// ============================================================
// run_full_audit (Phase 5 §7.2)
// ============================================================
import { z } from "zod";
import { buildTool } from "../tool.js";
import { degreeAudit } from "../../audit/degreeAudit.js";
import { calculateStanding } from "../../audit/academicStanding.js";

export const runFullAuditTool = buildTool({
    name: "run_full_audit",
    description:
        "Runs a deterministic degree audit against the student's declared programs. " +
        "Returns rule status, courses satisfying each rule, GPA, credit totals, " +
        "and warnings. Use this for any question about graduation progress, " +
        "remaining requirements, GPA, or credit counts. Per Cardinal Rule §2.1, " +
        "do NOT synthesize numerical claims (GPA, credits, requirement counts) " +
        "without calling this tool.",
    inputSchema: z.object({
        programId: z.string().optional()
            .describe("Optional: limit the audit to a specific program id (e.g., 'cs_major_ba')."),
    }),
    maxResultChars: 3000,
    // Phase 7-B Step 15 — semi_hardened: GPA + cumulative credits are
    // deterministic verdicts the validator must guard against drift.
    outputMode: "semi_hardened",
    async validateInput(_input, { session }) {
        if (!session.student) return { ok: false, userMessage: "I need your transcript / profile loaded before I can run an audit." };
        if (!session.courses || session.courses.length === 0) {
            return { ok: false, userMessage: "Course catalog is not loaded; cannot run audit." };
        }
        if (!session.programs || session.programs.size === 0) {
            return { ok: false, userMessage: "Program data is not loaded; cannot run audit." };
        }
        return { ok: true };
    },
    prompt: () =>
        `Run a degree audit. Returns rules, courses-satisfying, remaining counts, ` +
        `cumulative GPA, total credits completed, and warnings. Optional input ` +
        `'programId' restricts to one program.`,
    async call(input, { session }) {
        const student = session.student!;
        const declared = student.declaredPrograms;
        const targetIds = input.programId ? [input.programId] : declared.map((d) => d.programId);
        const audits = [];
        for (const id of targetIds) {
            const program = session.programs!.get(id);
            if (!program) continue;
            audits.push(degreeAudit(student, program, session.courses!, session.schoolConfig ?? null));
        }
        const standing = calculateStanding(student.coursesTaken, declared.length, session.schoolConfig ?? null);
        return { audits, standing };
    },
    summarizeResult(output) {
        const lines: string[] = [];
        for (const a of output.audits) {
            lines.push(`PROGRAM: ${a.programName} (${a.programId}) — ${a.overallStatus}`);
            lines.push(`  Credits: ${a.totalCreditsCompleted} / ${a.totalCreditsRequired}`);
            const unmet = a.rules.filter((r) => r.status !== "satisfied");
            lines.push(`  Unmet rules: ${unmet.length}`);
            for (const r of unmet.slice(0, 8)) {
                lines.push(`    - ${r.label}: ${r.remaining} remaining`);
            }
            if (a.warnings.length > 0) {
                lines.push(`  Warnings: ${a.warnings.slice(0, 3).join("; ")}`);
            }
        }
        lines.push(`STANDING: ${output.standing.level} (cumulative GPA ${output.standing.cumulativeGPA.toFixed(3)}, completion ${(output.standing.completionRate * 100).toFixed(0)}%)`);
        return lines.join("\n");
    },
    // Phase 7-B Step 15 — verbatim text the LLM must include
    // unchanged. We pin the cumulative GPA verdict (the most common
    // §2.1 violation pattern). Reasonable synthesis around it stays
    // allowed; only this clause must appear unchanged.
    extractVerbatim(output) {
        const gpa = output.standing.cumulativeGPA.toFixed(3);
        return `Cumulative GPA: ${gpa} (computed from your transcript).`;
    },
});
