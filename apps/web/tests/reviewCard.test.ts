// ============================================================
// reviewCard (Phase 4 Task E3.2) — verdict + Confirm / Cancel /
// Ask-why review card.
// ============================================================
// apps/web has NO React-DOM render harness (vitest runs in the `node`
// env). Per the established repo idiom (sharedPlanState.test.ts /
// canvasPreview.test.ts / planActionBubble.test.ts), the render-driving
// LOGIC lives in pure, node-testable modules and this suite drives them
// directly:
//   - `computeReviewCard` (apps/web/lib/reviewCard.ts) — turns a
//     PlanActionResponse into the verdict + glyph + label + trade-off
//     lines + canConfirm flag, reading ONLY engine fields (NEVER a
//     fabricated delta), and
//   - `applyReviewConfirm` / `applyReviewCancel` — the store-mutating
//     actions the React buttons call, with an INJECTABLE confirm fn so
//     the confirm/cancel behaviour is unit-testable without a DOM.
// The React review-card binding lives in scheduleSidebar.tsx, NOT here.
//
// Contract pinned here:
//   (a) verdict mapping — feasible+no-consequences → "valid"/"✓";
//       feasible+consequences → "trade-offs"/"⚠"; !feasible →
//       "invalid"/"✗"/canConfirm:false. tradeOffLines == consequences
//       verbatim (no fabrication).
//   (b) applyReviewConfirm calls the injected confirm fn with the right
//       id, commits the proposed forwardSchedule, AND clears the
//       preview — but ONLY on success (a failed confirm leaves the
//       preview so the user can retry).
//   (c) applyReviewCancel clears the preview WITHOUT ever calling the
//       confirm fn.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { createPlanStore, type PendingPreview } from "../app/chat/planState";
import {
    computeReviewCard,
    applyReviewConfirm,
    applyReviewCancel,
} from "../lib/reviewCard";
import type { PlanActionResponse, WhatIfAssumptionResponse } from "../lib/planActionOrchestrator";
import type { WhatIfAssumptionMarker } from "@nyupath/engine";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
} from "./_planRouteTestUtils";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const STUDENT = "stu-review-card";
const PMID = "pmid-review-123";

function makeCommitted(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2026-fall", slots: [specificSlot("CSCI-UA.101", 4), specificSlot("MATH-UA.121", 4)] },
        { term: "2027-spring", slots: [specificSlot("CSCI-UA.102", 4), specificSlot("MATH-UA.122", 4)] },
    ]);
}

function makeProposed(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        {
            term: "2026-fall",
            slots: [specificSlot("CSCI-UA.101", 4), specificSlot("MATH-UA.121", 4), specificSlot("CSCI-UA.201", 4)],
        },
        { term: "2027-spring", slots: [specificSlot("CSCI-UA.102", 4)] },
    ]);
}

/** A minimal PlanActionResponse. Only the fields computeReviewCard reads
 *  are load-bearing; the rest satisfy the type. */
function makeResponse(opts: {
    feasible: boolean;
    consequences: string[];
    forwardSchedule?: ForwardSchedule;
}): PlanActionResponse {
    return {
        feasible: opts.feasible,
        diff: { added: [], removed: [] },
        consequences: opts.consequences,
        explanation: "deterministic template",
        pendingMutationId: PMID,
        futureTerms: [],
        ...(opts.forwardSchedule ? { forwardSchedule: opts.forwardSchedule } : {}),
    };
}

function makePreview(proposed: ForwardSchedule, consequences: string[], verb = "move"): PendingPreview {
    return {
        proposedSchedule: proposed,
        pendingMutationId: PMID,
        consequences,
        verb,
    };
}

// ===========================================================================
// (a) computeReviewCard — verdict mapping + no-fabrication trade-off lines.
// ===========================================================================

describe("computeReviewCard — verdict + trade-offs (E3.2)", () => {
    it("feasible WITH non-empty consequences → ⚠ trade-offs, lines == consequences, canConfirm", () => {
        const consequences = [
            "Moves you to 12 credits in fall.",
            "Drops CSCI-UA.102 from spring.",
        ];
        const card = computeReviewCard(
            makeResponse({ feasible: true, consequences, forwardSchedule: makeProposed() }),
        );
        expect(card.verdict).toBe("trade-offs");
        expect(card.glyph).toBe("⚠");
        // The lines come ONLY from the engine's consequences — verbatim,
        // no fabrication.
        expect(card.tradeOffLines).toEqual(consequences);
        expect(card.canConfirm).toBe(true);
        expect(card.pendingMutationId).toBe(PMID);
    });

    it("feasible WITH empty consequences → ✓ valid, no trade-off lines, canConfirm", () => {
        const card = computeReviewCard(
            makeResponse({ feasible: true, consequences: [], forwardSchedule: makeProposed() }),
        );
        expect(card.verdict).toBe("valid");
        expect(card.glyph).toBe("✓");
        expect(card.tradeOffLines).toEqual([]);
        expect(card.canConfirm).toBe(true);
    });

    it("NOT feasible → ✗ invalid, canConfirm false (E3.3 owns the red-card render)", () => {
        const card = computeReviewCard(
            makeResponse({ feasible: false, consequences: ["Breaks the CS major prereq chain."] }),
        );
        expect(card.verdict).toBe("invalid");
        expect(card.glyph).toBe("✗");
        expect(card.canConfirm).toBe(false);
    });

    it("NEVER fabricates a trade-off line — an empty consequences array yields zero lines", () => {
        const card = computeReviewCard(
            makeResponse({ feasible: true, consequences: [], forwardSchedule: makeProposed() }),
        );
        // No invented "you might want to…" copy; strictly the engine's view.
        expect(card.tradeOffLines).toHaveLength(0);
    });

    it("a planDiff with a graduation-term shift contributes a deterministic summary line (still no fabrication)", () => {
        const response: PlanActionResponse = {
            ...makeResponse({ feasible: true, consequences: ["A consequence."], forwardSchedule: makeProposed() }),
            planDiff: {
                creditsByTermDelta: {},
                graduationTermShift: 1,
                newRequiresPetition: [],
                removedRequiresPetition: [],
                newUnmetRequirements: [],
                cascadedShifts: [],
                weightedCreditsByTermDelta: {},
                workloadTierShifts: [],
                balanceImpact: { before: 0, after: 0, delta: 0, classification: "negligible" },
                newAssumptions: [],
                validationResultsChanges: {},
            },
        };
        const card = computeReviewCard(response);
        // The original consequence is still present…
        expect(card.tradeOffLines).toContain("A consequence.");
        // …and the planDiff-derived line is a deterministic, engine-grounded
        // summary of graduationTermShift (not an invented narrative).
        expect(card.tradeOffLines.some((l) => l.toLowerCase().includes("graduation"))).toBe(true);
    });
});

// ===========================================================================
// (b) applyReviewConfirm — calls the injected confirm fn, commits, clears.
// ===========================================================================

describe("applyReviewConfirm — confirm path (E3.2)", () => {
    it("calls the confirm fn with the pendingMutationId, commits the proposed plan, AND clears the preview", async () => {
        const committed = makeCommitted();
        const proposed = makeProposed();
        const store = createPlanStore({ forwardSchedule: committed });
        store.setPendingPreview(makePreview(proposed, ["x"]));

        const confirmFn = vi.fn().mockResolvedValue({
            ok: true,
            data: { forwardSchedule: proposed },
        });

        const result = await applyReviewConfirm(store, confirmFn, PMID);

        expect(result.ok).toBe(true);
        expect(confirmFn).toHaveBeenCalledTimes(1);
        expect(confirmFn).toHaveBeenCalledWith({ pendingMutationId: PMID });
        // Committed plan is now the proposed plan…
        expect(store.getSnapshot().forwardSchedule).toBe(proposed);
        // …and the preview is cleared.
        expect(store.getSnapshot().pendingPreview).toBeNull();
    });

    it("a FAILED confirm leaves the preview in place (retry-able) and does NOT commit", async () => {
        const committed = makeCommitted();
        const preview = makePreview(makeProposed(), ["x"]);
        const store = createPlanStore({ forwardSchedule: committed });
        store.setPendingPreview(preview);

        const confirmFn = vi.fn().mockResolvedValue({ ok: false, status: 409, error: "conflict" });

        const result = await applyReviewConfirm(store, confirmFn, PMID);

        expect(result.ok).toBe(false);
        expect(confirmFn).toHaveBeenCalledTimes(1);
        // The committed plan is UNCHANGED…
        expect(store.getSnapshot().forwardSchedule).toBe(committed);
        // …and the preview is STILL staged so the user can retry.
        expect(store.getSnapshot().pendingPreview).toBe(preview);
    });

    it("a successful confirm WITHOUT a forwardSchedule still clears the preview (no crash)", async () => {
        const store = createPlanStore({ forwardSchedule: makeCommitted() });
        store.setPendingPreview(makePreview(makeProposed(), ["x"]));

        const confirmFn = vi.fn().mockResolvedValue({ ok: true, data: {} });
        const result = await applyReviewConfirm(store, confirmFn, PMID);

        expect(result.ok).toBe(true);
        expect(store.getSnapshot().pendingPreview).toBeNull();
    });
});

// ===========================================================================
// (c) applyReviewCancel — clears the preview WITHOUT calling confirm.
// ===========================================================================

describe("applyReviewCancel — cancel path (E3.2)", () => {
    it("clears the preview and NEVER calls the confirm fn", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });
        store.setPendingPreview(makePreview(makeProposed(), ["x"]));
        expect(store.getSnapshot().pendingPreview).not.toBeNull();

        const confirmSpy = vi.fn();
        applyReviewCancel(store);

        // Preview gone…
        expect(store.getSnapshot().pendingPreview).toBeNull();
        // …committed plan untouched…
        expect(store.getSnapshot().forwardSchedule).toBe(committed);
        // …and we NEVER hit the confirm round-trip.
        expect(confirmSpy).not.toHaveBeenCalled();
    });
});

// ===========================================================================
// (d) G3.2 — computeReviewCard with a WhatIfAssumptionResponse
// ===========================================================================

describe("computeReviewCard — what-if assumption marker (G3.2)", () => {
    function makeWhatIfMarker(
        outcome: WhatIfAssumptionMarker["outcome"] = "withdraw",
    ): WhatIfAssumptionMarker {
        return {
            courseId: "CSCI-UA 102",
            outcome,
            label: outcome === "withdraw"
                ? `Assumes you withdraw from CSCI-UA 102 (a "W" — GPA-neutral; the requirement re-opens).`
                : `Assumes you take CSCI-UA 102 pass/fail and PASS (unverified until your next DPR).`,
            hedges: ["This claim is unverified — verify with your adviser."],
            ...(outcome === "withdraw"
                ? { windowCaveat: "Registration window may be closed — verify with your adviser." }
                : {}),
        };
    }

    function makeWhatIfResponse(
        feasible: boolean,
        consequences: string[],
        marker: WhatIfAssumptionMarker,
    ): WhatIfAssumptionResponse {
        return {
            feasible,
            diff: { added: [], removed: [] },
            consequences,
            explanation: "what-if",
            pendingMutationId: PMID,
            futureTerms: [],
            whatIfAssumption: marker,
        };
    }

    it("a WhatIfAssumptionResponse → card carries the whatIfAssumption marker", () => {
        const marker = makeWhatIfMarker("withdraw");
        const card = computeReviewCard(makeWhatIfResponse(true, [], marker));
        expect(card.whatIfAssumption).toBeDefined();
        expect(card.whatIfAssumption!.courseId).toBe("CSCI-UA 102");
        expect(card.whatIfAssumption!.outcome).toBe("withdraw");
        expect(card.whatIfAssumption!.label).toMatch(/withdraw/i);
    });

    it("a WhatIfAssumptionResponse preserves the verdict + canConfirm logic unchanged", () => {
        const marker = makeWhatIfMarker("pass");
        const withConsequences = computeReviewCard(
            makeWhatIfResponse(true, ["Grad shifts 1 term."], marker),
        );
        expect(withConsequences.verdict).toBe("trade-offs");
        expect(withConsequences.canConfirm).toBe(true);

        const clean = computeReviewCard(makeWhatIfResponse(true, [], marker));
        expect(clean.verdict).toBe("valid");
        expect(clean.canConfirm).toBe(true);

        const infeasible = computeReviewCard(makeWhatIfResponse(false, [], marker));
        expect(infeasible.verdict).toBe("invalid");
        expect(infeasible.canConfirm).toBe(false);
    });

    it("hedges + windowCaveat are carried through on the marker (no truncation)", () => {
        const marker = makeWhatIfMarker("withdraw");
        const card = computeReviewCard(makeWhatIfResponse(true, [], marker));
        expect(card.whatIfAssumption!.hedges).toHaveLength(1);
        expect(card.whatIfAssumption!.windowCaveat).toBeDefined();
    });

    it("a normal (non-what-if) PlanActionResponse leaves whatIfAssumption absent", () => {
        const card = computeReviewCard(makeResponse({ feasible: true, consequences: [] }));
        // Normal proposals MUST NOT carry a whatIfAssumption — no accidental override.
        expect(card.whatIfAssumption).toBeUndefined();
    });
});
