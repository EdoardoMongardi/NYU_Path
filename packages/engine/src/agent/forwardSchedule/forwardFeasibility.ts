/**
 * Phase 13 Decision #27 — Forward-feasibility SCREEN at every Stage 6c
 * placement. NOT a formal oracle; can produce false positives AND false
 * negatives. Stage 8's runGraduationPathValidator is the actual
 * feasibility gate (Decision #41).
 *
 * The screen is a fast pruning heuristic that prevents the solver from
 * descending into obviously-doomed branches.
 *
 * Algorithm:
 *   1. Capacity check: Σ(ceiling[t] − placed[t]) across remaining terms.
 *      Low-confidence courses ("irregular" | "permission_only") incur a
 *      2.0× demand multiplier (half-capacity penalty).
 *      If total demand > total capacity → false.
 *   2. Depth check: each unmet course must have remainingTerms.length ≥ minDepth.
 *      If any course's minDepth exceeds the number of remaining terms → false.
 *   3. Otherwise → true.
 *
 * Cost: O(unmet + terms).
 */

import type { ConfidenceTier } from "@nyupath/shared";

const LOW_CONFIDENCE_TIERS = new Set<ConfidenceTier>(["irregular", "permission_only"]);

export interface ForwardFeasibilityArgs {
    /** Per-term map of credits already placed (after the trial placement). */
    placedCreditsByTerm: Map<string, number>;
    /** Per-term credit ceiling. */
    creditCeilingByTerm: Map<string, number>;
    /** Remaining unmet courses + their minimum-required term-depths. */
    remainingUnmet: Array<{ courseId: string; credits: number; minDepth: number }>;
    /** Remaining future terms (chronologically ordered). */
    remainingTerms: string[];
    /** Per-courseId offering confidence tier. */
    confidenceByCourse: Map<string, ConfidenceTier>;
}

/**
 * Returns true iff the plan is not obviously infeasible.
 * Pure function — no I/O, no module state.
 */
export function forwardFeasibilityScreen(args: ForwardFeasibilityArgs): boolean {
    const {
        placedCreditsByTerm,
        creditCeilingByTerm,
        remainingUnmet,
        remainingTerms,
        confidenceByCourse,
    } = args;

    // --- 1. Capacity check ---
    let totalCapacity = 0;
    for (const term of remainingTerms) {
        const ceiling = creditCeilingByTerm.get(term) ?? 0;
        const placed  = placedCreditsByTerm.get(term) ?? 0;
        totalCapacity += Math.max(0, ceiling - placed);
    }

    let totalDemand = 0;
    for (const course of remainingUnmet) {
        const confidence = confidenceByCourse.get(course.courseId);
        const multiplier = confidence !== undefined && LOW_CONFIDENCE_TIERS.has(confidence)
            ? 2.0
            : 1.0;
        totalDemand += course.credits * multiplier;
    }

    if (totalDemand > totalCapacity) return false;

    // --- 2. Depth check ---
    const nTerms = remainingTerms.length;
    for (const course of remainingUnmet) {
        if (course.minDepth > nTerms) return false;
    }

    return true;
}
