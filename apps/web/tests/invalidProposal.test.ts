// ============================================================
// invalidProposal (Phase 4 Task E3.3) — an engine-REJECTED proposal
// (`feasible: false`) NEVER reaches the canvas preview: it renders a
// RED card naming the binding constraint(s), and the committed plan
// stays byte-identical.
// ============================================================
// apps/web has NO React-DOM render harness (vitest runs in the `node`
// env). Per the established repo idiom (sharedPlanState.test.ts /
// canvasPreview.test.ts / reviewCard.test.ts), the render-driving
// LOGIC lives in pure, node-testable modules and this suite drives
// them directly:
//   - `computeInvalidCard` (apps/web/lib/reviewCard.ts) — turns a
//     `feasible:false` PlanActionResponse into the binding-constraint
//     list, sourced STRICTLY from the engine's own fields
//     (`response.conflicts` ∪ `response.forwardSchedule.feasibility
//     .constraintViolations`), deduped by `detail`, NEVER fabricated.
//   - the `invalidProposal` store slot (apps/web/app/chat/planState.ts)
//     + `setInvalidProposal` / `clearInvalidProposal`, mutually
//     exclusive with `pendingPreview` and NEVER touching the committed
//     `forwardSchedule`.
// The React red-card binding lives in scheduleSidebar.tsx, NOT here.
//
// Contract pinned here:
//   (a) computeInvalidCard — conflicts only / constraintViolations
//       only / BOTH (union deduped by detail) / NEITHER (→ [], no
//       fabrication).
//   (b) store + invariant — setInvalidProposal + clearPendingPreview
//       leaves NO preview overlay, sets invalidProposal, and the
//       committed forwardSchedule stays byte-identical (===/deep).
//       clearInvalidProposal nulls it.
//   (c) mutual exclusion — the feasible (preview) path leaves
//       invalidProposal null; the infeasible path leaves
//       pendingPreview null.
// ============================================================

import { describe, it, expect } from "vitest";
import { createPlanStore, type PendingPreview } from "../app/chat/planState";
import { computeInvalidCard } from "../lib/reviewCard";
import type { PlanActionResponse } from "../lib/planActionOrchestrator";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
} from "./_planRouteTestUtils";
import type { ForwardSchedule, FeasibilityReport } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

const STUDENT = "stu-invalid-card";
const PMID = "pmid-invalid-123";

function makeCommitted(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2026-fall", slots: [specificSlot("CSCI-UA.101", 4), specificSlot("MATH-UA.121", 4)] },
        { term: "2027-spring", slots: [specificSlot("CSCI-UA.102", 4), specificSlot("MATH-UA.122", 4)] },
    ]);
}

function makeProposed(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2026-fall", slots: [specificSlot("CSCI-UA.201", 4)] },
    ]);
}

/** Build a ForwardSchedule whose `feasibility.constraintViolations`
 *  carries the supplied detail lines (types.ts:1044-1059 shape). The
 *  rest of the schedule is inert — only `feasibility` is load-bearing. */
function makeScheduleWithViolations(
    violations: Array<{ kind: FeasibilityReport["constraintViolations"][number]["kind"]; detail: string }>,
): ForwardSchedule {
    const base = makeFeasibleScheduleWithSemesters(STUDENT, []);
    return {
        ...base,
        feasibility: {
            feasible: false,
            infeasibilityReason: "constraint violation",
            constraintViolations: violations.map((v) => ({ kind: v.kind, detail: v.detail })),
            placementRationale: {},
        },
    };
}

/** A `feasible:false` PlanActionResponse. `conflicts` and/or a
 *  `forwardSchedule` with non-empty `feasibility.constraintViolations`
 *  are the binding-constraint sources. */
function makeInvalidResponse(opts: {
    conflicts?: Array<{ kind: string; detail: string }>;
    forwardSchedule?: ForwardSchedule;
}): PlanActionResponse {
    return {
        feasible: false,
        diff: { added: [], removed: [] },
        consequences: [],
        explanation: "deterministic template",
        pendingMutationId: PMID,
        futureTerms: [],
        ...(opts.conflicts ? { conflicts: opts.conflicts } : {}),
        ...(opts.forwardSchedule ? { forwardSchedule: opts.forwardSchedule } : {}),
    };
}

function makePreview(proposed: ForwardSchedule, verb = "move"): PendingPreview {
    return {
        proposedSchedule: proposed,
        pendingMutationId: PMID,
        consequences: [],
        verb,
    };
}

// ===========================================================================
// (a) computeInvalidCard — binding constraints from REAL engine fields only.
// ===========================================================================

describe("computeInvalidCard — binding constraints from conflicts ∪ constraintViolations (E3.3)", () => {
    it("conflicts ONLY → exactly those constraints", () => {
        const conflicts = [
            { kind: "prereq", detail: "CSCI-UA.201 requires CSCI-UA.102 first." },
            { kind: "offering", detail: "MATH-UA.999 is not offered in spring." },
        ];
        const card = computeInvalidCard(makeInvalidResponse({ conflicts }), "swap");
        expect(card.verb).toBe("swap");
        expect(card.bindingConstraints).toEqual(conflicts);
    });

    it("constraintViolations ONLY → exactly those constraints (kind+detail)", () => {
        const schedule = makeScheduleWithViolations([
            { kind: "prereq_unsatisfiable", detail: "Prereq chain for CSCI-UA.201 is unsatisfiable." },
            { kind: "credit_ceiling", detail: "Fall 2026 exceeds the 18-credit ceiling." },
        ]);
        const card = computeInvalidCard(makeInvalidResponse({ forwardSchedule: schedule }), "add");
        expect(card.verb).toBe("add");
        expect(card.bindingConstraints).toEqual([
            { kind: "prereq_unsatisfiable", detail: "Prereq chain for CSCI-UA.201 is unsatisfiable." },
            { kind: "credit_ceiling", detail: "Fall 2026 exceeds the 18-credit ceiling." },
        ]);
    });

    it("BOTH sources → union deduped by detail (no duplicate lines)", () => {
        const sharedDetail = "Prereq chain for CSCI-UA.201 is unsatisfiable.";
        const conflicts = [
            { kind: "prereq", detail: sharedDetail },
            { kind: "offering", detail: "Only offered in fall." },
        ];
        const schedule = makeScheduleWithViolations([
            // Duplicate of a conflict (same detail) — must collapse to one.
            { kind: "prereq_unsatisfiable", detail: sharedDetail },
            { kind: "credit_ceiling", detail: "Fall 2026 exceeds the 18-credit ceiling." },
        ]);
        const card = computeInvalidCard(makeInvalidResponse({ conflicts, forwardSchedule: schedule }), "swap");
        const details = card.bindingConstraints.map((c) => c.detail);
        // sharedDetail appears exactly once.
        expect(details.filter((d) => d === sharedDetail)).toHaveLength(1);
        // All three distinct details are present.
        expect(details).toContain(sharedDetail);
        expect(details).toContain("Only offered in fall.");
        expect(details).toContain("Fall 2026 exceeds the 18-credit ceiling.");
        expect(card.bindingConstraints).toHaveLength(3);
    });

    it("NEITHER source → [] (NEVER fabricates a constraint)", () => {
        const card = computeInvalidCard(makeInvalidResponse({}), "drop");
        expect(card.bindingConstraints).toEqual([]);
        // The card carries the verb but invents NO specifics.
        expect(card.verb).toBe("drop");
    });

    it("an empty conflicts array + a feasible-shaped schedule (no violations) → [] (no fabrication)", () => {
        // forwardSchedule present but its feasibility.constraintViolations is empty.
        const schedule = makeFeasibleScheduleWithSemesters(STUDENT, []);
        const card = computeInvalidCard(
            makeInvalidResponse({ conflicts: [], forwardSchedule: schedule }),
        );
        expect(card.bindingConstraints).toEqual([]);
    });
});

// ===========================================================================
// (b) store slot — setInvalidProposal / clearInvalidProposal + the
//     "committed plan byte-identical" invariant.
// ===========================================================================

describe("invalidProposal store slot (E3.3)", () => {
    it("defaults to null on a fresh store", () => {
        const store = createPlanStore();
        expect(store.getSnapshot().invalidProposal).toBeNull();
    });

    it("setInvalidProposal + clearPendingPreview → NO preview, card set, committed plan byte-identical", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });
        // Snapshot the committed plan to prove byte-equality after.
        const before = JSON.parse(JSON.stringify(committed));

        const card = computeInvalidCard(
            makeInvalidResponse({ conflicts: [{ kind: "prereq", detail: "Breaks the CS prereq chain." }] }),
            "swap",
        );

        // The infeasible seam: stage the red card + clear any stale preview.
        store.setInvalidProposal(card);
        store.clearPendingPreview();

        const snap = store.getSnapshot();
        // NO overlay was staged.
        expect(snap.pendingPreview).toBeNull();
        // The red card is set with the engine-sourced constraints.
        expect(snap.invalidProposal).not.toBeNull();
        expect(snap.invalidProposal?.bindingConstraints).toEqual([
            { kind: "prereq", detail: "Breaks the CS prereq chain." },
        ]);
        expect(snap.invalidProposal?.verb).toBe("swap");
        // The committed plan is the SAME reference AND byte-identical.
        expect(snap.forwardSchedule).toBe(committed);
        expect(snap.forwardSchedule).toEqual(before);
    });

    it("clearInvalidProposal nulls the slot (committed plan untouched)", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });
        store.setInvalidProposal(
            computeInvalidCard(makeInvalidResponse({ conflicts: [{ kind: "x", detail: "y" }] })),
        );
        expect(store.getSnapshot().invalidProposal).not.toBeNull();

        store.clearInvalidProposal();
        const snap = store.getSnapshot();
        expect(snap.invalidProposal).toBeNull();
        expect(snap.forwardSchedule).toBe(committed);
    });

    it("getSnapshot returns a STABLE reference between reads (no allocation on read)", () => {
        const store = createPlanStore({ forwardSchedule: makeCommitted() });
        const a = store.getSnapshot();
        const b = store.getSnapshot();
        expect(a).toBe(b);
        store.setInvalidProposal(
            computeInvalidCard(makeInvalidResponse({ conflicts: [{ kind: "x", detail: "y" }] })),
        );
        // After a setter, a NEW snapshot is handed out (so React re-renders)…
        const c = store.getSnapshot();
        expect(c).not.toBe(a);
        // …but it is stable on the next read.
        expect(store.getSnapshot()).toBe(c);
    });
});

// ===========================================================================
// (c) mutual exclusion — preview ⊕ invalidProposal are never both set.
// ===========================================================================

describe("invalidProposal ⊕ pendingPreview mutual exclusion (E3.3)", () => {
    it("the FEASIBLE (preview) path: setPendingPreview + clearInvalidProposal leaves invalidProposal null", () => {
        const committed = makeCommitted();
        const store = createPlanStore({ forwardSchedule: committed });

        // Mirror the page's feasible branch: stage a preview + clear any
        // stale red card.
        store.setPendingPreview(makePreview(makeProposed()));
        store.clearInvalidProposal();

        const snap = store.getSnapshot();
        expect(snap.pendingPreview).not.toBeNull();
        expect(snap.invalidProposal).toBeNull();
        // Committed plan untouched by staging a preview.
        expect(snap.forwardSchedule).toBe(committed);
    });

    it("the INFEASIBLE path: setInvalidProposal + clearPendingPreview leaves pendingPreview null", () => {
        const store = createPlanStore({ forwardSchedule: makeCommitted() });
        // Seed a stale preview to prove the infeasible path clears it.
        store.setPendingPreview(makePreview(makeProposed()));

        store.setInvalidProposal(
            computeInvalidCard(makeInvalidResponse({ conflicts: [{ kind: "x", detail: "y" }] })),
        );
        store.clearPendingPreview();

        const snap = store.getSnapshot();
        expect(snap.invalidProposal).not.toBeNull();
        expect(snap.pendingPreview).toBeNull();
    });

    it("committing a new plan via setForwardSchedule clears a stale red card (the commit chokepoint)", () => {
        // A red card describes a proposal against the PRIOR committed plan;
        // the moment the committed plan changes (clean apply / bubble confirm
        // / override / SSE update / DPR refresh — all route through
        // setForwardSchedule), the card is stale and must clear.
        const store = createPlanStore({ forwardSchedule: makeCommitted() });
        store.setInvalidProposal(
            computeInvalidCard(makeInvalidResponse({ conflicts: [{ kind: "x", detail: "y" }] })),
        );
        // Also seed a stale preview to prove the chokepoint clears both slots.
        store.setPendingPreview(makePreview(makeProposed()));
        expect(store.getSnapshot().invalidProposal).not.toBeNull();

        store.setForwardSchedule(makeProposed());

        const snap = store.getSnapshot();
        expect(snap.invalidProposal).toBeNull();
        expect(snap.pendingPreview).toBeNull();
        expect(snap.forwardSchedule).not.toBeNull();
    });
});
