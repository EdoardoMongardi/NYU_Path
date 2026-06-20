// ============================================================
// materialize_feasible (Phase 38 Task 0.3) — read-only, structured
// ============================================================
// The deterministic candidate source for the §2.5 hybrid boundary:
// the agent NEVER enumerates schedules or judges validity — it only
// ranks/curates the VERIFIED candidates this tool returns. Enumeration
// + every hard constraint (time conflict, open/waitlist, the §2①(d)
// two-state waitlist backup) + the cheap pre-rank live in the
// deterministic orchestrator (`materializeFeasible`). The tool's
// `outputSchema` locks the engine↔UI contract (Phase 0.3) and is the
// guardrail: `call()` re-validates its own output, so a malformed /
// invalid candidate cannot be emitted.
//
// READ-ONLY: stages nothing, mutates no session state. (Picking +
// confirming a candidate reuses the existing `confirm_section_combination`
// metadata-attach path — that is the only write.)
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import {
    materializeFeasible as runMaterializeFeasible,
    materializeFeasibleResultSchema,
    type MaterializeFeasibleResult,
} from "../sectionMaterialization/materializeFeasible.js";
import { FoseCache } from "../sectionMaterialization/foseCache.js";
import { resolveIpSectionsToBlocks } from "../sectionMaterialization/ipSections.js";

// Module-level cache shared across calls in a session (5-min TTL).
const SHARED_FOSE_CACHE = new FoseCache<unknown[]>();

const inputSchema = z.object({
    targetTerm: z
        .string()
        .min(1)
        .describe(
            'Solver-format term identifier, e.g. "2026-fall". Must match a ' +
            "non-locked semester in session.forwardSchedule.",
        ),
    ipSections: z
        .array(
            z.object({
                courseId: z.string(),
                crn: z.string().optional(),
                meets: z.string().optional(),
                meetingTimes: z.string().optional(),
            }),
        )
        .optional()
        .describe(
            "The sections of courses the student is ALREADY REGISTERED for in " +
            "this term (their in-progress/IP courses). The DPR does NOT show " +
            "which section, so ASK the student and pass each course's CRN (looked " +
            "up live) or its meeting times here — so the feasible schedules avoid " +
            "time-conflicting against what they're already enrolled in. Omit if " +
            "the term has no already-registered courses (or the student doesn't " +
            "know them — the result will hedge).",
        ),
});

export const materializeFeasibleTool = buildTool<typeof inputSchema, MaterializeFeasibleResult>({
    name: "materialize_feasible",
    description:
        "Returns the VERIFIED feasible section schedules for ONE non-locked " +
        "future semester (read-only). Pulls live FOSE sections for each " +
        "specific_planned course, groups multi-component courses (lecture + " +
        "recitation/lab) and enumerates every conflict-free schedule that is " +
        "open or waitlist-with-a-registrable-open-backup, then pre-ranks " +
        "(open before waitlist). Each candidate is a structured, schema-" +
        "validated fact — the agent ranks/curates the top 5 over this set and " +
        "MUST NOT invent a schedule, CRN, professor, or pairing the tool did " +
        "not return. Surfaces cite-or-hedge notes: NYU's data does not say " +
        "which recitation pairs with which lecture (verify in Albert) and does " +
        "not expose the waitlist queue length (check Albert).",
    inputSchema,
    isReadOnly: true,
    maxResultChars: 6000,
    outputSchema: materializeFeasibleResultSchema,
    async validateInput(input, { session }) {
        if (!session.forwardSchedule) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. Call " +
                    "`plan_forward_degree` first, then check section feasibility " +
                    "for one of its non-locked semesters.",
            };
        }
        const sem = session.forwardSchedule.semesters.find(s => s.term === input.targetTerm);
        if (!sem) {
            const terms = session.forwardSchedule.semesters.map(s => s.term).join(", ");
            return {
                ok: false,
                userMessage:
                    `Target term "${input.targetTerm}" does not match any semester ` +
                    `in the current forward plan. Available terms: ${terms || "(none)"}.`,
            };
        }
        if (sem.locked) {
            return {
                ok: false,
                userMessage:
                    `Cannot check sections for a locked term ${input.targetTerm}; ` +
                    `choose a future non-locked semester.`,
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Return the verified feasible section schedules for ONE non-locked " +
        "semester. The result is the agent's ONLY candidate source — rank + " +
        "explain the top schedules; never fabricate one not in the set.",
    async call(input, { session }): Promise<MaterializeFeasibleResult> {
        const schedule = session.forwardSchedule!;
        const semester = schedule.semesters.find(s => s.term === input.targetTerm)!;

        const courseIds: string[] = [];
        const ipCourseIds: string[] = [];
        for (const slot of semester.slots) {
            if (slot.kind === "specific_planned") courseIds.push(slot.courseId);
            else if (slot.kind === "in_progress") ipCourseIds.push(slot.courseId);
        }

        if (courseIds.length === 0) {
            return {
                state: "unavailable",
                termCode: input.targetTerm,
                message:
                    `No concrete courses are scheduled in ${input.targetTerm} (only ` +
                    `placeholders, IP, or empty). Bind placeholders to specific ` +
                    `courses first, then re-check section feasibility.`,
                candidates: [],
                truncated: false,
                hedges: [],
                unavailableCourses: [],
            };
        }

        const schedulingPreferences =
            session.schedulePreferences?.schedulingPreferences ?? undefined;

        // #2 — already-registered (IP) courses occupy fixed times the remaining
        // courses must avoid. Resolve any student-supplied sections → blocks.
        const ipSections = input.ipSections ?? [];
        const { blocks: occupiedBlocks, unresolved } = ipSections.length > 0
            ? await resolveIpSectionsToBlocks(ipSections, input.targetTerm, { cache: SHARED_FOSE_CACHE })
            : { blocks: [], unresolved: [] as string[] };

        const result = await runMaterializeFeasible({
            termCode: input.targetTerm,
            courseIds,
            schedulingPreferences,
            ...(occupiedBlocks.length > 0 ? { occupiedBlocks } : {}),
            cache: SHARED_FOSE_CACHE,
        });

        // Elicit-or-hedge for IP courses whose section we don't know: any IP
        // course in this term the student didn't supply a (resolvable) section
        // for is a time-conflict blind spot — name it + ask, never silently
        // ignore it (the schedules below can't be conflict-checked against it).
        const suppliedIds = new Set(ipSections.map(s => s.courseId));
        const unknownIp = [
            ...ipCourseIds.filter(id => !suppliedIds.has(id)),
            ...unresolved,
        ].filter((v, i, a) => a.indexOf(v) === i);
        const withIpHedge: MaterializeFeasibleResult = unknownIp.length > 0
            ? {
                  ...result,
                  hedges: [
                      ...result.hedges,
                      `You're already registered for ${unknownIp.join(", ")} in ${input.targetTerm}, ` +
                      `but I don't know which section(s) — your DPR doesn't show the CRN/times. Tell me ` +
                      `their CRNs (or meeting times) so I can avoid time conflicts; otherwise verify the ` +
                      `schedules below against your actual Albert registration.`,
                  ],
              }
            : result;

        // Guardrail (§2.5): the tool re-validates its own output against the
        // locked schema before returning — a malformed candidate cannot escape.
        return materializeFeasibleResultSchema.parse(withIpHedge) as MaterializeFeasibleResult;
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(`MATERIALIZE_FEASIBLE — term: ${out.termCode}, state: ${out.state}`);
        lines.push(out.message);
        if (out.candidates.length > 0) {
            lines.push("");
            lines.push(`Verified candidate schedules (ranked best-first):`);
            for (const c of out.candidates.slice(0, 5)) {
                const sects = c.courses
                    .flatMap(cc => cc.components.map(comp => `${cc.code}#${comp.crn}(${comp.schd}/${comp.status})`))
                    .join(", ");
                lines.push(`  • ${c.candidateId}: ${sects} — ${c.preRankReason} [${c.weeklyHours.toFixed(1)}h/wk]`);
            }
            if (out.candidates.length > 5) lines.push(`  … (${out.candidates.length - 5} more — see-more available)`);
        }
        for (const h of out.hedges) {
            lines.push("");
            lines.push(`⚠ ${h}`);
        }
        return lines.join("\n");
    },
});
