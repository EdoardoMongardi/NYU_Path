// ============================================================
// Grade-threshold comparison for prereq satisfaction
// ============================================================
//
// Phase 13's solver checks whether a student's grade in a prereq
// course meets the threshold specified in the bulletin (now stored in
// `Prerequisite.minGrades`; previously trusted to DPR per the now-
// reversed Decision #4). This module is the canonical comparison
// utility — every prereq-satisfaction call site MUST go through
// `meetsGradeThreshold` rather than re-implementing the ladder.
//
// Why this exists (Decision #4 reversal context)
// -----------------------------------------------
// The locked Decision #4 said "trust DPR; the solver checks
// `coursesTaken[i]` membership but doesn't verify the student's grade
// against the bulletin's threshold." Empirical bulletin scan showed
// that's a silent-bug risk:
//   - 158 C-thresholds (DPR usually catches sub-C, low risk)
//   - 39 D-thresholds (passing = D, basically free)
//   -  9 C− thresholds
//   -  2 B thresholds  ← solver could green-light a downstream course
//   -  1 B+ threshold    the student cannot actually register for
//   -  1 A− threshold
// The B/B+/A− cases are the bug-rich tail. Hence: Decision #4 reversed,
// `Prerequisite.minGrades` populated by extractGradeThresholds.ts, and
// this comparator wired into the solver.
//
// Pure: no I/O, no closures over module state. Safe to call from
// any layer.
// ============================================================

/**
 * Total order over the NYU letter-grade ladder. Higher number = better.
 * Pass-fail-style grades (`P`, `CR`, `S`) are treated as C-equivalent
 * (passing letter grade). Anything not listed here (W, I, NR, audit
 * marks, etc.) returns `undefined` from the lookup, which fails closed.
 */
const GRADE_ORDER: Record<string, number> = {
    "A+": 13,
    A: 12,
    "A-": 11,
    "B+": 10,
    B: 9,
    "B-": 8,
    "C+": 7,
    C: 6,
    "C-": 5,
    "D+": 4,
    D: 3,
    "D-": 2,
    F: 0,
    // Pass/fail-style passing marks are treated as C-equivalent
    // (sufficient to pass any threshold of C or below; insufficient
    // for B/B+/A-/A+ thresholds — the student would need a letter
    // grade for those).
    P: 6,
    CR: 6,
    S: 6,
};

/**
 * Returns `true` iff `studentGrade` meets or exceeds `requiredGrade` per
 * the NYU letter-grade order. Unknown grades (W, I, NR, typos, undefined)
 * return `false` — the comparator fails closed; better to flag a course
 * for human review than silently approve a prereq the student may not
 * have actually completed.
 *
 * Inputs are case-normalized (`b+` → `B+`) and trimmed; whitespace inside
 * the grade is not allowed (e.g., `" B  -" → "B-"` is NOT applied).
 *
 * @example
 *   meetsGradeThreshold("B", "C")    // true
 *   meetsGradeThreshold("C-", "C")   // false
 *   meetsGradeThreshold("P", "C")    // true (P treated as C-equivalent)
 *   meetsGradeThreshold("P", "B")    // false (no letter grade earned)
 *   meetsGradeThreshold("F", "D")    // false
 *   meetsGradeThreshold(undefined, "D")  // false (no record)
 */
export function meetsGradeThreshold(
    studentGrade: string | undefined | null,
    requiredGrade: string,
): boolean {
    if (!studentGrade) return false;
    const s = GRADE_ORDER[studentGrade.toUpperCase().trim()];
    const r = GRADE_ORDER[requiredGrade.toUpperCase().trim()];
    if (s === undefined || r === undefined) return false;
    return s >= r;
}
