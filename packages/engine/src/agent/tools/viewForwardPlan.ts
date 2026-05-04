/**
 * Phase 13 Task 6 — view_forward_plan tool.
 *
 * Read-only. Returns session.forwardSchedule when set; falls back to
 * session.studentDraftPlan when forwardSchedule is absent; returns null
 * when neither is set.
 *
 * Does NOT mutate session state. isReadOnly: true.
 */

import { z } from "zod";
import { buildTool } from "../tool.js";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface ViewForwardPlanOutput {
    schedule: ForwardSchedule | null;
    /** Which session slot was read. */
    source: "forwardSchedule" | "studentDraftPlan" | "none";
    summary: string;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const viewForwardPlanTool = buildTool({
    name: "view_forward_plan",
    description:
        "Returns the student's current forward degree plan without recalculating it. " +
        "Reads session.forwardSchedule (valid plans) first, then session.studentDraftPlan " +
        "(infeasible drafts), then returns null if neither is set.\n\n" +
        "Use this for:\n" +
        "  • 'Show me my degree plan'\n" +
        "  • 'What courses do I have planned for spring 2027?'\n" +
        "  • 'When will I graduate according to my plan?'\n\n" +
        "This tool is READ-ONLY — it never modifies session state. " +
        "Call plan_forward_degree to generate or refresh the plan.",
    inputSchema: z.object({}),
    isReadOnly: true,
    maxResultChars: 4000,
    prompt: () =>
        "Return the stored forward degree plan (session.forwardSchedule or session.studentDraftPlan). " +
        "Read-only — does not recalculate. Use plan_forward_degree to generate a new plan.",
    async call(_input, { session }): Promise<ViewForwardPlanOutput> {
        if (session.forwardSchedule) {
            return {
                schedule: session.forwardSchedule,
                source: "forwardSchedule",
                summary: buildSummary(session.forwardSchedule, "forwardSchedule"),
            };
        }
        if (session.studentDraftPlan) {
            return {
                schedule: session.studentDraftPlan,
                source: "studentDraftPlan",
                summary: buildSummary(session.studentDraftPlan, "studentDraftPlan"),
            };
        }
        return {
            schedule: null,
            source: "none",
            summary:
                "No forward degree plan is stored in this session. " +
                "Call plan_forward_degree to generate one.",
        };
    },
    summarizeResult(output) {
        return output.summary;
    },
});

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(
    schedule: ForwardSchedule,
    source: "forwardSchedule" | "studentDraftPlan",
): string {
    const lines: string[] = [];

    const stateLabel =
        schedule.state === "valid-clean" ? "VALID (no caveats)" :
        schedule.state === "valid-with-trade-offs" ? "VALID with trade-offs (see assumptions)" :
        schedule.state === "infeasible-draft" ? "INFEASIBLE DRAFT" :
        "STUDENT-PREFERRED DRAFT";

    const sourceLabel = source === "studentDraftPlan"
        ? " [DRAFT — infeasible plan, not endorsed by the agent]"
        : "";

    lines.push(`FORWARD DEGREE PLAN${sourceLabel} — ${stateLabel}`);
    lines.push(`Graduation target: ${schedule.graduationTerm}`);
    lines.push(`Balance score: ${schedule.balanceScore.toFixed(2)}`);
    lines.push(`Degree credits met: ${schedule.degreeCreditsMet ? "yes" : "no"}`);
    lines.push(`Semesters: ${schedule.semesters.length}`);
    lines.push(`Computed at: ${new Date(schedule.computedAt).toISOString()}`);
    lines.push("");

    for (const sem of schedule.semesters) {
        const slots = sem.slots.map(s => {
            if (s.kind === "specific_planned") return `${s.courseId} (${s.credits}cr)`;
            if (s.kind === "placeholder") return `[placeholder: ${s.category}] (${s.credits}cr)`;
            if (s.kind === "completed") return `${s.courseId} ✓`;
            if (s.kind === "in_progress") return `${s.courseId} (IP)`;
            return "(unknown)";
        }).join(", ");
        lines.push(`  ${sem.term}: ${sem.plannedCredits}cr — ${slots || "(empty)"}`);
    }

    if (schedule.assumptions.length > 0) {
        lines.push("");
        lines.push(`Assumptions (${schedule.assumptions.length}):`);
        for (const a of schedule.assumptions.slice(0, 3)) {
            if (a.type === "IP_COURSE_COMPLETION") {
                lines.push(`  [IP] ${a.courseId}`);
            }
        }
        if (schedule.assumptions.length > 3) {
            lines.push(`  ... and ${schedule.assumptions.length - 3} more`);
        }
    }

    return lines.join("\n");
}
