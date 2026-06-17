// ============================================================
// planPreview (Phase 4 Task E3.1) — pure, node-testable helper that
// turns a STAGED proposal + the committed plan into a render-ready
// preview view for the canvas overlay.
// ============================================================
// The canvas overlay (sidebar) must surface the proposed plan marked
// PENDING, with the *credit delta* vs the committed plan, distinct
// from the committed term cards. All of that derivation is pure data
// transformation — so it lives here (unit-tested in
// apps/web/tests/canvasPreview.test.ts) and the React component is a
// thin consumer.
//
// The credit delta compares the proposed plan's per-term
// `plannedCredits` against the committed plan's, per the real
// `ForwardSemester` shape. `total` is the summed difference; `byTerm`
// is the per-term difference (every term that appears in EITHER plan,
// so a term added or dropped by the proposal still shows its delta).
//
// This module redefines NO types — it imports the real
// `ForwardSchedule` and the store's `PendingPreview`.
// ============================================================

import type { ForwardSchedule, PlanDiff } from "@nyupath/shared";
import type { PendingPreview } from "../app/chat/planState";

/**
 * Render-ready preview the canvas overlay consumes. `creditDelta`
 * is computed against the committed plan; `consequences` / `planDiff`
 * are surfaced straight from the staged proposal.
 */
export interface PreviewView {
    /** The proposed (read-only) schedule to render in the overlay. */
    proposedSchedule: ForwardSchedule;
    /** Opaque id the Confirm button hands to /api/plan/confirm. */
    pendingMutationId: string;
    /** Trade-offs / advisories surfaced under the PENDING banner. */
    consequences: string[];
    /** Structured per-axis diff, when the proposal carried one. */
    planDiff?: PlanDiff;
    /** Credit movement of the proposal relative to the committed plan. */
    creditDelta: {
        /** Net planned-credit change across all terms (proposed − committed). */
        total: number;
        /** Per-term planned-credit change (proposed − committed). Includes
         *  every term present in EITHER plan so added/dropped terms show. */
        byTerm: Record<string, number>;
    };
}

/** Sum a schedule's per-term `plannedCredits` into a {term → credits} map. */
function plannedCreditsByTerm(schedule: ForwardSchedule | null): Map<string, number> {
    const out = new Map<string, number>();
    if (!schedule) return out;
    for (const sem of schedule.semesters) {
        // A schedule should not list a term twice, but sum defensively
        // rather than overwrite if it ever does.
        out.set(sem.term, (out.get(sem.term) ?? 0) + sem.plannedCredits);
    }
    return out;
}

/**
 * Build the render-ready preview view from the committed plan + a
 * staged proposal. The committed plan is read ONLY to compute the
 * credit delta — it is never mutated and never returned (the overlay
 * renders `proposedSchedule`).
 *
 * `committed` may be null (no committed plan yet — e.g. the very first
 * proposal): then every proposed term's credits count as a positive
 * delta.
 */
export function computePreviewView(
    committed: ForwardSchedule | null,
    preview: PendingPreview,
): PreviewView {
    const committedByTerm = plannedCreditsByTerm(committed);
    const proposedByTerm = plannedCreditsByTerm(preview.proposedSchedule);

    // Union of all terms in either plan, so a term added or removed by
    // the proposal still surfaces its delta.
    const allTerms = new Set<string>([...committedByTerm.keys(), ...proposedByTerm.keys()]);

    const byTerm: Record<string, number> = {};
    let total = 0;
    for (const term of allTerms) {
        const delta = (proposedByTerm.get(term) ?? 0) - (committedByTerm.get(term) ?? 0);
        byTerm[term] = delta;
        total += delta;
    }

    return {
        proposedSchedule: preview.proposedSchedule,
        pendingMutationId: preview.pendingMutationId,
        consequences: preview.consequences,
        ...(preview.planDiff ? { planDiff: preview.planDiff } : {}),
        creditDelta: { total, byTerm },
    };
}
