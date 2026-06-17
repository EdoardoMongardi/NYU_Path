// ============================================================
// transformUtils — shared helpers for the synthetic-DPR what-if transforms
// ============================================================
// The fail / withdraw / pass-fail transforms
// (failCourseTransform.ts, withdrawTransform.ts, passFailTransform.ts)
// all walk the requirement tree and need to match a `courseId` against
// a courseHistory / coursesUsed row under the SAME keying buildSolverInput
// uses. That keying was originally duplicated verbatim across the
// transforms; a prior review flagged the duplication, so the single
// definition lives here.
//
// Keep this module to GENUINELY-shared, already-duplicated helpers only —
// do not over-extract transform-specific logic (counter/status reopen
// semantics differ subtly between the transforms and stay local).
//
// PURE: no I/O, no module state.
// ============================================================

import { canonicalizeCourseId } from "../../courseId.js";

/**
 * The canonical course-id key for a course row, matching buildSolverInput's
 * `${row.subject} ${row.catalogNbr}` keying (buildSolverInput.ts:198), run
 * through `canonicalizeCourseId` so the zero-padded form (`CSCI-UA 0101`)
 * and the unpadded form (`CSCI-UA 101`) collapse to the same id.
 */
export function rowKey(row: { subject: string; catalogNbr: string }): string {
    return canonicalizeCourseId(`${row.subject} ${row.catalogNbr}`);
}
