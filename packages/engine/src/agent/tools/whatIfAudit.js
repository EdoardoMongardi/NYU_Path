// ============================================================
// what_if_audit (Phase 5 §7.2)
// ============================================================
import { z } from "zod";
import { buildTool } from "../tool.js";
import { whatIfAudit } from "../../audit/whatIfAudit.js";
export const whatIfAuditTool = buildTool({
    name: "what_if_audit",
    description: "Runs a hypothetical audit with a different set of declared programs " +
        "(read-only — does NOT modify the student's profile). Optionally " +
        "compares to current declarations. Use for 'what if I switched to X', " +
        "'compare X vs Y', 'should I add a minor in Z'.",
    inputSchema: z.object({
        hypotheticalPrograms: z.array(z.string())
            .describe("Program ids to hypothetically declare, e.g., ['cas_econ_ba', 'cas_math_minor']."),
        compareWithCurrent: z.boolean().default(true)
            .describe("If true, also runs the current declarations and produces a diff."),
    }),
    maxResultChars: 3000,
    async validateInput(input, { session }) {
        if (!session.student)
            return { ok: false, userMessage: "I need your transcript / profile first." };
        if (input.hypotheticalPrograms.length === 0) {
            return { ok: false, userMessage: "hypotheticalPrograms must be non-empty." };
        }
        for (const id of input.hypotheticalPrograms) {
            if (!session.programs?.has(id)) {
                return {
                    ok: false,
                    userMessage: `Program '${id}' isn't in the catalog. Try search_policy or check the bulletin.`,
                };
            }
        }
        return { ok: true };
    },
    prompt: () => `Run a hypothetical audit. Required: hypotheticalPrograms (array of program ids). ` +
        `Optional: compareWithCurrent (default true). Read-only — never modifies the profile.`,
    async call(input, { session }) {
        return whatIfAudit(session.student, input.hypotheticalPrograms, session.programs, session.courses, session.schoolConfig ?? null, input.compareWithCurrent ?? true);
    },
    summarizeResult(result) {
        const lines = [];
        lines.push(`WHAT-IF: ${result.hypothetical.programs.length} program(s) hypothetically declared`);
        for (const entry of result.hypothetical.programs) {
            const a = entry.audit;
            const unmetCount = a.rules.filter((r) => r.status !== "satisfied").length;
            lines.push(`  ${entry.declaration.programType.toUpperCase()} ${a.programName} — ${unmetCount} unmet rules, ${a.totalCreditsCompleted}/${a.totalCreditsRequired} credits`);
        }
        if (result.comparison) {
            const c = result.comparison;
            lines.push(`Comparison to current:`);
            lines.push(`  Courses transferable to hypothetical: ${c.coursesTransferred}`);
            lines.push(`  Net additional requirements remaining: ${c.additionalRequirementsRemaining}`);
            if (c.droppedPrograms.length > 0)
                lines.push(`  Dropped: ${c.droppedPrograms.join(", ")}`);
            if (c.addedPrograms.length > 0)
                lines.push(`  Added: ${c.addedPrograms.join(", ")}`);
        }
        if (result.warnings.length > 0) {
            lines.push(`Warnings: ${result.warnings.slice(0, 3).join(" | ")}`);
        }
        return lines.join("\n");
    },
});
//# sourceMappingURL=whatIfAudit.js.map