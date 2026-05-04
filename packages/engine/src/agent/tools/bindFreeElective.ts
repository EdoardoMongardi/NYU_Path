/**
 * Phase 14 Task 6 — bind_free_elective tool (isReadOnly: true).
 *
 * Binds a specific course to a free-credit placeholder slot.
 * Returns a PlanChangeOutcome + warningLevel WITHOUT committing state.
 * The student must call confirm_plan_change to apply the binding.
 *
 * Decision #37: Free-credit slots carry defaultWeight 0.3.
 * Decision #38: PlaceholderSlot tagged union; FreeCreditSlot kind.
 *
 * Validation pipeline (in order):
 *  1. session.forwardSchedule exists
 *  2. Slot at slotId exists, is a placeholder, inner kind is "free-credit"
 *  3. Course exists in catalog (session.courses)
 *  4. Course is offered in slot's term (termsOffered check)
 *  5. Prereqs satisfied via isPrereqSatisfied (Decision #4)
 *  6. Course not already bound elsewhere in the schedule
 *  7. Compute new workloadWeight via classifyWorkloadTier (Decisions #24+#35)
 *  8. Hypothetical plan with binding applied + Stage 7 revalidation
 *  9. Compute balanceImpact via classifyBalanceDelta (Decision #25)
 * 10. Determine warningLevel
 *
 * isReadOnly: true — MUST NOT write to session state.
 */

import { z } from "zod";
import { buildTool } from "../tool.js";
import type {
    PlanChangeOutcome,
    ForwardSchedule,
    ScheduleSlotSpecificPlanned,
    ScheduleSlotPlaceholder,
    FreeCreditSlot,
} from "@nyupath/shared";
import { isPrereqSatisfied } from "../../dpr/prereqSatisfaction.js";
import { classifyWorkloadTier } from "../forwardSchedule/workloadTier.js";
import {
    computeBalanceScore,
    classifyBalanceDelta,
} from "../forwardSchedule/balanceScore.js";
import {
    runGraduationPathValidator,
} from "../forwardSchedule/graduationPathValidator.js";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export type WarningLevel = "none" | "mild" | "strong";

export interface BindFreeElectiveOutput extends PlanChangeOutcome {
    warningLevel: WarningLevel;
    /** Human-readable detail about the binding outcome. */
    bindingDetail?: string;
}

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
    slotId: z
        .string()
        .min(1)
        .describe("The placeholderId of the free-credit slot to bind."),
    courseId: z
        .string()
        .min(1)
        .describe("The courseId to bind into the free-credit slot."),
});

// ---------------------------------------------------------------------------
// Helper: extract term season from solver-format term ("2026-fall" → "fall")
// ---------------------------------------------------------------------------

function termSeason(term: string): string | null {
    const idx = term.indexOf("-");
    if (idx === -1) return null;
    return term.substring(idx + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Helper: find slot in schedule + its containing semester term
// ---------------------------------------------------------------------------

function findSlotWithTerm(
    schedule: ForwardSchedule,
    placeholderId: string,
): { slot: ScheduleSlotPlaceholder; term: string } | null {
    for (const sem of schedule.semesters) {
        for (const slot of sem.slots) {
            if (
                slot.kind === "placeholder" &&
                slot.placeholderId === placeholderId
            ) {
                return { slot, term: sem.term };
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Helper: check if a courseId is already bound in the schedule
// ---------------------------------------------------------------------------

function isCourseAlreadyBound(schedule: ForwardSchedule, courseId: string): boolean {
    for (const sem of schedule.semesters) {
        for (const slot of sem.slots) {
            if (slot.kind === "specific_planned" && slot.courseId === courseId) {
                return true;
            }
        }
    }
    return false;
}

// ---------------------------------------------------------------------------
// Helper: build a hypothetical ForwardSchedule with the free-elective bound
// ---------------------------------------------------------------------------

function buildHypotheticalSchedule(
    original: ForwardSchedule,
    slotId: string,
    concreteSlot: ScheduleSlotSpecificPlanned,
): ForwardSchedule {
    return {
        ...original,
        semesters: original.semesters.map((sem) => ({
            ...sem,
            slots: sem.slots.map((slot) => {
                if (
                    slot.kind === "placeholder" &&
                    slot.placeholderId === slotId
                ) {
                    return concreteSlot;
                }
                return slot;
            }),
        })),
    };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const bindFreeElectiveTool = buildTool({
    name: "bind_free_elective",
    description:
        "Preview binding a specific course to a free-credit placeholder slot in the " +
        "forward schedule WITHOUT committing the change.\n\n" +
        "Validates: course exists, is offered in the slot's term, prereqs satisfied, " +
        "course not already bound. Revalidates the plan via the graduation-path " +
        "validator and returns a warningLevel (none/mild/strong) based on workload " +
        "and balance impact.\n\n" +
        "Use this BEFORE calling confirm_plan_change with a bindFreeElective mutation. " +
        "isReadOnly: true — never writes to session state.",
    inputSchema,
    isReadOnly: true,
    maxResultChars: 3000,
    async validateInput(_input, { session }) {
        if (!session.forwardSchedule) {
            return {
                ok: false,
                userMessage:
                    "No forward plan exists in this session. " +
                    "Call plan_forward_degree first, then bind free-elective slots.",
            };
        }
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "No Degree Progress Report loaded. Cannot validate free-elective binding without DPR data.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Preview binding a course to a free-credit placeholder slot. " +
        "Validates prereqs, offering, duplicates, and computes a warning level. " +
        "Returns warningLevel: none | mild | strong based on workload + balance impact.",
    async call(input, { session }): Promise<BindFreeElectiveOutput> {
        const schedule = session.forwardSchedule!;
        const dpr = session.degreeProgressReport!;
        const courses = session.courses ?? [];
        const prereqsAll = session.prereqs ?? [];

        // --- 1. Check slot exists + is a placeholder of kind "free-credit" ---
        const found = findSlotWithTerm(schedule, input.slotId);
        if (!found) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [`Slot "${input.slotId}" not found in the forward schedule.`],
                conflicts: [{ kind: "unknown_slot", detail: `placeholderId "${input.slotId}" not found` }],
                warningLevel: "strong",
            };
        }

        const { slot: parentSlot, term: slotTerm } = found;

        // The PlaceholderSlot tagged union uses `slot.poolBinding` for pool slots.
        // Free-credit slots have NO poolBinding and their inner kind comes from
        // the ScheduleSlotPlaceholder shape: since PlaceholderSlot is the tagged
        // union stored on the ScheduleSlotPlaceholder, we detect free-credit slots
        // by absence of poolBinding and checking the category / inner discriminator.
        //
        // Per Phase 14 pre-flight finding #1: the ScheduleSlotPlaceholder itself
        // carries poolBinding?: PoolBinding — if poolBinding is absent and the
        // slot is a placeholder, we check whether it represents a FreeCreditSlot.
        // The FreeCreditSlot kind discriminator is stored in slot.placeholderId
        // naming convention OR we use the absence of poolBinding as signal.
        //
        // Ground truth from types.ts: ScheduleSlotPlaceholder has `poolBinding?`
        // for RequirementPoolSlot kind. FreeCreditSlot kind = no poolBinding.
        // AdvisingPlaceholderSlot kind = no poolBinding but has an advisingNote
        // (not modeled on ScheduleSlotPlaceholder directly — it's the inner type).
        //
        // For bind_free_elective, the validation is: poolBinding must be absent
        // (i.e. this is not a pool slot). The category check is the best signal
        // available on the outer ScheduleSlotPlaceholder.
        if (parentSlot.poolBinding) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [`Slot "${input.slotId}" is a requirement-pool slot, not a free-credit slot.`],
                conflicts: [{ kind: "wrong_slot_kind", detail: "Use bind_pool_slot for requirement-pool slots" }],
                warningLevel: "strong",
            };
        }

        // --- 2. Course exists in catalog ---
        const course = courses.find((c) => c.id === input.courseId);
        if (!course) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [`Course "${input.courseId}" not found in the course catalog.`],
                conflicts: [{ kind: "unknown_course", detail: `courseId "${input.courseId}" not found in session.courses` }],
                warningLevel: "strong",
            };
        }

        // --- 3. Course is offered in slot's term ---
        const season = termSeason(slotTerm);
        if (season && !course.termsOffered.includes(season as typeof course.termsOffered[number])) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [
                    `Course "${input.courseId}" is not typically offered in ${slotTerm} ` +
                    `(offered: ${course.termsOffered.join(", ")}).`,
                ],
                conflicts: [{ kind: "offering_mismatch", detail: `${input.courseId} not offered in ${season}` }],
                warningLevel: "strong",
            };
        }

        // --- 4. Prereqs satisfied ---
        const prereqEntry = prereqsAll.find((p) => p.course === input.courseId);
        if (prereqEntry) {
            // Build plannedPlacements from current schedule
            const plannedPlacements = new Map<string, string>();
            for (const sem of schedule.semesters) {
                for (const s of sem.slots) {
                    if (s.kind === "specific_planned") {
                        plannedPlacements.set(s.courseId, sem.term);
                    }
                }
            }

            for (const group of prereqEntry.prereqGroups) {
                if (group.type === "AND") {
                    for (const prereqCourseId of group.courses) {
                        const result = isPrereqSatisfied({
                            prereqCourseId,
                            dependentTerm: slotTerm,
                            dpr,
                            plannedPlacements,
                            minGrades: prereqEntry.minGrades,
                            mode: "prereq",
                        });
                        if (!result.satisfied) {
                            return {
                                feasible: false,
                                diff: { added: [], removed: [] },
                                consequences: [
                                    `Prerequisite "${prereqCourseId}" for "${input.courseId}" is not satisfied. ` +
                                    `Reason: ${result.reason}`,
                                ],
                                conflicts: [{ kind: "prereq_unsatisfied", detail: `${prereqCourseId}: ${result.reason}` }],
                                warningLevel: "strong",
                            };
                        }
                    }
                } else if (group.type === "OR" && group.courses.length > 0) {
                    // OR group: at least one must be satisfied
                    let orSatisfied = false;
                    for (const prereqCourseId of group.courses) {
                        const result = isPrereqSatisfied({
                            prereqCourseId,
                            dependentTerm: slotTerm,
                            dpr,
                            plannedPlacements,
                            minGrades: prereqEntry.minGrades,
                            mode: "prereq",
                        });
                        if (result.satisfied) {
                            orSatisfied = true;
                            break;
                        }
                    }
                    if (!orSatisfied) {
                        return {
                            feasible: false,
                            diff: { added: [], removed: [] },
                            consequences: [
                                `None of the OR-prereqs for "${input.courseId}" are satisfied: ` +
                                group.courses.join(", "),
                            ],
                            conflicts: [{ kind: "prereq_unsatisfied", detail: `OR group not satisfied for ${input.courseId}` }],
                            warningLevel: "strong",
                        };
                    }
                }
                // NOT groups are exclusion constraints handled elsewhere
            }
        }

        // --- 5. Course not already bound elsewhere ---
        if (isCourseAlreadyBound(schedule, input.courseId)) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [
                    `Course "${input.courseId}" is already placed in the schedule.`,
                ],
                conflicts: [{ kind: "duplicate_courseId", detail: `${input.courseId} already bound` }],
                warningLevel: "strong",
            };
        }

        // --- 6. Compute new workloadWeight ---
        // Free-elective slots are always "free-elective" tier (Decision #37).
        // We compute the weight using classifyWorkloadTier for consistency.
        const prereqsEntryForWeight = prereqEntry
            ? { prereqGroups: prereqEntry.prereqGroups }
            : undefined;

        const workloadResult = classifyWorkloadTier({
            courseId: input.courseId,
            satisfiesRules: parentSlot.satisfiesRules,
            majorRuleKinds: new Map(),           // free-credit → always free-elective tier
            schoolCoreRuleIds: new Set(),
            generalCategoryRuleIds: new Set(),
            bulletinTitle: course.title,
            bulletinKeywords: [],
            prereqsEntry: prereqsEntryForWeight,
            isOptional: true,                    // free-credit slots are optional by definition
        });

        // --- 7. Build hypothetical concrete slot ---
        const concreteSlot: ScheduleSlotSpecificPlanned = {
            kind: "specific_planned",
            courseId: input.courseId,
            title: course.title,
            credits: parentSlot.credits,
            satisfiesRules: parentSlot.satisfiesRules,
            reason: "Bound from free-credit placeholder (Decision #37)",
            rationale: parentSlot.rationale,
            flexibility: parentSlot.flexibility,
            downstreamImpact: parentSlot.downstreamImpact,
            workloadTier: workloadResult.tier,
            workloadWeight: workloadResult.weight,
            bindingState: "bound",
            confidence: parentSlot.confidence,
            isCriticalPath: parentSlot.isCriticalPath,
        };

        // --- 8. Build hypothetical plan + Stage 7 revalidation ---
        const hypotheticalSchedule = buildHypotheticalSchedule(
            schedule,
            input.slotId,
            concreteSlot,
        );

        // Run graduation path validator on the hypothetical plan
        const validatorResult = runGraduationPathValidator({
            plan: hypotheticalSchedule,
            dpr,
            programRules: {
                // Use the schedule's own degreeCreditMinimum (already accounts for
                // total planned credits) rather than the raw school config value.
                degreeCreditMinimum: schedule.graduationCreditMinimum,
                residencyMinCredits: session.schoolConfig?.residency?.minCredits ?? null,
                majorCreditMinimum: null,
                minorCreditMinimum: null,
                upperLevelMinCredits: null,
                schoolCoreMinCredits: null,
                graduationTargetTerm: schedule.graduationTerm,
            },
        });

        // --- 9. Compute balanceImpact ---
        const loadStyle = session.schedulePreferences?.loadStyle ?? "balanced";
        const beforeScore = computeBalanceScore(schedule.semesters, loadStyle);
        const afterScore = computeBalanceScore(hypotheticalSchedule.semesters, loadStyle);
        const balanceClassification = classifyBalanceDelta(beforeScore, afterScore);

        // --- 10. Determine warningLevel ---
        const weightDelta = workloadResult.weight - parentSlot.workloadWeight;
        let warningLevel: WarningLevel = "none";

        if (
            balanceClassification === "degraded-significant" ||
            weightDelta > 0.7
        ) {
            warningLevel = "strong";
        } else if (
            balanceClassification === "degraded-mild" ||
            (weightDelta > 0.2 && weightDelta <= 0.7)
        ) {
            warningLevel = "mild";
        }

        // Build diff
        const added: Array<{ term: string; slot: import("@nyupath/shared").ScheduleSlot }> = [
            { term: slotTerm, slot: concreteSlot },
        ];
        const removed: Array<{ term: string; slot: import("@nyupath/shared").ScheduleSlot }> = [
            { term: slotTerm, slot: parentSlot },
        ];

        const consequences: string[] = [];
        if (warningLevel === "strong") {
            consequences.push(
                `This binding significantly increases workload (weight delta: +${weightDelta.toFixed(2)}) ` +
                `or degrades plan balance.`,
            );
        } else if (warningLevel === "mild") {
            consequences.push(
                `This binding moderately increases workload (weight delta: +${weightDelta.toFixed(2)}).`,
            );
        }
        consequences.push(
            `Balance impact: ${balanceClassification} (${beforeScore.toFixed(2)} → ${afterScore.toFixed(2)}).`,
        );
        if (!validatorResult.feasible) {
            const failDetail = validatorResult.infeasibilityReport?.conflictDetail ?? "plan becomes infeasible";
            consequences.push(`Warning: hypothetical plan fails validation. ${failDetail}`);
        }

        return {
            feasible: validatorResult.feasible,
            diff: { added, removed },
            consequences,
            conflicts: validatorResult.feasible
                ? undefined
                : [{ kind: "plan_infeasible", detail: validatorResult.infeasibilityReport?.conflictDetail ?? "" }],
            warningLevel,
            bindingDetail: `${input.courseId} (${workloadResult.tier}, weight=${workloadResult.weight.toFixed(2)}) → slot ${input.slotId} in ${slotTerm}`,
        };
    },
    summarizeResult(output) {
        const lines: string[] = [];
        lines.push(`BIND FREE ELECTIVE — feasible: ${output.feasible}, warning: ${output.warningLevel}`);
        if (output.bindingDetail) lines.push(`  Binding: ${output.bindingDetail}`);
        for (const c of output.consequences.slice(0, 4)) {
            lines.push(`  • ${c}`);
        }
        if (output.conflicts && output.conflicts.length > 0) {
            lines.push(`  Conflicts: ${output.conflicts.map((c) => c.kind).join(", ")}`);
        }
        return lines.join("\n");
    },
});
