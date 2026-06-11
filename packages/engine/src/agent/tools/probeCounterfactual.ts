/**
 * D2.1b — probe_counterfactual tool (read-only what-if).
 *
 * The second half of D2.1 (the pure DPR transform `applyFailedCourseToDpr`
 * is D2.1a). A read-only counterfactual: apply a hypothetical → re-solve →
 * run the authoritative 7-axis validator → report the diff (valid) or the
 * binding constraint (infeasible).
 *
 * TWO ARMS (zod discriminatedUnion on "kind"):
 *   - Arm A `future_course` — apply PlanMutation[] to a HYPOTHETICAL clone of
 *     schedulePreferences, then re-solve. Models "what if I dropped / swapped /
 *     pinned this FUTURE course." Identical re-solve seam to proposePlanChange,
 *     minus the session write.
 *   - Arm B `fail_completed` — apply the pure `applyFailedCourseToDpr` transform
 *     to build a SYNTHETIC DPR (the failed course's grade → "F", removed from
 *     coursesUsed, its requirement re-opened), then re-solve against that
 *     synthetic DPR. Models "what if I had FAILED this COMPLETED course."
 *
 * isReadOnly: true — this tool NEVER writes to session. Arm B passes the
 * synthetic DPR to BOTH the solver-input builder and `finalizeForwardSchedule`;
 * `session.degreeProgressReport` is never mutated (the transform deep-copies).
 *
 * Why-not framing (D2.2, DONE) + trade-off diff (D3.1, DONE):
 *   - D2.2 — `summarizeResult` frames the two outcomes symmetrically:
 *     VALID (optionally "(with trade-offs)" when the engine's trade-off diff is
 *     non-empty) vs INFEASIBLE-because-<failing axis + reason>. HONEST SCOPE:
 *     the infeasible "why" is the validator's `Axes failed: <axis>: <reason>`
 *     string (conflictSource always "other") — AXIS-level, NOT a course-causal
 *     sentence. The tool never fabricates a course-causal binding constraint the
 *     validator doesn't emit (that would be an OPTIONAL future engine task).
 *   - D3.1 — the trade-off diff (carried via `planDiff`) is rendered as a
 *     guarded "Trade-offs:" section.
 */

import { z } from "zod";
import { buildTool } from "../tool.js";
import { solveForwardSchedule } from "../forwardSchedule/solver.js";
import { finalizeForwardSchedule } from "../forwardSchedule/build.js";
import { runGraduationPathValidator } from "../forwardSchedule/graduationPathValidator.js";
import { applyFailedCourseToDpr } from "../forwardSchedule/failCourseTransform.js";
import {
    applyMutationsToPreferences,
    buildSolverInputWithRulesFromSession,
    computeSlotDiff,
    buildPlanDiff,
    PlanMutationSchema,
} from "../forwardSchedule/planChangeHelpers.js";
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

/**
 * The probe outcome. Re-uses `PlanChangeOutcome`'s `feasible` / `diff` /
 * `consequences` / `conflicts` contract so the route layer can treat it like
 * a proposePlanChange result, plus:
 *   - `schedule`  — the re-solved counterfactual ForwardSchedule (the diff is
 *     vs the CURRENT plan; this is the hypothetical world).
 *   - `state`     — the validator-derived PlanState of the re-solved plan.
 *   - `planDiff`  — the rich delta (workload/balance/trade-offs) vs the current
 *     plan. D3.1 reads this for the agent-reachable trade-off diff.
 *   - `arm`       — which arm ran (future_course | fail_completed).
 */
export interface ProbeCounterfactualOutput extends PlanChangeOutcome {
    /** Which arm produced this result. */
    arm: "future_course" | "fail_completed";
    /** The re-solved counterfactual schedule (pure preview — never persisted). */
    schedule: ForwardSchedule;
    /** Validator-derived PlanState of the re-solved schedule. */
    state: ForwardSchedule["state"];
    /** Rich delta vs the CURRENT plan (D3.1 reads this for trade-offs). */
    planDiff?: PlanDiff;
}

// ---------------------------------------------------------------------------
// Input schema — discriminatedUnion("kind", …)
// ---------------------------------------------------------------------------

const ProbeInputSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("future_course"),
        mutations: z.array(PlanMutationSchema).min(1)
            .describe("One or more plan mutations to evaluate against a FUTURE course (applied left-to-right)."),
    }),
    z.object({
        kind: z.literal("fail_completed"),
        courseId: z.string()
            .describe("The completed course to hypothetically FAIL (its requirement re-opens)."),
    }),
]);

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const probeCounterfactualTool = buildTool({
    name: "probe_counterfactual",
    description:
        "Read-only WHAT-IF probe. Apply a hypothetical, re-solve, run the " +
        "authoritative 7-axis validator, and report the diff (if still valid) " +
        "or the binding constraint (if it becomes infeasible). Two arms:\n\n" +
        "  • { kind: \"future_course\", mutations: [...] } — what if I drop / " +
        "swap / pin a FUTURE course? (same mutation vocabulary as " +
        "propose_plan_change).\n" +
        "  • { kind: \"fail_completed\", courseId } — what if I had FAILED this " +
        "already-COMPLETED course? (its requirement re-opens and the plan " +
        "re-solves around it).\n\n" +
        "Use this to answer 'what happens if…' questions WITHOUT changing the " +
        "student's plan. isReadOnly: true — never writes to session state.",
    inputSchema: ProbeInputSchema,
    isReadOnly: true,
    maxResultChars: 4000,
    async validateInput(_input, { session }) {
        if (!session.forwardSchedule && !session.studentDraftPlan) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. " +
                    "Call plan_forward_degree first, then probe counterfactuals.",
            };
        }
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "No Degree Progress Report loaded. Cannot probe counterfactuals without DPR data.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Read-only what-if probe. Two arms: future_course (mutations on a " +
        "future course) and fail_completed (re-open a completed course's " +
        "requirement). Re-solves + 7-axis-validates and returns the diff or " +
        "the binding constraint. Never writes to session.",
    async call(input, { session }): Promise<ProbeCounterfactualOutput> {
        const dpr = session.degreeProgressReport!;
        const currentPlan = session.forwardSchedule ?? session.studentDraftPlan;

        if (!currentPlan) {
            return {
                arm: input.kind,
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: ["No forward plan found. Call plan_forward_degree first."],
                conflicts: [{ kind: "no_plan", detail: "session.forwardSchedule is absent" }],
                // No re-solve possible without a baseline plan; surface the
                // current (absent) plan would be misleading, so we synthesize a
                // minimal infeasible echo by reusing currentPlan when present.
                // currentPlan is undefined here by definition; the route layer
                // treats the conflict as the signal.
                schedule: undefined as unknown as ForwardSchedule,
                state: "infeasible-draft",
            };
        }

        // -- Resolve the counterfactual (dpr, prefs) per arm --------------------
        //
        // Arm A (future_course): the DPR is unchanged; the hypothetical lives in
        //   a CLONE of schedulePreferences with the mutations applied.
        // Arm B (fail_completed): the prefs are unchanged; the hypothetical lives
        //   in a SYNTHETIC DPR (deep copy via applyFailedCourseToDpr) — the
        //   original session.degreeProgressReport is never mutated. The synthetic
        //   DPR flows through BOTH the builder AND finalize so coursesTaken /
        //   unmetRequirements are derived from it.
        let solveDpr = dpr;
        let solvePrefs: SchedulePreferences = session.schedulePreferences ?? {};
        let noOpConsequences: string[] = [];

        if (input.kind === "future_course") {
            const { prefs, noOpConsequences: noOps } = applyMutationsToPreferences(
                session.schedulePreferences ?? {},
                input.mutations as PlanMutation[],
            );
            solvePrefs = prefs;
            noOpConsequences = noOps;
        } else {
            // Arm B — synthetic DPR with the completed course failed + re-opened.
            solveDpr = applyFailedCourseToDpr(dpr, input.courseId);
        }

        // -- Re-solve (read-only) ----------------------------------------------
        //
        // Identical seam to proposePlanChange: one buildProgramRules call yields
        // BOTH the solverInput and the validatorRules; solve; then route through
        // the SAME authoritative 7-axis finalize the build path uses. NONE of
        // this writes to session.
        const { solverInput, validatorRules } = buildSolverInputWithRulesFromSession(
            session,
            solveDpr,
            solvePrefs,
        );
        const solverOutput = solveForwardSchedule(solverInput);
        const { schedule: probedSchedule, validatorResult } = finalizeForwardSchedule(
            solverOutput,
            solverInput,
            solveDpr,
            validatorRules,
        );

        // Validate the BEFORE plan too (cheap, pure) so the planDiff can report
        // per-axis transitions. The before plan is validated against the
        // ORIGINAL dpr — that is the world the student is in today.
        const beforeAxes = runGraduationPathValidator({
            plan: currentPlan,
            dpr,
            programRules: validatorRules,
        }).axisResults;

        // -- Diff + rich planDiff vs the CURRENT plan --------------------------
        const diff = computeSlotDiff(currentPlan, probedSchedule);
        const planDiff = buildPlanDiff(currentPlan, probedSchedule, {
            before: beforeAxes,
            after: validatorResult.axisResults,
        });

        // -- Conflicts from the VALIDATOR (not the solver's coarse boolean) ----
        //
        // When the validator deems the counterfactual infeasible, surface the
        // BINDING constraint: the failing-axis + reason string from the
        // infeasibilityReport (conflictSource + conflictDetail). D2.2 frames this
        // as the "why-not" reason in summarizeResult. HONEST SCOPE: conflictSource
        // is always "other" and conflictDetail is `Axes failed: <axis>: <reason>`
        // — axis-level, NOT course-causal (see summarizeResult + the file header).
        const conflicts: Array<{ kind: string; detail: string }> = [];
        if (!validatorResult.feasible && validatorResult.infeasibilityReport) {
            conflicts.push({
                kind: validatorResult.infeasibilityReport.conflictSource,
                detail: validatorResult.infeasibilityReport.conflictDetail,
            });
        }

        // -- Consequences (plain-English) --------------------------------------
        const consequences: string[] = [...noOpConsequences];
        if (validatorResult.feasible) {
            consequences.push("Counterfactual re-solves to a VALID plan.");
        } else {
            consequences.push("Counterfactual is INFEASIBLE — see the binding constraint(s).");
        }
        if (diff.added.length > 0) {
            consequences.push(
                "Added: " +
                    diff.added
                        .map(({ term, slot }) =>
                            `${"courseId" in slot ? slot.courseId : "placeholder"} → ${term}`,
                        )
                        .join(", "),
            );
        }
        if (diff.removed.length > 0) {
            consequences.push(
                "Removed: " +
                    diff.removed
                        .map(({ term, slot }) =>
                            `${"courseId" in slot ? slot.courseId : "placeholder"} (was in ${term})`,
                        )
                        .join(", "),
            );
        }

        return {
            arm: input.kind,
            feasible: validatorResult.feasible,
            diff,
            consequences,
            conflicts: conflicts.length > 0 ? conflicts : undefined,
            schedule: probedSchedule,
            state: probedSchedule.state,
            planDiff,
        };
    },
    summarizeResult(output) {
        const lines: string[] = [];

        // -- D3.1 trade-off diff (computed FIRST so the D2.2 why-not header can
        //    announce its presence). Surface the (already-computed) trade-off
        //    diff from `diffPlanTradeOffs` so the agent SEES the petitions,
        //    re-opened requirements, cascaded shifts, and new assumptions a
        //    counterfactual introduces. Render only non-empty fields (guarded)
        //    so a benign probe shows no spurious section. The agent cannot
        //    invent a delta — it reads the engine's computed one. --------------
        const tradeOffLines: string[] = [];
        if (output.planDiff) {
            const pd = output.planDiff;
            if (pd.newUnmetRequirements.length > 0) {
                tradeOffLines.push(
                    `  • newly-unmet requirements: ${pd.newUnmetRequirements.join(", ")}`,
                );
            }
            if (pd.newRequiresPetition.length > 0) {
                tradeOffLines.push(
                    `  • now requires petition: ${pd.newRequiresPetition.join(", ")}`,
                );
            }
            if (pd.cascadedShifts.length > 0) {
                tradeOffLines.push(
                    "  • cascaded shifts: " +
                        pd.cascadedShifts
                            .map(
                                (s) =>
                                    `${s.courseId} ${s.fromTerm}→${s.toTerm} (because ${s.becauseOf})`,
                            )
                            .join("; "),
                );
            }
            if (pd.newAssumptions.length > 0) {
                tradeOffLines.push(
                    `  • new assumptions: ${pd.newAssumptions.length}/${pd.newAssumptions
                        .map((a) => a.type)
                        .join(", ")}`,
                );
            }
        }
        const hasTradeOffs = tradeOffLines.length > 0;

        // -- D2.2 why-not framing — the two outcomes are deliberately symmetric:
        //    VALID (optionally "(with trade-offs)" when the engine's trade-off
        //    diff is non-empty) vs INFEASIBLE-because-<failing axis + reason>.
        //    HONEST SCOPE: the INFEASIBLE binding constraint is the validator's
        //    `Axes failed: <axis>: <reason>` string (conflictSource always
        //    "other"); it is AXIS-level, NOT a course-causal sentence. We do not
        //    fabricate a course-causal "why" the validator does not emit. -------
        if (output.feasible) {
            const added = output.diff.added
                .map(({ term, slot }) =>
                    `${"courseId" in slot ? slot.courseId : "placeholder"} → ${term}`,
                )
                .join(", ");
            const removed = output.diff.removed
                .map(({ term, slot }) =>
                    `${"courseId" in slot ? slot.courseId : "placeholder"} (was in ${term})`,
                )
                .join(", ");
            const changes = [
                added ? `added ${added}` : "",
                removed ? `removed ${removed}` : "",
            ]
                .filter(Boolean)
                .join("; ");
            // Announce trade-offs in the header when the engine's trade-off diff
            // is non-empty — the symmetric counterpart to the INFEASIBLE reason.
            const verdict = hasTradeOffs ? "VALID (with trade-offs)" : "VALID";
            lines.push(
                `PROBE (${output.arm}) — ${verdict} — with these changes: ${changes || "no slot changes"}`,
            );
        } else {
            const binding =
                output.conflicts && output.conflicts.length > 0
                    ? output.conflicts.map((c) => `[${c.kind}] ${c.detail}`).join("; ")
                    : "(no binding-constraint detail available)";
            lines.push(`PROBE (${output.arm}) — INFEASIBLE — ${binding}`);
        }
        if (output.planDiff) {
            const pd = output.planDiff;
            const bi = pd.balanceImpact;
            lines.push(`Balance: ${bi.before.toFixed(2)} → ${bi.after.toFixed(2)} (${bi.classification})`);
            if (pd.planStateChange) {
                const sc = pd.planStateChange;
                lines.push(`Plan state: ${sc.from} → ${sc.to}`);
            }
            if (hasTradeOffs) {
                lines.push("Trade-offs:");
                lines.push(...tradeOffLines);
            }
        }
        if (output.consequences.length > 0) {
            lines.push("Consequences:");
            for (const c of output.consequences.slice(0, 5)) {
                lines.push(`  • ${c}`);
            }
        }
        return lines.join("\n");
    },
});
