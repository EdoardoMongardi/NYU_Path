/**
 * Phase 13 Task 3.1 — Solver internal types.
 *
 * SolverInput is the canonical bundle the solver receives from build.ts.
 * SolverOutput is what solveForwardSchedule() returns.
 * SolverNode is the in-flight mutable state used during greedy placement.
 *
 * Decisions covered in these types:
 *   #4  prereqSatisfaction helper wiring
 *   #24 workloadTier per-slot
 *   #25 balanceScore
 *   #28 pool-slot binding
 *   #29 offeringConfidence tier
 *   #30 IP assumptions
 *   #32 PlanState 4-state
 *   #37 placeholder slot binding
 *   #44 alternativeCandidates
 */

import type {
    PrereqGroup,
    ForwardSemester,
    ScheduleSlot,
    FeasibilityReport,
    AlternativePlanSummary,
    Assumption,
    PlanState,
    ConfidenceTier,
    WorkloadTier,
    SchedulePreferences,
} from "@nyupath/shared";
import type { DegreeProgressReport } from "../../dpr/schema.js";

// ---------------------------------------------------------------------------
// SolverInput
// ---------------------------------------------------------------------------

/**
 * Phase 13 — Solver input bundle. All fields are immutable from the
 * solver's perspective; the solver builds a fresh ForwardSchedule
 * from these inputs and never mutates them.
 */
export interface SolverInput {
    // ---- Student-side state (from build.ts wrapper / DPR ingest) ----
    studentId: string;
    homeSchoolId: string;
    visaStatus: string | undefined;
    /** Already-completed (DPR + AP/IB synth). */
    coursesTaken: Set<string>;
    /** Currently-IP per DPR. Keys are courseIds ("CSCI-UA 4");
     *  values carry the solver-shape term ("2026-spring", "2026-fall")
     *  the row was tagged with on the DPR. The solver places each IP
     *  row in ITS OWN term — without per-row terms, the May 2026 post-
     *  mortem bug bucketed every IP course (current-term + pre-
     *  registered future terms) into a single fictitious 28-credit
     *  current term. */
    coursesInProgress: Map<string, { term: string }>;
    /** e.g. "2026-fall" */
    currentTerm: string;
    graduationTerm: string;

    // ---- Per-term targets / floors / ceilings ----
    creditTargetPerSemester: number;
    /** F-1 minimum (typically 12) when applicable, else null. */
    f1Floor: number | null;
    /** Domestic part-time floor (typically 8) when applicable, else null. */
    domesticPartTimeFloor: number | null;
    /** Per-school upper credit ceiling (default 18). */
    creditCeiling: number;
    /** Hard graduation total (128 for CAS). */
    graduationCreditMinimum: number;
    /** Total credits already earned (per DPR). */
    creditsEarned: number;

    // ---- Header-level credit caps ----
    /** Pass/fail unit cap (CAS = 32). */
    passFailCap: number;
    /** Pass/fail units already used (per DPR header). */
    passFailUsed: number;
    /** Online-credit cap toward the major (CAS commonly 8 or 16). */
    onlineCreditCap: number | null;
    /** Online credits already counted toward the major (per DPR header). */
    onlineCreditsUsed: number;
    /** Outside-home-school credit cap (CAS = 16 for non-CAS courses). */
    outsideHomeCreditCap: number | null;
    /** Outside-home-school credits already used (per DPR header). */
    outsideHomeCreditsUsed: number;
    /** Cumulative GPA per the latest DPR. */
    cumulativeGpa: number;
    /** Cumulative major GPA per the DPR (when available). */
    majorGpa: number | null;
    /** School-required cumulative GPA floor for graduation (typically 2.0). */
    graduationGpaFloor: number;
    /** Major-GPA floor (when applicable). */
    majorGpaFloor: number | null;

    // ---- Unmet requirements (DPR notSatisfiedRequirements) ----
    unmetRequirements: Array<{
        rId: string;
        title: string;
        /** e.g. "cs_major_required" | "cas_core" | "free_elective" */
        category: string;
        /** Credits this requirement consumes. Usually 4 in CAS. */
        credits: number;
        /** Specific course IDs that satisfy this requirement (when known).
         *  Empty for placeholder-style requirements like "any free elective". */
        candidateCourses: string[];
    }>;

    // ---- Catalog / parser-output ----
    /** Parsed prereqs (Phase 12.8 output). courseId → PrereqGroup[]. */
    prereqs: Map<string, PrereqGroup[]>;
    /** Parsed offerings (Phase 12.8 output). courseId → term list. */
    offerings: Map<string, Array<"fall" | "spring" | "summer" | "january">>;
    /** Phase 12.9.5 confidence tier per course (#29).
     *  When absent → "historically_partial" default. */
    offeringConfidence: Map<string, ConfidenceTier>;
    /** Course metadata: title + credits, indexed by courseId. */
    courseCatalog: Map<string, { title: string; credits: number }>;
    /**
     * Step 8d PR-2 — bulletin credits for courses OUTSIDE the undergraduate
     * planning catalog (graduate/professional). Used only to resolve an
     * explicit student PIN of an off-catalog course (e.g. an advanced
     * undergrad pinning a grad course) so it places with real credits + a
     * "verify in Albert" caveat instead of being dropped. Auto-planning
     * never consults this. Absent → off-catalog pins fall to the 0-credit
     * "may be discontinued/renumbered" caveat path.
     */
    offCatalogCredits?: Map<string, { title: string; credits: number }>;
    /** DPR.courseHistory hash for downstream reconciliation (Task 4). */
    dprCourseHistoryHash: string;
    /** DPR for prereq-satisfaction queries (Decision #4 helper). */
    dpr: DegreeProgressReport;
    /** Optional grade-threshold map (Prerequisite.minGrades from prereqs.json). */
    minGrades?: Map<string, Record<string, string>>;

    // ---- Program rules for tier classification + audit ----
    /** Program rules for tier classification + audit (Decisions #24 + #33). */
    programRules: {
        majorRuleKinds: Map<string, "must_take" | "choose_n">;
        schoolCoreRuleIds: Set<string>;
        generalCategoryRuleIds: Set<string>;
        residencyMinCredits: number | null;
        majorCreditMinimum: number | null;
        upperLevelMinCredits: number | null;
    };

    /** Bulletin title per courseId for #35 modifiers (optional). */
    courseTitles?: Map<string, string>;
    /** Bulletin keyword tags per courseId for #35 modifiers (optional). */
    courseBulletinKeywords?: Map<string, string[]>;

    // ---- Phase 14 Task 3 — per-student solver preferences ----
    /** Phase 14 — load-style, pins, exclusions and per-term overrides.
     *  All fields optional; absent → Phase 13 defaults. */
    preferences?: SchedulePreferences;

    // ---- Phase 14 Task 9 — co-requisite same-term enforcement ----
    /**
     * Phase 14 Task 9 — Decision #14.
     * courseId → list of coreq courseIds that must be placed in the SAME term.
     * Populated by build.ts from prereqs.json's `coreqs` field per course.
     * When undefined or empty for a given courseId, no coreq constraint applies.
     */
    coreqs?: Map<string, string[]>;

    // ---- P2.10 (a) — build-time advisory warnings ----
    /**
     * Non-fatal advisories surfaced while building this input from the DPR —
     * e.g. the DPR omitted the degree credit minimum so a default was assumed.
     * Always present (possibly empty). Carried onto SolverOutput.warnings and
     * then ForwardSchedule.warnings so the agent-facing schedule shows them.
     */
    warnings: string[];

    // ---- T2b — derived-horizon flag (for add-a-term relax) ----
    /**
     * True when the `graduationTerm` was derived from credits (no student-stated
     * target and no explicit override). Used by `buildForwardSchedule` (build.ts)
     * to decide whether a too-short horizon may be automatically extended by one
     * main term. Undefined is treated as false (the safe default), so existing
     * test factories that do not set this field remain unaffected.
     */
    graduationTermWasDerived?: boolean;
}

// ---------------------------------------------------------------------------
// SolverOutput
// ---------------------------------------------------------------------------

export interface SolverOutput {
    semesters: ForwardSemester[];
    feasibility: FeasibilityReport;
    /** Decision #44 — top-5 alternative-plan summaries from Stage 7. */
    alternativeCandidates?: AlternativePlanSummary[];
    /** Decision #25 — plan-level scalar from balanceScore.ts. */
    balanceScore: number;
    /** Decision #30 — per-IP-course assumption entries. */
    assumptions: Assumption[];
    /** Decision #32 — derived from validator + caveat axes. */
    state: PlanState;
    /**
     * P2.10 (a) — build-time advisories carried from SolverInput.warnings.
     * Omitted (undefined) when there are none, so the field stays absent on
     * the common path. build.ts copies this onto ForwardSchedule.warnings.
     */
    warnings?: string[];
    /** Structured optimality of the returned plan (companion to `warnings`):
     *  "optimal" — search ran to exhaustion; the winner is the proven optimum (rare on the
     *    feasibility-first primary path; reserved for a future exhaustive-proof mode).
     *  "best-effort" — a VALID plan was found (feasibility-first) but it may not be the most
     *    preferred; surface a confidence caveat ("valid plan; may not be the most preferred —
     *    tell me your priorities and I'll refine").
     *  "feasibility-unconfirmed" — no valid plan was found within budget (NOT proven infeasible).
     *  Omitted is treated as "optimal" by consumers for back-compat. */
    optimality?: "optimal" | "best-effort" | "feasibility-unconfirmed";
}

// ---------------------------------------------------------------------------
// SolverNode (internal mutable state during greedy placement)
// ---------------------------------------------------------------------------

export interface SolverNode {
    /** Per-term tentative slot list (mutable during search). */
    perTerm: Map<string, ScheduleSlot[]>;
    /** Course IDs already placed (for prereq + NOT checks). */
    placedCourses: Set<string>;
    /** Courses we've decided NOT to place (e.g. excluded by NOT clauses). */
    excludedCourses: Set<string>;
    /** Per-term running credit count. */
    perTermCredits: Map<string, number>;
    /** Backtrack history (for debugging only). */
    decisions: string[];
}

// ---------------------------------------------------------------------------
// Re-export WorkloadTier so callers don't need a second import
// ---------------------------------------------------------------------------
export type { WorkloadTier };
