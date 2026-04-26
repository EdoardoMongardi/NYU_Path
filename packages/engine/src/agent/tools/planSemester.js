// ============================================================
// plan_semester (Phase 5 §7.2)
// ============================================================
import { z } from "zod";
import { buildTool } from "../tool.js";
import { planNextSemester } from "../../planner/semesterPlanner.js";
export const planSemesterTool = buildTool({
    name: "plan_semester",
    description: "Recommends courses for a target semester based on the student's audit, " +
        "prereq graph, and grade history. Returns ranked suggestions with " +
        "rationale, graduation risks, and enrollment warnings. Use for any " +
        "'what should I take next semester' question.",
    inputSchema: z.object({
        targetSemester: z.string().describe("Semester to plan, e.g. '2025-fall'."),
        maxCourses: z.number().int().positive().optional(),
        maxCredits: z.number().positive().optional(),
        programId: z.string().optional()
            .describe("Optional: plan against a specific declared program."),
    }),
    maxResultChars: 3000,
    async validateInput(input, { session }) {
        if (!session.student)
            return { ok: false, userMessage: "I need your transcript first." };
        if (!session.courses || !session.prereqs || !session.programs) {
            return { ok: false, userMessage: "Required engine data not loaded." };
        }
        const declared = session.student.declaredPrograms;
        if (declared.length === 0 && !input.programId) {
            return {
                ok: false,
                userMessage: "You haven't declared a program. Either declare one first or pass an explicit programId.",
            };
        }
        return { ok: true };
    },
    prompt: () => `Recommend courses for one upcoming semester. Required input: targetSemester ` +
        `(e.g., "2025-fall"). Optional: maxCourses (default 5), maxCredits (default 18), programId.`,
    async call(input, { session }) {
        const student = session.student;
        const programId = input.programId ?? student.declaredPrograms[0].programId;
        const program = session.programs.get(programId);
        if (!program) {
            throw new Error(`plan_semester: program "${programId}" not found in catalog.`);
        }
        return planNextSemester(student, program, session.courses, session.prereqs, {
            targetSemester: input.targetSemester,
            maxCourses: input.maxCourses ?? 5,
            maxCredits: input.maxCredits ?? 18,
        });
    },
    summarizeResult(plan) {
        const lines = [];
        lines.push(`PLAN for ${plan.targetSemester} — ${plan.suggestions.length} suggestion(s), ${plan.plannedCredits} credits planned, ~${plan.estimatedSemestersLeft} semester(s) left to graduation`);
        for (const s of plan.suggestions.slice(0, 8)) {
            lines.push(`  ${s.courseId} (${s.credits}cr) priority=${s.priority}: ${s.reason}`);
        }
        if (plan.risks.length > 0) {
            lines.push(`Risks: ${plan.risks.map((r) => `[${r.level}] ${r.message}`).slice(0, 3).join(" | ")}`);
        }
        if (plan.enrollmentWarnings.length > 0) {
            lines.push(`Enrollment warnings: ${plan.enrollmentWarnings.slice(0, 3).join(" | ")}`);
        }
        return lines.join("\n");
    },
});
//# sourceMappingURL=planSemester.js.map