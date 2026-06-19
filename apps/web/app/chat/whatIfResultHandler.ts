// ============================================================
// whatIfResultHandler.ts — I4: verdict-gated what-if surfacing
// ============================================================
// Extracted from `handleWhatIfResult` in page.tsx so the gating
// logic can be unit-tested without a React-DOM render harness.
//
// VERDICT GATE (I4):
//   • VALID (feasible, forwardSchedule present)  → addScenario a
//     READ-ONLY kind:"whatif" tab + emit a ScheduleCard into chat.
//   • INVALID (feasible:false OR no forwardSchedule) → NO workspace
//     surface at all: skip addScenario AND skip setInvalidProposal.
//     The agent already narrated the consequence in the chat turn;
//     a read-only invalid what-if is neither adoptable nor
//     meaningfully comparable, so it gets no tab and no red card.
//
// PROPOSED path is handled separately by applyPlanProposalEvent.
// This helper covers ONLY the /api/plan/whatif (Branch B) path.
//
// PURE-ISH — no React, no hooks.  Side-effects (store mutations +
// ScheduleCard emit) are injected via `deps` so tests can spy.
// ============================================================

import type { WhatIfAssumptionRouteResponse } from "../../lib/planActionClient";
import type { PlanStore, Scenario } from "./planState";
import { buildScheduleCardMessage } from "./buildScheduleCardMessage";
import type { ScheduleCardMessage } from "./buildScheduleCardMessage";
import { mapStateToVerdict } from "./buildWhatIfScenarioFromAudit";

// ---------------------------------------------------------------------------
// Deps shape — injected so the caller (page.tsx) can wire up React setters
// and the test can spy without React.
// ---------------------------------------------------------------------------

export interface ApplyWhatIfResultDeps {
    planStore: PlanStore;
    /**
     * Called with the newly-built ScheduleCard message when a valid what-if
     * produces a read-only scenario tab.  page.tsx implements this as
     * `(msg) => { setMessages(prev => [...prev, msg]); setTimeout(scrollToBottom, 50); }`.
     * Tests inject a vitest spy.
     */
    emitScheduleCard: (msg: ScheduleCardMessage, scenario: Scenario) => void;
    /**
     * Epoch ms timestamp for the created scenario.  page.tsx passes `Date.now()`.
     * Tests inject a fixed value for determinism.
     */
    now: number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle a /api/plan/whatif (Branch B: current-term withdraw/pass-fail)
 * success response.
 *
 * VERDICT GATE (I4):
 *  - VALID  → addScenario (read-only kind:"whatif" tab) + emitScheduleCard.
 *  - INVALID → no workspace surface: skip addScenario AND setInvalidProposal.
 *
 * The caller is responsible for routing network/HTTP errors before calling
 * this helper (those go into a plain chat message, not through this path).
 */
export function applyWhatIfResult(
    data: WhatIfAssumptionRouteResponse,
    deps: ApplyWhatIfResultDeps,
): void {
    const { planStore, emitScheduleCard, now } = deps;

    // ── INVALID gate ─────────────────────────────────────────────────────
    // feasible:false OR no forwardSchedule → NO workspace surface.
    // The agent's chat narrative already explains the consequence.
    if (data.feasible === false || !data.forwardSchedule) {
        // Do NOT call setInvalidProposal (I4: invalid what-if is chat-only).
        // Do NOT call setPendingPreview.
        return;
    }

    // ── VALID path ────────────────────────────────────────────────────────
    // Build a READ-ONLY kind:"whatif" scenario (no pendingMutationId →
    // the workspace shows Discard, NEVER Confirm).
    const marker = data.whatIfAssumption;
    const scenarioId =
        "whatif-assumption-" + now.toString() + Math.random().toString(36).slice(2, 6);

    const scenario: Scenario = {
        id: scenarioId,
        kind: "whatif",
        // Prefer the human-readable assumption label from the marker;
        // fall back to the course-id when the marker is absent (defensive).
        label: marker?.label ?? marker?.courseId ?? "What-if scenario",
        schedule: data.forwardSchedule,
        // If the schedule state is infeasible, verdict is "invalid".
        // If there are consequences, bump to "trade-offs" regardless of
        // the clean/trade-off distinction in the schedule state.
        // This mirrors the legacy previewToScenario logic in planState.ts.
        verdict: (() => {
            const base = mapStateToVerdict(data.forwardSchedule!.state);
            if (base === "invalid") return "invalid";
            return data.consequences?.length ? "trade-offs" : base;
        })(),
        ...(data.consequences?.length ? { hedges: data.consequences } : {}),
        // whatIfAssumption for the badge in ScheduleWorkspace.
        ...(marker ? { whatIfAssumption: marker } : {}),
        rederive: marker
            ? { via: "whatif_assumption", courseId: marker.courseId, outcome: marker.outcome }
            : undefined,
        createdAt: now,
        // NO pendingMutationId — this is read-only (cannot be confirmed).
    };

    planStore.addScenario(scenario);

    // Emit a ScheduleCard into the chat thread so the student can
    // open/compare the new what-if scenario from the conversation.
    const cardMsgId = now.toString() + Math.random().toString(36).slice(2, 6) + "-card";
    const cardMsg = buildScheduleCardMessage(scenario, cardMsgId, new Date(now));
    emitScheduleCard(cardMsg, scenario);
}
