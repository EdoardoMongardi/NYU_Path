// ============================================================
// reviewCard (Phase 4 Task E3.2) — pure, node-testable helpers that
// drive the canvas REVIEW CARD: the verdict (✓/⚠/✗) + trade-off
// summary + Confirm / Cancel actions that sit alongside the E3.1
// preview overlay.
// ============================================================
// apps/web has NO React-DOM render harness (vitest runs in `node`).
// Per the established repo idiom (planState.ts / planPreview.ts), ALL
// the decision logic lives here as pure functions and the React card
// in scheduleSidebar.tsx is a thin consumer.
//
// NO-INVENTION GUARD (§7.4 / §11). The verdict + trade-off lines are
// derived STRICTLY from the engine's own fields on the
// PlanActionResponse:
//   - `feasible` decides the verdict, and
//   - `consequences` (plus an OPTIONAL deterministic summary of a
//     `planDiff` the engine produced) are the ONLY source of
//     trade-off lines.
// The card NEVER fabricates a delta — if the engine surfaced no
// consequences and no diff, there are zero trade-off lines.
// ============================================================

import type { PlanActionResponse, WhatIfAssumptionResponse } from "./planActionOrchestrator";
import type { PlanStore } from "../app/chat/planState";
import type { ForwardSchedule, PlanDiff } from "@nyupath/shared";
import type { WhatIfAssumptionMarker } from "@nyupath/engine";

// ---------------------------------------------------------------------------
// Verdict view.
// ---------------------------------------------------------------------------

export type ReviewVerdict = "valid" | "trade-offs" | "invalid";

export interface ReviewCardView {
    /** feasible && no consequences → "valid"; feasible && consequences
     *  > 0 → "trade-offs"; !feasible → "invalid". */
    verdict: ReviewVerdict;
    /** "✓" | "⚠" | "✗" — the verdict glyph. */
    glyph: string;
    /** A short human label for the verdict. */
    label: string;
    /** Trade-off / advisory lines. Sourced ONLY from the engine's
     *  `consequences` (+ a deterministic `planDiff` summary when the
     *  engine produced one). NEVER fabricated. */
    tradeOffLines: string[];
    /** Whether the proposal may be confirmed — exactly `feasible`. An
     *  invalid (infeasible) proposal CANNOT be confirmed (E3.3 renders
     *  the red card; this flag keeps its Confirm disabled). */
    canConfirm: boolean;
    /** The id the Confirm round-trip hands to /api/plan/confirm. */
    pendingMutationId: string;
    /** G3.2 — present when this proposal is a WHAT-IF ASSUMPTION (Branch B:
     *  W/P-F). The review card uses this to display:
     *   - the assumption label (e.g. "Assumes you withdraw from CSCI-UA 102"),
     *   - the hedges (school-specific P/F warnings + the universal verify rail),
     *   - the windowCaveat (F3 registration-window note), and
     *   - a "Confirming records a PLAN under this assumption — not a fact"
     *     disclaimer.
     *  Absent for ordinary add/swap/drop/lock/move proposals. */
    whatIfAssumption?: WhatIfAssumptionMarker;
}

/**
 * Build a deterministic, engine-grounded summary line for a `planDiff`
 * field — used ONLY for facts the engine itself computed (so this is
 * NOT fabrication, it is a render of the engine's structured diff).
 * Returns null when the field carries no signal worth a line.
 *
 * We deliberately summarise just the graduation-term shift here: it is
 * the single most decision-relevant diff fact that the free-text
 * `consequences[]` does not always spell out. Everything else stays in
 * `consequences` (which the engine already phrases for the student).
 */
function planDiffSummaryLines(diff: PlanDiff): string[] {
    const lines: string[] = [];
    const shift = diff.graduationTermShift;
    if (typeof shift === "number" && shift !== 0) {
        const dir = shift > 0 ? "later" : "earlier";
        const n = Math.abs(shift);
        lines.push(
            `Graduation moves ${n} term${n === 1 ? "" : "s"} ${dir}.`,
        );
    }
    return lines;
}

/**
 * Compute the review-card view from a deterministic plan-action
 * response. Pure: reads only engine fields, allocates nothing on the
 * store, never mutates the response.
 *
 * G3.2: when `response` is a `WhatIfAssumptionResponse` (has a
 * `whatIfAssumption` field), the returned view carries the assumption
 * marker so the review card can display the label + hedges + caveat +
 * the "plan under assumption — not a fact" disclaimer. For an ordinary
 * response the field is absent — normal card, unchanged.
 */
export function computeReviewCard(response: PlanActionResponse): ReviewCardView {
    const feasible = response.feasible === true;
    const consequences = Array.isArray(response.consequences) ? response.consequences : [];

    // Trade-off lines come STRICTLY from the engine's view: the
    // free-text consequences, then any deterministic planDiff summary.
    // No invented copy is ever appended.
    const diffLines = response.planDiff ? planDiffSummaryLines(response.planDiff) : [];
    const tradeOffLines = [...consequences, ...diffLines];

    let verdict: ReviewVerdict;
    let glyph: string;
    let label: string;
    if (!feasible) {
        verdict = "invalid";
        glyph = "✗";
        label = "Invalid — cannot apply";
    } else if (consequences.length > 0 || diffLines.length > 0) {
        verdict = "trade-offs";
        glyph = "⚠";
        label = "Valid — with trade-offs";
    } else {
        verdict = "valid";
        glyph = "✓";
        label = "Valid";
    }

    // G3.2 — if this response is a WhatIfAssumptionResponse, carry the
    // assumption marker through so the review card can label the proposal
    // as an assumption ("Assumes you withdraw from X — not yet on your DPR").
    const whatIfAssumption = (response as Partial<WhatIfAssumptionResponse>).whatIfAssumption;

    return {
        verdict,
        glyph,
        label,
        tradeOffLines,
        // An infeasible proposal can never be confirmed (E3.3's red card
        // reuses this helper with canConfirm:false).
        canConfirm: feasible,
        pendingMutationId: response.pendingMutationId,
        ...(whatIfAssumption ? { whatIfAssumption } : {}),
    };
}

// ---------------------------------------------------------------------------
// Invalid-proposal card (E3.3).
// ---------------------------------------------------------------------------
// A proposal the engine REJECTS (`feasible: false`) never reaches the
// E3.1 preview path — it renders a RED card naming the binding
// constraint(s). Those constraints come STRICTLY from fields the
// response/sidebar already surface:
//   - `response.conflicts` (the propose orchestrator's own rejection
//     reasons — planActionOrchestrator.ts:487), and/or
//   - `response.forwardSchedule.feasibility.constraintViolations` (the
//     SAME source the shipped infeasible banner reads in
//     scheduleSidebar.tsx — `…constraintViolations.slice(0,5).map(v =>
//     v.detail)`).
// There is NO `infeasibilityReport` field anywhere — this helper
// invents nothing. When BOTH sources are empty the binding list is `[]`
// (the card may then show a generic "could not validate — verify with
// your adviser" fallback, but NO invented specifics).
// ---------------------------------------------------------------------------

export interface InvalidProposalCard {
    /** Which verb produced this rejected proposal (add | swap | drop |
     *  lock | move). Optional — drives only the card heading. */
    verb?: string;
    /** The binding constraint(s) that make the proposal invalid:
     *  `response.conflicts` UNION
     *  `response.forwardSchedule.feasibility.constraintViolations`,
     *  mapped to `{kind, detail}` and DEDUPED by `detail`. Both sources
     *  empty → `[]` (NEVER fabricated). */
    bindingConstraints: Array<{ kind: string; detail: string }>;
}

/**
 * Compute the invalid-proposal card from a `feasible:false`
 * PlanActionResponse. Pure: reads only engine fields, allocates nothing
 * on the store, never mutates the response, and NEVER fabricates a
 * constraint — both sources empty yields an empty list.
 *
 * `bindingConstraints` = `(response.conflicts ?? [])` UNION
 * `(response.forwardSchedule?.feasibility?.constraintViolations ?? [])`
 * (each mapped to `{kind, detail}`), deduped by `detail` (first
 * occurrence wins; conflicts are listed before constraintViolations).
 */
export function computeInvalidCard(
    response: PlanActionResponse,
    verb?: string,
): InvalidProposalCard {
    const fromConflicts = Array.isArray(response.conflicts) ? response.conflicts : [];
    const fromViolations = Array.isArray(response.forwardSchedule?.feasibility?.constraintViolations)
        ? response.forwardSchedule!.feasibility.constraintViolations
        : [];

    const seen = new Set<string>();
    const bindingConstraints: Array<{ kind: string; detail: string }> = [];
    for (const c of [...fromConflicts, ...fromViolations]) {
        // Dedup STRICTLY by `detail` (the line the user reads); the first
        // occurrence's kind+detail is kept.
        if (seen.has(c.detail)) continue;
        seen.add(c.detail);
        bindingConstraints.push({ kind: c.kind, detail: c.detail });
    }

    return {
        ...(verb !== undefined ? { verb } : {}),
        bindingConstraints,
    };
}

// ---------------------------------------------------------------------------
// Confirm / Cancel actions — store-mutating, with an INJECTABLE confirm
// fn so the React card's behaviour is unit-testable without a DOM.
// ---------------------------------------------------------------------------

/**
 * The minimal shape of a `planConfirm` result this module needs. We do
 * NOT import the full `PlanActionResult<PlanConfirmRouteResponse>` so
 * the test can pass a small mock; the real `planConfirm` satisfies it
 * structurally.
 */
export interface ReviewConfirmResult {
    ok: boolean;
    data?: { forwardSchedule?: ForwardSchedule };
}

/** A confirm fn matching `planConfirm`'s call signature (the only
 *  argument this module passes is `{ pendingMutationId }`). */
export type ReviewConfirmFn = (
    input: { pendingMutationId: string },
) => Promise<ReviewConfirmResult>;

/**
 * Confirm the staged mutation:
 *   1. call the injected confirm fn with `{ pendingMutationId }`,
 *   2. on success, commit the returned `forwardSchedule` (when present)
 *      and clear the PENDING preview overlay,
 *   3. on failure, leave the preview in place so the user can retry
 *      (mirrors the E3.1 chat-bubble Confirm behaviour).
 *
 * Pure-ish: operates on the injected store + confirm fn, no React.
 * Shares the SAME `setForwardSchedule` + `clearPendingPreview` commit
 * path as the chat-bubble Confirm, so the two surfaces cannot
 * double-commit (each is one confirm round-trip + one clear).
 */
export async function applyReviewConfirm(
    store: PlanStore,
    confirmFn: ReviewConfirmFn,
    pendingMutationId: string,
): Promise<{ ok: boolean }> {
    const res = await confirmFn({ pendingMutationId });
    if (!res.ok) {
        // Retry-able: keep the preview staged, commit nothing.
        return { ok: false };
    }
    // Commit the now-applied plan FIRST so there is no flash of the
    // pre-confirm schedule between the commit and the overlay clear.
    if (res.data?.forwardSchedule) {
        store.setForwardSchedule(res.data.forwardSchedule);
    }
    store.clearPendingPreview();
    return { ok: true };
}

/**
 * Cancel the staged proposal: drop the PENDING overlay locally and
 * revert the canvas to the (untouched) committed plan. NEVER calls the
 * confirm round-trip — nothing was applied, so nothing needs undoing.
 */
export function applyReviewCancel(store: PlanStore): void {
    store.clearPendingPreview();
}
