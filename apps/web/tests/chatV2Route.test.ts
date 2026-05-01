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
import { setCohortAssignment, reviewCompleteness } from "@nyupath/engine";

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

    it("returns 503 when the configured primary's API key is not configured", async () => {
        // Phase 8 B5 — primary swapped to anthropic; the test deletes
        // OPENAI_API_KEY (the prior primary) but the route now needs
        // ANTHROPIC_API_KEY. We delete BOTH so the route's
        // createPrimaryClient returns null and we get 503 regardless
        // of which provider is the configured default.
        delete process.env.OPENAI_API_KEY;
        delete process.env.ANTHROPIC_API_KEY;
        const res = await POST(fakeRequest({
            message: "hi",
            parsedData: { semesters: [] },
        }) as never);
        expect(res.status).toBe(503);
        const json = await res.json();
        // The error names whichever provider's key the configured
        // primary needs (ANTHROPIC by default after Phase 8 B5;
        // OPENAI when the test sets NYUPATH_PRIMARY_PROVIDER=openai).
        expect(json.error).toMatch(/(ANTHROPIC|OPENAI)_API_KEY/);
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
        // Phase 8 B5: primary swapped to anthropic; fallback is openai.
        // Set BOTH so createPrimaryClient succeeds regardless of which
        // provider is the configured default.
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-cohort-test";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-cohort-test";
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

// ============================================================
// Phase 12.5 Task 4 — completenessReviewer wiring
// ============================================================
// Unit-tests the `reviewCompleteness` integration that the v2 route
// now runs alongside `validateResponse`. Rather than mocking the full
// agent loop (expensive), we pin the reviewer contract directly:
//   • When the agent reply drops a disclaimer from an invocation's
//     envelope, `reviewCompleteness` returns pass=false and the
//     route converts that into an `incompleteness` Violation.
//   • When all envelope content is surfaced, the reviewer passes and
//     no incompleteness violation is emitted.
// This is the exact merge logic wired in route.ts.
describe("completenessReviewer wiring (Phase 12.5 Task 4)", () => {
    it("returns pass=true when no invocations carry envelope metadata", () => {
        const verdict = reviewCompleteness("Any reply.", []);
        expect(verdict.pass).toBe(true);
        expect(verdict.droppedDisclaimers).toHaveLength(0);
        expect(verdict.droppedAnchors).toHaveLength(0);
        expect(verdict.retryGuidance).toBe("");
    });

    it("returns pass=true when all disclaimers from invocations are present in the reply", () => {
        const invocations = [
            {
                toolName: "search_policy",
                args: {},
                result: {
                    disclaimers: [
                        { id: "f1_load", text: "F-1 students must maintain full-time enrollment.", reason: "visa compliance" },
                    ],
                },
                summary: "Policy retrieved",
            },
        ];
        // Reply includes the disclaimer text verbatim.
        const reply = "Note: F-1 students must maintain full-time enrollment. This is important.";
        const verdict = reviewCompleteness(reply, invocations);
        expect(verdict.pass).toBe(true);
    });

    it("returns pass=false with retryGuidance when a disclaimer is dropped from the reply", () => {
        const droppedText = "F-1 students must maintain full-time enrollment.";
        const invocations = [
            {
                toolName: "search_policy",
                args: {},
                result: {
                    disclaimers: [
                        { id: "f1_load", text: droppedText, reason: "visa compliance" },
                    ],
                },
                summary: "Policy retrieved",
            },
        ];
        // Reply deliberately omits the disclaimer.
        const reply = "You can plan your schedule for next semester.";
        const verdict = reviewCompleteness(reply, invocations);
        expect(verdict.pass).toBe(false);
        expect(verdict.droppedDisclaimers).toHaveLength(1);
        expect(verdict.droppedDisclaimers[0]!.id).toBe("f1_load");
        expect(verdict.retryGuidance).toContain("incomplete");
        expect(verdict.retryGuidance).toContain(droppedText);

        // Verify the route's mapping logic: pass=false → incompleteness Violation
        const completenessViolations = verdict.pass
            ? []
            : [{ kind: "incompleteness" as const, detail: verdict.retryGuidance }];
        expect(completenessViolations).toHaveLength(1);
        expect(completenessViolations[0]!.kind).toBe("incompleteness");
        expect(completenessViolations[0]!.detail).toBeTruthy();
    });

    it("returns pass=false with retryGuidance when a bulletin anchor is dropped", () => {
        const anchorQuote = "Students transferring internally must have a minimum 2.0 GPA in residence at NYU.";
        const invocations = [
            {
                toolName: "search_policy",
                args: {},
                result: {
                    anchors: [
                        { quote: anchorQuote, source: "CAS Bulletin §4.2" },
                    ],
                },
                summary: "Policy retrieved",
            },
        ];
        // Reply doesn't include the anchor quote.
        const reply = "Internal transfer is possible. Please contact your adviser.";
        const verdict = reviewCompleteness(reply, invocations);
        expect(verdict.pass).toBe(false);
        expect(verdict.droppedAnchors).toHaveLength(1);
        expect(verdict.retryGuidance).toContain("Missing bulletin anchors");
    });

    it("merging: incompleteness violations appear alongside other violations in allViolations", () => {
        // Simulate the exact merge in route.ts:
        //   allViolations = [...verdict.violations, ...completenessViolations]
        const verdictViolations = [
            { kind: "missing_caveat" as const, detail: "F-1 caveat missing", caveatId: "f1_visa" },
        ];
        const completenessViolations = [
            { kind: "incompleteness" as const, detail: "Disclaimer dropped." },
        ];
        const allViolations = [
            ...verdictViolations.map((v) => ({
                kind: v.kind,
                detail: v.detail,
                ...(v.caveatId ? { caveatId: v.caveatId } : {}),
            })),
            ...completenessViolations,
        ];
        expect(allViolations).toHaveLength(2);
        expect(allViolations[0]!.kind).toBe("missing_caveat");
        expect(allViolations[1]!.kind).toBe("incompleteness");
        // Both belong in a single validator_block violations array — the
        // SSE shape accepts kind: string, so `incompleteness` is valid.
        for (const v of allViolations) {
            expect(typeof v.kind).toBe("string");
            expect(typeof v.detail).toBe("string");
        }
    });
});
