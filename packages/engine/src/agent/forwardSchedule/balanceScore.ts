/**
 * Phase 13 Decision #25 — Plan-level aggregate balance score.
 * Lower = better. Range roughly 0 (perfect) to ~50 (deeply imbalanced).
 *
 * Components:
 *   α × variance(weightedCredits across terms)
 * + β × variance(hardCount across terms)
 * + γ × loadStyleDeviation(semesters, loadStyle)
 *
 * Coefficients (calibrated empirically once first 5–10 student plans land):
 *   α = 1.0, β = 2.0, γ = 0.5
 *
 * loadStyleDeviation:
 *   - "balanced" / "light" / "heavy": treated as balanced → deviation = 0.
 *     (Per-term load-style overrides are captured in ForwardSemester.loadRationale,
 *     not in the plan-level score.)
 *   - "frontload": credit-weighted-mean term index (centroid) should be ≤ median
 *     term index (earlier terms). deviation = max(0, centroid − medianTermIdx).
 *   - "backload": inverse. deviation = max(0, medianTermIdx − centroid).
 *
 * Variance formula: population variance — mean(x²) − mean(x)². (No n−1 bias
 * correction — each term is a census, not a sample.)
 *
 * Edge case: semesters.length === 0 → returns 0.
 */

import type { ForwardSemester } from "@nyupath/shared";

export type LoadStyle = "balanced" | "frontload" | "backload" | "light" | "heavy";

export const BALANCE_SCORE_COEFFICIENTS = {
    weightedCreditsVariance: 1.0,
    hardCountVariance: 2.0,
    loadStyleDeviation: 0.5,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the plan-level balance score (lower = better balance).
 * Pure function — no I/O, no module state.
 */
export function computeBalanceScore(semesters: ForwardSemester[], loadStyle: LoadStyle): number {
    if (semesters.length === 0) return 0;

    const credits = semesters.map(s => s.plannedCredits);
    const hard    = semesters.map(s => s.loadRationale.hardCount);

    const { weightedCreditsVariance: A, hardCountVariance: B, loadStyleDeviation: G } =
        BALANCE_SCORE_COEFFICIENTS;

    const varCredits = populationVariance(credits);
    const varHard    = populationVariance(hard);
    const lsd        = computeLoadStyleDeviation(credits, loadStyle);

    return A * varCredits + B * varHard + G * lsd;
}

/**
 * Classify the delta between two balance scores (after − before).
 * Positive delta → after-plan is MORE imbalanced.
 */
export function classifyBalanceDelta(
    before: number,
    after: number,
): "improved" | "negligible" | "degraded-mild" | "degraded-significant" {
    const delta = after - before;
    if (delta <= 0) return "improved";
    if (delta < 1.5) return "negligible";
    if (delta < 4) return "degraded-mild";
    return "degraded-significant";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Population variance: mean(x²) − mean(x)². */
function populationVariance(values: number[]): number {
    const n = values.length;
    if (n === 0) return 0;
    const mean  = values.reduce((s, x) => s + x, 0) / n;
    const mean2 = values.reduce((s, x) => s + x * x, 0) / n;
    return mean2 - mean * mean;
}

/**
 * loadStyleDeviation — measures how far the credit distribution deviates
 * from the desired load pattern (frontload vs backload).
 *
 * For "balanced", "light", "heavy": 0 (per-term overrides are not penalised
 * at the plan level; they're captured in ForwardSemester.loadRationale).
 *
 * centroid = credit-weighted mean term index
 * medianTermIdx = (n − 1) / 2
 *
 * frontload: deviation = max(0, centroid − medianTermIdx)   (want centroid ≤ median)
 * backload:  deviation = max(0, medianTermIdx − centroid)   (want centroid ≥ median)
 */
function computeLoadStyleDeviation(credits: number[], loadStyle: LoadStyle): number {
    if (loadStyle === "balanced" || loadStyle === "light" || loadStyle === "heavy") {
        return 0;
    }

    const n = credits.length;
    if (n <= 1) return 0;

    const totalCredits = credits.reduce((s, c) => s + c, 0);
    if (totalCredits === 0) return 0;

    // Credit-weighted mean term index (0-based)
    const centroid = credits.reduce((s, c, i) => s + c * i, 0) / totalCredits;
    const medianTermIdx = (n - 1) / 2;

    if (loadStyle === "frontload") {
        // Penalise if centroid is LATER than median (credits heavy toward end)
        return Math.max(0, centroid - medianTermIdx);
    } else {
        // backload: penalise if centroid is EARLIER than median
        return Math.max(0, medianTermIdx - centroid);
    }
}
