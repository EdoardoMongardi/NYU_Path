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
import { solveForwardSchedule } from "./solver.js";
import {
    runGraduationPathValidator,
    derivePlanStateFromValidator,
} from "./graduationPathValidator.js";
import { buildSolverInput, buildProgramRules } from "./buildSolverInput.js";
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
export function buildForwardSchedule(args: BuildForwardScheduleArgs): ForwardSchedule {
    const { session, dpr, graduationTermOverride } = args;

    // ---- Build SolverInput via the unified builder ----
    //
    // Graduation term resolution (inside buildSolverInput):
    //   1. graduationTermOverride (explicit, e.g. "what-if" probe)
    //   2. session.graduationTarget (onboarding-stated, display → solver shape)
    //   3. credit-derived default (deriveGraduationTerm)
    const solverInput = buildSolverInput(session, dpr, { graduationTermOverride });

    // Re-derive the program-rules bundle for the VALIDATOR path (which needs
    // validatorRules, a superset of what goes into solverInput.programRules).
    // The buildSolverInput call above already set solverInput.programRules
    // (solverRules). We call buildProgramRules again to get validatorRules.
    // This is a cheap second pass (pure computation, no I/O).
    const programRules = buildProgramRules(session, dpr, solverInput.graduationTerm, solverInput.graduationCreditMinimum);

    // ---- Call the solver ----

    const solverOutput = solveForwardSchedule(solverInput);

    // ---- Build initial ForwardSchedule from solver output ----

    const plannedCredits = solverOutput.semesters.reduce((sum, sem) => sum + sem.plannedCredits, 0);
    const degreeCreditsMet = (solverInput.creditsEarned + plannedCredits) >= solverInput.graduationCreditMinimum;

    const initialSchedule: ForwardSchedule = {
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
        ...(solverOutput.alternativeCandidates ? { alternativeCandidates: solverOutput.alternativeCandidates } : {}),
    };

    // ---- 13. Run full runGraduationPathValidator to get authoritative state ----

    const validatorResult = runGraduationPathValidator({
        plan: initialSchedule,
        dpr,
        programRules: programRules.validatorRules,
    });
    const finalState = derivePlanStateFromValidator(validatorResult, initialSchedule);

    return { ...initialSchedule, state: finalState };
}

// All helpers (inferCurrentTerm, psTermToSolverTerm, deriveGraduationTerm,
// extractCandidateCourseIds, inferRequirementCredits, buildProgramRules,
// buildProgramRulesForTest) have moved to buildSolverInput.ts.
// buildProgramRulesForTest is re-exported above for backward compatibility.
