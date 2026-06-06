/**
 * T3a — localImprove: validity-preserving preference descent on a FOUND
 * (pre-fill) search plan.
 *
 * Takes the first valid plan returned by findFirstValidPlan and applies
 * a bounded steepest-descent to lower scorePlan while preserving the
 * search-leaf validity of the plan. Each pass evaluates ALL candidate moves
 * of every `source:"requirement"` placement (re-term + swap-candidate), picks
 * the single move with the lowest valid score strictly below the current, and
 * applies it; terminates when no strictly-improving valid move remains or
 * MAX_PASSES is reached.
 *
 * CRITICAL — operates on the PRE-FILL search plan. Move validity uses the
 * EXACT EIGHT search-leaf predicates the search uses to accept a leaf, NOT
 * checkHardConstraints — its fill-dependent completion axes (perTermFloor /
 * creditMinimum / graduationTarget / gpaFloors) fail on any pre-fill plan and
 * would reject every move. The eight predicates are:
 *   incremental: checkOfferingSeasonMatch, checkPrereqsSatisfied,
 *                checkNotClauseClear, checkCoreqsSameTerm, checkPerTermCeiling
 *   leaf:        checkRequirementCoverage, checkMajorCreditFloor,
 *                checkResidencyFloor
 *
 * Invariants:
 *   - result is a valid search leaf (all eight predicates pass)
 *   - scorePlan(result) ≤ scorePlan(input)
 *   - deterministic (stable iteration order + strict-improvement-only step +
 *     stable planKey tie-break)
 *   - never moves source ∈ {pin, ip, free}
 *   - terminates: strict-improvement-only step + MAX_PASSES cap
 */

import {
    scorePlan,
    checkOfferingSeasonMatch,
    checkPrereqsSatisfied,
    checkNotClauseClear,
    checkCoreqsSameTerm,
    checkPerTermCeiling,
    checkRequirementCoverage,
    checkMajorCreditFloor,
    checkResidencyFloor,
    type ConstraintContext,
    type PartialPlan,
    type PlacedCourse,
    type ObjectiveWeights,
} from "./constraintModel.js";
import { classifyWorkloadTier } from "./workloadTier.js";
import { parseTerm, isStudyAbroadCourse } from "./solverHelpers.js";

const MAX_PASSES = 20;

type Season = "fall" | "spring" | "summer" | "january";

/** Search-leaf validity — the EXACT eight predicates the search uses to accept
 *  a leaf. NOT checkHardConstraints (its fill-dependent completion axes —
 *  perTermFloor / creditMinimum / graduationTarget / gpaFloors — fail on a
 *  pre-fill plan, which localImprove operates on). */
function isValidSearchLeaf(plan: PartialPlan, ctx: ConstraintContext): boolean {
    return (
        checkOfferingSeasonMatch(plan, ctx).ok &&
        checkPrereqsSatisfied(plan, ctx).ok &&
        checkNotClauseClear(plan, ctx).ok &&
        checkCoreqsSameTerm(plan, ctx).ok &&
        checkPerTermCeiling(plan, ctx).ok &&
        checkRequirementCoverage(plan, ctx).ok &&
        checkMajorCreditFloor(plan, ctx).ok &&
        checkResidencyFloor(plan, ctx).ok
    );
}

/** Deterministic, stable key for a plan: sorted `courseId@term` list joined by
 *  pipe. Mirrors search.ts's planKey so the tie-break matches the search's. */
function planKey(plan: PartialPlan): string {
    return plan.placed
        .map(p => `${p.courseId}@${p.term}`)
        .sort()
        .join("|");
}

/** Build a fully-formed PlacedCourse for (courseId, term, rId), mirroring
 *  search.ts's buildValue. Credits from catalog; tier/weight from
 *  classifyWorkloadTier exactly as the search does it. */
function buildRequirementValue(
    courseId: string,
    term: string,
    satisfiesRId: string | null,
    ctx: ConstraintContext,
): PlacedCourse {
    const credits = ctx.input.courseCatalog.get(courseId)?.credits ?? 0;
    const wt = classifyWorkloadTier({
        courseId,
        satisfiesRules: satisfiesRId !== null ? [satisfiesRId] : [],
        majorRuleKinds: ctx.input.programRules.majorRuleKinds,
        schoolCoreRuleIds: ctx.input.programRules.schoolCoreRuleIds,
        generalCategoryRuleIds: ctx.input.programRules.generalCategoryRuleIds,
        bulletinTitle: ctx.input.courseTitles?.get(courseId),
        bulletinKeywords: ctx.input.courseBulletinKeywords?.get(courseId),
    });
    return {
        courseId,
        term,
        credits,
        workloadTier: wt.tier,
        workloadWeight: wt.weight,
        satisfiesRId,
        source: "requirement",
    };
}

/** Return a new plan with plan.placed[i] replaced by newP. */
function replaceAt(plan: PartialPlan, i: number, newP: PlacedCourse): PartialPlan {
    return { placed: plan.placed.map((x, j) => (j === i ? newP : x)) };
}

/**
 * Enumerate all candidate moves for placement p = plan.placed[i].
 *
 * Two move kinds:
 *   1. Re-term:          move p to a different term in ctx.futureTerms.
 *   2. Swap-candidate:   replace p's courseId with another candidate of the
 *                        same requirement (from unmetRequirements, excluding
 *                        student exclusions, requiring catalog presence).
 *
 * All enumeration is in stable/deterministic order (futureTerms chronological,
 * candidateCourses in declaration order from the requirement, excluding the
 * current courseId and exclusions).
 */
function* enumerateMoves(
    plan: PartialPlan,
    i: number,
    ctx: ConstraintContext,
): Generator<PartialPlan> {
    const p = plan.placed[i]!;

    // 1. Re-term moves: try every future term except p's current term.
    for (const term of ctx.futureTerms) {
        if (term === p.term) continue;
        // Offering season check for the new term (quick pre-filter to avoid building
        // the full trial; isValidSearchLeaf below re-checks, so this is optional but
        // avoids allocating obviously-illegal trials).
        const offered = ctx.input.offerings.get(p.courseId);
        if (offered && offered.length > 0) {
            const parsed = parseTerm(term);
            if (!parsed || !offered.includes(parsed.season as Season)) continue;
        }
        yield replaceAt(plan, i, { ...p, term });
    }

    // 2. Swap-candidate moves: try other candidates of the same requirement.
    if (p.satisfiesRId === null) return; // can't swap without a bound requirement
    const req = ctx.input.unmetRequirements.find(r => r.rId === p.satisfiesRId);
    if (!req) return;

    const excludedCourseIds = new Set<string>(
        (ctx.input.preferences?.exclusions ?? []).map(e => e.courseId),
    );

    for (const candidateCourseId of req.candidateCourses) {
        if (candidateCourseId === p.courseId) continue;
        if (excludedCourseIds.has(candidateCourseId)) continue;
        if (!ctx.input.courseCatalog.has(candidateCourseId)) continue;
        // Mirror buildRequirementVariables' three candidate filters EXACTLY (catalog-present,
        // not-excluded, NOT study-abroad). isValidSearchLeaf does not screen study-abroad — that
        // filter lives only in buildRequirementVariables — so without this guard localImprove
        // could swap in a ≥9000 course the search itself would never have placed.
        if (isStudyAbroadCourse(candidateCourseId)) continue;
        // Check offering season for the candidate in p's current term.
        const offered = ctx.input.offerings.get(candidateCourseId);
        if (offered && offered.length > 0) {
            const parsed = parseTerm(p.term);
            if (!parsed || !offered.includes(parsed.season as Season)) continue;
        }
        yield replaceAt(plan, i, buildRequirementValue(candidateCourseId, p.term, p.satisfiesRId, ctx));
    }
}

/**
 * Validity-preserving local optimisation of a FOUND (pre-fill) search plan
 * toward lower scorePlan. Re-terms and candidate-swaps of requirement
 * placements only; pins/ip/free are never moved; every move is re-validated as
 * a search leaf. Deterministic; result is a valid leaf with score ≤ the
 * input's.
 */
export function localImprove(
    plan: PartialPlan,
    ctx: ConstraintContext,
    weights?: ObjectiveWeights,
): PartialPlan {
    let current = plan;
    let currentScore = scorePlan(current, ctx, weights);

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        let bestPlan: PartialPlan | null = null;
        let bestScore = currentScore;
        let bestKey = "";

        for (let i = 0; i < current.placed.length; i++) {
            const p = current.placed[i]!;
            if (p.source !== "requirement") continue; // never move pin/ip/free

            for (const moved of enumerateMoves(current, i, ctx)) {
                if (!isValidSearchLeaf(moved, ctx)) continue;
                const s = scorePlan(moved, ctx, weights);
                const key = planKey(moved);

                if (s < currentScore) {
                    // Strictly improving move: adopt if it beats (or ties with
                    // better planKey than) the current best candidate for this pass.
                    if (
                        bestPlan === null ||
                        s < bestScore ||
                        (s === bestScore && key < bestKey)
                    ) {
                        bestPlan = moved;
                        bestScore = s;
                        bestKey = key;
                    }
                }
            }
        }

        if (bestPlan === null) break; // local optimum — no strictly-improving move
        current = bestPlan;
        currentScore = bestScore;
    }

    return current;
}
