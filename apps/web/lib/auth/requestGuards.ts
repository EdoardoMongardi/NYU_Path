// ============================================================
// Cross-site request guards for state-changing /api routes
// ============================================================
// The session cookie is SameSite=Lax, so a cross-site POST arrives
// without it — but that does not cover:
//   - LOGIN CSRF: /api/auth/otp/verify needs no cookie, it SETS one. A
//     cross-site `<form enctype="text/plain">` POST of the attacker's
//     email + code (a body that still parses as JSON) would sign the
//     victim's browser in as the attacker, and the victim's DPR upload
//     would then land under the attacker's sub.
//   - same-SITE attackers (a sibling subdomain), whose requests DO carry
//     Lax cookies.
// So every state-changing handler calls `rejectCrossSiteRequest` (403)
// before it reads the session, parses the body or charges a rate-limit
// bucket, and JSON handlers also call `rejectNonJsonBody` (415) — via
// `guardJsonMutation`. A test (crossSiteRequestGuard.test.ts) fails if a
// POST/PUT/PATCH/DELETE route handler under app/api skips the guard.
//
// The origin check follows Go 1.25's net/http CrossOriginProtection:
//   1. Sec-Fetch-Site present (every current browser): allow only
//      "same-origin" or "none" (user-initiated); refuse "same-site" and
//      "cross-site".
//   2. Else an Origin header must name this host (Host, or
//      X-Forwarded-Host behind a proxy); "null" never matches.
//   3. Neither header: not a browser request, so it can't be carrying a
//      victim's cookies — allow (curl, server-side fetch, test harness).
// A browser can't forge either header, and an HTML form can't set them.
//
// The JSON check refuses a body whose declared Content-Type is anything
// but application/json. An HTML form always declares text/plain,
// urlencoded or multipart, so this closes the form vector of login CSRF
// even in a browser that sends neither header above. A request that
// declares NO Content-Type passes this check — a no-cors fetch() with
// an untyped Blob body is one — but fetch() always sends Origin on a
// cross-origin POST, so the origin check above refuses it.
// ============================================================

import { NextResponse } from "next/server";

/** The slice of a request the guards read. Tolerates the minimal fakes
 *  some route tests pass (no `headers` at all = no browser headers). */
interface HeaderSource {
    headers?: { get?: (name: string) => string | null };
}

/** Body of every refusal — `error` is what the clients already render. */
type Refusal = NextResponse<{ ok: false; error: string }>;

function header(req: HeaderSource, name: string): string | null {
    return req.headers?.get?.(name) ?? null;
}

function originMatchesHost(req: HeaderSource, origin: string): boolean {
    let originHost: string;
    try {
        originHost = new URL(origin).host;
    } catch {
        return false; // includes the opaque "null" origin
    }
    const forwarded = header(req, "x-forwarded-host")?.split(",")[0]?.trim();
    return originHost === header(req, "host") || (!!forwarded && originHost === forwarded);
}

/** 403 unless the request is same-origin (or not from a browser). */
export function rejectCrossSiteRequest(req: HeaderSource): Refusal | null {
    const site = header(req, "sec-fetch-site");
    const origin = header(req, "origin");
    const allowed =
        site !== null
            ? site === "same-origin" || site === "none"
            : origin === null || originMatchesHost(req, origin);
    if (allowed) return null;
    return NextResponse.json(
        { ok: false as const, error: "Cross-site request refused. Use NYU Path directly." },
        { status: 403 },
    );
}

/** 415 when the request declares a non-JSON body. */
export function rejectNonJsonBody(req: HeaderSource): Refusal | null {
    const contentType = header(req, "content-type");
    if (contentType === null) return null;
    const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
    if (mediaType === "application/json") return null;
    return NextResponse.json(
        { ok: false as const, error: "Content-Type must be application/json." },
        { status: 415 },
    );
}

/** Both guards, cross-site first — for routes that parse a JSON body. */
export function guardJsonMutation(req: HeaderSource): Refusal | null {
    return rejectCrossSiteRequest(req) ?? rejectNonJsonBody(req);
}
