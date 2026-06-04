// ============================================================
// what_if_audit — hypothetical PROGRAM change (pure-RAG estimate)
// ============================================================
// Scope: hypothetical PROGRAM changes — declaring a different major,
// adding a minor, a second major. There is never a DPR for a
// hypothetical program, so this tool NEVER claims a deterministic
// audit. It returns a structured, confidence-disclaimed ESTIMATE and
// points the student at `search_policy` (the program's bulletin
// requirements) + their adviser. NYU only produces an audit-grade
// verdict by recomputing the student's DPR for the new program.
//
// Course-level "what if I take A instead of B" is a DIFFERENT question
// — it runs the forward-schedule solver via `propose_plan_change` /
// `simulate_alternatives` against the student's plan, not this tool.
//
// The authored deterministic path (the `whatIfAudit()` rule engine over
// programs.json) was removed in the rule-engine decommission: the
// 1-program authored stub could only ever audit a single hypothetical,
// and the DPR-first design relies on the student's real audit + bulletin
// RAG instead.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";

interface UnauthoredProgramEstimate {
    kind: "unauthored_program_estimate";
    requestedProgramIds: string[];
    /** Verbatim disclaimer the validator's verbatim_drift check
     *  enforces in the LLM's reply. */
    disclaimer: string;
    /** What the student CAN learn from the DPR + RAG corpus, even
     *  without an audit-grade verdict for the hypothetical. */
    guidance: string;
}

const DISCLAIMER =
    "This estimate is based on AI-extracted requirements from NYU's bulletin. " +
    "Verify with an academic adviser before applying for an internal transfer or program change.";

export const whatIfAuditTool = buildTool({
    name: "what_if_audit",
    description:
        "Estimates the impact of a hypothetical PROGRAM change — declaring a " +
        "different major, adding a minor, or a second major (read-only — does " +
        "NOT modify the profile). Returns a structured estimate with a " +
        "non-removable disclaimer pointing at the bulletin (search_policy) + an " +
        "adviser; NYU only produces an audit-grade verdict by recomputing the " +
        "DPR for the new program, so this is always an estimate. Use for 'what " +
        "if I switched to X', 'should I add a minor in Z'. For course-level " +
        "'what if I take A instead of B', use propose_plan_change / " +
        "simulate_alternatives (they run the schedule solver) instead.",
    inputSchema: z.object({
        hypotheticalPrograms: z.array(z.string())
            .describe("Program ids to hypothetically declare, e.g., ['economics_ba', 'mathematics_minor']."),
        compareWithCurrent: z.boolean().default(true)
            .describe("Retained for compatibility; the estimate is always framed against the student's current DPR."),
    }),
    maxResultChars: 3000,
    // semi_hardened: the disclaimer must appear verbatim in the reply.
    outputMode: "semi_hardened",
    async validateInput(input, { session }) {
        // DPR-only: the estimate is framed against the student's real
        // coursework, which comes from the DPR. Refuse without it.
        if (!session.degreeProgressReport || !session.student) {
            return {
                ok: false,
                userMessage:
                    "I need your Albert Degree Progress Report (DPR) to frame a what-if comparison. " +
                    "Please upload your DPR and try again.",
            };
        }
        if (input.hypotheticalPrograms.length === 0) {
            return { ok: false, userMessage: "hypotheticalPrograms must be non-empty." };
        }
        return { ok: true };
    },
    prompt: () =>
        `Estimate the impact of a hypothetical PROGRAM change. Required: hypotheticalPrograms ` +
        `(array of program ids). Returns a confidence-disclaimed estimate (never a deterministic ` +
        `audit — there is no DPR for a hypothetical program) + points at search_policy and an ` +
        `adviser. Read-only; never modifies the profile.`,
    async call(input, { session }): Promise<UnauthoredProgramEstimate> {
        // The student's current state (from the DPR) anchors the estimate;
        // the hypothetical program's requirements come from search_policy
        // (the model fires it next), not from any authored rule set.
        const dpr = session.degreeProgressReport;
        let guidance: string;
        if (dpr) {
            const credits = dpr.cumulative.creditsUsed ?? 0;
            const gpa = dpr.cumulative.cumulativeGpa ?? 0;
            const transfer = dpr.courseHistory.filter((c) => c.type === "TE").length;
            guidance =
                `Your current state from the DPR: ${credits} credits earned, ` +
                `cumulative GPA ${gpa.toFixed(3)}, ${transfer} transfer-credit row(s) recorded. ` +
                `Run search_policy for the hypothetical program's bulletin requirements; ` +
                `cross-reference your earned credits against those requirements; consult an adviser for the official audit.`;
        } else {
            guidance =
                `No DPR loaded — use search_policy to look up the hypothetical program's requirements ` +
                `in the bulletin, and consult an adviser for the official audit.`;
        }

        return {
            kind: "unauthored_program_estimate",
            requestedProgramIds: input.hypotheticalPrograms,
            disclaimer: DISCLAIMER,
            guidance,
        };
    },
    summarizeResult(result) {
        const lines: string[] = [];
        lines.push(`WHAT-IF (estimate — there is no DPR for a hypothetical program)`);
        lines.push(`  Requested program(s): ${result.requestedProgramIds.join(", ")}`);
        lines.push(`  Guidance: ${result.guidance}`);
        // The disclaimer is also returned via extractVerbatim; it's
        // included here so the model sees the exact text it must include.
        lines.push(`  REQUIRED DISCLAIMER (must appear verbatim in your reply): ${result.disclaimer}`);
        return lines.join("\n");
    },
    extractVerbatim(result) {
        return result.disclaimer;
    },
});
