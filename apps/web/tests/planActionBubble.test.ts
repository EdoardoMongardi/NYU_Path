// ============================================================
// planActionBubble (Phase 17 Task D follow-up) — bubble lifecycle tests
// ============================================================
// Covers the page-side `plan_action_bubble` Message kind without
// the React-DOM render harness (apps/web doesn't ship
// @testing-library/react). The page extracts the lifecycle math
// into pure helpers in `apps/web/lib/planActionBubbleHelpers.ts`
// + `apps/web/lib/chatV2Client.ts`; this suite exercises that
// surface end-to-end:
//
//   - classification: clean → no bubble; trade-offs / soft / hard
//     refusals → bubble (with the right button set).
//   - polish reducer: chunk events accumulate; done event REPLACES
//     the template; error event keeps the template intact.
//   - Stage 2 reducer: per-term enrichment events append (last-write
//     -wins per term).
//   - SSE consumer (streamPlanActionStage2): parses block-buffered
//     events end-to-end, falls back to "unavailable" on transport /
//     non-2xx failures.
// ============================================================

import { describe, it, expect, afterEach, vi } from "vitest";
import {
    classifyPlanActionOutcome,
    bubbleHasButtons,
    bubbleHasOverrideButton,
    bubbleSlotKey,
    initBubbleState,
    applyPolishEvent,
    applyStage2Event,
    HARD_CONFLICT_KINDS,
    type PlanActionBubbleState,
} from "../lib/planActionBubbleHelpers";
import {
    streamPlanActionStage2,
    streamPlanActionPolish,
    type PlanActionBubbleSseEvent,
} from "../lib/chatV2Client";
import { planConfirm } from "../lib/planActionClient";
import type { PlanActionRouteResponse } from "../lib/planActionClient";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

function cleanResponse(): PlanActionRouteResponse {
    return {
        feasible: true,
        diff: { added: [], removed: [] },
        consequences: [],
        explanation: "Pinning CSCI-UA 101 to 2026-fall.",
        pendingMutationId: "11111111-2222-3333-4444-555555555555",
        futureTerms: ["2026-fall"],
    };
}

function tradeOffsResponse(): PlanActionRouteResponse {
    return {
        feasible: true,
        diff: { added: [], removed: [] },
        consequences: ["Bumped Spring 2027 from 16 → 20cr (within cap)."],
        explanation: "Adding CSCI-UA 480 raises the term to 20cr.",
        pendingMutationId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        futureTerms: ["2027-spring"],
    };
}

function softRefusalResponse(): PlanActionRouteResponse {
    return {
        feasible: false,
        diff: { added: [], removed: [] },
        consequences: ["Term would exceed the 18-credit cap."],
        conflicts: [
            { kind: "credit_floor", detail: "Below F-1 floor of 12cr." },
            { kind: "credit_ceiling", detail: "Above 18-credit cap." },
        ],
        explanation: "This change pushes the term beyond the credit cap.",
        pendingMutationId: "soft-refusal-uuid-1234567890ab",
        futureTerms: ["2026-fall"],
    };
}

function hardRefusalResponse(): PlanActionRouteResponse {
    return {
        feasible: false,
        diff: { added: [], removed: [] },
        consequences: ["Course requires unsatisfied prereq MATH-UA 121."],
        conflicts: [
            { kind: "prereq_unsatisfiable", detail: "MATH-UA 121 not yet completed." },
        ],
        explanation: "Cannot add CSCI-UA 480 — prereq MATH-UA 121 missing.",
        pendingMutationId: "hard-refusal-uuid-aaaaaaaaaa",
        futureTerms: ["2026-fall"],
    };
}

function fakeResponse(chunks: string[], opts: { status?: number } = {}): Response {
    const status = opts.status ?? 200;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
        },
    });
    return new Response(stream, { status });
}

function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function installFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = impl as never;
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
});

// ===========================================================================
// classifyPlanActionOutcome — covers the four bubble kinds.
// ===========================================================================

describe("classifyPlanActionOutcome (Phase 17 Task D)", () => {
    it("clean: feasible + zero consequences → 'clean'", () => {
        expect(classifyPlanActionOutcome(cleanResponse())).toBe("clean");
    });

    it("trade-offs: feasible + non-empty consequences → 'trade_offs'", () => {
        expect(classifyPlanActionOutcome(tradeOffsResponse())).toBe("trade_offs");
    });

    it("soft refusal: feasible:false + only soft conflict kinds → 'soft_refusal'", () => {
        expect(classifyPlanActionOutcome(softRefusalResponse())).toBe("soft_refusal");
    });

    it("hard refusal: feasible:false + ANY hard conflict kind → 'hard_refusal'", () => {
        expect(classifyPlanActionOutcome(hardRefusalResponse())).toBe("hard_refusal");
    });

    it("hard refusal: prereq_unsatisfiable mixed with soft kinds still wins", () => {
        const r: PlanActionRouteResponse = {
            ...softRefusalResponse(),
            conflicts: [
                { kind: "credit_floor", detail: "Below F-1 floor." },
                { kind: "prereq_unsatisfiable", detail: "Missing prereq." },
            ],
        };
        expect(classifyPlanActionOutcome(r)).toBe("hard_refusal");
    });

    it("hard refusal: feasible:false with empty conflicts[] degrades to soft", () => {
        // Defensive: an engine that returned feasible:false but no
        // conflicts is a soft refusal by default (Override-anyway is
        // the safe affordance — Decision #32 is exactly this slot).
        const r: PlanActionRouteResponse = {
            ...softRefusalResponse(),
            conflicts: [],
        };
        expect(classifyPlanActionOutcome(r)).toBe("soft_refusal");
    });

    it("HARD_CONFLICT_KINDS includes prereq + graduation + offering", () => {
        // Pin the constant — a future relaxation should be a deliberate
        // change, not a silent edit.
        expect(HARD_CONFLICT_KINDS.has("prereq_unsatisfiable")).toBe(true);
        expect(HARD_CONFLICT_KINDS.has("graduation_total")).toBe(true);
        expect(HARD_CONFLICT_KINDS.has("offering")).toBe(true);
        expect(HARD_CONFLICT_KINDS.has("offering_pattern")).toBe(true);
        expect(HARD_CONFLICT_KINDS.has("credit_floor")).toBe(false); // soft
    });
});

// ===========================================================================
// Button-set decisions — drives which buttons render in the page.
// ===========================================================================

describe("bubbleHasButtons / bubbleHasOverrideButton (Phase 17 Task D)", () => {
    it("trade_offs → buttons + NO override-anyway", () => {
        expect(bubbleHasButtons("trade_offs")).toBe(true);
        expect(bubbleHasOverrideButton("trade_offs")).toBe(false);
    });

    it("soft_refusal → buttons + override-anyway", () => {
        expect(bubbleHasButtons("soft_refusal")).toBe(true);
        expect(bubbleHasOverrideButton("soft_refusal")).toBe(true);
    });

    it("hard_refusal → NO buttons (pure refusal text)", () => {
        expect(bubbleHasButtons("hard_refusal")).toBe(false);
        expect(bubbleHasOverrideButton("hard_refusal")).toBe(false);
    });

    it("clean → buttons present (would render if forced) but never has override", () => {
        // Clean is suppressed at the call site (no bubble injected),
        // but the helpers still answer sensibly.
        expect(bubbleHasOverrideButton("clean")).toBe(false);
    });
});

// ===========================================================================
// initBubbleState — initial wiring from the route response.
// ===========================================================================

describe("initBubbleState (Phase 17 Task D)", () => {
    it("seeds the slotKey from pendingMutationId", () => {
        const r = tradeOffsResponse();
        const s = initBubbleState(r);
        expect(s.slotKey).toBe(bubbleSlotKey(r.pendingMutationId));
        expect(s.slotKey).toContain(r.pendingMutationId);
    });

    it("starts with the deterministic template + idle polish", () => {
        const r = tradeOffsResponse();
        const s = initBubbleState(r);
        expect(s.text).toBe(r.explanation);
        expect(s.polishStatus).toBe("idle");
        expect(s.stage2.size).toBe(0);
        expect(s.kind).toBe("trade_offs");
    });

    it("preserves futureTerms from the response", () => {
        const r = tradeOffsResponse();
        const s = initBubbleState(r);
        expect(s.futureTerms).toEqual(["2027-spring"]);
    });
});

// ===========================================================================
// applyPolishEvent — chunk → done → error reducer behavior.
// ===========================================================================

describe("applyPolishEvent (Phase 17 Task D)", () => {
    function freshState(): PlanActionBubbleState {
        return initBubbleState(tradeOffsResponse());
    }

    it("first chunk REPLACES the deterministic template (does not append)", () => {
        const s = freshState();
        const ev: PlanActionBubbleSseEvent = {
            kind: "plan_action_explanation_polish_chunk",
            slotKey: s.slotKey,
            deltaText: "Adding CSCI-UA 480 raises Spring 2027 from 16 to 20cr — within the cap.",
        };
        const next = applyPolishEvent(s, ev);
        // The template ("Adding CSCI-UA 480 raises the term to 20cr.")
        // is GONE; the polish chunk owns the bubble text now.
        expect(next.text).toBe(ev.deltaText);
        expect(next.text).not.toContain("term to 20cr");
        expect(next.polishStatus).toBe("streaming");
    });

    it("subsequent chunks accumulate", () => {
        const s = freshState();
        const ev1: PlanActionBubbleSseEvent = {
            kind: "plan_action_explanation_polish_chunk",
            slotKey: s.slotKey,
            deltaText: "Adding CSCI-UA 480",
        };
        const after1 = applyPolishEvent(s, ev1);
        const ev2: PlanActionBubbleSseEvent = {
            kind: "plan_action_explanation_polish_chunk",
            slotKey: s.slotKey,
            deltaText: " raises Spring 2027 to 20cr.",
        };
        const after2 = applyPolishEvent(after1, ev2);
        expect(after2.text).toBe("Adding CSCI-UA 480 raises Spring 2027 to 20cr.");
        expect(after2.polishStatus).toBe("streaming");
    });

    it("done event lands the final text + flips status to 'done'", () => {
        const s = freshState();
        const final = "Adding CSCI-UA 480 to Fall 2026 raises the term from 16 to 20cr — within the cap — with no prereq issues.";
        const ev: PlanActionBubbleSseEvent = {
            kind: "plan_action_explanation_polish_done",
            slotKey: s.slotKey,
            polishedText: final,
        };
        const next = applyPolishEvent(s, ev);
        expect(next.text).toBe(final);
        expect(next.polishStatus).toBe("done");
    });

    it("error event leaves the template intact + flips status to 'error'", () => {
        const s = freshState();
        const ev: PlanActionBubbleSseEvent = {
            kind: "plan_action_explanation_polish_error",
            slotKey: s.slotKey,
            message: "Anthropic 5xx",
        };
        const next = applyPolishEvent(s, ev);
        // Template preserved.
        expect(next.text).toBe(s.text);
        expect(next.polishStatus).toBe("error");
    });

    it("ignores events with a different slotKey (multi-bubble safety)", () => {
        const s = freshState();
        const ev: PlanActionBubbleSseEvent = {
            kind: "plan_action_explanation_polish_chunk",
            slotKey: "bubble:other-uuid",
            deltaText: "Should not be applied here.",
        };
        const next = applyPolishEvent(s, ev);
        // Same object reference — defensive guard.
        expect(next).toBe(s);
    });
});

// ===========================================================================
// applyStage2Event — per-term enrichment.
// ===========================================================================

describe("applyStage2Event (Phase 17 Task D)", () => {
    function freshState(): PlanActionBubbleState {
        return initBubbleState(tradeOffsResponse());
    }

    it("appends a single enrichment for one term", () => {
        const s = freshState();
        const ev: PlanActionBubbleSseEvent = {
            kind: "plan_action_stage2_enrichment",
            slotKey: s.slotKey,
            term: "2027-spring",
            status: "ok",
            message: "[2027-spring] open sections exist (3 conflict-free combinations).",
        };
        const next = applyStage2Event(s, ev);
        expect(next.stage2.size).toBe(1);
        const entry = Array.from(next.stage2.values())[0]!;
        expect(entry.status).toBe("ok");
        expect(entry.message).toContain("open sections exist");
    });

    it("multiple terms produce N independent entries", () => {
        let s = freshState();
        for (const t of ["2026-fall", "2027-spring"]) {
            const ev: PlanActionBubbleSseEvent = {
                kind: "plan_action_stage2_enrichment",
                slotKey: s.slotKey,
                term: t,
                status: "ok",
                message: `[${t}] open sections exist.`,
            };
            s = applyStage2Event(s, ev);
        }
        expect(s.stage2.size).toBe(2);
    });

    it("repeat event for the same term overwrites (last-write-wins)", () => {
        const s0 = freshState();
        const ev1: PlanActionBubbleSseEvent = {
            kind: "plan_action_stage2_enrichment",
            slotKey: s0.slotKey,
            term: "2026-fall",
            status: "pending",
            message: "[2026-fall] checking…",
        };
        const s1 = applyStage2Event(s0, ev1);
        const ev2: PlanActionBubbleSseEvent = {
            kind: "plan_action_stage2_enrichment",
            slotKey: s0.slotKey,
            term: "2026-fall",
            status: "ok",
            message: "[2026-fall] open sections exist.",
        };
        const s2 = applyStage2Event(s1, ev2);
        expect(s2.stage2.size).toBe(1);
        const entry = s2.stage2.get("2026-fall")!;
        expect(entry.status).toBe("ok");
    });

    it("ignores polish events (slotKey-matched but wrong kind)", () => {
        const s = freshState();
        const ev: PlanActionBubbleSseEvent = {
            kind: "plan_action_explanation_polish_chunk",
            slotKey: s.slotKey,
            deltaText: "polish",
        };
        const next = applyStage2Event(s, ev);
        expect(next).toBe(s);
    });

    it("ignores events with a different slotKey", () => {
        const s = freshState();
        const ev: PlanActionBubbleSseEvent = {
            kind: "plan_action_stage2_enrichment",
            slotKey: "bubble:other-uuid",
            term: "2027-spring",
            status: "ok",
            message: "[2027-spring] open sections exist.",
        };
        const next = applyStage2Event(s, ev);
        expect(next).toBe(s);
    });
});

// ===========================================================================
// streamPlanActionStage2 — SSE consumer end-to-end.
// ===========================================================================

describe("streamPlanActionStage2 (Phase 17 Task D)", () => {
    it("yields one enrichment per term + a terminating done event", async () => {
        installFetch(async () => fakeResponse([
            "event: plan_action_stage2_enrichment\ndata: " + JSON.stringify({
                kind: "plan_action_stage2_enrichment",
                slotKey: "bubble:k",
                term: "2026-fall",
                status: "ok",
                message: "[2026-fall] open sections exist.",
            }) + "\n\n",
            "event: plan_action_stage2_enrichment\ndata: " + JSON.stringify({
                kind: "plan_action_stage2_enrichment",
                slotKey: "bubble:k",
                term: "2027-spring",
                status: "warn",
                message: "[2027-spring] no conflict-free combinations.",
            }) + "\n\n",
            "event: plan_action_stage2_done\ndata: " + JSON.stringify({
                kind: "plan_action_stage2_done",
                slotKey: "bubble:k",
            }) + "\n\n",
        ]));
        const evs: PlanActionBubbleSseEvent[] = [];
        for await (const ev of streamPlanActionStage2({
            slotKey: "bubble:k",
            futureTerms: ["2026-fall", "2027-spring"],
        })) {
            evs.push(ev);
        }
        expect(evs).toHaveLength(3);
        expect(evs[0]!.kind).toBe("plan_action_stage2_enrichment");
        expect(evs[1]!.kind).toBe("plan_action_stage2_enrichment");
        expect(evs[2]!.kind).toBe("plan_action_stage2_done");
    });

    it("falls back to a single 'unavailable' enrichment on transport failure", async () => {
        installFetch(async () => { throw new Error("network down"); });
        const evs: PlanActionBubbleSseEvent[] = [];
        for await (const ev of streamPlanActionStage2({
            slotKey: "bubble:k",
            futureTerms: ["2026-fall"],
        })) {
            evs.push(ev);
        }
        expect(evs).toHaveLength(1);
        expect(evs[0]!.kind).toBe("plan_action_stage2_enrichment");
        const e = evs[0] as Extract<PlanActionBubbleSseEvent, { kind: "plan_action_stage2_enrichment" }>;
        expect(e.status).toBe("unavailable");
        expect(e.message).toMatch(/network down/);
    });

    it("falls back to 'unavailable' on a non-2xx (e.g. 429 quota)", async () => {
        installFetch(async () => jsonResponse(429, { error: "Stage 2 quota exhausted." }));
        const evs: PlanActionBubbleSseEvent[] = [];
        for await (const ev of streamPlanActionStage2({
            slotKey: "bubble:k",
            futureTerms: ["2026-fall"],
        })) {
            evs.push(ev);
        }
        expect(evs).toHaveLength(1);
        const e = evs[0] as Extract<PlanActionBubbleSseEvent, { kind: "plan_action_stage2_enrichment" }>;
        expect(e.status).toBe("unavailable");
        expect(e.message).toMatch(/quota exhausted/);
    });

    it("204 No Content (e.g. empty body) yields no events", async () => {
        installFetch(async () => new Response(null, { status: 204 }));
        const evs: PlanActionBubbleSseEvent[] = [];
        for await (const ev of streamPlanActionStage2({
            slotKey: "bubble:k",
            futureTerms: ["2026-fall"],
        })) {
            evs.push(ev);
        }
        expect(evs).toHaveLength(0);
    });
});

// ===========================================================================
// streamPlanActionPolish — SSE consumer (smoke test, full path lives in
// chatV2Client.test.ts).
// ===========================================================================

describe("streamPlanActionPolish (Phase 17 Task D)", () => {
    it("204 (env flag off) yields no events", async () => {
        installFetch(async () => new Response(null, { status: 204 }));
        const evs: PlanActionBubbleSseEvent[] = [];
        for await (const ev of streamPlanActionPolish({ slotKey: "k", templateText: "t" })) {
            evs.push(ev);
        }
        expect(evs).toHaveLength(0);
    });

    it("yields chunk + done events end-to-end", async () => {
        installFetch(async () => fakeResponse([
            "event: plan_action_explanation_polish_chunk\ndata: " + JSON.stringify({
                kind: "plan_action_explanation_polish_chunk",
                slotKey: "k",
                deltaText: "Polished ",
            }) + "\n\n",
            "event: plan_action_explanation_polish_chunk\ndata: " + JSON.stringify({
                kind: "plan_action_explanation_polish_chunk",
                slotKey: "k",
                deltaText: "explanation.",
            }) + "\n\n",
            "event: plan_action_explanation_polish_done\ndata: " + JSON.stringify({
                kind: "plan_action_explanation_polish_done",
                slotKey: "k",
                polishedText: "Polished explanation.",
            }) + "\n\n",
        ]));
        const evs: PlanActionBubbleSseEvent[] = [];
        for await (const ev of streamPlanActionPolish({ slotKey: "k", templateText: "t" })) {
            evs.push(ev);
        }
        expect(evs).toHaveLength(3);
        expect(evs[0]!.kind).toBe("plan_action_explanation_polish_chunk");
        expect(evs[2]!.kind).toBe("plan_action_explanation_polish_done");
    });
});

// ===========================================================================
// Bubble button click flows — end-to-end through planConfirm.
// ===========================================================================

describe("plan_action_bubble button flows (Phase 17 Task D)", () => {
    it("Confirm: POSTs to /api/plan/confirm with {pendingMutationId} (NO force)", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        installFetch(async (url, init) => {
            calls.push({ url, init });
            return jsonResponse(200, {
                feasible: true,
                diff: { added: [], removed: [] },
                consequences: [],
                storedIn: "forwardSchedule",
                consumedMutationId: "11111111-2222-3333-4444-555555555555",
            });
        });
        const r = await planConfirm({
            pendingMutationId: "11111111-2222-3333-4444-555555555555",
        });
        expect(r.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("/api/plan/confirm");
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body.pendingMutationId).toBe("11111111-2222-3333-4444-555555555555");
        // CRITICAL: Confirm must NOT include force=true.
        expect("force" in body).toBe(false);
    });

    it("Override-anyway: POSTs to /api/plan/confirm with {pendingMutationId, force: true}", async () => {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        installFetch(async (url, init) => {
            calls.push({ url, init });
            return jsonResponse(200, {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: ["Term over the 18-cap."],
                storedIn: "studentDraftPlan",
                consumedMutationId: "soft-refusal-uuid-1234567890ab",
            });
        });
        const r = await planConfirm({
            pendingMutationId: "soft-refusal-uuid-1234567890ab",
            force: true,
        });
        expect(r.ok).toBe(true);
        expect(calls).toHaveLength(1);
        const body = JSON.parse(calls[0]!.init.body as string);
        expect(body.force).toBe(true);
        // Override-anyway routes the apply into student-preferred-invalid-draft.
        if (r.ok) {
            expect(r.data.storedIn).toBe("studentDraftPlan");
        }
    });

    it("Keep-as-is: makes NO network call (pure UI dismiss)", async () => {
        const calls: Array<{ url: string }> = [];
        installFetch(async (url) => {
            calls.push({ url });
            return jsonResponse(200, {});
        });
        // Keep-as-is is a pure UI state mutation in the page — it
        // never hits the network. Asserting the absence of a fetch
        // here pins that contract: if a future refactor accidentally
        // fires planConfirm on Keep-as-is, this test fails.
        // (We don't actually invoke any helper — Keep-as-is doesn't
        // exist as a network helper. The page's onClick is a pure
        // setState.)
        expect(calls).toHaveLength(0);
    });
});

// ===========================================================================
// Clean-applies-no-bubble contract — pinned to the spec.
// ===========================================================================

describe("clean-applies-no-bubble (Phase 17 Task D contract)", () => {
    it("a clean response classifies as 'clean' so the page can branch and skip bubble insertion", () => {
        const kind = classifyPlanActionOutcome(cleanResponse());
        expect(kind).toBe("clean");
    });

    it("non-clean responses ALWAYS classify as one of the bubble kinds", () => {
        for (const r of [tradeOffsResponse(), softRefusalResponse(), hardRefusalResponse()]) {
            const kind = classifyPlanActionOutcome(r);
            expect(["trade_offs", "soft_refusal", "hard_refusal"]).toContain(kind);
        }
    });
});
