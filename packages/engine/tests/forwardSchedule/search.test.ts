/**
 * Phase 2 P2.2a — backtracking + forward-check + branch-and-bound search tests
 * (TDD-first). The search assigns each unmet requirement a (course, term) so
 * that all per-placement hard constraints hold and requirement coverage +
 * major/residency floors hold, minimising scorePlan among valid assignments.
 *
 * It places ONLY requirement-satisfying courses (source "requirement") plus
 * caller-supplied fixed placements. It does NOT do free-elective fill — that is
 * a later task — so the fill-dependent axes (per-term floor, total-credit
 * minimum, graduation target) and the placement-independent gpaFloors are NOT
 * enforced here.
 *
 * makeInput / placed are copied (minimal) from constraintModel.test.ts.
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
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import { compareSolverTerms } from "../../src/agent/forwardSchedule/solverHelpers.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { PrereqGroup } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (copied from constraintModel.test.ts)
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

// ===========================================================================
// 1. Single forced solution
// ===========================================================================

describe("searchBestPlan — single forced solution", () => {
    it("places the only candidate of a single requirement; coverage holds; exhaustive", () => {
        const input = makeInput({
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Required Course",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1"],
                },
            ],
            courseCatalog: new Map([["REQ-UA 1", { title: "Required Course", credits: 4 }]]),
            offerings: new Map([["REQ-UA 1", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);

        const result = searchBestPlan(ctx);
        expect(result.plan).not.toBeNull();
        expect(checkRequirementCoverage(result.plan!, ctx).ok).toBe(true);
        expect(result.exhaustive).toBe(true);
        // The single requirement is placed by a bound requirement source.
        const reqPlacement = result.plan!.placed.find(p => p.satisfiesRId === "r1");
        expect(reqPlacement).toBeDefined();
        expect(reqPlacement!.source).toBe("requirement");
        expect(reqPlacement!.courseId).toBe("REQ-UA 1");
    });
});

// ===========================================================================
// 2. Completeness — the collide case greedy fails
// ===========================================================================

describe("searchBestPlan — completeness (collide case greedy reports infeasible)", () => {
    // R1.candidates = [A, B], R2.candidates = [A, C]; A is the shared first choice.
    // A is fall-only, B & C are spring-only. Ceiling = 6, all courses 4 cr.
    // A naive "first candidate each" (R1→A, R2→A) forces TWO A placements into
    // 2026-fall (4 + 4 = 8 > 6) → ceiling collision, infeasible. But a valid
    // assignment exists: R1→B(spring) + R2→A(fall), or R1→A(fall) + R2→C(spring),
    // each term at 4 credits.
    const input = makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditCeiling: 6,
        unmetRequirements: [
            {
                rId: "r1",
                title: "Requirement One",
                category: "major_elective",
                credits: 4,
                candidateCourses: ["A-UA 1", "B-UA 2"],
            },
            {
                rId: "r2",
                title: "Requirement Two",
                category: "major_elective",
                credits: 4,
                candidateCourses: ["A-UA 1", "C-UA 3"],
            },
        ],
        courseCatalog: new Map([
            ["A-UA 1", { title: "Course A", credits: 4 }],
            ["B-UA 2", { title: "Course B", credits: 4 }],
            ["C-UA 3", { title: "Course C", credits: 4 }],
        ]),
        offerings: new Map([
            ["A-UA 1", ["fall"]],
            ["B-UA 2", ["spring"]],
            ["C-UA 3", ["spring"]],
        ]),
    });

    it("finds a valid assignment where greedy first-candidate-each fails", () => {
        const ctx = buildConstraintContext(input);
        const result = searchBestPlan(ctx);

        expect(result.plan).not.toBeNull();
        expect(checkRequirementCoverage(result.plan!, ctx).ok).toBe(true);

        // Both requirements covered by DISTINCT courses.
        const r1Course = result.plan!.placed.find(p => p.satisfiesRId === "r1")?.courseId;
        const r2Course = result.plan!.placed.find(p => p.satisfiesRId === "r2")?.courseId;
        expect(r1Course).toBeDefined();
        expect(r2Course).toBeDefined();
        expect(r1Course).not.toBe(r2Course);
    });
});

// ===========================================================================
// 3. Prereq ordering
// ===========================================================================

describe("searchBestPlan — prereq ordering", () => {
    // ADV-UA 2 (prereq BASE-UA 1). BASE offered fall, ADV offered spring.
    // The search must place BASE in an earlier term than ADV.
    const prereqs = new Map<string, PrereqGroup[]>([
        ["ADV-UA 2", [{ type: "AND", courses: ["BASE-UA 1"] }]],
    ]);
    const input = makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        prereqs,
        unmetRequirements: [
            {
                rId: "rAdv",
                title: "Advanced",
                category: "major_required",
                credits: 4,
                candidateCourses: ["ADV-UA 2"],
            },
            {
                rId: "rBase",
                title: "Base",
                category: "major_required",
                credits: 4,
                candidateCourses: ["BASE-UA 1"],
            },
        ],
        courseCatalog: new Map([
            ["ADV-UA 2", { title: "Advanced", credits: 4 }],
            ["BASE-UA 1", { title: "Base", credits: 4 }],
        ]),
        offerings: new Map([
            ["BASE-UA 1", ["fall"]],
            ["ADV-UA 2", ["spring"]],
        ]),
    });

    it("places the prereq BASE before the dependent ADV; coverage holds", () => {
        const ctx = buildConstraintContext(input);
        const result = searchBestPlan(ctx);

        expect(result.plan).not.toBeNull();
        expect(checkRequirementCoverage(result.plan!, ctx).ok).toBe(true);
        expect(checkPrereqsSatisfied(result.plan!, ctx).ok).toBe(true);

        const baseTerm = result.plan!.placed.find(p => p.courseId === "BASE-UA 1")!.term;
        const advTerm = result.plan!.placed.find(p => p.courseId === "ADV-UA 2")!.term;
        expect(compareSolverTerms(baseTerm, advTerm)).toBeLessThan(0);
    });
});

// ===========================================================================
// 4. Infeasible
// ===========================================================================

describe("searchBestPlan — infeasible", () => {
    it("returns null plan and lists the unsatisfiable rId when the only candidate is never offered in the window", () => {
        // SUM-UA 1 is offered ONLY in summer; the main-term window (fall/spring)
        // never includes summer → no legal (course, term) value.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            unmetRequirements: [
                {
                    rId: "rSummer",
                    title: "Summer Only",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["SUM-UA 1"],
                },
            ],
            courseCatalog: new Map([["SUM-UA 1", { title: "Summer Only", credits: 4 }]]),
            offerings: new Map([["SUM-UA 1", ["summer"]]]),
        });
        const ctx = buildConstraintContext(input);
        const result = searchBestPlan(ctx);

        expect(result.plan).toBeNull();
        expect(result.score).toBe(Infinity);
        expect(result.unsatisfiable).toContain("rSummer");
    });
});

// ===========================================================================
// 5. Determinism
// ===========================================================================

describe("searchBestPlan — determinism", () => {
    it("identical input → two calls return identical plan (same placements, same order) and score", () => {
        const makeScenario = () =>
            makeInput({
                currentTerm: "2026-fall",
                graduationTerm: "2027-spring",
                creditCeiling: 8,
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

        const r1 = searchBestPlan(buildConstraintContext(makeScenario()));
        const r2 = searchBestPlan(buildConstraintContext(makeScenario()));

        expect(r1.score).toBe(r2.score);
        expect(r1.plan).not.toBeNull();
        // Identical placements, in identical order.
        expect(r1.plan!.placed).toEqual(r2.plan!.placed);
    });
});

// ===========================================================================
// 6. Never-invalid (the collide case)
// ===========================================================================

describe("searchBestPlan — returned plan is never invalid", () => {
    it("the collide-case plan passes every per-placement + coverage hard predicate", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 6,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Requirement One",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: ["A-UA 1", "B-UA 2"],
                },
                {
                    rId: "r2",
                    title: "Requirement Two",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: ["A-UA 1", "C-UA 3"],
                },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "Course A", credits: 4 }],
                ["B-UA 2", { title: "Course B", credits: 4 }],
                ["C-UA 3", { title: "Course C", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall"]],
                ["B-UA 2", ["spring"]],
                ["C-UA 3", ["spring"]],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const result = searchBestPlan(ctx);

        expect(result.plan).not.toBeNull();
        const plan = result.plan!;
        expect(checkOfferingSeasonMatch(plan, ctx).ok).toBe(true);
        expect(checkPrereqsSatisfied(plan, ctx).ok).toBe(true);
        expect(checkNotClauseClear(plan, ctx).ok).toBe(true);
        expect(checkCoreqsSameTerm(plan, ctx).ok).toBe(true);
        expect(checkPerTermCeiling(plan, ctx).ok).toBe(true);
        expect(checkRequirementCoverage(plan, ctx).ok).toBe(true);
    });
});

// ===========================================================================
// 7. Optimality (small)
// ===========================================================================

describe("searchBestPlan — optimality (small)", () => {
    it("picks the lower-scorePlan term for a single 1-variable, 2-term case", () => {
        // One requirement, one candidate offered in BOTH fall and spring.
        // A fixed 8-credit course already sits in 2026-fall. With weights
        // {balance:1, timeToDegree:0}, placing the requirement (4 cr) in the
        // EMPTY 2027-spring term yields a lower-variance, lower-balance score
        // than piling it onto the already-loaded fall term.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 18,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Flexible",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: ["FLEX-UA 1"],
                },
            ],
            courseCatalog: new Map([["FLEX-UA 1", { title: "Flexible", credits: 4 }]]),
            offerings: new Map([["FLEX-UA 1", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);

        const fixed: PlacedCourse[] = [
            placed({ courseId: "FIX-UA 9", term: "2026-fall", credits: 8, source: "ip" }),
        ];
        const result = searchBestPlan(ctx, { weights: { balance: 1, timeToDegree: 0 }, fixed });

        expect(result.plan).not.toBeNull();
        const reqTerm = result.plan!.placed.find(p => p.satisfiesRId === "r1")!.term;
        // Balancing 8 (fall) + 4 (spring) beats lumping 12 (fall) + 0 (spring).
        expect(reqTerm).toBe("2027-spring");
    });
});
