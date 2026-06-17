/**
 * D2.1b — probe_counterfactual tool (read-only what-if).
 *
 * The second half of D2.1 (the pure DPR transform `applyFailedCourseToDpr`
 * is D2.1a). A read-only counterfactual: apply a hypothetical → re-solve →
 * run the authoritative 7-axis validator → report the diff (valid) or the
 * binding constraint (infeasible).
 *
 * FOUR ARMS (zod discriminatedUnion on "kind"):
 *   - Arm A `future_course` — apply PlanMutation[] to a HYPOTHETICAL clone of
 *     schedulePreferences, then re-solve. Models "what if I dropped / swapped /
 *     pinned this FUTURE course." Identical re-solve seam to proposePlanChange,
 *     minus the session write.
 *   - Arm B `fail_completed` — apply the pure `applyFailedCourseToDpr` transform
 *     to build a SYNTHETIC DPR (the failed course's grade → "F", removed from
 *     coursesUsed, its requirement re-opened), then re-solve against that
 *     synthetic DPR. Models "what if I had FAILED this COMPLETED course."
 *   - Arm C `withdraw` (G2.1) — apply the pure `applyWithdrawalToDpr` transform
 *     (grade → "W", a "W" never satisfies the requirement so any leaf it
 *     covered re-opens; GPA-neutral), re-solve, AND compute the F3 registrar-
 *     window caveat. Models "what if I WITHDRAW from this CURRENT-TERM course."
 *   - Arm D `pass_fail` (G2.1) — apply the pure `applyPassFailToDpr` transform
 *     (school-specific: a "pass" keeps credit but may only satisfy electives;
 *     a "fail" re-opens + lowers GPA), capture its hedges, re-solve, AND compute
 *     the F3 window caveat. Models "what if I take this CURRENT-TERM course P/F."
 *
 * Arms B/C/D all build a SYNTHETIC DPR via the matching pure transform and feed
 * it to the SAME frozen solve/diff seam (the shared `solveAndDiff` helper). The
 * frozen contract (finalizeForwardSchedule + the 7-axis validator + the solver)
 * is unchanged — these arms only CALL it. Arms C/D additionally carry honest
 * hedges + the F3 window caveat + the universal "unverified assumption — verify
 * with your adviser; nothing is official until your next DPR" rail (CORE RULE 15).
 *
 * isReadOnly: true — this tool NEVER writes to session. The synthetic DPR flows
 * through BOTH the solver-input builder and `finalizeForwardSchedule`;
 * `session.degreeProgressReport` is never mutated (the transforms deep-copy).
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
import type { ToolSession } from "../tool.js";
import { solveForwardSchedule } from "../forwardSchedule/solver.js";
import { finalizeForwardSchedule } from "../forwardSchedule/build.js";
import { runGraduationPathValidator } from "../forwardSchedule/graduationPathValidator.js";
import { applyFailedCourseToDpr } from "../forwardSchedule/failCourseTransform.js";
import { applyWithdrawalToDpr } from "../forwardSchedule/withdrawTransform.js";
import { applyPassFailToDpr } from "../forwardSchedule/passFailTransform.js";
import { rowKey } from "../forwardSchedule/transformUtils.js";
import { canonicalizeCourseId } from "../../courseId.js";
import {
    applyMutationsToPreferences,
    buildSolverInputWithRulesFromSession,
    computeSlotDiff,
    buildPlanDiff,
    PlanMutationSchema,
} from "../forwardSchedule/planChangeHelpers.js";
import {
    classifyIpChangeability,
    deriveTemporalContext,
    campusForHomeSchool,
    NYU_ACADEMIC_CALENDAR,
} from "../../dpr/index.js";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import type {
    ForwardSchedule,
    PlanChangeOutcome,
    PlanDiff,
    PlanMutation,
    SchedulePreferences,
} from "@nyupath/shared";

/** The universal rail every IP-course what-if (withdraw / pass_fail) carries:
 *  a claimed current-term change is an UNVERIFIED assumption (CORE RULE 15 /
 *  core_philosophy.md) — nothing is official until the next DPR. */
const VERIFY_RAIL =
    "This is an unverified assumption — verify with your adviser; nothing is " +
    "official until your next DPR.";

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
    arm: "future_course" | "fail_completed" | "withdraw" | "pass_fail";
    /** The re-solved counterfactual schedule (pure preview — never persisted). */
    schedule: ForwardSchedule;
    /** Validator-derived PlanState of the re-solved schedule. */
    state: ForwardSchedule["state"];
    /** Rich delta vs the CURRENT plan (D3.1 reads this for trade-offs). */
    planDiff?: PlanDiff;
    /**
     * G2.1 — honest hedges for the IP-course arms (withdraw / pass_fail). For
     * pass_fail these are `applyPassFailToDpr`'s school-specific P/F hedges (e.g.
     * "uncertain whether P/F satisfies this requirement" / the GPA hedge on a
     * fail). Includes the universal verify/not-official rail. Absent for the
     * future_course / fail_completed arms.
     */
    hedges?: string[];
    /**
     * G2.1 — the F3 registrar-window caveat from `classifyIpChangeability`:
     * whether the student is even inside the add/drop or withdraw/PF window NOW
     * (window-aware actionability, cite-or-hedge per academicCalendar.ts). The
     * requirement consequence above is computed REGARDLESS of the window (a "W"
     * never satisfies the requirement, window-independent); this caveat only
     * gates *actionability*. Absent for the future_course / fail_completed arms.
     */
    windowCaveat?: string;
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
    z.object({
        kind: z.literal("withdraw"),
        courseId: z.string()
            .describe("The current-term (in-progress) course to hypothetically WITHDRAW from. A \"W\" never satisfies the requirement, so any leaf it covered re-opens; GPA-neutral."),
        now: z.string().datetime().optional()
            .describe("Override 'today' (ISO 8601) for the registrar-window check. Defaults to the real clock; injected in tests for determinism."),
    }),
    z.object({
        kind: z.literal("pass_fail"),
        courseId: z.string()
            .describe("The current-term (in-progress) course the student claims to take PASS/FAIL."),
        outcome: z.enum(["pass", "fail"])
            .describe("The claimed P/F result. 'pass' keeps credit but may not satisfy a major/minor/core requirement (school-specific); 'fail' re-opens the requirement and lowers GPA."),
        now: z.string().datetime().optional()
            .describe("Override 'today' (ISO 8601) for the registrar-window check. Defaults to the real clock; injected in tests for determinism."),
    }),
]);

// ---------------------------------------------------------------------------
// Shared transform→solve→diff machinery (reused by every arm)
// ---------------------------------------------------------------------------

/** The fields every arm assembles after re-solving its (dpr, prefs)
 *  counterfactual — i.e. the `PlanChangeOutcome`-shaped core plus the probe's
 *  schedule/state/planDiff. The arm-specific fields (`arm`, `hedges`,
 *  `windowCaveat`) are merged by the handler. */
interface SolveAndDiffResult {
    feasible: boolean;
    diff: PlanChangeOutcome["diff"];
    consequences: string[];
    conflicts?: Array<{ kind: string; detail: string }>;
    schedule: ForwardSchedule;
    state: ForwardSchedule["state"];
    planDiff?: PlanDiff;
}

/**
 * Re-solve a counterfactual `(solveDpr, solvePrefs)` through the SAME frozen
 * pipeline the build path uses (`buildSolverInputWithRulesFromSession` →
 * `solveForwardSchedule` → `finalizeForwardSchedule` + the 7-axis validator),
 * then compute the diff / rich planDiff / binding-constraint conflicts vs the
 * CURRENT plan. PURE re-solve — NOTHING here writes to session. Shared by all
 * four arms so the solve/diff logic lives in exactly ONE place.
 *
 * @param originalDpr The student's REAL DPR (the "before" world the planDiff
 *                    is measured against — always the original, never the
 *                    synthetic clone).
 * @param solveDpr    The DPR to solve against (the synthetic clone for the
 *                    fail/withdraw/pass_fail arms; === originalDpr for
 *                    future_course).
 */
function solveAndDiff(
    session: ToolSession,
    currentPlan: ForwardSchedule,
    originalDpr: DegreeProgressReport,
    solveDpr: DegreeProgressReport,
    solvePrefs: SchedulePreferences,
    noOpConsequences: string[],
): SolveAndDiffResult {
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
        dpr: originalDpr,
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
        feasible: validatorResult.feasible,
        diff,
        consequences,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
        schedule: probedSchedule,
        state: probedSchedule.state,
        planDiff,
    };
}

/**
 * Resolve the F3 registrar-window caveat for an IP-course arm (withdraw /
 * pass_fail). Finds the target course's term from the DPR's courseHistory,
 * derives the temporal context + campus, and asks `classifyIpChangeability`
 * whether the student is even inside the add/drop or withdraw/PF window NOW.
 *
 * READ-ONLY + window-INDEPENDENT consequence: this is surfaced as a CAVEAT
 * only — the requirement consequence (a "W" never satisfies the requirement)
 * is computed regardless of the window. Returns the classifier's hedge when
 * one applies (closed / withdraw_pf / unknown), else a benign in-window note;
 * when the course's term can't be found, returns `undefined`.
 */
function ipWindowCaveat(
    dpr: DegreeProgressReport,
    courseId: string,
    homeSchool: string | undefined,
    now?: Date,
): string | undefined {
    // Find the course's term from courseHistory under the SAME keying the
    // transforms use: canonicalizeCourseId(courseId) equals rowKey(row) =
    // canonicalizeCourseId(`${row.subject} ${row.catalogNbr}`).
    const targetId = canonicalizeCourseId(courseId);
    const row = dpr.courseHistory.find((r) => rowKey(r) === targetId);
    if (!row) return undefined;

    const temporalContext = deriveTemporalContext(dpr, now ? { now } : {});
    const campus = campusForHomeSchool(homeSchool);
    const result = classifyIpChangeability({
        ipTerm: row.term,
        temporalContext,
        campus,
        calendar: NYU_ACADEMIC_CALENDAR,
        ...(now ? { now } : {}),
    });
    // Prefer the classifier's hedge (closed / withdraw_pf / unknown). For a
    // freely-changeable window (future / add_drop) there is no hedge — surface
    // a short benign note so the caller always has a window caveat string.
    if (result.hedge) return result.hedge;
    return result.window === "future"
        ? "This is a pre-registered future term — freely changeable; no real-world registration to undo yet."
        : "You appear to be within the add/drop window for this term, so this course can still be dropped/changed; confirm the exact deadline with your registrar.";
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const probeCounterfactualTool = buildTool({
    name: "probe_counterfactual",
    description:
        "Read-only WHAT-IF probe. Apply a hypothetical, re-solve, run the " +
        "authoritative 7-axis validator, and report the diff (if still valid) " +
        "or the binding constraint (if it becomes infeasible). Four arms:\n\n" +
        "  • { kind: \"future_course\", mutations: [...] } — what if I drop / " +
        "swap / pin a FUTURE course? (same mutation vocabulary as " +
        "propose_plan_change).\n" +
        "  • { kind: \"fail_completed\", courseId } — what if I had FAILED this " +
        "already-COMPLETED course? (its requirement re-opens and the plan " +
        "re-solves around it).\n" +
        "  • { kind: \"withdraw\", courseId } — what if I WITHDRAW from this " +
        "current-term course? (a \"W\" never satisfies the requirement, so it " +
        "re-opens; GPA-neutral). Surfaces the registrar add/drop-or-withdraw " +
        "window caveat.\n" +
        "  • { kind: \"pass_fail\", courseId, outcome } — what if I take this " +
        "current-term course PASS/FAIL? ('pass' keeps credit but may not satisfy " +
        "a major/minor/core requirement — school-specific, hedged; 'fail' " +
        "re-opens it + lowers GPA). Surfaces the registrar window caveat.\n\n" +
        "Use this to answer 'what happens if…' questions WITHOUT changing the " +
        "student's plan. isReadOnly: true — never writes to session state. " +
        "The withdraw / pass_fail arms model an UNVERIFIED current-term change " +
        "(CORE RULE 15) — nothing is official until the next DPR.",
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
        "Read-only what-if probe. Four arms: future_course (mutations on a " +
        "future course), fail_completed (re-open a completed course's " +
        "requirement), withdraw (current-term course → 'W', re-opens; GPA- " +
        "neutral), and pass_fail (current-term course → P/F; 'pass' may not " +
        "satisfy a major/minor/core requirement — school-specific + hedged; " +
        "'fail' re-opens + lowers GPA). Re-solves + 7-axis-validates and " +
        "returns the diff or the binding constraint. The withdraw / pass_fail " +
        "arms add the registrar add/drop-or-withdraw window caveat + honest " +
        "hedges (an UNVERIFIED current-term change; nothing is official until " +
        "the next DPR). Never writes to session.",
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
        // Arms B/C/D (fail_completed / withdraw / pass_fail): the prefs are
        //   unchanged; the hypothetical lives in a SYNTHETIC DPR (deep copy via
        //   the matching pure transform) — the original
        //   session.degreeProgressReport is never mutated. The synthetic DPR
        //   flows through BOTH the builder AND finalize so coursesTaken /
        //   unmetRequirements are derived from it.
        //
        // Every arm hands its resolved (solveDpr, solvePrefs) to the SHARED
        // `solveAndDiff` helper — the solve/diff/conflict logic is defined in
        // exactly one place; the arms only differ in the transform they apply.
        let solveDpr: DegreeProgressReport = dpr;
        let solvePrefs: SchedulePreferences = session.schedulePreferences ?? {};
        let noOpConsequences: string[] = [];
        // G2.1 — IP-course arms surface honest hedges + the F3 window caveat.
        const armHedges: string[] = [];
        let windowCaveat: string | undefined;

        if (input.kind === "future_course") {
            const { prefs, noOpConsequences: noOps } = applyMutationsToPreferences(
                session.schedulePreferences ?? {},
                input.mutations as PlanMutation[],
            );
            solvePrefs = prefs;
            noOpConsequences = noOps;
        } else if (input.kind === "fail_completed") {
            // Arm B — synthetic DPR with the completed course failed + re-opened.
            solveDpr = applyFailedCourseToDpr(dpr, input.courseId);
        } else {
            // Arms C/D — IP-course (current-term) what-ifs. Build the synthetic
            // DPR via the matching pure transform, then ALSO compute the F3
            // registrar-window caveat (window-independent of the requirement
            // consequence — a "W" never satisfies the requirement regardless).
            const homeSchool = session.student?.homeSchool;
            // pfEligibility keys off the canonical school id; prefer the loaded
            // schoolConfig, fall back to the student's home school.
            const schoolId = session.schoolConfig?.schoolId ?? homeSchool ?? "";
            const now = input.now ? new Date(input.now) : undefined;

            if (input.kind === "withdraw") {
                solveDpr = applyWithdrawalToDpr(dpr, input.courseId);
            } else {
                // pass_fail — capture the transform's school-specific hedges.
                const { dpr: pfDpr, hedges } = applyPassFailToDpr(
                    dpr,
                    input.courseId,
                    input.outcome,
                    schoolId,
                );
                solveDpr = pfDpr;
                armHedges.push(...hedges);
            }

            // F3 window caveat (read-only; never gates the consequence).
            windowCaveat = ipWindowCaveat(dpr, input.courseId, homeSchool, now);
            // The universal rail: a claimed current-term change is UNVERIFIED.
            armHedges.push(VERIFY_RAIL);
        }

        // -- Re-solve (read-only) — shared transform→solve→diff seam -----------
        const core = solveAndDiff(
            session,
            currentPlan,
            dpr,
            solveDpr,
            solvePrefs,
            noOpConsequences,
        );

        // The verify rail also belongs in `consequences` for the IP arms so a
        // consumer reading only `consequences` still sees it.
        const consequences =
            input.kind === "withdraw" || input.kind === "pass_fail"
                ? [...core.consequences, VERIFY_RAIL]
                : core.consequences;

        return {
            arm: input.kind,
            feasible: core.feasible,
            diff: core.diff,
            consequences,
            conflicts: core.conflicts,
            schedule: core.schedule,
            state: core.state,
            planDiff: core.planDiff,
            ...(armHedges.length > 0 ? { hedges: armHedges } : {}),
            ...(windowCaveat ? { windowCaveat } : {}),
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
        // -- G2.1 — IP-course window caveat + honest hedges (withdraw/pass_fail).
        //    The window caveat is the F3 registrar-window actionability check
        //    (am I even inside the add/drop or withdraw/PF window NOW?); the
        //    requirement consequence above was computed REGARDLESS of it. The
        //    hedges include the school-specific P/F uncertainty + the universal
        //    verify/not-official rail. The agent must surface these verbatim. --
        if (output.windowCaveat) {
            lines.push(`Registrar-window caveat: ${output.windowCaveat}`);
        }
        if (output.hedges && output.hedges.length > 0) {
            lines.push("Hedges:");
            for (const h of output.hedges) {
                lines.push(`  • ${h}`);
            }
        }
        return lines.join("\n");
    },
});
