// ============================================================
// Exploratory Planner (Phase 3 §12.6 row 3)
// ============================================================
// "Undeclared student gets Core-first plan." For students with no
// declared major, the engine should still recommend a productive
// next semester — typically the school's shared core curriculum
// (`SchoolConfig.sharedPrograms`) since those courses count toward
// any eventual major.
//
// This module is a thin wrapper over `planNextSemester`: when the
// student's declaredPrograms is empty, it audits against the school's
// shared core program and surfaces the resulting suggestions with a
// `mode: "exploratory"` annotation so the chat layer can render an
// appropriate caveat.
// ============================================================

import type {
    Course,
    PlannerConfig,
    Prerequisite,
    Program,
    SchoolConfig,
    SemesterPlan,
    StudentProfile,
} from "@nyupath/shared";
import { planNextSemester } from "./semesterPlanner.js";

export interface ExploratoryPlanResult {
    /** The plan the engine produced under exploratory mode */
    plan: SemesterPlan;
    /** Human-readable basis for the mode (e.g., "no declaredPrograms; using cas_core") */
    basis: string;
    /** Program id that was used as the audit target */
    auditedProgramId: string;
    /** Notes the chat layer should surface to the student */
    notes: string[];
}

/**
 * Run an exploratory plan for an undeclared student. Returns an explicit
 * `unsupported` result when the school config doesn't expose a sharedPrograms
 * pointer — never fabricates a program.
 */
export function planExploratory(
    student: StudentProfile,
    courses: Course[],
    prereqs: Prerequisite[],
    config: PlannerConfig,
    schoolConfig: SchoolConfig | null,
    programs: Map<string, Program>,
): ExploratoryPlanResult | { kind: "unsupported"; reason: string } {
    if (student.declaredPrograms.length > 0) {
        return {
            kind: "unsupported",
            reason:
                `Exploratory mode is for undeclared students. ` +
                `${student.id} has ${student.declaredPrograms.length} declared program(s); ` +
                `use planNextSemester directly.`,
        };
    }

    const sharedProgramIds = schoolConfig?.sharedPrograms ?? [];
    if (sharedProgramIds.length === 0) {
        return {
            kind: "unsupported",
            reason:
                `Exploratory mode requires SchoolConfig.sharedPrograms (e.g., "cas_core"). ` +
                `${schoolConfig?.schoolId ?? "unknown school"} does not declare shared programs.`,
        };
    }

    // Use the first shared program (typically the school's core curriculum).
    // CAS bulletin: cas_core. Stern: stern_business_core (out of scope at v1).
    const targetProgramId = sharedProgramIds[0]!;
    const target = programs.get(targetProgramId);
    if (!target) {
        return {
            kind: "unsupported",
            reason:
                `SchoolConfig.sharedPrograms[0] "${targetProgramId}" is not in the resolved ` +
                `programs catalog. Caller must load it before invoking planExploratory.`,
        };
    }

    const plan = planNextSemester(student, target, courses, prereqs, config);

    // Re-tag suggestions: in exploratory mode, every "required" suggestion
    // is required for the SHARED CORE, not for any specific major. Prefix
    // the reason with that context so the chat layer can render correctly.
    for (const s of plan.suggestions) {
        if (!s.reason.startsWith("[exploratory")) {
            s.reason = `[exploratory mode — toward ${target.name}] ${s.reason}`;
        }
    }

    return {
        plan,
        basis: `Student has no declaredPrograms; audit run against shared core "${target.name}" (${target.programId}).`,
        auditedProgramId: target.programId,
        notes: [
            `Exploratory mode in use because no major has been declared.`,
            `Suggested courses count toward the ${schoolConfig?.name ?? "school"} core curriculum, ` +
            `which applies to every major in this school.`,
            `Once you declare a major, re-run the planner for major-specific recommendations.`,
        ],
    };
}
