// ============================================================
// Academic Standing Calculator
// ============================================================
// Source: SKILL.md §A3.8 — all rules from:
//         Original rules/General CAS academic rules.md → Academic Standing
//
// Phase 1 Step A: GPA / completion thresholds moved into CAS_DEFAULTS.
// Phase 1 Step D: overallGpaMin and goodStandingReturnThreshold now read from the
// runtime SchoolConfig when supplied; the dismissal-rate structure
// (50% / 2-semester) is intentionally still CAS-only — see L139-141
// for rationale. Add school-specific dismissal config when a non-CAS
// source documents an alternative.
// ============================================================

import type { CourseTaken, SchoolConfig, GpaTierRow } from "@nyupath/shared";

/**
 * Look up the active GPA tier for `semestersCompleted`. Returns the
 * largest finite row whose `semestersCompleted <= count`, or the
 * open-ended (`null`) row if any rows have `semestersCompleted > count`
 * but an open-ended floor exists.
 */
function resolveTieredGpaMin(
    table: GpaTierRow[] | undefined,
    count: number,
): number | undefined {
    if (!table || table.length === 0) return undefined;
    const finiteRows = table
        .filter((r) => typeof r.semestersCompleted === "number")
        .sort((a, b) => (a.semestersCompleted as number) - (b.semestersCompleted as number));
    let active: GpaTierRow | undefined;
    for (const r of finiteRows) {
        if ((r.semestersCompleted as number) <= count) active = r;
    }
    if (active) return active.minCumGpa;
    // Past the highest finite tier — fall through to the open-ended row if any
    const openEnded = table.find((r) => r.semestersCompleted === null);
    return openEnded?.minCumGpa;
}

// ---- CAS defaults (Phase 1 Step A: extracted, not yet config-driven) ----
const CAS_DEFAULTS = {
    overallGpaMin: 2.0,
    completionRate: {
        goodStandingThreshold: 0.75,
        dismissalThreshold: 0.50,
        dismissalAfterSemesters: 2,
    },
} as const;

export type StandingLevel =
    | "good_standing"
    | "academic_concern"
    | "continued_concern"
    | "required_leave"
    | "pre_dismissal"
    | "final_probation"
    | "dismissed";

export interface StandingResult {
    /** Current standing level */
    level: StandingLevel;
    /** Cumulative GPA */
    cumulativeGPA: number;
    /** Latest semester GPA (if determinable) */
    semesterGPA?: number;
    /** Credit completion percentage */
    completionRate: number;
    /** Whether the student is in good academic standing */
    inGoodStanding: boolean;
    /** Human-readable explanation */
    message: string;
    /** Specific warnings */
    warnings: string[];
}

/**
 * Grade point values per NYU grading scale.
 * Source: General CAS academic rules.md → Grading (effective Fall 2018)
 */
const GRADE_POINTS: Record<string, number> = {
    "A": 4.000,
    "A-": 3.667,
    "B+": 3.333,
    "B": 3.000,
    "B-": 2.667,
    "C+": 2.333,
    "C": 2.000,
    "C-": 1.667,
    "D+": 1.333,
    "D": 1.000,
    "F": 0.000,
};

// Grades that earn credits (used for completion rate)
const PASSING_GRADES = new Set(["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "P"]);

// Grades that are computed in GPA (letter grades + F under P/F)
// P is NOT computed in GPA; F under P/F IS computed
const GPA_GRADES = new Set(Object.keys(GRADE_POINTS));

/**
 * Calculate academic standing based on GPA and completion rate.
 *
 * Rules from [GEN-ACAD] §A3.8:
 * - NOT in good standing if cumulative or semester GPA < 2.0
 * - To return: semester GPA ≥ 2.0, cumulative GPA ≥ 2.0, complete ≥ 75% of attempted credits
 * - After 2nd semester, may be dismissed if < 50% of attempted credits completed
 *
 * @param coursesTaken - All courses the student has taken
 * @param semestersCompleted - Number of semesters completed (for dismissal threshold)
 */
export function calculateStanding(
    coursesTaken: CourseTaken[],
    semestersCompleted: number = 0,
    schoolConfig: SchoolConfig | null = null,
): StandingResult {
    const warnings: string[] = [];

    // Compute cumulative GPA
    let totalGradePoints = 0;
    let totalGPACredits = 0;
    let totalAttemptedCredits = 0;
    let totalCompletedCredits = 0;

    for (const ct of coursesTaken) {
        const grade = ct.grade.toUpperCase();
        const credits = ct.credits ?? 4;

        // TR (transfer): not attempted at NYU and not in NYU GPA — skip entirely.
        // Source: CAS bulletin (line 127): "Grades of courses for which transfer
        // credit is given are omitted in computing a student's cumulative or
        // current semester GPAs."
        if (grade === "TR") continue;

        // G32-G34: W (withdrawal), I (incomplete), NR (no record) all count
        // as ATTEMPTED but not earned and not in GPA.
        // Source: CAS bulletin line 394 (NR): "Courses with NR grades will not
        // count toward earned credit and will not factor into the GPA, but will
        // count as credits attempted." ARCHITECTURE.md §1785: "I/NR/W grades
        // ≠ earned; include in attempted."
        if (grade === "W" || grade === "I" || grade === "NR") {
            totalAttemptedCredits += credits;
            continue;
        }

        totalAttemptedCredits += credits;

        // P grade: earns credits but NOT computed in GPA
        if (grade === "P") {
            totalCompletedCredits += credits;
            continue;
        }

        // F grade (including under P/F): computed in GPA, does NOT earn credits
        if (grade === "F") {
            const gpa = GRADE_POINTS["F"];
            totalGradePoints += gpa * credits;
            totalGPACredits += credits;
            // F does NOT count as completed
            continue;
        }

        // Letter grades: computed in GPA
        if (GPA_GRADES.has(grade)) {
            const gpa = GRADE_POINTS[grade];
            totalGradePoints += gpa * credits;
            totalGPACredits += credits;

            if (PASSING_GRADES.has(grade)) {
                totalCompletedCredits += credits;
            }
        }
    }

    const cumulativeGPA = totalGPACredits > 0 ? totalGradePoints / totalGPACredits : 0;
    const completionRate = totalAttemptedCredits > 0
        ? totalCompletedCredits / totalAttemptedCredits
        : 1;

    // Determine standing — SchoolConfig overrides for the values it knows
    // about (overallGpaMin, goodStandingReturnThreshold). The CAS-specific
    // completion-rate structure (50% dismissal / "after 2nd semester") is
    // not expressed in SchoolConfig today, so we keep CAS defaults for it.
    // Gap B (Phase 3): when SchoolConfig publishes a per-semester tiered
    // GPA table (e.g., Tandon L287-300), the active tier supersedes the
    // flat `overallGpaMin`. Tier lookup: largest row whose semestersCompleted
    // is ≤ the student's semestersCompleted; null = open-ended ">N" tier.
    const flatGpaMin = schoolConfig?.overallGpaMin ?? CAS_DEFAULTS.overallGpaMin;
    const gpaMin = resolveTieredGpaMin(schoolConfig?.gpaTierTable, semestersCompleted) ?? flatGpaMin;
    const dismissalThreshold = CAS_DEFAULTS.completionRate.dismissalThreshold;
    const dismissalAfter = CAS_DEFAULTS.completionRate.dismissalAfterSemesters;
    const goodStandingThreshold =
        schoolConfig?.goodStandingReturnThreshold
        ?? CAS_DEFAULTS.completionRate.goodStandingThreshold;

    const inGoodStanding = cumulativeGPA >= gpaMin;
    let level: StandingLevel = "good_standing";
    let message = "In good academic standing.";

    if (!inGoodStanding) {
        level = "academic_concern";
        message = `Academic concern: cumulative GPA is ${cumulativeGPA.toFixed(3)} (below ${gpaMin.toFixed(1)} minimum).`;
        warnings.push(`Cumulative GPA is below the ${gpaMin.toFixed(1)} minimum required for good academic standing.`);
    }

    // Gap A (Phase 3): the dismissal-completion-rate review per CAS bulletin
    // L494 is INDEPENDENT of GPA. Lift out of the !inGoodStanding gate.
    if (semestersCompleted >= dismissalAfter && completionRate < dismissalThreshold) {
        level = "dismissed";
        const pct = Math.round(dismissalThreshold * 100);
        message = `Academic dismissal risk: only ${(completionRate * 100).toFixed(0)}% of attempted credits completed after ${semestersCompleted} semesters.`;
        warnings.push(`Completion rate ${(completionRate * 100).toFixed(0)}% is below ${pct}% after ${semestersCompleted} semesters — may result in dismissal.`);
    }

    // Phase 3 follow-up: Tandon bulletin L303 final-probation footnote —
    // "Any time a student's cumulative GPA falls below 1.5 they are placed
    // on Final Probation regardless of how many credits they have completed."
    // This is a stronger designation than academic_concern but distinct
    // from dismissal. It does not override an already-emitted "dismissed".
    const finalProbationFloor = schoolConfig?.finalProbationGpaFloor;
    if (
        typeof finalProbationFloor === "number"
        && cumulativeGPA < finalProbationFloor
        && level !== "dismissed"
    ) {
        level = "final_probation";
        message = `Final Probation: cumulative GPA ${cumulativeGPA.toFixed(3)} is below the ${finalProbationFloor.toFixed(1)} floor.`;
        warnings.push(
            `Cumulative GPA below ${finalProbationFloor.toFixed(1)} triggers Final Probation regardless of credits completed (${schoolConfig?.name ?? "school"} policy).`,
        );
    }

    // Additional warning for completion rate below the good-standing threshold
    if (completionRate < goodStandingThreshold && level !== "dismissed") {
        const pct = Math.round(goodStandingThreshold * 100);
        warnings.push(`Credit completion rate is ${(completionRate * 100).toFixed(0)}% — below the ${pct}% threshold required to return to good standing.`);
    }

    return {
        level,
        cumulativeGPA: Math.round(cumulativeGPA * 1000) / 1000,
        completionRate: Math.round(completionRate * 1000) / 1000,
        inGoodStanding,
        message,
        warnings,
    };
}

/**
 * Compute GPA for a specific semester.
 * Useful for checking semester-specific standing.
 */
export function computeSemesterGPA(coursesTaken: CourseTaken[], semester: string): number {
    let totalPoints = 0;
    let totalCredits = 0;

    for (const ct of coursesTaken) {
        if (ct.semester !== semester) continue;
        const grade = ct.grade.toUpperCase();
        // P, TR, W, I, NR are excluded from GPA computation (per CAS bulletin
        // line 344 "Only grades of A through F... are computed in the average").
        if (grade === "P" || grade === "TR" || grade === "W" || grade === "I" || grade === "NR") continue;
        const gpa = GRADE_POINTS[grade];
        if (gpa === undefined) continue;
        const credits = ct.credits ?? 4;
        totalPoints += gpa * credits;
        totalCredits += credits;
    }

    return totalCredits > 0 ? Math.round((totalPoints / totalCredits) * 1000) / 1000 : 0;
}
