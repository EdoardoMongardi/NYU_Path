// ============================================================
// POST /api/auth/otp/issue (Phase 7-B Step 11; W12.2 hardened)
// ============================================================
// Body: { email }. Issues a fresh 6-digit OTP, persists hash, sends
// the code via Resend. Per-IP rate-limited (5/UTC-day) so a flood
// against /issue can't burn Resend quota or spam an inbox.
//
// Always returns 200 unless the request is structurally malformed
// or the email is rejected (non-NYU + not on AUTH_TEST_EMAILS).
// We don't tell the client "account exists" vs "doesn't" — there is
// no separate signup flow; every successful verify upserts a
// students row, so the start endpoint is account-enumeration-blind.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { issueOtp } from "../../../../../lib/auth/otp";
import { consumeRequest } from "../../../../../lib/rateLimit";

export const runtime = "nodejs";

const OTP_LIMIT_PER_DAY = 5;

function ipKey(req: NextRequest): string {
    const fwd = req.headers.get("x-forwarded-for");
    if (fwd) return `otp-ip:${fwd.split(",")[0]!.trim()}`;
    const real = req.headers.get("x-real-ip");
    if (real) return `otp-ip:${real.trim()}`;
    return "otp-ip:anonymous";
}

export async function POST(req: NextRequest): Promise<Response> {
    const rate = consumeRequest(ipKey(req), OTP_LIMIT_PER_DAY);
    if (!rate.ok) {
        return NextResponse.json(
            { ok: false, error: `Too many login attempts from this IP. Try again after ${rate.resetAt}.` },
            { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
        );
    }

    let body: { email?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ ok: false, error: "Body must be JSON with an email field." }, { status: 400 });
    }
    if (!body.email || typeof body.email !== "string") {
        return NextResponse.json({ ok: false, error: "email is required." }, { status: 400 });
    }
    const result = await issueOtp(body.email.trim());
    if (!result.ok) {
        if (result.reason === "invalid_email") {
            return NextResponse.json(
                {
                    ok: false,
                    error: "We only accept @nyu.edu addresses (or operator-allowlisted test accounts during cohort A setup).",
                },
                { status: 400 },
            );
        }
        if (result.reason === "db_unavailable") {
            return NextResponse.json(
                { ok: false, error: "Auth backend is unavailable. Please try again in a moment." },
                { status: 503 },
            );
        }
        return NextResponse.json(
            { ok: false, error: "Couldn't send the login email. Please try again or contact the operator." },
            { status: 502 },
        );
    }
    return NextResponse.json({
        ok: true,
        ...(result.debugCode ? { debugCode: result.debugCode } : {}),
    });
}
