// ============================================================
// sectionMaterialization/candidatePreRank.ts — Phase 38 G1 + §2②
// ============================================================
// The cheap DETERMINISTIC pre-rank over verified feasible candidates
// (§2 ②). This is the fallback ordering the agent curates on top of
// (§2.5) and the order used directly when no model curation runs.
//
// Ranking rule (strict tiers, never let a soft weight flip them):
//   1. open ≻ waitlist — fewer waitlisted sections is strictly better
//      (per-section penalty; an all-open schedule always outranks any
//      waitlist-containing one);
//   2. within a waitlist tier, higher soft-preference rerank weight
//      (Decision #43 weights, keyed by section CRN, product over the
//      candidate's sections; default 1);
//   3. ties preserve enumeration order (stable).
//
// `preScore` encodes this as a single monotonic number:
//   softTerm = softProduct / (softProduct + 1)   ∈ (0, 1), increasing
//   preScore = -waitlistCount + softTerm
// so any extra waitlisted section drops the score by ~1 (dominating
// the bounded soft term) — open strictly beats waitlist regardless of
// soft weights, and soft weights only refine within a tier.
//
// Pure module — no I/O.
// ============================================================

import type { FeasibleCandidate } from "./feasibleSchedules.js";

export interface RankedCandidate {
    candidate: FeasibleCandidate;
    /** Higher = better. Monotonic with the ranking rule above. */
    preScore: number;
    /** Short human-readable rationale for the pre-rank position. */
    preRankReason: string;
}

function softProductOf(
    candidate: FeasibleCandidate,
    rerankWeights: Map<string, number> | undefined,
): number {
    if (rerankWeights === undefined || rerankWeights.size === 0) return 1;
    let product = 1;
    for (const sel of candidate.selections) {
        for (const s of sel.sections) {
            product *= rerankWeights.get(s.crn) ?? 1;
        }
    }
    return product;
}

function reasonFor(candidate: FeasibleCandidate, softProduct: number): string {
    const parts: string[] = [];
    const wl = candidate.waitlistCrns.length;
    if (wl === 0) {
        parts.push("all sections open");
    } else {
        parts.push(`${wl} waitlisted section${wl === 1 ? "" : "s"} (lower priority — auto-swap backup required)`);
    }
    if (softProduct > 1) parts.push("matches your scheduling preferences");
    else if (softProduct < 1) parts.push("partially matches your scheduling preferences");
    return parts.join("; ");
}

/**
 * Pre-rank verified feasible candidates best-first. Returns a NEW
 * array (input untouched); ties are stable on input order. Pure.
 */
export function preRankCandidates(
    candidates: FeasibleCandidate[],
    rerankWeights?: Map<string, number>,
): RankedCandidate[] {
    const decorated = candidates.map((candidate, i) => {
        const softProduct = softProductOf(candidate, rerankWeights);
        // The open ≻ waitlist invariant rests on softTerm ∈ [0, 1) so the
        // integer waitlist penalty always dominates. That holds only when
        // softProduct > 0 and finite. A rerank multiplier can in principle be
        // 0/negative/non-finite (the SchedulingPreferences `preferTimeWindows`
        // weight is unbounded), which would make softTerm negative or ±Infinity
        // and flip the ranking — so clamp any non-positive/non-finite product to
        // 0 (⇒ softTerm 0), preserving the invariant by construction.
        const safeSoft = Number.isFinite(softProduct) && softProduct > 0 ? softProduct : 0;
        const softTerm = safeSoft / (safeSoft + 1);
        const preScore = -candidate.waitlistCrns.length + softTerm;
        return {
            candidate,
            i,
            preScore,
            preRankReason: reasonFor(candidate, softProduct),
        };
    });
    decorated.sort((a, b) => {
        if (b.preScore !== a.preScore) return b.preScore - a.preScore;
        return a.i - b.i; // stable on ties
    });
    return decorated.map(d => ({
        candidate: d.candidate,
        preScore: d.preScore,
        preRankReason: d.preRankReason,
    }));
}
