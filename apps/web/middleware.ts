// ============================================================
// Phase 7-E W10 reviewer P1-3 — auth-guard /admin/*
// ============================================================
// The cohort-A operator dashboard at /admin/observability surfaces
// fallback events including model-error details, validator
// violations, and tool routing failures. Public exposure leaks
// operational signal AND any future detail-string that quotes
// user input. Basic-Auth gate keeps it operator-only until W12
// brings real session auth.
//
// Env vars (set in deploy environment):
//   OBSERVABILITY_USER  — required; the username
//   OBSERVABILITY_PASS  — required; the password
//
// If either env var is missing, /admin/* returns 503 (the
// dashboard cannot be served safely without configured auth).
// ============================================================

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

export const config = {
    matcher: ["/admin/:path*"],
    runtime: "nodejs",
};

function constantTimeEq(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
}

export function middleware(req: NextRequest): NextResponse {
    const expectedUser = process.env.OBSERVABILITY_USER;
    const expectedPass = process.env.OBSERVABILITY_PASS;

    if (!expectedUser || !expectedPass) {
        return new NextResponse(
            "Observability dashboard auth not configured. " +
                "Set OBSERVABILITY_USER and OBSERVABILITY_PASS in the deploy environment.",
            { status: 503, headers: { "Content-Type": "text/plain" } },
        );
    }

    const header = req.headers.get("authorization") ?? "";
    if (!header.toLowerCase().startsWith("basic ")) {
        return new NextResponse("Authentication required.", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="NYU Path Admin"' },
        });
    }

    let decoded = "";
    try {
        decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf-8");
    } catch {
        return new NextResponse("Malformed authorization header.", { status: 400 });
    }
    const colonAt = decoded.indexOf(":");
    if (colonAt < 0) {
        return new NextResponse("Malformed credentials.", { status: 400 });
    }
    const providedUser = decoded.slice(0, colonAt);
    const providedPass = decoded.slice(colonAt + 1);

    const userOk = constantTimeEq(providedUser, expectedUser);
    const passOk = constantTimeEq(providedPass, expectedPass);
    if (!userOk || !passOk) {
        return new NextResponse("Invalid credentials.", {
            status: 401,
            headers: { "WWW-Authenticate": 'Basic realm="NYU Path Admin"' },
        });
    }

    return NextResponse.next();
}
