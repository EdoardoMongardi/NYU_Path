/**
 * Phase 2 P2.2c — Forward-schedule solver entry point.
 *
 * `solveForwardSchedule(input)` is the system's single planning entry point. It
 * is now a thin orchestration over three pure, individually-tested modules:
 *
 *   1. buildConstraintContext (constraintModel.ts) — precompute the immutable
 *      problem context (future-term window, prereq depths, dependents index).
 *   2. searchBestPlan (search.ts) — a COMPLETE backtracking + forward-check +
 *      branch-and-bound search that assigns each unmet requirement a (course,
 *      term) on top of caller-supplied FIXED placements (in-progress + pins),
 *      minimising the soft objective among VALID assignments. Where the old
 *      greedy was first-fit (and could falsely report infeasible), the search is
 *      optimal/complete: it finds a valid plan iff one exists.
 *   3. materializePlan (materializePlan.ts) — turn the search's PartialPlan into
 *      the full SolverOutput (rich specific_planned slots, placeholders for
 *      uncovered requirements, free-elective fill, per-term visa invariants,
 *      Stage-8 global checks, assumptions, balanceScore, coarse state,
 *      feasibility). This is the verbatim tail the old greedy used to inline.
 *
 * This file deletes the old greedy core entirely (Stage-5 candidate ranking, the
 * pin-placement pass, the Stage-6 greedy placement loop + inline slot building,
 * the Stage-6c placeholder block, the free-elective fill, the Stage-6d visa
 * block, the Stage-8 global checks, the post-pass, and the synthetic
 * `buildAlternativeCandidates` / `ALT_DISTRIBUTIONS` Stage-7 stub). Everything
 * those stages did now lives in search.ts + materializePlan.ts. Only two helpers
 * remain here — `buildIpAssumptions` and `derivePlanState` — because
 * materializePlan re-uses them (and this body uses derivePlanState).
 *
 * `alternativeCandidates` is the REAL top-K distinct plans (P2.3): the search
 * returns up to 5 best valid leaves; the winner (plans[0]) is the main plan, and
 * each remaining leaf is materialised + summarised into an AlternativePlanSummary
 * (the fake distribution probe is gone).
 *
 * The `solveForwardSchedule(input: SolverInput): SolverOutput` signature is
 * FROZEN — build.ts and alternatives.ts call it unchanged.
 */

import type { ForwardSemester, FeasibilityReport, Assumption } from "@nyupath/shared";
import type { SolverInput, SolverOutput } from "./types.js";
import { buildConstraintContext, type PlacedCourse } from "./constraintModel.js";
import { searchTopKPlans } from "./search.js";
import { materializePlan, buildAlternativeSummaries } from "./materializePlan.js";
import { classifyWorkloadTier } from "./workloadTier.js";
import { parseTerm } from "./solverHelpers.js";

type Season = "fall" | "spring" | "summer" | "january";

// ---------------------------------------------------------------------------
// IP assumption builder (Decision #30)
//
// Retained here (not moved to materializePlan) because materializePlan imports
// it from this module. Emits one IP_COURSE_COMPLETION assumption per in-progress
// course that is a prereq of at least one PLACED (requirement/pin) slot.
// ---------------------------------------------------------------------------

export function buildIpAssumptions(
    input: SolverInput,
    placedCourses: Set<string>,
    dependentsIndex: Map<string, string[]>,
): Assumption[] {
    const assumptions: Assumption[] = [];
    for (const ipCourseId of input.coursesInProgress.keys()) {
        // Only emit an assumption if this IP course is a prereq for at least one placed slot
        const dependents = dependentsIndex.get(ipCourseId) ?? [];
        const affectedPlaced = dependents.filter(d => placedCourses.has(d));
        if (affectedPlaced.length === 0) continue;

        assumptions.push({
            type: "IP_COURSE_COMPLETION",
            courseId: ipCourseId,
            consequenceIfFalse: `Downstream slots ${affectedPlaced.join(", ")} may need to move to a later term.`,
            cascadingSlots: affectedPlaced,
            contingencyPlanAvailable: false,
        });
    }
    return assumptions;
}

// ---------------------------------------------------------------------------
// PlanState derivation (Decision #32 — coarse Task 3.1 approximation)
//
// Retained here (not moved to materializePlan) because materializePlan imports
// it from this module, and the solver body re-derives state after folding in
// extra (pin / unsatisfiable) violations.
// ---------------------------------------------------------------------------

export function derivePlanState(
    semesters: ForwardSemester[],
    feasibility: FeasibilityReport,
    assumptions: Assumption[],
): import("@nyupath/shared").PlanState {
    // Returns 3 of the 4 PlanState members. The fourth state
    // ("student-preferred-invalid-draft") is set by Phase 14's mutation
    // layer when a student confirms a plan despite hard violations — that
    // input is not available to the solver, so it is not emittable here.
    if (!feasibility.feasible) return "infeasible-draft";

    // Check for trade-off signals
    const hasTradeoff =
        assumptions.length > 0 ||
        semesters.some(sem =>
            sem.slots.some(
                s =>
                    (s.kind === "specific_planned" && (
                        s.requiresPetition === true ||
                        s.confidence === "irregular" ||
                        s.confidence === "permission_only" ||
                        (s.approvalAuthority !== undefined)
                    )) ||
                    s.kind === "placeholder"
            )
        );

    return hasTradeoff ? "valid-with-trade-offs" : "valid-clean";
}

// ---------------------------------------------------------------------------
// Main export — constraint search + materialize
// ---------------------------------------------------------------------------

export function solveForwardSchedule(input: SolverInput): SolverOutput {
    const ctx = buildConstraintContext(input);

    // Empty horizon (graduation == current term): nothing to plan. materializePlan
    // returns the same empty valid bundle the old greedy did.
    if (ctx.futureTerms.length === 0) {
        return materializePlan({ placed: [] }, ctx);
    }

    // Violations the SEARCH/materialize path cannot surface on its own (pins it
    // had to skip, and requirements the search could not place). Folded into the
    // materialised feasibility report at the end. Shape = FeasibilityReport's
    // constraintViolations element.
    const extraViolations: FeasibilityReport["constraintViolations"] = [];

    // -----------------------------------------------------------------------
    // Build FIXED placements (always present in every candidate plan; the search
    // assigns requirement courses on top of these).
    // -----------------------------------------------------------------------
    const fixed: PlacedCourse[] = [];

    // ---- In-progress courses (source "ip") ----
    // One per coursesInProgress entry. The placement's term is the row's own
    // term when it falls inside the planning window, else the current term
    // (mirrors the old IP pre-population + materialize's IP handling). Credits
    // from the catalog (default 4 when absent). IP courses satisfy no bound
    // requirement (satisfiesRId null) — coverage counts only requirement/pin.
    for (const [ipCourseId, { term: ipTerm }] of input.coursesInProgress) {
        const term = ctx.futureTerms.includes(ipTerm) ? ipTerm : input.currentTerm;
        const meta = input.courseCatalog.get(ipCourseId);
        const credits = meta?.credits ?? 4;
        const wt = classifyWorkloadTier({
            courseId: ipCourseId,
            satisfiesRules: [],
            majorRuleKinds: input.programRules.majorRuleKinds,
            schoolCoreRuleIds: input.programRules.schoolCoreRuleIds,
            generalCategoryRuleIds: input.programRules.generalCategoryRuleIds,
            bulletinTitle: input.courseTitles?.get(ipCourseId),
            bulletinKeywords: input.courseBulletinKeywords?.get(ipCourseId),
        });
        fixed.push({
            courseId: ipCourseId,
            term,
            credits,
            workloadTier: wt.tier,
            workloadWeight: wt.weight,
            satisfiesRId: null,
            source: "ip",
        });
    }

    // ---- Pins (source "pin") ----
    // Each pin is a hard student preference within the valid candidate set.
    // A pin CANNOT bypass the offering pattern or escape the planning window:
    //   - pinned to a non-future term → "other" violation, skipped (not fixed).
    //   - offering pattern known and season(term) ∉ it → "offering_pattern"
    //     violation, skipped.
    // Pin META resolution (mirrors the old pin pass + Step-8d off-catalog
    // softening): catalog → offCatalogCredits → { title: courseId, credits: 0 }.
    // PIN COVERAGE: the pin's satisfiesRId is the rId of the FIRST unmet
    // requirement whose candidateCourses include the pinned course (so the pin
    // COVERS that requirement and the search skips that variable — see
    // search.ts's coveredByFixed filter), else null. Workload tier/weight are
    // classified with satisfiesRules [matchedRId ?? ""].
    for (const pin of input.preferences?.pins ?? []) {
        if (!ctx.futureTerms.includes(pin.term)) {
            extraViolations.push({
                kind: "other",
                course: pin.courseId,
                detail: `Pinned to ${pin.term}, not a future term in the plan window.`,
            });
            continue;
        }

        // Resolve credits (auto-planning never consults offCatalogCredits; this
        // is the explicit-pin softening path).
        let meta = input.courseCatalog.get(pin.courseId);
        if (!meta) {
            meta = input.offCatalogCredits?.get(pin.courseId) ?? { title: pin.courseId, credits: 0 };
        }

        const offered = input.offerings.get(pin.courseId);
        const season = (parseTerm(pin.term)?.season ?? "fall") as Season;
        if (offered && offered.length > 0 && !offered.includes(season)) {
            extraViolations.push({
                kind: "offering_pattern",
                course: pin.courseId,
                term: pin.term,
                detail: `${pin.courseId} pinned to ${pin.term}, but offering pattern is ${offered.join(", ")}.`,
            });
            continue;
        }

        // PIN COVERAGE — first unmet requirement whose candidates include the pin.
        const matchedRId =
            input.unmetRequirements.find(r => r.candidateCourses.includes(pin.courseId))?.rId ?? null;

        const wt = classifyWorkloadTier({
            courseId: pin.courseId,
            satisfiesRules: [matchedRId ?? ""],
            majorRuleKinds: input.programRules.majorRuleKinds,
            schoolCoreRuleIds: input.programRules.schoolCoreRuleIds,
            generalCategoryRuleIds: input.programRules.generalCategoryRuleIds,
            bulletinTitle: input.courseTitles?.get(pin.courseId),
            bulletinKeywords: input.courseBulletinKeywords?.get(pin.courseId),
        });

        fixed.push({
            courseId: pin.courseId,
            term: pin.term,
            credits: meta.credits,
            workloadTier: wt.tier,
            workloadWeight: wt.weight,
            satisfiesRId: matchedRId,
            source: "pin",
        });
    }

    // -----------------------------------------------------------------------
    // Run the search (requirement placements on top of fixed). The WINNER —
    // top.plans[0] — is the optimal valid plan (=== the old searchBestPlan plan);
    // top.plans[1..] are the next-best DISTINCT valid plans (≤4 alternatives).
    // When NO valid plan exists (top.plans empty), materialise the fixed-only
    // plan (so IP + pins + placeholders still render) and surface each
    // unsatisfiable requirement as a violation — the exact old infeasible path.
    // -----------------------------------------------------------------------
    const top = searchTopKPlans(ctx, { fixed, k: 5 });
    const winnerPlan = top.plans[0] ?? { placed: fixed };
    if (top.plans.length === 0) {
        for (const rId of top.unsatisfiable) {
            extraViolations.push({
                kind: "prereq_unsatisfiable",
                detail: `Requirement ${rId} could not be placed in any valid (course, term).`,
            });
        }
    }

    const out = materializePlan(winnerPlan, ctx);

    // Materialise each alternative leaf the SAME way as the winner, then summarise
    // them against the winner. The alternatives are NOT subjected to the pin/
    // unsatisfiable extra-violation fold (those describe the whole problem, not a
    // per-alternative defect) — and buildAlternativeSummaries reads only the
    // winner's balanceScore + last term, both unaffected by that fold. Left
    // undefined when there are no alternatives.
    const altOuts = top.plans.slice(1).map(p => materializePlan(p, ctx));
    const alternativeCandidates =
        altOuts.length > 0 ? buildAlternativeSummaries(out, altOuts) : undefined;

    if (extraViolations.length === 0) {
        return alternativeCandidates !== undefined ? { ...out, alternativeCandidates } : out;
    }

    // Fold the extra violations into the feasibility report and re-derive state.
    const constraintViolations = [...out.feasibility.constraintViolations, ...extraViolations];
    const feasibility: FeasibilityReport = {
        ...out.feasibility,
        constraintViolations,
        feasible: constraintViolations.length === 0,
        ...(constraintViolations.length > 0
            ? { infeasibilityReason: `${constraintViolations.length} constraint violation(s).` }
            : {}),
    };
    const state = derivePlanState(out.semesters, feasibility, out.assumptions);
    return alternativeCandidates !== undefined
        ? { ...out, feasibility, state, alternativeCandidates }
        : { ...out, feasibility, state };
}
