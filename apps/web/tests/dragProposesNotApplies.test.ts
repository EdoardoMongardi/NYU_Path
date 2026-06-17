// ============================================================
// dragProposesNotApplies (Phase 4 Task E3.4) — drag/⋯ reconciliation.
// ============================================================
// The owner removed the drag gesture entirely: the per-course ⋯ menu is
// now the SOLE edit input, and every ⋯ verb (Move / Swap / Drop / Lock)
// PROPOSES — it renders the E3.1 canvas preview + E3.2 review card and
// applies ONLY on Confirm. This suite (the plan's filename) verifies the
// reconciliation now that drag is gone:
//
//   - a CLEAN feasible ⋯-menu result is no longer SILENTLY dropped — it
//     stages the preview (preview set, NOT null) and the committed plan
//     stays byte-identical until Confirm;
//   - a TRADE-OFFS feasible result also stages the preview;
//   - a `feasible:false` result stages the RED invalid card (no preview);
//   - the bubble↔card dedup: the FEASIBLE path mints NO chat bubble
//     (`showBubble:false`, the canvas review card is the sole surface);
//     the `feasible:false` path KEEPS the bubble (`showBubble:true`) for
//     its Override-anyway / hard-refusal copy.
//
// apps/web has NO React-DOM render harness (vitest runs in the `node`
// env). Per the established repo idiom (canvasPreview.test.ts /
// invalidProposal.test.ts), the surface decision lives in a pure,
// node-testable helper — `apps/web/lib/planActionSurfaces.ts` — and this
// suite drives it directly, then drives the result into a real
// `createPlanStore` to pin the no-silent-drop + commit-only-on-Confirm
// invariants. Real fixtures mirror `_planRouteTestUtils.ts`.
// ============================================================

import { describe, it, expect } from "vitest";
import { createPlanStore } from "../app/chat/planState";
import { planActionSurfaces } from "../lib/planActionSurfaces";
import { computeReviewCard } from "../lib/reviewCard";
import type { PlanActionResponse } from "../lib/planActionOrchestrator";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
} from "./_planRouteTestUtils";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const STUDENT = "stu-e34-reconcile";
const PMID = "pmid-e34-123";

/** Committed plan: 2026-fall = 8cr, 2027-spring = 8cr (total 16). */
function makeCommitted(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2026-fall", slots: [specificSlot("CSCI-UA.101", 4), specificSlot("MATH-UA.121", 4)] },
        { term: "2027-spring", slots: [specificSlot("CSCI-UA.102", 4), specificSlot("MATH-UA.122", 4)] },
    ]);
}

/** Proposed plan after a ⋯-menu move (one course moved fall → spring). */
function makeProposed(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2026-fall", slots: [specificSlot("CSCI-UA.101", 4)] },
        {
            term: "2027-spring",
            slots: [specificSlot("CSCI-UA.102", 4), specificSlot("MATH-UA.122", 4), specificSlot("MATH-UA.121", 4)],
        },
    ]);
}

/** A CLEAN feasible response: feasible:true, NO consequences, a proposed
 *  forwardSchedule present (the path that used to be silently dropped). */
function makeCleanResponse(proposed: ForwardSchedule): PlanActionResponse {
    return {
        feasible: true,
        diff: { added: [], removed: [] },
        consequences: [],
        explanation: "deterministic template",
        pendingMutationId: PMID,
        futureTerms: [],
        forwardSchedule: proposed,
    };
}

/** A TRADE-OFFS feasible response: feasible:true WITH consequences. */
function makeTradeOffsResponse(proposed: ForwardSchedule): PlanActionResponse {
    return {
        feasible: true,
        diff: { added: [], removed: [] },
        consequences: ["Moves CSCI-UA.102 a term later.", "Fall 2026 drops to 4 credits."],
        explanation: "deterministic template",
        pendingMutationId: PMID,
        futureTerms: ["2027-spring"],
        forwardSchedule: proposed,
    };
}

/** A `feasible:false` response with a binding conflict. */
function makeInfeasibleResponse(): PlanActionResponse {
    return {
        feasible: false,
        diff: { added: [], removed: [] },
        consequences: [],
        explanation: "deterministic refusal template",
        pendingMutationId: PMID,
        futureTerms: [],
        conflicts: [
            { kind: "credit_ceiling", detail: "Spring 2027 would exceed the 18-credit ceiling." },
        ],
    };
}

// ===========================================================================
// planActionSurfaces — the surface decision (preview / invalidCard / bubble).
// ===========================================================================

describe("planActionSurfaces — surface decision (E3.4)", () => {
    it("CLEAN feasible result → preview set (NOT null — no silent drop), no invalid card, NO bubble", () => {
        const proposed = makeProposed();
        const surfaces = planActionSurfaces(makeCleanResponse(proposed), "move");

        // The clean ⋯-menu result PROPOSES — it is NOT silently dropped.
        expect(surfaces.preview).not.toBeNull();
        expect(surfaces.preview!.proposedSchedule).toBe(proposed);
        expect(surfaces.preview!.pendingMutationId).toBe(PMID);
        expect(surfaces.preview!.verb).toBe("move");
        expect(surfaces.invalidCard).toBeNull();
        // Bubble↔card dedup: the canvas review card is the sole surface
        // for the feasible path → NO chat bubble.
        expect(surfaces.showBubble).toBe(false);
    });

    it("CLEAN feasible result → the review card is available (verdict 'valid')", () => {
        const card = computeReviewCard(makeCleanResponse(makeProposed()));
        expect(card.verdict).toBe("valid");
        expect(card.canConfirm).toBe(true);
    });

    it("TRADE-OFFS feasible result → preview set, NO bubble (card is the sole surface)", () => {
        const proposed = makeProposed();
        const surfaces = planActionSurfaces(makeTradeOffsResponse(proposed), "swap");

        expect(surfaces.preview).not.toBeNull();
        expect(surfaces.preview!.proposedSchedule).toBe(proposed);
        expect(surfaces.preview!.consequences).toEqual([
            "Moves CSCI-UA.102 a term later.",
            "Fall 2026 drops to 4 credits.",
        ]);
        expect(surfaces.invalidCard).toBeNull();
        expect(surfaces.showBubble).toBe(false);
    });

    it("TRADE-OFFS feasible result → the review card reports 'trade-offs'", () => {
        const card = computeReviewCard(makeTradeOffsResponse(makeProposed()));
        expect(card.verdict).toBe("trade-offs");
        expect(card.canConfirm).toBe(true);
    });

    it("feasible:false result → preview null, invalidCard set, bubble KEPT", () => {
        const surfaces = planActionSurfaces(makeInfeasibleResponse(), "add");

        expect(surfaces.preview).toBeNull();
        expect(surfaces.invalidCard).not.toBeNull();
        expect(surfaces.invalidCard!.verb).toBe("add");
        expect(surfaces.invalidCard!.bindingConstraints).toEqual([
            { kind: "credit_ceiling", detail: "Spring 2027 would exceed the 18-credit ceiling." },
        ]);
        // The red card lacks Override-anyway / hard-refusal copy — KEEP
        // the chat bubble alongside it for the feasible:false path.
        expect(surfaces.showBubble).toBe(true);
    });

    it("a feasible result with no forwardSchedule yields no surfaces (defensive no-op)", () => {
        const noSchedule: PlanActionResponse = {
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            explanation: "x",
            pendingMutationId: PMID,
            futureTerms: [],
        };
        const surfaces = planActionSurfaces(noSchedule, "move");
        expect(surfaces.preview).toBeNull();
        expect(surfaces.invalidCard).toBeNull();
        expect(surfaces.showBubble).toBe(false);
    });
});

// ===========================================================================
// Store integration — clean result PROPOSES (no silent drop) and the
// committed plan is NOT applied until Confirm.
// ===========================================================================

describe("planActionSurfaces → store: clean ⋯-menu result proposes, never auto-applies (E3.4)", () => {
    it("a clean result stages pendingPreview AND leaves the committed plan byte-identical", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });

        const proposed = makeProposed();
        const surfaces = planActionSurfaces(makeCleanResponse(proposed), "move");

        // Drive the (feasible) surface into the store exactly as the page
        // does: stage the preview, clear any stale red card. The committed
        // plan is NEVER mutated here — that happens only on Confirm.
        expect(surfaces.preview).not.toBeNull();
        store.setPendingPreview(surfaces.preview!);
        store.clearInvalidProposal();

        const snap = store.getSnapshot();
        // The proposal is STAGED (not silently dropped)…
        expect(snap.pendingPreview).not.toBeNull();
        expect(snap.pendingPreview!.proposedSchedule).toBe(proposed);
        // …and the committed plan is byte-identical (same reference + deep) —
        // a clean ⋯-menu result is NOT applied until Confirm.
        expect(snap.forwardSchedule).toBe(committed);
        expect(snap.forwardSchedule).toEqual(committed);
        // The proposed schedule is NOT the committed one.
        expect(snap.forwardSchedule).not.toBe(proposed);
    });

    it("a feasible:false result stages the RED card and leaves NO preview + committed plan untouched", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });

        const surfaces = planActionSurfaces(makeInfeasibleResponse(), "add");
        expect(surfaces.invalidCard).not.toBeNull();
        store.setInvalidProposal(surfaces.invalidCard!);
        store.clearPendingPreview();

        const snap = store.getSnapshot();
        expect(snap.invalidProposal).not.toBeNull();
        expect(snap.pendingPreview).toBeNull();
        expect(snap.forwardSchedule).toBe(committed);
    });
});
