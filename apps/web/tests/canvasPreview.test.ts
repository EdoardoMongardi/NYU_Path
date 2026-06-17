// ============================================================
// canvasPreview (Phase 4 Task E3.1) — staged-proposal canvas preview.
// ============================================================
// apps/web has NO React-DOM render harness (vitest runs in the `node`
// env). Per the established repo idiom (sharedPlanState.test.ts /
// planActionBubble.test.ts), the render-driving LOGIC lives in pure,
// node-testable modules and this suite drives them directly:
//   - the shared store's new `pendingPreview` slot
//     (apps/web/app/chat/planState.ts), and
//   - the pure `computePreviewView` helper
//     (apps/web/lib/planPreview.ts).
// The React overlay binding lives in scheduleSidebar.tsx, NOT here.
//
// Contract pinned here:
//   - setPendingPreview stages a proposal AND leaves the committed
//     forwardSchedule byte-identical (the preview NEVER mutates the
//     committed plan).
//   - clearPendingPreview nulls the overlay.
//   - the snapshot reference changes on a set (consumers re-render)
//     and is stable across no-op reads (React 19 caching).
//   - computePreviewView returns the proposed schedule, surfaces the
//     consequences, and computes the credit delta (total + per-term)
//     correctly vs the committed plan.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { createPlanStore, type PendingPreview } from "../app/chat/planState";
import { computePreviewView } from "../lib/planPreview";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
} from "./_planRouteTestUtils";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures — real ForwardSchedule shapes via the shared route test utils.
// The committed plan and the proposed plan differ in their per-term
// planned credits so the credit-delta assertions are meaningful.
// ---------------------------------------------------------------------------

const STUDENT = "stu-canvas-preview";

/** Committed plan: 2026-fall = 8cr, 2027-spring = 8cr (total 16). */
function makeCommitted(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2026-fall", slots: [specificSlot("CSCI-UA.101", 4), specificSlot("MATH-UA.121", 4)] },
        { term: "2027-spring", slots: [specificSlot("CSCI-UA.102", 4), specificSlot("MATH-UA.122", 4)] },
    ]);
}

/** Proposed plan: a course added to 2026-fall (+4cr) and one dropped
 *  from 2027-spring (−4cr): 2026-fall = 12cr, 2027-spring = 4cr. */
function makeProposed(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        {
            term: "2026-fall",
            slots: [specificSlot("CSCI-UA.101", 4), specificSlot("MATH-UA.121", 4), specificSlot("CSCI-UA.201", 4)],
        },
        { term: "2027-spring", slots: [specificSlot("CSCI-UA.102", 4)] },
    ]);
}

function makePreview(proposed: ForwardSchedule, consequences: string[]): PendingPreview {
    return {
        proposedSchedule: proposed,
        pendingMutationId: "pmid-123",
        consequences,
    };
}

// ===========================================================================
// Store: pendingPreview slot
// ===========================================================================

describe("planState — pendingPreview slot (E3.1)", () => {
    it("defaults pendingPreview to null", () => {
        const store = createPlanStore();
        expect(store.getSnapshot().pendingPreview).toBeNull();
    });

    it("setPendingPreview stages the overlay AND leaves committed forwardSchedule untouched", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });

        const before = store.getSnapshot();
        expect(before.pendingPreview).toBeNull();

        const preview = makePreview(makeProposed(), ["Drops CSCI-UA.202 from spring."]);
        store.setPendingPreview(preview);

        const after = store.getSnapshot();
        // The overlay is staged…
        expect(after.pendingPreview).toBe(preview);
        // …and the COMMITTED plan is byte-identical (same reference) —
        // the preview NEVER mutates the committed plan.
        expect(after.forwardSchedule).toBe(committed);
        expect(after.forwardSchedule).toEqual(before.forwardSchedule);
    });

    it("clearPendingPreview nulls the overlay (Confirm / Cancel / Keep-as-is)", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });
        store.setPendingPreview(makePreview(makeProposed(), ["x"]));
        expect(store.getSnapshot().pendingPreview).not.toBeNull();

        store.clearPendingPreview();
        const snap = store.getSnapshot();
        expect(snap.pendingPreview).toBeNull();
        // Committed plan is STILL untouched by clearing the overlay.
        expect(snap.forwardSchedule).toBe(committed);
    });

    it("setPendingPreview swaps the snapshot reference (consumers re-render)", () => {
        const store = createPlanStore({ forwardSchedule: makeCommitted() });
        const before = store.getSnapshot();
        store.setPendingPreview(makePreview(makeProposed(), ["x"]));
        const after = store.getSnapshot();
        expect(after).not.toBe(before);
    });

    it("getSnapshot is a STABLE reference across no-op reads (React 19 caching)", () => {
        const store = createPlanStore({ forwardSchedule: makeCommitted() });
        store.setPendingPreview(makePreview(makeProposed(), ["x"]));
        const a = store.getSnapshot();
        const b = store.getSnapshot();
        expect(b).toBe(a);
    });

    it("subscribe listeners fire on set and on clear", () => {
        const store = createPlanStore({ forwardSchedule: makeCommitted() });
        const listener = vi.fn();
        store.subscribe(listener);
        store.setPendingPreview(makePreview(makeProposed(), ["x"]));
        store.clearPendingPreview();
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it("staging a preview does not mutate the committed plan captured by a stale read", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });
        const stale = store.getSnapshot();
        store.setPendingPreview(makePreview(makeProposed(), ["x"]));
        // A render holding the pre-set snapshot still sees no overlay AND
        // its committed plan is frozen.
        expect(stale.pendingPreview).toBeNull();
        expect(stale.forwardSchedule).toBe(committed);
    });
});

// ===========================================================================
// Helper: computePreviewView credit delta
// ===========================================================================

describe("computePreviewView — credit delta (E3.1)", () => {
    it("computes the per-term and total credit delta proposed − committed", () => {
        const committed = makeCommitted();
        const consequences = ["Moves you to 12 credits in fall.", "Drops a course from spring."];
        const view = computePreviewView(committed, makePreview(makeProposed(), consequences));

        // 2026-fall: 12 − 8 = +4 ; 2027-spring: 4 − 8 = −4 ; total 0.
        expect(view.creditDelta.byTerm["2026-fall"]).toBe(4);
        expect(view.creditDelta.byTerm["2027-spring"]).toBe(-4);
        expect(view.creditDelta.total).toBe(0);
    });

    it("surfaces the proposed schedule and the consequences verbatim", () => {
        const committed = makeCommitted();
        const proposed = makeProposed();
        const consequences = ["A non-empty trade-off line."];
        const view = computePreviewView(committed, makePreview(proposed, consequences));
        expect(view.proposedSchedule).toBe(proposed);
        expect(view.consequences).toEqual(consequences);
        expect(view.pendingMutationId).toBe("pmid-123");
    });

    it("a net credit increase yields a positive total", () => {
        // Committed: fall 8 + spring 8 = 16. Proposed: fall 12 + spring 8 = 20.
        const committed = makeCommitted();
        const proposed = makeFeasibleScheduleWithSemesters(STUDENT, [
            {
                term: "2026-fall",
                slots: [specificSlot("A", 4), specificSlot("B", 4), specificSlot("C", 4)],
            },
            { term: "2027-spring", slots: [specificSlot("D", 4), specificSlot("E", 4)] },
        ]);
        const view = computePreviewView(committed, makePreview(proposed, ["+4 credits in fall"]));
        expect(view.creditDelta.byTerm["2026-fall"]).toBe(4);
        expect(view.creditDelta.byTerm["2027-spring"]).toBe(0);
        expect(view.creditDelta.total).toBe(4);
    });

    it("a term present only in the proposal counts its full credits as the delta", () => {
        const committed = makeFeasibleScheduleWithSemesters(STUDENT, [
            { term: "2026-fall", slots: [specificSlot("A", 4)] },
        ]);
        const proposed = makeFeasibleScheduleWithSemesters(STUDENT, [
            { term: "2026-fall", slots: [specificSlot("A", 4)] },
            { term: "2027-spring", slots: [specificSlot("B", 4)] }, // new term
        ]);
        const view = computePreviewView(committed, makePreview(proposed, ["adds a term"]));
        expect(view.creditDelta.byTerm["2026-fall"]).toBe(0);
        expect(view.creditDelta.byTerm["2027-spring"]).toBe(4);
        expect(view.creditDelta.total).toBe(4);
    });

    it("with no committed plan, every proposed term's credits are a positive delta", () => {
        const proposed = makeProposed(); // fall 12 + spring 4 = 16
        const view = computePreviewView(null, makePreview(proposed, ["first plan"]));
        expect(view.creditDelta.byTerm["2026-fall"]).toBe(12);
        expect(view.creditDelta.byTerm["2027-spring"]).toBe(4);
        expect(view.creditDelta.total).toBe(16);
    });

    it("never mutates the committed plan it reads", () => {
        const committed = makeCommitted();
        const snapshotBefore = JSON.parse(JSON.stringify(committed));
        computePreviewView(committed, makePreview(makeProposed(), ["x"]));
        expect(committed).toEqual(snapshotBefore);
    });
});
