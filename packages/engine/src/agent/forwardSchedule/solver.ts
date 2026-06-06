/**
 * Phase 2 P2.2c — Forward-schedule solver entry point.
 *
 * `solveForwardSchedule(input)` is the system's single planning entry point. It
 * is now a thin orchestration over three pure, individually-tested modules:
 *
 *   1. buildConstraintContext (constraintModel.ts) — precompute the immutable
 *      problem context (future-term window, prereq depths, dependents index).
 *   2. searchTopKPlans (search.ts) — a backtracking + forward-check search with
 *      incumbent tracking but NO admissible objective bound (so NOT cost-bounded
 *      branch-and-bound; a sound bound is impossible while the objective is
 *      non-monotonic). It assigns each unmet requirement a (course, term) on top
 *      of caller-supplied FIXED placements (in-progress + pins), minimising the
 *      soft objective among VALID assignments. It is COMPLETE + OPTIMAL only
 *      WITHIN its `maxNodes` budget and TRUNCATES beyond it. Where the old greedy
 *      was first-fit (and could falsely report infeasible), an EXHAUSTIVE search
 *      finds a valid plan iff one exists; a TRUNCATED one is surfaced honestly via
 *      `exhaustive` (see C1 below) so we never present a truncated search as
 *      proven-optimal or proven-infeasible.
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
 * those stages did now lives in search.ts + materializePlan.ts. The two pure
 * helpers `buildIpAssumptions` and `derivePlanState` — re-used by materializePlan
 * — were moved to solverHelpers.ts (P2 review M2) to break the
 * solver ↔ materializePlan import cycle; this file imports them from there and
 * uses derivePlanState in its body.
 *
 * `alternativeCandidates` is the REAL top-K distinct plans (P2.3): the search
 * returns up to 5 best valid leaves; the winner (plans[0]) is the main plan, and
 * each remaining leaf is materialised + summarised into an AlternativePlanSummary
 * (the fake distribution probe is gone).
 *
 * The `solveForwardSchedule(input: SolverInput): SolverOutput` signature is
 * FROZEN for production callers — build.ts and alternatives.ts call it with a
 * single argument, unchanged. C1 adds ONE optional, back-compatible trailing
 * parameter `maxNodes?: number` (a test-supporting seam): it is forwarded to the
 * search's node budget so a test can FORCE truncation on a small input and assert
 * the truncation-surfacing behaviour. Production callers omit it and get the
 * search default; the public single-arg contract is unaffected.
 */

import type { FeasibilityReport } from "@nyupath/shared";
import type { SolverInput, SolverOutput } from "./types.js";
import { buildConstraintContext, type ConstraintContext, type PlacedCourse } from "./constraintModel.js";
import { searchTopKPlans } from "./search.js";
import { materializePlan, buildAlternativeSummaries } from "./materializePlan.js";
import { classifyWorkloadTier } from "./workloadTier.js";
import { parseTerm, isOptionalTerm, derivePlanState } from "./solverHelpers.js";

type Season = "fall" | "spring" | "summer" | "january";

// `buildIpAssumptions` + its private `contingencyAvailableFor` were moved to
// solverHelpers.ts (P2 review M2) to break the solver ↔ materializePlan import
// cycle; materializePlan now imports buildIpAssumptions from solverHelpers.

// ---------------------------------------------------------------------------
// Search-truncation advisory (P2 review C1)
//
// The constraint search is complete + optimal ONLY within its node budget;
// `exhaustive === false` means the space was NOT fully explored, so a returned
// plan may not be the OPTIMUM and an empty result is NOT proven infeasible. This
// pure helper maps (exhaustive, hasValidPlan, nodesExplored) → the honest
// advisory string (or null when exhaustive, where today's proven verdicts hold):
//
//   - exhaustive            → null (no advisory; the search fully explored the
//                             space, so the winner is the true optimum and an
//                             empty result is a PROVEN infeasibility).
//   - truncated, hasValidPlan → "valid but maybe not most-preferred" — the
//                             returned plan PASSED the completion-leaf check (the
//                             post-hoc validator confirms it is VALID); it simply
//                             may not be the best-balanced one.
//   - truncated, no valid plan → "feasibility could not be confirmed" — NOT a
//                             proven infeasibility; a valid plan may still exist
//                             beyond the budget.
//
// Extracted as a pure, unit-testable helper; the gating that consumes it lives in
// solveForwardSchedule.
// ---------------------------------------------------------------------------

export function truncationWarning(
    exhaustive: boolean,
    hasValidPlan: boolean,
    nodesExplored: number,
): string | null {
    if (exhaustive) return null;
    if (hasValidPlan) {
        return (
            `Plan search was truncated after ${nodesExplored} candidate placements; ` +
            `the returned plan is valid but may not be the most preferred — a ` +
            `better-balanced plan could exist.`
        );
    }
    return (
        `Plan search was truncated after ${nodesExplored} candidate placements ` +
        `WITHOUT finding a valid plan — feasibility could not be confirmed within ` +
        `the search budget (a valid plan may still exist). Verify with your adviser.`
    );
}

/**
 * Capacity diagnostic (jointly-infeasible blocker). When the search returns NO
 * plan, even with no single requirement individually unplaceable the remaining
 * unmet requirements may simply not FIT: their summed credits exceed the credit
 * capacity left in the NON-optional (fall/spring) terms after the fixed placements.
 *
 *   requiredCredits   = Σ credits of unmet requirements NOT already covered by a
 *                       fixed placement (a fixed placement covers a requirement when
 *                       its satisfiesRId === the requirement's rId).
 *   availableCapacity = Σ over non-optional future terms of
 *                       (creditCeiling − fixed credits already placed in that term),
 *                       clamped at 0 per term (an over-ceiling fixed term adds none).
 *
 * Returns a `graduation_total` violation ONLY when requiredCredits > availableCapacity
 * (the true "would need 22 cr in spring, over the 18 ceiling"-style blocker); else
 * null — never fabricated.
 */
function computeCapacityDiagnostic(
    input: SolverInput,
    ctx: ConstraintContext,
    fixed: PlacedCourse[],
): FeasibilityReport["constraintViolations"][number] | null {
    const coveredByFixed = new Set(
        fixed.map(p => p.satisfiesRId).filter((rId): rId is string => rId !== null),
    );
    const requiredCredits = input.unmetRequirements
        .filter(r => !coveredByFixed.has(r.rId))
        .reduce((s, r) => s + r.credits, 0);

    const nonOptionalTerms = ctx.futureTerms.filter(t => !isOptionalTerm(t));
    const fixedCreditsByTerm = new Map<string, number>();
    for (const p of fixed) {
        fixedCreditsByTerm.set(p.term, (fixedCreditsByTerm.get(p.term) ?? 0) + p.credits);
    }
    const availableCapacity = nonOptionalTerms.reduce((s, term) => {
        const used = fixedCreditsByTerm.get(term) ?? 0;
        return s + Math.max(0, input.creditCeiling - used);
    }, 0);

    if (requiredCredits <= availableCapacity) return null;
    return {
        kind: "graduation_total",
        detail:
            `The remaining requirements need ~${requiredCredits} credits, but only ${availableCapacity} ` +
            `credits of capacity exist in the ${nonOptionalTerms.length} term${nonOptionalTerms.length === 1 ? "" : "s"} ` +
            `through ${input.graduationTerm} — add summer/J-term or extend the graduation target.`,
    };
}

// `derivePlanState` was moved to solverHelpers.ts (P2 review M2) alongside
// buildIpAssumptions to break the solver ↔ materializePlan import cycle. The
// solver body re-derives state (after folding in extra pin / unsatisfiable
// violations) using the imported helper.

// ---------------------------------------------------------------------------
// Main export — constraint search + materialize
// ---------------------------------------------------------------------------

export function solveForwardSchedule(input: SolverInput, maxNodes?: number): SolverOutput {
    const ctx = buildConstraintContext(input);

    // P2.10 (a) — build-time advisories carried onto the output. C1 appends a
    // search-truncation advisory below; the final array is spread onto
    // SolverOutput.warnings (omitted when empty). Copy so we never mutate
    // input.warnings.
    const warningsList: string[] = [...input.warnings];

    // Empty horizon (graduation == current term): nothing to plan. materializePlan
    // returns the same empty valid bundle the old greedy did. (No search runs, so
    // no truncation is possible — only build-time advisories apply here.)
    if (ctx.futureTerms.length === 0) {
        const out = materializePlan({ placed: [] }, ctx);
        return warningsList.length > 0 ? { ...out, warnings: warningsList } : out;
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
    //
    // C1: the search is complete + optimal ONLY within its node budget. We consume
    // `top.exhaustive` (and `top.nodesExplored`) so a TRUNCATED search never reads
    // as proven-optimal or proven-infeasible (see gating below). `maxNodes` is the
    // test-supporting seam (undefined in production → search default).
    // -----------------------------------------------------------------------
    const top = searchTopKPlans(ctx, { fixed, k: 5, ...(maxNodes !== undefined ? { maxNodes } : {}) });
    const winnerPlan = top.plans[0] ?? { placed: fixed };

    // C1 — honest truncation advisory (null when exhaustive; today's verdicts then
    // hold unchanged). Appended to the warnings carried onto SolverOutput.
    const truncMsg = truncationWarning(top.exhaustive, top.plans.length > 0, top.nodesExplored);
    if (truncMsg !== null) warningsList.push(truncMsg);

    if (top.plans.length === 0) {
        // Per-requirement binding constraints — the SPECIFIC reason each unplaceable
        // requirement is blocked (offering / ceiling / coreq / NOT / prereq-depth),
        // replacing the old uncomputable generic "could not be placed" prereq push.
        // These hold REGARDLESS of truncation (each is an individual-impossibility
        // proof against just `fixed`), so they are surfaced whether or not the
        // search was exhaustive.
        for (const b of top.blockers) {
            extraViolations.push({ kind: b.kind, detail: b.detail });
        }

        // Capacity diagnostic (jointly infeasible) — even when no SINGLE requirement
        // is individually unplaceable, the remaining unmet requirements can simply
        // fail to FIT: their total credits exceed the credit capacity left in the
        // non-optional terms. This is a JOINT-infeasibility verdict, which is only
        // PROVEN when the search fully explored the space. C1: gate it on
        // `top.exhaustive` — when the search was TRUNCATED (no valid plan found
        // within the budget) feasibility is UNCONFIRMED, not disproven, so we do
        // NOT emit this "would need N credits"-style infeasibility framing; the
        // truncation advisory above is the honest signal (any real per-requirement
        // blockers still stand).
        if (top.exhaustive) {
            const cap = computeCapacityDiagnostic(input, ctx, fixed);
            if (cap !== null) extraViolations.push(cap);
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
        return {
            ...out,
            ...(alternativeCandidates !== undefined ? { alternativeCandidates } : {}),
            ...(warningsList.length > 0 ? { warnings: warningsList } : {}),
        };
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
    return {
        ...out,
        feasibility,
        state,
        ...(alternativeCandidates !== undefined ? { alternativeCandidates } : {}),
        ...(warningsList.length > 0 ? { warnings: warningsList } : {}),
    };
}
