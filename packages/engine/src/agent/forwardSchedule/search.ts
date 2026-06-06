/**
 * Phase 2 P2.2a — Backtracking constraint search over requirement variables.
 *
 * Replaces the greedy, no-backtracking forward solver's requirement-placement
 * core. Given a ConstraintContext, it assigns each unmet requirement variable a
 * (course, term) value so that a COMPLETE assignment satisfies every hard
 * constraint, and it MINIMISES scorePlan among valid assignments (LOWER =
 * better).
 *
 * ALGORITHM — backtracking + forward-checking with INCUMBENT TRACKING but NO
 * admissible objective bound. This is NOT cost-bounded branch-and-bound: a sound
 * lower bound is impossible while the objective is non-monotonic (balance variance
 * can DROP as placements are added, e.g. [16,0] scores worse than [8,8]), so the
 * search keeps the best incumbent(s) but CANNOT prune a branch on score. It is
 * therefore COMPLETE + OPTIMAL only WITHIN the `maxNodes` budget, and TRUNCATES
 * beyond it (surfaced to callers via the `exhaustive` flag). Do not read this as
 * unconditionally complete/optimal.
 *
 * BUDGET-BOUNDED COMPLETENESS — within the node budget the search prunes a branch
 * ONLY on SOUND, later-variable-independent conditions: the incremental forward-
 * check is exactly {offeringSeasonMatch, notClauseClear, coreqsSameTerm,
 * perTermCeiling}, each of which, once violated on a partial plan, stays violated
 * under any further placement (so pruning never discards a branch that would
 * become valid later). The remaining hard predicates — prereqs, requirement
 * coverage, the major-credit floor and the residency floor — are validated at the
 * COMPLETE leaf, where every course is placed (so a prereq satisfied by a LATER
 * variable placed in an EARLIER term resolves correctly). A leaf is accepted only
 * if ALL of {prereqs, coverage, major-credit, residency} pass. There is NO
 * score-based prune (the objective is not monotonic) and NO forward-feasibility/
 * capacity screen (the available screen is a false-negative-prone heuristic —
 * unsound as a hard prune). The prereq-depth-ascending variable ordering is a
 * PERFORMANCE heuristic, not a correctness dependency. Net effect: IF the search
 * runs to exhaustion (`exhaustive === true`) a valid plan is found iff one exists
 * and the winner is the true optimum; if it TRUNCATES (`exhaustive === false`) any
 * plan returned is still VALID (it passed the completion-leaf check) but may not be
 * the optimum, and an EMPTY result means "none found within the budget" — NOT
 * proven infeasible.
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
    type HardViolation,
} from "./constraintModel.js";
import { classifyWorkloadTier } from "./workloadTier.js";
import { parseTerm, compareSolverTerms, isOptionalTerm } from "./solverHelpers.js";

/** One binding-constraint explanation for a requirement that could not be placed.
 *  Additive companion to `unsatisfiable`: same rIds, but each carries WHY (the
 *  specific hard-constraint kind + a human-readable detail naming the requirement). */
export interface Blocker {
    rId: string;
    kind: HardViolation["kind"];
    detail: string;
}

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
    /** When plan === null: the SAME rIds as `unsatisfiable`, each annotated with the
     *  binding constraint that makes it unplaceable (one representative per rId). Empty
     *  when a plan was found. Parallel companion to `unsatisfiable` — see computeBlockers. */
    blockers: Blocker[];
}

export interface TopKOptions extends SearchOptions {
    /** Number of distinct best plans to collect. Default 5. */
    k?: number;
}

export interface TopKResult {
    /** Ascending by scorePlan; plans[0] is the optimum (=== searchBestPlan's plan). Empty when none exists. */
    plans: PartialPlan[];
    /** scorePlan of each plan, parallel to `plans`. */
    scores: number[];
    /** True iff the search space was fully explored within maxNodes (not truncated). */
    exhaustive: boolean;
    nodesExplored: number;
    /** When plans is empty: rIds of requirement variables that could not be satisfied. */
    unsatisfiable: string[];
    /** When plans is empty: the SAME rIds as `unsatisfiable`, each annotated with the
     *  binding constraint that makes it unplaceable. Empty when a plan was found. */
    blockers: Blocker[];
}

const DEFAULT_MAX_NODES = 200_000;
const DEFAULT_K = 5;

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
// Core backtracking routine (shared by searchBestPlan + searchTopKPlans)
// ---------------------------------------------------------------------------

/** Bookkeeping every public entry point needs after the recursion finishes. */
interface SearchRun {
    /** The ordered requirement variables searched (post fixed-coverage filter). */
    variables: RequirementVariable[];
    /** The fixed placements present in every candidate plan. */
    fixed: PlacedCourse[];
    /** Total recursion nodes visited. */
    nodes: number;
    /** True iff the node budget was hit (the space is not fully explored). */
    truncated: boolean;
}

/**
 * The single backtracking + forward-check traversal (incumbent tracking, NO
 * admissible objective bound — so NOT cost-bounded branch-and-bound).
 * `onValidLeaf(plan, score)` is invoked at EVERY valid complete leaf — a leaf
 * that passes prereqs + coverage + major-credit + residency — with the plan
 * `{ placed: [...fixed, ...assigned] }` and its scorePlan. The traversal itself
 * is objective-agnostic: it never decides which leaves to keep (that is the
 * caller's job via the callback), so searchBestPlan (keep the single lowest
 * score) and searchTopKPlans (keep the K lowest scores) explore the IDENTICAL
 * tree and visit the IDENTICAL leaves in the IDENTICAL order. There is NO
 * score-based prune (the objective is not monotonic) — pruning relies solely on
 * the sound incremental forward-check — so completeness is preserved WITHIN the
 * `maxNodes` budget; once that budget is hit the traversal stops early and sets
 * `truncated` (surfaced to callers as `exhaustive === false`).
 *
 * The callback may return `true` to request an early stop after accepting the
 * leaf (used by findFirstValidPlan to halt after the first valid leaf). Returning
 * `undefined` / `void` (the default for all other callers) continues the traversal.
 */
function runSearch(
    ctx: ConstraintContext,
    options: SearchOptions | undefined,
    onValidLeaf: (plan: PartialPlan, score: number) => boolean | void,
): SearchRun {
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

    // 4. Backtracking with forward-checking + incumbent tracking (no admissible
    //    objective bound, so NOT cost-bounded B&B). Terminates at the maxNodes
    //    budget (sets `truncated`), or at the first valid leaf when the caller's
    //    onValidLeaf callback returns true (sets `stopped`).
    let nodes = 0;
    let truncated = false;
    let stopped = false;

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
                if (onValidLeaf(plan, scorePlan(plan, ctx, weights)) === true) stopped = true;
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
        //    courseId ASC) so good solutions surface early — this is a value-
        //    ORDERING heuristic only; with no admissible bound it does NOT prune,
        //    so it cannot affect completeness, only the order leaves are visited.
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
            // NO objective bound (so this is NOT cost-bounded branch-and-bound):
            // scorePlan is NOT monotonic in placements — balance variance can go
            // DOWN as courses are added (e.g. [16,0] has higher variance than
            // [8,8]). So we do NOT prune a branch merely because the partial's
            // score ≥ the best incumbent; that would be unsound and could skip the
            // optimum. Pruning relies solely on the sound incremental forward-check
            // above; the incumbent is tracked (by the caller's onValidLeaf) but
            // never used as a bound. (An admissible lower-bound on the objective is
            // a documented FAST-FOLLOW that would turn this into true cost-bounded
            // B&B and let it prune — see the whole-branch review.)
            recurse([...assigned, value], i + 1);
            if (truncated || stopped) return;
        }
    }

    recurse([], 0);

    return { variables, fixed, nodes, truncated };
}

/** A deterministic, stable key for a plan: its sorted `courseId@term` list.
 *  Two leaves with EQUAL score are ordered by this key so output is deterministic,
 *  and (because the search assigns variables in a fixed order) every leaf's key is
 *  unique among the leaves — distinct plans never collide. */
function planKey(plan: PartialPlan): string {
    return plan.placed
        .map(p => `${p.courseId}@${p.term}`)
        .sort()
        .join("|");
}

/** Fixed kind-priority order for the dominant-failing-incrementalOk tie-break
 *  (ceiling → offering → coreq → not_clause). Lower index wins a tie. */
const INCREMENTAL_KIND_ORDER: HardViolation["kind"][] = [
    "credit_ceiling",
    "offering_pattern",
    "other", // coreqsSameTerm violations carry kind "other"
    "not_clause",
];

/** The DOMINANT failing incremental-axis kind across a variable's candidate values
 *  (each evaluated as {placed:[...fixed, value]}). For every value that fails
 *  incrementalOk we tally which per-axis predicate(s) fire; the kind that fails for
 *  the MOST values wins (tie-break: INCREMENTAL_KIND_ORDER). Returns null only when
 *  no value fails any of the four incremental axes (should not happen when the
 *  caller already established no value passes incrementalOk). */
function dominantIncrementalKind(
    v: RequirementVariable,
    fixed: PlacedCourse[],
    ctx: ConstraintContext,
): HardViolation["kind"] | null {
    const counts = new Map<HardViolation["kind"], number>();
    for (const value of rawValues(v, ctx)) {
        const trial: PartialPlan = { placed: [...fixed, value] };
        // Tally each axis that fails for THIS value (a value may fail several).
        if (!checkPerTermCeiling(trial, ctx).ok) {
            counts.set("credit_ceiling", (counts.get("credit_ceiling") ?? 0) + 1);
        }
        if (!checkOfferingSeasonMatch(trial, ctx).ok) {
            counts.set("offering_pattern", (counts.get("offering_pattern") ?? 0) + 1);
        }
        if (!checkCoreqsSameTerm(trial, ctx).ok) {
            counts.set("other", (counts.get("other") ?? 0) + 1);
        }
        if (!checkNotClauseClear(trial, ctx).ok) {
            counts.set("not_clause", (counts.get("not_clause") ?? 0) + 1);
        }
    }
    let best: HardViolation["kind"] | null = null;
    let bestCount = 0;
    for (const kind of INCREMENTAL_KIND_ORDER) {
        const c = counts.get(kind) ?? 0;
        if (c > bestCount) {
            best = kind;
            bestCount = c;
        }
    }
    return best;
}

/** Human-readable detail for a dominant incremental-failure kind. */
function incrementalBlockerDetail(v: RequirementVariable, kind: HardViolation["kind"]): string {
    const head = `${v.title} (${v.rId})`;
    switch (kind) {
        case "credit_ceiling":
            return `${head}: every candidate placement would exceed the per-term credit ceiling given the fixed placements.`;
        case "offering_pattern":
            return `${head}: no candidate can be placed in a term matching its offering season given the fixed placements.`;
        case "other":
            return `${head}: a co-requisite cannot be co-scheduled in the same term as any candidate given the fixed placements.`;
        case "not_clause":
            return `${head}: every candidate is excluded by a NOT prerequisite clause (a co-listed/completed course blocks it).`;
        default:
            return `${head}: no candidate placement satisfies the hard constraints given the fixed placements.`;
    }
}

/**
 * Per-requirement binding-constraint analysis for an empty result. A variable is
 * "unplaceable" — and so gets ONE representative blocker — when EITHER it has no
 * value passing the incremental forward-check against just `fixed` (the exact
 * same individual-impossibility test the old computeUnsatisfiable used), OR it is
 * prereq-depth-blocked (an independent structural block incrementalOk cannot see,
 * because incrementalOk deliberately excludes prereqs). The representative blocker
 * is chosen by priority:
 *
 *   1. offering-absent — rawValues(v) is empty: not a single (course, term) is
 *      offering-legal in the planning window. Kind "offering_pattern".
 *   2. prereq-depth structural block — the MIN prereq depth across the variable's
 *      candidates exceeds the number of NON-optional future terms, so the prereq
 *      chain cannot fit the window before graduation. Kind "prereq_unsatisfiable".
 *      Evaluated INDEPENDENTLY of incrementalOk: a depth-blocked requirement may
 *      still have incrementalOk-passing values (incrementalOk ignores prereqs), so
 *      this is the reason the COMPLETE-leaf checkPrereqsSatisfied rejected it.
 *   3. dominant incrementalOk failure — values exist, none pass incrementalOk;
 *      report the per-axis kind that fails for the most values.
 *
 * The returned `Blocker[]` is parallel to the rId list (`unsatisfiable`): callers
 * derive `unsatisfiable = blockers.map(b => b.rId)`, so the two never diverge.
 */
function computeBlockers(run: SearchRun, ctx: ConstraintContext): Blocker[] {
    const blockers: Blocker[] = [];
    // Number of NON-optional (fall/spring) future terms — the window a prereq chain
    // must fit within (optional summer/january terms don't extend a normal chain).
    const nonOptionalTermCount = ctx.futureTerms.filter(t => !isOptionalTerm(t)).length;
    const gradTerm = ctx.input.graduationTerm;

    for (const v of run.variables) {
        const values = rawValues(v, ctx);

        // Individual incrementalOk viability vs just `fixed` (old unplaceability test).
        let anyViable = false;
        for (const value of values) {
            const trial: PartialPlan = { placed: [...run.fixed, value] };
            if (incrementalOk(trial, ctx)) {
                anyViable = true;
                break;
            }
        }

        // Prereq-depth structural block — INDEPENDENT of incrementalOk (it ignores
        // prereqs), so check it whether or not the variable is incrementalOk-viable.
        const minDepth = minCandidateDepth(v, ctx);
        const prereqDepthBlocked = values.length > 0 && minDepth > nonOptionalTermCount;

        // Not unplaceable unless one of the two conditions holds.
        if (anyViable && !prereqDepthBlocked) continue;

        // --- 1. Offering-absent: no offering-legal (course, term) at all. ---
        if (values.length === 0) {
            blockers.push({
                rId: v.rId,
                kind: "offering_pattern",
                detail: `${v.title} (${v.rId}): no candidate course is offered in the planning window (${ctx.futureTerms.join(", ")}).`,
            });
            continue;
        }

        // --- 2. Prereq-depth structural block (priority over incrementalOk failure). ---
        if (prereqDepthBlocked) {
            blockers.push({
                rId: v.rId,
                kind: "prereq_unsatisfiable",
                detail: `${v.title} (${v.rId}): prerequisite chain (depth ${minDepth}) does not fit the ${nonOptionalTermCount}-term window before ${gradTerm}.`,
            });
            continue;
        }

        // --- 3. Dominant incrementalOk failure. ---
        const kind = dominantIncrementalKind(v, run.fixed, ctx) ?? "other";
        blockers.push({ rId: v.rId, kind, detail: incrementalBlockerDetail(v, kind) });
    }
    return blockers;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/** Feasibility-first: return the FIRST valid complete leaf and stop. The per-variable
 *  values are ordered best-first by scorePlan, so the first leaf is a good (not provably
 *  optimal) plan; a later localImprove step refines it.
 *
 *  `exhaustive` SEMANTICS DIFFER from searchBestPlan and matter ONLY when `plan === null`:
 *    - plan === null, exhaustive === true  → PROVEN infeasible (search ran out within budget).
 *    - plan === null, exhaustive === false → truncated (hit maxNodes); feasibility unconfirmed.
 *    - plan !== null                        → a valid plan was found by stopping EARLY (the
 *      first leaf). `exhaustive` is then `true` (the budget was NOT hit), but it does NOT mean
 *      "the whole space was explored / this is the optimum" — feasibility-first never proves
 *      optimality. Consumers MUST treat a found plan as best-effort (see the T7 `optimality`
 *      signal); they should consult `exhaustive` only on the null path.
 *  blockers/unsatisfiable are populated exactly as searchBestPlan (via computeBlockers) on null. */
export function findFirstValidPlan(ctx: ConstraintContext, options?: SearchOptions): SearchResult {
    let found: PartialPlan | null = null;
    let foundScore = Infinity;
    const run = runSearch(ctx, options, (plan, score) => {
        found = plan;
        foundScore = score;
        return true; // stop at the first valid leaf
    });
    const blockers: Blocker[] = found === null ? computeBlockers(run, ctx) : [];
    return {
        plan: found,
        score: foundScore,
        exhaustive: !run.truncated,
        nodesExplored: run.nodes,
        unsatisfiable: blockers.map(b => b.rId),
        blockers,
    };
}

export function searchBestPlan(ctx: ConstraintContext, options?: SearchOptions): SearchResult {
    // Keep the SINGLE lowest-score valid leaf. A strictly-lower score always
    // replaces; an EQUAL score replaces only when the new leaf's planKey (sorted
    // `courseId@term` list) is smaller. This deterministic tie-break is the same
    // one searchTopKPlans applies, so searchBestPlan's plan === searchTopKPlans's
    // plans[0] for every input — even when several distinct leaves tie at the
    // global minimum. (With a UNIQUE optimum this is exactly "the lowest-score
    // leaf", so every existing optimality/determinism assertion is unchanged; the
    // tie-break only fixes WHICH optimum is named when there are several, which no
    // prior test pinned — they assert two runs AGREE, which still holds.)
    let best: PartialPlan | null = null;
    let bestScore = Infinity;
    let bestKey = "";

    const run = runSearch(ctx, options, (plan, score) => {
        if (best === null || score < bestScore) {
            best = plan;
            bestScore = score;
            bestKey = planKey(plan);
        } else if (score === bestScore) {
            const key = planKey(plan);
            if (key < bestKey) {
                best = plan;
                bestKey = key;
            }
        }
    });

    // When no plan was found, analyse each unplaceable requirement's binding
    // constraint. `unsatisfiable` is derived from `blockers` so the two are always
    // the SAME rIds (blockers just add the reason). Both empty when a plan exists.
    const blockers: Blocker[] = best === null ? computeBlockers(run, ctx) : [];
    const unsatisfiable: string[] = blockers.map(b => b.rId);

    return {
        plan: best,
        score: bestScore,
        exhaustive: !run.truncated,
        nodesExplored: run.nodes,
        unsatisfiable,
        blockers,
    };
}

/**
 * Collect the K best DISTINCT valid plans (default k=5). Every valid complete
 * leaf is a unique (rId → course, term) assignment (the search binds variables
 * in a FIXED order), so the K lowest-`scorePlan` leaves ARE the K best distinct
 * plans — no dedup/diversity logic is needed.
 *
 * A bounded best-of-K list is maintained during the traversal: a leaf is kept
 * when fewer than K are held, or when it strictly beats the current worst-of-K
 * (then the worst is evicted). The final `plans` are sorted ascending by score
 * with a deterministic tie-break on `planKey` (the sorted `courseId@term` list),
 * so the output is stable across runs. `plans[0]` equals what searchBestPlan
 * returns for the same input: both pick the lowest score and, on a score tie, the
 * smallest planKey (searchBestPlan applies the identical tie-break), so the two
 * agree even when several distinct leaves tie at the global minimum.
 *
 * No score-based prune: the same tree is explored as searchBestPlan (visiting the
 * IDENTICAL leaves in the IDENTICAL order). So WHEN THE SEARCH RUNS TO EXHAUSTION
 * (`exhaustive === true`) plans[0] is the true optimum; when it TRUNCATES
 * (`exhaustive === false`) every returned plan is still VALID but may not be the
 * optimum, and an empty `plans` means "none found within the budget" — NOT proven
 * infeasible. Callers must consult `exhaustive` before treating plans[0] as
 * optimal or an empty result as infeasible.
 */
export function searchTopKPlans(ctx: ConstraintContext, options?: TopKOptions): TopKResult {
    const k = Math.max(0, options?.k ?? DEFAULT_K);

    // Bounded best-of-K, kept UNSORTED during traversal; we track the current
    // worst (highest score) for O(1) admission decisions and evict it on insert.
    const kept: Array<{ plan: PartialPlan; score: number }> = [];

    function worstIndex(): number {
        // Index of the highest-score entry (the eviction candidate). Ties broken
        // by LARGER planKey so the survivor set matches the final sort's tie-break.
        let wi = 0;
        for (let i = 1; i < kept.length; i++) {
            const a = kept[i]!;
            const b = kept[wi]!;
            if (a.score > b.score || (a.score === b.score && planKey(a.plan) > planKey(b.plan))) {
                wi = i;
            }
        }
        return wi;
    }

    const run = runSearch(ctx, options, (plan, score) => {
        if (k === 0) return;
        if (kept.length < k) {
            kept.push({ plan, score });
            return;
        }
        const wi = worstIndex();
        const worst = kept[wi]!;
        // Replace the worst-of-K only on a STRICT improvement: a lower score, or
        // an equal score with a SMALLER planKey (so the deterministic tie-break is
        // honoured even at the K-boundary). Distinctness is automatic — each leaf
        // has a unique planKey — so this never drops a true distinct alternative
        // that should rank inside the top K.
        if (score < worst.score || (score === worst.score && planKey(plan) < planKey(worst.plan))) {
            kept[wi] = { plan, score };
        }
    });

    // Final deterministic order: score ASC, then planKey ASC.
    kept.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        const ka = planKey(a.plan);
        const kb = planKey(b.plan);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const blockers: Blocker[] = kept.length === 0 ? computeBlockers(run, ctx) : [];
    const unsatisfiable = blockers.map(b => b.rId);

    return {
        plans: kept.map(e => e.plan),
        scores: kept.map(e => e.score),
        exhaustive: !run.truncated,
        nodesExplored: run.nodes,
        unsatisfiable,
        blockers,
    };
}
