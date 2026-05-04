/**
 * Phase 14 Task 5 — simulate_alternatives tool (read-only).
 *
 * Wraps simulateAlternatives() from Phase 14 Task 4.
 *
 * When the current plan is already feasible, returns an empty candidates
 * array with a consequence string. Otherwise builds a SolverInput from
 * session + DPR and calls simulateAlternatives().
 *
 * isReadOnly: true — never writes to session state.
 */

import { z } from "zod";
import { buildTool } from "../tool.js";
import { simulateAlternatives as coreSimulateAlternatives } from "../forwardSchedule/alternatives.js";
import { buildSolverInputFromSession } from "../forwardSchedule/planChangeHelpers.js";
import type { AlternativeCandidate } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface SimulateAlternativesOutput {
    candidates: AlternativeCandidate[];
    /** Human-readable notes (e.g. "plan is already feasible"). */
    note?: string;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const simulateAlternativesTool = buildTool({
    name: "simulate_alternatives",
    description:
        "When the current forward plan is infeasible, generate up to 3 alternative " +
        "schedule candidates by progressively relaxing constraints " +
        "(add summer term, add J-term, or extend graduation by one term).\n\n" +
        "Returns an empty list when the current plan is already feasible — " +
        "no alternatives are needed in that case.\n\n" +
        "Use this after plan_forward_degree returns an infeasible-draft plan " +
        "to show the student what options are available.\n\n" +
        "isReadOnly: true — never writes to session state.",
    inputSchema: z.object({}),
    isReadOnly: true,
    maxResultChars: 3000,
    async validateInput(_input, { session }) {
        if (!session.forwardSchedule && !session.studentDraftPlan) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. " +
                    "Call plan_forward_degree first, then simulate alternatives.",
            };
        }
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "No Degree Progress Report loaded. Cannot simulate alternatives without DPR data.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Generate alternative schedule candidates when the primary plan is infeasible. " +
        "Returns an empty list if the plan is already feasible. " +
        "Useful for presenting options to the student when the default graduation term cannot be met.",
    async call(_input, { session }): Promise<SimulateAlternativesOutput> {
        const dpr = session.degreeProgressReport!;

        // Check current plan feasibility.
        const currentPlan = session.forwardSchedule ?? session.studentDraftPlan;
        if (currentPlan && currentPlan.feasibility.feasible === true) {
            return {
                candidates: [],
                note: "Current plan is feasible; no alternatives needed.",
            };
        }

        // Build SolverInput and run the alternatives generator.
        const solverInput = buildSolverInputFromSession(
            session,
            dpr,
            session.schedulePreferences,
        );

        const candidates = coreSimulateAlternatives(solverInput);

        return { candidates };
    },
    summarizeResult(output) {
        if (output.note) {
            return output.note;
        }
        if (output.candidates.length === 0) {
            return "No alternative candidates generated.";
        }
        const lines: string[] = [`ALTERNATIVE CANDIDATES (${output.candidates.length}):`];
        for (const c of output.candidates) {
            const scheduleInfo = c.schedule
                ? `feasible → grad ${c.schedule.graduationTerm}`
                : `still infeasible (${c.stillInfeasibleReason ?? "unknown"})`;
            lines.push(`  [${c.relaxation}] ${c.summary} — ${scheduleInfo}`);
        }
        return lines.join("\n");
    },
});
