// ============================================================
// check_transfer_eligibility (Phase 5 §7.2)
// ============================================================
import { z } from "zod";
import { buildTool } from "../tool.js";
import { checkTransferEligibility } from "../../audit/checkTransferEligibility.js";

export const checkTransferEligibilityTool = buildTool({
    name: "check_transfer_eligibility",
    description:
        "Checks internal-transfer eligibility from the student's home school to a " +
        "target NYU school. Returns: status (eligible / not_yet_eligible / " +
        "ineligible / unsupported), entry-year prereq checklist, application " +
        "deadline, accepted terms, missing-prereq detail. Use this for " +
        "'how do I transfer to X', 'am I eligible for Stern', etc. " +
        "ALWAYS include the gpaNote in your reply: GPA thresholds for internal " +
        "transfer are not published.",
    inputSchema: z.object({
        targetSchool: z.string().describe("Lowercase school id, e.g. 'stern', 'tandon'."),
    }),
    maxResultChars: 2500,
    async validateInput(input, { session }) {
        if (!session.student) return { ok: false, userMessage: "I need your transcript / profile first." };
        if (session.student.homeSchool === input.targetSchool) {
            return {
                ok: false,
                userMessage: `You're already in ${input.targetSchool}. Did you mean to change major within your current school?`,
            };
        }
        return { ok: true };
    },
    prompt: () =>
        `Check eligibility for internal transfer to a target NYU school. ` +
        `Required input: targetSchool (lowercase id). Returns deadline, prereq ` +
        `status, missing-prereq list, and the standard 'GPA not published' note.`,
    async call(input, { session }) {
        return checkTransferEligibility(session.student!, input.targetSchool);
    },
    summarizeResult(decision) {
        if (decision.status === "unsupported") {
            return `TRANSFER UNSUPPORTED: ${decision.reason} | Contact: ${decision.contact}`;
        }
        if (decision.status === "ineligible") {
            const after = decision.canApplyAfter ? ` (after: ${decision.canApplyAfter})` : "";
            return `TRANSFER INELIGIBLE: ${decision.reason}${after}`;
        }
        const lines: string[] = [];
        lines.push(`TRANSFER ${decision.status.toUpperCase()} (entry: ${decision.entryYear})`);
        lines.push(`Deadline: ${decision.deadline} | Accepted terms: ${decision.acceptedTerms.join(", ")}`);
        for (const p of decision.prereqStatus) {
            lines.push(`  ${p.satisfied ? "✓" : "✗"} ${p.category}: ${p.description}${p.satisfied ? ` (via ${p.courseTaken})` : ""}`);
        }
        if (decision.missingPrereqs.length > 0) {
            lines.push(`Missing: ${decision.missingPrereqs.map((m) => m.category).join(", ")}`);
        }
        lines.push(`Note: ${decision.gpaNote}`);
        return lines.join("\n");
    },
});
