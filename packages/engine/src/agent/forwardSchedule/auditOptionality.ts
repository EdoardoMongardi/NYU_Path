/**
 * Phase 13 Decision #33 — Audited optionality. A slot is droppable
 * iff removing it preserves all global constraints:
 *   - degree-credit-minimum
 *   - school-residency
 *   - major-credit-minimum
 *   - upper-level-credit count
 *   - F-1 floor across affected terms
 *   - graduation-target-term (trivially passes — dropping a slot
 *     does not alter the target; documented per spec)
 *   - forward-feasibility (Decision #27 screen result)
 *
 * All constraints are evaluated; failures are accumulated into
 * blockingConstraints (not short-circuited on first failure).
 *
 * Pure function — no I/O, no module state.
 */

import type { ScheduleSlot, ForwardSchedule } from "@nyupath/shared";

export interface AuditOptionalityArgs {
    slot: ScheduleSlot;
    plan: ForwardSchedule;
    programRules: {
        degreeCreditMinimum: number;
        residencyMinCredits: number | null;
        majorCreditMinimum: number | null;
        upperLevelMinCredits: number | null;
        graduationTargetTerm: string;
    };
    /** F-1 floor (typically 12) when student is on F-1 visa, else null. */
    f1Floor: number | null;
    /** Per-term credits AFTER the slot's removal (caller pre-computes). */
    perTermCreditsAfterRemoval: Map<string, number>;
    /** Forward-feasibility screen result for the post-removal plan. */
    forwardFeasibilityAfterRemoval: boolean;
}

export interface AuditOptionalityResult {
    droppable: boolean;
    blockingConstraints?: string[];
}

/**
 * Determine whether a slot may be dropped without violating any global
 * program constraint. Returns {droppable: true} when all checks pass,
 * or {droppable: false, blockingConstraints: [...]} otherwise.
 */
export function canDropSlot(args: AuditOptionalityArgs): AuditOptionalityResult {
    const {
        slot,
        plan,
        programRules,
        f1Floor,
        perTermCreditsAfterRemoval,
        forwardFeasibilityAfterRemoval,
    } = args;

    const blocking: string[] = [];
    const slotCredits = getSlotCredits(slot);

    // --- 1. Degree-credit-minimum ---
    const totalCredits = plan.semesters.reduce((s, sem) => s + sem.plannedCredits, 0);
    const postRemovalTotal = totalCredits - slotCredits;
    if (postRemovalTotal < programRules.degreeCreditMinimum) {
        blocking.push(
            `degree-credit-minimum: post-removal total ${postRemovalTotal} < required ${programRules.degreeCreditMinimum}`
        );
    }

    // --- 2. School-residency ---
    // Approximation: all _planned/completed slots count as residency-eligible.
    // Phase 14 may refine this to suffix-based eligibility.
    // When residencyMinCredits is null, no residency rule exists → skip.
    if (programRules.residencyMinCredits !== null) {
        const residencyPost = totalCredits - slotCredits;
        if (residencyPost < programRules.residencyMinCredits) {
            blocking.push(
                `residency: post-removal eligible credits ${residencyPost} < required ${programRules.residencyMinCredits} (approximation: all planned credits treated as residency-eligible)`
            );
        }
    }

    // --- 3. Major-credit-minimum ---
    if (programRules.majorCreditMinimum !== null) {
        if (slotContributesMajorCredits(slot)) {
            // Approximate: count all major-tier slots in plan.
            const majorCredits = countMajorCredits(plan);
            const majorPost = majorCredits - slotCredits;
            if (majorPost < programRules.majorCreditMinimum) {
                blocking.push(
                    `major-credit-minimum: post-removal major credits ${majorPost} < required ${programRules.majorCreditMinimum}`
                );
            }
        }
    }

    // --- 4. Upper-level-credit count ---
    if (programRules.upperLevelMinCredits !== null) {
        if (slotIsUpperLevel(slot)) {
            const upperCredits = countUpperLevelCredits(plan);
            const upperPost = upperCredits - slotCredits;
            if (upperPost < programRules.upperLevelMinCredits) {
                blocking.push(
                    `upper-level-credits: post-removal upper-level credits ${upperPost} < required ${programRules.upperLevelMinCredits}`
                );
            }
        }
    }

    // --- 5. F-1 floor across affected terms ---
    if (f1Floor !== null) {
        for (const [term, creditsAfter] of perTermCreditsAfterRemoval) {
            if (creditsAfter < f1Floor) {
                blocking.push(
                    `f1-floor: term ${term} would have ${creditsAfter} credits after removal, below F-1 floor of ${f1Floor}`
                );
            }
        }
    }

    // --- 6. Graduation-target-term ---
    // Dropping a slot does not move the graduation target term.
    // Always passes. (Per spec: documented and trivially true.)

    // --- 7. Forward-feasibility ---
    if (!forwardFeasibilityAfterRemoval) {
        blocking.push(
            `forward-feasibility: post-removal plan fails the forward-feasibility screen (Decision #27)`
        );
    }

    if (blocking.length === 0) {
        return { droppable: true };
    }
    return { droppable: false, blockingConstraints: blocking };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getSlotCredits(slot: ScheduleSlot): number {
    return slot.credits;
}

/** Returns true if the slot has a workloadTier that counts toward major credits. */
function slotContributesMajorCredits(slot: ScheduleSlot): boolean {
    if (slot.kind !== "specific_planned" && slot.kind !== "placeholder") return false;
    return slot.workloadTier === "major-required" || slot.workloadTier === "major-elective";
}

/** Sum of credits across all specific_planned + placeholder slots with major tiers. */
function countMajorCredits(plan: ForwardSchedule): number {
    let total = 0;
    for (const sem of plan.semesters) {
        for (const s of sem.slots) {
            if (slotContributesMajorCredits(s)) {
                total += s.credits;
            }
        }
    }
    return total;
}

/** Infer upper-level status from a slot's courseId number.
 *  Upper-level = course number ≥ 3000 (a broad convention; Phase 14 may refine).
 *  Non-numeric course number tail → assume NOT upper-level (safe conservative).
 */
function slotIsUpperLevel(slot: ScheduleSlot): boolean {
    if (slot.kind !== "specific_planned" && slot.kind !== "placeholder") return false;
    const courseId = "courseId" in slot ? slot.courseId : undefined;
    if (!courseId) return false;
    const m = courseId.match(/[- ](\d+)[A-Za-z]*\s*$/);
    if (!m) return false;
    const num = parseInt(m[1], 10);
    return !isNaN(num) && num >= 3000;
}

/** Sum of credits across all upper-level specific_planned + placeholder slots. */
function countUpperLevelCredits(plan: ForwardSchedule): number {
    let total = 0;
    for (const sem of plan.semesters) {
        for (const s of sem.slots) {
            if (slotIsUpperLevel(s)) {
                total += s.credits;
            }
        }
    }
    return total;
}
