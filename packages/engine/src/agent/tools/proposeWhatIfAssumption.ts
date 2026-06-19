/**
 * G3.1 — propose_whatif_assumption tool (read-only).
 *
 * The PROPOSE half of a propose→confirm round-trip for a current-term IP-course
 * WHAT-IF ASSUMPTION. A student claims "I withdrew / I'll take pass-fail for
 * course X" (a current-term in-progress course). We treat the claim as an
 * ASSUMPTION, build a SYNTHETIC DPR in-memory via the matching pure transform
 * (applyWithdrawalToDpr / applyPassFailToDpr), re-solve through the SAME frozen
 * pipeline the build path uses, and return the PROPOSED (un-persisted) plan +
 * diff + a `whatIfAssumption` marker (courseId + outcome + hedges + windowCaveat
 * + label) so the web review card / canvas badge (G3.2) can label it.
 *
 * isReadOnly: true — at PROPOSE time this tool NEVER writes session state. The
 * orchestrator stages the assumption ({courseId, outcome}) for a follow-up
 * confirm; only the CONFIRM step persists the resulting forward_schedule (never
 * the synthetic DPR — the R1 snapshot-integrity guardrail).
 *
 * Relationship to probe_counterfactual: the probe is pure INTROSPECTION ("what
 * happens if…"), with no persist path. This tool is the propose half of an
 * ACTIONABLE assumption the student can Confirm onto their canvas. Both reuse
 * the SAME `solveWhatIfAssumption` machinery (whatIfAssumption.ts), so the
 * re-plan + hedges + window caveat are computed identically.
 */

import { z } from "zod";
import { buildTool } from "../tool.js";
import {
    solveWhatIfAssumption,
    whatIfAssumptionLabel,
    type WhatIfOutcome,
} from "../forwardSchedule/whatIfAssumption.js";
import { canonicalizeCourseId } from "../../courseId.js";
import type {
    ForwardSchedule,
    PlanChangeOutcome,
    PlanDiff,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// The whatIfAssumption marker (G3.1) — carried on the proposed plan so the
// web review card + canvas badge (G3.2) can label the assumption.
// ---------------------------------------------------------------------------

export interface WhatIfAssumptionMarker {
    /** The current-term IP course the assumption is about. */
    courseId: string;
    /** The assumed outcome. */
    outcome: WhatIfOutcome;
    /** Plain-English label ("Assumes you withdraw from CSCI-UA 102 …"). */
    label: string;
    /** School-specific P/F hedges + the universal verify/not-official rail. */
    hedges: string[];
    /** The F3 registrar-window actionability caveat (absent when the course's
     *  term can't be located). */
    windowCaveat?: string;
}

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface ProposeWhatIfAssumptionOutput extends PlanChangeOutcome {
    /** The proposed (read-only, NOT persisted) ForwardSchedule the student
     *  would land on if they confirm. */
    proposedSchedule?: ForwardSchedule;
    /** Rich delta vs the CURRENT plan (workload/balance/trade-offs). */
    planDiff?: PlanDiff;
    /** Validator-derived PlanState of the proposed schedule. */
    state: ForwardSchedule["state"];
    /** The G3.1 assumption marker (label + course/outcome + hedges + caveat). */
    whatIfAssumption: WhatIfAssumptionMarker;
    /** Echoed for convenience; identical to `whatIfAssumption.windowCaveat`. */
    windowCaveat?: string;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const InputSchema = z.object({
    courseId: z.string().min(1)
        .describe("The current-term (in-progress) course the student claims a what-if outcome for."),
    outcome: z.enum(["withdraw", "pass", "fail"])
        .describe(
            "The claimed outcome. 'withdraw' → a \"W\" (GPA-neutral; the requirement re-opens). " +
            "'pass'/'fail' → a Pass/Fail election (school-specific: a 'pass' keeps credit but may " +
            "only satisfy electives; a 'fail' re-opens + lowers GPA).",
        ),
    now: z.string().datetime().optional()
        .describe("Override 'today' (ISO 8601) for the registrar-window check. Defaults to the real clock; injected in tests for determinism."),
});

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const proposeWhatIfAssumptionTool = buildTool({
    name: "propose_whatif_assumption",
    description:
        "Propose a current-term IP-course WHAT-IF ASSUMPTION the student can " +
        "Confirm onto their canvas. The student claims 'I withdrew / I'll take " +
        "pass-fail for course X'; we treat it as an ASSUMPTION, build a synthetic " +
        "in-memory DPR, re-solve through the authoritative 8-axis pipeline, and " +
        "return the PROPOSED (un-persisted) plan + a whatIfAssumption marker " +
        "(label + course/outcome + honest hedges + the registrar-window caveat).\n\n" +
        "  • outcome 'withdraw' — a \"W\" (GPA-neutral; the requirement re-opens).\n" +
        "  • outcome 'pass' — keeps credit but may not satisfy a major/minor/core " +
        "requirement (school-specific, hedged).\n" +
        "  • outcome 'fail' — re-opens the requirement + lowers GPA.\n\n" +
        "Use this when the student wants to ACT on the assumption (Confirm it as " +
        "their plan), NOT just ask 'what happens if…' (that's probe_counterfactual). " +
        "isReadOnly: true — proposing stages only; CONFIRMING persists ONLY the " +
        "resulting forward_schedule, never the DPR. The assumption is UNVERIFIED " +
        "until the next DPR (CORE RULE 15).",
    inputSchema: InputSchema,
    isReadOnly: true,
    maxResultChars: 4000,
    async validateInput(input, { session }) {
        if (!session.forwardSchedule && !session.studentDraftPlan) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. " +
                    "Call plan_forward_degree first, then propose a what-if assumption.",
            };
        }
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "No Degree Progress Report loaded. Cannot propose a what-if assumption without DPR data.",
            };
        }
        // D-7 IP-membership guard: withdraw/pass/fail apply ONLY to courses the
        // student is currently taking (type "IP" in courseHistory). Reject:
        //   • course not on DPR at all → likely planned; tell student to drop it
        //   • course on DPR but not IP → already completed / graded
        const id = canonicalizeCourseId(input.courseId);
        const row = session.degreeProgressReport.courseHistory.find(
            (r) => canonicalizeCourseId(`${r.subject} ${r.catalogNbr}`) === id,
        );
        if (!row) {
            return {
                ok: false,
                userMessage:
                    `${input.courseId} isn't a course you're currently taking — ` +
                    `it looks planned, not in progress. To remove a planned course, drop it instead.`,
            };
        }
        if (row.type !== "IP") {
            return {
                ok: false,
                userMessage:
                    `Withdraw and pass/fail apply only to a course you're currently taking (in progress). ` +
                    `${input.courseId} is already completed.`,
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Propose a current-term IP-course what-if assumption (withdraw / pass / " +
        "fail). Re-solves against a synthetic in-memory DPR + returns the proposed " +
        "plan + a labeled whatIfAssumption marker (hedges + registrar-window " +
        "caveat). The student Confirms it to persist ONLY the resulting schedule " +
        "(never the DPR); it stays unverified until the next DPR (CORE RULE 15).",
    async call(input, { session }): Promise<ProposeWhatIfAssumptionOutput> {
        const currentPlan = session.forwardSchedule ?? session.studentDraftPlan;
        if (!currentPlan) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: ["No forward plan found. Call plan_forward_degree first."],
                conflicts: [{ kind: "no_plan", detail: "session.forwardSchedule is absent" }],
                state: "infeasible-draft",
                whatIfAssumption: {
                    courseId: input.courseId,
                    outcome: input.outcome,
                    label: whatIfAssumptionLabel(input.courseId, input.outcome),
                    hedges: [],
                },
            };
        }

        const now = input.now ? new Date(input.now) : undefined;
        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: input.courseId,
            outcome: input.outcome,
            ...(now ? { now } : {}),
        });

        const marker: WhatIfAssumptionMarker = {
            courseId: input.courseId,
            outcome: input.outcome,
            label: whatIfAssumptionLabel(input.courseId, input.outcome),
            hedges: result.hedges,
            ...(result.windowCaveat ? { windowCaveat: result.windowCaveat } : {}),
        };

        return {
            feasible: result.feasible,
            diff: result.diff,
            consequences: result.consequences,
            ...(result.conflicts ? { conflicts: result.conflicts } : {}),
            proposedSchedule: result.schedule,
            ...(result.planDiff ? { planDiff: result.planDiff } : {}),
            state: result.state,
            whatIfAssumption: marker,
            ...(result.windowCaveat ? { windowCaveat: result.windowCaveat } : {}),
        };
    },
    summarizeResult(output) {
        const lines: string[] = [];
        const wa = output.whatIfAssumption;
        const verdict = output.feasible ? "VALID" : "INFEASIBLE";
        lines.push(`PROPOSE WHAT-IF ASSUMPTION (${wa.outcome}) — ${verdict}`);
        lines.push(`Assumption: ${wa.label}`);
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
        if (output.windowCaveat) {
            lines.push(`Registrar-window caveat: ${output.windowCaveat}`);
        }
        if (wa.hedges.length > 0) {
            lines.push("Hedges:");
            for (const h of wa.hedges) {
                lines.push(`  • ${h}`);
            }
        }
        return lines.join("\n");
    },
});
