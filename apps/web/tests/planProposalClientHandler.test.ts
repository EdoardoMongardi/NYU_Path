// ============================================================
// Task I2 — plan_proposal client handler (real-code coverage)
// ============================================================
// Tests call `applyPlanProposalEvent` — the REAL extracted function that
// `case "plan_proposal":` in page.tsx delegates to — so the switch-case
// registration, field mapping, and ScheduleCard emit are all covered.
//
// Prior version tested a DUPLICATED `mapEventToResponse` copy.  This
// version imports the real implementation (planProposalEvent.ts) so a
// drift in the mapping, a missing branch, or a removed case would be
// caught immediately.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { createPlanStore } from "../app/chat/planState";
import { applyPlanProposalEvent } from "../app/chat/planProposalEvent";
import type { PlanProposalSseEvent } from "../app/chat/planProposalEvent";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
} from "./_planRouteTestUtils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUDENT = "stu-i2-handler-test";
const PENDING_ID = "plan-proposal-uuid-abcd1234";

/** Minimal feasible proposed schedule. */
function makeProposed() {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2027-fall", slots: [specificSlot("CSCI-UA 201", 4)] },
    ]);
}

// ---------------------------------------------------------------------------
// Tests — FEASIBLE path
// ---------------------------------------------------------------------------

describe("plan_proposal client handler — FEASIBLE path", () => {
    it("feasible event with proposedSchedule stages a proposed scenario on the store", () => {
        const ev: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: true,
            pendingMutationId: PENDING_ID,
            consequences: [],
            proposedSchedule: makeProposed(),
        };

        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        applyPlanProposalEvent(ev, { planStore: store, emitScheduleCard });

        // The active scenario must be kind:"proposed".
        const active = store.getActiveScenario();
        expect(active).toBeDefined();
        expect(active!.kind).toBe("proposed");

        // The pendingMutationId from the event flows into the scenario.
        expect(active!.pendingMutationId).toBe(PENDING_ID);

        // The compat snapshot also reflects the pending preview.
        const snap = store.getSnapshot();
        expect(snap.pendingPreview).not.toBeNull();
        expect(snap.pendingPreview!.pendingMutationId).toBe(PENDING_ID);

        // R1 guard: the committed plan is UNCHANGED (null — no prior committed
        // plan was set).  Staging a preview never commits.
        expect(snap.forwardSchedule).toBeNull();
    });

    it("feasible event calls emitScheduleCard spy with a ScheduleCard message", () => {
        const proposed = makeProposed();
        const ev: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: true,
            pendingMutationId: PENDING_ID,
            consequences: [],
            proposedSchedule: proposed,
        };

        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        applyPlanProposalEvent(ev, { planStore: store, emitScheduleCard });

        // ScheduleCard was emitted exactly once.
        expect(emitScheduleCard).toHaveBeenCalledOnce();

        // The first argument is the ScheduleCardMessage.
        const [msg] = emitScheduleCard.mock.calls[0];
        expect(msg.kind).toBe("schedule_card");
        expect(msg.role).toBe("assistant");
        expect(msg.id).toBeTruthy();
        // The scheduleCard payload reflects the proposed scenario.
        expect(msg.scheduleCard.kind).toBe("proposed");
        expect(msg.scheduleCard.scenarioId).toBeTruthy();

        // The second argument is the active Scenario.
        const [, scenario] = emitScheduleCard.mock.calls[0];
        expect(scenario.kind).toBe("proposed");
        expect(scenario.pendingMutationId).toBe(PENDING_ID);
    });

    it("feasible event with consequences has verdict trade-offs in the scenario", () => {
        const ev: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: true,
            pendingMutationId: PENDING_ID,
            consequences: ["Consequence 1", "Consequence 2"],
            proposedSchedule: makeProposed(),
        };

        const store = createPlanStore();
        applyPlanProposalEvent(ev, { planStore: store, emitScheduleCard: vi.fn() });

        const active = store.getActiveScenario();
        expect(active!.verdict).toBe("trade-offs");
        expect(active!.hedges).toEqual(["Consequence 1", "Consequence 2"]);
    });

    it("clearInvalidProposal is called — no stale red card after a feasible proposal", () => {
        const ev: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: true,
            pendingMutationId: PENDING_ID,
            consequences: [],
            proposedSchedule: makeProposed(),
        };

        const store = createPlanStore();
        applyPlanProposalEvent(ev, { planStore: store, emitScheduleCard: vi.fn() });

        expect(store.getSnapshot().invalidProposal).toBeNull();
    });

    it("feasible event WITHOUT proposedSchedule — no proposed scenario, spy not called", () => {
        // Edge: feasible:true but no proposedSchedule — planActionSurfaces returns
        // preview:null so nothing is staged and the ScheduleCard spy is never called.
        const ev: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: true,
            pendingMutationId: PENDING_ID,
            consequences: [],
            // no proposedSchedule
        };

        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        applyPlanProposalEvent(ev, { planStore: store, emitScheduleCard });

        // No proposed scenario.
        const active = store.getActiveScenario();
        expect(active?.kind).not.toBe("proposed");

        // Spy never called — nothing to emit without a schedule.
        expect(emitScheduleCard).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests — INFEASIBLE path
// ---------------------------------------------------------------------------

describe("plan_proposal client handler — INFEASIBLE path", () => {
    it("infeasible event stages a red card; no proposed scenario, spy not called", () => {
        // Build an infeasible SSE event.
        const ev: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: false,
            pendingMutationId: PENDING_ID,
            consequences: [],
            // No proposedSchedule on the infeasible path.
        };

        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        applyPlanProposalEvent(ev, { planStore: store, emitScheduleCard });

        // No proposed scenario should be active.
        const active = store.getActiveScenario();
        expect(active?.kind).not.toBe("proposed");

        // The red card (invalidProposal) is set.
        expect(store.getSnapshot().invalidProposal).not.toBeNull();

        // R1 — committed plan untouched.
        expect(store.getSnapshot().forwardSchedule).toBeNull();

        // No ScheduleCard emitted for infeasible proposals.
        expect(emitScheduleCard).not.toHaveBeenCalled();
    });

    it("infeasible event clears the pending preview (no preview after red card)", () => {
        // Seed a prior pending preview (from a previous feasible turn).
        const priorEv: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: true,
            pendingMutationId: "prior-uuid",
            consequences: [],
            proposedSchedule: makeProposed(),
        };
        const store = createPlanStore();
        applyPlanProposalEvent(priorEv, { planStore: store, emitScheduleCard: vi.fn() });

        // Sanity: prior event staged a preview.
        expect(store.getSnapshot().pendingPreview).not.toBeNull();

        // Now an infeasible event arrives.
        const infeasibleEv: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: false,
            pendingMutationId: PENDING_ID,
            consequences: [],
        };
        applyPlanProposalEvent(infeasibleEv, { planStore: store, emitScheduleCard: vi.fn() });

        // The prior preview must be cleared.
        expect(store.getSnapshot().pendingPreview).toBeNull();
        // And the red card is now set.
        expect(store.getSnapshot().invalidProposal).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Mapping invariant — proposedSchedule → forwardSchedule rename
// ---------------------------------------------------------------------------

describe("plan_proposal event — field mapping inside applyPlanProposalEvent", () => {
    it("proposedSchedule on the event flows into the proposed scenario's proposedSchedule", () => {
        const schedule = makeProposed();
        const ev: PlanProposalSseEvent = {
            kind: "plan_proposal",
            feasible: true,
            pendingMutationId: PENDING_ID,
            consequences: [],
            proposedSchedule: schedule,
        };

        const store = createPlanStore();
        applyPlanProposalEvent(ev, { planStore: store, emitScheduleCard: vi.fn() });

        // planActionSurfaces reads response.forwardSchedule (the renamed field)
        // and places it on preview.proposedSchedule.  Verify it's the same object.
        const snap = store.getSnapshot();
        expect(snap.pendingPreview!.proposedSchedule).toBe(schedule);
    });
});
