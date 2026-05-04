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
    /** Currently-IP per DPR. */
    coursesInProgress: Set<string>;
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
