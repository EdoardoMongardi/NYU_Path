/**
 * Phase 13 Decision #28 — Late-binding for choose_n elective pools.
 *
 * `placePoolSlot()` reserves credits + tier for a pool slot WITHOUT
 * committing to a specific courseId. The slot enters with
 * bindingState: "unbound" and bound: undefined.
 *
 * `promotePoolSlotToConcrete()` takes a pool slot + a candidate
 * courseId and produces a bound slot. Validates the courseId is in
 * poolBinding.candidates and emits the bound shape. Used by Stage 7
 * when prereq chains or feasibility require a specific courseId.
 *
 * Phase 14's `bindPoolSlot` tool is the student-facing entry point;
 * this module provides the solver-side mechanics.
 *
 * Pure functions — no I/O, no module state.
 */

import type { PoolBinding, RequirementPoolSlot } from "@nyupath/shared";

export interface PlacePoolSlotArgs {
    poolBinding: PoolBinding;
    credits: number;
    /** Term where the placeholder is reserved. */
    term: string;
    placeholderId: string;
}

/**
 * Reserve a pool slot without committing to a specific courseId.
 * The returned slot has bindingState: "unbound" and bound: undefined.
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
    placeholder: RequirementPoolSlot;
    chosenCourseId: string;
}

export interface PromotePoolSlotResult {
    success: boolean;
    /**
     * When success === true: the bound slot (RequirementPoolSlot with
     * bindingState: "bound" and bound: chosenCourseId).
     * Phase 14's binding tool then transitions the parent ScheduleSlot
     * from kind:"placeholder" to kind:"specific_planned" — that transition
     * is the binding tool's responsibility, not this helper's.
     */
    bound?: RequirementPoolSlot;
    /** Failure reason when success === false. */
    rejectedBecause?: "not-in-candidates" | "already-bound";
}

/**
 * Attempt to bind a pool slot to a specific courseId.
 * Returns failure if the courseId is not in candidates or slot is already bound.
 */
export function promotePoolSlotToConcrete(args: PromotePoolSlotArgs): PromotePoolSlotResult {
    const { placeholder, chosenCourseId } = args;

    // Guard: already bound
    if (placeholder.bindingState === "bound") {
        return { success: false, rejectedBecause: "already-bound" };
    }

    // Guard: not in candidates
    if (!placeholder.candidates.includes(chosenCourseId)) {
        return { success: false, rejectedBecause: "not-in-candidates" };
    }

    const bound: RequirementPoolSlot = {
        ...placeholder,
        bindingState: "bound",
        bound: chosenCourseId,
    };

    return { success: true, bound };
}
