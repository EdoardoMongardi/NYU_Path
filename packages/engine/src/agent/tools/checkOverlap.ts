// ============================================================
// check_overlap (Phase 7-A P-3 / §7.1 + Appendix A rule #4)
// ============================================================
// "For double-major/minor questions, ALWAYS call check_overlap."
//
// Wraps `crossProgramAudit` and surfaces the sharedCourses list +
// any double-counting warnings. The agent's system prompt routes
// double-major / minor / cross-program queries here per Appendix A
// rule #4.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { crossProgramAudit } from "../../audit/crossProgramAudit.js";

export const checkOverlapTool = buildTool({
    name: "check_overlap",
    description:
        "Detects courses that satisfy MULTIPLE declared programs (e.g., " +
        "a CS major + Math minor double-count). Returns the shared-courses " +
        "list, double-counting warnings (per the home school's policy), and " +
        "the per-program audit summaries. CALL THIS for any double-major / " +
        "minor / cross-program question per Appendix A rule #4.",
    inputSchema: z.object({}),
    isReadOnly: true,
    maxResultChars: 2000,
    async validateInput(_input, { session }) {
        if (!session.student) return { ok: false, userMessage: "No student profile loaded." };
        if (!session.programs || session.programs.size === 0) {
            return { ok: false, userMessage: "Programs catalog not loaded." };
        }
        if (!session.courses || session.courses.length === 0) {
            return { ok: false, userMessage: "Courses catalog not loaded." };
        }
        return { ok: true };
    },
    prompt: () =>
        `Compute cross-program course overlaps. Returns sharedCourses ` +
        `(courseId → programIds) plus double-counting warnings per the ` +
        `home-school doubleCounting policy. Read-only.`,
    async call(_input, { session }) {
        const result = crossProgramAudit(
            session.student!,
            session.programs!,
            session.courses!,
            session.schoolConfig ?? null,
        );
        return {
            declaredPrograms: result.programs.map((e) => ({
                programId: e.declaration.programId,
                programType: e.declaration.programType,
                programName: e.program.name,
                overallStatus: e.audit.overallStatus,
                totalCreditsCompleted: e.audit.totalCreditsCompleted,
                totalCreditsRequired: e.audit.totalCreditsRequired,
            })),
            sharedCourses: result.sharedCourses,
            doubleCountWarnings: result.warnings,
        };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(`PROGRAMS DECLARED: ${out.declaredPrograms.length}`);
        for (const p of out.declaredPrograms) {
            const remaining = Math.max(0, p.totalCreditsRequired - p.totalCreditsCompleted);
            lines.push(`  ${p.programId} (${p.programType}): ${p.overallStatus} — ${remaining} of ${p.totalCreditsRequired} credits remaining`);
        }
        if (out.sharedCourses.length === 0) {
            lines.push(`No course is shared across programs.`);
        } else {
            lines.push(`Shared courses (count toward >1 program):`);
            for (const sc of out.sharedCourses) {
                lines.push(`  ${sc.courseId} → ${sc.programIds.join(" + ")}`);
            }
        }
        if (out.doubleCountWarnings.length > 0) {
            lines.push(`Double-count warnings:`);
            for (const w of out.doubleCountWarnings) {
                lines.push(`  [${w.kind}] ${w.courseId} (${w.programIds.join(" + ")}): ${w.message}`);
            }
        }
        return lines.join("\n");
    },
});
