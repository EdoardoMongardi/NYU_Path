// ============================================================
// Per-Major / Per-Pool GPA Calculator (Phase 2 §G5-G6)
// ============================================================
// Some bulletin rules require a GPA computed over a specific subset
// of courses — e.g., the CAS Econ BA honors track requires "3.65
// average in economics courses" (Econ bulletin L76). This is the
// canonical helper for any "GPA over a course pool" computation.
//
// The grade classification rules (P/TR/W/I/NR exclusions) match
// `academicStanding.computeSemesterGPA` per CAS bulletin L344.
// ============================================================

import type { CourseTaken, Course } from "@nyupath/shared";

/**
 * NYU letter-grade → grade-point map (CAS bulletin L344-359).
 * F = 0.000 — included so F drags the major GPA down even though it
 * earns no credits, matching CAS GPA computation.
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

export interface PoolGpaResult {
    /** Computed GPA, rounded to 3 decimals. 0 when the pool has no graded courses. */
    gpa: number;
    /** Number of courses that contributed to the GPA */
    countedCourses: number;
    /** Total credit-hours that contributed (denominator) */
    countedCredits: number;
    /** Course IDs of the matched-and-graded courses */
    contributingCourseIds: string[];
}

/**
 * Compute a GPA over a set of courses, restricted to a pool of course IDs
 * or course-id wildcard patterns (e.g., `["ECON-UA *"]` for "all ECON-UA").
 *
 * Pool-matching is identical to ruleEvaluator's matchesPool semantics:
 *   - exact id match
 *   - wildcard prefix match (`"ECON-UA *"` matches any ECON-UA course)
 *
 * Excludes P/TR/W/I/NR per CAS bulletin L344. Letter grades (incl. F)
 * count.
 */
export function computePoolGpa(
    coursesTaken: CourseTaken[],
    pool: string[],
    courseCatalog?: Map<string, Course>,
): PoolGpaResult {
    const wildcardPrefixes: string[] = [];
    const exactIds = new Set<string>();
    for (const id of pool) {
        if (id.includes("*")) {
            wildcardPrefixes.push(id.replace("*", "").trimEnd());
        } else {
            exactIds.add(id);
        }
    }

    let totalPoints = 0;
    let totalCredits = 0;
    let countedCourses = 0;
    const contributingCourseIds: string[] = [];

    for (const ct of coursesTaken) {
        const grade = ct.grade.toUpperCase();
        if (!(grade in GRADE_POINTS)) continue; // P/TR/W/I/NR/etc.

        const id = ct.courseId;
        const inPool =
            exactIds.has(id) ||
            wildcardPrefixes.some((p) => id.startsWith(p));
        if (!inPool) continue;

        const credits = courseCatalog?.get(id)?.credits ?? ct.credits ?? 4;
        totalPoints += GRADE_POINTS[grade]! * credits;
        totalCredits += credits;
        countedCourses += 1;
        contributingCourseIds.push(id);
    }

    const raw = totalCredits > 0 ? totalPoints / totalCredits : 0;
    return {
        gpa: Math.round(raw * 1000) / 1000,
        countedCourses,
        countedCredits: totalCredits,
        contributingCourseIds,
    };
}

/**
 * Convenience: compute GPA over courses whose canonical course-id prefix
 * matches the major's department prefix (e.g., "CSCI-UA" for CS BA, or
 * "ECON-UA" for Econ BA). For majors whose requirements span multiple
 * prefixes (Econ requires MATH-UA 131/132 too), pass the explicit pool
 * via `computePoolGpa` instead.
 */
export function computeMajorGpaByDeptPrefix(
    coursesTaken: CourseTaken[],
    deptPrefix: string,
    courseCatalog?: Map<string, Course>,
): PoolGpaResult {
    return computePoolGpa(coursesTaken, [`${deptPrefix} *`], courseCatalog);
}
