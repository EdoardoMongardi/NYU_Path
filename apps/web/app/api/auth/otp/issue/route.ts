// ============================================================
// /api/auth/otp/issue — Phase 7-B Step 11
// ============================================================
import { NextRequest, NextResponse } from "next/server";
import { issueOtp } from "../../../../../lib/auth/otp";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
    let body: { email?: string };
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body.email || typeof body.email !== "string") {
        return NextResponse.json({ error: "`email` is required." }, { status: 400 });
    }
    const result = await issueOtp(body.email);
    if (!result.ok) {
        const status = result.reason === "invalid_email"
            ? 400
            : result.reason === "db_unavailable"
                ? 503
                : 500;
        return NextResponse.json({ error: result.reason }, { status });
    }
    return NextResponse.json({
        ok: true,
        ...(result.debugCode ? { debugCode: result.debugCode } : {}),
    });
}
