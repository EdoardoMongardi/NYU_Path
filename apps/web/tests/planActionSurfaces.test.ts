import { describe, it, expect } from "vitest";
import { planActionSurfaces } from "../lib/planActionSurfaces";
import type { PlanActionResponse } from "../lib/planActionOrchestrator";
import type { WhatIfAssumptionMarker } from "@nyupath/engine";
import { makeFeasibleScheduleWithSemesters, specificSlot } from "./_planRouteTestUtils";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// planActionSurfaces — Plan 35 G3.2 marker-threading (the pure piece of the
// page wiring). The page's handleWhatIfResult feeds a /api/plan/whatif response
// through this helper; the whatIfAssumption marker must ride onto the preview
// so the review card renders the "assumes you withdraw/PF X — not a fact" badge.
// ---------------------------------------------------------------------------

const STUDENT = "stu-surfaces";

function proposed(): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(STUDENT, [
        { term: "2026-fall", slots: [specificSlot("CSCI-UA.101", 4)] },
    ]);
}

function baseResponse(extra: Partial<PlanActionResponse> = {}): PlanActionResponse {
    return {
        feasible: true,
        diff: { added: [], removed: [] },
        consequences: [],
        explanation: "t",
        pendingMutationId: "pmid-surfaces-1",
        futureTerms: [],
        forwardSchedule: proposed(),
        ...extra,
    };
}

const MARKER: WhatIfAssumptionMarker = {
    courseId: "CSCI-UA.102",
    outcome: "withdraw",
    label: "Assumes you withdraw from CSCI-UA.102 (a \"W\").",
    hedges: ["verify with your adviser"],
    windowCaveat: "within the withdraw window",
};

describe("planActionSurfaces — whatIfAssumption marker threading (G3.2)", () => {
    it("an ordinary feasible response → preview WITHOUT a whatIfAssumption marker", () => {
        const s = planActionSurfaces(baseResponse(), "move");
        expect(s.preview).not.toBeNull();
        expect(s.preview?.whatIfAssumption).toBeUndefined();
        expect(s.invalidCard).toBeNull();
    });

    it("a what-if response (marker present) → preview CARRIES the marker for the badge", () => {
        const resp = baseResponse({ whatIfAssumption: MARKER } as Partial<PlanActionResponse>);
        const s = planActionSurfaces(resp);
        expect(s.preview?.whatIfAssumption).toEqual(MARKER);
        expect(s.preview?.proposedSchedule).toBe(resp.forwardSchedule);
        expect(s.showBubble).toBe(false);
    });

    it("an infeasible what-if response → RED card, no preview (no marker leaks)", () => {
        const resp = baseResponse({
            feasible: false,
            forwardSchedule: undefined,
            whatIfAssumption: MARKER,
        } as Partial<PlanActionResponse>);
        const s = planActionSurfaces(resp);
        expect(s.preview).toBeNull();
        expect(s.invalidCard).not.toBeNull();
    });
});
