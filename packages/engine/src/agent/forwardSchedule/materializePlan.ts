/**
 * Phase 2 P2.2b — Materialise a search result into a full SolverOutput.
 *
 * The constraint search (search.ts) returns a `PartialPlan` of chosen
 * requirement / pin / in-progress placements. This module turns that placement
 * into the EXACT `SolverOutput` the rest of the system expects — the same shape
 * the old greedy solver produced in its tail (solver.ts `solveForwardSchedule`,
 * the section from per-term init through the post-pass). It does NOT run the
 * greedy placement loop: every requirement/pin placement is taken verbatim from
 * the plan; this module only re-derives the rich per-slot fields, adds
 * placeholder slots for requirements the search left uncovered, fills each term
 * to its credit target with free-elective placeholders, runs the per-term visa
 * invariants + Stage-8 global checks, and assembles the feasibility / balance /
 * assumptions / state bundle.
 *
 * Pure: deterministic from (plan, ctx); no I/O, no module-level mutable state.
 *
 * Boundary (intentional): `alternativeCandidates` is left `undefined` — a later
 * task computes the real top-K distinct plans; the old greedy solver's synthetic
 * distribution-probe `buildAlternativeCandidates` is deliberately NOT called.
 *
 * Reuses the pure primitives from solverHelpers.ts (effectiveTermTarget,
 * checkAllPrereqs, computeDownstreamImpact, isCriticalPath, parseTerm) plus the
 * context's pre-built dependents index, and the two helpers exported from
 * solver.ts (buildIpAssumptions, derivePlanState) — none are reimplemented.
 */

import type {
    ScheduleSlot,
    ScheduleSlotSpecificPlanned,
    ScheduleSlotPlaceholder,
    ForwardSemester,
    FeasibilityReport,
    SlotRationale,
    SlotFlexibility,
    TermConstraint,
    ConfidenceTier,
    WorkloadTier,
    AlternativePlanSummary,
} from "@nyupath/shared";
import type { SolverOutput } from "./types.js";
import type { ConstraintContext, PartialPlan, PlacedCourse } from "./constraintModel.js";
import {
    scorePlan,
    checkOfferingSeasonMatch,
    checkPrereqsSatisfied,
    checkNotClauseClear,
    checkCoreqsSameTerm,
    checkPerTermCeiling,
} from "./constraintModel.js";
import { visaValidator } from "../../dpr/visaValidator.js";
import { visaNotesForCredits } from "./visaPolicy.js";
import { classifyWorkloadTier } from "./workloadTier.js";
import { computeBalanceScore } from "./balanceScore.js";
import {
    parseTerm,
    compareSolverTerms,
    effectiveTermTarget,
    checkAllPrereqs,
    computeDownstreamImpact,
    isCriticalPath,
    isStudyAbroadCourse,
    isOptionalTerm,
} from "./solverHelpers.js";
import { buildIpAssumptions, derivePlanState } from "./solver.js";

// ---------------------------------------------------------------------------
// LoadRationale builder — verbatim from solver.ts (kept private; identical
// output so the materialised ForwardSemester.loadRationale matches the greedy
// solver's byte-for-byte).
// ---------------------------------------------------------------------------

function buildLoadRationale(
    slots: ScheduleSlot[],
    creditTarget: number,
    placed: number,
): import("@nyupath/shared").LoadRationale {
    let weightedCredits = 0;
    let hardCount = 0;
    let easyCount = 0;

    for (const s of slots) {
        if (s.kind === "specific_planned") {
            weightedCredits += s.credits * (s.workloadWeight ?? 1.0);
            if ((s.workloadWeight ?? 0) >= 1.0) hardCount++;
            else easyCount++;
        } else if (s.kind === "placeholder") {
            weightedCredits += s.credits * (s.workloadWeight ?? 0.3);
            easyCount++;
        }
    }

    return {
        strategy: "balanced",
        creditsTarget: creditTarget,
        slack: Math.max(0, creditTarget - placed),
        weightedCredits,
        hardCount,
        easyCount,
        alternativeDistributionsConsidered: [],
    };
}

// ---------------------------------------------------------------------------
// Per-slot rationale helpers (P2.5) — make the search's REAL reasoning legible.
//
// The search chose course C for requirement R in term T because every OTHER
// candidate C′ was either hard-infeasible at (C′, T) given the rest of the plan,
// or feasible-but-objective-worse. These helpers re-derive that verdict by a
// COUNTERFACTUAL swap C→C′ against the FINAL plan, reusing the SAME incremental
// hard predicates + scorePlan the search used (no reimplementation), so each
// rejected alternative carries the concrete reason an advisor can quote.
// ---------------------------------------------------------------------------

/** The five incremental hard predicates, in the order the search applies them.
 *  A counterfactual swap is rejected on the FIRST that fails. */
const INCREMENTAL_PREDICATES: ReadonlyArray<{
    check: (plan: PartialPlan, ctx: ConstraintContext) => { ok: boolean; violations: Array<{ detail: string }> };
}> = [
    { check: checkOfferingSeasonMatch },
    { check: checkPrereqsSatisfied },
    { check: checkNotClauseClear },
    { check: checkCoreqsSameTerm },
    { check: checkPerTermCeiling },
];

/** Workload tier/weight for a counterfactual requirement placement of `courseId`
 *  bound to `rId` — IDENTICAL to search.ts's buildValue wiring (satisfiesRules:[rId]). */
function classifyTrialTier(
    courseId: string,
    rId: string,
    ctx: ConstraintContext,
): { tier: WorkloadTier; weight: number } {
    const wt = classifyWorkloadTier({
        courseId,
        satisfiesRules: [rId],
        majorRuleKinds: ctx.input.programRules.majorRuleKinds,
        schoolCoreRuleIds: ctx.input.programRules.schoolCoreRuleIds,
        generalCategoryRuleIds: ctx.input.programRules.generalCategoryRuleIds,
        bulletinTitle: ctx.input.courseTitles?.get(courseId),
        bulletinKeywords: ctx.input.courseBulletinKeywords?.get(courseId),
    });
    return { tier: wt.tier, weight: wt.weight };
}

/**
 * Why was alternative `altCourseId` not chosen for requirement `rId` (whose chosen
 * placement is `chosen`)? Returns the concrete `rejectedBecause`:
 *  - Non-viable (excluded / off-catalog / study-abroad) → the viability message
 *    (the search never even ranked it; it isn't in the requirement's candidates).
 *  - Else swap chosen→alt in the chosen term against `finalPlan`, run the 5
 *    incremental predicates; the FIRST violation's `detail` is the reason.
 *  - Else (hard-feasible) compare scorePlan(trial) vs `finalScore`: the chosen
 *    course balances the plan better — cite both objective values.
 */
function rejectionReasonForAlternative(
    altCourseId: string,
    chosen: PlacedCourse,
    rId: string,
    finalPlan: PartialPlan,
    finalScore: number,
    ctx: ConstraintContext,
    excludedCourseIds: Set<string>,
): string {
    const { input } = ctx;
    const altMeta = input.courseCatalog.get(altCourseId);
    if (
        excludedCourseIds.has(altCourseId) ||
        altMeta === undefined ||
        isStudyAbroadCourse(altCourseId)
    ) {
        return "not a viable candidate (excluded, off-catalog, or study-abroad)";
    }

    // Counterfactual: replace the chosen placement with an alt placement in the
    // SAME term, leaving every other placement intact. Tier/weight + credits come
    // from alt's catalog entry, exactly as the search would have built this value.
    const trialTier = classifyTrialTier(altCourseId, rId, ctx);
    const altPlacement: PlacedCourse = {
        courseId: altCourseId,
        term: chosen.term,
        credits: altMeta.credits,
        workloadTier: trialTier.tier,
        workloadWeight: trialTier.weight,
        satisfiesRId: rId,
        source: "requirement",
    };
    const trialPlan: PartialPlan = {
        placed: finalPlan.placed.map(p => (p.courseId === chosen.courseId ? altPlacement : p)),
    };

    for (const { check } of INCREMENTAL_PREDICATES) {
        const res = check(trialPlan, ctx);
        if (!res.ok && res.violations.length > 0) {
            return res.violations[0]!.detail;
        }
    }

    // Hard-feasible alternative — it lost on the soft objective.
    const altScore = scorePlan(trialPlan, ctx);
    return (
        `feasible but the chosen course balances the plan better ` +
        `(objective ${altScore.toFixed(2)} vs ${finalScore.toFixed(2)})`
    );
}

/**
 * Real feasible-term window for chosen course `courseId` in the FINAL plan.
 *
 * earliestPossibleTerm = the earliest future term where the course is offered
 *   (season matches, or offerings empty/absent) AND every one of its prereqs is
 *   either already taken / in-progress or placed in a STRICTLY earlier term.
 * latestPossibleTerm   = the latest future term where the course is offered,
 *   bounded by the planning window (which already ends at the graduation term).
 *
 * Falls back to the chosen term / last term when no term satisfies the bound
 * (defensive — the chosen placement is itself feasible, so earliest ≤ chosen).
 */
function feasibleTermWindow(
    courseId: string,
    chosenTerm: string,
    ctx: ConstraintContext,
    plannedPlacements: Map<string, string>,
): { earliestPossibleTerm: string; latestPossibleTerm: string } {
    const { input, futureTerms } = ctx;
    const offered = input.offerings.get(courseId);
    const offeredInTerm = (term: string): boolean => {
        if (!offered || offered.length === 0) return true;
        const season = parseTerm(term)?.season;
        return season != null && offered.includes(season as "fall" | "spring" | "summer" | "january");
    };

    // Direct prereq course ids (non-NOT groups) — the courses that must precede.
    const prereqIds = new Set<string>();
    for (const g of input.prereqs.get(courseId) ?? []) {
        if (g.type === "NOT") continue;
        for (const dep of g.courses) {
            if (dep) prereqIds.add(dep);
        }
    }
    const prereqsPrecede = (term: string): boolean => {
        for (const dep of prereqIds) {
            if (input.coursesTaken.has(dep)) continue;
            if (input.coursesInProgress.has(dep)) continue;
            const depTerm = plannedPlacements.get(dep);
            // Unmet & either unplaced or not strictly-before this term → blocks it.
            if (depTerm === undefined) return false;
            if (compareSolverTerms(depTerm, term) >= 0) return false;
        }
        return true;
    };

    let earliest: string | undefined;
    for (const t of futureTerms) {
        if (offeredInTerm(t) && prereqsPrecede(t)) {
            earliest = t;
            break;
        }
    }
    let latest: string | undefined;
    for (let i = futureTerms.length - 1; i >= 0; i--) {
        const t = futureTerms[i]!;
        if (offeredInTerm(t)) {
            latest = t;
            break;
        }
    }

    return {
        earliestPossibleTerm: earliest ?? chosenTerm,
        latestPossibleTerm: latest ?? futureTerms[futureTerms.length - 1] ?? chosenTerm,
    };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Turn a search result (a PartialPlan of chosen requirement/pin/ip placements) into a full
 * SolverOutput: rich specific_planned slots, placeholder slots for requirements with no bound
 * course, free-elective fill to each term's target, per-term visa notes + violations, Stage-8
 * global checks, assumptions, balanceScore, coarse state, feasibility. Mirrors the tail of the
 * old greedy solver (solveForwardSchedule) but driven by the search's placements instead of
 * the greedy loop.
 */
export function materializePlan(plan: PartialPlan, ctx: ConstraintContext): SolverOutput {
    const { input } = ctx;
    const violations: FeasibilityReport["constraintViolations"] = [];
    const placementRationale: Record<string, string> = {};

    // -----------------------------------------------------------------------
    // Terms. Reuse the context's chronological future-term window (the same
    // enumerateMainTerms(currentTerm, graduationTerm) the search used). For an
    // empty horizon, return the same empty bundle solveForwardSchedule does.
    // -----------------------------------------------------------------------
    const futureTerms = ctx.futureTerms;
    if (futureTerms.length === 0) {
        const emptyFeasibility: FeasibilityReport = {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        };
        return {
            semesters: [],
            feasibility: emptyFeasibility,
            balanceScore: 0,
            assumptions: [],
            state: "valid-clean",
        };
    }

    const perTermSlots = new Map<string, ScheduleSlot[]>();
    const perTermCredits = new Map<string, number>();
    for (const t of futureTerms) {
        perTermSlots.set(t, []);
        perTermCredits.set(t, 0);
    }

    // Index requirements by rId for category / candidate / credits lookup, and
    // build a courseId→term map of EVERY placement (for the prereq re-check, the
    // same `plannedPlacements` the solver feeds checkAllPrereqs).
    const reqByRId = new Map<string, (typeof input.unmetRequirements)[number]>();
    for (const req of input.unmetRequirements) reqByRId.set(req.rId, req);

    const plannedPlacements = new Map<string, string>();
    for (const p of plan.placed) plannedPlacements.set(p.courseId, p.term);

    // P2.5 — per-slot rationale inputs (computed once, reused per requirement slot):
    //  - excludedCourseIds: student exclusions (a course the search never ranks);
    //  - finalScore: the objective of the FINAL plan, the baseline each
    //    feasible-but-rejected alternative is compared against.
    const excludedCourseIds = new Set<string>(
        (input.preferences?.exclusions ?? []).map(e => e.courseId),
    );
    const finalScore = scorePlan(plan, ctx);

    // Dependents index over all candidate course ids — identical to the
    // ctx.dependentsIndex (built in buildConstraintContext) and to the greedy
    // solver's. Reuse ctx's so downstreamImpact / isCriticalPath match exactly.
    const dependentsIndex = ctx.dependentsIndex;

    // placedCourseSet drives IP-assumption emission (same as the greedy solver:
    // the set of courses placed by requirement/pin slots — IP rows are NOT in it).
    const placedCourseSet = new Set<string>();

    // -----------------------------------------------------------------------
    // 1. in_progress slots (source "ip"). Emit a kind:"in_progress" slot into
    //    the placement's term, mirroring solver.ts's IP pre-population. Title /
    //    credits from the catalog (default 4cr when absent). Fall back to
    //    currentTerm when the placement's term is outside the planning horizon.
    // -----------------------------------------------------------------------
    for (const p of plan.placed) {
        if (p.source !== "ip") continue;
        const targetTerm = perTermSlots.has(p.term) ? p.term : input.currentTerm;
        const targetSlots = perTermSlots.get(targetTerm);
        if (targetSlots === undefined) continue;
        const meta = input.courseCatalog.get(p.courseId);
        const ipCredits = meta?.credits ?? 4;
        targetSlots.push({
            kind: "in_progress",
            courseId: p.courseId,
            title: meta?.title ?? p.courseId,
            credits: ipCredits,
        });
        perTermCredits.set(targetTerm, (perTermCredits.get(targetTerm) ?? 0) + ipCredits);
    }

    // -----------------------------------------------------------------------
    // 2. specific_planned slots (source "requirement" | "pin"). Process in
    //    chronological term order, then by plan order within a term, so the
    //    `creditSlack` term-constraint sees the same running slack the greedy
    //    solver would have. Placements whose term is outside the horizon are
    //    dropped (the search only ever assigns futureTerms; defensive).
    // -----------------------------------------------------------------------
    const boundPlacements = plan.placed.filter(
        p => p.source === "requirement" || p.source === "pin",
    );
    // Stable chronological-by-term ordering; preserve plan order within a term.
    const termIndex = new Map<string, number>();
    futureTerms.forEach((t, i) => termIndex.set(t, i));
    const orderedBound = boundPlacements
        .map((p, i) => ({ p, i }))
        .sort((a, b) => {
            const ta = termIndex.get(a.p.term) ?? Number.MAX_SAFE_INTEGER;
            const tb = termIndex.get(b.p.term) ?? Number.MAX_SAFE_INTEGER;
            if (ta !== tb) return ta - tb;
            return a.i - b.i; // stable within a term
        })
        .map(x => x.p);

    const lastTerm = futureTerms[futureTerms.length - 1]!;

    for (const p of orderedBound) {
        if (!perTermSlots.has(p.term)) continue; // outside horizon — defensive
        const meta = input.courseCatalog.get(p.courseId);
        // Title/credits: prefer catalog; the search only places catalog courses,
        // but be defensive (off-catalog pins resolved at search time carry their
        // own credits on the PlacedCourse).
        const title = meta?.title ?? p.courseId;
        const credits = meta?.credits ?? p.credits;
        const confidence: ConfidenceTier =
            input.offeringConfidence.get(p.courseId) ?? "historically_partial";
        const offered = input.offerings.get(p.courseId);

        if (p.source === "pin") {
            // ---- Pin slot (mirror solver.ts pin branch) ----
            // Off-catalog caveat (Step-8d PR-2): an explicit student pin is
            // honored even when the course isn't in the undergraduate planning
            // catalog. Reconstruct the SAME caveat the old greedy solver emitted
            // (the PlacedCourse cannot carry it), keyed only on `input`:
            //   - in catalog            → no caveat;
            //   - off-catalog (grad)    → "verify credits/eligibility in Albert";
            //   - wholly unknown        → "may be discontinued/renumbered; verify in Albert".
            let pinCaveat: string | null = null;
            if (!meta) {
                pinCaveat = input.offCatalogCredits?.has(p.courseId)
                    ? `${p.courseId} is outside the undergraduate planning catalog ` +
                      `(graduate/professional) — verify credits and eligibility in Albert.`
                    : `${p.courseId} isn't in the current NYU bulletin — it may be ` +
                      `discontinued or renumbered (e.g. an old course number). Verify the ` +
                      `current course in Albert.`;
            }

            // A pin that COVERS a requirement (satisfiesRId set by the solver's
            // pin-coverage pass) must surface that coverage in `satisfiesRules`,
            // because the search SKIPS the covered requirement variable and the
            // authoritative runGraduationPathValidator credits a requirement only
            // from a specific_planned slot's `satisfiesRules`. Without this the
            // pin would cover the requirement in the search's bookkeeping yet the
            // validator would still see it unsatisfied (no placeholder is emitted
            // for a covered requirement either). A non-covering pin keeps [].
            const pinSatisfies = p.satisfiesRId != null ? [p.satisfiesRId] : [];

            const pinRationale: SlotRationale = {
                satisfiesRequirements: pinSatisfies,
                termConstraints: [
                    { kind: "offering", detail: `Pinned by student preference to ${p.term}.` },
                ],
                consideredAlternatives: [],
                decisionsApplied: ["D10-pinHardConstraint", "D31-pinPrecedence"],
            };
            const pinFlexibility: SlotFlexibility = {
                earliestPossibleTerm: p.term,
                latestPossibleTerm: lastTerm,
                alternativeCourses: [],
            };
            const pinnedSlot: ScheduleSlotSpecificPlanned = {
                kind: "specific_planned",
                courseId: p.courseId,
                title,
                credits,
                satisfiesRules: pinSatisfies,
                reason: `Pinned by student preference to ${p.term}.${pinCaveat ? ` ${pinCaveat}` : ""}`,
                rationale: pinRationale,
                flexibility: pinFlexibility,
                downstreamImpact: computeDownstreamImpact(p.courseId, dependentsIndex),
                workloadTier: p.workloadTier,
                workloadWeight: p.workloadWeight ?? 1.0,
                bindingState: "bound",
                confidence,
                isCriticalPath: false,
            };
            perTermSlots.get(p.term)!.push(pinnedSlot);
            perTermCredits.set(p.term, (perTermCredits.get(p.term) ?? 0) + credits);
            placedCourseSet.add(p.courseId);
            placementRationale[p.courseId] = pinnedSlot.reason;
            continue;
        }

        // ---- Requirement slot (mirror solver.ts requirement branch) ----
        const req = p.satisfiesRId != null ? reqByRId.get(p.satisfiesRId) : undefined;
        const category = req?.category ?? "requirement";
        const candidateCourses = req?.candidateCourses ?? [];

        // Re-derive the prereq check against the plan's placements (the greedy
        // solver computed prereqResult against the live plannedPlacements; the
        // full plan is a superset, so this resolves prereqs-in-an-earlier-term
        // correctly). Drives requiresPetition / approvalAuthority / decisions.
        const prereqResult = checkAllPrereqs(p.courseId, p.term, input, plannedPlacements);

        // Running slack for the `creditSlack` term-constraint: target − credits
        // already in this term BEFORE this slot (so the constraint reads like the
        // greedy solver's slack at the moment it placed this course).
        const termTarget = effectiveTermTarget(
            p.term,
            input.creditTargetPerSemester,
            input.preferences,
            input.f1Floor,
            input.domesticPartTimeFloor,
            input.creditCeiling,
        );
        const slack = termTarget - (perTermCredits.get(p.term) ?? 0);

        const termConstraints: TermConstraint[] = [];
        if (offered && offered.length > 0) {
            termConstraints.push({
                kind: "offering",
                detail: `${p.courseId} offered in: ${offered.join(", ")}`,
            });
        }
        if (slack < credits + 4) {
            termConstraints.push({
                kind: "creditSlack",
                detail: `Slack ${slack} cr constrained placement to term ${p.term}.`,
            });
        }
        if (prereqResult.decisionsApplied.length > 0) {
            termConstraints.push({
                kind: "prereqChain",
                detail: `Prereq chain: ${prereqResult.decisionsApplied.join(", ")}`,
            });
        }
        // coreqSameTerm (P2.5 — restores the P2.2c-deferred label): if this course
        // has UNMET coreqs (not already taken/IP) that ARE co-placed in THIS term,
        // record the same-term constraint (Decision #14) so the agent can explain
        // why the coreq pair must share the term.
        const coPlacedCoreqs = (input.coreqs?.get(p.courseId) ?? []).filter(coreqId => {
            if (input.coursesTaken.has(coreqId)) return false;
            if (input.coursesInProgress.has(coreqId)) return false;
            return plannedPlacements.get(coreqId) === p.term;
        });
        if (coPlacedCoreqs.length > 0) {
            termConstraints.push({
                kind: "coreqSameTerm",
                detail: `Coreqs [${coPlacedCoreqs.join(", ")}] must be taken the same term as ${p.courseId} (Decision #14).`,
            });
        }

        const alternativeCourses = candidateCourses.filter(c => c !== p.courseId);

        // flexibility (P2.5): the REAL earliest/latest feasible-term window for the
        // chosen course (offering season + prereq-precedence bounded), against the
        // final plan — lets the agent answer "why not term T".
        const window = feasibleTermWindow(p.courseId, p.term, ctx, plannedPlacements);

        const rationale: SlotRationale = {
            satisfiesRequirements: p.satisfiesRId != null ? [p.satisfiesRId] : [],
            termConstraints,
            // consideredAlternatives (P2.5): each OTHER candidate carries the
            // search's REAL reason it lost — the first hard-constraint violation of
            // the counterfactual swap C→C′ in term T, or (if feasible) the objective
            // comparison. p.satisfiesRId is set for every requirement placement.
            consideredAlternatives: alternativeCourses.map(c => ({
                courseId: c,
                rejectedBecause:
                    p.satisfiesRId != null
                        ? rejectionReasonForAlternative(
                              c,
                              p,
                              p.satisfiesRId,
                              plan,
                              finalScore,
                              ctx,
                              excludedCourseIds,
                          )
                        : "search selected a different candidate to satisfy this requirement",
            })),
            decisionsApplied: [
                ...prereqResult.decisionsApplied,
                ...(prereqResult.requiresPetition ? ["D3-petitionSoftAllow"] : []),
            ].filter((v, i, arr) => arr.indexOf(v) === i),
            ...(prereqResult.requiresPetition
                ? {
                      petitionTrigger: {
                          fromCourse: p.courseId,
                          bulletinText: "Instructor permission required",
                      },
                  }
                : {}),
        };

        const flexibility: SlotFlexibility = {
            earliestPossibleTerm: window.earliestPossibleTerm,
            latestPossibleTerm: window.latestPossibleTerm,
            alternativeCourses,
        };

        const criticalPath =
            p.satisfiesRId != null
                ? isCriticalPath(
                      p.courseId,
                      p.satisfiesRId,
                      candidateCourses,
                      dependentsIndex,
                      input.prereqs,
                  )
                : false;

        const slot: ScheduleSlotSpecificPlanned = {
            kind: "specific_planned",
            courseId: p.courseId,
            title,
            credits,
            satisfiesRules: p.satisfiesRId != null ? [p.satisfiesRId] : [],
            reason: `Required (${category}) placed in ${p.term} via slack-balanced placement.`,
            ...(prereqResult.requiresPetition ? { requiresPetition: true } : {}),
            rationale,
            flexibility,
            downstreamImpact: computeDownstreamImpact(p.courseId, dependentsIndex),
            workloadTier: p.workloadTier,
            workloadWeight: p.workloadWeight,
            bindingState: "bound",
            confidence,
            isCriticalPath: criticalPath,
            ...(prereqResult.requiresPetition ? { approvalAuthority: "instructor" as const } : {}),
        };

        perTermSlots.get(p.term)!.push(slot);
        perTermCredits.set(p.term, (perTermCredits.get(p.term) ?? 0) + credits);
        placedCourseSet.add(p.courseId);
        placementRationale[p.courseId] = slot.reason;
    }

    // -----------------------------------------------------------------------
    // 3. Placeholder slots (mirror solver.ts placeholder pass). A requirement
    //    gets a placeholder iff its rId is NOT covered by a requirement/pin
    //    placement in the plan — i.e. the search could not bind it (empty
    //    candidates, all excluded, catalog gap, or genuinely unplaceable). The
    //    slot lands in the best-slack term, exactly as the greedy solver does.
    // -----------------------------------------------------------------------
    const coveredRIds = new Set<string>();
    for (const p of plan.placed) {
        if (p.satisfiesRId === null) continue;
        if (p.source === "requirement" || p.source === "pin") coveredRIds.add(p.satisfiesRId);
    }
    const placeholderRequirements = input.unmetRequirements.filter(
        req => !coveredRIds.has(req.rId),
    );

    for (const req of placeholderRequirements) {
        // Best-slack term (respects per-term target overrides).
        let bestTerm: string | null = null;
        let bestSlack = -Infinity;
        for (const t of futureTerms) {
            const tTarget = effectiveTermTarget(
                t,
                input.creditTargetPerSemester,
                input.preferences,
                input.f1Floor,
                input.domesticPartTimeFloor,
                input.creditCeiling,
            );
            const slack = tTarget - (perTermCredits.get(t) ?? 0);
            if (slack >= req.credits && slack > bestSlack) {
                bestSlack = slack;
                bestTerm = t;
            }
        }
        if (!bestTerm) bestTerm = futureTerms[0] ?? null;
        if (!bestTerm) continue;

        const isImmediate = bestTerm === futureTerms[0];
        const bindingState: "placeholder-pending" | "placeholder-deferred" = isImmediate
            ? "placeholder-pending"
            : "placeholder-deferred";

        const wtResult = classifyWorkloadTier({
            courseId: `placeholder-${req.rId}`,
            satisfiesRules: [req.rId],
            majorRuleKinds: input.programRules.majorRuleKinds,
            schoolCoreRuleIds: input.programRules.schoolCoreRuleIds,
            generalCategoryRuleIds: input.programRules.generalCategoryRuleIds,
            isOptional: false,
        });

        const phRationale: SlotRationale = {
            satisfiesRequirements: [req.rId],
            termConstraints: [
                { kind: "offering", detail: "No specific course assigned — pending advising" },
            ],
            consideredAlternatives: req.candidateCourses.map(c => ({
                courseId: c,
                rejectedBecause: "not in course catalog or no offering data",
            })),
            decisionsApplied: ["D37-PlaceholderSlot"],
        };

        const phSlot: ScheduleSlotPlaceholder = {
            kind: "placeholder",
            category: req.title,
            credits: req.credits,
            satisfiesRules: [req.rId],
            optional: false,
            reason: `Placeholder for unmet requirement "${req.title}" (${req.category}).`,
            rationale: phRationale,
            flexibility: {
                earliestPossibleTerm: bestTerm,
                latestPossibleTerm: lastTerm,
                alternativeCourses: req.candidateCourses,
            },
            downstreamImpact: { courseIds: [], graduationDelay: 0 },
            workloadTier: wtResult.tier,
            workloadWeight: 0.3,
            bindingState,
            placeholderId: `REQ-${req.rId}`,
            confidence: "historically_partial",
            isCriticalPath: req.candidateCourses.length === 0,
        };

        perTermSlots.get(bestTerm)!.push(phSlot);
        perTermCredits.set(bestTerm, (perTermCredits.get(bestTerm) ?? 0) + req.credits);
    }

    // -----------------------------------------------------------------------
    // 4. Free-elective fill (mirror solver.ts). Top each term up to its
    //    effective target with free-elective placeholders; above the degree
    //    minimum + F-1 floor they are flagged optional (Decision #8).
    //
    //    Optional terms (summer/january, P2.8/PLAN-5) are NOT padded: they carry
    //    only what the search placed there. The per-term ForwardSemester is still
    //    emitted below; it simply isn't filled toward the credit target.
    // -----------------------------------------------------------------------
    const degreeCreditsMet = input.creditsEarned >= input.graduationCreditMinimum;

    for (const term of futureTerms) {
        if (isOptionalTerm(term)) continue; // do not pad summer/january
        const cur = perTermCredits.get(term) ?? 0;
        const target = effectiveTermTarget(
            term,
            input.creditTargetPerSemester,
            input.preferences,
            input.f1Floor,
            input.domesticPartTimeFloor,
            input.creditCeiling,
        );
        let credits = cur;

        while (credits < target) {
            const slotCredits = Math.min(4, target - credits);
            const aboveFloor = credits >= (input.f1Floor ?? input.domesticPartTimeFloor ?? 0);
            const optional = degreeCreditsMet && aboveFloor;

            const freeRationale: SlotRationale = {
                satisfiesRequirements: [],
                termConstraints: [
                    {
                        kind: "creditFloor",
                        detail: optional
                            ? `Above degree minimum + F-1 floor — optional load.`
                            : `Fills term to ${target}-credit target.`,
                    },
                ],
                consideredAlternatives: [],
                decisionsApplied: optional ? ["D8-OptionalElective"] : [],
            };

            const freeSlot: ScheduleSlotPlaceholder = {
                kind: "placeholder",
                category: "Free elective",
                credits: slotCredits,
                satisfiesRules: [],
                optional,
                reason: optional
                    ? "Above degree minimum and credit floor — optional load."
                    : `Brings total to ${target}-credit target.`,
                rationale: freeRationale,
                flexibility: {
                    earliestPossibleTerm: term,
                    latestPossibleTerm: lastTerm,
                    alternativeCourses: [],
                },
                downstreamImpact: { courseIds: [], graduationDelay: 0 },
                workloadTier: "free-elective" as WorkloadTier,
                workloadWeight: 0.3,
                bindingState: "placeholder-deferred",
                placeholderId: `FREE-${term}-${credits}`,
                confidence: "historically_partial",
                isCriticalPath: false,
                ...(optional ? { optionalReason: { droppable: true } } : {}),
            };

            perTermSlots.get(term)!.push(freeSlot);
            credits += slotCredits;
        }
        perTermCredits.set(term, credits);
    }

    // -----------------------------------------------------------------------
    // 5. Per-term assembly + visa invariants (mirror solver.ts Stage 6d).
    // -----------------------------------------------------------------------
    const semesters: ForwardSemester[] = futureTerms.map(term => {
        const slots = perTermSlots.get(term) ?? [];
        const termCredits = slots.reduce((s, x) => s + x.credits, 0);
        const notes: string[] = [];

        const visaNotes = visaNotesForCredits({
            credits: termCredits,
            visa: input.visaStatus,
            f1Floor: input.f1Floor,
            domesticPartTimeFloor: input.domesticPartTimeFloor,
        });
        notes.push(...visaNotes);

        const isLastTerm = term === lastTerm;
        const vResult = visaValidator({
            termCredits,
            term,
            profile: {
                visaStatus: input.visaStatus as "f1" | "domestic" | "other" | undefined,
                isFinalTerm: isLastTerm,
            },
            f1Floor: input.f1Floor,
            domesticPartTimeFloor: input.domesticPartTimeFloor,
            f1OnlineCreditsPerTermCap: null,
        });

        // Optional terms (summer/january, P2.8/PLAN-5) are exempt from the F-1 /
        // part-time floor — mirror checkPerTermFloor's exemption so materialize does
        // not flag a lightly-loaded summer/January term below the floor.
        const termIsOptional = isOptionalTerm(term);
        if (!termIsOptional && vResult.fullTimeSatisfied.status === "fail") {
            violations.push({
                kind: "credit_floor",
                term,
                detail: `Below F-1 full-time floor (${termCredits} credits). ${vResult.fullTimeSatisfied.reason}`,
            });
        }
        if (!termIsOptional && vResult.creditMinimumSatisfied.status === "fail") {
            violations.push({
                kind: "credit_floor",
                term,
                detail: `Below minimum enrollment floor (${termCredits} credits). ${vResult.creditMinimumSatisfied.reason}`,
            });
        }

        if (termCredits > input.creditCeiling) {
            notes.push(`Above credit ceiling of ${input.creditCeiling} — overload approval needed.`);
            violations.push({
                kind: "credit_ceiling",
                term,
                detail: `Above ceiling (${termCredits} > ${input.creditCeiling}).`,
            });
        }

        const loadRationale = buildLoadRationale(slots, input.creditTargetPerSemester, termCredits);

        return {
            term,
            locked: false,
            slots,
            plannedCredits: termCredits,
            notes,
            loadRationale,
        };
    });

    // -----------------------------------------------------------------------
    // 6. Stage-8 global constraint checks (mirror solver.ts Stage 8).
    // -----------------------------------------------------------------------
    const totalScheduled =
        input.creditsEarned + semesters.reduce((s, sem) => s + sem.plannedCredits, 0);
    if (totalScheduled < input.graduationCreditMinimum) {
        violations.push({
            kind: "graduation_total",
            detail: `Projected total ${totalScheduled} < graduation minimum ${input.graduationCreditMinimum}.`,
        });
    }

    if (input.passFailUsed >= input.passFailCap) {
        violations.push({
            kind: "pass_fail_cap",
            detail: `Student has used ${input.passFailUsed} of ${input.passFailCap} P/F units. Any future placement must be letter-graded.`,
        });
    }

    if (input.onlineCreditCap != null && input.onlineCreditsUsed > input.onlineCreditCap) {
        violations.push({
            kind: "online_credit_cap",
            detail: `Student has used ${input.onlineCreditsUsed} online credits, exceeding the ${input.onlineCreditCap}-credit cap. Future online courses will not count.`,
        });
    }

    if (
        input.outsideHomeCreditCap != null &&
        input.outsideHomeCreditsUsed > input.outsideHomeCreditCap
    ) {
        violations.push({
            kind: "outside_home_credit_cap",
            detail: `Student has used ${input.outsideHomeCreditsUsed} credits outside ${input.homeSchoolId}, exceeding the ${input.outsideHomeCreditCap}-credit cap.`,
        });
    }

    if (input.cumulativeGpa < input.graduationGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Cumulative GPA ${input.cumulativeGpa} is below the ${input.graduationGpaFloor} graduation floor. The plan does not address this.`,
        });
    }
    if (input.majorGpaFloor != null && input.majorGpa != null && input.majorGpa < input.majorGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Major GPA ${input.majorGpa} is below the ${input.majorGpaFloor} major-completion floor.`,
        });
    }

    // -----------------------------------------------------------------------
    // 7. Post-pass: assumptions, balanceScore, feasibility, state (mirror
    //    solver.ts). alternativeCandidates is intentionally left undefined —
    //    the real top-K is a later task (do NOT call buildAlternativeCandidates).
    // -----------------------------------------------------------------------
    const assumptions = buildIpAssumptions(input, placedCourseSet, dependentsIndex);

    const balanceScore = computeBalanceScore(semesters, "balanced");

    const feasibility: FeasibilityReport = {
        feasible: violations.length === 0,
        ...(violations.length > 0
            ? { infeasibilityReason: `${violations.length} constraint violation(s).` }
            : {}),
        constraintViolations: violations,
        placementRationale,
    };

    const state = derivePlanState(semesters, feasibility, assumptions);

    return {
        semesters,
        feasibility,
        balanceScore,
        assumptions,
        state,
    };
}

// ---------------------------------------------------------------------------
// Alternative-plan summaries (P2.3)
// ---------------------------------------------------------------------------

/** Department prefix of a courseId — everything before the LAST space-separated
 *  numeric token (e.g. "CSCI-UA 101" → "CSCI-UA", "MATH-UA 9 101" → "MATH-UA 9").
 *  When the final token is not a bare number (or there is no space), the whole id
 *  is returned unchanged. */
function subjectPrefix(courseId: string): string {
    const idx = courseId.lastIndexOf(" ");
    if (idx < 0) return courseId;
    const tail = courseId.slice(idx + 1);
    // Bare integer (course number) → strip it; otherwise keep the id whole.
    return /^\d+$/.test(tail) ? courseId.slice(0, idx) : courseId;
}

/**
 * Summarise each already-materialised alternative SolverOutput into an
 * AlternativePlanSummary, computed purely from its `semesters` + `assumptions`
 * relative to the `winner` plan.
 *
 * Per alternative:
 *   - balanceScore / weighted-credits / hard / easy counts come straight from the
 *     materialised per-term loadRationale (so they MATCH the rendered semesters).
 *   - subjectDistributionByTerm sums credits by department prefix over the bound
 *     specific_planned + in_progress slots (the courses a student actually takes).
 *   - distinctSubjectsCount is the number of distinct prefixes across the plan.
 *   - totalPetitionCount counts specific_planned slots flagged requiresPetition.
 *   - totalAssumptionCount = alt.assumptions.length.
 *   - graduationTerm = the alt's last semester term (matches the old summary).
 *   - topDiffsFromWinner: balanceScore always, graduationTerm when it differs (≤3).
 *   - planIndex is 1-based among the returned (balance-sorted) alternatives.
 *
 * Returns [] when `alternatives` is empty. The returned array is sorted ascending
 * by balanceScore (stable), and planIndex is assigned AFTER that sort.
 */
export function buildAlternativeSummaries(
    winner: SolverOutput,
    alternatives: SolverOutput[],
): AlternativePlanSummary[] {
    if (alternatives.length === 0) return [];

    const winnerBalance = winner.balanceScore;
    const winnerGradTerm = lastTermOf(winner);

    // Build each summary WITHOUT planIndex (assigned after the balance-sort below).
    const summaries = alternatives.map((alt): Omit<AlternativePlanSummary, "planIndex"> => {
        const weightedCreditsByTerm: Record<string, number> = {};
        const hardCountByTerm: Record<string, number> = {};
        const easyCountByTerm: Record<string, number> = {};
        const subjectDistributionByTerm: Record<string, Record<string, number>> = {};
        const distinctSubjects = new Set<string>();
        let totalPetitionCount = 0;

        for (const sem of alt.semesters) {
            weightedCreditsByTerm[sem.term] = sem.loadRationale.weightedCredits;
            hardCountByTerm[sem.term] = sem.loadRationale.hardCount;
            easyCountByTerm[sem.term] = sem.loadRationale.easyCount;

            const bySubject: Record<string, number> = {};
            for (const slot of sem.slots) {
                if (slot.kind !== "specific_planned" && slot.kind !== "in_progress") continue;
                const subject = subjectPrefix(slot.courseId);
                bySubject[subject] = (bySubject[subject] ?? 0) + slot.credits;
                distinctSubjects.add(subject);
                if (slot.kind === "specific_planned" && slot.requiresPetition === true) {
                    totalPetitionCount++;
                }
            }
            subjectDistributionByTerm[sem.term] = bySubject;
        }

        const graduationTerm = lastTermOf(alt);

        const topDiffsFromWinner: Array<{ aspect: string; change: string }> = [
            {
                aspect: "balanceScore",
                change: `${alt.balanceScore} vs winner ${winnerBalance} (${
                    alt.balanceScore < winnerBalance
                        ? "more balanced"
                        : alt.balanceScore > winnerBalance
                          ? "less balanced"
                          : "equally balanced"
                })`,
            },
        ];
        if (graduationTerm !== winnerGradTerm && topDiffsFromWinner.length < 3) {
            topDiffsFromWinner.push({
                aspect: "graduationTerm",
                change: `${graduationTerm} vs ${winnerGradTerm}`,
            });
        }

        return {
            balanceScore: alt.balanceScore,
            weightedCreditsByTerm,
            hardCountByTerm,
            easyCountByTerm,
            subjectDistributionByTerm,
            distinctSubjectsCount: distinctSubjects.size,
            totalPetitionCount,
            totalAssumptionCount: alt.assumptions.length,
            graduationTerm,
            topDiffsFromWinner,
        };
    });

    // Stable ascending sort by balanceScore (preserve input order on ties).
    const ordered = summaries
        .map((s, i) => ({ s, i }))
        .sort((a, b) => (a.s.balanceScore !== b.s.balanceScore ? a.s.balanceScore - b.s.balanceScore : a.i - b.i))
        .map(x => x.s);

    return ordered.map((s, i) => ({ planIndex: i + 1, ...s }));
}

/** The last semester's term in a materialised plan ("" when there are none) —
 *  the graduation/completion term the old summary reported. */
function lastTermOf(out: SolverOutput): string {
    return out.semesters.length > 0 ? out.semesters[out.semesters.length - 1]!.term : "";
}
