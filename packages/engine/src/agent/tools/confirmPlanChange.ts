/**
 * Phase 14 Task 5 — confirm_plan_change tool (write).
 *
 * Accepts the same multi-mutation array as propose_plan_change.
 * Applies mutations to session.schedulePreferences, re-runs the solver,
 * and routes the result per Decision #32:
 *   valid-clean / valid-with-trade-offs → session.forwardSchedule
 *   infeasible-draft / student-preferred-invalid-draft → session.studentDraftPlan
 *
 * isReadOnly: false — DOES mutate session.schedulePreferences + schedule slot.
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
    PlanMutationSchema,
} from "../forwardSchedule/planChangeHelpers.js";
import type {
    PlanChangeOutcome,
    PlanDiff,
    PlanMutation,
    SchedulePreferences,
    ForwardSchedule,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface ConfirmPlanChangeOutput extends PlanChangeOutcome {
    planDiff?: PlanDiff;
    /** Where the resulting schedule was stored. */
    storedIn: "forwardSchedule" | "studentDraftPlan";
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const confirmPlanChangeTool = buildTool({
    name: "confirm_plan_change",
    description:
        "Apply one or more plan mutations permanently to the session. " +
        "Mutates session.schedulePreferences, re-runs the forward planner, and routes " +
        "the result per Decision #32 (valid plans → forwardSchedule; infeasible/draft → studentDraftPlan).\n\n" +
        "Call propose_plan_change first to preview the effect. " +
        "Use confirm_plan_change only after the student has agreed to the change.\n\n" +
        "isReadOnly: false — writes to session.schedulePreferences and schedule slot.",
    inputSchema: z.object({
        mutations: z.array(PlanMutationSchema).min(1)
            .describe("One or more plan mutations to apply (same array as propose_plan_change)."),
    }),
    isReadOnly: false,
    maxResultChars: 4000,
    async validateInput(_input, { session }) {
        if (!session.forwardSchedule && !session.studentDraftPlan) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. " +
                    "Call plan_forward_degree first, then confirm changes.",
            };
        }
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "No Degree Progress Report loaded. Cannot apply plan changes without DPR data.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Apply plan mutations after the student has confirmed the preview. " +
        "Mutates session preferences, re-runs the solver, and routes the result " +
        "to forwardSchedule or studentDraftPlan per Decision #32.",
    async call(input, { session }): Promise<ConfirmPlanChangeOutput> {
        const dpr = session.degreeProgressReport!;
        const currentPlan = session.forwardSchedule ?? session.studentDraftPlan;

        if (!currentPlan) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: ["No forward plan found. Call plan_forward_degree first."],
                conflicts: [{ kind: "no_plan", detail: "session.forwardSchedule is absent" }],
                storedIn: "studentDraftPlan",
            };
        }

        // Step 1: Apply mutations to session.schedulePreferences (mutate).
        const basePrefs: SchedulePreferences = session.schedulePreferences ?? {};
        const { prefs: newPrefs, noOpConsequences } = applyMutationsToPreferences(
            basePrefs,
            input.mutations as PlanMutation[],
        );
        session.schedulePreferences = newPrefs;

        // Step 2: Re-run the solver with the updated preferences.
        const solverInput = buildSolverInputFromSession(session, dpr, newPrefs);
        const solverOutput = solveForwardSchedule(solverInput);

        // Build a ForwardSchedule from solver output.
        const plannedCredits = solverOutput.semesters.reduce((sum, s) => sum + s.plannedCredits, 0);
        const degreeCreditsMet =
            (dpr.cumulative.creditsUsed ?? 0) + plannedCredits >= (dpr.cumulative.creditsRequired ?? 128);

        const newSchedule: ForwardSchedule = {
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

        // Step 3: Decision #32 routing.
        let storedIn: ConfirmPlanChangeOutput["storedIn"];
        if (newSchedule.state === "valid-clean" || newSchedule.state === "valid-with-trade-offs") {
            session.forwardSchedule = newSchedule;
            delete session.studentDraftPlan;
            storedIn = "forwardSchedule";
        } else {
            session.studentDraftPlan = newSchedule;
            // Keep the last valid forwardSchedule — do NOT delete it.
            storedIn = "studentDraftPlan";
        }

        // Step 4: Build outcome.
        const diff = computeSlotDiff(currentPlan, newSchedule);
        const consequences = deriveConsequences(diff, newSchedule, noOpConsequences);
        const planDiff = buildPlanDiff(currentPlan, newSchedule);

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
            storedIn,
        };
    },
    summarizeResult(output) {
        const lines: string[] = [];
        lines.push(`CONFIRM PLAN CHANGE — feasible: ${output.feasible}, stored in: session.${output.storedIn}`);
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
