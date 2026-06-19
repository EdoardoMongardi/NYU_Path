// ============================================================
// whatIfAssumption — shared transform→solve→diff machinery (G3.1)
// ============================================================
// The single home for the what-if ASSUMPTION pipeline shared by:
//   - `probe_counterfactual` (read-only introspection — Arms C/D, G2.1), and
//   - `propose_whatif_assumption` (the propose half of a propose→confirm
//     round-trip — G3.1) + the web orchestrator's confirm path.
//
// "What-if assumption" = the student CLAIMS a current-term IP-course outcome
// ("I withdrew / I'll take pass-fail for course X"). We treat it as an
// ASSUMPTION: build a SYNTHETIC DPR in-memory via the matching pure transform
// (applyWithdrawalToDpr / applyPassFailToDpr — the original DPR is NEVER
// mutated; the clone carries reportKind:"what_if"), re-solve through the SAME
// frozen pipeline the build path uses (buildSolverInputWithRulesFromSession →
// solveForwardSchedule → finalizeForwardSchedule + the 8-axis validator), and
// compute the diff / rich planDiff / binding-constraint conflicts vs the
// CURRENT plan, plus the school-specific P/F hedges + the F3 registrar-window
// caveat + the universal verify/not-official rail (CORE RULE 15).
//
// The frozen contract (finalizeForwardSchedule + the 8-axis validator + the
// solver + the search) is unchanged — this module only CALLS it.
//
// PURITY / R1 GUARDRAIL: `solveAndDiff` + `solveWhatIfAssumption` NEVER write
// to session — they only read it and build local clones. The synthetic DPR is
// in-memory only and MUST never reach students.parsed_dpr (the snapshot-
// integrity guard refuses any non-"dpr" reportKind write). A confirm persists
// only the resulting forward_schedule, never the synthetic DPR.
// ============================================================

import type { ToolSession } from "../tool.js";
import { solveForwardSchedule } from "./solver.js";
import { finalizeForwardSchedule } from "./build.js";
import { runGraduationPathValidator } from "./graduationPathValidator.js";
import { applyWithdrawalToDpr } from "./withdrawTransform.js";
import { applyPassFailToDpr } from "./passFailTransform.js";
import { rowKey } from "./transformUtils.js";
import { canonicalizeCourseId } from "../../courseId.js";
import {
    buildSolverInputWithRulesFromSession,
    computeSlotDiff,
    buildPlanDiff,
} from "./planChangeHelpers.js";
import {
    classifyIpChangeability,
    deriveTemporalContext,
    campusForHomeSchool,
    NYU_ACADEMIC_CALENDAR,
} from "../../dpr/index.js";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import type {
    ForwardSchedule,
    PlanChangeOutcome,
    PlanDiff,
    SchedulePreferences,
} from "@nyupath/shared";

/** The universal rail every IP-course what-if (withdraw / pass / fail) carries:
 *  a claimed current-term change is an UNVERIFIED assumption (CORE RULE 15 /
 *  core_philosophy.md) — nothing is official until the next DPR. */
export const VERIFY_RAIL =
    "This is an unverified assumption — verify with your adviser; nothing is " +
    "official until your next DPR.";

/** The three current-term IP-course outcomes a student can assume. "withdraw"
 *  → a "W" (GPA-neutral; the requirement always re-opens). "pass"/"fail" →
 *  P/F election (school-specific; a fail re-opens + lowers GPA). */
export type WhatIfOutcome = "withdraw" | "pass" | "fail";

// ---------------------------------------------------------------------------
// Shared transform→solve→diff core (reused by every what-if arm)
// ---------------------------------------------------------------------------

/** The `PlanChangeOutcome`-shaped core plus the probe's schedule/state/planDiff
 *  every what-if arm assembles after re-solving its `(dpr, prefs)`
 *  counterfactual. The arm-specific fields (`hedges`, `windowCaveat`) are
 *  merged by the caller. */
export interface SolveAndDiffResult {
    feasible: boolean;
    diff: PlanChangeOutcome["diff"];
    consequences: string[];
    conflicts?: Array<{ kind: string; detail: string }>;
    schedule: ForwardSchedule;
    state: ForwardSchedule["state"];
    planDiff?: PlanDiff;
}

/**
 * Re-solve a counterfactual `(solveDpr, solvePrefs)` through the SAME frozen
 * pipeline the build path uses, then compute the diff / rich planDiff /
 * binding-constraint conflicts vs the CURRENT plan. PURE re-solve — NOTHING
 * here writes to session. Shared by `probe_counterfactual` and
 * `propose_whatif_assumption` so the solve/diff logic lives in exactly ONE
 * place.
 *
 * @param originalDpr The student's REAL DPR (the "before" world the planDiff
 *                    is measured against — always the original, never the
 *                    synthetic clone).
 * @param solveDpr    The DPR to solve against (the synthetic clone for the
 *                    withdraw/pass/fail arms; === originalDpr for future_course).
 */
export function solveAndDiff(
    session: ToolSession,
    currentPlan: ForwardSchedule,
    originalDpr: DegreeProgressReport,
    solveDpr: DegreeProgressReport,
    solvePrefs: SchedulePreferences,
    noOpConsequences: string[],
): SolveAndDiffResult {
    // Identical seam to proposePlanChange: one buildProgramRules call yields
    // BOTH the solverInput and the validatorRules; solve; then route through
    // the SAME authoritative 8-axis finalize the build path uses. NONE of
    // this writes to session.
    const { solverInput, validatorRules } = buildSolverInputWithRulesFromSession(
        session,
        solveDpr,
        solvePrefs,
    );
    const solverOutput = solveForwardSchedule(solverInput);
    // Plan 37 (Task C2 fix-loop) — thread the session-resolved per-school P/F
    // config so the 8th validator axis (passFailLimitsRespected) enforces the
    // career cap. This is THE flow where the cap can change: a P/F PASS election
    // (applyPassFailToDpr, B1) increments `solveDpr.cumulative.passFailUsedUnits`,
    // and the axis reads that. Without the config the axis ran pass-by-default,
    // so an over-cap election went unflagged (feasible:true).
    const passFailConfig = session.schoolConfig?.passFail;
    const { schedule: probedSchedule, validatorResult } = finalizeForwardSchedule(
        solverOutput,
        solverInput,
        solveDpr,
        validatorRules,
        passFailConfig,
    );

    // Validate the BEFORE plan too (cheap, pure) so the planDiff can report
    // per-axis transitions. The before plan is validated against the
    // ORIGINAL dpr — that is the world the student is in today (so its
    // `passFailUsedUnits` carries NO election; the before/after diff is honest:
    // an already-over-cap student shows fail on BOTH worlds — no spurious NEW
    // transition — while an election that newly crosses the cap shows pass→fail).
    const beforeAxes = runGraduationPathValidator({
        plan: currentPlan,
        dpr: originalDpr,
        programRules: validatorRules,
        // SAME P/F config as the after world (the career cap is plan-independent;
        // only the DPR's used-units differ between before/after).
        passFailConfig,
    }).axisResults;

    // -- Diff + rich planDiff vs the CURRENT plan --------------------------
    const diff = computeSlotDiff(currentPlan, probedSchedule);
    const planDiff = buildPlanDiff(currentPlan, probedSchedule, {
        before: beforeAxes,
        after: validatorResult.axisResults,
    });

    // -- Conflicts from the VALIDATOR (not the solver's coarse boolean) ----
    //
    // When the validator deems the counterfactual infeasible, surface the
    // BINDING constraint: the failing-axis + reason string from the
    // infeasibilityReport. HONEST SCOPE: conflictSource is always "other" and
    // conflictDetail is `Axes failed: <axis>: <reason>` — axis-level, NOT
    // course-causal.
    const conflicts: Array<{ kind: string; detail: string }> = [];
    if (!validatorResult.feasible && validatorResult.infeasibilityReport) {
        conflicts.push({
            kind: validatorResult.infeasibilityReport.conflictSource,
            detail: validatorResult.infeasibilityReport.conflictDetail,
        });
    }

    // -- Consequences (plain-English) --------------------------------------
    const consequences: string[] = [...noOpConsequences];
    if (validatorResult.feasible) {
        consequences.push("Counterfactual re-solves to a VALID plan.");
    } else {
        consequences.push("Counterfactual is INFEASIBLE — see the binding constraint(s).");
    }
    if (diff.added.length > 0) {
        consequences.push(
            "Added: " +
                diff.added
                    .map(({ term, slot }) =>
                        `${"courseId" in slot ? slot.courseId : "placeholder"} → ${term}`,
                    )
                    .join(", "),
        );
    }
    if (diff.removed.length > 0) {
        consequences.push(
            "Removed: " +
                diff.removed
                    .map(({ term, slot }) =>
                        `${"courseId" in slot ? slot.courseId : "placeholder"} (was in ${term})`,
                    )
                    .join(", "),
        );
    }

    return {
        feasible: validatorResult.feasible,
        diff,
        consequences,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
        schedule: probedSchedule,
        state: probedSchedule.state,
        planDiff,
    };
}

/**
 * Resolve the F3 registrar-window caveat for a current-term IP-course what-if.
 * Finds the target course's term from the DPR's courseHistory, derives the
 * temporal context + campus, and asks `classifyIpChangeability` whether the
 * student is even inside the add/drop or withdraw/PF window NOW.
 *
 * READ-ONLY + window-INDEPENDENT consequence: this is surfaced as a CAVEAT
 * only — the requirement consequence (a "W" never satisfies the requirement)
 * is computed regardless of the window. Returns the classifier's hedge when
 * one applies (closed / withdraw_pf / unknown), else a benign in-window note;
 * when the course's term can't be found, returns `undefined`.
 */
export function ipWindowCaveat(
    dpr: DegreeProgressReport,
    courseId: string,
    homeSchool: string | undefined,
    now?: Date,
): string | undefined {
    // Find the course's term from courseHistory under the SAME keying the
    // transforms use: canonicalizeCourseId(courseId) equals rowKey(row).
    const targetId = canonicalizeCourseId(courseId);
    const row = dpr.courseHistory.find((r) => rowKey(r) === targetId);
    if (!row) return undefined;

    const temporalContext = deriveTemporalContext(dpr, now ? { now } : {});
    const campus = campusForHomeSchool(homeSchool);
    const result = classifyIpChangeability({
        ipTerm: row.term,
        temporalContext,
        campus,
        calendar: NYU_ACADEMIC_CALENDAR,
        ...(now ? { now } : {}),
    });
    // Prefer the classifier's hedge (closed / withdraw_pf / unknown). For a
    // freely-changeable window (future / add_drop) there is no hedge — surface
    // a short benign note so the caller always has a window caveat string.
    if (result.hedge) return result.hedge;
    return result.window === "future"
        ? "This is a pre-registered future term — freely changeable; no real-world registration to undo yet."
        : "You appear to be within the add/drop window for this term, so this course can still be dropped/changed; confirm the exact deadline with your registrar.";
}

// ---------------------------------------------------------------------------
// High-level what-if assumption solve (G3.1) — propose + confirm both call this
// ---------------------------------------------------------------------------

/** Everything a what-if assumption produces: the `SolveAndDiffResult` core
 *  plus the school-specific hedges + the F3 window caveat. Both the propose
 *  tool (read-only) and the confirm path (which then persists `schedule`)
 *  build on this. */
export interface WhatIfAssumptionResult extends SolveAndDiffResult {
    /** The assumed course (echoed back; canonicalisation happens in the
     *  transforms). */
    courseId: string;
    /** The assumed outcome. */
    outcome: WhatIfOutcome;
    /** School-specific P/F hedges (pass/fail only) + the universal verify rail
     *  (always). Empty only in the impossible no-op case. */
    hedges: string[];
    /** The F3 registrar-window actionability caveat. Absent when the course's
     *  term can't be located in courseHistory. */
    windowCaveat?: string;
}

/**
 * The single shared entry point for a what-if ASSUMPTION re-plan. Builds the
 * synthetic DPR for the claimed `{ courseId, outcome }`, re-solves READ-ONLY
 * through the frozen pipeline, and returns the proposed schedule + diff +
 * hedges + the F3 window caveat + the verify rail.
 *
 * READ-ONLY: never writes to session. The original `session.degreeProgressReport`
 * is never mutated (the transforms deep-copy). A CONFIRM caller takes the
 * returned `schedule` and persists ONLY that forward_schedule — never the
 * synthetic DPR (the R1 guardrail).
 *
 * @param session    The tool session (provides the real DPR, prefs, school).
 * @param currentPlan The current committed/draft plan the diff is measured against.
 * @param input.courseId The current-term IP course the claim is about.
 * @param input.outcome  "withdraw" | "pass" | "fail".
 * @param input.now      Override "today" for the registrar-window check (tests).
 */
export function solveWhatIfAssumption(
    session: ToolSession,
    currentPlan: ForwardSchedule,
    input: { courseId: string; outcome: WhatIfOutcome; now?: Date },
): WhatIfAssumptionResult {
    const dpr = session.degreeProgressReport!;
    const { courseId, outcome, now } = input;

    // pfEligibility keys off the canonical school id; prefer the loaded
    // schoolConfig, fall back to the student's home school.
    const homeSchool = session.student?.homeSchool;
    const schoolId = session.schoolConfig?.schoolId ?? homeSchool ?? "";

    // ---- Build the synthetic DPR via the matching pure transform. ----
    let solveDpr: DegreeProgressReport;
    const hedges: string[] = [];
    if (outcome === "withdraw") {
        solveDpr = applyWithdrawalToDpr(dpr, courseId);
    } else {
        const { dpr: pfDpr, hedges: pfHedges } = applyPassFailToDpr(
            dpr,
            courseId,
            outcome,
            schoolId,
        );
        solveDpr = pfDpr;
        hedges.push(...pfHedges);
    }

    // ---- F3 window caveat (read-only; never gates the consequence). ----
    const windowCaveat = ipWindowCaveat(dpr, courseId, homeSchool, now);

    // ---- The universal rail: a claimed current-term change is UNVERIFIED. ----
    hedges.push(VERIFY_RAIL);

    // ---- Re-solve (read-only) through the SAME shared seam. ----
    const core = solveAndDiff(
        session,
        currentPlan,
        dpr,
        solveDpr,
        session.schedulePreferences ?? {},
        [],
    );

    // The verify rail also belongs in `consequences` so a consumer reading
    // only `consequences` still sees it.
    const consequences = [...core.consequences, VERIFY_RAIL];

    return {
        ...core,
        consequences,
        courseId,
        outcome,
        hedges,
        ...(windowCaveat ? { windowCaveat } : {}),
    };
}

/** A short, human-readable label for the assumption ("assumes you withdraw
 *  CSCI-UA 102" / "assumes you take CSCI-UA 102 pass-fail (pass)"). Used by the
 *  web review card + canvas badge (G3.2). */
export function whatIfAssumptionLabel(courseId: string, outcome: WhatIfOutcome): string {
    if (outcome === "withdraw") {
        return `Assumes you withdraw from ${courseId} (a "W" — GPA-neutral; the requirement re-opens).`;
    }
    const verb = outcome === "pass" ? "PASS" : "FAIL";
    return `Assumes you take ${courseId} pass/fail and ${verb} (unverified until your next DPR).`;
}
