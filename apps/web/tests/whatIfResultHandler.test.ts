// ============================================================
// whatIfResultHandler — Branch-B CONFIRMABLE what-if surfacing
// ============================================================
// Tests call `applyWhatIfResult` — the pure helper extracted from
// `handleWhatIfResult` in page.tsx — to verify the CONFIRMABLE gate
// (owner decision, post-I4 correction):
//
//   • VALID Branch-B what-if   → setPendingPreview (kind:"proposed" scenario
//     with pendingMutationId / Confirm button; R1 intact).
//   • INVALID Branch-B what-if → setInvalidProposal (red explanation card;
//     no Confirm, no Override, NOT chat-only).
//
// The audit (Branch-A program-change) path (buildWhatIfScenarioFromAudit)
// remains read-only and is tested elsewhere.
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

/** Minimal valid WhatIfAssumptionRouteResponse (feasible). */
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
// Tests — VALID Branch-B what-if (CONFIRMABLE: setPendingPreview)
// ---------------------------------------------------------------------------

describe("applyWhatIfResult — VALID Branch-B what-if → CONFIRMABLE proposed scenario", () => {
    it("setPendingPreview is called — pendingPreview is non-null with pendingMutationId", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        const snap = store.getSnapshot();
        expect(snap.pendingPreview).not.toBeNull();
        // pendingMutationId present → Confirm button is wired.
        expect(snap.pendingPreview?.pendingMutationId).toBe(PENDING_ID);
    });

    it("the active scenario is kind:'proposed' (confirmable, not read-only kind:'whatif')", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        const active = store.getActiveScenario();
        expect(active).not.toBeNull();
        expect(active?.kind).toBe("proposed");
    });

    it("the proposed scenario carries the whatIfAssumption marker (badge in ScheduleWorkspace)", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        const snap = store.getSnapshot();
        expect(snap.pendingPreview?.whatIfAssumption).toEqual(MARKER);
    });

    it("no red invalidProposal card is set on the valid path", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeValidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        expect(store.getScenarioState().invalidProposal).toBeNull();
    });

    it("emitScheduleCard is called exactly once with a schedule_card message (H4.2a)", () => {
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

    it("consequences are threaded onto the pendingPreview", () => {
        const resp: WhatIfAssumptionRouteResponse = {
            ...makeValidWhatIfResponse(),
            consequences: ["This might delay your graduation."],
        };
        const store = createPlanStore();

        applyWhatIfResult(resp, { planStore: store, emitScheduleCard: vi.fn(), now: Date.now() });

        const snap = store.getSnapshot();
        expect(snap.pendingPreview?.consequences).toEqual(["This might delay your graduation."]);
    });
});

// ---------------------------------------------------------------------------
// Tests — INVALID Branch-B what-if (red card, NOT chat-only)
// ---------------------------------------------------------------------------

describe("applyWhatIfResult — INVALID Branch-B what-if → red explanation card", () => {
    it("setInvalidProposal is called — red card is non-null", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeInvalidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        // Red card present (NOT chat-only — the card IS the surface).
        expect(store.getScenarioState().invalidProposal).not.toBeNull();
    });

    it("no pendingPreview (no Confirm button) on the invalid path", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeInvalidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        expect(store.getSnapshot().pendingPreview).toBeNull();
    });

    it("NO proposed scenario is created on the invalid path", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeInvalidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        const active = store.getActiveScenario();
        expect(active?.kind).not.toBe("proposed");
        expect(store.getScenarios()).toHaveLength(0);
    });

    it("does NOT call emitScheduleCard on the invalid path", () => {
        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        applyWhatIfResult(makeInvalidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard,
            now: Date.now(),
        });

        expect(emitScheduleCard).not.toHaveBeenCalled();
    });

    it("R1 preserved — committed plan untouched on the invalid path", () => {
        const store = createPlanStore();

        applyWhatIfResult(makeInvalidWhatIfResponse(), {
            planStore: store,
            emitScheduleCard: vi.fn(),
            now: Date.now(),
        });

        expect(store.getSnapshot().forwardSchedule).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Tests — defensive no-op (feasible:true but no forwardSchedule)
// ---------------------------------------------------------------------------

describe("applyWhatIfResult — defensive no-op (feasible:true, no forwardSchedule)", () => {
    it("creates no scenario and sets no card when forwardSchedule is absent", () => {
        const store = createPlanStore();
        const emitScheduleCard = vi.fn();

        const resp: WhatIfAssumptionRouteResponse = {
            ...makeValidWhatIfResponse(),
            forwardSchedule: undefined,
        };
        applyWhatIfResult(resp, { planStore: store, emitScheduleCard, now: Date.now() });

        expect(store.getScenarios()).toHaveLength(0);
        expect(store.getSnapshot().pendingPreview).toBeNull();
        expect(store.getScenarioState().invalidProposal).toBeNull();
        expect(emitScheduleCard).not.toHaveBeenCalled();
    });
});
