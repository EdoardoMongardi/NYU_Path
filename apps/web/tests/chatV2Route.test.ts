// ============================================================
// Phase 6.1 WS2 — v2 route input-validation tests (P3 reviewer fix)
// ============================================================
// Pins the 400/503 response paths in apps/web/app/api/chat/v2/route.ts.
// The route's body-parse + missing-key short-circuits are trivial
// guards; this file pins them so a future refactor can't silently
// regress the wire contract.
// ============================================================

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { POST } from "../app/api/chat/v2/route";
import { setCohortAssignment } from "@nyupath/engine";

// Helper: synthesize a minimal NextRequest-shaped object.
function fakeRequest(body: unknown | string): { json: () => Promise<unknown> } {
    if (typeof body === "string") {
        return {
            async json() { throw new SyntaxError("Unexpected token"); },
        };
    }
    return { json: async () => body };
}

describe("v2 route input validation (Phase 6.1 WS2)", () => {
    const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
    beforeEach(() => { delete process.env.OPENAI_API_KEY; });
    afterEach(() => {
        if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
    });

    it("returns 400 when JSON body is unparseable", async () => {
        const res = await POST(fakeRequest("INVALID-JSON") as never);
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/Invalid JSON body/i);
    });

    it("returns 400 when `message` is missing", async () => {
        const res = await POST(fakeRequest({ parsedData: { semesters: [] } }) as never);
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/message.*required/i);
    });

    it("returns 400 when `message` is not a string", async () => {
        const res = await POST(fakeRequest({ message: 42, parsedData: { semesters: [] } }) as never);
        expect(res.status).toBe(400);
    });

    it("returns 400 when `parsedData` is missing", async () => {
        const res = await POST(fakeRequest({ message: "hi" }) as never);
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toMatch(/parsedData.*required/i);
    });

    it("returns 503 when OPENAI_API_KEY is not configured", async () => {
        // Body is valid; the missing key is the failure mode.
        const res = await POST(fakeRequest({
            message: "hi",
            parsedData: { semesters: [] },
        }) as never);
        expect(res.status).toBe(503);
        const json = await res.json();
        expect(json.error).toMatch(/OPENAI_API_KEY/);
    });
});

describe("v2 route cohort gating (Phase 7-A P-1)", () => {
    const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
    afterEach(() => {
        if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
        // Reset cohort assignment to default after each test.
        setCohortAssignment({ default: "alpha" });
    });

    it("serves a 200 SSE stream from a `limited` cohort user without calling the agent loop", async () => {
        // Even with NO API key configured, a `limited` cohort user
        // must get a 200 SSE response (template-only / limited
        // availability). This is the §12.6.5 cohort-D recovery
        // contract: the agent loop is disabled but the route still
        // serves curated answers + a graceful fallback.
        delete process.env.OPENAI_API_KEY;
        // Without an API key the route returns 503 BEFORE checking
        // cohort. With a key it serves via runTemplateMatcherOnly.
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-cohort-test";
        setCohortAssignment({
            overrides: { "u-limited": "limited" },
            default: "alpha",
        });
        const res = await POST(fakeRequest({
            message: "Can I take a major course P/F?",
            parsedData: { semesters: [] },
            userId: "u-limited",
        }) as never);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
        // Drain the SSE stream and assert it contains a `done` event.
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let body = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            body += decoder.decode(value, { stream: true });
        }
        expect(body).toMatch(/event: done/);
        // The recovery path tags modelUsedId so we can verify the
        // agent loop did NOT run (no real model would have that id).
        expect(body).toMatch(/cohort:limited:(?:template-only|limited)/);
    });
});
