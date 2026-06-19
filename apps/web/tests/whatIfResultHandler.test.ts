// ============================================================
// Task I4 — whatIfResultHandler: verdict-gated what-if surfacing
// ============================================================
// Tests call `applyWhatIfResult` — the pure helper extracted from
// `handleWhatIfResult` in page.tsx — to verify the I4 verdict gate:
//
//   • VALID what-if   → addScenario (read-only kind:"whatif" tab) + emitScheduleCard.
//   • INVALID what-if → NO workspace surface (no addScenario, no setInvalidProposal).
//
// The proposed path (applyPlanProposalEvent) is covered in
// planProposalClientHandler.test.ts.  This file focuses on the
// /api/plan/whatif Branch-B surface.
// ============================================================

import { describe, it, expect, vi } from "vitest";
import { createPlanStore } from "../app/chat/planState";
import { applyWhatIfResult } from "../app/chat/whatIfResultHandler";
import type { WhatIfAssumptionRouteResponse } from "../lib/planActionClient";
import type { WhatIfAssumptionMarker } from "@nyupath/engine";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
} from "./_planRouteTestUtils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUDENT = "stu-i4-whatif-test";
const PENDING_ID = "whatif-pending-uuid-abcd5678";

const MARKER: WhatIfAssumptionMarker = {
    courseId: "CSCI-UA 101",
    outcome: "withdraw",
    label: `Assumes you withdraw from CSCI-UA 101 (a "W" — GPA-neutral; the requirement re-opens).`,
    hedges: ["Verify the withdrawal deadline with the Registrar."],
};

function makeValidSchedule() {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2027-fall", slots: [specificSlot("CSCI-UA 201", 4)] },
    ]);
}

function makeInfeasibleSchedule() {
    const s = makeValidSchedule();
    return {
        ...s,
        state: "infeasible-draft" as const,
        feasibility: { feasible: false, constraintViolations: [], placementRationale: {} },
    };
}

/** Minimal valid WhatIfAssumptionRouteResponse. */
function makeValidWhatIfResponse(): WhatIfAssumptionRouteResponse {
    return {
        feasible: true,
        diff: { added: [], removed: [] },
        consequences: [],
        explanation: "Valid what-if plan.",
        pendingMutationId: PENDING_ID,
        futureTerms: [],
        forwardSchedule: makeValidSchedule(),
        whatIfAssumption: MARKER,
    };
}

/** Infeasible WhatIfAssumptionRouteResponse (feasible:false). */
function makeInvalidWhatIfResponse(): WhatIfAssumptionRouteResponse {
    return {
        feasible: false,
        diff: { added: [], removed: [] },
        consequences: [],
        explanation: "This withdraw would leave you below the minimum credit floor.",
        pendingMutationId: PENDING_ID,
        futureTerms: [],
        // No forwardSchedule on infeasible path.
        whatIfAssumption: MARKER,
    };
}

// ---------------------------------------------------------------------------
// Tests — INVALID what-if (I4: no workspace surface)
// ---------------------------------------------------------------------------

describe("applyWhatIfResult — INVALID what-if", () => {
    it("creates NO scenario when feasible:false", () => {
        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        applyWhatIfResult(makeInvalidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard,
            now: Date.now(),
        });

        // No scenario added — scenarios list is empty.
        expect(store.getScenarios()).toHaveLength(0);
    });

    it("does NOT set an invalidProposal (red card) when feasible:false — chat-only", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeInvalidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        // No red card — the agent's chat narration is the sole surface.
        expect(store.getScenarioState().invalidProposal).toBeNull();
    });

    it("does NOT call emitScheduleCard when feasible:false", () => {
        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        applyWhatIfResult(makeInvalidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard,
            now: Date.now(),
        });

        expect(emitScheduleCard).not.toHaveBeenCalled();
    });

    it("creates NO scenario when feasible:true but forwardSchedule absent (defensive)", () => {
        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        const resp: WhatIfAssumptionRouteResponse = {
            ...makeValidWhatIfResponse(),
            forwardSchedule: undefined,
        };
        applyWhatIfResult(resp, { planStore: store, emitScheduleCard, now: Date.now() });

        expect(store.getScenarios()).toHaveLength(0);
        expect(emitScheduleCard).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Tests — VALID what-if (I4: read-only kind:"whatif" scenario tab)
// ---------------------------------------------------------------------------

describe("applyWhatIfResult — VALID what-if", () => {
    it("addScenario is called — scenarios list has exactly one kind:'whatif' entry", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        const scenarios = store.getScenarios();
        expect(scenarios).toHaveLength(1);
        expect(scenarios[0].kind).toBe("whatif");
    });

    it("the whatif scenario has NO pendingMutationId (read-only: no Confirm button)", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        const scenario = store.getScenarios()[0];
        expect(scenario.pendingMutationId).toBeUndefined();
    });

    it("the whatif scenario verdict is 'valid' for a valid-clean schedule", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        expect(store.getScenarios()[0].verdict).toBe("valid");
    });

    it("the whatif scenario verdict is 'trade-offs' when there are consequences", () => {
        const resp: WhatIfAssumptionRouteResponse = {
            ...makeValidWhatIfResponse(),
            consequences: ["This might delay your graduation."],
        };
        const store = createPlanStore();

        applyWhatIfResult(resp, { planStore: store, emitScheduleCard: vi.fn(), now: Date.now() });

        const sc = store.getScenarios()[0];
        expect(sc.verdict).toBe("trade-offs");
        expect(sc.hedges).toEqual(["This might delay your graduation."]);
    });

    it("emitScheduleCard is called exactly once with a schedule_card message", () => {
        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard,
            now: Date.now(),
        });

        expect(emitScheduleCard).toHaveBeenCalledOnce();
        const [msg] = emitScheduleCard.mock.calls[0];
        expect(msg.kind).toBe("schedule_card");
        expect(msg.role).toBe("assistant");
    });

    it("the whatif scenario carries the whatIfAssumption marker", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        const sc = store.getScenarios()[0];
        expect(sc.whatIfAssumption).toEqual(MARKER);
        expect(sc.rederive).toEqual({
            via: "whatif_assumption",
            courseId: MARKER.courseId,
            outcome: MARKER.outcome,
        });
    });

    it("the committed plan (forwardSchedule) is NEVER mutated — R1 preserved", () => {
        const store = createPlanStore();
        // No prior committed plan.
        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        // R1: committed stays null — only Confirm commits.
        expect(store.getSnapshot().forwardSchedule).toBeNull();
    });

    it("no red card is set on the valid path", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        expect(store.getScenarioState().invalidProposal).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Tests — INFEASIBLE-schedule schedule (feasible:true but state:"infeasible-draft")
// The feasible flag comes from the route, but the schedule.state could still be
// infeasible if the engine returns a partial plan.  We treat feasible:false as
// the gate (not schedule.state) to align with planActionSurfaces semantics.
// This test documents the behaviour: if feasible:true + infeasibleSchedule,
// a scenario IS created (the route said feasible=true; the verdict is invalid).
// ---------------------------------------------------------------------------

describe("applyWhatIfResult — feasible:true but schedule state infeasible-draft", () => {
    it("creates a scenario with verdict:'invalid' when schedule.state is infeasible-draft", () => {
        const resp: WhatIfAssumptionRouteResponse = {
            ...makeValidWhatIfResponse(),
            forwardSchedule: makeInfeasibleSchedule(),
        };
        const store = createPlanStore();

        applyWhatIfResult(resp, { planStore: store, emitScheduleCard: vi.fn(), now: Date.now() });

        // feasible:true gate passed → scenario created.
        expect(store.getScenarios()).toHaveLength(1);
        // The scenario's verdict reflects the schedule state.
        expect(store.getScenarios()[0].verdict).toBe("invalid");
    });
});
