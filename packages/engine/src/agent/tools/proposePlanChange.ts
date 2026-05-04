/**
 * Phase 14 Task 5 — propose_plan_change tool (read-only).
 *
 * Accepts a multi-mutation array (Decision #23), applies mutations to a
 * hypothetical copy of schedulePreferences, runs the solver, and returns
 * a PlanChangeOutcome + attached planDiff without mutating any session state.
 *
 * isReadOnly: true — MUST NOT write to session.schedulePreferences or
 * session.forwardSchedule.
 */

import { z } from "zod";
import { buildTool } from "../tool.js";
import { solveForwardSchedule } from "../forwardSchedule/solver.js";
import {
    applyMutationsToPreferences,
    buildSolverInputFromSession,
    computeSlotDiff,
    deriveConsequences,
    buildPlanDiff,
} from "../forwardSchedule/planChangeHelpers.js";
import type { PlanChangeOutcome, PlanDiff, PlanMutation, SchedulePreferences } from "@nyupath/shared";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Zod schema for PlanMutation (mirrors the discriminated union in shared)
// ---------------------------------------------------------------------------

const SchedulingPreferencesSchema = z.object({
    avoidDays: z.array(z.object({ day: z.string(), strict: z.boolean() })).optional(),
    avoidTimeWindows: z.array(z.object({
        days: z.array(z.string()),
        startMin: z.number(),
        endMin: z.number(),
        strict: z.boolean(),
    })).optional(),
    preferTimeWindows: z.array(z.object({
        days: z.array(z.string()),
        startMin: z.number(),
        endMin: z.number(),
        weight: z.number(),
    })).optional(),
    desiredFreeDay: z.object({ day: z.string(), strict: z.boolean() }).optional(),
    avoidConsecutiveLongBlocks: z.boolean().optional(),
}).passthrough();

const PlanMutationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pin"), courseId: z.string(), term: z.string() }),
    z.object({ kind: z.literal("exclude"), courseId: z.string(), term: z.string().optional() }),
    z.object({ kind: z.literal("swap"), drop: z.string(), add: z.string(), term: z.string() }),
    z.object({ kind: z.literal("addTerm"), term: z.string() }),
    z.object({
        kind: z.literal("loadStyleOverride"),
        term: z.string().optional(),
        style: z.enum(["balanced", "frontload", "backload", "light", "heavy"]),
    }),
    z.object({ kind: z.literal("bindFreeElective"), slotId: z.string(), courseId: z.string() }),
    z.object({ kind: z.literal("unbindFreeElective"), slotId: z.string() }),
    z.object({ kind: z.literal("bindPoolSlot"), slotId: z.string(), courseId: z.string() }),
    z.object({ kind: z.literal("setSchedulingPreference"), value: SchedulingPreferencesSchema }),
    z.object({ kind: z.literal("clearSchedulingPreference") }),
]);

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface ProposePlanChangeOutput extends PlanChangeOutcome {
    planDiff?: PlanDiff;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const proposePlanChangeTool = buildTool({
    name: "propose_plan_change",
    description:
        "Preview the effect of one or more plan mutations WITHOUT committing them. " +
        "Returns a PlanChangeOutcome (feasible, diff, consequences, conflicts) and a " +
        "rich planDiff (workload shifts, balance impact, etc.) so the student can " +
        "evaluate the change before confirming.\n\n" +
        "Use this BEFORE calling confirm_plan_change. " +
        "Accepts the same mutation array: pin a course to a term, exclude a course, " +
        "swap courses, change load style, add summer/J-term, set scheduling preferences.\n\n" +
        "isReadOnly: true — never writes to session state.",
    inputSchema: z.object({
        mutations: z.array(PlanMutationSchema).min(1)
            .describe("One or more plan mutations to evaluate (applied left-to-right)."),
    }),
    isReadOnly: true,
    maxResultChars: 4000,
    async validateInput(_input, { session }) {
        if (!session.forwardSchedule && !session.studentDraftPlan) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. " +
                    "Call plan_forward_degree first, then propose changes.",
            };
        }
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "No Degree Progress Report loaded. Cannot simulate plan changes without DPR data.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Preview plan mutations before committing. " +
        "Returns feasibility + consequence strings + rich planDiff. " +
        "Use before confirm_plan_change so the student can see what would change.",
    async call(input, { session }): Promise<ProposePlanChangeOutput> {
        const dpr = session.degreeProgressReport!;
        const currentPlan = session.forwardSchedule ?? session.studentDraftPlan;

        if (!currentPlan) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: ["No forward plan found. Call plan_forward_degree first."],
                conflicts: [{ kind: "no_plan", detail: "session.forwardSchedule is absent" }],
            };
        }

        // Build hypothetical preferences (no mutation of session)
        const basePrefs: SchedulePreferences = session.schedulePreferences ?? {};
        const { prefs: hypotheticalPrefs, noOpConsequences } = applyMutationsToPreferences(
            basePrefs,
            input.mutations as PlanMutation[],
        );

        // Build a hypothetical SolverInput with the mutated preferences
        const solverInput = buildSolverInputFromSession(session, dpr, hypotheticalPrefs);

        // Run the solver (read-only — we never write the result to session)
        const solverOutput = solveForwardSchedule(solverInput);

        // Build a minimal ForwardSchedule from solver output (mirrors alternatives.ts)
        const plannedCredits = solverOutput.semesters.reduce((sum, s) => sum + s.plannedCredits, 0);
        const degreeCreditsMet =
            (dpr.cumulative.creditsUsed ?? 0) + plannedCredits >= (dpr.cumulative.creditsRequired ?? 128);

        const proposedSchedule: ForwardSchedule = {
            studentId: currentPlan.studentId,
            homeSchoolId: currentPlan.homeSchoolId,
            graduationTerm: solverInput.graduationTerm,
            creditTargetPerSemester: solverInput.creditTargetPerSemester,
            f1Floor: solverInput.f1Floor,
            domesticPartTimeFloor: solverInput.domesticPartTimeFloor,
            graduationCreditMinimum: solverInput.graduationCreditMinimum,
            degreeCreditsMet,
            semesters: solverOutput.semesters,
            dprCourseHistoryHash: solverInput.dprCourseHistoryHash,
            computedAt: Date.now(),
            feasibility: solverOutput.feasibility,
            state: solverOutput.state,
            balanceScore: solverOutput.balanceScore,
            assumptions: solverOutput.assumptions,
            ...(solverOutput.alternativeCandidates !== undefined
                ? { alternativeCandidates: solverOutput.alternativeCandidates }
                : {}),
        };

        // Compute diff and consequences
        const diff = computeSlotDiff(currentPlan, proposedSchedule);
        const consequences = deriveConsequences(diff, proposedSchedule, noOpConsequences);
        const planDiff = buildPlanDiff(currentPlan, proposedSchedule);

        // Build conflicts array from feasibility violations
        const conflicts = solverOutput.feasibility.constraintViolations.map(v => ({
            kind: v.kind as string,
            detail: v.detail,
        }));

        return {
            feasible: solverOutput.feasibility.feasible,
            diff,
            consequences,
            conflicts: conflicts.length > 0 ? conflicts : undefined,
            planDiff,
        };
    },
    summarizeResult(output) {
        const lines: string[] = [];
        lines.push(`PROPOSE PLAN CHANGE — feasible: ${output.feasible}`);
        if (output.conflicts && output.conflicts.length > 0) {
            lines.push(`Conflicts (${output.conflicts.length}):`);
            for (const c of output.conflicts.slice(0, 3)) {
                lines.push(`  [${c.kind}] ${c.detail}`);
            }
        }
        lines.push(`Added slots: ${output.diff.added.length}, removed slots: ${output.diff.removed.length}`);
        if (output.consequences.length > 0) {
            lines.push("Consequences:");
            for (const c of output.consequences.slice(0, 5)) {
                lines.push(`  • ${c}`);
            }
        }
        if (output.planDiff) {
            const bi = output.planDiff.balanceImpact;
            lines.push(`Balance: ${bi.before.toFixed(2)} → ${bi.after.toFixed(2)} (${bi.classification})`);
            if (output.planDiff.planStateChange) {
                const sc = output.planDiff.planStateChange;
                lines.push(`Plan state: ${sc.from} → ${sc.to}`);
            }
        }
        return lines.join("\n");
    },
});
