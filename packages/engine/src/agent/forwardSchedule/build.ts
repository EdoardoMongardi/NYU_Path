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
import { deriveTemporalContext } from "../../dpr/temporalContext.js";
import { solveForwardSchedule } from "./solver.js";
import {
    runGraduationPathValidator,
    derivePlanStateFromValidator,
} from "./graduationPathValidator.js";
import type { GraduationPathValidatorArgs } from "./graduationPathValidator.js";
import { hashDprCourseHistory } from "./reconcile.js";
import type { SolverInput } from "./types.js";
import { loadOffCatalogCredits, loadOfferings } from "../../dataLoader.js";
import type { ConfidenceTier } from "@nyupath/shared";
import {
    DEFAULT_CREDIT_TARGET_PER_SEMESTER,
    DEFAULT_DOMESTIC_PARTTIME_FLOOR,
} from "../../data/schoolDefaults.js";
import { classifyRequirementKind } from "./requirementKind.js";
import type { ProgramDeclaration } from "@nyupath/shared";

// Module-cached off-catalog (grad/professional) credit map for pin
// resolution. Read once per process; a missing file degrades to empty so a
// data-file absence can't break planning (off-catalog pins then fall to the
// 0-credit "verify in Albert" path).
let OFF_CATALOG_CACHE: Map<string, { title: string; credits: number }> | null = null;
function getOffCatalogCredits(): Map<string, { title: string; credits: number }> {
    if (!OFF_CATALOG_CACHE) {
        try {
            OFF_CATALOG_CACHE = loadOffCatalogCredits();
        } catch {
            OFF_CATALOG_CACHE = new Map();
        }
    }
    return OFF_CATALOG_CACHE;
}

// Module-cached offerings map (Task 1.8 / PLAN-1). Read once per process;
// a missing file degrades to empty so the absence of courses-offerings.json
// can't break planning (terms-offered guard is silently skipped, same as
// before this fix).
type Season = "fall" | "spring" | "summer" | "january";
let OFFERINGS_CACHE: Map<string, { termsOffered: Season[]; confidence: ConfidenceTier }> | null = null;
function getOfferings(): Map<string, { termsOffered: Season[]; confidence: ConfidenceTier }> {
    if (!OFFERINGS_CACHE) {
        try {
            OFFERINGS_CACHE = loadOfferings();
        } catch {
            OFFERINGS_CACHE = new Map();
        }
    }
    return OFFERINGS_CACHE;
}

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
    const graduationCreditMinimum = dpr.cumulative.creditsRequired ?? 128;
    const creditCeiling = schoolConfig?.maxCreditsPerSemester ?? 18;
    const creditTargetPerSemester = schoolConfig?.creditTargetPerSemester ?? DEFAULT_CREDIT_TARGET_PER_SEMESTER;
    const cumulativeGpa = dpr.cumulative.cumulativeGpa ?? 0;
    const f1Floor =
        student?.visaStatus === "f1"
            ? (schoolConfig?.f1FullTimeMinCredits ?? 12)
            : null;
    const domesticPartTimeFloor = schoolConfig?.domesticPartTimeFloor ?? DEFAULT_DOMESTIC_PARTTIME_FLOOR;

    // Credit caps from DPR header
    const passFailCap = dpr.cumulative.passFailCapUnits ?? 32;
    const passFailUsed = dpr.cumulative.passFailUsedUnits ?? 0;
    const outsideHomeCreditCap = dpr.cumulative.outsideHomeCapUnits ?? null;
    const outsideHomeCreditsUsed = dpr.cumulative.outsideHomeUsedUnits ?? 0;

    // ---- 2. Derive student identifiers ----

    const studentId = student?.id ?? "unknown";
    const homeSchoolId = student?.homeSchool ?? schoolConfig?.schoolId ?? "unknown";
    const visaStatus = student?.visaStatus;

    // ---- 3. Build courses-taken and courses-in-progress sets from DPR ----
    //
    // Each IP row carries its own term on the DPR (e.g. a senior in
    // Spring 2026 may have 4 IP rows for "2026 Spr" + 3 IP rows for
    // "2026 Fall" they pre-registered for). The solver later places
    // each IP row in the term it was tagged with; flattening the term
    // info here is what produced the May 2026 post-mortem 28-credit
    // phantom term. When a row's term can't be parsed, fall back to
    // currentTerm so a stale-DPR row still surfaces somewhere.

    // currentTerm is computed first because the IP fallback path needs it.
    const currentTerm = inferCurrentTerm(dpr);

    const coursesTaken = new Set<string>();
    const coursesInProgress = new Map<string, { term: string }>();
    for (const row of dpr.courseHistory) {
        const key = `${row.subject} ${row.catalogNbr}`;
        if (row.type === "IP") {
            const rowTerm = psTermToSolverTerm(row.term) ?? currentTerm;
            coursesInProgress.set(key, { term: rowTerm });
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
    const graduationTerm = graduationTermOverride ?? deriveGraduationTerm(currentTerm, creditsEarned, graduationCreditMinimum, creditTargetPerSemester);

    // ---- 5. Build unmet requirements from DPR ----

    // RC-3: classify requirement kinds structurally from the DPR group hierarchy
    // rather than by substring-matching the leaf's rId/title.
    const kindByRId = classifyRequirementKind({
        groups: dpr.requirementGroups,
        declaredPrograms: student?.declaredPrograms ?? [],
    });

    const unmetReqs = notSatisfiedRequirements(dpr.requirementGroups);
    const unmetRequirements: SolverInput["unmetRequirements"] = unmetReqs.map(req => ({
        rId: req.rId,
        title: req.title,
        category: kindByRId.get(req.rId) ?? "unknown",
        credits: inferRequirementCredits(req),
        candidateCourses: extractCandidateCourseIds(req),
    }));

    // ---- 6. Build prereq map + coreq map from session.prereqs ----

    const prereqs = new Map<string, import("@nyupath/shared").PrereqGroup[]>();
    const coreqs = new Map<string, string[]>();
    if (session.prereqs) {
        for (const p of session.prereqs) {
            prereqs.set(p.course, p.prereqGroups);
            if (p.coreqs && p.coreqs.length > 0) {
                coreqs.set(p.course, p.coreqs);
            }
        }
    }

    // ---- 7. Build course catalog from session.courses ----

    const courseCatalog = new Map<string, { title: string; credits: number }>();
    if (session.courses) {
        for (const c of session.courses) {
            courseCatalog.set(c.id, { title: c.title, credits: c.credits });
        }
    }

    // ---- 8. Build program rules from DPR requirement groups + school config ----

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
        graduationGpaFloor: dpr.cumulative.cumulativeGpaRequired ?? 2.0,
        majorGpaFloor: null,
        unmetRequirements,
        prereqs,
        ...(() => {
            const offeringsData = getOfferings();
            const offerings = new Map<string, Season[]>();
            const offeringConfidence = new Map<string, ConfidenceTier>();
            for (const [id, v] of offeringsData) {
                offerings.set(id, v.termsOffered);
                offeringConfidence.set(id, v.confidence);
            }
            return { offerings, offeringConfidence };
        })(),
        courseCatalog,
        offCatalogCredits: getOffCatalogCredits(),
        dprCourseHistoryHash,
        dpr,
        programRules: programRules.solverRules,
        ...(coreqs.size > 0 ? { coreqs } : {}),
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

/** Infer the current term using the wall clock (NOT the latest IP row).
 *
 *  RC (May 2026 post-mortem): the prior implementation picked the LAST
 *  IP-tagged DPR row as "current term". With a student mid-Spring 2026
 *  who has Fall 2026 already pre-registered, that picked Fall 2026 — so
 *  the planner started building forward from Fall 2026 and stacked new
 *  unmet-requirement courses on top of the 3 IP rows already in that
 *  term, producing a 28-credit semester (well over the 18-credit cap).
 *
 *  The fix routes through `deriveTemporalContext` (which already does
 *  wall-clock-vs-DPR reconciliation correctly) and returns its
 *  `currentTerm` in the solver's "{year}-{season}" shape.
 *
 *  `now` is injectable for deterministic tests; defaults to wall clock.
 */
function inferCurrentTerm(dpr: DegreeProgressReport, now: Date = new Date()): string {
    const temporal = deriveTemporalContext(dpr, { now });
    // `temporal.currentTerm` is in human-readable "Season YYYY" or
    // "YYYY Season" shape (e.g. "Fall 2026"). The planner needs
    // "{year}-{season}" — convert via the existing helper.
    const solverShape = temporal.currentTerm
        ? psTermToSolverTerm(temporal.currentTerm)
        : null;
    if (solverShape) return solverShape;
    // Defensive fallback (should never hit; deriveTemporalContext is
    // pure + deterministic given a Date). Keeps the legacy default so
    // we never crash on a malformed temporal output.
    return "2026-fall";
}

/** Convert a human term label to the solver's "{year}-{season}" shape.
 *  Accepts EITHER "2026 Fall" (PeopleSoft / DPR) OR "Fall 2026"
 *  (deriveTemporalContext output) OR the already-canonical "2026-fall".
 *  Returns null when the input isn't a recognizable term label.
 */
function psTermToSolverTerm(psTerm: string): string | null {
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
    const declaredPrograms = session.student?.declaredPrograms ?? [];

    // RC-3: classify requirement kinds structurally from the DPR group hierarchy.
    const kindByRId = classifyRequirementKind({
        groups: dpr.requirementGroups,
        declaredPrograms,
    });

    const majorRuleKinds = new Map<string, "must_take" | "choose_n">();
    const schoolCoreRuleIds = new Set<string>();
    const generalCategoryRuleIds = new Set<string>();

    // Walk all leaves and populate the rule maps from the classifier output.
    const leaves = walkRequirements(dpr.requirementGroups);
    for (const leaf of leaves) {
        const kind = kindByRId.get(leaf.rId);
        if (kind === "major-required") {
            majorRuleKinds.set(leaf.rId, "must_take");
        } else if (kind === "major-elective") {
            majorRuleKinds.set(leaf.rId, "choose_n");
        } else if (kind === "school-core") {
            schoolCoreRuleIds.add(leaf.rId);
        } else {
            // "free-elective", "general-elective", "unknown" → general bucket
            generalCategoryRuleIds.add(leaf.rId);
        }
    }

    // ---- Residency floor ----
    // Prefer dpr.cumulative.residencyRequired (the primary residency row).
    // Take the max over dpr.cumulative.residencyAll[*].required so a joint-major
    // program-specific residency row isn't lost if it exceeds the main row.
    let residencyMin: number | null = dpr.cumulative.residencyRequired ?? null;
    if (dpr.cumulative.residencyAll) {
        for (const row of dpr.cumulative.residencyAll) {
            if (typeof row.required === "number") {
                residencyMin = residencyMin === null ? row.required : Math.max(residencyMin, row.required);
            }
        }
    }

    // ---- Major credit floor ----
    // Sum counter.required (units kind) across all leaves classified as
    // "major-required" or "major-elective" by the Task-1.7 classifier.
    //
    // This is a conservative floor: it captures only leaves that carry a
    // units-counter with a positive required value. Course-count-only
    // requirements (e.g. a group summary stating "18 courses required") are
    // NOT captured here — they have no units counter and therefore do not
    // contribute to majorCreditMin. For the CAS-Economics fixture, the
    // units-leaf sum = 36 credits; the group's course-count summary = 18
    // courses — these are independent counters and do NOT agree in kind.
    let majorCreditMin: number | null = null;
    for (const leaf of leaves) {
        const kind = kindByRId.get(leaf.rId);
        if (kind === "major-required" || kind === "major-elective") {
            if (leaf.counter?.kind === "units") {
                // Use the total required (not just "needed" remaining) so the
                // floor reflects the full program requirement regardless of
                // how many credits the student has already earned toward it.
                const requiredCredits = leaf.counter.required;
                if (requiredCredits > 0) {
                    majorCreditMin = (majorCreditMin ?? 0) + requiredCredits;
                }
            }
        }
    }

    const validatorRules: GraduationPathValidatorArgs["programRules"] = {
        degreeCreditMinimum,
        residencyMinCredits: typeof residencyMin === "number" ? residencyMin : null,
        majorCreditMinimum: majorCreditMin,
        minorCreditMinimum: null,
        // upperLevelMinCredits: no DPR counter clearly represents this for all
        // programs — leave null so the validator returns requires-approval rather
        // than inventing a floor. Revisit when a structured upper-level counter
        // is identified in the DPR fixture.
        upperLevelMinCredits: null,
        schoolCoreMinCredits: null,
        graduationTargetTerm: graduationTerm,
    };

    const solverRules: SolverInput["programRules"] = {
        majorRuleKinds,
        schoolCoreRuleIds,
        generalCategoryRuleIds,
        residencyMinCredits: typeof residencyMin === "number" ? residencyMin : null,
        majorCreditMinimum: majorCreditMin,
        upperLevelMinCredits: null,
    };

    return { validatorRules, solverRules };
}

// ---------------------------------------------------------------------------
// Test-only export (not part of the public API surface)
// ---------------------------------------------------------------------------

/**
 * Exposed for unit tests that need to inspect the programRules maps
 * directly without constructing a full session. Returns only the
 * solver-facing rule maps (majorRuleKinds, schoolCoreRuleIds,
 * generalCategoryRuleIds) so tests can assert the classifier output.
 *
 * @internal — test use only
 */
export function buildProgramRulesForTest(
    dpr: DegreeProgressReport,
    declaredPrograms: ProgramDeclaration[],
): {
    majorRuleKinds: Map<string, "must_take" | "choose_n">;
    schoolCoreRuleIds: Set<string>;
    generalCategoryRuleIds: Set<string>;
} {
    const kindByRId = classifyRequirementKind({
        groups: dpr.requirementGroups,
        declaredPrograms,
    });

    const majorRuleKinds = new Map<string, "must_take" | "choose_n">();
    const schoolCoreRuleIds = new Set<string>();
    const generalCategoryRuleIds = new Set<string>();

    const leaves = walkRequirements(dpr.requirementGroups);
    for (const leaf of leaves) {
        const kind = kindByRId.get(leaf.rId);
        if (kind === "major-required") {
            majorRuleKinds.set(leaf.rId, "must_take");
        } else if (kind === "major-elective") {
            majorRuleKinds.set(leaf.rId, "choose_n");
        } else if (kind === "school-core") {
            schoolCoreRuleIds.add(leaf.rId);
        } else {
            generalCategoryRuleIds.add(leaf.rId);
        }
    }

    return { majorRuleKinds, schoolCoreRuleIds, generalCategoryRuleIds };
}
