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
import { finalizeForwardSchedule } from "../forwardSchedule/build.js";
import { runGraduationPathValidator } from "../forwardSchedule/graduationPathValidator.js";
import {
    applyMutationsToPreferences,
    buildSolverInputWithRulesFromSession,
    computeSlotDiff,
    deriveConsequences,
    buildPlanDiff,
    PlanMutationSchema,
} from "../forwardSchedule/planChangeHelpers.js";
import { explainPlanDiff } from "../forwardSchedule/explainPlanDiff.js";
import type {
    ForwardSchedule,
    PlanChangeOutcome,
    PlanDiff,
    PlanMutation,
    SchedulePreferences,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface ProposePlanChangeOutput extends PlanChangeOutcome {
    planDiff?: PlanDiff;
    /**
     * Phase 17 — deterministic confirm-bubble template rendered from
     * `(planDiff, mutations[0])`. Plain English; preserves every
     * course code, term, and credit number verbatim. The route layer
     * surfaces this as the fast-path explanation; an optional LLM
     * polish call (Phase 17 Task D) may replace it later. Always
     * derived from the FIRST mutation in the input array — multi-
     * mutation batches show the first operation's template (the
     * route layer can request additional renders if needed).
     */
    explanation: string;
    /**
     * Phase 17 — the simulated post-mutation schedule. Returned so the
     * route-layer orchestrator can read the proposed `forwardSchedule`
     * directly without re-running the solver via a clone-session
     * `confirmPlanChange` call (the May 2026 post-mortem variant of the
     * Task A reviewer's load-bearing assertion: doubling the solver
     * invocation per click would push Stage 1 latency from 180-600ms
     * up to 360-1200ms — over the budget I committed to in the plan).
     *
     * The route layer reads this to validate "course actually lands in
     * toTerm" without persisting; the actual persist still goes through
     * `confirmPlanChange` on a separate user-confirm action. So this
     * field NEVER triggers a write — it's a pure preview.
     */
    proposedSchedule?: ForwardSchedule;
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
                explanation: "No forward plan found. Call plan_forward_degree first.",
            };
        }

        // Build hypothetical preferences (no mutation of session)
        const basePrefs: SchedulePreferences = session.schedulePreferences ?? {};
        const { prefs: hypotheticalPrefs, noOpConsequences } = applyMutationsToPreferences(
            basePrefs,
            input.mutations as PlanMutation[],
        );

        // Build a hypothetical SolverInput with the mutated preferences.
        // P2.10 (b)+(d): one buildProgramRules call yields BOTH the solverInput
        // and the validatorRules; the mutated prefs are applied as a non-mutating
        // override (no session write on this read-only path).
        const { solverInput, validatorRules } = buildSolverInputWithRulesFromSession(
            session,
            dpr,
            hypotheticalPrefs,
        );

        // Run the solver (read-only — we never write the result to session)
        const solverOutput = solveForwardSchedule(solverInput);

        // ---- Route through the AUTHORITATIVE 7-axis validator (P2.7/PLAN-3) ----
        //
        // The solver's coarse `feasibility`/`state` is NOT trusted here. We run
        // the SAME finalize step the build path uses, so the proposed schedule
        // carries the validator-derived state and `feasible` reflects the full
        // 7-axis verdict — closing the PLAN-3 hole where an edit could preview
        // as feasible while a 7-axis check would have failed.
        const { schedule: proposedSchedule, validatorResult } = finalizeForwardSchedule(
            solverOutput,
            solverInput,
            dpr,
            validatorRules,
        );

        // Validate the BEFORE plan too (cheap, pure) so the planDiff can report
        // per-axis validation transitions (validationResultsChanges, P2.7).
        const beforeAxes = runGraduationPathValidator({
            plan: currentPlan,
            dpr,
            programRules: validatorRules,
        }).axisResults;

        // Compute diff and consequences
        const diff = computeSlotDiff(currentPlan, proposedSchedule);
        const consequences = deriveConsequences(diff, proposedSchedule, noOpConsequences);
        const planDiff = buildPlanDiff(currentPlan, proposedSchedule, {
            before: beforeAxes,
            after: validatorResult.axisResults,
        });

        // Build conflicts from the VALIDATOR's verdict (not the solver's coarse
        // feasibility): when infeasible, surface the binding constraint (failing
        // axes) from the validator's infeasibilityReport.
        const conflicts: Array<{ kind: string; detail: string }> = [];
        if (!validatorResult.feasible && validatorResult.infeasibilityReport) {
            conflicts.push({
                kind: validatorResult.infeasibilityReport.conflictSource,
                detail: validatorResult.infeasibilityReport.conflictDetail,
            });
        }

        // Phase 17 — deterministic confirm-bubble template. Use the
        // first mutation in the batch as the "headline" mutation. The
        // route layer (Phase 17 Task B) can call explainPlanDiff again
        // for any subsequent mutation if it wants per-mutation copy.
        const mutations = input.mutations as PlanMutation[];
        const firstMutation = mutations[0]!;
        const explanation = explainPlanDiff(planDiff, firstMutation);

        return {
            feasible: validatorResult.feasible,
            diff,
            consequences,
            conflicts: conflicts.length > 0 ? conflicts : undefined,
            planDiff,
            explanation,
            proposedSchedule,
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
