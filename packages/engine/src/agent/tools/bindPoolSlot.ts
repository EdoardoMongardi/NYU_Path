/**
 * Phase 14 Task 6 — bind_pool_slot tool (isReadOnly: true).
 *
 * Binds a specific course to a requirement-pool placeholder slot.
 * Returns a PlanChangeOutcome + warningLevel WITHOUT committing state.
 * The student must call confirm_plan_change to apply the binding.
 *
 * Decision #28: Late-binding for choose_n elective pools.
 * Decision #38: PlaceholderSlot tagged union; RequirementPoolSlot kind.
 *
 * Validation pipeline (in order — same as bind_free_elective plus pool-specific checks):
 *  1. session.forwardSchedule exists
 *  2. Slot at slotId exists, is a placeholder, inner kind is RequirementPoolSlot (has poolBinding)
 *  3. courseId must be in slot.poolBinding.candidates
 *  4. Course exists in catalog (session.courses)
 *  5. Course is offered in slot's term (termsOffered check)
 *  6. Prereqs satisfied via isPrereqSatisfied (Decision #4)
 *  7. Course not already bound elsewhere in the schedule
 *  8. Choose_n constraint: Σ over remaining pool members ≥ requiredCount − 1
 *  9. Compute new workloadWeight via classifyWorkloadTier (Decisions #24+#35)
 * 10. Hypothetical plan with binding applied + Stage 7 revalidation
 * 11. Compute balanceImpact via classifyBalanceDelta (Decision #25)
 * 12. Determine warningLevel
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
import type { WarningLevel } from "./bindFreeElective.js";

// ---------------------------------------------------------------------------
// Output type
// ---------------------------------------------------------------------------

export interface BindPoolSlotOutput extends PlanChangeOutcome {
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
        .describe("The placeholderId of the requirement-pool slot to bind."),
    courseId: z
        .string()
        .min(1)
        .describe("The courseId to bind (must be in the slot's poolBinding.candidates)."),
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
// Helper: check choose_n constraint after binding
// Check that Σ remaining pool candidates (across all pool slots of same poolId
// after this binding) >= requiredCount − 1.
//
// "requiredCount" is inferred from the number of placeholder slots sharing
// this poolId in the schedule — each needs one distinct candidate.
// After binding slotId → courseId, the remaining pool slots need at least
// (remaining_count) distinct candidates.
// ---------------------------------------------------------------------------

function checkPoolConstraint(
    schedule: ForwardSchedule,
    targetSlotId: string,
    boundCourseId: string,
): { ok: boolean; detail?: string } {
    // Collect all pool slots in the schedule for the same poolId
    let targetPoolId: string | null = null;
    let targetCandidates: string[] = [];

    // First pass: find the target slot's poolId
    for (const sem of schedule.semesters) {
        for (const slot of sem.slots) {
            if (
                slot.kind === "placeholder" &&
                slot.placeholderId === targetSlotId &&
                slot.poolBinding
            ) {
                targetPoolId = slot.poolBinding.poolId;
                targetCandidates = slot.poolBinding.candidates;
                break;
            }
        }
        if (targetPoolId) break;
    }

    if (!targetPoolId) return { ok: true }; // slot not found — validation handled elsewhere

    // Second pass: collect all OTHER unbound pool slots for the same poolId
    const otherPoolSlots: Array<{ candidates: string[]; placeholderId: string }> = [];
    for (const sem of schedule.semesters) {
        for (const slot of sem.slots) {
            if (
                slot.kind === "placeholder" &&
                slot.placeholderId !== targetSlotId &&
                slot.poolBinding?.poolId === targetPoolId
            ) {
                otherPoolSlots.push({
                    candidates: slot.poolBinding.candidates,
                    placeholderId: slot.placeholderId ?? "",
                });
            }
        }
    }

    if (otherPoolSlots.length === 0) {
        // No other slots in this pool — no constraint to satisfy
        return { ok: true };
    }

    // After binding boundCourseId to targetSlotId, check if each remaining
    // pool slot still has at least one remaining candidate (excluding boundCourseId
    // since it's now consumed).
    const consumedCourses = new Set<string>([boundCourseId]);

    for (const other of otherPoolSlots) {
        const available = other.candidates.filter((c) => !consumedCourses.has(c));
        if (available.length === 0) {
            return {
                ok: false,
                detail:
                    `Binding "${boundCourseId}" to slot "${targetSlotId}" leaves pool slot ` +
                    `"${other.placeholderId}" with no remaining candidates — choose_n constraint violated.`,
            };
        }
        // Greedily consume the first available candidate for this slot
        consumedCourses.add(available[0]!);
    }

    return { ok: true };
}

// ---------------------------------------------------------------------------
// Helper: build a hypothetical ForwardSchedule with the pool slot bound
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

export const bindPoolSlotTool = buildTool({
    name: "bind_pool_slot",
    description:
        "Preview binding a specific course to a requirement-pool placeholder slot " +
        "in the forward schedule WITHOUT committing the change.\n\n" +
        "The courseId MUST be in the slot's poolBinding.candidates. " +
        "Validates: course in candidates, course exists, offered in term, prereqs satisfied, " +
        "not already bound, and choose_n constraint is still satisfiable after binding. " +
        "Revalidates the plan via the graduation-path validator and returns a warningLevel.\n\n" +
        "Use this BEFORE calling confirm_plan_change with a bindPoolSlot mutation. " +
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
                    "Call plan_forward_degree first, then bind pool slots.",
            };
        }
        if (!session.degreeProgressReport) {
            return {
                ok: false,
                userMessage:
                    "No Degree Progress Report loaded. Cannot validate pool-slot binding without DPR data.",
            };
        }
        return { ok: true };
    },
    prompt: () =>
        "Preview binding a course to a requirement-pool placeholder slot. " +
        "The course must be in poolBinding.candidates. Validates prereqs, offering, " +
        "choose_n constraint, duplicates, and computes a warning level. " +
        "Returns warningLevel: none | mild | strong based on workload + balance impact.",
    async call(input, { session }): Promise<BindPoolSlotOutput> {
        const schedule = session.forwardSchedule!;
        const dpr = session.degreeProgressReport!;
        const courses = session.courses ?? [];
        const prereqsAll = session.prereqs ?? [];

        // --- 1. Check slot exists ---
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

        // --- 2. Slot must be a requirement-pool kind (has poolBinding) ---
        if (!parentSlot.poolBinding) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [
                    `Slot "${input.slotId}" is not a requirement-pool slot. ` +
                    `Use bind_free_elective for free-credit slots.`,
                ],
                conflicts: [{ kind: "wrong_slot_kind", detail: "Slot has no poolBinding — not a requirement-pool slot" }],
                warningLevel: "strong",
            };
        }

        const poolBinding = parentSlot.poolBinding;

        // --- 3. courseId must be in poolBinding.candidates ---
        if (!poolBinding.candidates.includes(input.courseId)) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [
                    `Course "${input.courseId}" is not in the candidate list for pool slot "${input.slotId}". ` +
                    `Available candidates: ${poolBinding.candidates.join(", ")}.`,
                ],
                conflicts: [{ kind: "not_in_pool_candidates", detail: `${input.courseId} not in pool ${poolBinding.poolId}` }],
                warningLevel: "strong",
            };
        }

        // --- 4. Course exists in catalog ---
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

        // --- 5. Course is offered in slot's term ---
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

        // --- 6. Prereqs satisfied ---
        const prereqEntry = prereqsAll.find((p) => p.course === input.courseId);
        if (prereqEntry) {
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
            }
        }

        // --- 7. Course not already bound elsewhere ---
        if (isCourseAlreadyBound(schedule, input.courseId)) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [`Course "${input.courseId}" is already placed in the schedule.`],
                conflicts: [{ kind: "duplicate_courseId", detail: `${input.courseId} already bound` }],
                warningLevel: "strong",
            };
        }

        // --- 8. Choose_n constraint check ---
        const poolConstraint = checkPoolConstraint(schedule, input.slotId, input.courseId);
        if (!poolConstraint.ok) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: [poolConstraint.detail ?? "Pool constraint violated."],
                conflicts: [{ kind: "pool_constraint_violation", detail: poolConstraint.detail ?? "" }],
                warningLevel: "strong",
            };
        }

        // --- 9. Compute new workloadWeight ---
        const prereqsEntryForWeight = prereqEntry
            ? { prereqGroups: prereqEntry.prereqGroups }
            : undefined;

        const workloadResult = classifyWorkloadTier({
            courseId: input.courseId,
            satisfiesRules: parentSlot.satisfiesRules,
            majorRuleKinds: new Map(),
            schoolCoreRuleIds: new Set(),
            generalCategoryRuleIds: new Set(),
            bulletinTitle: course.title,
            bulletinKeywords: [],
            prereqsEntry: prereqsEntryForWeight,
            isOptional: parentSlot.optional,
        });

        // --- 10. Build hypothetical concrete slot ---
        const concreteSlot: ScheduleSlotSpecificPlanned = {
            kind: "specific_planned",
            courseId: input.courseId,
            title: course.title,
            credits: parentSlot.credits,
            satisfiesRules: parentSlot.satisfiesRules,
            reason: `Bound from pool: ${poolBinding.poolId} / ${poolBinding.satisfiesRule}`,
            rationale: parentSlot.rationale,
            flexibility: parentSlot.flexibility,
            downstreamImpact: parentSlot.downstreamImpact,
            workloadTier: workloadResult.tier,
            workloadWeight: workloadResult.weight,
            bindingState: "bound",
            confidence: parentSlot.confidence,
            isCriticalPath: parentSlot.isCriticalPath,
        };

        // --- 11. Build hypothetical plan + Stage 7 revalidation ---
        const hypotheticalSchedule = buildHypotheticalSchedule(
            schedule,
            input.slotId,
            concreteSlot,
        );

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

        // --- 12. Compute balanceImpact ---
        const loadStyle = session.schedulePreferences?.loadStyle ?? "balanced";
        const beforeScore = computeBalanceScore(schedule.semesters, loadStyle);
        const afterScore = computeBalanceScore(hypotheticalSchedule.semesters, loadStyle);
        const balanceClassification = classifyBalanceDelta(beforeScore, afterScore);

        // --- 13. Determine warningLevel ---
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
            bindingDetail:
                `${input.courseId} (${workloadResult.tier}, weight=${workloadResult.weight.toFixed(2)}) ` +
                `→ pool slot ${input.slotId} [pool: ${poolBinding.poolId}] in ${slotTerm}`,
        };
    },
    summarizeResult(output) {
        const lines: string[] = [];
        lines.push(`BIND POOL SLOT — feasible: ${output.feasible}, warning: ${output.warningLevel}`);
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
