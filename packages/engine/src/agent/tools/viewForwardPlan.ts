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
import type {
    ForwardSchedule,
    ForwardSemester,
    ScheduleSlot,
} from "@nyupath/shared";

type DetailLevel = "terse" | "rich";

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
        "Pass detail: \"rich\" for the per-slot reasoning the stored plan already carries — " +
        "the recorded RATIONALE (the \"why\" each course sits in its term), each slot's " +
        "LOCK status (taken/in-progress = fixed vs. planned = movable), FLEXIBILITY " +
        "(earliest/latest possible term + alternative courses), DOWNSTREAM IMPACT " +
        "(what slips if the course moves), and CRITICAL-PATH flags. Use detail: \"rich\" to " +
        "answer 'why is <course> in <term>?', 'which courses are locked vs. movable?', or " +
        "'how flexible is this slot?' — cite the recorded reason verbatim; never invent one. " +
        "Default detail: \"terse\" gives the compact one-line-per-term view.\n\n" +
        "This tool is READ-ONLY — it never modifies session state. " +
        "Call plan_forward_degree to generate or refresh the plan.",
    inputSchema: z.object({
        detail: z.enum(["terse", "rich"]).optional(),
    }),
    isReadOnly: true,
    maxResultChars: 8000,
    prompt: () =>
        "Return the stored forward degree plan (session.forwardSchedule or session.studentDraftPlan). " +
        "Read-only — does not recalculate. Use plan_forward_degree to generate a new plan.",
    async call(input, { session }): Promise<ViewForwardPlanOutput> {
        const detail: DetailLevel = input.detail ?? "terse";
        if (session.forwardSchedule) {
            return {
                schedule: session.forwardSchedule,
                source: "forwardSchedule",
                summary: buildSummary(session.forwardSchedule, "forwardSchedule", detail),
            };
        }
        if (session.studentDraftPlan) {
            return {
                schedule: session.studentDraftPlan,
                source: "studentDraftPlan",
                summary: buildSummary(session.studentDraftPlan, "studentDraftPlan", detail),
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
    detail: DetailLevel = "terse",
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

    if (detail === "rich") {
        for (const sem of schedule.semesters) {
            appendRichSemester(lines, sem);
        }
    } else {
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

// ---------------------------------------------------------------------------
// Rich-mode rendering (D1.1)
// ---------------------------------------------------------------------------
//
// Surfaces the per-slot reasoning the plan ALREADY carries — recorded WHY,
// lock-vs-movable status, flexibility, downstream impact, critical-path — so
// the agent can answer "why is X in term Y / what's locked vs movable / how
// flexible is this" without inventing a field. Renders labeled text (not a
// JSON dump); only prints fields that are present (optionals guarded).

/** Per-semester rich block: header (with lock + load rationale) then each slot. */
function appendRichSemester(lines: string[], sem: ForwardSemester): void {
    const lockTag = sem.locked ? " 🔒 LOCKED (slots fixed)" : "";
    lines.push(`  ${sem.term}: ${sem.plannedCredits}cr${lockTag}`);

    const lr = sem.loadRationale;
    lines.push(
        `    load: ${lr.strategy} · target ${lr.creditsTarget}cr · slack ${lr.slack} · ` +
        `weighted ${lr.weightedCredits} · hard ${lr.hardCount} / easy ${lr.easyCount}`,
    );

    if (sem.slots.length === 0) {
        lines.push("    (empty)");
        return;
    }
    for (const slot of sem.slots) {
        appendRichSlot(lines, slot, sem.locked);
    }
}

/** One rich slot: lock-vs-movable marker headline + the recorded reasoning. */
function appendRichSlot(lines: string[], slot: ScheduleSlot, semesterLocked: boolean): void {
    const marker = lockMarker(slot, semesterLocked);

    if (slot.kind === "completed") {
        lines.push(`    ${marker} ${slot.courseId} (${slot.credits}cr, grade ${slot.grade})`);
        return;
    }
    if (slot.kind === "in_progress") {
        lines.push(`    ${marker} ${slot.courseId} (${slot.credits}cr)`);
        return;
    }
    if (slot.kind === "specific_planned") {
        lines.push(`    ${marker} ${slot.courseId} (${slot.credits}cr)${slot.isCriticalPath ? " ⚠ critical path" : ""}`);
        lines.push(`      why: ${slot.reason}`);
        if (slot.rationale.satisfiesRequirements.length > 0) {
            lines.push(`      satisfies: ${slot.rationale.satisfiesRequirements.join(", ")}`);
        }
        lines.push(`      tier: ${slot.workloadTier}`);
        appendFlexibility(lines, slot.flexibility);
        appendDownstream(lines, slot.downstreamImpact);
        appendOptionalReason(lines, slot.optionalReason);
        return;
    }
    // placeholder
    lines.push(`    ${marker} [${slot.category}] (${slot.credits}cr)${slot.isCriticalPath ? " ⚠ critical path" : ""}`);
    lines.push(`      why: ${slot.reason}`);
    if (slot.satisfiesRules.length > 0) {
        lines.push(`      satisfies: ${slot.satisfiesRules.join(", ")}`);
    }
    lines.push(`      tier: ${slot.workloadTier}`);
    appendFlexibility(lines, slot.flexibility);
    appendDownstream(lines, slot.downstreamImpact);
    appendOptionalReason(lines, slot.optionalReason);
    if (slot.poolBinding) {
        lines.push(`      pool candidates: ${slot.poolBinding.candidates.join(", ") || "(none)"}`);
    }
}

/**
 * Lock-vs-movable headline marker (the D1.1 centerpiece):
 *  - completed   → 🔒 locked (taken/final)
 *  - in_progress → ◐ in progress (fixed in term)
 *  - planned     → planned (movable) — UNLESS its semester is locked (then fixed)
 */
function lockMarker(slot: ScheduleSlot, semesterLocked: boolean): string {
    if (slot.kind === "completed") return "🔒 locked (taken/final)";
    if (slot.kind === "in_progress") return "◐ in progress (fixed in term)";
    // specific_planned / placeholder
    return semesterLocked ? "🔒 fixed (locked term)" : "○ planned (movable)";
}

function appendFlexibility(
    lines: string[],
    flex: { earliestPossibleTerm: string; latestPossibleTerm: string; alternativeCourses: string[] },
): void {
    lines.push(`      flexibility: earliest ${flex.earliestPossibleTerm} → latest ${flex.latestPossibleTerm}`);
    if (flex.alternativeCourses.length > 0) {
        lines.push(`      alternatives: ${flex.alternativeCourses.join(", ")}`);
    }
}

function appendDownstream(
    lines: string[],
    impact: { courseIds: string[]; graduationDelay: number },
): void {
    if (impact.courseIds.length === 0 && impact.graduationDelay === 0) return;
    lines.push(
        `      downstream: ${impact.courseIds.length} dependent course(s)` +
        (impact.graduationDelay > 0 ? ` · graduation delay ${impact.graduationDelay} term(s) if moved` : ""),
    );
}

function appendOptionalReason(
    lines: string[],
    optionalReason: { droppable: boolean; blockingConstraints?: string[] } | undefined,
): void {
    if (!optionalReason) return;
    lines.push(`      droppable: ${optionalReason.droppable ? "yes" : "no"}`);
}
