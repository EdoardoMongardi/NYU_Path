/**
 * Phase 13 Task 5 — Forward-schedule build orchestrator.
 *
 * Composes SolverInput from session + DPR + profile, calls
 * solveForwardSchedule, then post-processes via the full
 * runGraduationPathValidator to get the authoritative state.
 *
 * Decisions covered:
 *   #32 PlanState 4-state (overrides solver's coarse approximation)
 *   #25 balanceScore (trusted from solver)
 *   #30 IP assumptions (from solver)
 *
 * Task 1.10 — SolverInput construction delegated to the shared
 * buildSolverInput() in buildSolverInput.ts (RC-4/PLAN-2).
 */

import type { ToolSession } from "../tool.js";
import type { ForwardSchedule } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import type { SolverInput, SolverOutput } from "./types.js";
import { solveForwardSchedule } from "./solver.js";
import {
    runGraduationPathValidator,
    derivePlanStateFromValidator,
} from "./graduationPathValidator.js";
import type {
    GraduationPathValidatorArgs,
    GraduationPathValidatorResult,
} from "./graduationPathValidator.js";
import { buildSolverInputWithRules } from "./buildSolverInput.js";
import { nextMainTermOrNull } from "./solverHelpers.js";

/** The validator's program-rules shape (superset returned by
 *  `buildProgramRules(...).validatorRules`). Re-exported so the edit
 *  tools can type their `validatorRules` argument without reaching into
 *  the validator module directly. */
export type ValidatorRules = GraduationPathValidatorArgs["programRules"];

/**
 * Result of `finalizeForwardSchedule`: the fully-assembled schedule with
 * the AUTHORITATIVE validator-derived `state`, plus the raw validator
 * result (so callers can read `feasible`, per-axis `axisResults`, and the
 * `infeasibilityReport` binding constraint without re-running the validator).
 */
export interface FinalizedSchedule {
    schedule: ForwardSchedule;
    validatorResult: GraduationPathValidatorResult;
}

/**
 * Shared finalize step (P2.7/PLAN-3): one search → one validator for EVERY
 * path. Assembles the `ForwardSchedule` from `solverOutput` + `solverInput`
 * (the literal previously duplicated in build.ts / proposePlanChange /
 * confirmPlanChange), runs `runGraduationPathValidator`, and derives the
 * authoritative `state` from the validator (NOT the solver's coarse state).
 *
 * Behavior-preserving for the build path (it already validated); the value
 * is that the EDIT tools now share the same authoritative gate instead of
 * trusting `solverOutput.state` / `solverOutput.feasibility.feasible`.
 *
 * `computedAt` uses `Date.now()` to match the existing call sites — this
 * introduces no nondeterminism beyond what every prior assembly already had.
 */
export function finalizeForwardSchedule(
    solverOutput: SolverOutput,
    solverInput: SolverInput,
    dpr: DegreeProgressReport,
    validatorRules: ValidatorRules,
): FinalizedSchedule {
    const plannedCredits = solverOutput.semesters.reduce((sum, sem) => sum + sem.plannedCredits, 0);
    const degreeCreditsMet =
        (solverInput.creditsEarned + plannedCredits) >= solverInput.graduationCreditMinimum;

    const assembled: ForwardSchedule = {
        studentId: solverInput.studentId,
        homeSchoolId: solverInput.homeSchoolId,
        graduationTerm: solverInput.graduationTerm,
        creditTargetPerSemester: solverInput.creditTargetPerSemester,
        f1Floor: solverInput.f1Floor,
        domesticPartTimeFloor: solverInput.domesticPartTimeFloor,
        graduationCreditMinimum: solverInput.graduationCreditMinimum,
        degreeCreditsMet,
        semesters: solverOutput.semesters,
        dprCourseHistoryHash: solverInput.dprCourseHistoryHash,
        computedAt: Date.now(),
        feasibility: solverOutput.feasibility,
        state: solverOutput.state,           // solver's coarse state (overridden below)
        balanceScore: solverOutput.balanceScore,
        assumptions: solverOutput.assumptions,
        ...(solverOutput.alternativeCandidates !== undefined
            ? { alternativeCandidates: solverOutput.alternativeCandidates }
            : {}),
        // P2.10 (a) — surface the solver's build-time advisories on the
        // agent-facing schedule (e.g. assumed-128 when the DPR omits the
        // degree credit minimum). Omitted when there are none.
        ...(solverOutput.warnings ? { warnings: solverOutput.warnings } : {}),
        // T7 — thread the structured optimality signal onto the assembled schedule.
        // Omitted when undefined (back-compat: consumers treat absent as "optimal").
        ...(solverOutput.optimality !== undefined ? { optimality: solverOutput.optimality } : {}),
    };

    const validatorResult = runGraduationPathValidator({
        plan: assembled,
        dpr,
        programRules: validatorRules,
    });
    const state = derivePlanStateFromValidator(validatorResult, assembled);

    return { schedule: { ...assembled, state }, validatorResult };
}
// Re-export for test files that import buildProgramRulesForTest from build.js
// (backward-compat; the authoritative copy lives in buildSolverInput.ts)
export { buildProgramRulesForTest } from "./buildSolverInput.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildForwardScheduleArgs {
    session: ToolSession;
    /** The student's parsed DPR. */
    dpr: DegreeProgressReport;
    /** Override the default graduationTerm derived from session/profile. */
    graduationTermOverride?: string;
}

/**
 * Phase 13 Task 5 — Compose SolverInput from session + DPR + profile,
 * call the solver, post-process to populate Stage-8 final state.
 *
 * Task 1.10: SolverInput construction delegates to the shared
 * buildSolverInput() (RC-4/PLAN-2) which honors graduationTarget,
 * wall-clock dating, coreqs, offerings, and classifier thresholds.
 */
/**
 * Maximum number of extra main terms the relax loop may add to a DERIVED
 * graduation horizon. 2 is sufficient for any realistic prereq chain depth
 * (a 4-deep chain needs at most 2 extra semesters beyond the naive 1-term
 * credit floor). The loop always terminates: it stops as soon as the plan is
 * feasible, after MAX_HORIZON_RELAX_TERMS extensions, or when
 * nextMainTermOrNull returns null.
 */
const MAX_HORIZON_RELAX_TERMS = 2;

export function buildForwardSchedule(args: BuildForwardScheduleArgs): ForwardSchedule {
    const { session, dpr, graduationTermOverride } = args;

    // ---- Build SolverInput via the unified builder (P2.10 (b)) ----
    //
    // Graduation term resolution (inside buildSolverInputWithRules):
    //   1. graduationTermOverride (explicit, e.g. "what-if" probe)
    //   2. session.graduationTarget (onboarding-stated, display → solver shape)
    //   3. credit-derived default (deriveGraduationTerm)
    //
    // The rules-aware builder calls buildProgramRules ONCE and hands back
    // `validatorRules` directly — so the validator path no longer re-derives
    // it with a redundant second buildProgramRules call.
    let { solverInput, validatorRules } = buildSolverInputWithRules(session, dpr, { graduationTermOverride });

    // ---- T2b: add-a-term relax for a too-short DERIVED horizon ----
    //
    // WHY THIS LIVES IN build.ts, NOT inside solveForwardSchedule:
    // Extending the horizon changes `graduationTerm`, and the post-hoc
    // validator's `graduationTargetTerm` is baked into `validatorRules`
    // built by `buildSolverInputWithRules`. A relax inside the solver would
    // extend the internal window but `runGraduationPathValidator` (called in
    // `finalizeForwardSchedule` below) would still check the ORIGINAL target
    // and wrongly report the relaxed plan infeasible. The loop at this level
    // rebuilds both `solverInput` AND `validatorRules` together via a fresh
    // `buildSolverInputWithRules` call, keeping everything consistent.
    //
    // GUARD: only trigger when the graduation term was DERIVED (no student-
    // stated target, no explicit override). A hard target (graduationTarget or
    // graduationTermOverride) is NEVER silently extended — we surface the real
    // binding constraints (PLAN-13) instead.

    // Capture the derivation flag from the FIRST build. Subsequent re-builds
    // pass graduationTermOverride so their own flag is false, but the local
    // `wasDerived` variable governs the loop.
    const wasDerived = solverInput.graduationTermWasDerived === true;

    // ---- Call the solver ----
    let solverOutput = solveForwardSchedule(solverInput);

    // ---- Assemble + run the authoritative validator via the shared finalize ----
    //
    // The same single-search → single-validator step the edit tools now use
    // (P2.7/PLAN-3). For the build path this is a behavior-preserving
    // extraction: the assembled literal, the validator call, and the
    // derivePlanStateFromValidator override are byte-identical to the prior
    // inline block.
    let finalized = finalizeForwardSchedule(solverOutput, solverInput, dpr, validatorRules);

    // ---- Relax loop (T2b) ----
    //
    // The loop condition uses the VALIDATOR's feasibility verdict (validatorResult.feasible),
    // NOT the solver's feasibility flag (schedule.feasibility.feasible). The solver can
    // return feasibility.feasible=true even when requirements become unbound placeholders
    // (the credit-fill alone satisfies the solver's credit-minimum check). The validator
    // is the authoritative gate — it checks requirementGroupsSatisfied, which fails when
    // requirements are covered only by placeholders rather than specific_planned slots.
    //
    // FALLBACK: keep the ORIGINAL derived-horizon result. An extension is ADOPTED only when it
    // actually ACHIEVES validator-feasibility; otherwise we return the original (its honest
    // binding constraints + the credit-derived graduation term). Extending the horizon for an
    // infeasibility that more terms cannot fix (a GPA floor, an unbindable/no-candidate
    // requirement) would otherwise push the graduation term out needlessly on a plan that stays
    // infeasible — a misleading later grad term. So an unhelpful relax is never "stuck".
    const derivedFinalized = finalized;
    let ext = 0;
    while (!finalized.validatorResult.feasible && wasDerived && ext < MAX_HORIZON_RELAX_TERMS) {
        const extended = nextMainTermOrNull(solverInput.graduationTerm);
        if (extended === null) break;
        ext++;
        ({ solverInput, validatorRules } = buildSolverInputWithRules(session, dpr, { graduationTermOverride: extended }));
        solverOutput = solveForwardSchedule(solverInput);
        finalized = finalizeForwardSchedule(solverOutput, solverInput, dpr, validatorRules);
    }

    // Adopt the relaxed result only if it became feasible; else fall back to the original
    // derived-horizon schedule (no useless grad-term extension on a still-infeasible plan).
    return (finalized.validatorResult.feasible ? finalized : derivedFinalized).schedule;
}

// All helpers (inferCurrentTerm, psTermToSolverTerm, deriveGraduationTerm,
// extractCandidateCourseIds, inferRequirementCredits, buildProgramRules,
// buildProgramRulesForTest) have moved to buildSolverInput.ts.
// buildProgramRulesForTest is re-exported above for backward compatibility.
