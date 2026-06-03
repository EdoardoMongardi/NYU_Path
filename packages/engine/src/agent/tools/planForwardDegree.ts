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
import { computeDprFingerprint } from "../../dpr/fingerprint.js";
import type { ForwardSchedule } from "@nyupath/shared";

/** Convert a display-form ("Spring 2027" / "2027 Spring" / "spring2027") or
 *  PeopleSoft ("2027 Spr") graduation term to the solver's "{year}-{season}"
 *  shape. Pass-through when already in solver shape. Returns undefined when
 *  the input is undefined or unparseable so the caller falls through to
 *  build.ts's credit-derived default. */
function toSolverShape(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (/^\d{4}-(?:fall|spring|summer|january)$/i.test(trimmed)) return trimmed.toLowerCase();
    const m = trimmed.match(/^(\d{4})\s+(Fall|Spring|Summer|J Term|J-Term|January|Spr|Sum)$/i)
        ?? trimmed.match(/^(Fall|Spring|Summer|J Term|J-Term|January|Spr|Sum)\s+(\d{4})$/i);
    if (!m) return undefined;
    const yearStr = /^\d{4}$/.test(m[1]!) ? m[1]! : m[2]!;
    const seasonRaw = (/^\d{4}$/.test(m[1]!) ? m[2]! : m[1]!).toLowerCase();
    const season =
        seasonRaw.startsWith("fa") ? "fall" :
        seasonRaw.startsWith("sp") ? "spring" :
        seasonRaw.startsWith("su") ? "summer" :
        seasonRaw.startsWith("j")  ? "january" : null;
    return season ? `${yearStr}-${season}` : undefined;
}

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

        // Resolve the graduation target the schedule should aim at.
        // Priority:
        //   1. explicit `graduationTermOverride` from the LLM (hypothetical
        //      "what if I graduate Fall 2027" probes)
        //   2. `session.graduationTarget` — the onboarding-stated term the
        //      student typed at sign-up, threaded by the chat route
        //   3. nothing → build.ts derives from credits remaining
        // The session value is in display form ("Spring 2027"); the
        // solver needs "{year}-{season}" — the local converter accepts
        // both shapes plus the PeopleSoft "2027 Spring" form.
        const resolvedOverride =
            input.graduationTermOverride
            ?? toSolverShape(session.graduationTarget);

        const schedule = buildForwardSchedule({
            session,
            dpr,
            graduationTermOverride: resolvedOverride,
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

        // Phase 16 Task A — durable schedule persistence. The fingerprint
        // is content-only (course history + cumulative + programs) so the
        // Update-DPR route (Task 16.B) can detect meaningful re-uploads
        // by comparing against the stored row's `dprFingerprint`. Failures
        // do NOT throw — the in-memory write already landed and the live
        // turn is the source of truth (mirrors confirm_profile_update's
        // no-throw persistence pattern).
        if (session.scheduleStore && session.student) {
            try {
                const fingerprint = computeDprFingerprint(dpr);
                await session.scheduleStore.persistSchedule(
                    session.student.id,
                    schedule,
                    fingerprint,
                );
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[plan_forward_degree] persistSchedule failed: ${err instanceof Error ? err.message : String(err)}`);
            }
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
