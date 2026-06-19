// ============================================================
// whatIfResultHandler.ts — Branch-B what-if CONFIRMABLE surfacing
// ============================================================
// Extracted from `handleWhatIfResult` in page.tsx so the gating
// logic can be unit-tested without a React-DOM render harness.
//
// CONFIRMABLE GATE (owner decision, post-I4 correction):
//   • VALID (feasible, forwardSchedule present)  → setPendingPreview
//     (kind:"proposed" scenario with Confirm button; R1 holds —
//     only forward_schedule persists, the synthetic DPR is never written).
//   • INVALID (feasible:false OR no forwardSchedule) → setInvalidProposal
//     (red explanation card; NO Confirm, NO Override — M2 already removed
//     Override).  NOT chat-only; the red card IS the surface.
//
// The audit (Branch-A program-change) path is handled separately by
// buildWhatIfScenarioFromAudit.  This helper covers ONLY the
// /api/plan/whatif (Branch-B: withdraw / pass-fail) path.
//
// PURE-ISH — no React, no hooks.  Side-effects (store mutations +
// ScheduleCard emit) are injected via `deps` so tests can spy.
// ============================================================

import type { WhatIfAssumptionRouteResponse } from "../../lib/planActionClient";
import type { PlanStore } from "./planState";
import { buildScheduleCardMessage } from "./buildScheduleCardMessage";
import type { ScheduleCardMessage } from "./buildScheduleCardMessage";
import { planActionSurfaces } from "../../lib/planActionSurfaces";

// ---------------------------------------------------------------------------
// Deps shape — injected so the caller (page.tsx) can wire up React setters
// and the test can spy without React.
// ---------------------------------------------------------------------------

export interface ApplyWhatIfResultDeps {
    planStore: PlanStore;
    /**
     * Called with the newly-built ScheduleCard message when a valid Branch-B
     * what-if produces a confirmable proposed scenario.  page.tsx implements
     * this as:
     *   `(msg) => { setMessages(prev => [...prev, msg]); setTimeout(scrollToBottom, 50); }`
     * Tests inject a vitest spy.
     */
    emitScheduleCard: (msg: ScheduleCardMessage) => void;
    /**
     * Epoch ms timestamp — page.tsx passes `Date.now()`.
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
 * CONFIRMABLE GATE (owner decision):
 *  - VALID  → setPendingPreview (kind:"proposed" + Confirm button; R1 intact).
 *  - INVALID → setInvalidProposal (red explanation card; no Confirm, no Override).
 *
 * The audit path (Branch A, buildWhatIfScenarioFromAudit) uses a separate
 * read-only kind:"whatif" scenario — this helper is NOT called for that path.
 *
 * The caller is responsible for routing network/HTTP errors before calling
 * this helper (those go into a plain chat message, not through this path).
 */
export function applyWhatIfResult(
    data: WhatIfAssumptionRouteResponse,
    deps: ApplyWhatIfResultDeps,
): void {
    const { planStore, emitScheduleCard, now } = deps;

    // planActionSurfaces decides the surface: preview (confirmable) or
    // invalidCard (red card).  Pass "whatif" as the verb so the review
    // card and red card can label themselves accordingly.
    const surfaces = planActionSurfaces(data, "whatif");

    if (surfaces.invalidCard) {
        // INVALID path — show the red explanation card; clear any stale preview.
        planStore.setInvalidProposal(surfaces.invalidCard);
        planStore.clearPendingPreview();
        return;
    }

    if (surfaces.preview) {
        // VALID path — stage the preview as a confirmable proposed scenario.
        planStore.setPendingPreview(surfaces.preview);
        planStore.clearInvalidProposal();
        // H4.2a — emit a ScheduleCard into the chat thread so the student
        // can open/compare the new what-if scenario from the conversation.
        const activeSc = planStore.getActiveScenario();
        if (activeSc && activeSc.kind === "proposed") {
            const cardMsgId = now.toString() + Math.random().toString(36).slice(2, 6) + "-card";
            const cardMsg = buildScheduleCardMessage(activeSc, cardMsgId, new Date(now));
            emitScheduleCard(cardMsg);
        }
        return;
    }

    // Defensive no-op: feasible but no schedule — nothing to surface.
}
