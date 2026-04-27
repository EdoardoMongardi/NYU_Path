// ============================================================
// /api/auth/otp/verify — Phase 7-B Step 11
// ============================================================
import { NextRequest, NextResponse } from "next/server";
import { verifyOtp } from "../../../../../lib/auth/otp";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
    let body: { email?: string; code?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body.email || typeof body.email !== "string" || !body.code || typeof body.code !== "string") {
        return NextResponse.json({ error: "`email` and `code` are required." }, { status: 400 });
    }
    const result = await verifyOtp(body.email, body.code);
    if (!result.ok) {
        const status = result.reason === "invalid_email"
            ? 400
            : result.reason === "db_unavailable"
                ? 503
                : result.reason === "no_pending_otp" || result.reason === "expired"
                    ? 404
                    : result.reason === "code_mismatch"
                        ? 401
                        : 500;
        return NextResponse.json({ error: result.reason }, { status });
    }
    return NextResponse.json({
        ok: true,
        token: result.token,
        studentId: result.studentId,
    });
}
