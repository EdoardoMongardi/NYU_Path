// ============================================================
// applyFailedCourseToDpr — pure synthetic-DPR transform (D2.1a)
// ============================================================
// Part of the D2.1 counterfactual probe. Models "what if the student
// had FAILED this completed course" by returning a DEEP-COPIED synthetic
// DegreeProgressReport (the input `dpr` is NEVER mutated) in which:
//
//   1. Every `courseHistory` row matching `courseId` has its `grade` set
//      to a clearly-failing "F". This drops it below the pass threshold
//      so buildSolverInput's `coursesTaken` set — which only adds a row
//      when `meetsGradeThreshold(row.grade, "D")` (buildSolverInput.ts
//      lines 197-206) — excludes it on the next solve.
//
//   2. The course is removed from every requirement leaf's `coursesUsed[]`.
//      For any leaf that, after removal, drops below `counter.required`,
//      we flip `status` to "not_satisfied", decrement `counter.used` by the
//      number of rows removed, and recompute `counter.needed = max(0,
//      required - used)`. That makes `notSatisfiedRequirements(...)`
//      RE-INCLUDE the requirement so the planner treats it as unmet work.
//
// COURSE-ID KEYING — must match buildSolverInput exactly. buildSolverInput
// keys a courseHistory row as `${row.subject} ${row.catalogNbr}` (line 198).
// We compare under `canonicalizeCourseId` so the zero-padded form
// (`CSCI-UA 0101`) and the unpadded form (`CSCI-UA 101`) collapse to the
// same id — strictly more consistent than a raw string compare, and it
// matches the prereq/DPR-satisfaction paths that already canonicalize.
//
// PURE: no I/O, no module state. Returns a fresh object via structuredClone.
// If `courseId` matches nothing, returns a structurally-equal deep copy
// (no-op but still a fresh object).
// ============================================================

import { canonicalizeCourseId } from "../../courseId.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
    type DPRRequirement,
    type DPRRequirementGroup,
} from "../../dpr/schema.js";

/** A clearly-FAILING grade: below the "D" pass threshold the solver uses. */
const FAILING_GRADE = "F";

/**
 * The canonical course-id key for a course row, matching buildSolverInput's
 * `${row.subject} ${row.catalogNbr}` keying (buildSolverInput.ts:198), run
 * through `canonicalizeCourseId` so zero-padded / unpadded forms unify.
 */
function rowKey(row: { subject: string; catalogNbr: string }): string {
    return canonicalizeCourseId(`${row.subject} ${row.catalogNbr}`);
}

/**
 * Return a DEEP-COPIED `DegreeProgressReport` in which `courseId` is treated
 * as FAILED: its courseHistory grades become "F" and it is stripped from every
 * requirement leaf's `coursesUsed[]`, reopening any leaf that drops below its
 * required count. The input `dpr` is never mutated.
 */
export function applyFailedCourseToDpr(
    dpr: DegreeProgressReport,
    courseId: string,
): DegreeProgressReport {
    // structuredClone gives us a fully detached copy, so every edit below is
    // local to `next` and the caller's `dpr` is guaranteed untouched.
    const next: DegreeProgressReport = structuredClone(dpr);
    const targetId = canonicalizeCourseId(courseId);

    // ---- 1. Flip matching courseHistory rows to a failing grade. ----
    for (const row of next.courseHistory) {
        if (rowKey(row) === targetId) {
            row.grade = FAILING_GRADE;
        }
    }

    // ---- 2. Remove from every leaf's coursesUsed[] + reopen if needed. ----
    const editLeaf = (leaf: DPRRequirement): void => {
        const before = leaf.coursesUsed.length;
        leaf.coursesUsed = leaf.coursesUsed.filter((cu) => rowKey(cu) !== targetId);
        const removed = before - leaf.coursesUsed.length;
        if (removed === 0) return;

        // Only a "courses"/"units" counter has a `used`/`required` to drop.
        // (A "gpa" counter has no `required` shortfall semantics here.) A leaf
        // used by MULTIPLE courses stays satisfied unless removing THIS one
        // pulls `used` below `required` — so a shared leaf does NOT reopen if
        // it still meets its bar after the removal.
        const counter = leaf.counter;
        if (counter && (counter.kind === "courses" || counter.kind === "units")) {
            const used = counter.used - removed;
            counter.used = used;
            counter.needed = Math.max(0, counter.required - used);
            if (used < counter.required) {
                leaf.status = "not_satisfied";
            }
        } else {
            // No droppable counter: still flip to not_satisfied, since a course
            // that satisfied this leaf is now gone (conservative — re-include it
            // as unmet work rather than silently keep it satisfied).
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

    // ---- 3. Validate the synthetic DPR is still schema-valid. ----
    // A failing grade + not_satisfied status + adjusted counter are all valid
    // values, so this only fires if the transform produced a malformed shape —
    // i.e. fail loudly rather than ship a broken synthetic DPR. parse() also
    // returns a fresh validated object, preserving purity.
    return degreeProgressReportSchema.parse(next);
}
