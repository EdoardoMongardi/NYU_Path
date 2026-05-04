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
 */

import type { ToolSession } from "../tool.js";
import type { ForwardSchedule } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import { walkRequirements, notSatisfiedRequirements } from "../../dpr/schema.js";
import { meetsGradeThreshold } from "../../dpr/gradeComparison.js";
import { solveForwardSchedule } from "./solver.js";
import {
    runGraduationPathValidator,
    derivePlanStateFromValidator,
} from "./graduationPathValidator.js";
import type { GraduationPathValidatorArgs } from "./graduationPathValidator.js";
import { hashDprCourseHistory } from "./reconcile.js";
import type { SolverInput } from "./types.js";

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
 */
export function buildForwardSchedule(args: BuildForwardScheduleArgs): ForwardSchedule {
    const { session, dpr, graduationTermOverride } = args;

    const student = session.student;
    const schoolConfig = session.schoolConfig ?? null;

    // ---- 1. Derive credit parameters from DPR + school config ----

    const creditsEarned = dpr.cumulative.creditsUsed ?? 0;
    const graduationCreditMinimum = dpr.cumulative.creditsRequired ?? schoolConfig?.totalCreditsRequired ?? 128;
    const creditCeiling = schoolConfig?.maxCreditsPerSemester ?? 18;
    const creditTargetPerSemester = 16;
    const cumulativeGpa = dpr.cumulative.cumulativeGpa ?? 0;
    const f1Floor =
        student?.visaStatus === "f1"
            ? (schoolConfig?.f1FullTimeMinCredits ?? 12)
            : null;
    const domesticPartTimeFloor = 8;

    // Credit caps from DPR header
    const passFailCap = dpr.cumulative.passFailCapUnits ?? 32;
    const passFailUsed = dpr.cumulative.passFailUsedUnits ?? 0;
    const outsideHomeCreditCap = dpr.cumulative.outsideHomeCapUnits ?? null;
    const outsideHomeCreditsUsed = dpr.cumulative.outsideHomeUsedUnits ?? 0;

    // ---- 2. Derive student identifiers ----

    const studentId = student?.id ?? "unknown";
    const homeSchoolId = student?.homeSchool ?? schoolConfig?.schoolId ?? "cas";
    const visaStatus = student?.visaStatus;

    // ---- 3. Build courses-taken and courses-in-progress sets from DPR ----

    const coursesTaken = new Set<string>();
    const coursesInProgress = new Set<string>();
    for (const row of dpr.courseHistory) {
        const key = `${row.subject} ${row.catalogNbr}`;
        if (row.type === "IP") {
            coursesInProgress.add(key);
            continue;
        }
        // Use the canonical grade comparator so non-standard NYU codes
        // (I, NR, WF, AU, etc.) fail closed — same semantics reconcile.ts
        // uses for "completed" detection. Raw inequality on a hand-listed
        // negative-grade set would silently accept these codes.
        if (row.grade && meetsGradeThreshold(row.grade, "D")) {
            coursesTaken.add(key);
        }
    }

    // ---- 4. Determine graduation term ----

    // Priority: explicit override > solver default (2 semesters out)
    const currentTerm = inferCurrentTerm(dpr);
    const graduationTerm = graduationTermOverride ?? deriveGraduationTerm(currentTerm, creditsEarned, graduationCreditMinimum, creditTargetPerSemester);

    // ---- 5. Build unmet requirements from DPR ----

    const unmetReqs = notSatisfiedRequirements(dpr.requirementGroups);
    const unmetRequirements: SolverInput["unmetRequirements"] = unmetReqs.map(req => ({
        rId: req.rId,
        title: req.title,
        category: inferCategory(req.rId, req.title),
        credits: inferRequirementCredits(req),
        candidateCourses: extractCandidateCourseIds(req),
    }));

    // ---- 6. Build prereq map from session.prereqs ----

    const prereqs = new Map<string, import("@nyupath/shared").PrereqGroup[]>();
    if (session.prereqs) {
        for (const p of session.prereqs) {
            prereqs.set(p.course, p.prereqGroups);
        }
    }

    // ---- 7. Build course catalog from session.courses ----

    const courseCatalog = new Map<string, { title: string; credits: number }>();
    if (session.courses) {
        for (const c of session.courses) {
            courseCatalog.set(c.id, { title: c.title, credits: c.credits });
        }
    }

    // ---- 8. Build program rules from session.programs + school config ----

    const programRules = buildProgramRules(session, dpr, graduationTerm, graduationCreditMinimum);

    // ---- 9. DPR hash ----

    const dprCourseHistoryHash = hashDprCourseHistory(dpr);

    // ---- 10. Build SolverInput ----

    const solverInput: SolverInput = {
        studentId,
        homeSchoolId,
        visaStatus,
        coursesTaken,
        coursesInProgress,
        currentTerm,
        graduationTerm,
        creditTargetPerSemester,
        f1Floor,
        domesticPartTimeFloor,
        creditCeiling,
        graduationCreditMinimum,
        creditsEarned,
        passFailCap,
        passFailUsed,
        onlineCreditCap: null,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap,
        outsideHomeCreditsUsed,
        cumulativeGpa,
        majorGpa: null,
        graduationGpaFloor: schoolConfig?.overallGpaMin ?? 2.0,
        majorGpaFloor: null,
        unmetRequirements,
        prereqs,
        offerings: new Map(),
        offeringConfidence: new Map(),
        courseCatalog,
        dprCourseHistoryHash,
        dpr,
        programRules: programRules.solverRules,
    };

    // ---- 11. Call the solver ----

    const solverOutput = solveForwardSchedule(solverInput);

    // ---- 12. Build initial ForwardSchedule from solver output ----

    const plannedCredits = solverOutput.semesters.reduce((sum, sem) => sum + sem.plannedCredits, 0);
    const degreeCreditsMet = (creditsEarned + plannedCredits) >= graduationCreditMinimum;

    const initialSchedule: ForwardSchedule = {
        studentId,
        homeSchoolId,
        graduationTerm,
        creditTargetPerSemester,
        f1Floor,
        domesticPartTimeFloor,
        graduationCreditMinimum,
        degreeCreditsMet,
        semesters: solverOutput.semesters,
        dprCourseHistoryHash,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Infer the current term from DPR IP rows, or fall back to a default. */
function inferCurrentTerm(dpr: DegreeProgressReport): string {
    // Look for the latest IP row term and use it as current
    const ipRows = dpr.courseHistory.filter(r => r.type === "IP");
    if (ipRows.length > 0) {
        // Convert PeopleSoft term format ("2026 Fall") to solver format ("2026-fall")
        const latestTerm = ipRows[ipRows.length - 1]!.term;
        const converted = psTermToSolverTerm(latestTerm);
        if (converted) return converted;
    }
    // Fall back to the next semester from "now" (2026-fall as a reasonable default)
    return "2026-fall";
}

/** Convert PeopleSoft term ("2026 Fall") to solver format ("2026-fall"). */
function psTermToSolverTerm(psTerm: string): string | null {
    const m = psTerm.match(/^(\d{4})\s+(Fall|Spring|Summer|J Term|Spr|Sum)$/i);
    if (!m) return null;
    const year = m[1]!;
    const seasonRaw = m[2]!.toLowerCase();
    const season =
        seasonRaw.startsWith("fa") ? "fall" :
        seasonRaw.startsWith("sp") ? "spring" :
        seasonRaw.startsWith("su") ? "summer" :
        seasonRaw.startsWith("j") ? "january" : null;
    if (!season) return null;
    return `${year}-${season}`;
}

/** Derive graduation term from current term + credits needed. */
function deriveGraduationTerm(
    currentTerm: string,
    creditsEarned: number,
    graduationCreditMinimum: number,
    creditTargetPerSemester: number,
): string {
    const creditsNeeded = Math.max(0, graduationCreditMinimum - creditsEarned);
    const semestersNeeded = Math.ceil(creditsNeeded / creditTargetPerSemester);

    const m = currentTerm.match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return "2028-spring";

    let year = parseInt(m[1]!, 10);
    let season = m[2]!;

    // Advance N semesters (spring/fall only, skipping summer/january)
    for (let i = 0; i < Math.max(1, semestersNeeded); i++) {
        if (season === "spring") {
            season = "fall";
        } else if (season === "fall") {
            year += 1;
            season = "spring";
        } else if (season === "summer") {
            season = "fall";
        } else {
            season = "spring";
        }
    }
    return `${year}-${season}`;
}

const COURSE_ID_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{1,4}[A-Z]?)\b/g;

function extractCandidateCourseIds(req: { description?: string; statusText: string; title: string }): string[] {
    const sources = [req.description ?? "", req.statusText, req.title].join(" ");
    const out = new Set<string>();
    for (const m of sources.matchAll(COURSE_ID_RE)) {
        out.add(`${m[1]} ${m[2]}`);
    }
    return Array.from(out);
}

function inferCategory(rId: string, title: string): string {
    const blob = `${rId} ${title}`.toLowerCase();
    if (blob.includes("major")) return "cs_major_required";
    if (blob.includes("core")) return "cas_core";
    if (blob.includes("elective")) return "free_elective";
    return "general";
}

function inferRequirementCredits(req: { counter?: import("../../dpr/schema.js").DPRCounter }): number {
    if (!req.counter) return 4;
    if (req.counter.kind === "units") {
        const needed = "needed" in req.counter ? (req.counter.needed ?? 0) : Math.max(0, req.counter.required - req.counter.used);
        return needed > 0 ? needed : 4;
    }
    return 4;
}

// ---------------------------------------------------------------------------
// Program rules builder — bridges session/DPR to validator's programRules shape
// ---------------------------------------------------------------------------

interface ProgramRulesBundle {
    validatorRules: GraduationPathValidatorArgs["programRules"];
    solverRules: SolverInput["programRules"];
}

function buildProgramRules(
    session: ToolSession,
    dpr: DegreeProgressReport,
    graduationTerm: string,
    degreeCreditMinimum: number,
): ProgramRulesBundle {
    const schoolConfig = session.schoolConfig ?? null;

    // Walk DPR requirement leaves to synthesize major/school-core rId sets
    const leaves = walkRequirements(dpr.requirementGroups);
    const majorRuleKinds = new Map<string, "must_take" | "choose_n">();
    const schoolCoreRuleIds = new Set<string>();
    const generalCategoryRuleIds = new Set<string>();

    for (const leaf of leaves) {
        const blob = `${leaf.rId} ${leaf.title}`.toLowerCase();
        if (blob.includes("major") || blob.includes("concentration")) {
            majorRuleKinds.set(leaf.rId, blob.includes("required") ? "must_take" : "choose_n");
        } else if (blob.includes("core") || blob.includes("cas core")) {
            schoolCoreRuleIds.add(leaf.rId);
        } else {
            generalCategoryRuleIds.add(leaf.rId);
        }
    }

    // Residency from DPR cumulative or school config
    const residencyMin = dpr.cumulative.residencyRequired ?? schoolConfig?.residency?.minCredits ?? null;

    const validatorRules: GraduationPathValidatorArgs["programRules"] = {
        degreeCreditMinimum,
        residencyMinCredits: typeof residencyMin === "number" ? residencyMin : null,
        majorCreditMinimum: null,       // not derivable from DPR alone without program rules
        minorCreditMinimum: null,
        upperLevelMinCredits: null,
        schoolCoreMinCredits: null,
        graduationTargetTerm: graduationTerm,
    };

    const solverRules: SolverInput["programRules"] = {
        majorRuleKinds,
        schoolCoreRuleIds,
        generalCategoryRuleIds,
        residencyMinCredits: typeof residencyMin === "number" ? residencyMin : null,
        majorCreditMinimum: null,
        upperLevelMinCredits: null,
    };

    return { validatorRules, solverRules };
}
