// ============================================================
// Task I2 — client-side plan_proposal SSE event handler
// ============================================================
// The `applyEvent` switch in apps/web/app/chat/page.tsx must, on
// receiving a `plan_proposal` SSE event, map it to the
// PlanActionResponse shape (field rename: proposedSchedule →
// forwardSchedule) and route it through `planActionSurfaces` — the
// SAME pure decision helper used by every sidebar verb. The result
// drives the store:
//
//   • FEASIBLE  + proposedSchedule present:
//       planStore.setPendingPreview(surfaces.preview)
//       planStore.clearInvalidProposal()
//       → getActiveScenario().kind === "proposed"
//         getActiveScenario().pendingMutationId === event.pendingMutationId
//
//   • INFEASIBLE:
//       planStore.setInvalidProposal(surfaces.invalidCard)
//       planStore.clearPendingPreview()
//       → getSnapshot().invalidProposal ≠ null
//         getActiveScenario() is undefined or kind !== "proposed"
//
// Because `applyEvent` is a React-component closure (not exported) the
// store impact cannot be tested by calling `applyEvent` directly
// (apps/web has no React-DOM render harness). Instead we test the PURE
// LOGIC that `case "plan_proposal":` will delegate to:
//   – the field mapping (proposedSchedule → forwardSchedule)
//   – planActionSurfaces(mappedResponse)
//   – the store's setPendingPreview / setInvalidProposal
// This is identical to the established pattern in canvasPreview.test.ts
// and planActionSurfaces.test.ts.
// ============================================================

import { describe, it, expect } from "vitest";
import { createPlanStore } from "../app/chat/planState";
import { planActionSurfaces } from "../lib/planActionSurfaces";
import type { PlanActionRouteResponse } from "../lib/planActionClient";
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

/**
 * Simulate what `case "plan_proposal":` will build from the SSE event:
 * a PlanActionRouteResponse-shaped object with the key rename:
 *   ev.proposedSchedule  →  response.forwardSchedule
 */
function mapEventToResponse(ev: {
    feasible: boolean;
    pendingMutationId: string;
    consequences: string[];
    proposedSchedule?: ReturnType<typeof makeFeasibleScheduleWithSemesters>;
    planDiff?: unknown;
}): PlanActionRouteResponse {
    return {
        feasible: ev.feasible,
        pendingMutationId: ev.pendingMutationId,
        consequences: ev.consequences,
        // `diff` (added/removed slot pairs from PlanChangeOutcome) is not
        // surfaced in the SSE event; provide an empty sentinel — it mirrors
        // what the `case "plan_proposal":` in applyEvent does.
        diff: { added: [], removed: [] },
        ...(ev.proposedSchedule ? { forwardSchedule: ev.proposedSchedule } : {}),
        ...(ev.planDiff ? { planDiff: ev.planDiff as PlanActionRouteResponse["planDiff"] } : {}),
        // These fields are not used by planActionSurfaces but are part of
        // the type (they come from the route response envelope):
        explanation: "",
        futureTerms: [],
    };
}

// ---------------------------------------------------------------------------
// Tests — FEASIBLE path
// ---------------------------------------------------------------------------

describe("plan_proposal client handler — FEASIBLE path", () => {
    it("planActionSurfaces returns a non-null preview for a feasible event with a proposedSchedule", () => {
        const ev = {
            feasible: true as const,
            pendingMutationId: PENDING_ID,
            consequences: [],
            proposedSchedule: makeProposed(),
        };
        const response = mapEventToResponse(ev);
        const surfaces = planActionSurfaces(response, "propose");

        expect(surfaces.preview).not.toBeNull();
        expect(surfaces.invalidCard).toBeNull();
        expect(surfaces.showBubble).toBe(false);

        // The preview carries the same pendingMutationId as the event.
        expect(surfaces.preview!.pendingMutationId).toBe(PENDING_ID);
        expect(surfaces.preview!.proposedSchedule).toBe(ev.proposedSchedule);
        expect(surfaces.preview!.consequences).toEqual([]);
    });

    it("setPendingPreview(surfaces.preview) stages a proposed scenario on the store", () => {
        const ev = {
            feasible: true as const,
            pendingMutationId: PENDING_ID,
            consequences: ["Drop below 15cr: verify with adviser"],
            proposedSchedule: makeProposed(),
        };
        const response = mapEventToResponse(ev);
        const surfaces = planActionSurfaces(response, "propose");

        const store = createPlanStore();
        store.setPendingPreview(surfaces.preview!);
        store.clearInvalidProposal();

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
        expect(snap.pendingPreview!.consequences).toEqual(["Drop below 15cr: verify with adviser"]);

        // R1 guard: the committed plan is UNCHANGED (null in this test — no
        // prior committed plan was set). Staging a preview never commits.
        expect(snap.forwardSchedule).toBeNull();
    });

    it("clearInvalidProposal is a no-op when there is no stale red card", () => {
        const ev = {
            feasible: true as const,
            pendingMutationId: PENDING_ID,
            consequences: [],
            proposedSchedule: makeProposed(),
        };
        const response = mapEventToResponse(ev);
        const surfaces = planActionSurfaces(response);

        const store = createPlanStore();
        store.setPendingPreview(surfaces.preview!);
        store.clearInvalidProposal(); // No red card present — must be a safe no-op.

        expect(store.getSnapshot().invalidProposal).toBeNull();
    });

    it("a feasible proposal with consequences has verdict trade-offs in the scenario", () => {
        const ev = {
            feasible: true as const,
            pendingMutationId: PENDING_ID,
            consequences: ["Consequence 1", "Consequence 2"],
            proposedSchedule: makeProposed(),
        };
        const response = mapEventToResponse(ev);
        const surfaces = planActionSurfaces(response, "propose");
        const store = createPlanStore();
        store.setPendingPreview(surfaces.preview!);

        const active = store.getActiveScenario();
        expect(active!.verdict).toBe("trade-offs");
        expect(active!.hedges).toEqual(["Consequence 1", "Consequence 2"]);
    });

    it("a feasible event WITHOUT proposedSchedule returns null preview (defensive case)", () => {
        // Edge: feasible:true but no proposedSchedule — planActionSurfaces
        // should return preview:null (defensive no-op).
        const ev = {
            feasible: true as const,
            pendingMutationId: PENDING_ID,
            consequences: [],
            // no proposedSchedule
        };
        const response = mapEventToResponse(ev);
        const surfaces = planActionSurfaces(response, "propose");

        expect(surfaces.preview).toBeNull();
        expect(surfaces.invalidCard).toBeNull();
        expect(surfaces.showBubble).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Tests — INFEASIBLE path
// ---------------------------------------------------------------------------

describe("plan_proposal client handler — INFEASIBLE path", () => {
    it("planActionSurfaces returns a non-null invalidCard for an infeasible event", () => {
        const ev = {
            feasible: false as const,
            pendingMutationId: PENDING_ID,
            consequences: [],
            // No proposedSchedule on infeasible path
        };
        // An infeasible response also carries feasibility violation details.
        const response: PlanActionRouteResponse = {
            ...mapEventToResponse(ev),
            feasibility: {
                feasible: false,
                constraintViolations: [
                    { kind: "credits-over-limit", detail: "Too many credits in Fall 2027" },
                ],
                placementRationale: {},
            },
        } as unknown as PlanActionRouteResponse;

        const surfaces = planActionSurfaces(response, "propose");

        expect(surfaces.preview).toBeNull();
        expect(surfaces.invalidCard).not.toBeNull();
        expect(surfaces.showBubble).toBe(true); // bubble + red card on infeasible
    });

    it("setInvalidProposal stages the red card; getActiveScenario is not kind:proposed", () => {
        const ev = {
            feasible: false as const,
            pendingMutationId: PENDING_ID,
            consequences: [],
        };
        const response: PlanActionRouteResponse = {
            ...mapEventToResponse(ev),
            feasibility: {
                feasible: false,
                constraintViolations: [
                    { kind: "credits-over-limit", detail: "Too many credits" },
                ],
                placementRationale: {},
            },
        } as unknown as PlanActionRouteResponse;

        const surfaces = planActionSurfaces(response, "propose");
        const store = createPlanStore();
        store.setInvalidProposal(surfaces.invalidCard!);
        store.clearPendingPreview();

        // No proposed scenario should be active.
        const active = store.getActiveScenario();
        expect(active?.kind).not.toBe("proposed");

        // The red card is set.
        expect(store.getSnapshot().invalidProposal).not.toBeNull();

        // R1 — committed plan untouched.
        expect(store.getSnapshot().forwardSchedule).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Mapping invariant — the key rename
// ---------------------------------------------------------------------------

describe("plan_proposal event → PlanActionResponse field mapping", () => {
    it("mapEventToResponse renames proposedSchedule → forwardSchedule", () => {
        const schedule = makeProposed();
        const ev = {
            feasible: true as const,
            pendingMutationId: PENDING_ID,
            consequences: [],
            proposedSchedule: schedule,
        };
        const response = mapEventToResponse(ev);

        // planActionSurfaces reads response.forwardSchedule — not proposedSchedule.
        expect(response.forwardSchedule).toBe(schedule);
        // Verify planActionSurfaces sees the schedule via its forwardSchedule key.
        const surfaces = planActionSurfaces(response);
        expect(surfaces.preview!.proposedSchedule).toBe(schedule);
    });

    it("a missing proposedSchedule on the event maps to an absent forwardSchedule", () => {
        const ev = {
            feasible: true as const,
            pendingMutationId: PENDING_ID,
            consequences: [],
        };
        const response = mapEventToResponse(ev);
        expect(response.forwardSchedule).toBeUndefined();
    });
});
