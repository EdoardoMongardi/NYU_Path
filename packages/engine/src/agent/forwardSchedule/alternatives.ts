/**
 * Phase 14 Task 4 — Alternatives generator (failure-mode fallback).
 *
 * Decision #12 — When the primary solve returns `feasible: false`, run
 * the solver multiple times with progressively-relaxed inputs and return
 * up to 3 `AlternativeCandidate` objects for the agent to surface.
 *
 * Strategies (in order):
 *   1. include_summer — add summer term(s) to the planning window.
 *   2. include_jterm  — add J-term (January intersession) to the window.
 *   3. extend_grad_one_term — push graduationTerm forward by one main term.
 *
 * Solver note (P2.8 / PLAN-5): the constraint search now DOES read
 * `preferences.includeSummer` / `preferences.includeJTerm` —
 * `buildConstraintContext` enumerates the opted-in optional terms via
 * `enumerateTerms`, treating them as OPTIONAL (no F-1 floor, no force-fill,
 * excluded from balance). So strategies 1 and 2 actually enumerate summer /
 * January and CAN return a non-null `schedule` when an opted-in optional term
 * lets the remaining requirements fit (e.g. a summer-only course, or summer
 * credits that reach the degree minimum within the window). When the optional
 * term still cannot fix the plan, the candidate carries `schedule: null` and
 * `stillInfeasibleReason`. Strategy 3 (extend_grad_one_term) still expands the
 * main-term window. The strategy logic below is unchanged — each strategy sets
 * the flag (or extends the term) and re-solves.
 */

import { solveForwardSchedule } from "./solver.js";
import { nextMainTermOrNull } from "./solverHelpers.js";
import type { SolverInput, SolverOutput } from "./types.js";
import type { AlternativeCandidate } from "@nyupath/shared";
import { finalizeForwardSchedule } from "./build.js";
import type { ValidatorRules } from "./build.js";

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Generate up to 3 alternative schedule candidates by progressively
 * relaxing the original (infeasible) solver input.
 *
 * Callers should only invoke this when `solveForwardSchedule(input).feasibility.feasible`
 * is `false`; the function is otherwise a no-op that returns up to 3 candidates
 * (each of which may itself still be infeasible).
 */
export function simulateAlternatives(input: SolverInput): AlternativeCandidate[] {
    const candidates: AlternativeCandidate[] = [];

    // ---- Strategy 1: add summer term ----
    // Only attempt if `includeSummer` is not already set (would be a no-op).
    if (!input.preferences?.includeSummer) {
        const withSummer: SolverInput = {
            ...input,
            preferences: { ...input.preferences, includeSummer: true },
        };
        const out = solveForwardSchedule(withSummer);
        candidates.push(
            buildCandidate(
                "include_summer",
                "Adding a summer term may allow remaining requirements to fit.",
                out,
                withSummer,
                "Even with summer added, no feasible plan could be constructed.",
            ),
        );
    }

    // ---- Strategy 2: add J-term ----
    // Only attempt if `includeJTerm` is not already set.
    if (!input.preferences?.includeJTerm) {
        const withJTerm: SolverInput = {
            ...input,
            preferences: { ...input.preferences, includeJTerm: true },
        };
        const out = solveForwardSchedule(withJTerm);
        candidates.push(
            buildCandidate(
                "include_jterm",
                "Adding J-term (January intersession) may allow remaining requirements to fit.",
                out,
                withJTerm,
                "Even with J-term added, no feasible plan could be constructed.",
            ),
        );
    }

    // ---- Strategy 3: extend graduation by one main term ----
    // spring → same-year fall; fall → next-year spring.
    const extendedTerm = nextMainTermOrNull(input.graduationTerm);
    if (extendedTerm !== null) {
        const extended: SolverInput = {
            ...input,
            graduationTerm: extendedTerm,
        };
        const out = solveForwardSchedule(extended);
        candidates.push(
            buildCandidate(
                "extend_grad_one_term",
                `Pushing your graduation target to ${extendedTerm} adds one more semester to fit remaining requirements.`,
                out,
                extended,
                `Even with graduation extended to ${extendedTerm}, no feasible plan could be constructed.`,
            ),
        );
    }

    // Cap at 3 candidates total.
    return candidates.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reconstruct the `ValidatorRules` shape from a `SolverInput`.
 *
 * Mirrors what `buildProgramRules` produces in `buildSolverInput.ts`:
 *   - `minorCreditMinimum` and `schoolCoreMinCredits` are always null there.
 *   - `upperLevelMinCredits` is always null (no DPR counter reliably captures it).
 *   - All other fields come straight from the SolverInput fields that
 *     `buildProgramRules` populated them from.
 *
 * Exported for use in tests.
 */
export function validatorRulesFromInput(input: SolverInput): ValidatorRules {
    return {
        degreeCreditMinimum: input.graduationCreditMinimum,
        residencyMinCredits: input.programRules.residencyMinCredits,
        majorCreditMinimum: input.programRules.majorCreditMinimum,
        minorCreditMinimum: null,
        upperLevelMinCredits: null,
        schoolCoreMinCredits: null,
        graduationTargetTerm: input.graduationTerm,
    };
}

/**
 * Construct a single `AlternativeCandidate` from a solver run.
 *
 * When the solver reports coarse-feasible, we run `finalizeForwardSchedule`
 * which assembles the `ForwardSchedule` AND runs `runGraduationPathValidator`
 * to derive the AUTHORITATIVE `state`. We then gate on the VALIDATOR's
 * `feasible` verdict — a coarse-feasible-but-validator-infeasible alternative
 * becomes a `stillInfeasibleReason` entry, not a falsely-valid schedule (T8/M3).
 *
 * When `out.feasibility.feasible` is false (solver already knows it's
 * infeasible), we skip finalization and emit the reason directly.
 * `stillInfeasibleReason` carries the REAL binding constraints:
 * post-P2.9, `out.feasibility.constraintViolations` holds the SPECIFIC
 * per-requirement blockers (offering / ceiling / coreq / NOT / prereq-depth)
 * plus the capacity diagnostic, so we join those concrete details rather than
 * the bare "N constraint violation(s)" count (`infeasibilityReason`). The
 * provided `fallbackReason` is used only when the solver reported no detail at
 * all (should not happen for an infeasible plan).
 */
function buildCandidate(
    relaxation: AlternativeCandidate["relaxation"],
    summary: string,
    out: SolverOutput,
    input: SolverInput,
    fallbackReason: string,
): AlternativeCandidate {
    if (out.feasibility.feasible) {
        // Route through the validator to get the AUTHORITATIVE state (T8/M3).
        const { schedule, validatorResult } = finalizeForwardSchedule(
            out,
            input,
            input.dpr,
            validatorRulesFromInput(input),
        );
        if (validatorResult.feasible) {
            return { summary, relaxation, schedule };
        }
        // Coarse-feasible but validator-infeasible — surface as a stillInfeasibleReason.
        const reason =
            validatorResult.infeasibilityReport?.conflictDetail ?? fallbackReason;
        return { summary, relaxation, schedule: null, stillInfeasibleReason: reason };
    }
    // Solver already knows it's infeasible — compose from concrete constraint violations.
    const details = out.feasibility.constraintViolations.map(v => v.detail).filter(d => d.length > 0);
    const stillInfeasibleReason =
        details.length > 0
            ? details.join(" ")
            : (out.feasibility.infeasibilityReason ?? fallbackReason);
    return {
        summary,
        relaxation,
        schedule: null,
        stillInfeasibleReason,
    };
}
