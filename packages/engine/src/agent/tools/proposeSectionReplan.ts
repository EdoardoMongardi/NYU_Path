// ============================================================
// propose_section_replan (Phase 38 Task E3) — read-only escalation
// ============================================================
// The agent calls this when `materialize_feasible` returns NO feasible
// candidate, or the student rejects every feasible schedule. It runs
// the §2⑤ BOUNDED outer loop (materialize near-term → escalate via the
// resolution ladder → re-materialize the new near-term → bounded), all
// re-solved through the FROZEN validator, and returns:
//   - kind "replan"  → the recommended plan mutations + a narration
//     summary (the route re-derives + stages them through the EXISTING
//     plan_proposal → Confirm chokepoint);
//   - kind "no-op"   → the honest binding-constraint reason (the agent
//     relays it; never invents a re-plan);
//   - kind "feasible"→ the near term was schedulable as-is.
//
// READ-ONLY: it computes a proposal; the student confirms via the
// canvas (the route stages the mutations). The frozen engine is only
// CALLED through the bridge, never modified.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { runSectionReplanLoop } from "../sectionMaterialization/sectionReplanBridge.js";
import { buildSectionReplanLoopDeps } from "../sectionMaterialization/sectionReplanWiring.js";
import type { PlanMutation } from "@nyupath/shared";

const inputSchema = z.object({
    rejectedCourseIds: z
        .array(z.string())
        .optional()
        .describe(
            "Courses whose live sections the student rejected this term (e.g. " +
            "every CS421 professor). Omit for the pure no-feasible-candidate case.",
        ),
});

export interface ProposeSectionReplanOutput {
    kind: "feasible" | "replan" | "no-op";
    /** Narration for the agent to relay to the student. */
    summary: string;
    /** Present for "no-op" — the binding constraint (verbatim, never invented). */
    reason?: string;
    /** Present for "replan" — the recommended mutations (route stages these). */
    mutations?: PlanMutation[];
    movedCourseIds?: string[];
    gradTermChanged?: boolean;
}

export const proposeSectionReplanTool = buildTool<typeof inputSchema, ProposeSectionReplanOutput>({
    name: "propose_section_replan",
    description:
        "Escalate when `materialize_feasible` found NO feasible schedule for the " +
        "near term, or the student rejected every feasible one. Runs the " +
        "deterministic resolution ladder (within-term swap → move the " +
        "un-schedulable course to a later term → bounded multi-course re-plan), " +
        "re-solving through the frozen graduation validator, and surfaces a VALID " +
        "re-plan as a Confirm-able proposal on the canvas — or an honest 'no valid " +
        "re-plan keeps your graduation target' when none exists. You NEVER compute " +
        "or invent the re-plan yourself; relay this tool's verdict.",
    inputSchema,
    isReadOnly: true,
    maxResultChars: 2000,
    async validateInput(_input, { session }) {
        if (!session.forwardSchedule) {
            return { ok: false, userMessage: "No forward plan exists yet. Call `plan_forward_degree` first." };
        }
        if (!session.degreeProgressReport) {
            return { ok: false, userMessage: "No DPR loaded — I can't re-solve a re-plan without it." };
        }
        return { ok: true };
    },
    prompt: () =>
        "Escalate a section-infeasible / all-rejected near term into a VALID, " +
        "Confirm-able structural re-plan (or an honest no-op). Never invent the plan.",
    async call(input, { session }): Promise<ProposeSectionReplanOutput> {
        const plan = session.forwardSchedule!;
        const dpr = session.degreeProgressReport!;
        const deps = buildSectionReplanLoopDeps(session, dpr);
        const result = await runSectionReplanLoop(plan, deps, {
            ...(input.rejectedCourseIds ? { rejectedCourseIds: input.rejectedCourseIds } : {}),
        });

        if (result.kind === "feasible") {
            return {
                kind: "feasible",
                summary: "The near term is schedulable as planned — no structural re-plan is needed.",
            };
        }
        if (result.kind === "no-op") {
            return { kind: "no-op", summary: result.reason, reason: result.reason };
        }
        // replan
        const moved = result.movedCourseIds.join(", ");
        const gradNote = result.gradTermChanged
            ? ` Heads up: this shifts your graduation to ${result.gradTerm}.`
            : " Your graduation term is unchanged.";
        return {
            kind: "replan",
            summary:
                `Found a valid re-plan: move ${moved} so the near term becomes schedulable.${gradNote} ` +
                `It's on the canvas as a proposal — click Confirm to apply it.`,
            mutations: result.mutations,
            movedCourseIds: result.movedCourseIds,
            gradTermChanged: result.gradTermChanged,
        };
    },
    summarizeResult(out) {
        const lines = [`PROPOSE_SECTION_REPLAN — ${out.kind}`, out.summary];
        if (out.kind === "replan" && out.movedCourseIds) {
            lines.push(`moved: ${out.movedCourseIds.join(", ")}; gradTermChanged: ${out.gradTermChanged ? "yes" : "no"}`);
        }
        return lines.join("\n");
    },
});
