/**
 * Phase 2 P2.4 — Objective fixtures: workload-balance drives placement.
 *
 * Proves that the balance soft objective is a PLACEMENT-DRIVING force, not just
 * a reported metric:
 *
 *   1. Balance evens heavy-course distribution (headline) — the balance-on
 *      search spreads two heavy (major-required, workloadWeight≥1) requirements
 *      into DIFFERENT terms, while the balance-off baseline (score=0 everywhere
 *      → planKey tie-break) lumps them in the SAME earliest term. The hardCount
 *      variance contrast is the measurable proof.
 *
 *   2. loadStyle shifts the credit centroid — with the SAME fixture, setting
 *      preferences.loadStyle:"frontload" vs "backload" causes searchBestPlan
 *      (with {balance:1, timeToDegree:0}) to pick plans with measurably
 *      different credit centroids: frontload centroid < backload centroid.
 *      loadStyle is read from ctx.input.preferences, not from weights.
 *
 *   3. Balance is on by default end-to-end — solveForwardSchedule (which uses
 *      DEFAULT_OBJECTIVE_WEIGHTS = {balance:1, timeToDegree:0.5}) on the headline
 *      fixture distributes the two heavy courses into different terms, confirming
 *      the default path activates the balance objective.
 *
 * makeInput / placed are copied from search.test.ts (identical to
 * constraintModel.test.ts originals).
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    scorePlan,
    type PartialPlan,
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal helpers (pattern from search.test.ts)
// ---------------------------------------------------------------------------

function makeMinimalDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 100,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 4,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
        ...overrides,
    };
}

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: "domestic", // avoid F-1 floor complications in end-to-end test
        coursesTaken: new Set(),
        coursesInProgress: new Map(),
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: null, // no floor for domestic in tests
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 100,
        passFailCap: 32,
        passFailUsed: 4,
        onlineCreditCap: 16,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap: 16,
        outsideHomeCreditsUsed: 0,
        cumulativeGpa: 3.4,
        majorGpa: 3.3,
        graduationGpaFloor: 2.0,
        majorGpaFloor: 2.0,
        unmetRequirements: [],
        prereqs: new Map(),
        offerings: new Map(),
        offeringConfidence: new Map(),
        courseCatalog: new Map(),
        dprCourseHistoryHash: "test-hash",
        dpr: makeMinimalDpr(),
        programRules: {
            majorRuleKinds: new Map(),
            schoolCoreRuleIds: new Set(),
            generalCategoryRuleIds: new Set(),
            residencyMinCredits: null,
            majorCreditMinimum: null,
            upperLevelMinCredits: null,
        },
        ...overrides,
    };
}

/** Convenience: build a placed course with sensible defaults. */
function placed(p: Partial<PlacedCourse> & { courseId: string; term: string }): PlacedCourse {
    return {
        credits: 4,
        workloadTier: "free-elective",
        workloadWeight: 0.5,
        satisfiesRId: null,
        source: "free",
        ...p,
    };
}

// ---------------------------------------------------------------------------
// Shared helpers for variance and centroid
// ---------------------------------------------------------------------------

/** Population variance: mean(x²) − mean(x)². */
function populationVariance(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((s, x) => s + x, 0) / values.length;
    const mean2 = values.reduce((s, x) => s + x * x, 0) / values.length;
    return mean2 - mean * mean;
}

/** Credit-weighted mean term index (centroid) of a placed-course list.
 *  termOrder maps term string → 0-based index. Returns 0 when totalCredits = 0. */
function creditCentroid(placed: PlacedCourse[], termOrder: string[]): number {
    const totalCredits = placed.reduce((s, p) => s + p.credits, 0);
    if (totalCredits === 0) return 0;
    return (
        placed.reduce((s, p) => {
            const idx = termOrder.indexOf(p.term);
            return s + p.credits * (idx >= 0 ? idx : 0);
        }, 0) / totalCredits
    );
}

/** Per-term hardCount array (parallel to termOrder). */
function hardCountsForTerms(placed: PlacedCourse[], termOrder: string[]): number[] {
    return termOrder.map(term =>
        placed.filter(p => p.term === term && p.workloadWeight >= 1.0).length,
    );
}

// ===========================================================================
// Fixture — two HEAVY requirements each offered in both future terms
//
// Two unmet requirements (r1, r2), each with a single major-required candidate.
// major-required ⇒ workloadWeight = base(1.0) + modifiers = 1.0 (no modifiers
// on plain "HEAVY-UA N" course IDs). Both offered in fall AND spring (the only
// two future terms in the 2026-fall → 2027-spring window). No prereq linking
// them → each can freely land in either term.
//
// Variable ordering (search.ts §2): depth=0, candidates.length=1, weight=1.0,
// rId ASC → r1 first, r2 second.
//
// With weights {balance:0, timeToDegree:0}: every scorePlan trial = 0. Value
// ordering within each variable falls back to chronological term ASC, then
// courseId ASC → both variables pick 2026-fall (earliest term). Result:
//   placed=[HEAVY-UA 1@2026-fall, HEAVY-UA 2@2026-fall],
//   hardCount per term=[2, 0], var(hardCount) = 1.  ← BASELINE LUMP
//
// With weights {balance:1, timeToDegree:0}: scorePlan discriminates. After
// placing r1 in 2026-fall, the search evaluates r2@2026-fall vs r2@2027-spring:
//   r2@2026-fall  → hardCount=[2,0], var=1 → balance penalises heavily.
//   r2@2027-spring → hardCount=[1,1], var=0 → lower score.
// Balance drives r2 to 2027-spring → one heavy per term → var(hardCount) = 0.
// ===========================================================================

const HEADLINE_TERMS = ["2026-fall", "2027-spring"];

const headlineInput = makeInput({
    currentTerm: "2026-fall",
    graduationTerm: "2027-spring",
    creditCeiling: 18,
    unmetRequirements: [
        {
            rId: "r1",
            title: "Heavy Requirement One",
            category: "major_required",
            credits: 4,
            candidateCourses: ["HEAVY-UA 1"],
        },
        {
            rId: "r2",
            title: "Heavy Requirement Two",
            category: "major_required",
            credits: 4,
            candidateCourses: ["HEAVY-UA 2"],
        },
    ],
    courseCatalog: new Map([
        ["HEAVY-UA 1", { title: "Heavy Course One", credits: 4 }],
        ["HEAVY-UA 2", { title: "Heavy Course Two", credits: 4 }],
    ]),
    offerings: new Map([
        ["HEAVY-UA 1", ["fall", "spring"]],
        ["HEAVY-UA 2", ["fall", "spring"]],
    ]),
    // Make r1 and r2 both major-required (must_take) so workloadWeight = 1.0.
    programRules: {
        majorRuleKinds: new Map([
            ["r1", "must_take"],
            ["r2", "must_take"],
        ]),
        schoolCoreRuleIds: new Set(),
        generalCategoryRuleIds: new Set(),
        residencyMinCredits: null,
        majorCreditMinimum: null,
        upperLevelMinCredits: null,
    },
});

// ===========================================================================
// 1. Balance evens heavy courses (headline)
// ===========================================================================

describe("balance objective — headline: heavy-course distribution", () => {
    it("baseline (balance=0): planKey tie-break lumps both heavy courses in the same (earliest) term", () => {
        // With all scores = 0, value-ordering falls back to (term chronological,
        // courseId ASC) → both requirements land in 2026-fall (earliest term).
        const ctx = buildConstraintContext(headlineInput);
        const result = searchBestPlan(ctx, { weights: { balance: 0, timeToDegree: 0 } });

        expect(result.plan).not.toBeNull();
        const plan = result.plan!;

        const hc = hardCountsForTerms(plan.placed, HEADLINE_TERMS);
        // Both heavy courses in the same term → one term has hardCount=2, the other=0.
        expect(populationVariance(hc)).toBeGreaterThan(0);

        // Specifically: both must be in 2026-fall (the chronologically earliest term
        // that passes the score tie-break).
        const r1Term = plan.placed.find(p => p.satisfiesRId === "r1")?.term;
        const r2Term = plan.placed.find(p => p.satisfiesRId === "r2")?.term;
        expect(r1Term).toBe("2026-fall");
        expect(r2Term).toBe("2026-fall");
    });

    it("balance-on (balance=1, timeToDegree=0): heavy courses land in DIFFERENT terms", () => {
        // With balance=1, the search penalises hardCount variance. After placing r1
        // in any term, placing r2 in the SAME term gives hardCount=[2,0], var=1 (cost 2).
        // Placing r2 in the OTHER term gives hardCount=[1,1], var=0 (cost 0).
        // Balance drives r2 away from r1's term → different terms → var(hardCount) = 0.
        const ctx = buildConstraintContext(headlineInput);
        const result = searchBestPlan(ctx, { weights: { balance: 1, timeToDegree: 0 } });

        expect(result.plan).not.toBeNull();
        const plan = result.plan!;

        const hc = hardCountsForTerms(plan.placed, HEADLINE_TERMS);
        // Different terms → each term has hardCount=1 → var = 0.
        expect(populationVariance(hc)).toBe(0);

        const r1Term = plan.placed.find(p => p.satisfiesRId === "r1")?.term;
        const r2Term = plan.placed.find(p => p.satisfiesRId === "r2")?.term;
        expect(r1Term).not.toBeUndefined();
        expect(r2Term).not.toBeUndefined();
        expect(r1Term).not.toBe(r2Term); // the measurable proof: different terms
    });

    it("balance-on var(hardCount) is strictly less than baseline var(hardCount)", () => {
        // Quantitative contrast: balance=1 plan's hardCount variance < balance=0 plan's.
        const ctx = buildConstraintContext(headlineInput);

        const baseline = searchBestPlan(ctx, { weights: { balance: 0, timeToDegree: 0 } });
        const balanced = searchBestPlan(ctx, { weights: { balance: 1, timeToDegree: 0 } });

        expect(baseline.plan).not.toBeNull();
        expect(balanced.plan).not.toBeNull();

        const baselineVar = populationVariance(hardCountsForTerms(baseline.plan!.placed, HEADLINE_TERMS));
        const balancedVar = populationVariance(hardCountsForTerms(balanced.plan!.placed, HEADLINE_TERMS));

        // Baseline lumps (var > 0); balance-on spreads (var = 0). Strict contrast.
        expect(balancedVar).toBeLessThan(baselineVar);
    });

    it("scorePlan score of the balance-on plan (balance=1) is strictly lower than the baseline plan's score under the same weights", () => {
        // Cross-validates that the score function itself agrees: the balanced plan
        // is cheaper under balance weights, confirming the search found the true optimum.
        const ctx = buildConstraintContext(headlineInput);
        const w = { balance: 1, timeToDegree: 0 };

        const baseline = searchBestPlan(ctx, { weights: { balance: 0, timeToDegree: 0 } });
        const balanced = searchBestPlan(ctx, { weights: w });

        expect(baseline.plan).not.toBeNull();
        expect(balanced.plan).not.toBeNull();

        const baselineScoreUnderBalance = scorePlan(baseline.plan!, ctx, w);
        const balancedScoreUnderBalance = scorePlan(balanced.plan!, ctx, w);

        expect(balancedScoreUnderBalance).toBeLessThan(baselineScoreUnderBalance);
    });
});

// ===========================================================================
// 2. loadStyle shifts the credit centroid
//
// Fixture: 3 future terms (2026-fall, 2027-spring, 2027-fall), two requirements:
//   r1 — 8-credit major-required course (workloadWeight=1.0, placed first by
//        the search's weight-DESC ordering)
//   r2 — 4-credit free-elective course (workloadWeight=0.5)
//
// Both candidates offered in both fall and spring seasons (covering all 3 terms
// in the window).
//
// With {balance:1, timeToDegree:0}, the credit-variance component pushes the two
// courses into DIFFERENT terms. Among the different-term configurations, the
// loadStyleDeviation (lsd) component breaks ties:
//   - frontload: penalises centroid > medianTermIdx=1. The search picks the
//     configuration where the heavy 8cr course lands in an EARLIER term
//     → centroid < medianIdx.
//   - backload: penalises centroid < medianTermIdx=1. The search picks the
//     configuration where the heavy 8cr course lands in a LATER term
//     → centroid > medianIdx.
//
// Proven contrast: frontload centroid < backload centroid.
// ===========================================================================

const LOAD_TERMS = ["2026-fall", "2027-spring", "2027-fall"];

function makeLoadStyleInput(loadStyle: "frontload" | "backload"): SolverInput {
    return makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-fall",
        creditCeiling: 18,
        unmetRequirements: [
            {
                rId: "rBig",
                title: "Big Course",
                category: "major_required",
                credits: 8,
                candidateCourses: ["BIG-UA 1"],
            },
            {
                rId: "rSmall",
                title: "Small Course",
                category: "free_elective",
                credits: 4,
                candidateCourses: ["SM-UA 2"],
            },
        ],
        courseCatalog: new Map([
            ["BIG-UA 1", { title: "Big Course", credits: 8 }],
            ["SM-UA 2", { title: "Small Course", credits: 4 }],
        ]),
        offerings: new Map([
            // Both available in fall AND spring → all 3 main terms in the window.
            ["BIG-UA 1", ["fall", "spring"]],
            ["SM-UA 2", ["fall", "spring"]],
        ]),
        // rBig is major-required (must_take) → workloadWeight=1.0.
        // rSmall is free-elective (not in majorRuleKinds) → workloadWeight=0.5.
        programRules: {
            majorRuleKinds: new Map([["rBig", "must_take"]]),
            schoolCoreRuleIds: new Set(),
            generalCategoryRuleIds: new Set(),
            residencyMinCredits: null,
            majorCreditMinimum: null,
            upperLevelMinCredits: null,
        },
        preferences: { loadStyle },
    });
}

describe("balance objective — loadStyle shifts credit centroid", () => {
    it("frontload centroid < backload centroid (same fixture, only loadStyle differs)", () => {
        // The loadStyle preference is embedded in the input and read by scorePlan
        // via ctx.input.preferences?.loadStyle. Running searchBestPlan with
        // {balance:1, timeToDegree:0} exercises the full lsd channel.
        const w = { balance: 1, timeToDegree: 0 } as const;

        const frontCtx = buildConstraintContext(makeLoadStyleInput("frontload"));
        const backCtx = buildConstraintContext(makeLoadStyleInput("backload"));

        const frontResult = searchBestPlan(frontCtx, { weights: w });
        const backResult = searchBestPlan(backCtx, { weights: w });

        expect(frontResult.plan).not.toBeNull();
        expect(backResult.plan).not.toBeNull();

        const frontCentroid = creditCentroid(frontResult.plan!.placed, LOAD_TERMS);
        const backCentroid = creditCentroid(backResult.plan!.placed, LOAD_TERMS);

        // The measurable proof: frontload drives credits earlier, backload drives
        // them later. The centroid delta must be strictly positive.
        expect(frontCentroid).toBeLessThan(backCentroid);
    });

    it("frontload plan's centroid is ≤ medianTermIdx (credits lean early or neutral)", () => {
        const w = { balance: 1, timeToDegree: 0 } as const;
        const frontCtx = buildConstraintContext(makeLoadStyleInput("frontload"));
        const result = searchBestPlan(frontCtx, { weights: w });

        expect(result.plan).not.toBeNull();

        const centroid = creditCentroid(result.plan!.placed, LOAD_TERMS);
        const medianTermIdx = (LOAD_TERMS.length - 1) / 2; // = 1

        // lsd for frontload = max(0, centroid − medianTermIdx). If centroid ≤ 1,
        // lsd=0 and no frontload penalty was incurred — the plan leans early.
        expect(centroid).toBeLessThanOrEqual(medianTermIdx);
    });

    it("backload plan's centroid is ≥ medianTermIdx (credits lean late or neutral)", () => {
        const w = { balance: 1, timeToDegree: 0 } as const;
        const backCtx = buildConstraintContext(makeLoadStyleInput("backload"));
        const result = searchBestPlan(backCtx, { weights: w });

        expect(result.plan).not.toBeNull();

        const centroid = creditCentroid(result.plan!.placed, LOAD_TERMS);
        const medianTermIdx = (LOAD_TERMS.length - 1) / 2; // = 1

        // lsd for backload = max(0, medianTermIdx − centroid). If centroid ≥ 1,
        // lsd=0 — the plan leans late.
        expect(centroid).toBeGreaterThanOrEqual(medianTermIdx);
    });
});

// ===========================================================================
// 3. Balance is on by default end-to-end
//
// solveForwardSchedule calls searchTopKPlans(ctx, {fixed, k:5}) with NO
// explicit weights → DEFAULT_OBJECTIVE_WEIGHTS = {balance:1, timeToDegree:0.5}.
// The balance component (weight=1) is active. Running solveForwardSchedule on
// the headline fixture (two heavy-required courses each offered in both terms,
// no prereqs) must distribute the heavy courses into DIFFERENT terms — proving
// that the default path drives balance, not just an explicit {balance:1} call.
// ===========================================================================

describe("balance objective — default weights (solveForwardSchedule end-to-end)", () => {
    it("solveForwardSchedule places the two heavy requirements in different terms by default", () => {
        const out = solveForwardSchedule(headlineInput);

        // The solver must produce a feasible plan (the fixture is trivially feasible).
        expect(out.feasibility.feasible).toBe(true);

        // Extract the two specific_planned slots bound to r1 and r2.
        const r1Slot = out.semesters
            .flatMap(sem => sem.slots.map(slot => ({ slot, term: sem.term })))
            .find(({ slot }) => slot.kind === "specific_planned" && slot.satisfiesRules.includes("r1"));
        const r2Slot = out.semesters
            .flatMap(sem => sem.slots.map(slot => ({ slot, term: sem.term })))
            .find(({ slot }) => slot.kind === "specific_planned" && slot.satisfiesRules.includes("r2"));

        expect(r1Slot).not.toBeUndefined();
        expect(r2Slot).not.toBeUndefined();

        // Different terms → balance objective separated the two heavy courses.
        expect(r1Slot!.term).not.toBe(r2Slot!.term);
    });

    it("solveForwardSchedule: per-term hardCount is ≤ 1 for all terms (one heavy per term)", () => {
        const out = solveForwardSchedule(headlineInput);
        expect(out.feasibility.feasible).toBe(true);

        // Every semester produced by the solver has loadRationale.hardCount ≤ 1,
        // confirming the two heavy courses were spread evenly.
        for (const sem of out.semesters) {
            expect(sem.loadRationale.hardCount).toBeLessThanOrEqual(1);
        }
    });

    it("the default-weights plan has a lower scorePlan (balance=1) than the baseline plan", () => {
        // Extra confirmation: the plan solveForwardSchedule returns is provably
        // better under the balance objective than the lumped-in-one-term baseline.
        const headlineCtx = buildConstraintContext(headlineInput);

        // Re-derive the PartialPlan the default path chose.
        const out = solveForwardSchedule(headlineInput);
        expect(out.feasibility.feasible).toBe(true);

        const defaultPlan: PartialPlan = {
            placed: out.semesters.flatMap(sem =>
                sem.slots
                    .filter(s => s.kind === "specific_planned")
                    .map(s => ({
                        courseId: s.courseId!,
                        term: sem.term,
                        credits: s.credits,
                        workloadTier: (s as { workloadTier?: string }).workloadTier ?? "free-elective",
                        workloadWeight: (s as { workloadWeight?: number }).workloadWeight ?? 0.5,
                        satisfiesRId: (s as { satisfiesRules?: string[] }).satisfiesRules?.[0] ?? null,
                        source: "requirement" as const,
                    })),
            ),
        };

        const baselinePlan = searchBestPlan(headlineCtx, {
            weights: { balance: 0, timeToDegree: 0 },
        });
        expect(baselinePlan.plan).not.toBeNull();

        const balanceW = { balance: 1, timeToDegree: 0 };
        const defaultScore = scorePlan(defaultPlan, headlineCtx, balanceW);
        const baselineScore = scorePlan(baselinePlan.plan!, headlineCtx, balanceW);

        expect(defaultScore).toBeLessThan(baselineScore);
    });
});
