// ============================================================
// sectionMaterialization/sectionReplanBridge.ts — Phase 38 Phase A
// ============================================================
// The section→structure ESCALATION bridge (§2④). Runs ONLY when the
// student rejects every feasible schedule, or none is feasible. It is
// the LAST resort after the §2①–③ picker (materialize_feasible).
//
// This file (Phase A1 + A2) is PURE: it classifies the section-layer
// failure and generates an ordered list of candidate plan-mutation
// batches (rung 1 within-term swap → rung 2 cross-term move → rung 3
// bounded multi-course move). It does NOT re-solve or validate —
// A3 (`validateResolutionCandidates`, a separate step) runs each batch
// through the EXISTING propose-path chain (applyMutationsToPreferences
// → buildSolverInput → solveForwardSchedule → finalizeForwardSchedule)
// and keeps only `validatorResult.feasible` results. The frozen engine
// contract is never modified — the bridge only CALLS the seam.
//
// Every batch ends (in A3) at `finalizeForwardSchedule`; only a
// valid-clean / valid-with-trade-offs result becomes a proposal. An
// infeasible re-plan is never shipped (CORE philosophy + plan-37 M1/M2).
// ============================================================

import type { PlanMutation } from "@nyupath/shared";

/** Why the section layer couldn't land a schedule (A1 output). */
export type SectionFailureKind = "hard-conflict" | "course-wipe" | "soft-rejection";

export interface SectionFailure {
    kind: SectionFailureKind;
    /** The courses implicated in the failure (to move/swap). */
    courseIds: string[];
}

/** The section-layer signals A1 classifies (from `materialize_feasible`). */
export interface SectionFailureInput {
    /** `materialize_feasible` result `candidates.length`. */
    candidateCount: number;
    /** `materialize_feasible` result `unavailableCourses` (no O/W section). */
    unavailableCourses: string[];
    /** Explicit student rejection — courses whose live sections were all rejected. */
    rejectedCourseIds?: string[];
}

/**
 * A1 — classify the section-layer failure. Returns `null` when there is
 * no failure (feasible candidates exist and nothing was wiped/rejected),
 * so the bridge no-ops and the picker stands. Precedence: an explicit
 * student rejection (active intent) > a course-wipe (a course literally
 * has no section) > a pure time-conflict (zero candidates). Pure.
 */
export function classifySectionFailure(input: SectionFailureInput): SectionFailure | null {
    const rejected = input.rejectedCourseIds ?? [];
    if (rejected.length > 0) {
        return { kind: "soft-rejection", courseIds: [...rejected] };
    }
    if (input.unavailableCourses.length > 0) {
        return { kind: "course-wipe", courseIds: [...input.unavailableCourses] };
    }
    if (input.candidateCount === 0) {
        // Zero conflict-free candidates with no wiped course ⇒ a pure time clash.
        return { kind: "hard-conflict", courseIds: [] };
    }
    return null;
}

/** One candidate resolution: an ordered mutation batch + provenance. */
export interface ResolutionBatch {
    /** 1 = within-term swap, 2 = cross-term move, 3 = multi-course move. */
    rung: 1 | 2 | 3;
    strategy: string;
    /** The plan mutations to apply (re-solved + validated by A3). */
    mutations: PlanMutation[];
    /** Courses this batch relocates/swaps (for disruption ranking in A3). */
    movedCourseIds: string[];
}

export interface LadderContext {
    failure: SectionFailure;
    /** The near term being section-checked (the courses' current term). */
    nearTerm: string;
    /**
     * Later regular terms the courses may move into, nearest-first
     * (D3 — summer/J-term only when the caller opted in + included them).
     */
    laterTerms: string[];
    /**
     * Within-term alternative courses for rung 1 — `courseId → altCourseId`
     * (supplied by the Phase-B swapHook: an alt on the same requirement leaf
     * that is offered + open this term). Omitted ⇒ rung 1 is skipped.
     */
    withinTermAlternatives?: Record<string, string>;
    /** Cap on courses moved together in rung 3 (D4; default 2). */
    multiCourseK?: number;
}

/**
 * A2 — generate the ordered resolution ladder (cheapest first). PURE:
 * it only produces candidate mutation batches; A3 re-solves + validates
 * each and picks the first valid one.
 *
 *   Rung 1 — within-term swap (one per course that has an alternative).
 *   Rung 2 — cross-term move of a single failing course to the nearest
 *            later term.
 *   Rung 3 — a bounded (≤ K) multi-course move when >1 course fails.
 *
 * Courses with no later term to move into yield no rung-2/3 batch.
 */
export function generateResolutionLadder(ctx: LadderContext): ResolutionBatch[] {
    const { failure, nearTerm, laterTerms } = ctx;
    const K = ctx.multiCourseK ?? 2;
    const nearestLater = laterTerms[0];
    const batches: ResolutionBatch[] = [];

    // Rung 1 — within-term swap (only for courses with a supplied alternative).
    const alts = ctx.withinTermAlternatives ?? {};
    for (const courseId of failure.courseIds) {
        const alt = alts[courseId];
        if (alt !== undefined) {
            batches.push({
                rung: 1,
                strategy: `within-term swap ${courseId} → ${alt}`,
                mutations: [{ kind: "swap", drop: courseId, add: alt, term: nearTerm }],
                movedCourseIds: [courseId],
            });
        }
    }

    // Rungs 2 + 3 need a later term to move into.
    if (nearestLater !== undefined) {
        // Rung 2 — single-course cross-term move (one batch per failing course).
        for (const courseId of failure.courseIds) {
            batches.push({
                rung: 2,
                strategy: `move ${courseId} to ${nearestLater}`,
                mutations: [{ kind: "move", courseId, fromTerm: nearTerm, toTerm: nearestLater }],
                movedCourseIds: [courseId],
            });
        }

        // Rung 3 — bounded multi-course move when more than one course fails.
        if (failure.courseIds.length > 1) {
            const moved = failure.courseIds.slice(0, K);
            batches.push({
                rung: 3,
                strategy: `move ${moved.join(" + ")} to ${nearestLater}`,
                mutations: moved.map(courseId => ({
                    kind: "move" as const,
                    courseId,
                    fromTerm: nearTerm,
                    toTerm: nearestLater,
                })),
                movedCourseIds: moved,
            });
        }
    }

    // Cheapest-first (rung ascending); stable within a rung.
    return batches.sort((a, b) => a.rung - b.rung);
}
