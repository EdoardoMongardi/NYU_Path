// ============================================================
// applyWithdrawalToDpr — pure synthetic-DPR transform (G1.1)
// ============================================================
// Part of the what-if probe. Models "the student WILL WITHDRAW from
// this in-progress course" by returning a DEEP-COPIED synthetic
// DegreeProgressReport (the input `dpr` is NEVER mutated) in which:
//
//   1. `reportKind` is set to "what_if" — the clone is now a
//      hypothetical. The G0.2 snapshot guard will refuse to persist
//      a what_if DPR as a student's real DPR.
//
//   2. Every `courseHistory` row matching `courseId` has its `grade`
//      set to "W" (withdrawal). This is deliberately NOT "F":
//        - "W" is not in the NYU letter-grade ladder (GRADE_ORDER in
//          gradeComparison.ts), so meetsGradeThreshold("W", "D")
//          returns false (fails closed).
//        - buildSolverInput's coursesTaken set only adds a row when
//          meetsGradeThreshold(row.grade, "D") passes — so the
//          withdrawn course is excluded on the next solve without
//          being counted as an F in the GPA ladder.
//        - A withdrawal is GPA-neutral; marking it "F" would
//          misrepresent its academic impact.
//
//   3. The course is removed from every requirement leaf's
//      `coursesUsed[]`. For any leaf that drops below
//      `counter.required`, we flip `status` to "not_satisfied",
//      decrement `counter.used` by the number of rows removed, and
//      recompute `counter.needed = max(0, required - used)`. That
//      makes `notSatisfiedRequirements(...)` re-include the
//      requirement so the planner treats it as unmet work.
//
//   4. The `cumulative` block is left UNCHANGED. A withdrawal is
//      GPA-neutral; computing revised credit/GPA totals would
//      require knowing the real final state of the transcript, which
//      we don't have. This is a known simplification consistent with
//      plan §5 Q3 "skip exact GPA recomputation".
//
// COURSE-ID KEYING — identical to applyFailedCourseToDpr and
// buildSolverInput (line 198): `${row.subject} ${row.catalogNbr}`,
// canonicalized via canonicalizeCourseId so that the zero-padded
// form (`CSCI-UA 0101`) and the unpadded form (`CSCI-UA 101`)
// collapse to the same id.
//
// PURE: no I/O, no module state. Returns a fresh object via
// structuredClone. If `courseId` matches nothing, returns a
// structurally-equal deep copy with reportKind="what_if" (no-op
// on the content, but still a hypothetical container).
// ============================================================

import { canonicalizeCourseId } from "../../courseId.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
    type DPRRequirement,
    type DPRRequirementGroup,
} from "../../dpr/schema.js";

/** The grade used when a student withdraws — GPA-neutral, not in the
 *  letter-grade ladder, so it fails meetsGradeThreshold("W","D")
 *  cleanly without being miscounted as an academic failure. */
const WITHDRAWAL_GRADE = "W";

/**
 * The canonical course-id key for a course row, matching
 * buildSolverInput's `${row.subject} ${row.catalogNbr}` keying
 * (buildSolverInput.ts:198), run through `canonicalizeCourseId`
 * so zero-padded / unpadded forms unify.
 */
function rowKey(row: { subject: string; catalogNbr: string }): string {
    return canonicalizeCourseId(`${row.subject} ${row.catalogNbr}`);
}

/**
 * Return a DEEP-COPIED `DegreeProgressReport` in which `courseId`
 * is treated as WITHDRAWN: its `reportKind` becomes "what_if", its
 * courseHistory grades become "W", and it is stripped from every
 * requirement leaf's `coursesUsed[]`, reopening any leaf that drops
 * below its required count. The `cumulative` block is left unchanged
 * (W is GPA-neutral; credit/GPA recomputation is out of scope).
 * The input `dpr` is never mutated.
 */
export function applyWithdrawalToDpr(
    dpr: DegreeProgressReport,
    courseId: string,
): DegreeProgressReport {
    // structuredClone gives us a fully detached copy, so every edit
    // below is local to `next` and the caller's `dpr` is guaranteed
    // untouched.
    const next: DegreeProgressReport = structuredClone(dpr);
    const targetId = canonicalizeCourseId(courseId);

    // ---- 1. Mark as hypothetical. ----
    next.reportKind = "what_if";

    // ---- 2. Flip matching courseHistory rows to a withdrawal grade. ----
    for (const row of next.courseHistory) {
        if (rowKey(row) === targetId) {
            row.grade = WITHDRAWAL_GRADE;
        }
    }

    // ---- 3. Remove from every leaf's coursesUsed[] + reopen if needed. ----
    const editLeaf = (leaf: DPRRequirement): void => {
        const before = leaf.coursesUsed.length;
        leaf.coursesUsed = leaf.coursesUsed.filter(
            (cu) => rowKey(cu) !== targetId,
        );
        const removed = before - leaf.coursesUsed.length;
        if (removed === 0) return;

        // Only a "courses"/"units" counter has a `used`/`required` to
        // drop. A "gpa" counter has no `required` shortfall semantics
        // here. A leaf used by MULTIPLE courses stays satisfied unless
        // removing THIS one pulls `used` below `required`.
        const counter = leaf.counter;
        if (
            counter &&
            (counter.kind === "courses" || counter.kind === "units")
        ) {
            const used = counter.used - removed;
            counter.used = used;
            counter.needed = Math.max(0, counter.required - used);
            if (used < counter.required) {
                leaf.status = "not_satisfied";
            }
        } else {
            // No droppable counter: still flip to not_satisfied, since a
            // course that satisfied this leaf is now gone. Conservative —
            // re-include it as unmet work rather than silently keep it
            // satisfied.
            leaf.status = "not_satisfied";
        }
    };

    const visit = (node: DPRRequirementGroup | DPRRequirement): void => {
        if ("rId" in node) {
            editLeaf(node);
            return;
        }
        for (const child of node.children) visit(child);
    };
    for (const g of next.requirementGroups) visit(g);

    // ---- 4. Validate the synthetic DPR is still schema-valid. ----
    // "W" and "not_satisfied" are valid schema values, so this only
    // fires if the transform produced a malformed shape — fail loudly
    // rather than ship a broken synthetic DPR. parse() also returns a
    // fresh validated object, preserving purity.
    return degreeProgressReportSchema.parse(next);
}
