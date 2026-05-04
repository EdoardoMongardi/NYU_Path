/**
 * Phase 14 Task 7 — compare_plan_alternatives tool (isReadOnly: true).
 *
 * Tier B of the 4-tier fallback hierarchy (Decision #42).
 * Reads alternativeCandidates from session.forwardSchedule (populated by Phase 13's
 * solver Stage 7, Decision #44) and returns the candidate metadata for the LLM
 * to reason over in-prompt.
 *
 * This tool is STRICTLY read-only — it MUST NOT mutate session.forwardSchedule
 * or any other session field under any branch. The agent then uses the returned
 * metadata to pick a candidate and route to the confirm_plan_change two-step.
 *
 * The tool DOES NOT make the tier decision itself. It returns the candidates
 * (or a "no alternatives" indicator) and lets the agent route.
 */

import { z } from "zod";
import { buildTool } from "../tool.js";
import type { AlternativePlanSummary } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Default dimensions per spec (Decision #42 Tier B)
// ---------------------------------------------------------------------------

const DEFAULT_DIMENSIONS: string[] = [
    "balanceScore",
    "distinctSubjectsCount",
    "totalPetitionCount",
    "hardCount-evenness",
];

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface ComparePlanAlternativesOutput {
    plansSummarized: AlternativePlanSummary[];
    dimensionsConsidered: string[];
    decisionFraming: string;
}

// ---------------------------------------------------------------------------
// No-alternatives framing literal (spec-exact text)
// ---------------------------------------------------------------------------

const NO_ALTERNATIVES_FRAMING =
    "no alternatives available; route to Tier C clarification or (soft-only) Tier D heuristic mapping";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const comparePlanAlternativesTool = buildTool({
    name: "compare_plan_alternatives",
    description:
        "Compare the alternative-plan candidates attached to the current ForwardSchedule " +
        "(Decision #44, Tier B per Decision #42).\n\n" +
        "When the student states an unmodeled soft preference (e.g. 'I want more subject " +
        "variety', 'I prefer lighter fall semesters'), call this tool to surface the up-to-5 " +
        "solver-generated AlternativePlanSummary entries so you can reason over them in-prompt " +
        "and recommend one to the student.\n\n" +
        "If the session has no alternatives (or the solver didn't emit any), the tool returns " +
        "an empty plansSummarized and a decisionFraming that routes you to Tier C/D.\n\n" +
        "After comparing, use the existing confirm_plan_change two-step to apply the " +
        "student's chosen mutation — this tool does NOT apply any changes.\n\n" +
        "isReadOnly: true — never writes to session state.",
    inputSchema: z.object({
        studentStatedFactor: z
            .string()
            .describe(
                "The student's stated soft preference or factor to compare against " +
                "(e.g. 'lighter workload', 'more subject variety', 'fewer petitions').",
            ),
        dimensions: z
            .array(z.string())
            .optional()
            .describe(
                "Which metadata axes to surface in the comparison. " +
                "Defaults to [balanceScore, distinctSubjectsCount, totalPetitionCount, hardCount-evenness]. " +
                "The tool echoes these in dimensionsConsidered for the LLM's reasoning.",
            ),
    }),
    isReadOnly: true,
    maxResultChars: 4000,
    prompt: () =>
        "Compare solver-generated alternative plan candidates (Tier B, Decision #42). " +
        "Returns plansSummarized + dimensionsConsidered for in-prompt reasoning. " +
        "If no candidates, returns no-alternatives framing to route to Tier C/D.",
    async call(input, { session }): Promise<ComparePlanAlternativesOutput> {
        const candidates = session.forwardSchedule?.alternativeCandidates;

        // No alternatives: absent or empty
        if (!candidates || candidates.length === 0) {
            return {
                plansSummarized: [],
                dimensionsConsidered: [],
                decisionFraming: NO_ALTERNATIVES_FRAMING,
            };
        }

        // Resolve dimensions: use provided array if defined, else default set.
        const dimensionsConsidered: string[] =
            input.dimensions !== undefined ? input.dimensions : DEFAULT_DIMENSIONS;

        return {
            plansSummarized: candidates,
            dimensionsConsidered,
            decisionFraming: "Tier B per Decision #42",
        };
    },
    summarizeResult(output) {
        if (output.plansSummarized.length === 0) {
            return `COMPARE PLAN ALTERNATIVES — ${output.decisionFraming}`;
        }
        const lines: string[] = [
            `COMPARE PLAN ALTERNATIVES — ${output.plansSummarized.length} candidate(s) (${output.decisionFraming})`,
        ];
        if (output.dimensionsConsidered.length > 0) {
            lines.push(`Dimensions: ${output.dimensionsConsidered.join(", ")}`);
        }
        for (const c of output.plansSummarized) {
            lines.push(
                `  [${c.planIndex}] grad=${c.graduationTerm} balance=${c.balanceScore.toFixed(2)} ` +
                `distinctSubjects=${c.distinctSubjectsCount} petitions=${c.totalPetitionCount}`,
            );
        }
        return lines.join("\n");
    },
});
