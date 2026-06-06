/**
 * T3b — findDiverseValidPlans tests.
 *
 * Verifies that findDiverseValidPlans returns up to k distinct, valid search
 * leaves by re-running findFirstValidPlan while forbidding each prior winner's
 * requirement-assignment signature — a cheap O(k × first-plan-cost) strategy
 * that does NOT exhaust the whole search space.
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    checkOfferingSeasonMatch,
    checkPrereqsSatisfied,
    checkNotClauseClear,
    checkCoreqsSameTerm,
    checkPerTermCeiling,
    checkRequirementCoverage,
    checkMajorCreditFloor,
    checkResidencyFloor,
    type PartialPlan,
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { findDiverseValidPlans, findFirstValidPlan } from "../../src/agent/forwardSchedule/search.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (verbatim from search.test.ts)
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
        visaStatus: "f1",
        coursesTaken: new Set(),
        coursesInProgress: new Map(),
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
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
        warnings: [],
        ...overrides,
    };
}

/** Convenience: build a single placed course with sensible defaults. */
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
// Helpers (mirror the test helpers in the task spec)
// ---------------------------------------------------------------------------

/** Check all 8 search-leaf predicates. */
function isValidLeaf(
    plan: PartialPlan,
    ctx: ReturnType<typeof buildConstraintContext>,
): boolean {
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

/** Requirement-assignment signature: sorted `rId=courseId@term` entries for bound placements. */
function reqSig(plan: PartialPlan): string {
    return plan.placed
        .filter(p => p.satisfiesRId !== null)
        .map(p => `${p.satisfiesRId}=${p.courseId}@${p.term}`)
        .sort()
        .join(",");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findDiverseValidPlans — cheap distinct valid plans", () => {
    it("returns up to k distinct valid plans, each a valid search leaf", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 18,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "One",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: ["A-UA 1", "B-UA 2"],
                },
                {
                    rId: "r2",
                    title: "Two",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: ["C-UA 3", "D-UA 4"],
                },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }],
                ["B-UA 2", { title: "B", credits: 4 }],
                ["C-UA 3", { title: "C", credits: 4 }],
                ["D-UA 4", { title: "D", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]],
                ["B-UA 2", ["fall", "spring"]],
                ["C-UA 3", ["fall", "spring"]],
                ["D-UA 4", ["fall", "spring"]],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const plans = findDiverseValidPlans(ctx, { k: 4 });
        expect(plans.length).toBeGreaterThan(1);
        expect(plans.length).toBeLessThanOrEqual(4);
        for (const p of plans) expect(isValidLeaf(p, ctx)).toBe(true);
        const sigs = plans.map(reqSig);
        expect(new Set(sigs).size).toBe(sigs.length); // pairwise distinct
    });

    it("plans[0] equals findFirstValidPlan's plan (no forbidden signatures on the first)", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "One",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: ["A-UA 1", "B-UA 2"],
                },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }],
                ["B-UA 2", { title: "B", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]],
                ["B-UA 2", ["fall", "spring"]],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const plans = findDiverseValidPlans(ctx, { k: 4 });
        const first = findFirstValidPlan(ctx).plan!;
        expect(plans[0]!.placed).toEqual(first.placed);
    });

    it("single-solution input returns exactly one plan", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Only",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["ONE-UA 1"],
                },
            ],
            courseCatalog: new Map([["ONE-UA 1", { title: "Only", credits: 4 }]]),
            offerings: new Map([["ONE-UA 1", ["fall"]]]),
        });
        const ctx = buildConstraintContext(input);
        expect(findDiverseValidPlans(ctx, { k: 4 })).toHaveLength(1);
    });

    it("is deterministic (two calls return identical plans)", () => {
        const make = () =>
            buildConstraintContext(
                makeInput({
                    currentTerm: "2026-fall",
                    graduationTerm: "2027-spring",
                    creditCeiling: 18,
                    unmetRequirements: [
                        {
                            rId: "r1",
                            title: "One",
                            category: "major_elective",
                            credits: 4,
                            candidateCourses: ["A-UA 1", "B-UA 2"],
                        },
                        {
                            rId: "r2",
                            title: "Two",
                            category: "major_elective",
                            credits: 4,
                            candidateCourses: ["C-UA 3", "D-UA 4"],
                        },
                    ],
                    courseCatalog: new Map([
                        ["A-UA 1", { title: "A", credits: 4 }],
                        ["B-UA 2", { title: "B", credits: 4 }],
                        ["C-UA 3", { title: "C", credits: 4 }],
                        ["D-UA 4", { title: "D", credits: 4 }],
                    ]),
                    offerings: new Map([
                        ["A-UA 1", ["fall", "spring"]],
                        ["B-UA 2", ["fall", "spring"]],
                        ["C-UA 3", ["fall", "spring"]],
                        ["D-UA 4", ["fall", "spring"]],
                    ]),
                }),
            );
        const a = findDiverseValidPlans(make(), { k: 4 });
        const b = findDiverseValidPlans(make(), { k: 4 });
        expect(a.map(p => p.placed)).toEqual(b.map(p => p.placed));
    });
});
