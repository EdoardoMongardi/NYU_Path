/**
 * Phase 2 P2.1b — Hard-constraint model.
 *
 * Pure, individually-testable predicates that, given a (partial or complete)
 * candidate plan, report whether it violates each hard constraint. A later
 * task builds the backtracking search that consumes these; a separate task
 * adds the SOFT objective. NO objective/scoring lives here.
 *
 * The authoritative definition of a "valid" plan is `runGraduationPathValidator`
 * (graduationPathValidator.ts). Each predicate documents — via its `axis` —
 * which validator axis it mirrors, so that a complete plan passing every hard
 * predicate here also passes `runGraduationPathValidator`. The per-placement
 * predicates (offering / prereq / NOT / coreq) mirror the EXACT placement-time
 * checks in solver.ts; the per-term and completion predicates mirror the
 * validator's 7 axes.
 *
 * Reuses the pure primitives from solverHelpers.ts (enumerateMainTerms,
 * parseTerm, compareSolverTerms, computePrereqDepths, buildDependentsIndex,
 * checkAllPrereqs, isExcludedByNotClause, isStudyAbroadCourse) and the
 * visaValidator from ../../dpr/visaValidator.js — none are reimplemented.
 */

import type { SolverInput } from "./types.js";
import type { WorkloadTier, FeasibilityReport } from "@nyupath/shared";
import type { ValidatorAxis } from "./graduationPathValidator.js";
import {
    enumerateMainTerms,
    parseTerm,
    compareSolverTerms,
    computePrereqDepths,
    buildDependentsIndex,
    checkAllPrereqs,
    isExcludedByNotClause,
    isStudyAbroadCourse,
} from "./solverHelpers.js";
import { visaValidator } from "../../dpr/visaValidator.js";

// ---------------------------------------------------------------------------
// Plan / context types
// ---------------------------------------------------------------------------

/** One placed course in a (partial or complete) candidate plan. */
export interface PlacedCourse {
    courseId: string;
    term: string; // solver term code, e.g. "2026-fall"
    credits: number;
    workloadTier: WorkloadTier;
    workloadWeight: number;
    /** rId this placement satisfies, or null for pins/free-electives/IP. */
    satisfiesRId: string | null;
    source: "requirement" | "pin" | "ip" | "free";
}

/** A (partial or complete) candidate plan. Per-term aggregates are derived on demand. */
export interface PartialPlan {
    placed: PlacedCourse[];
}

/** Immutable problem context, precomputed once from a SolverInput. */
export interface ConstraintContext {
    input: SolverInput;
    futureTerms: string[]; // chronological; from enumerateMainTerms(currentTerm, graduationTerm)
    prereqDepths: Map<string, number>;
    dependentsIndex: Map<string, string[]>;
}

export function buildConstraintContext(input: SolverInput): ConstraintContext {
    const futureTerms = enumerateMainTerms(input.currentTerm, input.graduationTerm);
    const allCandidateCourseIds = input.unmetRequirements.flatMap(r => r.candidateCourses);
    const prereqDepths = computePrereqDepths(allCandidateCourseIds, input.prereqs);
    const dependentsIndex = buildDependentsIndex(allCandidateCourseIds, input.prereqs);
    return { input, futureTerms, prereqDepths, dependentsIndex };
}

// ---------------------------------------------------------------------------
// Requirement variables (CSP variable model)
// ---------------------------------------------------------------------------

/** A requirement that needs a specific bound course (validator axis 1). */
export interface RequirementVariable {
    rId: string;
    title: string;
    category: string;
    credits: number;
    candidates: string[]; // catalog-present, not excluded, not study-abroad
    domain: Array<{ courseId: string; term: string }>; // legal by offering-season + catalog
}

/** Build the CSP variables from unmet requirements + preferences (exclusions applied).
 *  Requirements whose candidateCourses are all missing-from-catalog / excluded / study-abroad
 *  yield an EMPTY candidates+domain (they become placeholders downstream — not handled here). */
export function buildRequirementVariables(ctx: ConstraintContext): RequirementVariable[] {
    const { input, futureTerms } = ctx;
    const excludedCourseIds = new Set<string>(
        (input.preferences?.exclusions ?? []).map(e => e.courseId),
    );

    const out: RequirementVariable[] = [];
    for (const req of input.unmetRequirements) {
        const candidates = req.candidateCourses.filter(
            cid =>
                input.courseCatalog.has(cid) &&
                !excludedCourseIds.has(cid) &&
                !isStudyAbroadCourse(cid),
        );

        const domain: Array<{ courseId: string; term: string }> = [];
        for (const cid of candidates) {
            const offered = input.offerings.get(cid);
            for (const term of futureTerms) {
                const parsed = parseTerm(term);
                if (!parsed) continue;
                // Legal by offering season (empty/absent offerings ⇒ any season).
                if (offered && offered.length > 0 && !offered.includes(parsed.season as never)) {
                    continue;
                }
                domain.push({ courseId: cid, term });
            }
        }

        out.push({
            rId: req.rId,
            title: req.title,
            category: req.category,
            credits: req.credits,
            candidates,
            domain,
        });
    }
    return out;
}

// ---------------------------------------------------------------------------
// Hard-constraint contract
// ---------------------------------------------------------------------------

export type HardConstraintId =
    | "offeringSeasonMatch"
    | "prereqsSatisfied"
    | "notClauseClear"
    | "coreqsSameTerm"
    | "perTermCeiling"
    | "perTermFloor"
    | "requirementCoverage"
    | "creditMinimum"
    | "graduationTarget"
    | "residencyFloor"
    | "majorCreditFloor"
    | "gpaFloors";

export type ConstraintPhase = "incremental" | "completion";

/** Reuse FeasibilityReport's violation shape so the search can pass these straight through. */
export type HardViolation = FeasibilityReport["constraintViolations"][number];
export interface HardResult {
    ok: boolean;
    violations: HardViolation[];
}

export interface HardConstraint {
    id: HardConstraintId;
    phase: ConstraintPhase;
    axis: ValidatorAxis | "perPlacement"; // the validator axis this maps to (documents the proof)
    check(plan: PartialPlan, ctx: ConstraintContext): HardResult;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const OK: HardResult = { ok: true, violations: [] };

function result(violations: HardViolation[]): HardResult {
    return { ok: violations.length === 0, violations };
}

/** courseId → term, from all placements. (Last write wins, but each course
 *  appears at most once in a well-formed plan.) */
function plannedPlacements(plan: PartialPlan): Map<string, string> {
    const m = new Map<string, string>();
    for (const p of plan.placed) m.set(p.courseId, p.term);
    return m;
}

/** term → Σ credits of placed courses in that term. */
function perTermCredits(plan: PartialPlan): Map<string, number> {
    const m = new Map<string, number>();
    for (const p of plan.placed) m.set(p.term, (m.get(p.term) ?? 0) + p.credits);
    return m;
}

// ===========================================================================
// Incremental predicates (mirror solver.ts placement-time checks)
// ===========================================================================

/** offeringSeasonMatch — mirrors solver.ts offering screen (offered && season ∈ offered).
 *  Empty/absent offerings ⇒ no constraint. */
export function checkOfferingSeasonMatch(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const violations: HardViolation[] = [];
    for (const p of plan.placed) {
        const offered = ctx.input.offerings.get(p.courseId);
        if (!offered || offered.length === 0) continue;
        const parsed = parseTerm(p.term);
        const season = parsed?.season;
        if (!season || !offered.includes(season as never)) {
            violations.push({
                kind: "offering_pattern",
                course: p.courseId,
                term: p.term,
                detail: `Course ${p.courseId} is not offered in ${season ?? p.term} (offered: ${offered.join(", ")}).`,
            });
        }
    }
    return result(violations);
}

/** prereqsSatisfied — mirrors solver.ts:633-637 (checkAllPrereqs; petition soft-allows).
 *  source "ip" is exempt (IP courses are assumed-passing forward projections). */
export function checkPrereqsSatisfied(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const violations: HardViolation[] = [];
    const placements = plannedPlacements(plan);
    for (const p of plan.placed) {
        if (p.source === "ip") continue;
        const res = checkAllPrereqs(p.courseId, p.term, ctx.input, placements);
        if (!res.satisfied && !res.requiresPetition) {
            violations.push({
                kind: "prereq_unsatisfiable",
                course: p.courseId,
                term: p.term,
                detail: `Prerequisites for ${p.courseId} are not satisfied by ${p.term}.`,
            });
        }
    }
    return result(violations);
}

/** notClauseClear — mirrors solver.ts:577 (isExcludedByNotClause). A course never
 *  excludes itself: the placedBefore set passed per-course omits the course itself. */
export function checkNotClauseClear(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const violations: HardViolation[] = [];
    for (const p of plan.placed) {
        // placedBefore = every OTHER placed course (excluding p itself).
        const placedOthers = new Set<string>();
        for (const q of plan.placed) {
            if (q.courseId !== p.courseId) placedOthers.add(q.courseId);
        }
        if (isExcludedByNotClause(p.courseId, ctx.input.prereqs, ctx.input.coursesTaken, placedOthers)) {
            violations.push({
                kind: "not_clause",
                course: p.courseId,
                term: p.term,
                detail: `Course ${p.courseId} is excluded by a NOT prereq clause (a co-listed/completed course blocks it).`,
            });
        }
    }
    return result(violations);
}

/** coreqsSameTerm — mirrors the same-term intent of solver.ts:644-701. For each
 *  unmet coreq (NOT in coursesTaken / coursesInProgress) that IS placed in the plan,
 *  it must share the dependent's term. Unplaced coreqs are coverage's concern. */
export function checkCoreqsSameTerm(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const coreqMap = ctx.input.coreqs;
    if (!coreqMap || coreqMap.size === 0) return OK;
    const violations: HardViolation[] = [];
    const placements = plannedPlacements(plan);

    for (const p of plan.placed) {
        const coreqIds = coreqMap.get(p.courseId) ?? [];
        for (const coreqId of coreqIds) {
            // Already satisfied concurrently — no enforcement (matches solver.ts:653-655).
            if (ctx.input.coursesTaken.has(coreqId)) continue;
            if (ctx.input.coursesInProgress.has(coreqId)) continue;
            const coreqTerm = placements.get(coreqId);
            if (coreqTerm === undefined) continue; // unplaced → coverage handles it
            if (coreqTerm !== p.term) {
                violations.push({
                    kind: "other",
                    course: p.courseId,
                    term: p.term,
                    detail: `Co-requisite ${coreqId} must be placed in the same term as ${p.courseId} (placed in ${coreqTerm}, expected ${p.term}).`,
                });
            }
        }
    }
    return result(violations);
}

/** perTermCeiling — mirrors solver.ts:1072 (termCredits > creditCeiling). */
export function checkPerTermCeiling(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const violations: HardViolation[] = [];
    for (const [term, credits] of perTermCredits(plan)) {
        if (credits > ctx.input.creditCeiling) {
            violations.push({
                kind: "credit_ceiling",
                term,
                detail: `Above ceiling (${credits} > ${ctx.input.creditCeiling}).`,
            });
        }
    }
    return result(violations);
}

// ===========================================================================
// Completion predicates (mirror the validator's 7 axes)
// ===========================================================================

/** perTermFloor — mirrors solver.ts:1044-1070 (visaValidator per non-empty future term).
 *  Skips terms with 0 placed credits (the search fills terms; an empty mid-plan term
 *  is not a floor violation). */
export function checkPerTermFloor(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const { input, futureTerms } = ctx;
    const lastTerm = futureTerms[futureTerms.length - 1];
    const byTerm = perTermCredits(plan);
    const violations: HardViolation[] = [];

    for (const term of futureTerms) {
        const termCredits = byTerm.get(term) ?? 0;
        if (termCredits <= 0) continue; // empty term — skipped

        const vResult = visaValidator({
            termCredits,
            term,
            profile: {
                visaStatus: input.visaStatus as "f1" | "domestic" | "other" | undefined,
                isFinalTerm: term === lastTerm,
            },
            f1Floor: input.f1Floor,
            domesticPartTimeFloor: input.domesticPartTimeFloor,
            f1OnlineCreditsPerTermCap: null,
        });

        if (vResult.fullTimeSatisfied.status === "fail") {
            violations.push({
                kind: "credit_floor",
                term,
                detail: `Below F-1 full-time floor (${termCredits} credits). ${
                    vResult.fullTimeSatisfied.status === "fail" ? vResult.fullTimeSatisfied.reason : ""
                }`,
            });
        }
        if (vResult.creditMinimumSatisfied.status === "fail") {
            violations.push({
                kind: "credit_floor",
                term,
                detail: `Below minimum enrollment floor (${termCredits} credits). ${
                    vResult.creditMinimumSatisfied.status === "fail" ? vResult.creditMinimumSatisfied.reason : ""
                }`,
            });
        }
    }
    return result(violations);
}

/** requirementCoverage — mirrors validator axis 1 (graduationPathValidator.ts:85-184).
 *  Every requirement variable with ≥1 viable candidate must be covered by a BOUND
 *  placement (source ∈ {requirement, pin, ip}); placeholders/free do NOT count. */
export function checkRequirementCoverage(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const variables = buildRequirementVariables(ctx);

    // rId → set of courseIds covering it via a bound source.
    const coveredRIds = new Set<string>();
    for (const p of plan.placed) {
        if (p.satisfiesRId === null) continue;
        if (p.source === "requirement" || p.source === "pin" || p.source === "ip") {
            coveredRIds.add(p.satisfiesRId);
        }
    }

    const violations: HardViolation[] = [];
    for (const v of variables) {
        if (v.candidates.length === 0) continue; // placeholder downstream — not actionable here
        if (!coveredRIds.has(v.rId)) {
            violations.push({
                kind: "other",
                detail: `Requirement ${v.rId} (${v.title}) is not satisfied by any bound course in the plan.`,
            });
        }
    }
    return result(violations);
}

/** creditMinimum — mirrors validator axis 3 (graduationPathValidator.ts:227-244). */
export function checkCreditMinimum(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const planned = plan.placed.reduce((s, p) => s + p.credits, 0);
    const total = ctx.input.creditsEarned + planned;
    if (total >= ctx.input.graduationCreditMinimum) return OK;
    return result([
        {
            kind: "graduation_total",
            detail: `Projected total credits ${total} < ${ctx.input.graduationCreditMinimum}.`,
        },
    ]);
}

/** graduationTarget — mirrors validator axis 7 (graduationPathValidator.ts:465-501).
 *  Walks futureTerms chronologically; the first term whose running total
 *  (creditsEarned + per-term placed credits) ≥ graduationCreditMinimum is the
 *  completion term. Fails if none reach it, or if completion is AFTER graduationTerm. */
export function checkGraduationTarget(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const { input, futureTerms } = ctx;
    const byTerm = perTermCredits(plan);

    let cumulative = input.creditsEarned;
    let completionTerm: string | null = null;
    for (const term of futureTerms) {
        cumulative += byTerm.get(term) ?? 0;
        if (cumulative >= input.graduationCreditMinimum && completionTerm === null) {
            completionTerm = term;
        }
    }

    if (completionTerm === null) {
        return result([
            {
                kind: "graduation_total",
                detail: `Projected credits never reach ${input.graduationCreditMinimum} within the plan's terms.`,
            },
        ]);
    }
    if (compareSolverTerms(completionTerm, input.graduationTerm) <= 0) return OK;
    return result([
        {
            kind: "graduation_total",
            detail: `Graduation completion term ${completionTerm} is after target ${input.graduationTerm}.`,
        },
    ]);
}

/** residencyFloor — mirrors validator axis 4 residency (graduationPathValidator.ts:259-279).
 *  Baseline = dpr.cumulative.residencyUsed; counts placed credits from bound sources
 *  (requirement / pin / ip). When residencyMinCredits is null → NO violation (the
 *  validator returns requires-approval, not fail). */
export function checkResidencyFloor(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const min = ctx.input.programRules.residencyMinCredits;
    if (min == null) return OK;

    const baseline = ctx.input.dpr.cumulative.residencyUsed ?? 0;
    const plannedResidency = plan.placed.reduce((s, p) => {
        if (p.source === "requirement" || p.source === "pin" || p.source === "ip") return s + p.credits;
        return s;
    }, 0);
    const projected = baseline + plannedResidency;
    if (projected >= min) return OK;
    return result([
        {
            kind: "other",
            detail: `Projected residency credits ${projected} < required ${min} (residency threshold).`,
        },
    ]);
}

/** majorCreditFloor — mirrors validator axis 4 major (graduationPathValidator.ts:288-306).
 *  Sums placed credits where workloadTier ∈ {major-required, major-elective} AND source
 *  is bound (requirement / pin / ip). null → no violation. */
export function checkMajorCreditFloor(plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const min = ctx.input.programRules.majorCreditMinimum;
    if (min == null) return OK;

    const plannedMajor = plan.placed.reduce((s, p) => {
        const isBound = p.source === "requirement" || p.source === "pin" || p.source === "ip";
        const isMajorTier = p.workloadTier === "major-required" || p.workloadTier === "major-elective";
        return isBound && isMajorTier ? s + p.credits : s;
    }, 0);
    if (plannedMajor >= min) return OK;
    return result([
        {
            kind: "other",
            detail: `Projected major credits ${plannedMajor} < required ${min} (major threshold).`,
        },
    ]);
}

/** gpaFloors — mirrors solver.ts:1141-1156 (feeds validator axis 5 via gpa_floor kind).
 *  Placement-independent: same result for any plan. */
export function checkGpaFloors(_plan: PartialPlan, ctx: ConstraintContext): HardResult {
    const { input } = ctx;
    const violations: HardViolation[] = [];
    if (input.cumulativeGpa < input.graduationGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Cumulative GPA ${input.cumulativeGpa} is below the ${input.graduationGpaFloor} graduation floor.`,
        });
    }
    if (input.majorGpaFloor != null && input.majorGpa != null && input.majorGpa < input.majorGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Major GPA ${input.majorGpa} is below the ${input.majorGpaFloor} major-completion floor.`,
        });
    }
    return result(violations);
}

// ===========================================================================
// Registry + composition
// ===========================================================================

/** Registry of all hard constraints, in a stable order. */
export const HARD_CONSTRAINTS: HardConstraint[] = [
    { id: "offeringSeasonMatch", phase: "incremental", axis: "perPlacement", check: checkOfferingSeasonMatch },
    { id: "prereqsSatisfied", phase: "incremental", axis: "perPlacement", check: checkPrereqsSatisfied },
    { id: "notClauseClear", phase: "incremental", axis: "perPlacement", check: checkNotClauseClear },
    { id: "coreqsSameTerm", phase: "incremental", axis: "perPlacement", check: checkCoreqsSameTerm },
    { id: "perTermCeiling", phase: "incremental", axis: "visaAxesPass", check: checkPerTermCeiling },
    { id: "perTermFloor", phase: "completion", axis: "visaAxesPass", check: checkPerTermFloor },
    { id: "requirementCoverage", phase: "completion", axis: "requirementGroupsSatisfied", check: checkRequirementCoverage },
    { id: "creditMinimum", phase: "completion", axis: "totalCreditsMeetMinimum", check: checkCreditMinimum },
    { id: "graduationTarget", phase: "completion", axis: "graduationTargetMet", check: checkGraduationTarget },
    { id: "residencyFloor", phase: "completion", axis: "thresholdsMet", check: checkResidencyFloor },
    { id: "majorCreditFloor", phase: "completion", axis: "thresholdsMet", check: checkMajorCreditFloor },
    { id: "gpaFloors", phase: "completion", axis: "visaAxesPass", check: checkGpaFloors },
];

/** Run all hard constraints (optionally filtered to one phase). ok === (no violations). */
export function checkHardConstraints(
    plan: PartialPlan,
    ctx: ConstraintContext,
    phase?: ConstraintPhase,
): HardResult {
    const violations: HardViolation[] = [];
    for (const c of HARD_CONSTRAINTS) {
        if (phase !== undefined && c.phase !== phase) continue;
        violations.push(...c.check(plan, ctx).violations);
    }
    return result(violations);
}
