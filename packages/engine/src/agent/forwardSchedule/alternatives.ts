/**
 * Phase 14 Task 4 — Alternatives generator (failure-mode fallback).
 *
 * Decision #12 — When the primary solve returns `feasible: false`, run
 * the solver multiple times with progressively-relaxed inputs and return
 * up to 3 `AlternativeCandidate` objects for the agent to surface.
 *
 * Strategies (in order):
 *   1. include_summer — add summer term to the planning window.
 *   2. include_jterm  — add J-term (January intersession) to the window.
 *   3. extend_grad_one_term — push graduationTerm forward by one main term.
 *
 * Phase 13 solver note: `enumerateMainTerms` in solver.ts only enumerates
 * fall/spring terms and does NOT yet read `preferences.includeSummer` or
 * `preferences.includeJTerm`. Those flags are Phase 14 Task 5 wiring.
 * Until then, strategies 1 and 2 will call the solver and, if the solver
 * still returns infeasible, emit a candidate with `schedule: null` and
 * `stillInfeasibleReason` set. Strategy 3 (extend_grad_one_term) DOES
 * cause the solver to enumerate an additional main term and can produce a
 * non-null schedule.
 */

import { solveForwardSchedule } from "./solver.js";
import type { SolverInput, SolverOutput } from "./types.js";
import type { AlternativeCandidate, ForwardSchedule } from "@nyupath/shared";

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
    const extendedTerm = computeNextMainTerm(input.graduationTerm);
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
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Advance a graduation term by one main term:
 *   - YYYY-spring → YYYY-fall (same year)
 *   - YYYY-fall   → (YYYY+1)-spring
 *
 * Returns null when the input term doesn't match the expected pattern
 * (e.g. "2026-summer" or an unparseable string).
 */
function computeNextMainTerm(term: string): string | null {
    const m = term.match(/^(\d{4})-(spring|fall)$/);
    if (!m) return null;
    const year = parseInt(m[1]!, 10);
    if (m[2] === "spring") return `${year}-fall`;
    return `${year + 1}-spring`;
}

/**
 * Build a `ForwardSchedule` from a feasible `SolverOutput` + the input
 * that produced it. Mirrors the construction in `build.ts` without
 * invoking the full graduation-path-validator pass (Decision #32 routing
 * is `planForwardDegreeTool`'s responsibility; here we trust the solver's
 * coarse state derivation, which is sufficient for alternative-candidate
 * display).
 */
function buildScheduleFromOutput(
    out: SolverOutput,
    input: SolverInput,
): ForwardSchedule {
    const plannedCredits = out.semesters.reduce((sum, s) => sum + s.plannedCredits, 0);
    const degreeCreditsMet =
        input.creditsEarned + plannedCredits >= input.graduationCreditMinimum;

    return {
        studentId: input.studentId,
        homeSchoolId: input.homeSchoolId,
        graduationTerm: input.graduationTerm,
        creditTargetPerSemester: input.creditTargetPerSemester,
        f1Floor: input.f1Floor,
        domesticPartTimeFloor: input.domesticPartTimeFloor,
        graduationCreditMinimum: input.graduationCreditMinimum,
        degreeCreditsMet,
        semesters: out.semesters,
        dprCourseHistoryHash: input.dprCourseHistoryHash,
        computedAt: Date.now(),
        feasibility: out.feasibility,
        state: out.state,
        balanceScore: out.balanceScore,
        assumptions: out.assumptions,
        ...(out.alternativeCandidates !== undefined
            ? { alternativeCandidates: out.alternativeCandidates }
            : {}),
    };
}

/**
 * Construct a single `AlternativeCandidate` from a solver run.
 *
 * When `out.feasibility.feasible` is true, the `schedule` field is
 * populated via `buildScheduleFromOutput`. When infeasible, `schedule`
 * is null and `stillInfeasibleReason` is set to the solver's reported
 * reason (falling back to the provided `fallbackReason`).
 */
function buildCandidate(
    relaxation: AlternativeCandidate["relaxation"],
    summary: string,
    out: SolverOutput,
    input: SolverInput,
    fallbackReason: string,
): AlternativeCandidate {
    if (out.feasibility.feasible) {
        return {
            summary,
            relaxation,
            schedule: buildScheduleFromOutput(out, input),
        };
    }
    return {
        summary,
        relaxation,
        schedule: null,
        stillInfeasibleReason:
            out.feasibility.infeasibilityReason ?? fallbackReason,
    };
}
