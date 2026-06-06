/**
 * Phase 2 P2.2a — Backtracking constraint search over requirement variables.
 *
 * Replaces the greedy, no-backtracking forward solver's requirement-placement
 * core. Given a ConstraintContext, it assigns each unmet requirement variable a
 * (course, term) value so that:
 *   - every per-placement hard predicate holds (offering season, prereqs,
 *     NOT-clause, coreq same-term, per-term ceiling), AND
 *   - requirement coverage + the major-credit and residency floors hold,
 * and it MINIMISES scorePlan among valid assignments (LOWER = better).
 *
 * Boundary (intentional): this search places ONLY requirement-satisfying
 * courses (source "requirement") on top of caller-supplied FIXED placements
 * (pins source "pin", in-progress source "ip"). It does NOT do free-elective
 * fill and does NOT build a ForwardSchedule — those are later tasks. As a
 * direct consequence the FILL-DEPENDENT axes (per-term floor, total-credit
 * minimum, graduation target) and the placement-independent gpaFloors are
 * deliberately NOT enforced here: a later materialise step adds free electives
 * to satisfy floors/targets, and the post-hoc runGraduationPathValidator is the
 * authoritative gate. Enforcing those axes mid-search (before fill exists)
 * would reject every partial plan.
 *
 * Pure: deterministic from (ctx, options); no module-level mutable state.
 */

import {
    buildRequirementVariables,
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
    type RequirementVariable,
} from "./constraintModel.js";
import { classifyWorkloadTier } from "./workloadTier.js";
import { forwardFeasibilityScreen } from "./forwardFeasibility.js";
import { parseTerm, compareSolverTerms } from "./solverHelpers.js";

type Season = "fall" | "spring" | "summer" | "january";

export interface SearchOptions {
    weights?: ObjectiveWeights;
    /** Pre-fixed placements present in EVERY candidate plan (pins source:"pin", in-progress source:"ip").
     *  The search assigns the requirement variables on top of these. Default []. */
    fixed?: PlacedCourse[];
    /** Node budget for guaranteed termination. Default 200_000. */
    maxNodes?: number;
}

export interface SearchResult {
    /** Best valid assignment (fixed + requirement placements), or null if none exists. */
    plan: PartialPlan | null;
    /** scorePlan of the best plan; Infinity when plan === null. */
    score: number;
    /** True iff the search space was fully explored within maxNodes (not truncated). */
    exhaustive: boolean;
    nodesExplored: number;
    /** When plan === null: rIds of requirement variables that could not be satisfied
     *  (a variable with no viable (course,term) value given the others). For infeasibility reporting. */
    unsatisfiable: string[];
}

const DEFAULT_MAX_NODES = 200_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Minimum prereq depth across a variable's candidate courses (depth-0 default). */
function minCandidateDepth(v: RequirementVariable, ctx: ConstraintContext): number {
    let min = Infinity;
    for (const cid of v.candidates) {
        const d = ctx.prereqDepths.get(cid) ?? 0;
        if (d < min) min = d;
    }
    return min === Infinity ? 0 : min;
}

/** Workload weight of a variable's first candidate (for the stable tie-break).
 *  Mirrors solver.ts's classifyWorkloadTier wiring (satisfiesRules: [rId]). */
function variableWorkloadWeight(v: RequirementVariable, ctx: ConstraintContext): number {
    const cid = v.candidates[0];
    if (cid === undefined) return 0;
    return classifyWorkloadTier({
        courseId: cid,
        satisfiesRules: [v.rId],
        majorRuleKinds: ctx.input.programRules.majorRuleKinds,
        schoolCoreRuleIds: ctx.input.programRules.schoolCoreRuleIds,
        generalCategoryRuleIds: ctx.input.programRules.generalCategoryRuleIds,
        bulletinTitle: ctx.input.courseTitles?.get(cid),
        bulletinKeywords: ctx.input.courseBulletinKeywords?.get(cid),
    }).weight;
}

/** Build a fully-formed PlacedCourse value for (courseId, term) bound to a variable. */
function buildValue(v: RequirementVariable, courseId: string, term: string, ctx: ConstraintContext): PlacedCourse {
    const credits = ctx.input.courseCatalog.get(courseId)!.credits;
    const wt = classifyWorkloadTier({
        courseId,
        satisfiesRules: [v.rId],
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
        satisfiesRId: v.rId,
        source: "requirement",
    };
}

/** All (courseId, term) values for a variable that are legal by offering season.
 *  Empty/absent offerings ⇒ any season. (Same legality rule as the domain pre-built
 *  in buildRequirementVariables, recomputed here to keep search self-contained.) */
function rawValues(v: RequirementVariable, ctx: ConstraintContext): PlacedCourse[] {
    const out: PlacedCourse[] = [];
    for (const cid of v.candidates) {
        const offered = ctx.input.offerings.get(cid);
        for (const term of ctx.futureTerms) {
            const parsed = parseTerm(term);
            if (!parsed) continue;
            if (offered && offered.length > 0 && !offered.includes(parsed.season as Season)) continue;
            out.push(buildValue(v, cid, term, ctx));
        }
    }
    return out;
}

/** All incremental (per-placement) hard predicates pass on the trial plan. */
function incrementalOk(trial: PartialPlan, ctx: ConstraintContext): boolean {
    return (
        checkOfferingSeasonMatch(trial, ctx).ok &&
        checkPrereqsSatisfied(trial, ctx).ok &&
        checkNotClauseClear(trial, ctx).ok &&
        checkCoreqsSameTerm(trial, ctx).ok &&
        checkPerTermCeiling(trial, ctx).ok
    );
}

/** Forward-feasibility screen: do the REMAINING variables (those after index i)
 *  still fit given the trial's per-term load? Capacity + depth pruning. */
function remainingStillFit(
    trial: PartialPlan,
    remaining: RequirementVariable[],
    ctx: ConstraintContext,
): boolean {
    const placedCreditsByTerm = new Map<string, number>();
    for (const p of trial.placed) {
        placedCreditsByTerm.set(p.term, (placedCreditsByTerm.get(p.term) ?? 0) + p.credits);
    }
    const creditCeilingByTerm = new Map<string, number>();
    for (const term of ctx.futureTerms) creditCeilingByTerm.set(term, ctx.input.creditCeiling);

    const remainingUnmet = remaining.map(rv => {
        const cid = rv.candidates[0]!; // variables are pre-filtered to candidates.length > 0
        return {
            courseId: cid,
            credits: ctx.input.courseCatalog.get(cid)!.credits,
            minDepth: ctx.prereqDepths.get(cid) ?? 0,
        };
    });

    return forwardFeasibilityScreen({
        placedCreditsByTerm,
        creditCeilingByTerm,
        remainingUnmet,
        remainingTerms: ctx.futureTerms,
        confidenceByCourse: ctx.input.offeringConfidence,
    });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function searchBestPlan(ctx: ConstraintContext, options?: SearchOptions): SearchResult {
    const weights = options?.weights;
    const fixed = options?.fixed ?? [];
    const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;

    // 1. Variables — only those with ≥1 viable candidate (empty-candidate
    //    requirements become placeholders downstream; not searched here).
    const variables = buildRequirementVariables(ctx).filter(v => v.candidates.length > 0);

    // 2. Variable ordering (FIXED before search → deterministic). Sort by:
    //    (a) prereq-depth ASC (minimum depth across candidates) — guarantees a
    //        course's prerequisites (shallower) are assigned BEFORE the dependent,
    //        so the prereq forward-check is valid (placing a dependent before its
    //        prereq would otherwise prune its whole domain);
    //    (b) candidates.length ASC (fewer options = more constrained, MRV);
    //    (c) workload-weight DESC (heavier first), via classifyWorkloadTier;
    //    (d) rId ASC (stable final tie-break).
    const depthOf = new Map<string, number>();
    const weightOf = new Map<string, number>();
    for (const v of variables) {
        depthOf.set(v.rId, minCandidateDepth(v, ctx));
        weightOf.set(v.rId, variableWorkloadWeight(v, ctx));
    }
    variables.sort((a, b) => {
        const da = depthOf.get(a.rId)!;
        const db = depthOf.get(b.rId)!;
        if (da !== db) return da - db;
        if (a.candidates.length !== b.candidates.length) return a.candidates.length - b.candidates.length;
        const wa = weightOf.get(a.rId)!;
        const wb = weightOf.get(b.rId)!;
        if (wa !== wb) return wb - wa;
        return a.rId < b.rId ? -1 : a.rId > b.rId ? 1 : 0;
    });

    // 4. Backtracking with forward-checking + branch-and-bound.
    let best: PartialPlan | null = null;
    let bestScore = Infinity;
    let nodes = 0;
    let truncated = false;

    function recurse(assigned: PlacedCourse[], i: number): void {
        nodes++;
        if (nodes > maxNodes) {
            truncated = true;
            return;
        }

        if (i === variables.length) {
            // All variables assigned — a complete (requirement + fixed) candidate.
            const plan: PartialPlan = { placed: [...fixed, ...assigned] };
            if (
                checkRequirementCoverage(plan, ctx).ok &&
                checkMajorCreditFloor(plan, ctx).ok &&
                checkResidencyFloor(plan, ctx).ok
            ) {
                const s = scorePlan(plan, ctx, weights);
                if (s < bestScore) {
                    best = plan;
                    bestScore = s;
                }
            }
            return;
        }

        const v = variables[i]!;
        const remaining = variables.slice(i + 1);

        // 3. Domain values for this variable. Forward-check each against the trial,
        //    then ORDER survivors best-first by scorePlan ASC (tie-break: term
        //    chronological, then courseId ASC) so branch-and-bound finds good
        //    solutions early.
        const candidateValues: Array<{ value: PlacedCourse; score: number }> = [];
        for (const value of rawValues(v, ctx)) {
            const trial: PartialPlan = { placed: [...fixed, ...assigned, value] };
            if (!incrementalOk(trial, ctx)) continue;
            if (!remainingStillFit(trial, remaining, ctx)) continue;
            candidateValues.push({ value, score: scorePlan(trial, ctx, weights) });
        }
        candidateValues.sort((x, y) => {
            if (x.score !== y.score) return x.score - y.score;
            const t = compareSolverTerms(x.value.term, y.value.term);
            if (t !== 0) return t;
            return x.value.courseId < y.value.courseId ? -1 : x.value.courseId > y.value.courseId ? 1 : 0;
        });

        for (const { value } of candidateValues) {
            // Branch-and-bound (SOUND only): scorePlan is NOT monotonic in
            // placements — balance variance can go DOWN as courses are added
            // (e.g. [16,0] has higher variance than [8,8]). So we do NOT prune a
            // branch merely because the partial's score ≥ bestScore; that would be
            // unsound and could skip the optimum. Pruning relies solely on the
            // forward-check above. (An admissible lower-bound on the objective is a
            // future optimisation that would make this true cost-bounded B&B.)
            recurse([...assigned, value], i + 1);
            if (truncated) return;
        }
    }

    recurse([], 0);

    // 5. Result. When no plan was found, report a best-effort blocker list: rIds
    //    of variables that have NO value passing the incremental forward-check
    //    against just `fixed` (i.e. individually impossible regardless of the
    //    others). Empty when a plan was found.
    const unsatisfiable: string[] = [];
    if (best === null) {
        for (const v of variables) {
            let anyViable = false;
            for (const value of rawValues(v, ctx)) {
                const trial: PartialPlan = { placed: [...fixed, value] };
                if (incrementalOk(trial, ctx)) {
                    anyViable = true;
                    break;
                }
            }
            if (!anyViable) unsatisfiable.push(v.rId);
        }
    }

    return {
        plan: best,
        score: bestScore,
        exhaustive: !truncated,
        nodesExplored: nodes,
        unsatisfiable,
    };
}
