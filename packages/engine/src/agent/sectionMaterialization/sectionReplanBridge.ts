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

import type { ForwardSchedule, PlanMutation } from "@nyupath/shared";
import type { ToolSession } from "../tool.js";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import {
    resolveBindMutations,
    applyMutationsToPreferences,
    buildSolverInputWithRulesFromSession,
} from "../forwardSchedule/planChangeHelpers.js";
import { solveForwardSchedule } from "../forwardSchedule/solver.js";
import { finalizeForwardSchedule } from "../forwardSchedule/build.js";

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

// ============================================================
// A3 — validate each candidate through the FROZEN propose-path seam
// ============================================================

/** One batch's verdict from the re-solve (A3 input). */
export interface BatchEvaluation {
    batch: ResolutionBatch;
    feasible: boolean;
    /** The re-solved schedule (present iff feasible). */
    schedule?: ForwardSchedule;
    /** The re-solved graduation term (present iff feasible). */
    gradTerm?: string;
    /** The binding constraint when infeasible (from the validator's report). */
    infeasibility?: { conflictSource: string; conflictDetail: string };
}

/** Evaluate one mutation batch → a verdict. Production = the frozen seam. */
export type BatchEvaluator = (batch: ResolutionBatch) => BatchEvaluation;

/** A feasible, re-solved, validated resolution (A3 output). */
export interface ValidatedResolution {
    batch: ResolutionBatch;
    schedule: ForwardSchedule;
    gradTerm: string;
    /** True when this re-plan pushes the graduation term past the baseline. */
    gradTermChanged: boolean;
    /** How many courses this batch relocated/swapped (disruption metric). */
    movedCount: number;
}

export interface ResolutionResult {
    /** Feasible resolutions, ranked least-disruptive first ([] if none). */
    resolutions: ValidatedResolution[];
    /** A4 — the binding constraint when no resolution is feasible; null otherwise. */
    reason: string | null;
}

/**
 * A3 — run each candidate batch through the EXISTING propose-path chain
 * (via the injected `evaluate`; production wires `makeFrozenSeamEvaluator`)
 * and keep only the feasible results, ranked by disruption: fewest moved
 * courses first, then an unchanged graduation term first, then the
 * cheaper rung. A4 — when none is feasible, return `{ resolutions: [],
 * reason }` carrying the binding constraint from the validator's
 * infeasibility report. Pure (given a pure `evaluate`).
 */
export function validateResolutionCandidates(
    batches: ResolutionBatch[],
    baselineGradTerm: string,
    evaluate: BatchEvaluator,
): ResolutionResult {
    const resolutions: ValidatedResolution[] = [];
    const infeasibilities: Array<{ conflictSource: string; conflictDetail: string }> = [];

    for (const batch of batches) {
        const verdict = evaluate(batch);
        if (verdict.feasible && verdict.schedule && verdict.gradTerm !== undefined) {
            resolutions.push({
                batch,
                schedule: verdict.schedule,
                gradTerm: verdict.gradTerm,
                gradTermChanged: verdict.gradTerm !== baselineGradTerm,
                movedCount: batch.movedCourseIds.length,
            });
        } else if (verdict.infeasibility) {
            infeasibilities.push(verdict.infeasibility);
        }
    }

    // Rank: fewest moves → unchanged grad term → cheaper rung → stable.
    const decorated = resolutions.map((r, i) => ({ r, i }));
    decorated.sort((a, b) => {
        if (a.r.movedCount !== b.r.movedCount) return a.r.movedCount - b.r.movedCount;
        if (a.r.gradTermChanged !== b.r.gradTermChanged) return a.r.gradTermChanged ? 1 : -1;
        if (a.r.batch.rung !== b.r.batch.rung) return a.r.batch.rung - b.r.batch.rung;
        return a.i - b.i;
    });
    const ranked = decorated.map(d => d.r);

    if (ranked.length > 0) {
        return { resolutions: ranked, reason: null };
    }

    // A4 — honest no-op: surface the first informative binding constraint.
    const firstInfeasible = infeasibilities.find(x => x.conflictDetail.trim().length > 0);
    const reason =
        firstInfeasible !== undefined
            ? firstInfeasible.conflictDetail
            : "No valid re-plan keeps your graduation target with these courses next term.";
    return { resolutions: [], reason };
}

/**
 * Production `BatchEvaluator` — runs the EXACT propose-path chain
 * (`proposePlanChange.ts:146-176`): resolveBindMutations →
 * applyMutationsToPreferences → buildSolverInputWithRulesFromSession →
 * solveForwardSchedule → finalizeForwardSchedule, threading the per-school
 * P/F config into the 8th validator axis. The frozen functions are CALLED,
 * never modified.
 */
export function makeFrozenSeamEvaluator(
    session: ToolSession,
    dpr: DegreeProgressReport,
    currentPlan: ForwardSchedule,
): BatchEvaluator {
    return (batch: ResolutionBatch): BatchEvaluation => {
        const resolved = resolveBindMutations(currentPlan, batch.mutations);
        const { prefs } = applyMutationsToPreferences(session.schedulePreferences ?? {}, resolved);
        const { solverInput, validatorRules } = buildSolverInputWithRulesFromSession(session, dpr, prefs);
        const solverOutput = solveForwardSchedule(solverInput);
        const { schedule, validatorResult } = finalizeForwardSchedule(
            solverOutput,
            solverInput,
            dpr,
            validatorRules,
            session.schoolConfig?.passFail,
        );
        if (validatorResult.feasible) {
            return { batch, feasible: true, schedule, gradTerm: schedule.graduationTerm };
        }
        return {
            batch,
            feasible: false,
            infeasibility: validatorResult.infeasibilityReport
                ? {
                      conflictSource: validatorResult.infeasibilityReport.conflictSource,
                      conflictDetail: validatorResult.infeasibilityReport.conflictDetail,
                  }
                : undefined,
        };
    };
}

// ============================================================
// E4 — the §2⑤ BOUNDED outer loop (materialize → escalate → re-materialize)
// ============================================================

/** Injected dependencies for the outer loop (production wires
 *  `materialize_feasible` + the bridge; tests stub both). */
export interface SectionReplanLoopDeps {
    /** Materialize the near-term of a plan → the feasibility signal A1 reads. */
    materialize: (
        plan: ForwardSchedule,
    ) => Promise<{ candidateCount: number; unavailableCourses: string[]; nearTerm: string }>;
    /** Escalate a classified failure on a plan → the ranked validated resolutions (A2+A3). */
    escalate: (failure: SectionFailure, plan: ForwardSchedule, nearTerm: string) => Promise<ResolutionResult>;
}

export interface SectionReplanLoopOptions {
    /** Max escalate↔re-materialize cycles before the honest no-op (default 2). */
    cap?: number;
    /** An explicit student rejection — applied to the FIRST classification only. */
    rejectedCourseIds?: string[];
}

export type SectionReplanLoopResult =
    | { kind: "feasible"; nearTerm: string; cycles: number }
    | {
          kind: "replan";
          /** Accumulated mutations transforming the original plan → finalPlan. */
          mutations: PlanMutation[];
          movedCourseIds: string[];
          finalPlan: ForwardSchedule;
          nearTerm: string;
          cycles: number;
          gradTermChanged: boolean;
          gradTerm: string;
      }
    | { kind: "no-op"; reason: string; cycles: number; nearTerm: string };

/**
 * E4 / §2⑤ — the BOUNDED outer loop. Materialize the near-term; if it's
 * feasible, stop. Otherwise classify the failure and escalate (A2+A3) to a
 * validated re-plan, then RE-materialize the NEW near-term and repeat — so a
 * structural re-plan is never shipped without verifying its new near-term is
 * itself schedulable. Bounded by `cap`: past the cap (or when no valid re-plan
 * exists) it falls to an honest no-op — it can NEVER loop forever.
 *
 * The explicit `rejectedCourseIds` signal applies only to the FIRST
 * classification (the student rejected THIS term's sections); subsequent
 * cycles classify purely on the re-materialized feasibility. The frozen
 * validator is reached only through `deps.escalate` (the injected bridge),
 * so this orchestrator never imports the solver.
 */
export async function runSectionReplanLoop(
    plan: ForwardSchedule,
    deps: SectionReplanLoopDeps,
    opts: SectionReplanLoopOptions = {},
): Promise<SectionReplanLoopResult> {
    const cap = opts.cap ?? 2;
    let current = plan;
    let cycles = 0;
    const mutations: PlanMutation[] = [];
    const moved = new Set<string>();
    let gradTerm = plan.graduationTerm;
    let gradTermChanged = false;

    // Hard upper bound on iterations as a belt-and-suspenders guard against a
    // mis-wired dep — the loop returns on feasible / no-op / cap long before this.
    for (let guard = 0; guard <= cap + 1; guard++) {
        const m = await deps.materialize(current);
        const rejectedCourseIds = cycles === 0 ? opts.rejectedCourseIds : undefined;
        const failure = classifySectionFailure({
            candidateCount: m.candidateCount,
            unavailableCourses: m.unavailableCourses,
            rejectedCourseIds,
        });

        if (failure === null) {
            return cycles === 0
                ? { kind: "feasible", nearTerm: m.nearTerm, cycles }
                : {
                      kind: "replan",
                      mutations,
                      movedCourseIds: [...moved],
                      finalPlan: current,
                      nearTerm: m.nearTerm,
                      cycles,
                      gradTermChanged,
                      gradTerm,
                  };
        }

        if (cycles >= cap) {
            return {
                kind: "no-op",
                reason: `These courses still can't be scheduled together after ${cap} re-plan attempt${cap === 1 ? "" : "s"}; verify with your adviser.`,
                cycles,
                nearTerm: m.nearTerm,
            };
        }

        const escalation = await deps.escalate(failure, current, m.nearTerm);
        const best = escalation.resolutions[0];
        if (best === undefined) {
            return {
                kind: "no-op",
                reason: escalation.reason ?? "No valid re-plan keeps your graduation target with these courses next term.",
                cycles,
                nearTerm: m.nearTerm,
            };
        }

        mutations.push(...best.batch.mutations);
        best.batch.movedCourseIds.forEach(c => moved.add(c));
        current = best.schedule;
        gradTerm = best.gradTerm;
        gradTermChanged = gradTermChanged || best.gradTermChanged;
        cycles++;
    }

    // Unreachable in practice (the cap branch returns first); satisfies the type.
    return { kind: "no-op", reason: "section re-plan exceeded its iteration guard", cycles, nearTerm: plan.graduationTerm };
}
