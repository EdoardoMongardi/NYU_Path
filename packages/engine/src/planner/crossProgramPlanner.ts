// ============================================================
// Cross-Program Priority Planner (Phase 3 §12.6 row 3)
// ============================================================
// "Multi-program planner test ... cross-program priority scoring."
//
// For a student declaring multiple programs (major + minor, two majors,
// etc.), this planner:
//   1. Runs `crossProgramAudit` to identify shared courses + warnings
//   2. Runs `planNextSemester` against each declared program
//   3. Merges the per-program suggestion lists with priority boosts:
//        - A course that satisfies rules in 2+ programs gets a "shared
//          course" boost (highest priority — efficient credit use)
//        - A course whose double-counting would EXCEED the school's
//          double-count limit gets a deprioritization (already at the
//          shared-cap; taking more shared courses is wasted credits)
// ============================================================

import type {
    Course,
    CourseSuggestion,
    PlannerConfig,
    Prerequisite,
    Program,
    SchoolConfig,
    SemesterPlan,
    StudentProfile,
} from "@nyupath/shared";
import { planNextSemester } from "./semesterPlanner.js";
import {
    crossProgramAudit,
    type CrossProgramAuditResult,
} from "../audit/crossProgramAudit.js";

export interface CrossProgramPlanResult {
    /** Per-program plans in declaration order */
    perProgram: Array<{ programId: string; plan: SemesterPlan }>;
    /** Merged suggestions across all programs, deduped + priority-resorted */
    merged: CourseSuggestion[];
    /** Shared-course audit produced alongside */
    audit: CrossProgramAuditResult;
    /** Notes accumulated across the merge */
    notes: string[];
}

/** Score boost (added to suggestion.priority) when a course satisfies
 *  rules in 2+ declared programs. Magnitude chosen so it dominates
 *  ordinary major-only suggestions but doesn't override a "blocks-many"
 *  required course in a single program. */
const SHARED_COURSE_BOOST = 30;

/** Penalty applied when adding this course would push the student PAST
 *  the school's double-counting pair limit. Negative because we want to
 *  push these toward the bottom of the merged list. */
const OVER_LIMIT_PENALTY = -40;

export function planMultiProgram(
    student: StudentProfile,
    programs: Map<string, Program>,
    courses: Course[],
    prereqs: Prerequisite[],
    config: PlannerConfig,
    schoolConfig: SchoolConfig | null = null,
): CrossProgramPlanResult {
    const audit = crossProgramAudit(student, programs, courses, schoolConfig);
    const perProgram: CrossProgramPlanResult["perProgram"] = [];
    const notes: string[] = [];

    for (const decl of student.declaredPrograms) {
        const program = programs.get(decl.programId);
        if (!program) {
            notes.push(`Skipped unknown programId "${decl.programId}".`);
            continue;
        }
        const plan = planNextSemester(student, program, courses, prereqs, config);
        perProgram.push({ programId: decl.programId, plan });
    }

    // Merge suggestions: collect by courseId, sum the satisfiesRules counts
    // (a course satisfying rules in 2 programs lists rules from both).
    const merged = new Map<string, CourseSuggestion & { _programs: Set<string> }>();
    for (const { programId, plan } of perProgram) {
        for (const s of plan.suggestions) {
            const existing = merged.get(s.courseId);
            if (!existing) {
                merged.set(s.courseId, {
                    ...s,
                    _programs: new Set([programId]),
                });
            } else {
                existing._programs.add(programId);
                // Combine satisfiesRules so the chat layer can render a
                // course that helps both programs as such.
                for (const r of s.satisfiesRules) {
                    if (!existing.satisfiesRules.includes(r)) {
                        existing.satisfiesRules.push(r);
                    }
                }
            }
        }
    }

    // Apply boosts/penalties
    const sharedCourseIds = new Set(audit.sharedCourses.map((sc) => sc.courseId));
    const overflowIds = new Set(
        audit.warnings
            .filter((w) => w.kind === "exceeds_pair_limit")
            .map((w) => w.courseId),
    );

    const result: CourseSuggestion[] = [];
    for (const [courseId, sug] of merged) {
        let priority = sug.priority;
        const programsCount = sug._programs.size;
        if (programsCount >= 2) {
            priority += SHARED_COURSE_BOOST;
            sug.reason =
                `[shared across ${programsCount} programs: ${[...sug._programs].join(", ")}] ` + sug.reason;
        }
        if (overflowIds.has(courseId)) {
            priority += OVER_LIMIT_PENALTY;
            sug.reason =
                `[would exceed school double-count limit] ` + sug.reason;
        } else if (sharedCourseIds.has(courseId) && programsCount < 2) {
            // Already a shared course in the audit (e.g., from completed
            // coursework) but only one program currently lists it as a
            // suggestion. This is a planning hint, not a boost.
            sug.reason = `[helps multiple programs] ` + sug.reason;
        }
        // Strip the internal `_programs` Set before emitting — it would
        // serialize to `{}` in JSON and confuse downstream consumers.
        const { _programs, ...clean } = sug;
        result.push({ ...clean, priority });
    }

    result.sort((a, b) => b.priority - a.priority);

    if (audit.warnings.length > 0) {
        notes.push(
            `${audit.warnings.length} double-counting warning(s) from cross-program audit. ` +
            `Suggestions for over-limit courses are deprioritized.`,
        );
    }
    notes.push(`${audit.sharedCourses.length} course(s) shared across declared programs.`);

    return { perProgram, merged: result, audit, notes };
}
