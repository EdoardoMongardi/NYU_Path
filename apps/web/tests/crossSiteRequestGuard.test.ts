// ============================================================
// Cross-site request guard (PR #58 review finding 1 — login CSRF)
// ============================================================
// /api/auth/otp/verify parsed `req.json()` whatever the Content-Type
// and never looked at Origin / Sec-Fetch-Site. A cross-site
// `<form enctype="text/plain">` top-level POST carrying the ATTACKER's
// email + a fresh code (`{"email":"…","code":"…","x":"=…"}`) parsed as
// JSON, so the route set the attacker's session cookie in the victim's
// browser; the victim then uploaded their DPR under the attacker's sub.
//
// Every state-changing /api handler now refuses a cross-site request
// (403) before doing anything, and the JSON routes refuse a declared
// non-JSON body (415) — the only bodies an HTML form can send.
// ============================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    guardJsonMutation,
    rejectCrossSiteRequest,
    rejectNonJsonBody,
} from "../lib/auth/requestGuards";
import { SESSION_COOKIE } from "../lib/auth/session";
import { getStores, resetStoresForTests } from "../lib/db/store";
import { TEST_SECRET, issueTestToken, makeProfile, makeDpr } from "./_planRouteTestUtils";

const verifyOtpMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/auth/otp", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/auth/otp")>();
    return { ...actual, verifyOtp: verifyOtpMock };
});

function headersReq(headers: Record<string, string>): { headers: Headers } {
    return { headers: new Headers(headers) };
}

describe("rejectCrossSiteRequest", () => {
    it.each(["same-origin", "none"])("allows Sec-Fetch-Site: %s", (site) => {
        expect(rejectCrossSiteRequest(headersReq({ "sec-fetch-site": site }))).toBeNull();
    });

    it.each(["cross-site", "same-site"])("refuses Sec-Fetch-Site: %s with 403", async (site) => {
        const res = rejectCrossSiteRequest(
            headersReq({ "sec-fetch-site": site, origin: "https://nyupath.example", host: "nyupath.example" }),
        );
        expect(res?.status).toBe(403);
        expect((await res!.json()).error).toMatch(/cross-site/i);
    });

    it("without Sec-Fetch-Site, allows an Origin whose host matches Host", () => {
        expect(
            rejectCrossSiteRequest(headersReq({ origin: "https://nyupath.example", host: "nyupath.example" })),
        ).toBeNull();
    });

    it("without Sec-Fetch-Site, allows an Origin matching X-Forwarded-Host (proxied deploys)", () => {
        expect(
            rejectCrossSiteRequest(
                headersReq({
                    origin: "https://nyupath.example",
                    host: "internal:3000",
                    "x-forwarded-host": "nyupath.example",
                }),
            ),
        ).toBeNull();
    });

    it("without Sec-Fetch-Site, refuses a foreign Origin", () => {
        expect(
            rejectCrossSiteRequest(headersReq({ origin: "https://evil.example", host: "nyupath.example" }))?.status,
        ).toBe(403);
    });

    it("refuses an opaque `Origin: null` (sandboxed frame / data: URL)", () => {
        expect(rejectCrossSiteRequest(headersReq({ origin: "null", host: "nyupath.example" }))?.status).toBe(403);
    });

    it("allows a request with neither header (not a browser — can't carry a victim's cookies)", () => {
        expect(rejectCrossSiteRequest(headersReq({ host: "nyupath.example" }))).toBeNull();
        expect(rejectCrossSiteRequest({})).toBeNull();
    });
});

describe("rejectNonJsonBody", () => {
    it.each([
        "text/plain",
        "text/plain;charset=UTF-8",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
    ])("refuses Content-Type %s with 415", (ct) => {
        expect(rejectNonJsonBody(headersReq({ "content-type": ct }))?.status).toBe(415);
    });

    it.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])(
        "allows Content-Type %s",
        (ct) => {
            expect(rejectNonJsonBody(headersReq({ "content-type": ct }))).toBeNull();
        },
    );

    it("allows a request that declares no body type", () => {
        expect(rejectNonJsonBody(headersReq({}))).toBeNull();
    });

    it("guardJsonMutation applies the cross-site check first, then the JSON check", () => {
        expect(guardJsonMutation(headersReq({ "sec-fetch-site": "cross-site", "content-type": "text/plain" }))?.status).toBe(403);
        expect(guardJsonMutation(headersReq({ "sec-fetch-site": "same-origin", "content-type": "text/plain" }))?.status).toBe(415);
        expect(guardJsonMutation(headersReq({ "sec-fetch-site": "same-origin", "content-type": "application/json" }))).toBeNull();
    });
});

// ---- the finding, end to end on the real routes ----

const ATTACKER_FORM_BODY = '{"email":"attacker@nyu.edu","code":"123456","x":"=y"}';

function nextReq(path: string, init: { method?: string; headers?: Record<string, string>; body?: string }): NextRequest {
    return new NextRequest(`http://nyupath.example${path}`, {
        method: init.method ?? "POST",
        headers: { host: "nyupath.example", ...(init.headers ?? {}) },
        ...(init.body !== undefined ? { body: init.body } : {}),
    });
}

describe("POST /api/auth/otp/verify — login CSRF", () => {
    beforeEach(() => {
        verifyOtpMock.mockReset();
        verifyOtpMock.mockResolvedValue({ ok: true, token: "attacker.session.jwt", studentId: "attacker" });
    });

    it("refuses a cross-site text/plain form POST without verifying or setting a session cookie", async () => {
        const { POST } = await import("../app/api/auth/otp/verify/route");
        const res = await POST(
            nextReq("/api/auth/otp/verify", {
                headers: {
                    "content-type": "text/plain",
                    origin: "https://evil.example",
                    "sec-fetch-site": "cross-site",
                },
                body: ATTACKER_FORM_BODY,
            }),
        );
        expect(res.status).toBe(403);
        expect(verifyOtpMock).not.toHaveBeenCalled();
        expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("refuses a text/plain body even from a browser that sends no fetch-metadata headers", async () => {
        const { POST } = await import("../app/api/auth/otp/verify/route");
        const res = await POST(
            nextReq("/api/auth/otp/verify", { headers: { "content-type": "text/plain" }, body: ATTACKER_FORM_BODY }),
        );
        expect(res.status).toBe(415);
        expect(verifyOtpMock).not.toHaveBeenCalled();
        expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("still signs in a same-origin JSON request and sets the cookie", async () => {
        const { POST } = await import("../app/api/auth/otp/verify/route");
        const res = await POST(
            nextReq("/api/auth/otp/verify", {
                headers: {
                    "content-type": "application/json",
                    origin: "http://nyupath.example",
                    "sec-fetch-site": "same-origin",
                },
                body: JSON.stringify({ email: "abc123@nyu.edu", code: "123456" }),
            }),
        );
        expect(res.status).toBe(200);
        expect(verifyOtpMock).toHaveBeenCalledOnce();
        expect(res.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=`);
    });
});

describe("other state-changing routes refuse a cross-site request", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    beforeEach(() => {
        delete process.env.DATABASE_URL;
        process.env.SECRET_KEY = TEST_SECRET;
        resetStoresForTests();
    });
    afterEach(() => {
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
        resetStoresForTests();
    });

    async function crossSite(path: string, method: string, sub: string, body?: string): Promise<NextRequest> {
        const token = await issueTestToken(sub);
        return nextReq(path, {
            method,
            headers: {
                cookie: `${SESSION_COOKIE}=${token}`,
                "sec-fetch-site": "same-site",
                origin: "https://sibling.nyupath.example",
                ...(body !== undefined ? { "content-type": "application/json" } : {}),
            },
            ...(body !== undefined ? { body } : {}),
        });
    }

    it("/api/session/delete keeps the student's data", async () => {
        const sub = "csrf_delete_victim";
        await getStores({}).profileStore.persistMutation(
            makeProfile(sub),
            { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
            makeDpr(),
        );
        const { DELETE } = await import("../app/api/session/delete/route");
        const res = await DELETE(await crossSite("/api/session/delete", "DELETE", sub));
        expect(res.status).toBe(403);
        expect(await getStores({}).profileStore.get(sub)).not.toBeNull();
    });

    it("/api/chat/v2 refuses before parsing the body", async () => {
        const { POST } = await import("../app/api/chat/v2/route");
        const res = await POST(await crossSite("/api/chat/v2", "POST", "csrf_chat", JSON.stringify({ message: "hi" })));
        expect(res.status).toBe(403);
    });

    it("/api/plan/* (shared preflight) refuses before auth or rate limit", async () => {
        const { POST } = await import("../app/api/plan/drop/route");
        const res = await POST(await crossSite("/api/plan/drop", "POST", "csrf_plan", JSON.stringify({ courseId: "CSCI-UA 101" })));
        expect(res.status).toBe(403);
    });

    it("/api/auth/logout can't be forced cross-site", async () => {
        const { POST } = await import("../app/api/auth/logout/route");
        const res = await POST(await crossSite("/api/auth/logout", "POST", "csrf_logout"));
        expect(res.status).toBe(403);
        expect(res.headers.get("set-cookie")).toBeNull();
    });
});

// ---- coverage: no state-changing /api handler may skip the guard ----

const API_ROOT = join(__dirname, "..", "app", "api");
const GUARD_CALL = /\b(guardJsonMutation|rejectCrossSiteRequest)\(/;
// The plan-action routes share `preflight` in planActionRouteHelpers.ts,
// which calls the guard (exercised by the /api/plan/drop case above).
const SHARED_GUARDED_HANDLER = /\bhandle(Propose|ProposeWhatIf|Confirm)Route\b/;

function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return routeFiles(p);
        return name === "route.ts" ? [p] : [];
    });
}

describe("every state-changing /api route handler is guarded", () => {
    const files = routeFiles(API_ROOT);

    it("finds the route files", () => {
        expect(files.length).toBeGreaterThan(10);
    });

    it.each(files.map((f) => [relative(API_ROOT, f), f]))("%s", (_rel, file) => {
        const src = readFileSync(file, "utf-8");
        const mutating = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\b/.test(src);
        if (!mutating) return;
        expect(GUARD_CALL.test(src) || SHARED_GUARDED_HANDLER.test(src)).toBe(true);
    });
});
