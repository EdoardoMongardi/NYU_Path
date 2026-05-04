// ============================================================
// materialize_sections + confirm_section_combination (Phase 15 Task 7)
// ============================================================
// Architecture §7.2 two-step write contract — mirrors the
// `update_profile` / `confirm_profile_update` pair (see
// `updateProfile.ts` for the canonical reference).
//
//   1. `materialize_sections.call()`  — STAGES every conflict-free
//      combination from the Task-6 orchestrator into
//      `session.pendingMaterializations`, keyed by a deterministic
//      `proposalId`. `isReadOnly: true` — does NOT mutate
//      `session.forwardSchedule`.
//
//   2. `confirm_section_combination.call({ proposalId })` — looks up
//      the staged combination, walks the matching specific_planned
//      slots in `session.forwardSchedule.semesters[targetTerm]`, and
//      adds the concrete-section fields (crn, meetingPatterns,
//      instructor, schd, sectionNumber) in-place per the strict
//      additive extension to `ScheduleSlotSpecificPlanned`. The
//      pending entry is consumed (deleted) on success.
//
// Decision #19 (course-swap cascade) is currently STUBBED — the
// `swapHook` returns null for every call. Wiring it into the
// structural solver's swap path is deferred to Phase 16.
// ============================================================

import { z } from "zod";
import { buildTool } from "../tool.js";
import { materializeSections as runMaterializer } from "../sectionMaterialization/materialize.js";
import { FoseCache } from "../sectionMaterialization/foseCache.js";
import type {
    MaterializationResult,
    SectionView,
} from "../sectionMaterialization/types.js";
import type {
    ForwardSchedule,
    ForwardSemester,
    ScheduleSlot,
} from "@nyupath/shared";

// ---- Module-level cache shared across `materialize_sections` calls ----
//
// The orchestrator already maintains a default singleton cache, but
// constructing one here lets us pass it explicitly so tests can inject
// their own. Reusing one instance across calls within a session means
// the second `materialize_sections` for the same termCode hits the
// cache for already-fetched courseIds.
const SHARED_FOSE_CACHE = new FoseCache<unknown[]>();

// ============================================================
// Tool 1: materialize_sections (read-only, staging)
// ============================================================

const materializeInputSchema = z.object({
    targetTerm: z
        .string()
        .min(1)
        .describe(
            'Solver-format term identifier, e.g. "2026-fall". Must match a ' +
            "non-locked semester in session.forwardSchedule.",
        ),
});

export interface MaterializeSectionsOutput extends MaterializationResult {
    /**
     * Staged proposalIds — one per conflict-free combination, ordered
     * to match `semester.combinations`. Returned only when
     * `state === "full"` and at least one combination exists. Each
     * entry corresponds to an entry in `session.pendingMaterializations`.
     */
    proposals?: Array<{
        proposalId: string;
        sections: SectionView[];
        weeklyHours: number;
    }>;
    /** Echoed for `confirm_section_combination` to read on follow-up. */
    targetTerm: string;
}

export const materializeSectionsTool = buildTool({
    name: "materialize_sections",
    description:
        "Stages section-level proposals for one non-locked future semester. " +
        "Pulls FOSE per concrete-course slot in the target term, runs the " +
        "Phase-15 orchestrator (availability gate + scheduling-preferences " +
        "filter + conflict-free enumeration + rerank), and assigns each " +
        "combination a proposalId. Returns the orchestrator's full result " +
        "(including `schedulingPreferenceCheck` for the visa validator) plus " +
        "the proposalId list.\n\n" +
        "DOES NOT pin any CRNs onto the schedule. To apply a chosen " +
        "combination, the student must explicitly confirm and the agent " +
        "must call `confirm_section_combination` with the chosen proposalId. " +
        "Two-step write per §7.2.\n\n" +
        "Operates ONLY on `kind: \"specific_planned\"` slots in the target " +
        "semester — placeholders are skipped (no concrete course to look " +
        "up). If the target semester contains no specific_planned slots " +
        "the result has `state: \"unavailable\"` and an explanatory " +
        "message; nothing is staged.",
    inputSchema: materializeInputSchema,
    isReadOnly: true,
    maxResultChars: 4000,
    async validateInput(input, { session }) {
        if (!session.forwardSchedule) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. Call " +
                    "`plan_forward_degree` first, then materialize sections " +
                    "for one of its non-locked semesters.",
            };
        }
        const sem = session.forwardSchedule.semesters.find(
            (s) => s.term === input.targetTerm,
        );
        if (!sem) {
            const availableTerms = session.forwardSchedule.semesters
                .map((s) => s.term)
                .join(", ");
            return {
                ok: false,
                userMessage:
                    `Target term "${input.targetTerm}" does not match any ` +
                    `semester in the current forward plan. Available terms: ` +
                    `${availableTerms || "(none)"}.`,
            };
        }
        if (sem.locked) {
            return {
                ok: false,
                userMessage:
                    `Cannot materialize a locked term ${input.targetTerm}; ` +
                    `choose a future non-locked semester.`,
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Stage section-level combinations for ONE non-locked semester in " +
        "the forward plan. Returns proposalIds the student picks from; " +
        "to apply the chosen combination call `confirm_section_combination`.",
    async call(input, { session }): Promise<MaterializeSectionsOutput> {
        const schedule = session.forwardSchedule!;
        const semester = schedule.semesters.find((s) => s.term === input.targetTerm)!;

        // Build the FOSE keyword list from specific_planned slots only.
        // Placeholders have no concrete courseId yet — `materialize_sections`
        // skips them. (Section-level materialization for a placeholder
        // requires the student to bind it via `bind_pool_slot` /
        // `bind_free_elective` first.)
        const courseIds: string[] = [];
        for (const slot of semester.slots) {
            if (slot.kind === "specific_planned") {
                courseIds.push(slot.courseId);
            }
        }

        if (courseIds.length === 0) {
            // No concrete courses to look up — return an "unavailable"
            // result with a clear message and stage nothing. We do NOT
            // touch session.pendingMaterializations in this branch.
            return {
                state: "unavailable",
                message:
                    `No concrete courses are scheduled in ${input.targetTerm} ` +
                    `(target semester contains only placeholders or is empty). ` +
                    `Bind the placeholders to specific courses first, then ` +
                    `re-run materialize_sections.`,
                schedulingPreferenceCheck: { kind: "absent" },
                targetTerm: input.targetTerm,
            };
        }

        // Phase 15 Task 7 stub for Decision #19 — the structural-solver
        // swap path is deferred to Phase 16. Returning null for every
        // input means course wipes surface cleanly via the orchestrator's
        // `dropped` array (no alternative is added).
        // TODO Phase 16: wire into the structural solver's swap path.
        const swapHook: (
            failedCourseId: string,
            reason: "unavailable" | "scheduling-prefs-eliminated",
        ) => Promise<string | null> = async () => null;

        const schedulingPreferences =
            session.schedulePreferences?.schedulingPreferences ?? undefined;

        const result = await runMaterializer({
            termCode: input.targetTerm,
            courseIds,
            swapHook,
            schedulingPreferences,
            cache: SHARED_FOSE_CACHE,
        });

        // For non-"full" states (unavailable / partial) the orchestrator
        // has nothing to stage — pass the result through verbatim.
        if (result.state !== "full" || !result.semester) {
            return { ...result, targetTerm: input.targetTerm };
        }

        // Stage every combination in `pendingMaterializations`. We use a
        // deterministic id (`prop_${termCode}_${1-indexed}`) so that
        // tests + the model can refer to a stable identifier without
        // re-reading FOSE. Combinations are already ranked best-first by
        // the orchestrator (Task 6's step 9).
        if (!session.pendingMaterializations) {
            session.pendingMaterializations = new Map();
        }

        const proposals: NonNullable<MaterializeSectionsOutput["proposals"]> = [];
        for (let i = 0; i < result.semester.combinations.length; i++) {
            const combo = result.semester.combinations[i]!;
            const proposalId = `prop_${input.targetTerm}_${i + 1}`;
            session.pendingMaterializations.set(proposalId, {
                termCode: input.targetTerm,
                sections: combo.sections,
            });
            proposals.push({
                proposalId,
                sections: combo.sections,
                weeklyHours: combo.weeklyHours,
            });
        }

        return {
            ...result,
            proposals,
            targetTerm: input.targetTerm,
        };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(`MATERIALIZE_SECTIONS — term: ${out.targetTerm}, state: ${out.state}`);
        lines.push(out.message);
        if (out.proposals && out.proposals.length > 0) {
            lines.push(``);
            lines.push(`Staged ${out.proposals.length} proposal(s):`);
            for (const p of out.proposals.slice(0, 5)) {
                const sectionList = p.sections
                    .map((s) => `${s.courseId}#${s.crn}`)
                    .join(", ");
                lines.push(
                    `  • ${p.proposalId}: ${sectionList} (${p.weeklyHours.toFixed(2)}h/wk)`,
                );
            }
            if (out.proposals.length > 5) {
                lines.push(`  … (${out.proposals.length - 5} more)`);
            }
            lines.push(``);
            lines.push(
                `To apply one, call confirm_section_combination with the ` +
                `chosen proposalId.`,
            );
        }
        if (out.schedulingPreferenceCheck) {
            lines.push(``);
            lines.push(
                `schedulingPreferenceCheck: ${out.schedulingPreferenceCheck.kind}` +
                (out.schedulingPreferenceCheck.kind === "violated"
                    ? ` — ${out.schedulingPreferenceCheck.reason}`
                    : ""),
            );
        }
        return lines.join("\n");
    },
});

// ============================================================
// Tool 2: confirm_section_combination (write — applies a staged proposal)
// ============================================================

const confirmInputSchema = z.object({
    proposalId: z
        .string()
        .min(1)
        .describe(
            "The proposalId returned by a prior `materialize_sections` call. " +
            "Each id is single-use — confirming the same id twice is rejected.",
        ),
});

export interface ConfirmSectionCombinationOutput {
    status: "applied";
    termCode: string;
    /** Number of slots that were updated with concrete-section fields. */
    sectionsBound: number;
    /** The post-apply forward schedule (same instance — mutated in-place). */
    schedule: ForwardSchedule;
    /**
     * Per-section apply note: which slot a section was matched to OR a
     * "missed" note when no specific_planned slot for that courseId
     * existed in the target semester. Defensive — should never be
     * non-empty in practice because `materialize_sections` is the only
     * upstream stager.
     */
    notes: string[];
}

/**
 * Locate the specific_planned slot in `semester.slots` whose courseId
 * matches `section.courseId`. Returns null if no match (defensive — a
 * staged section should always map to a slot, but the upstream
 * `materialize_sections` only filters by kind, so a swap of the
 * structural plan between stage + confirm could surface a miss).
 */
function findSpecificPlannedSlot(
    semester: ForwardSemester,
    courseId: string,
): ScheduleSlot | null {
    for (const slot of semester.slots) {
        if (slot.kind === "specific_planned" && slot.courseId === courseId) {
            return slot;
        }
    }
    return null;
}

export const confirmSectionCombinationTool = buildTool({
    name: "confirm_section_combination",
    description:
        "Pins a specific section combination onto the forward schedule. " +
        "Looks up a `proposalId` previously staged by `materialize_sections`, " +
        "walks the target semester's specific_planned slots, and adds the " +
        "concrete-section fields (crn, meetingPatterns, instructor, schd, " +
        "sectionNumber) IN-PLACE per the §15.7 additive extension. The " +
        "pending entry is consumed on success — confirming the same " +
        "proposalId twice is rejected.",
    inputSchema: confirmInputSchema,
    isReadOnly: false,
    maxResultChars: 2000,
    async validateInput(input, { session }) {
        if (!session.forwardSchedule) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. Call " +
                    "`plan_forward_degree` then `materialize_sections` first.",
            };
        }
        const pending = session.pendingMaterializations?.get(input.proposalId);
        if (!pending) {
            return {
                ok: false,
                userMessage:
                    `No pending section proposal with id "${input.proposalId}". ` +
                    `Either \`materialize_sections\` was not called for the ` +
                    `enclosing term, or this proposal was already consumed by ` +
                    `a prior \`confirm_section_combination\` call.`,
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Apply a previously-staged section combination by id. Mutates the " +
        "forward schedule's specific_planned slots in-place with concrete " +
        "CRN + meeting-time + instructor data.",
    async call(input, { session }): Promise<ConfirmSectionCombinationOutput> {
        const schedule = session.forwardSchedule!;
        const pending = session.pendingMaterializations!.get(input.proposalId)!;
        const semester = schedule.semesters.find((s) => s.term === pending.termCode);

        const notes: string[] = [];
        let sectionsBound = 0;

        if (!semester) {
            // Defensive: the structural plan has been mutated since the
            // proposal was staged. Surface a note + consume the entry so
            // the student isn't stuck on a dead id.
            notes.push(
                `Target semester ${pending.termCode} no longer exists in the ` +
                `forward schedule; nothing to bind. Re-run plan_forward_degree.`,
            );
        } else {
            for (const section of pending.sections) {
                const slot = findSpecificPlannedSlot(semester, section.courseId);
                if (!slot || slot.kind !== "specific_planned") {
                    notes.push(
                        `No specific_planned slot for ${section.courseId} in ` +
                        `${pending.termCode}; section CRN ${section.crn} not bound.`,
                    );
                    continue;
                }
                // Mutate the slot in-place with the additive concrete-section
                // fields (Phase 15 Task 7). All fields are optional on
                // ScheduleSlotSpecificPlanned so this is a strict
                // additive extension — bindingState already === "bound".
                slot.crn = section.crn;
                slot.meetingPatterns = section.meetingPatterns;
                slot.instructor = section.instructor;
                slot.schd = section.schd;
                slot.sectionNumber = section.section;
                sectionsBound++;
            }
        }

        // Consume the pending entry so a second confirm with the same
        // proposalId returns the "no pending" path via validateInput.
        // Mirrors `confirm_profile_update`'s idempotency contract.
        session.pendingMaterializations!.delete(input.proposalId);

        return {
            status: "applied" as const,
            termCode: pending.termCode,
            sectionsBound,
            schedule,
            notes,
        };
    },
    summarizeResult(out) {
        const lines: string[] = [];
        lines.push(
            `CONFIRM_SECTION_COMBINATION — APPLIED to ${out.termCode}: ` +
            `${out.sectionsBound} slot(s) updated with CRN + meeting times.`,
        );
        for (const n of out.notes) {
            lines.push(`  • ${n}`);
        }
        return lines.join("\n");
    },
});
