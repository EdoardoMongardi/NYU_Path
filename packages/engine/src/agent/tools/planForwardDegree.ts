/**
 * Phase 13 Task 6 — plan_forward_degree tool.
 *
 * Invokes buildForwardSchedule and writes the result to the correct
 * session slot per Decision #32 state-routing:
 *   valid-clean / valid-with-trade-offs → session.forwardSchedule
 *   infeasible-draft                    → session.studentDraftPlan
 *
 * Returns the schedule + a brief human-readable summary.
 */

import { z } from "zod";
import { buildTool } from "../tool.js";
import { buildForwardSchedule } from "../forwardSchedule/build.js";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface PlanForwardDegreeOutput {
    schedule: ForwardSchedule;
    /** Where the schedule was stored in session. */
    storedIn: "forwardSchedule" | "studentDraftPlan";
    /** Brief human-readable summary for the agent. */
    summary: string;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const planForwardDegreeTool = buildTool({
    name: "plan_forward_degree",
    description:
        "Builds a multi-semester forward degree plan for the student based on their " +
        "current Degree Progress Report (DPR). Uses a greedy scheduling solver to " +
        "place unmet requirements across remaining semesters up to the target graduation term.\n\n" +
        "Use this for:\n" +
        "  • 'Show me my full degree plan'\n" +
        "  • 'When can I graduate if I take X credits per semester?'\n" +
        "  • 'Map out the rest of my degree'\n\n" +
        "Requires session.degreeProgressReport to be set (upload your DPR first).\n\n" +
        "Decision #32: plans whose solver state is 'infeasible-draft' are stored " +
        "separately (session.studentDraftPlan) so the agent never endorses an " +
        "infeasible plan as official. The summary will clearly label which slot " +
        "was used.\n\n" +
        "After calling this tool, use `view_forward_plan` to retrieve the stored plan.",
    inputSchema: z.object({
        graduationTermOverride: z.string().optional()
            .describe(
                "Optional target graduation term, e.g. '2027-spring'. " +
                "When omitted the orchestrator infers it from credits remaining " +
                "and the default 16-credit-per-semester target.",
            ),
    }),
    isReadOnly: false,
    maxResultChars: 4000,
    async validateInput(_input, { session }) {
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "I need your Degree Progress Report (DPR) before I can build a forward plan. " +
                    "Please upload your DPR and try again.",
            };
        }
        if (!session.student) {
            return {
                ok: false,
                userMessage:
                    "Student profile not loaded. Cannot build a forward plan without profile data.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Build a complete multi-semester forward degree plan. Requires the student's DPR to be loaded. " +
        "Call this when the student wants to see their full degree roadmap from now to graduation. " +
        "Plans are stored as session.forwardSchedule (valid) or session.studentDraftPlan (infeasible). " +
        "After calling, use view_forward_plan to read the result.",
    async call(input, { session }): Promise<PlanForwardDegreeOutput> {
        const dpr = session.degreeProgressReport!;

        const schedule = buildForwardSchedule({
            session,
            dpr,
            graduationTermOverride: input.graduationTermOverride,
        });

        // Decision #32 state-routing
        const isDraft =
            schedule.state === "infeasible-draft" ||
            schedule.state === "student-preferred-invalid-draft";

        let storedIn: PlanForwardDegreeOutput["storedIn"];
        if (isDraft) {
            session.studentDraftPlan = schedule;
            storedIn = "studentDraftPlan";
        } else {
            session.forwardSchedule = schedule;
            storedIn = "forwardSchedule";
        }

        const summary = buildSummary(schedule, storedIn);
        return { schedule, storedIn, summary };
    },
    summarizeResult(output) {
        return output.summary;
    },
});

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(schedule: ForwardSchedule, storedIn: "forwardSchedule" | "studentDraftPlan"): string {
    const lines: string[] = [];

    const stateLabel =
        schedule.state === "valid-clean" ? "VALID (no caveats)" :
        schedule.state === "valid-with-trade-offs" ? "VALID with trade-offs (see assumptions)" :
        schedule.state === "infeasible-draft" ? "INFEASIBLE DRAFT (see feasibility report)" :
        "STUDENT-PREFERRED DRAFT (invalid — not endorsed)";

    lines.push(`FORWARD DEGREE PLAN — ${stateLabel}`);
    lines.push(`Stored in: session.${storedIn}`);
    lines.push(`Graduation target: ${schedule.graduationTerm}`);
    lines.push(`Balance score: ${schedule.balanceScore.toFixed(2)} (lower = better)`);
    lines.push(`Degree credits met: ${schedule.degreeCreditsMet ? "yes" : "no (plan does not reach minimum)"}`);
    lines.push(`Semesters planned: ${schedule.semesters.length}`);
    lines.push("");

    for (const sem of schedule.semesters) {
        const slotSummaries = sem.slots.map(s => {
            if (s.kind === "specific_planned") return `${s.courseId} (${s.credits}cr)`;
            if (s.kind === "placeholder") return `[placeholder: ${s.category}] (${s.credits}cr)`;
            if (s.kind === "completed") return `${s.courseId} ✓`;
            if (s.kind === "in_progress") return `${s.courseId} (IP)`;
            return "(unknown)";
        }).join(", ");
        lines.push(`  ${sem.term}: ${sem.plannedCredits}cr — ${slotSummaries}`);
        if (sem.notes.length > 0) {
            lines.push(`    Notes: ${sem.notes.join("; ")}`);
        }
    }

    if (schedule.assumptions.length > 0) {
        lines.push("");
        lines.push(`Assumptions (${schedule.assumptions.length}):`);
        for (const a of schedule.assumptions.slice(0, 5)) {
            if (a.type === "IP_COURSE_COMPLETION") {
                lines.push(`  [IP] ${a.courseId}: ${a.consequenceIfFalse}`);
            }
        }
        if (schedule.assumptions.length > 5) {
            lines.push(`  ... and ${schedule.assumptions.length - 5} more`);
        }
    }

    if (!schedule.feasibility.feasible && schedule.feasibility.infeasibilityReason) {
        lines.push("");
        lines.push(`Infeasibility: ${schedule.feasibility.infeasibilityReason}`);
    }

    return lines.join("\n");
}
