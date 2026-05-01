// ============================================================
// Session cookie helpers (Phase 7-E W12.3)
// ============================================================
// One cookie: nyupath_session = <signed JWT> (HS256, 30-day TTL).
// Issued by the OTP-verify route after a successful login. Read by
// the v2 chat route to derive the authenticated `userId` (the JWT
// subject — the NYU NetID prefix or, for the operator self-test,
// the local-part of an allowlisted email).
//
// Cookie attributes:
//   - HttpOnly      — JS can't read the token → mitigates XSS
//   - SameSite=Lax  — blocks CSRF on the chat route while still
//                     letting the user navigate in from email links
//   - Secure        — HTTPS only in production; relaxed for localhost
//   - Path=/        — needed across /, /chat, /api/*
//   - Max-Age=30d   — matches the JWT exp claim
// ============================================================

import { jwtVerify } from "jose";
import type { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "nyupath_session";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface SessionClaims {
    /** NYU NetID prefix or operator-allowlisted local-part — the
     *  canonical studentId we key everything off (rate-limit bucket,
     *  session_summaries.studentId, students.studentId). */
    sub: string;
    email: string;
}

/** Set the session cookie on a NextResponse (used after OTP verify). */
export function setSessionCookie(res: NextResponse, token: string): void {
    res.cookies.set({
        name: SESSION_COOKIE,
        value: token,
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: MAX_AGE_SECONDS,
    });
}

/** Clear the session cookie (used by /api/auth/logout). */
export function clearSessionCookie(res: NextResponse): void {
    res.cookies.set({
        name: SESSION_COOKIE,
        value: "",
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 0,
    });
}

/** Verify a token and return claims, or null if missing/invalid/expired. */
export async function verifySessionToken(
    token: string,
    env: Record<string, string | undefined> = process.env,
): Promise<SessionClaims | null> {
    const secret = env.SECRET_KEY;
    if (!secret) return null;
    try {
        const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
            algorithms: ["HS256"],
        });
        if (typeof payload.sub !== "string" || typeof payload.email !== "string") return null;
        return { sub: payload.sub, email: payload.email };
    } catch {
        return null;
    }
}

/** Read + verify the session cookie from a route-handler `NextRequest`.
 *  Defensive against shape variations: tests sometimes pass a minimal
 *  Request mock without a `.cookies.get` API. */
export async function readSessionFromRequest(req: NextRequest): Promise<SessionClaims | null> {
    let token: string | undefined;
    if (typeof req.cookies?.get === "function") {
        token = req.cookies.get(SESSION_COOKIE)?.value;
    } else {
        // Fallback: parse the Cookie header directly.
        const header = req.headers?.get?.("cookie");
        if (header) {
            for (const part of header.split(/;\s*/)) {
                const eq = part.indexOf("=");
                if (eq > 0 && part.slice(0, eq) === SESSION_COOKIE) {
                    token = decodeURIComponent(part.slice(eq + 1));
                    break;
                }
            }
        }
    }
    if (!token) return null;
    return verifySessionToken(token);
}

/** Read + verify the session cookie inside a Server Component (uses
 *  next/headers cookies()). */
export async function readSessionFromCookies(): Promise<SessionClaims | null> {
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    return verifySessionToken(token);
}
