// ============================================================
// get_academic_standing (Phase 7-A P-3 / §7.1)
// ============================================================
// Returns the student's current academic-standing snapshot:
//   - cumulative GPA + semester GPAs
//   - SAP / probation / dismissal level (per-school thresholds)
//   - whether the student is at risk of failing the school's tiered
//     GPA floor (when present)
//
// Wraps the existing `calculateStanding` engine helper. Per §7.1 +
// Appendix A rule #5 ("Before discussing CREDIT COUNTS, GPA, …,
// call at minimum: get_academic_standing → get_credit_caps"), this
// is the canonical first call for any GPA / progress / standing
// query. The agent's system prompt routes those questions here.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { calculateStanding } from "../../audit/academicStanding.js";

export const getAcademicStandingTool = buildTool({
    name: "get_academic_standing",
    description:
        "Returns the student's cumulative GPA, per-semester GPAs, " +
        "and SAP/probation/dismissal standing level per the home " +
        "school's thresholds. Call this BEFORE answering ANY question " +
        "about GPA, academic progress, probation, or risk-of-dismissal. " +
        "Read-only.",
    inputSchema: z.object({}),
    isReadOnly: true,
    maxResultChars: 1500,
    async validateInput(_input, { session }) {
        if (!session.student) return { ok: false, userMessage: "No student profile loaded." };
        return { ok: true };
    },
    prompt: () =>
        `Compute the student's academic standing from their courses + ` +
        `the home-school's GPA thresholds. Returns cumulative GPA, ` +
        `standing level, and per-semester GPAs.`,
    async call(_input, { session }) {
        const student = session.student!;
        const declaredCount = student.declaredPrograms.length;
        const standing = calculateStanding(
            student.coursesTaken,
            declaredCount,
            session.schoolConfig ?? null,
        );
        return {
            cumulativeGPA: standing.cumulativeGPA,
            level: standing.level,
            inGoodStanding: standing.inGoodStanding,
            semesterGPA: standing.semesterGPA ?? null,
            completionRate: standing.completionRate,
            message: standing.message,
            warnings: standing.warnings,
            schoolFloor: session.schoolConfig?.overallGpaMin ?? null,
        };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(`STANDING: ${out.level} (cumulative GPA ${out.cumulativeGPA.toFixed(2)})`);
        lines.push(`In good standing: ${out.inGoodStanding}`);
        if (out.semesterGPA !== null) {
            lines.push(`Most recent semester GPA: ${out.semesterGPA.toFixed(2)}`);
        }
        lines.push(`Credit completion rate: ${(out.completionRate * 100).toFixed(0)}%`);
        if (out.schoolFloor !== null) lines.push(`School minimum GPA floor: ${out.schoolFloor}`);
        lines.push(`Summary: ${out.message}`);
        if (out.warnings.length > 0) {
            lines.push(`Warnings:`);
            for (const w of out.warnings) lines.push(`  - ${w}`);
        }
        return lines.join("\n");
    },
});
