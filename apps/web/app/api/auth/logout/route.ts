// ============================================================
// POST /api/auth/logout (Phase 7-E W12.3)
// ============================================================
// Clears the session cookie. The JWT itself remains valid until
// its exp claim — there's no server-side blacklist (cohort A is
// small enough that we trust client-side cookie deletion). For
// cohort B+ a session-revocation table can be added.
// ============================================================

import { NextResponse } from "next/server";
import { clearSessionCookie } from "../../../../lib/auth/session";

export const runtime = "nodejs";

export async function POST(): Promise<Response> {
    const res = NextResponse.json({ ok: true });
    clearSessionCookie(res);
    return res;
}
