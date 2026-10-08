// ============================================================
// POST /api/auth/otp/verify (Phase 7-B Step 11; W12.3 cookie wiring)
// ============================================================
// Body: { email, code }. Verifies the OTP, signs a JWT, sets the
// HttpOnly session cookie, returns 200 + the studentId so the client
// can route to /chat. The JWT is intentionally NOT echoed in the
// response body — keeping it cookie-only blocks XSS exfiltration.
//
// This is the only way to mint a session, so it is brute-force
// guarded twice: per-IP and per-email daily rate limits here (429 +
// Retry-After, checked before any code comparison), and a durable
// per-code attempt budget inside verifyOtp. The rate limits are
// in-process (per instance); the per-code budget is the DB-backed
// control that holds across instances.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { verifyOtp } from "../../../../../lib/auth/otp";
import { setSessionCookie } from "../../../../../lib/auth/session";
import { clientIp } from "../../../../../lib/clientIp";
import { consumeRequest, type ConsumeBlocked } from "../../../../../lib/rateLimit";

export const runtime = "nodejs";

/** 5 issued codes/day/IP (issue route) × 5 attempts per code. */
const VERIFY_LIMIT_PER_IP_PER_DAY = 25;
/** Two codes' worth of attempts per email per day. */
const VERIFY_LIMIT_PER_EMAIL_PER_DAY = 10;

function tooManyRequests(rate: ConsumeBlocked, message: string): Response {
    return NextResponse.json(
        { ok: false, error: `${message} Try again after ${rate.resetAt}.` },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
}

export async function POST(req: NextRequest): Promise<Response> {
    const ipRate = consumeRequest(`otp-verify-ip:${clientIp(req.headers)}`, VERIFY_LIMIT_PER_IP_PER_DAY);
    if (!ipRate.ok) return tooManyRequests(ipRate, "Too many login attempts from this IP.");

    let body: { email?: string; code?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "Body must be JSON with email + code." }, { status: 400 });
    }
    if (!body.email || typeof body.email !== "string" || !body.code || typeof body.code !== "string") {
        return NextResponse.json({ ok: false, error: "email and code are required." }, { status: 400 });
    }
    const email = body.email.trim();
    const emailRate = consumeRequest(`otp-verify-email:${email.toLowerCase()}`, VERIFY_LIMIT_PER_EMAIL_PER_DAY);
    if (!emailRate.ok) return tooManyRequests(emailRate, "Too many login attempts for this email.");

    const result = await verifyOtp(email, body.code.trim());
    if (!result.ok || !result.token || !result.studentId) {
        // Map all failure modes to the same shape so the client's
        // copy can stay consistent (and we don't leak which step failed).
        const message =
            result.reason === "expired" ? "That code has expired. Request a new one."
            : result.reason === "code_mismatch" ? "That code doesn't match. Double-check the email and try again."
            : result.reason === "too_many_attempts" ? "Too many incorrect codes. Request a new code."
            : result.reason === "no_pending_otp" ? "No active code for that email. Request a new one."
            : result.reason === "invalid_email" ? "That email isn't allowed."
            : result.reason === "db_unavailable" ? "Auth backend is unavailable. Try again in a moment."
            : "Couldn't verify the code. Try again.";
        const status =
            result.reason === "invalid_email" ? 400
            : result.reason === "db_unavailable" ? 503
            : 401;
        return NextResponse.json({ ok: false, error: message }, { status });
    }

    const res = NextResponse.json({ ok: true, studentId: result.studentId });
    setSessionCookie(res, result.token);
    return res;
}
