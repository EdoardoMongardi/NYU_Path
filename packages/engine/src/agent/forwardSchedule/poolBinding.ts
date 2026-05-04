/**
 * Phase 13 Decision #28 — Late-binding for choose_n elective pools.
 *
 * `placePoolSlot()` reserves credits + tier for a pool slot WITHOUT
 * committing to a specific courseId. The slot enters with
 * bindingState: "unbound" and bound: undefined.
 *
 * `promotePoolSlotToConcrete()` takes a pool slot + a candidate
 * courseId and produces a ScheduleSlotSpecificPlanned. The parent
 * slot transitions from kind:"placeholder" to kind:"specific_planned"
 * via confirm_plan_change — this helper returns the new concrete slot
 * shape, and the caller (confirm_plan_change / bindPoolSlot) splices it
 * into forwardSchedule.semesters[].slots[].
 *
 * Phase 14's `bindPoolSlot` tool is the student-facing entry point;
 * this module provides the solver-side mechanics.
 *
 * Pure functions — no I/O, no module state.
 */

import type {
    PoolBinding,
    RequirementPoolSlot,
    ScheduleSlotSpecificPlanned,
    ScheduleSlotPlaceholder,
} from "@nyupath/shared";

/**
 * Args for `placePoolSlot`.
 *
 * NOTE: credits / term / placeholderId are NOT consumed by this helper —
 * they live on the parent `ScheduleSlotPlaceholder` that wraps the
 * `RequirementPoolSlot` (the wrapping happens in the caller's
 * placement code, e.g. the Stage 6c solver). Keeping the args interface
 * minimal here prevents callers from passing fields that are silently
 * dropped.
 */
export interface PlacePoolSlotArgs {
    poolBinding: PoolBinding;
}

/**
 * Reserve a pool slot without committing to a specific courseId.
 * The returned slot has bindingState: "unbound" and bound: undefined.
 *
 * Caller wraps the result in a parent `ScheduleSlotPlaceholder`
 * carrying credits / term / placeholderId metadata.
 */
export function placePoolSlot(args: PlacePoolSlotArgs): RequirementPoolSlot {
    const { poolBinding } = args;
    return {
        kind: "requirement-pool",
        ruleId: poolBinding.satisfiesRule,
        candidates: [...poolBinding.candidates],
        constraints: [],
        bindingState: "unbound",
        bound: undefined,
    };
}

export interface PromotePoolSlotArgs {
    /** The parent ScheduleSlotPlaceholder (for credits, rationale, etc.) */
    parentSlot: ScheduleSlotPlaceholder;
    /** The inner RequirementPoolSlot within the parent. */
    placeholder: RequirementPoolSlot;
    chosenCourseId: string;
    /** Title for the concrete slot (lookup from session.courses). */
    courseTitle: string;
}

export interface PromotePoolSlotResult {
    success: boolean;
    /**
     * When success === true: the new ScheduleSlotSpecificPlanned that
     * replaces the parent placeholder slot in forwardSchedule.semesters[].slots[].
     *
     * Phase 14 Task 6 contract: the binding tool (bindPoolSlot) calls this,
     * then confirm_plan_change splices the new slot into the schedule.
     * The RequirementPoolSlot itself is never mutated to a "bound" state;
     * the PARENT placeholder slot is replaced entirely.
     */
    concreteSlot?: ScheduleSlotSpecificPlanned;
    /** Failure reason when success === false. */
    rejectedBecause?: "not-in-candidates" | "already-promoted";
}

/**
 * Attempt to promote a pool slot to a concrete ScheduleSlotSpecificPlanned.
 * Returns failure if the courseId is not in candidates or the parent slot
 * has already been promoted (bindingState is not "unbound" or "candidate-set").
 *
 * Phase 14 Task 6 — binding-tool contract:
 * On success, the caller replaces the placeholder slot with concreteSlot
 * in the ForwardSchedule. The RequirementPoolSlot's "bound" state variant
 * has been removed from the type (Decision #38); this function reflects that
 * by returning a fully-concrete ScheduleSlotSpecificPlanned instead.
 */
export function promotePoolSlotToConcrete(args: PromotePoolSlotArgs): PromotePoolSlotResult {
    const { parentSlot, placeholder, chosenCourseId, courseTitle } = args;

    // Guard: parent slot already has a specific course (would only happen if
    // the caller incorrectly passes a non-placeholder parent).
    if (parentSlot.bindingState !== "placeholder-pending" && parentSlot.bindingState !== "placeholder-deferred") {
        return { success: false, rejectedBecause: "already-promoted" };
    }

    // Guard: not in candidates
    if (!placeholder.candidates.includes(chosenCourseId)) {
        return { success: false, rejectedBecause: "not-in-candidates" };
    }

    // Build the concrete ScheduleSlotSpecificPlanned from the parent placeholder's metadata.
    const concreteSlot: ScheduleSlotSpecificPlanned = {
        kind: "specific_planned",
        courseId: chosenCourseId,
        title: courseTitle,
        credits: parentSlot.credits,
        satisfiesRules: parentSlot.satisfiesRules,
        reason: `Bound from pool: ${placeholder.ruleId}`,
        rationale: parentSlot.rationale,
        flexibility: parentSlot.flexibility,
        downstreamImpact: parentSlot.downstreamImpact,
        workloadTier: parentSlot.workloadTier,
        workloadWeight: parentSlot.workloadWeight,
        bindingState: "bound",
        confidence: parentSlot.confidence,
        isCriticalPath: parentSlot.isCriticalPath,
        ...(parentSlot.optionalReason ? { optionalReason: parentSlot.optionalReason } : {}),
        ...(parentSlot.approvalAuthority ? { approvalAuthority: parentSlot.approvalAuthority } : {}),
    };

    return { success: true, concreteSlot };
}
