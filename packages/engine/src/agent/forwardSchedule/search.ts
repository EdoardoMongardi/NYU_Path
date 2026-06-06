/**
 * Phase 2 P2.2a — Backtracking constraint search over requirement variables.
 *
 * Replaces the greedy, no-backtracking forward solver's requirement-placement
 * core. Given a ConstraintContext, it assigns each unmet requirement variable a
 * (course, term) value so that a COMPLETE assignment satisfies every hard
 * constraint, and it MINIMISES scorePlan among valid assignments (LOWER =
 * better).
 *
 * COMPLETENESS — the search prunes a branch ONLY on SOUND, later-variable-
 * independent conditions: the incremental forward-check is exactly
 * {offeringSeasonMatch, notClauseClear, coreqsSameTerm, perTermCeiling}, each of
 * which, once violated on a partial plan, stays violated under any further
 * placement (so pruning never discards a branch that would become valid later).
 * The remaining hard predicates — prereqs, requirement coverage, the major-
 * credit floor and the residency floor — are validated at the COMPLETE leaf,
 * where every course is placed (so a prereq satisfied by a LATER variable placed
 * in an EARLIER term resolves correctly). A leaf is accepted only if ALL of
 * {prereqs, coverage, major-credit, residency} pass. There is NO score-based
 * prune (the objective is not monotonic) and NO forward-feasibility/capacity
 * screen (the available screen is a false-negative-prone heuristic — unsound as
 * a hard prune). The prereq-depth-ascending variable ordering is a PERFORMANCE
 * heuristic, not a correctness dependency. Net effect: a valid plan is found iff
 * one exists.
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

/**
 * Incremental forward-check predicate set — exactly {offering, NOT, coreq,
 * ceiling}. SOUNDNESS: each of these is later-variable-independent, i.e. a
 * violation on the trial plan can NEVER be cleared by adding more placements,
 * so pruning a branch on any violation here cannot discard a branch that would
 * become valid later:
 *   - offeringSeasonMatch: a property of the placed (course, term) alone;
 *     unaffected by other placements.
 *   - notClauseClear: the set of blockers only GROWS as courses are added, so a
 *     NOT-clause exclusion present now persists.
 *   - coreqsSameTerm: only fires when a coreq is ALREADY placed in a DIFFERENT
 *     term; it skips unplaced coreqs (those are coverage's concern), so its
 *     verdict never flips from violation→ok via a future placement.
 *   - perTermCeiling: a per-term credit SUM that only grows, so an over-ceiling
 *     term stays over-ceiling.
 *
 * checkPrereqsSatisfied is DELIBERATELY EXCLUDED here: as an incremental prune
 * it is UNSOUND, because a course's prereq may be an unassigned LATER variable
 * not yet placed — pruning then would discard a branch that becomes valid once
 * that later variable is placed in an earlier term. Prereqs are instead checked
 * at the COMPLETION leaf (recurse i === variables.length), where every course
 * is placed and prereq-in-an-earlier-term is verified correctly.
 */
function incrementalOk(trial: PartialPlan, ctx: ConstraintContext): boolean {
    return (
        checkOfferingSeasonMatch(trial, ctx).ok &&
        checkNotClauseClear(trial, ctx).ok &&
        checkCoreqsSameTerm(trial, ctx).ok &&
        checkPerTermCeiling(trial, ctx).ok
    );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function searchBestPlan(ctx: ConstraintContext, options?: SearchOptions): SearchResult {
    const weights = options?.weights;
    const fixed = options?.fixed ?? [];
    const maxNodes = options?.maxNodes ?? DEFAULT_MAX_NODES;

    // 1. Variables — only those with ≥1 viable candidate (empty-candidate
    //    requirements become placeholders downstream; not searched here), MINUS
    //    any requirement already covered by a FIXED placement. A requirement-
    //    satisfying pin arrives in `fixed` with its satisfiesRId set (the new
    //    solveForwardSchedule body binds a pin to the first unmet requirement it
    //    can cover); skipping that variable here prevents the search from placing
    //    a SECOND course for the same rId (double-placement). Coverage of such a
    //    requirement is then supplied by the pin in materialize.
    const coveredByFixed = new Set(
        fixed.map(p => p.satisfiesRId).filter((rId): rId is string => rId !== null),
    );
    const variables = buildRequirementVariables(ctx).filter(
        v => v.candidates.length > 0 && !coveredByFixed.has(v.rId),
    );

    // 2. Variable ordering (FIXED before search → deterministic). This ordering
    //    is a PERFORMANCE HEURISTIC ONLY — it is NOT a correctness dependency.
    //    Search correctness (completeness) does not rely on any variable being
    //    assigned before another: the only prune conditions are the sound,
    //    later-variable-independent incremental predicates (incrementalOk), and
    //    prereqs/coverage/floors are validated at the COMPLETE leaf. Sort by:
    //    (a) prereq-depth ASC (minimum depth across candidates) — TENDS to place a
    //        course's prerequisites (shallower) before the dependent, so most
    //        explored leaves are already prereq-valid (fewer wasted leaves). It
    //        does NOT guarantee prereqs-are-assigned-first (a requirement's
    //        candidates can have heterogeneous prereq depths), but correctness no
    //        longer depends on that guarantee;
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
            // The leaf is accepted only if ALL of {prereqs, coverage, major-credit,
            // residency} pass. checkPrereqsSatisfied is verified HERE (not in the
            // incremental prune) because only at a complete leaf is every course
            // placed, so a prereq satisfied by a LATER variable placed in an
            // EARLIER term resolves correctly; checking it incrementally would
            // unsoundly prune such branches (see incrementalOk).
            const plan: PartialPlan = { placed: [...fixed, ...assigned] };
            if (
                checkPrereqsSatisfied(plan, ctx).ok &&
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

        // 3. Domain values for this variable. Forward-check each against the trial
        //    using ONLY the sound, later-variable-independent incremental
        //    predicates (incrementalOk = {offering, NOT, coreq, ceiling}); no
        //    capacity/feasibility screen is applied, because the only available
        //    screen (forwardFeasibilityScreen) is a documented false-negative-
        //    prone heuristic (2.0× low-confidence multiplier + candidates[0]-
        //    derived demand) and a false negative used as a hard prune would
        //    discard valid branches → incompleteness. checkPerTermCeiling already
        //    supplies sound per-term capacity pruning. Survivors are then ORDERED
        //    best-first by scorePlan ASC (tie-break: term chronological, then
        //    courseId ASC) so branch-and-bound finds good solutions early.
        const candidateValues: Array<{ value: PlacedCourse; score: number }> = [];
        for (const value of rawValues(v, ctx)) {
            const trial: PartialPlan = { placed: [...fixed, ...assigned, value] };
            if (!incrementalOk(trial, ctx)) continue;
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
