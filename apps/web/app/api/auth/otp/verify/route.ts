// ============================================================
// POST /api/auth/otp/verify (Phase 7-B Step 11; W12.3 cookie wiring)
// ============================================================
// Body: { email, code }. Verifies the OTP, signs a JWT, sets the
// HttpOnly session cookie, returns 200 + the studentId so the client
// can route to /chat. The JWT is intentionally NOT echoed in the
// response body — keeping it cookie-only blocks XSS exfiltration.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { verifyOtp } from "../../../../../lib/auth/otp";
import { setSessionCookie } from "../../../../../lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
    let body: { email?: string; code?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "Body must be JSON with email + code." }, { status: 400 });
    }
    if (!body.email || typeof body.email !== "string" || !body.code || typeof body.code !== "string") {
        return NextResponse.json({ ok: false, error: "email and code are required." }, { status: 400 });
    }
    const result = await verifyOtp(body.email.trim(), body.code.trim());
    if (!result.ok || !result.token || !result.studentId) {
        // Map all failure modes to the same shape so the client's
        // copy can stay consistent (and we don't leak which step failed).
        const message =
            result.reason === "expired" ? "That code has expired. Request a new one."
            : result.reason === "code_mismatch" ? "That code doesn't match. Double-check the email and try again."
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
