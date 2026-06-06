/**
 * Phase 2 P2.6 — Trade-off engine.
 *
 * `buildPlanDiff` (planChangeHelpers.ts) computes credit / balance / workload /
 * graduation-term deltas correctly, but historically hard-coded empty arrays for
 * the *consequence* fields — `newRequiresPetition`, `removedRequiresPetition`,
 * `newUnmetRequirements`, `cascadedShifts`, `newAssumptions`. The renderer
 * (`explainPlanDiff.ts`) reads exactly those fields, so a plan change that newly
 * requires a petition / drops a satisfied requirement / cascades a prereq into a
 * different term was never surfaced to the student.
 *
 * This module fills the gap by diffing the two `ForwardSchedule` objects
 * directly. Pure, deterministic, no I/O.
 */

import type { ForwardSchedule, Assumption, PlanDiff } from "@nyupath/shared";

export interface PlanTradeOffs {
    /** courseIds requiring a petition in AFTER but not BEFORE. */
    newRequiresPetition: string[];
    /** courseIds requiring a petition in BEFORE but not AFTER. */
    removedRequiresPetition: string[];
    /** rIds covered by a bound (specific_planned) slot in BEFORE but no longer in AFTER. */
    newUnmetRequirements: string[];
    /** courses present in both plans that changed term. */
    cascadedShifts: PlanDiff["cascadedShifts"];
    /** assumptions present in AFTER but not BEFORE. */
    newAssumptions: Assumption[];
}

/**
 * Diff the consequence (trade-off) fields between two schedules.
 *
 * `before` may be undefined (first plan ever computed); in that case every
 * "before"-derived set is empty — so `newRequiresPetition` / `newAssumptions`
 * reflect all of AFTER's contents, while `removedRequiresPetition`,
 * `newUnmetRequirements`, and `cascadedShifts` are empty.
 */
export function diffPlanTradeOffs(
    before: ForwardSchedule | undefined,
    after: ForwardSchedule,
): PlanTradeOffs {
    // --- Petitions ---------------------------------------------------------
    const beforePetitions = petitionCourses(before);
    const afterPetitions = petitionCourses(after);
    const newRequiresPetition = sortedDiff(afterPetitions, beforePetitions);
    const removedRequiresPetition = sortedDiff(beforePetitions, afterPetitions);

    // --- newUnmetRequirements ---------------------------------------------
    // A requirement that had a bound satisfier in BEFORE and lost it in AFTER.
    const beforeCovered = coveredRIds(before);
    const afterCovered = coveredRIds(after);
    const newUnmetRequirements = sortedDiff(beforeCovered, afterCovered);

    // --- cascadedShifts ----------------------------------------------------
    // Courses present in BOTH plans whose term changed. Deterministic order.
    const beforeTerms = termByCourse(before);
    const afterTerms = termByCourse(after);
    const cascadedShifts: PlanTradeOffs["cascadedShifts"] = [];
    for (const [courseId, beforeTerm] of beforeTerms) {
        const afterTerm = afterTerms.get(courseId);
        if (afterTerm !== undefined && afterTerm !== beforeTerm) {
            cascadedShifts.push({
                courseId,
                fromTerm: beforeTerm,
                toTerm: afterTerm,
                becauseOf: "plan re-solved after the change",
            });
        }
    }
    cascadedShifts.sort((a, b) => (a.courseId < b.courseId ? -1 : a.courseId > b.courseId ? 1 : 0));

    // --- newAssumptions ----------------------------------------------------
    const beforeAssumptions = before?.assumptions ?? [];
    const newAssumptions = after.assumptions.filter(
        a => !beforeAssumptions.some(b => assumptionsMatch(a, b)),
    );

    return {
        newRequiresPetition,
        removedRequiresPetition,
        newUnmetRequirements,
        cascadedShifts,
        newAssumptions,
    };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set of `courseId` of specific_planned slots flagged `requiresPetition`. */
function petitionCourses(plan: ForwardSchedule | undefined): Set<string> {
    const out = new Set<string>();
    if (!plan) return out;
    for (const sem of plan.semesters) {
        for (const slot of sem.slots) {
            if (slot.kind === "specific_planned" && slot.requiresPetition === true) {
                out.add(slot.courseId);
            }
        }
    }
    return out;
}

/** Union of every specific_planned slot's `satisfiesRules` (rIds with a bound satisfier). */
function coveredRIds(plan: ForwardSchedule | undefined): Set<string> {
    const out = new Set<string>();
    if (!plan) return out;
    for (const sem of plan.semesters) {
        for (const slot of sem.slots) {
            if (slot.kind === "specific_planned") {
                for (const rId of slot.satisfiesRules) out.add(rId);
            }
        }
    }
    return out;
}

/** `courseId → term` over specific_planned + in_progress slots. */
function termByCourse(plan: ForwardSchedule | undefined): Map<string, string> {
    const out = new Map<string, string>();
    if (!plan) return out;
    for (const sem of plan.semesters) {
        for (const slot of sem.slots) {
            if (slot.kind === "specific_planned" || slot.kind === "in_progress") {
                // First placement wins (a course should appear once; defensively
                // keep the earliest-encountered term for determinism).
                if (!out.has(slot.courseId)) out.set(slot.courseId, sem.term);
            }
        }
    }
    return out;
}

/** Elements of `a` not in `b`, sorted ascending for deterministic output. */
function sortedDiff(a: Set<string>, b: Set<string>): string[] {
    const out: string[] = [];
    for (const x of a) {
        if (!b.has(x)) out.push(x);
    }
    out.sort();
    return out;
}

/**
 * Match two assumptions for "is this AFTER-assumption already present in BEFORE".
 *
 * `IP_COURSE_COMPLETION` is the only solver-emitted variant; it is identified by
 * `(type, courseId)`. For the Phase-14-emitted variants (LLM_RANKED_ALTERNATIVE,
 * HEURISTIC_MAPPING) there is no single stable key, so fall back to structural
 * deep-equality on the whole object.
 */
function assumptionsMatch(a: Assumption, b: Assumption): boolean {
    if (a.type !== b.type) return false;
    if (a.type === "IP_COURSE_COMPLETION" && b.type === "IP_COURSE_COMPLETION") {
        return a.courseId === b.courseId;
    }
    return deepEqual(a, b);
}

/** Order-independent structural equality (sufficient for Assumption shapes). */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return a === b;
    if (typeof a !== "object") return false;

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        return a.every((x, i) => deepEqual(x, b[i]));
    }

    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const aKeys = Object.keys(ao);
    const bKeys = Object.keys(bo);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}
