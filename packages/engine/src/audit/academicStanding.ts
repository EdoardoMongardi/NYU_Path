// ============================================================
// Academic Standing Calculator
// ============================================================
// Source: SKILL.md §A3.8 — all rules from:
//         Original rules/General CAS academic rules.md → Academic Standing
// ============================================================

import type { CourseTaken } from "@nyupath/shared";

export type StandingLevel =
    | "good_standing"
    | "academic_concern"
    | "continued_concern"
    | "required_leave"
    | "pre_dismissal"
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
    semestersCompleted: number = 0
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

        // Skip non-academic grades (TR, W, etc.)
        if (grade === "TR" || grade === "W" || grade === "I") continue;

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

    // Determine standing
    const inGoodStanding = cumulativeGPA >= 2.0;
    let level: StandingLevel = "good_standing";
    let message = "In good academic standing.";

    if (!inGoodStanding) {
        level = "academic_concern";
        message = `Academic concern: cumulative GPA is ${cumulativeGPA.toFixed(3)} (below 2.0 minimum).`;
        warnings.push("Cumulative GPA is below the 2.0 minimum required for good academic standing.");

        // Check dismissal risk — source: "after 2nd semester, may be dismissed if < 50% attempted credits completed"
        if (semestersCompleted >= 2 && completionRate < 0.50) {
            level = "dismissed";
            message = `Academic dismissal risk: only ${(completionRate * 100).toFixed(0)}% of attempted credits completed after ${semestersCompleted} semesters.`;
            warnings.push(`Completion rate ${(completionRate * 100).toFixed(0)}% is below 50% after ${semestersCompleted} semesters — may result in dismissal.`);
        }
    }

    // Additional warning for completion rate below 75%
    if (completionRate < 0.75 && level !== "dismissed") {
        warnings.push(`Credit completion rate is ${(completionRate * 100).toFixed(0)}% — below the 75% threshold required to return to good standing.`);
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
        if (grade === "P" || grade === "TR" || grade === "W" || grade === "I") continue;
        const gpa = GRADE_POINTS[grade];
        if (gpa === undefined) continue;
        const credits = ct.credits ?? 4;
        totalPoints += gpa * credits;
        totalCredits += credits;
    }

    return totalCredits > 0 ? Math.round((totalPoints / totalCredits) * 1000) / 1000 : 0;
}
