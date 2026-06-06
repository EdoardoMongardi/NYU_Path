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
import type { PrereqGroup, ConfidenceTier } from "@nyupath/shared";
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

// ===========================================================================
// 8. Completeness regression — low-confidence course near capacity (Fix A)
// ===========================================================================

describe("searchBestPlan — completeness: low-confidence course near capacity (regression for forwardFeasibilityScreen prune)", () => {
    // The ONLY valid assignment routes a requirement through a "permission_only"
    // course, in a window deliberately sized so the OLD forwardFeasibilityScreen
    // (a hard prune in the forward-check) would have called every R1 branch
    // infeasible via its 2.0× low-confidence demand multiplier — even though the
    // REAL credits fit comfortably.
    //
    // Setup: 2 future terms (2026-fall, 2027-spring), creditCeiling = 5.
    //   R1 → REG-UA 1 (4 cr, normal confidence, offered fall+spring)
    //   R2 → LOW-UA 2 (4 cr, "permission_only", offered fall+spring)
    // Ordering ties on depth (0) and candidates.length (1); workload weight ties
    // (both major_elective); rId ASC ⇒ R1 is assigned first, R2 is "remaining".
    //
    // OLD screen at i=0 (R1 placed, demand for remaining R2 = 4 × 2.0 = 8):
    //   place REG in fall  → capacity = max(0,5-4)+max(0,5-0) = 1+5 = 6; 8 > 6 → PRUNE
    //   place REG in spring→ capacity = max(0,5-0)+max(0,5-4) = 5+1 = 6; 8 > 6 → PRUNE
    // Both R1 branches pruned ⇒ OLD search returns plan === null (false negative).
    //
    // REALITY: REG(4) in one term + LOW(4) in the other ⇒ each term 4 ≤ 5. Valid.
    // After Fix A (screen removed; only sound checkPerTermCeiling prunes capacity)
    // the branch survives and the leaf yields a valid plan.
    const offeringConfidence = new Map<string, ConfidenceTier>([
        ["LOW-UA 2", "permission_only"],
    ]);
    const input = makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditCeiling: 5,
        unmetRequirements: [
            {
                rId: "r1",
                title: "Regular",
                category: "major_elective",
                credits: 4,
                candidateCourses: ["REG-UA 1"],
            },
            {
                rId: "r2",
                title: "Permission Only",
                category: "major_elective",
                credits: 4,
                candidateCourses: ["LOW-UA 2"],
            },
        ],
        courseCatalog: new Map([
            ["REG-UA 1", { title: "Regular", credits: 4 }],
            ["LOW-UA 2", { title: "Permission Only", credits: 4 }],
        ]),
        offerings: new Map([
            ["REG-UA 1", ["fall", "spring"]],
            ["LOW-UA 2", ["fall", "spring"]],
        ]),
        offeringConfidence,
    });

    it("finds the valid plan the 2.0× low-confidence screen would have falsely pruned", () => {
        const ctx = buildConstraintContext(input);
        const result = searchBestPlan(ctx);

        expect(result.plan).not.toBeNull();
        const plan = result.plan!;

        // All requirements covered by their (only) candidate.
        expect(checkRequirementCoverage(plan, ctx).ok).toBe(true);
        const r1Course = plan.placed.find(p => p.satisfiesRId === "r1")?.courseId;
        const r2Course = plan.placed.find(p => p.satisfiesRId === "r2")?.courseId;
        expect(r1Course).toBe("REG-UA 1");
        expect(r2Course).toBe("LOW-UA 2");

        // The returned plan passes every incremental (sound) predicate — the real
        // credits DO fit (each term ≤ ceiling 5), unlike the screen's verdict.
        expect(checkOfferingSeasonMatch(plan, ctx).ok).toBe(true);
        expect(checkNotClauseClear(plan, ctx).ok).toBe(true);
        expect(checkCoreqsSameTerm(plan, ctx).ok).toBe(true);
        expect(checkPerTermCeiling(plan, ctx).ok).toBe(true);
        expect(checkPrereqsSatisfied(plan, ctx).ok).toBe(true);
    });
});

// ===========================================================================
// 9. Completeness regression — dependent ordered before its prereq (Fix B)
// ===========================================================================

describe("searchBestPlan — completeness: dependent considered before prereq via candidate ordering (regression for incremental prereq prune)", () => {
    // Two requirements arranged so the prereq-depth-ascending variable ordering
    // considers the DEPENDENT before its PREREQ — which the OLD incremental
    // checkPrereqsSatisfied prune could not tolerate.
    //
    //   Rdep (r1dep) candidates = [DEP-UA 2, ALT-DEP-UA 8]
    //       DEP-UA 2 has prereq PRE-UA 1 (depth 1); offered SPRING only.
    //       ALT-DEP-UA 8 is a shallow (depth-0) alternative offered SUMMER only
    //       → NOT selectable in the fall/spring window, so Rdep is forced to DEP,
    //         but its presence lowers minCandidateDepth(Rdep) to min(1,0) = 0.
    //   Rpre (r2pre) candidates = [PRE-UA 1, ALT-PRE-UA 9]
    //       PRE-UA 1 depth 0; offered FALL only.
    //       ALT-PRE-UA 9 depth 0, offered SUMMER only → not selectable; gives Rpre
    //         candidates.length = 2 to match Rdep so the tie-break reaches rId.
    //
    // Ordering: both depth 0, both candidates.length 2, workload weight ties
    // (both major_required) ⇒ rId ASC ⇒ r1dep (Rdep) is assigned FIRST, while its
    // prereq PRE is still unplaced.
    //
    // OLD behaviour: at i=0 the incremental prune evaluates checkPrereqsSatisfied
    // on a trial with DEP placed but PRE unplaced → prereq unsatisfied → DEP's
    // only value is pruned → Rdep has no surviving value → plan === null.
    //
    // AFTER Fix B: prereqs are NOT in the incremental prune, so DEP survives;
    // PRE is placed at i=1; the COMPLETE leaf re-checks prereqs with both placed —
    // PRE (2026-fall) precedes DEP (2027-spring) → satisfied → valid plan.
    const prereqs = new Map<string, PrereqGroup[]>([
        ["DEP-UA 2", [{ type: "AND", courses: ["PRE-UA 1"] }]],
    ]);
    const input = makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        prereqs,
        unmetRequirements: [
            {
                rId: "r1dep",
                title: "Dependent",
                category: "major_required",
                credits: 4,
                candidateCourses: ["DEP-UA 2", "ALT-DEP-UA 8"],
            },
            {
                rId: "r2pre",
                title: "Prereq",
                category: "major_required",
                credits: 4,
                candidateCourses: ["PRE-UA 1", "ALT-PRE-UA 9"],
            },
        ],
        courseCatalog: new Map([
            ["DEP-UA 2", { title: "Dependent", credits: 4 }],
            ["ALT-DEP-UA 8", { title: "Alt Dependent", credits: 4 }],
            ["PRE-UA 1", { title: "Prereq", credits: 4 }],
            ["ALT-PRE-UA 9", { title: "Alt Prereq", credits: 4 }],
        ]),
        offerings: new Map([
            ["DEP-UA 2", ["spring"]],
            ["ALT-DEP-UA 8", ["summer"]],
            ["PRE-UA 1", ["fall"]],
            ["ALT-PRE-UA 9", ["summer"]],
        ]),
    });

    it("still finds a valid plan with PRE placed in an earlier term than DEP", () => {
        const ctx = buildConstraintContext(input);
        const result = searchBestPlan(ctx);

        expect(result.plan).not.toBeNull();
        const plan = result.plan!;

        expect(checkRequirementCoverage(plan, ctx).ok).toBe(true);
        expect(checkPrereqsSatisfied(plan, ctx).ok).toBe(true);

        const preTerm = plan.placed.find(p => p.courseId === "PRE-UA 1")!.term;
        const depTerm = plan.placed.find(p => p.courseId === "DEP-UA 2")!.term;
        expect(preTerm).toBe("2026-fall");
        expect(depTerm).toBe("2027-spring");
        expect(compareSolverTerms(preTerm, depTerm)).toBeLessThan(0);
    });
});

// ===========================================================================
// 10. Pin coverage — a fixed pin satisfying a requirement is not double-placed
// ===========================================================================

describe("searchBestPlan — pin coverage (fixed placement satisfies a requirement)", () => {
    // A single requirement r1 whose only candidate, PIN-UA 1, is supplied as a
    // FIXED pin (source "pin", satisfiesRId "r1"). The search must SKIP the r1
    // variable entirely — it must NOT place a second course for r1 — and the
    // returned plan must cover r1 via the pin alone.
    const input = makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        unmetRequirements: [
            {
                rId: "r1",
                title: "Requirement One",
                category: "major_required",
                credits: 4,
                candidateCourses: ["PIN-UA 1"],
            },
        ],
        courseCatalog: new Map([["PIN-UA 1", { title: "Pinned Course", credits: 4 }]]),
        offerings: new Map([["PIN-UA 1", ["fall", "spring"]]]),
    });

    it("does not place another course for the pinned requirement; coverage holds via the pin", () => {
        const ctx = buildConstraintContext(input);
        const fixed: PlacedCourse[] = [
            placed({
                courseId: "PIN-UA 1",
                term: "2026-fall",
                credits: 4,
                source: "pin",
                satisfiesRId: "r1",
            }),
        ];
        const result = searchBestPlan(ctx, { fixed });

        expect(result.plan).not.toBeNull();
        const plan = result.plan!;

        // r1 is covered (the pin is a bound source counted by coverage).
        expect(checkRequirementCoverage(plan, ctx).ok).toBe(true);

        // EXACTLY one placement satisfies r1, and it is the pin (source "pin") —
        // the search added NO second "requirement"-source course for r1.
        const r1Placements = plan.placed.filter(p => p.satisfiesRId === "r1");
        expect(r1Placements).toHaveLength(1);
        expect(r1Placements[0]!.source).toBe("pin");
        expect(r1Placements[0]!.courseId).toBe("PIN-UA 1");

        // No requirement-source placement exists at all (the only variable was
        // covered by the pin and skipped).
        expect(plan.placed.some(p => p.source === "requirement")).toBe(false);
    });
});
