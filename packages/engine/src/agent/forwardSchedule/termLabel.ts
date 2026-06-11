// ============================================================
// termLabel — the ONE canonical human-term → solver-term normalizer
// ============================================================
// Extracted from buildSolverInput.ts (formerly the private
// `psTermToSolverTerm`) so that BOTH the solver-input builder AND the
// response validator's plan-claim check (checkPlanClaims, D5.1) share a
// single implementation and cannot drift. Any prose-vs-stored-schedule
// term comparison MUST route through this — never raw-string-compare
// "Fall 2027" against the canonical "2027-fall".

/**
 * Convert a human term label to the solver's "{year}-{season}" shape.
 * Accepts EITHER "2026 Fall" (PeopleSoft / DPR) OR "Fall 2026"
 * (deriveTemporalContext output) OR the already-canonical "2026-fall".
 * Returns null when the input isn't a recognizable term label.
 *
 * Season aliases: Fall, Spring (Spr), Summer (Sum), January / J Term /
 * J-Term (→ "january").
 */
export function psTermToSolverTerm(psTerm: string): string | null {
    // Already in solver format → pass through.
    if (/^\d{4}-(?:fall|spring|summer|january)$/i.test(psTerm)) {
        return psTerm.toLowerCase();
    }
    // "YYYY Season" or "Season YYYY".
    const m = psTerm.match(/^(\d{4})\s+(Fall|Spring|Summer|J Term|J-Term|January|Spr|Sum)$/i)
        ?? psTerm.match(/^(Fall|Spring|Summer|J Term|J-Term|January|Spr|Sum)\s+(\d{4})$/i);
    if (!m) return null;
    const [g1, g2] = [m[1]!, m[2]!];
    const yearStr = /^\d{4}$/.test(g1) ? g1 : g2;
    const seasonStr = /^\d{4}$/.test(g1) ? g2 : g1;
    const seasonRaw = seasonStr.toLowerCase();
    const season =
        seasonRaw.startsWith("fa") ? "fall" :
        seasonRaw.startsWith("sp") ? "spring" :
        seasonRaw.startsWith("su") ? "summer" :
        seasonRaw.startsWith("j") ? "january" : null;
    if (!season) return null;
    return `${yearStr}-${season}`;
}
