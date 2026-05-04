// ============================================================
// prereqSatisfaction.ts — Phase 13 Task 3.0, Decision #4
// ============================================================
// Canonical implementation of the optimistic-forward-projection
// prereq-satisfaction rule. Single source of truth: the solver
// AND any future tool that checks prereqs MUST call isPrereqSatisfied
// rather than re-implementing the logic.
//
// Decision #4 (canonical):
//   A prereq course Y satisfies course X's requirement in term T iff
//   ANY ONE of the three optimistic-forward-projection paths fires:
//     1. Y appears in any DPRRequirement leaf's coursesUsed[]
//        (DPR officially recorded Y as satisfying something).
//     2. Y has type "IP" in courseHistory[] (currently enrolled,
//        assumed-passing for planning purposes).
//     3. Y is placed in a term strictly before T (or ≤T for coreqs)
//        in the solver's current in-progress plan.
//
//   Hard-reject: Y has a final past attempt (EN/TE) that fails the
//   satisfaction check AND no later retake (IP, future-plan, satisfiedBy).
//
//   "Fails the satisfaction check":
//     - If minGrades[Y] is set: use meetsGradeThreshold(grade, minGrades[Y]).
//     - If minGrades[Y] is absent: fall back to the DPR satisfiedBy check
//       (Step 1 already ran and returned false → fail-no-implicit-acceptance).
// ============================================================

import type { DegreeProgressReport, DPRCourseRow } from "./schema.js";
import { walkRequirements } from "./schema.js";
import { meetsGradeThreshold } from "./gradeComparison.js";

// ---- Types ----

export interface PrereqSatisfactionResult {
    satisfied: boolean;
    /** Short descriptor of which rule fired.
     *  Possible values:
     *    "dpr-satisfiedBy"           — Step 1: coursesUsed[] in any leaf req
     *    "ip-attempt"                — Step 2: IP row in courseHistory
     *    "future-placement"          — Step 3: solver placement before T (or ≤T for coreq)
     *    "dpr-satisfiedBy-implicit"  — Step 4: EN/TE attempt meets explicit minGrade threshold
     *    "fail-grade-threshold"      — hard-reject: most-recent attempt below minGrades threshold
     *    "fail-no-attempt"           — hard-reject: course never taken, no IP, no future-plan
     *    "fail-no-implicit-acceptance" — hard-reject: EN/TE attempt exists but DPR never
     *                                    recorded it in coursesUsed (no minGrades set)
     */
    reason: string;
}

// ---- Private term comparator (solver format: "2026-fall", "2027-spring") ----
//
// Season ranks mirror the literal Task 3 solver convention:
//   spring = 0, summer = 1, fall = 2, january = 3
//
// Returns negative when a < b, zero when a == b, positive when a > b.

const SEASON_RANK: Record<string, number> = {
    spring: 0,
    summer: 1,
    fall: 2,
    january: 3,
};

function parseSolverTerm(term: string): { year: number; seasonRank: number } | null {
    // Expected form: "YYYY-season"
    const dashIdx = term.indexOf("-");
    if (dashIdx === -1) return null;
    const yearStr = term.substring(0, dashIdx);
    const season = term.substring(dashIdx + 1).toLowerCase();
    const year = parseInt(yearStr, 10);
    if (isNaN(year)) return null;
    const seasonRank = SEASON_RANK[season];
    if (seasonRank === undefined) return null;
    return { year, seasonRank };
}

/** Compare two solver-format terms.
 *  Returns <0 if a < b, 0 if a == b, >0 if a > b.
 *  Unparseable terms sort as lowest possible (-Infinity). */
function compareSolverTerms(a: string, b: string): number {
    const pa = parseSolverTerm(a);
    const pb = parseSolverTerm(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    const yearDiff = pa.year - pb.year;
    if (yearDiff !== 0) return yearDiff;
    return pa.seasonRank - pb.seasonRank;
}

// ---- Private DPR-term comparator (PeopleSoft format: "2026 Fall", "2024 Spr") ----
//
// Used only for sorting courseHistory rows to find the most-recent attempt.
// Season token → rank mapping mirrors SEASON_RANK above where possible.

const DPR_SEASON_TOKEN: Record<string, number> = {
    Spr:    0,
    Spring: 0,
    Sum:    1,
    Summer: 1,
    Fall:   2,
    Fa:     2,
    Win:    3,
    Winter: 3,
    "J-Term": 3,
    JTerm:  3,
    Jan:    3,
};

function parseDprTerm(term: string): { year: number; seasonRank: number } | null {
    const trimmed = term.trim();
    // Primary form: "<year> <token>"
    const m = trimmed.match(/^(\d{4})\s+([A-Za-z-]+)$/);
    if (!m) return null;
    const year = parseInt(m[1]!, 10);
    const rank = DPR_SEASON_TOKEN[m[2]!];
    if (rank === undefined) return null;
    return { year, seasonRank: rank };
}

/** Compare two DPR-format term strings. Same sign convention as compareSolverTerms. */
function compareDprTerms(a: string, b: string): number {
    const pa = parseDprTerm(a);
    const pb = parseDprTerm(b);
    if (!pa && !pb) return 0;
    if (!pa) return -1;
    if (!pb) return 1;
    const yearDiff = pa.year - pb.year;
    if (yearDiff !== 0) return yearDiff;
    return pa.seasonRank - pb.seasonRank;
}

// ---- Private helper: courseId string from a DPRCourseRow ----
//
// Format: "CSCI-UA 101" (subject + space + catalogNbr).
// Matches the format used throughout the solver and bulletin parser.

function rowToCourseId(row: DPRCourseRow): string {
    return `${row.subject} ${row.catalogNbr}`;
}

// ---- Main export ----

/**
 * Phase 13 Decision #4 — optimistic-forward-projection prereq check.
 *
 * @param prereqCourseId  The course Y whose satisfaction we are checking.
 * @param dependentTerm   The solver-format term T of the dependent course X.
 *                        Y must be satisfied strictly before T (or ≤T when
 *                        mode === "coreq").
 * @param dpr             The student's current DegreeProgressReport.
 * @param plannedPlacements
 *                        Solver in-progress placements: courseId → term.
 *                        These are NOT the student's DPR history — those
 *                        flow through `dpr`.
 * @param minGrades       Optional grade-threshold map from
 *                        Prerequisite.minGrades.  When present and
 *                        minGrades[prereqCourseId] is set, an EN/TE attempt
 *                        must meet that threshold via meetsGradeThreshold.
 *                        When absent, the implicit floor is "did the DPR
 *                        record Y in any requirementGroups[].coursesUsed[]".
 * @param mode            "prereq" → strictly-before-T (< T).
 *                        "coreq"  → at-or-before-T (≤ T).
 */
export function isPrereqSatisfied(args: {
    prereqCourseId: string;
    dependentTerm: string;
    dpr: DegreeProgressReport;
    plannedPlacements: Map<string, string>;
    minGrades?: Record<string, string>;
    mode: "prereq" | "coreq";
}): PrereqSatisfactionResult {
    const { prereqCourseId, dependentTerm, dpr, plannedPlacements, minGrades, mode } = args;

    // ------------------------------------------------------------------
    // Step 1 — DPR satisfiedBy (coursesUsed in any leaf requirement).
    // Walk the requirementGroups tree; if Y appears in any
    // DPRRequirement.coursesUsed[], the registrar officially recorded Y
    // as satisfying something → satisfied, no grade check needed.
    // ------------------------------------------------------------------
    const allLeafReqs = walkRequirements(dpr.requirementGroups);
    for (const req of allLeafReqs) {
        for (const usedRow of req.coursesUsed) {
            if (rowToCourseId(usedRow) === prereqCourseId) {
                return { satisfied: true, reason: "dpr-satisfiedBy" };
            }
        }
    }

    // ------------------------------------------------------------------
    // Step 2 — IP attempt (currently enrolled, assumed-passing).
    // No grade check on IP — a re-plan trigger fires via reconcile.ts
    // when the IP row receives a final grade (Phase 13 separate task).
    // ------------------------------------------------------------------
    for (const row of dpr.courseHistory) {
        if (rowToCourseId(row) === prereqCourseId && row.type === "IP") {
            return { satisfied: true, reason: "ip-attempt" };
        }
    }

    // ------------------------------------------------------------------
    // Step 3 — Future placement in the solver's current plan.
    // prereq mode: placement must be strictly BEFORE dependentTerm.
    // coreq mode:  placement may be AT or before dependentTerm.
    // ------------------------------------------------------------------
    if (plannedPlacements.has(prereqCourseId)) {
        const placedTerm = plannedPlacements.get(prereqCourseId)!;
        const cmp = compareSolverTerms(placedTerm, dependentTerm);
        const satisfiesPlacement =
            mode === "prereq" ? cmp < 0 : cmp <= 0;
        if (satisfiesPlacement) {
            return { satisfied: true, reason: "future-placement" };
        }
        // Placement is at-or-after T (prereq) or strictly-after T (coreq) —
        // does NOT fire; fall through to Step 4.
    }

    // ------------------------------------------------------------------
    // Step 4 — Hard-reject check (final past attempts: EN or TE).
    //
    // If no such rows exist → course was never taken → fail-no-attempt.
    //
    // If at least one exists:
    //   a) minGrades[Y] is set: evaluate the most-recent EN/TE attempt.
    //      - Meets threshold → "dpr-satisfiedBy-implicit" (satisfied).
    //      - Below threshold → "fail-grade-threshold" (hard-reject).
    //   b) minGrades[Y] absent: implicit floor = DPR coursesUsed[].
    //      Step 1 already checked and returned false → "fail-no-implicit-acceptance".
    // ------------------------------------------------------------------
    const finalAttempts = dpr.courseHistory.filter(
        (row) => rowToCourseId(row) === prereqCourseId && (row.type === "EN" || row.type === "TE"),
    );

    if (finalAttempts.length === 0) {
        return { satisfied: false, reason: "fail-no-attempt" };
    }

    const minGrade = minGrades?.[prereqCourseId];

    if (minGrade !== undefined) {
        // Find the most-recent EN/TE attempt by DPR-term ordering.
        // Sort ascending then take the last; ties resolved by array order (last wins).
        const sorted = [...finalAttempts].sort((a, b) => compareDprTerms(a.term, b.term));
        const mostRecent = sorted[sorted.length - 1]!;

        if (meetsGradeThreshold(mostRecent.grade ?? undefined, minGrade)) {
            return { satisfied: true, reason: "dpr-satisfiedBy-implicit" };
        } else {
            return { satisfied: false, reason: "fail-grade-threshold" };
        }
    }

    // minGrades absent — implicit-floor signal is DPR coursesUsed[].
    // Step 1 ran and returned false → registrar did NOT accept the attempt.
    return { satisfied: false, reason: "fail-no-implicit-acceptance" };
}
