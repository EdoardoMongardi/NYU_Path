// ============================================================
// planProposalEvent.ts — I2 refactor: testable dispatch helper
// ============================================================
// Extracted from the `case "plan_proposal":` body in page.tsx so the
// mapping + planActionSurfaces routing can be called from tests without
// a React-DOM render harness.
//
// PURE-ISH — no React, no hooks, no closures.  The two side-effects
// (store mutations + ScheduleCard emit) are injected via `deps` so the
// test can spy on them.
// ============================================================

import {
    planActionSurfaces,
} from "../../lib/planActionSurfaces";
import type { PlanActionRouteResponse } from "../../lib/planActionClient";
import type { PlanStore, Scenario } from "./planState";
import { buildScheduleCardMessage } from "./buildScheduleCardMessage";
import type { ScheduleCardMessage } from "./buildScheduleCardMessage";

// ---------------------------------------------------------------------------
// The exact SSE event shape for "plan_proposal" (mirrored from chatV2Client).
// We re-declare it here (type-only) to avoid importing from chatV2Client,
// which pulls in streaming deps that shouldn't be needed in tests.
// ---------------------------------------------------------------------------

import type { ForwardSchedule, PlanDiff } from "@nyupath/shared";

export interface PlanProposalSseEvent {
    kind: "plan_proposal";
    pendingMutationId: string;
    feasible: boolean;
    consequences: string[];
    proposedSchedule?: ForwardSchedule;
    planDiff?: PlanDiff;
}

// ---------------------------------------------------------------------------
// Deps shape — injected so the caller (page.tsx) can wire up React setters
// and the test can spy without React.
// ---------------------------------------------------------------------------

export interface ApplyPlanProposalDeps {
    planStore: PlanStore;
    /**
     * Called with the newly-built ScheduleCard message when a feasible
     * proposal produces a proposed scenario.  page.tsx implements this as
     * `(msg) => { setMessages(prev => [...prev, msg]); setTimeout(scrollToBottom, 50); }`.
     * Tests inject a jest/vitest spy.
     */
    emitScheduleCard: (msg: ScheduleCardMessage, scenario: Scenario) => void;
}

// ---------------------------------------------------------------------------
// Public API — verbatim logic from the `case "plan_proposal":` body.
// ---------------------------------------------------------------------------

/**
 * Handle a `plan_proposal` SSE event.
 *
 * Steps (verbatim from `case "plan_proposal":` in page.tsx):
 *  1. Map the SSE event → PlanActionRouteResponse (rename proposedSchedule →
 *     forwardSchedule; sentinel diff).
 *  2. Call planActionSurfaces(response, "propose").
 *  3. Infeasible → setInvalidProposal + clearPendingPreview.
 *     Feasible   → setPendingPreview + clearInvalidProposal + emit ScheduleCard
 *                  (only if the store now has a kind:"proposed" active scenario).
 */
export function applyPlanProposalEvent(
    ev: PlanProposalSseEvent,
    deps: ApplyPlanProposalDeps,
): void {
    const { planStore, emitScheduleCard } = deps;

    // ── Step 1: field mapping ──────────────────────────────────────────────
    // The SSE event field is named `proposedSchedule`; the route response
    // (and planActionSurfaces) expects `forwardSchedule`.  The `diff` field
    // is not surfaced in the SSE event; provide an empty sentinel so the type
    // contract is satisfied (planActionSurfaces doesn't read it).
    const proposalResponse: PlanActionRouteResponse = {
        feasible: ev.feasible,
        pendingMutationId: ev.pendingMutationId,
        consequences: ev.consequences,
        diff: { added: [], removed: [] },
        ...(ev.proposedSchedule ? { forwardSchedule: ev.proposedSchedule } : {}),
        ...(ev.planDiff ? { planDiff: ev.planDiff } : {}),
        explanation: "",
        futureTerms: [],
    };

    // ── Step 2: planActionSurfaces — same helper as every sidebar verb ─────
    const proposalSurfaces = planActionSurfaces(proposalResponse, "propose");

    // ── Step 3: store mutations + ScheduleCard emit ────────────────────────
    if (proposalSurfaces.invalidCard) {
        planStore.setInvalidProposal(proposalSurfaces.invalidCard);
        planStore.clearPendingPreview();
    } else if (proposalSurfaces.preview) {
        planStore.setPendingPreview(proposalSurfaces.preview);
        planStore.clearInvalidProposal();
        // H4.2a — emit a ScheduleCard into the chat thread so the student can
        // open/compare the proposed scenario directly from the conversation
        // (mirrors the sidebar verb path).
        const activeSc = planStore.getActiveScenario();
        if (activeSc && activeSc.kind === "proposed") {
            const cardMsgId = Date.now().toString() + Math.random().toString(36).slice(2, 6);
            const cardMsg = buildScheduleCardMessage(activeSc, cardMsgId, new Date());
            emitScheduleCard(cardMsg, activeSc);
        }
    }
}
