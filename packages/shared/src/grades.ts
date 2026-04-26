// ============================================================
// Letter-grade ordering and threshold helpers
// ============================================================
// Single source of truth for the NYU letter-grade ordering used by
// degreeAudit, passfailGuard, creditCapValidator, ruleEvaluator, and
// academicStanding. Keeping the ordering here avoids four copies of
// the same array drifting independently when SchoolConfig.gradeThresholds
// is wired in (Phase 1 Step D).
//
// Source: General CAS academic rules.md → Grading (effective Fall 2018).
// "F" is intentionally omitted from the threshold ordering — F never
// satisfies a grade-floor rule. P is omitted because P/F is governed
// by SchoolConfig.passFail, not by the letter-threshold ladder.
// ============================================================

/**
 * Letter grades that can satisfy a "grade ≥ threshold" rule, ordered
 * highest-first. Index N + 1 is strictly worse than index N.
 */
export const LETTER_GRADE_ORDER = [
    "A",
    "A-",
    "B+",
    "B",
    "B-",
    "C+",
    "C",
    "C-",
    "D+",
    "D",
] as const;

export type LetterGrade = typeof LETTER_GRADE_ORDER[number];

/**
 * Return the set of letter grades that meet `threshold` or better.
 *
 * `threshold` is matched case-sensitively against `LETTER_GRADE_ORDER`.
 * Throws on an unknown threshold rather than returning the empty set —
 * a typo in SchoolConfig.gradeThresholds should fail loudly, not
 * silently disqualify every course.
 *
 * Examples:
 *   gradesAtOrAbove("C")  → {A, A-, B+, B, B-, C+, C}
 *   gradesAtOrAbove("D")  → {A, A-, ..., D+, D}
 *   gradesAtOrAbove("A")  → {A}
 */
/**
 * Normalize a school identifier to its canonical form.
 *
 * `Program.school` is historically uppercase ("CAS", "Tandon") because
 * the field was authored by hand from human-readable strings. The Phase 1
 * additions (`StudentProfile.homeSchool`, `SchoolConfig.schoolId`,
 * `data/schools/<id>.json` filenames, `data/programs/<id>/` directory
 * names) are all lowercase. To compare across the boundary safely, run
 * both sides through `canonicalSchoolId` first.
 *
 * Pure: returns lowercase, trims surrounding whitespace, leaves the
 * input alone otherwise.
 */
export function canonicalSchoolId(s: string): string {
    return s.trim().toLowerCase();
}

export function gradesAtOrAbove(threshold: string): Set<string> {
    const idx = LETTER_GRADE_ORDER.indexOf(threshold as LetterGrade);
    if (idx === -1) {
        throw new Error(
            `gradesAtOrAbove: unknown letter-grade threshold "${threshold}". ` +
            `Expected one of: ${LETTER_GRADE_ORDER.join(", ")}.`,
        );
    }
    return new Set(LETTER_GRADE_ORDER.slice(0, idx + 1));
}
