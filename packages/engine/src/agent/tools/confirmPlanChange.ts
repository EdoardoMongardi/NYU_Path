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
import { finalizeForwardSchedule } from "../forwardSchedule/build.js";
import { runGraduationPathValidator } from "../forwardSchedule/graduationPathValidator.js";
import {
    applyMutationsToPreferences,
    resolveBindMutations,
    buildSolverInputWithRulesFromSession,
    computeSlotDiff,
    deriveConsequences,
    buildPlanDiff,
    PlanMutationSchema,
} from "../forwardSchedule/planChangeHelpers.js";
import { computeDprFingerprint } from "../../dpr/fingerprint.js";
import { buildDoubleCountAdvisory } from "../forwardSchedule/doubleCountAdvisory.js";
import { renderEnvelopeMeta, type Disclaimer } from "../toolEnvelope.js";
import type {
    Assumption,
    PlanChangeOutcome,
    PlanDiff,
    PlanMutation,
    SchedulePreferences,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// D6.3 — rung-3 LLM re-rank provenance input
// ---------------------------------------------------------------------------
//
// When the agent re-ranks the ForwardSchedule's `alternativeCandidates`
// (Tier B, Decision #42) against a student-stated soft factor and applies the
// chosen alternative via this tool, it passes the re-rank provenance so we can
// record WHY this plan was chosen as a durable `LLM_RANKED_ALTERNATIVE`
// Assumption on the confirmed schedule's `assumptions[]`. That Assumption
// channel persists (persistSchedule) AND survives the P3.1 hydration path, so
// the rationale is re-explainable on a later turn. Optional — confirms that do
// not re-rank simply omit it and no provenance Assumption is added.
const RankedAlternativeSchema = z.object({
    studentStatedFactor: z
        .string()
        .describe("The student's stated soft preference the re-rank optimized for."),
    selectedPlanIndex: z
        .number()
        .int()
        .describe("planIndex of the chosen AlternativePlanSummary (from compare_plan_alternatives)."),
    reasoning: z
        .string()
        .describe("Why this alternative was chosen over the others (recorded, surfaced to the student)."),
    dimensionsConsidered: z
        .array(z.string())
        .describe("The comparison axes weighed during the re-rank (echoed from compare_plan_alternatives)."),
});

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

interface ConfirmPlanChangeOutput extends PlanChangeOutcome {
    planDiff?: PlanDiff;
    /** Where the resulting schedule was stored. */
    storedIn: "forwardSchedule" | "studentDraftPlan";
    /**
     * Phase 10 envelope — advisory disclaimers (e.g. the double-count
     * heads-up for multi-program students). Carried as a STRUCTURED
     * Disclaimer (id + reason + bulletinSource), mirroring
     * plan_forward_degree, so the citation is surfaced by summarizeResult.
     * Advisory only — never affects feasibility / storedIn / the schedule.
     * (D3.2: previously the advisory's `.text` was pushed bare into
     * `consequences[]`, dropping the citation.)
     */
    disclaimers?: Disclaimer[];
    /**
     * D6.3 — when the confirm applied a re-ranked alternative, the recorded
     * provenance (mirrors the LLM_RANKED_ALTERNATIVE assumption appended to the
     * confirmed schedule). Surfaced by summarizeResult so the student sees the
     * recorded rationale. Present ONLY when the agent passed `rankedAlternative`.
     */
    rankedAlternative?: {
        studentStatedFactor: string;
        selectedPlanIndex: number;
        reasoning: string;
        dimensionsConsidered: string[];
    };
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
        rankedAlternative: RankedAlternativeSchema
            .optional()
            .describe(
                "D6.3 — re-rank provenance. Pass this ONLY when applying an alternative you " +
                "chose via compare_plan_alternatives (Tier B). Records WHY this plan was chosen " +
                "as a durable LLM_RANKED_ALTERNATIVE assumption on the confirmed schedule, so the " +
                "rationale persists and is re-explainable on a later turn. Omit for ordinary edits.",
            ),
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

        // Plan 37 Task J2 — translate slot-level binds into pins BEFORE the
        // prefs walk so the binding SURVIVES this confirm (and future re-plans):
        // `currentPlan` resolves a bind's slotId → term, and the pin path both
        // persists into prefs.pins[] and (via the solver's pin-coverage pass)
        // covers the requirement leaf. The dead bindPoolSlot/bindFreeElective
        // no-ops never persisted, so the binding used to be discarded here.
        const resolvedMutations = resolveBindMutations(currentPlan, input.mutations as PlanMutation[]);

        // Step 1: Apply mutations to session.schedulePreferences (mutate).
        const basePrefs: SchedulePreferences = session.schedulePreferences ?? {};
        const { prefs: newPrefs, noOpConsequences } = applyMutationsToPreferences(
            basePrefs,
            resolvedMutations,
        );
        session.schedulePreferences = newPrefs;

        // Step 2: Re-run the solver with the updated preferences.
        // P2.10 (b)+(d): one buildProgramRules call yields BOTH the solverInput
        // and the validatorRules. `newPrefs` is passed as a non-mutating override
        // — it is ALSO the value just persisted to session.schedulePreferences
        // above (that intended write is separate and unaffected), so the effective
        // preferences are identical either way.
        const { solverInput, validatorRules } = buildSolverInputWithRulesFromSession(
            session,
            dpr,
            newPrefs,
        );
        const solverOutput = solveForwardSchedule(solverInput);

        // ---- Route through the AUTHORITATIVE 7-axis validator (P2.7/PLAN-3) ----
        //
        // PLAN-3 hole: previously the Decision #32 routing keyed on the SOLVER's
        // coarse `state`, so a confirmed edit could be stored to
        // session.forwardSchedule ("valid") without runGraduationPathValidator
        // passing. We now run the SAME finalize step the build path uses; the
        // schedule carries the validator-derived state and the routing keys on
        // `validatorResult.feasible`. The `validatorRules` come from the single
        // bundle above (no redundant second buildProgramRules call).

        // Validate the BEFORE plan too (cheap, pure) for validationResultsChanges.
        const beforeAxes = runGraduationPathValidator({
            plan: currentPlan,
            dpr,
            programRules: validatorRules,
        }).axisResults;

        const { schedule: newSchedule, validatorResult } = finalizeForwardSchedule(
            solverOutput,
            solverInput,
            dpr,
            validatorRules,
        );

        // D6.3 — rung-3 re-rank provenance. When the agent applied an
        // alternative it chose via compare_plan_alternatives (Tier B), record
        // WHY as a durable LLM_RANKED_ALTERNATIVE assumption on the CONFIRMED
        // schedule's assumptions[] BEFORE persistSchedule below. This is the
        // parallel-Assumption channel (Risk #6 default): it persists AND
        // survives the P3.1 hydration path, so the rationale is re-explainable
        // on a later turn — no separate per-pref provenance store needed.
        // `finalizeForwardSchedule` rebuilds `assumptions` FRESH from the solver
        // on every confirm (the solver only emits IP_COURSE_COMPLETION, never
        // LLM_RANKED_ALTERNATIVE), so a prior turn's provenance is never carried
        // into this `newSchedule` — appending here yields EXACTLY ONE provenance
        // entry, and a re-confirm cannot stack duplicates (no de-dup guard needed).
        if (input.rankedAlternative) {
            const provenance: Extract<Assumption, { type: "LLM_RANKED_ALTERNATIVE" }> = {
                type: "LLM_RANKED_ALTERNATIVE",
                studentStatedFactor: input.rankedAlternative.studentStatedFactor,
                selectedPlanIndex: input.rankedAlternative.selectedPlanIndex,
                reasoning: input.rankedAlternative.reasoning,
                dimensionsConsidered: input.rankedAlternative.dimensionsConsidered,
            };
            newSchedule.assumptions = [...newSchedule.assumptions, provenance];
        }

        // Step 3: Decision #32 routing — keyed on the VALIDATOR's verdict.
        // An edit may be stored to session.forwardSchedule ONLY when the
        // authoritative validator deems it feasible (state valid-clean /
        // valid-with-trade-offs). Otherwise it lands in studentDraftPlan and
        // the last valid forwardSchedule is preserved.
        let storedIn: ConfirmPlanChangeOutput["storedIn"];
        if (validatorResult.feasible) {
            session.forwardSchedule = newSchedule;
            delete session.studentDraftPlan;
            storedIn = "forwardSchedule";
        } else {
            session.studentDraftPlan = newSchedule;
            // Keep the last valid forwardSchedule — do NOT delete it.
            storedIn = "studentDraftPlan";
        }

        // Phase 16 Task A — durable persistence of both the schedule
        // (so login restore can replay the latest plan) AND the
        // preferences (so pins / load-style / exclusions survive across
        // sessions). Failures do NOT throw — the in-memory mutation
        // already landed and the live turn is the source of truth.
        if (session.scheduleStore && session.student) {
            try {
                const fingerprint = computeDprFingerprint(dpr);
                await session.scheduleStore.persistSchedule(
                    session.student.id,
                    newSchedule,
                    fingerprint,
                );
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[confirm_plan_change] persistSchedule failed: ${err instanceof Error ? err.message : String(err)}`);
            }
            try {
                await session.scheduleStore.persistPreferences(
                    session.student.id,
                    newPrefs,
                );
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[confirm_plan_change] persistPreferences failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Step 4: Build outcome.
        const diff = computeSlotDiff(currentPlan, newSchedule);
        const consequences = deriveConsequences(diff, newSchedule, noOpConsequences);
        // D3.2 — carry the double-count advisory as a STRUCTURED, cited
        // Disclaimer on the envelope (mirrors plan_forward_degree), NOT as a
        // bare `.text` in consequences[] (which dropped reason + bulletinSource).
        const dcAdvisory = buildDoubleCountAdvisory(dpr, session.schoolConfig);
        const disclaimers = dcAdvisory ? [dcAdvisory] : undefined;
        const planDiff = buildPlanDiff(currentPlan, newSchedule, {
            before: beforeAxes,
            after: validatorResult.axisResults,
        });

        // Conflicts + the binding-constraint consequence come from the
        // VALIDATOR's verdict (the authoritative gate), not the solver's coarse
        // feasibility. When the validator fails an axis the solver missed, name
        // the failing axes + binding constraint so the student sees WHY the edit
        // landed in the draft slot rather than the live plan.
        const conflicts: Array<{ kind: string; detail: string }> = [];
        if (!validatorResult.feasible && validatorResult.infeasibilityReport) {
            const failingAxes = Object.entries(validatorResult.axisResults)
                .filter(([, v]) => v.status === "fail")
                .map(([axis]) => axis);
            conflicts.push({
                kind: validatorResult.infeasibilityReport.conflictSource,
                detail: validatorResult.infeasibilityReport.conflictDetail,
            });
            consequences.push(
                `Plan fails graduation-path validation (${failingAxes.join(", ")}): ` +
                `${validatorResult.infeasibilityReport.conflictDetail}. ` +
                "Stored as a draft; your last valid plan is unchanged.",
            );
        }

        return {
            feasible: validatorResult.feasible,
            diff,
            consequences,
            conflicts: conflicts.length > 0 ? conflicts : undefined,
            planDiff,
            storedIn,
            ...(disclaimers ? { disclaimers } : {}),
            ...(input.rankedAlternative ? { rankedAlternative: input.rankedAlternative } : {}),
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
        // D6.3 — surface the recorded re-rank rationale so the student sees WHY
        // this alternative was chosen (now durable on the schedule's assumptions[]).
        if (output.rankedAlternative) {
            const ra = output.rankedAlternative;
            lines.push(
                `Recorded why this plan was chosen: ${ra.reasoning} ` +
                `(dimensions: ${ra.dimensionsConsidered.join(", ")})`,
            );
        }
        // D3.2 — render the advisory disclaimer (reason + bulletinSource cited),
        // mirroring plan_forward_degree. Adds nothing when there is no advisory.
        const env = renderEnvelopeMeta({ disclaimers: output.disclaimers });
        if (env) lines.push("", env);
        return lines.join("\n");
    },
});
