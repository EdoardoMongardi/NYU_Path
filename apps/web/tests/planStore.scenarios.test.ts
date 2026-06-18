// ============================================================
// planStore.scenarios (plan 36 Task H0.2) — the store's NEW
// scenario API drives the pure scenarioModel correctly, and the
// backward-COMPAT facade stays coherent on top of it.
// ============================================================
// H0.2 refactored `apps/web/app/chat/planState.ts` so its INTERNAL
// state is the pure `ScenarioState` model (a committed anchor + a list
// of proposed/whatif scenarios + activeId + compare) PLUS the two
// orthogonal fields it doesn't own. This suite pins the NEW surface:
//   - addScenario → it is the active scenario AND the compat
//     `pendingPreview` reflects a proposed one;
//   - confirmProposed → committed updated, the compat `forwardSchedule`
//     reflects it, pendingPreview goes null;
//   - openCompare / closeCompare;
//   - referential stability on a model no-op (discard absent id).
//
// The legacy compat contract (setForwardSchedule / setPendingPreview /
// invalidProposal etc.) is pinned by sharedPlanState/canvasPreview/
// reviewCard/invalidProposal/dragProposesNotApplies — NOT re-tested here.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { createPlanStore, type Scenario } from "../app/chat/planState";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures — minimal real-shaped schedules; only identity is load-bearing.
// ---------------------------------------------------------------------------

function makeSchedule(graduationTerm: string): ForwardSchedule {
    return { graduationTerm, semesters: [] } as unknown as ForwardSchedule;
}

let seq = 0;
function makeProposedScenario(schedule: ForwardSchedule, label = "Proposed"): Scenario {
    return {
        id: `sc-${seq++}`,
        kind: "proposed",
        label,
        schedule,
        verdict: "valid",
        pendingMutationId: `pmid-${seq}`,
        createdAt: 0,
    };
}

function makeWhatifScenario(schedule: ForwardSchedule, label = "What-if"): Scenario {
    return {
        id: `wi-${seq++}`,
        kind: "whatif",
        label,
        schedule,
        verdict: "trade-offs",
        createdAt: 0,
    };
}

// ===========================================================================
// addScenario — active scenario + compat pendingPreview
// ===========================================================================

describe("planStore — addScenario", () => {
    it("makes the new scenario active AND the compat pendingPreview reflects a proposed one", () => {
        const committed = makeSchedule("committed");
        const store = createPlanStore({ forwardSchedule: committed });
        const proposedSched = makeSchedule("proposed");
        const sc = makeProposedScenario(proposedSched, "Proposed: move");

        store.addScenario(sc);

        // New scenario API: it is the active scenario, and it's in the list.
        expect(store.getActiveScenario()?.id).toBe(sc.id);
        expect(store.getScenarios().map((s) => s.id)).toContain(sc.id);
        // Committed anchor unchanged.
        expect(store.getCommitted()).toBe(committed);

        // Compat facade: a proposed active scenario surfaces a pendingPreview
        // pointing at the proposed schedule; committed plan untouched.
        const snap = store.getSnapshot();
        expect(snap.pendingPreview).not.toBeNull();
        expect(snap.pendingPreview?.proposedSchedule).toBe(proposedSched);
        expect(snap.pendingPreview?.pendingMutationId).toBe(sc.pendingMutationId);
        expect(snap.forwardSchedule).toBe(committed);
    });

    it("a WHATIF active scenario does NOT surface a compat pendingPreview (proposed-only)", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("c") });
        store.addScenario(makeWhatifScenario(makeSchedule("wi")));
        // Active scenario exists…
        expect(store.getActiveScenario()?.kind).toBe("whatif");
        // …but the compat preview overlay is for proposed only.
        expect(store.getSnapshot().pendingPreview).toBeNull();
    });

    it("notifies subscribers on add", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("c") });
        const listener = vi.fn();
        store.subscribe(listener);
        store.addScenario(makeProposedScenario(makeSchedule("p")));
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

// ===========================================================================
// confirmProposed — commit chokepoint
// ===========================================================================

describe("planStore — confirmProposed", () => {
    it("updates committed, the compat forwardSchedule reflects it, pendingPreview goes null", () => {
        const committed = makeSchedule("committed");
        const store = createPlanStore({ forwardSchedule: committed });
        const proposedSched = makeSchedule("proposed");
        const sc = makeProposedScenario(proposedSched);
        store.addScenario(sc);

        // Sanity: staged.
        expect(store.getSnapshot().pendingPreview).not.toBeNull();

        store.confirmProposed(sc.id);

        // Committed is now the proposed schedule (by reference).
        expect(store.getCommitted()).toBe(proposedSched);
        // The scenario is removed from the list and active falls back.
        expect(store.getScenarios().map((s) => s.id)).not.toContain(sc.id);
        expect(store.getActiveScenario()?.kind).toBe("committed");

        // Compat facade: forwardSchedule reflects the new committed, no preview.
        const snap = store.getSnapshot();
        expect(snap.forwardSchedule).toBe(proposedSched);
        expect(snap.pendingPreview).toBeNull();
        expect(snap.invalidProposal).toBeNull();
    });

    it("throws when confirming a non-proposed scenario", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("c") });
        const wi = makeWhatifScenario(makeSchedule("wi"));
        store.addScenario(wi);
        expect(() => store.confirmProposed(wi.id)).toThrow();
    });
});

// ===========================================================================
// openCompare / closeCompare
// ===========================================================================

describe("planStore — compare", () => {
    it("openCompare sets the compare pair; closeCompare clears it", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const a = makeProposedScenario(makeSchedule("a"), "A");
        const b = makeProposedScenario(makeSchedule("b"), "B");
        store.addScenario(a);
        store.addScenario(b);

        store.openCompare(a.id, b.id);
        expect(store.getScenarioState().compare).toEqual({ leftId: a.id, rightId: b.id });

        store.closeCompare();
        expect(store.getScenarioState().compare).toBeNull();
    });

    it("openCompare against the committed anchor works", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const a = makeProposedScenario(makeSchedule("a"), "A");
        store.addScenario(a);
        store.openCompare("committed", a.id);
        expect(store.getScenarioState().compare).toEqual({ leftId: "committed", rightId: a.id });
    });

    it("openCompare throws on equal ids", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        expect(() => store.openCompare("committed", "committed")).toThrow();
    });
});

// ===========================================================================
// setActive / discardScenario
// ===========================================================================

describe("planStore — setActive / discardScenario", () => {
    it("setActive switches the active tab and clears compare", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const a = makeProposedScenario(makeSchedule("a"), "A");
        const b = makeProposedScenario(makeSchedule("b"), "B");
        store.addScenario(a);
        store.addScenario(b);
        store.openCompare(a.id, b.id);

        store.setActive(a.id);
        expect(store.getActiveScenario()?.id).toBe(a.id);
        expect(store.getScenarioState().compare).toBeNull();
    });

    it("discardScenario removes it and falls active back to committed", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const a = makeProposedScenario(makeSchedule("a"), "A");
        store.addScenario(a);
        expect(store.getActiveScenario()?.id).toBe(a.id);

        store.discardScenario(a.id);
        expect(store.getScenarios()).toHaveLength(0);
        expect(store.getActiveScenario()?.kind).toBe("committed");
    });
});

// ===========================================================================
// Referential stability — a model no-op must NOT re-materialize / notify
// ===========================================================================

describe("planStore — referential stability on no-ops", () => {
    it("discarding an ABSENT scenario is a no-op: snapshot reference stable, no notify", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const before = store.getSnapshot();
        const listener = vi.fn();
        store.subscribe(listener);

        store.discardScenario("does-not-exist");

        // The scenarioModel reducer returns the SAME ScenarioState reference
        // for an absent-id discard, so the store skips the commit entirely.
        expect(store.getSnapshot()).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    it("getSnapshot is a STABLE reference across no-op reads (React 19 caching)", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const a = store.getSnapshot();
        const b = store.getSnapshot();
        expect(b).toBe(a);
    });

    it("a real scenario change swaps the snapshot reference", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const before = store.getSnapshot();
        store.addScenario(makeProposedScenario(makeSchedule("p")));
        expect(store.getSnapshot()).not.toBe(before);
    });
});

// ===========================================================================
// setCommitted — replace the anchor, keep scenarios
// ===========================================================================

describe("planStore — setCommitted", () => {
    it("replaces the committed anchor WITHOUT dropping scenarios", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("v1") });
        const a = makeProposedScenario(makeSchedule("a"), "A");
        store.addScenario(a);

        const v2 = makeSchedule("v2");
        store.setCommitted(v2);

        expect(store.getCommitted()).toBe(v2);
        // The scenario survives (setCommitted is NOT the stale-card chokepoint
        // that setForwardSchedule is — it only swaps the anchor).
        expect(store.getScenarios().map((s) => s.id)).toContain(a.id);
    });
});
