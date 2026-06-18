// ============================================================
// planActionSurfaces (Phase 4 Task E3.4) — the SINGLE, pure decision of
// which surfaces a deterministic plan-action route response drives, now
// that drag is removed and the per-course ⋯ menu is the sole edit input.
// ============================================================
// apps/web has NO React-DOM render harness (vitest runs in `node`). Per
// the established repo idiom (planState.ts / planPreview.ts /
// reviewCard.ts), the decision logic lives here as a pure function and
// `handlePlanActionResult` in page.tsx is a thin consumer.
//
// THREE surfaces, derived STRICTLY from the engine's own verdict:
//
//   - `preview`      — a STAGED `PendingPreview` overlay (the E3.1
//                      violet canvas preview + the E3.2 review card).
//                      Set for a FEASIBLE result (clean OR trade-offs)
//                      that carries a proposed `forwardSchedule`; null
//                      otherwise. The committed plan is NEVER mutated —
//                      the preview applies only on Confirm.
//   - `invalidCard`  — the E3.3 RED card naming the binding
//                      constraint(s) (via `computeInvalidCard`, which
//                      invents nothing). Set for a `feasible:false`
//                      result; null otherwise. No proposed-plan overlay.
//   - `showBubble`   — whether the page mints a chat `plan_action_bubble`.
//                      Bubble↔card dedup (a code-review note for E3.4):
//                        * FEASIBLE path (clean + trade-offs) → FALSE —
//                          the canvas review card is the SOLE surface,
//                          which removes the double-surface + the
//                          card→bubble stale-button bug entirely.
//                        * `feasible:false` path → TRUE — the chat bubble
//                          carries Override-anyway / hard-refusal copy the
//                          red card doesn't, so it renders ALONGSIDE the
//                          red card.
//
// NO-INVENTION GUARD: this helper reads ONLY the engine fields and
// delegates the red-card constraint extraction to `computeInvalidCard`.
// It never fabricates a preview, a constraint, or a bubble.
// ============================================================

import type { PlanActionResponse } from "./planActionOrchestrator";
import type { PendingPreview } from "../app/chat/planState";
import { computeInvalidCard, type InvalidProposalCard } from "./reviewCard";
import type { WhatIfAssumptionMarker } from "@nyupath/engine";

export interface PlanActionSurfaces {
    /** Feasible (clean OR trade-offs) + a proposed `forwardSchedule`
     *  present → the staged preview overlay; else null. */
    preview: PendingPreview | null;
    /** `!feasible` → the RED invalid-proposal card; else null. */
    invalidCard: InvalidProposalCard | null;
    /** Whether the page should mint a chat `plan_action_bubble`. False
     *  for the feasible path (the canvas card is the sole surface); true
     *  for the `feasible:false` path (Override-anyway / hard-refusal copy). */
    showBubble: boolean;
}

/**
 * Decide the surfaces a plan-action route response drives. Pure: reads
 * only engine fields, allocates nothing on any store, never mutates the
 * response.
 *
 * `verb` (the ⋯-menu verb that produced this response) is threaded onto
 * the preview + the red card so the surfaces can label themselves
 * ("Review: move change" / "Can't add — invalid change"). Optional.
 */
export function planActionSurfaces(
    response: PlanActionResponse,
    verb?: string,
): PlanActionSurfaces {
    // feasible:false → the RED card (E3.3), NO preview, KEEP the bubble.
    if (response.feasible === false) {
        return {
            preview: null,
            invalidCard: computeInvalidCard(response, verb),
            showBubble: true,
        };
    }

    // Feasible (clean OR trade-offs) WITH a proposed schedule → the
    // staged preview (E3.1) + the review card (E3.2). NO bubble — the
    // canvas review card is the sole surface for the feasible path.
    if (response.forwardSchedule) {
        // Plan 35 G3.2 — a what-if-assumption response (from /api/plan/whatif)
        // carries a `whatIfAssumption` marker; thread it onto the preview so
        // the review card renders the "assumes you withdraw/PF X — not a fact"
        // badge. Absent for ordinary plan-action verbs.
        const whatIfAssumption = (response as { whatIfAssumption?: WhatIfAssumptionMarker })
            .whatIfAssumption;
        const preview: PendingPreview = {
            proposedSchedule: response.forwardSchedule,
            pendingMutationId: response.pendingMutationId,
            consequences: response.consequences,
            ...(response.planDiff ? { planDiff: response.planDiff } : {}),
            ...(verb !== undefined ? { verb } : {}),
            ...(whatIfAssumption ? { whatIfAssumption } : {}),
        };
        return { preview, invalidCard: null, showBubble: false };
    }

    // Feasible but no proposed schedule — defensive no-op. There is
    // nothing to preview and nothing to refuse; mint nothing.
    return { preview: null, invalidCard: null, showBubble: false };
}
