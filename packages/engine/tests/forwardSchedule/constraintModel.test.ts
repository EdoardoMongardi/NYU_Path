/**
 * Phase 2 P2.1b — hard-constraint model tests (TDD-first).
 *
 * Three test layers:
 *   1. Per-predicate unit tests (PASS + FAIL) for each of the 12 predicates.
 *   2. Registry test: HARD_CONSTRAINTS shape + checkHardConstraints composition.
 *   3. Proof/equivalence test: a real valid plan from solveForwardSchedule
 *      passes both checkHardConstraints AND runGraduationPathValidator; then
 *      negative mutations make the matching predicate fail.
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    buildRequirementVariables,
    checkHardConstraints,
    HARD_CONSTRAINTS,
    checkOfferingSeasonMatch,
    checkPrereqsSatisfied,
    checkNotClauseClear,
    checkCoreqsSameTerm,
    checkPerTermCeiling,
    checkPerTermFloor,
    checkRequirementCoverage,
    checkCreditMinimum,
    checkGraduationTarget,
    checkResidencyFloor,
    checkMajorCreditFloor,
    checkGpaFloors,
    type ConstraintContext,
    type PartialPlan,
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { PrereqGroup } from "@nyupath/shared";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import {
    runGraduationPathValidator,
    type GraduationPathValidatorArgs,
} from "../../src/agent/forwardSchedule/graduationPathValidator.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories
// ---------------------------------------------------------------------------

function makeMinimalDpr(
    overrides: Partial<DegreeProgressReport> = {},
): DegreeProgressReport {
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
// 1. Per-predicate unit tests
// ===========================================================================

describe("checkOfferingSeasonMatch", () => {
    it("PASS when course is placed in an offered season", () => {
        const ctx = buildConstraintContext(
            makeInput({ offerings: new Map([["X-UA 1", ["fall"]]]) }),
        );
        const plan: PartialPlan = { placed: [placed({ courseId: "X-UA 1", term: "2026-fall" })] };
        expect(checkOfferingSeasonMatch(plan, ctx).ok).toBe(true);
    });

    it("FAIL (offering_pattern) when course is placed off-season", () => {
        const ctx = buildConstraintContext(
            makeInput({ offerings: new Map([["X-UA 1", ["fall"]]]) }),
        );
        const plan: PartialPlan = { placed: [placed({ courseId: "X-UA 1", term: "2027-spring" })] };
        const r = checkOfferingSeasonMatch(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("offering_pattern");
        expect(r.violations[0]!.course).toBe("X-UA 1");
        expect(r.violations[0]!.term).toBe("2027-spring");
    });

    it("empty offerings ⇒ no constraint", () => {
        const ctx = buildConstraintContext(makeInput({ offerings: new Map([["X-UA 1", []]]) }));
        const plan: PartialPlan = { placed: [placed({ courseId: "X-UA 1", term: "2027-spring" })] };
        expect(checkOfferingSeasonMatch(plan, ctx).ok).toBe(true);
    });
});

describe("checkPrereqsSatisfied", () => {
    const prereqs = new Map<string, PrereqGroup[]>([
        ["ADV-UA 2", [{ type: "AND", courses: ["BASE-UA 1"] }]],
    ]);

    it("PASS when prereq is placed in an earlier term", () => {
        const ctx = buildConstraintContext(makeInput({ prereqs }));
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "BASE-UA 1", term: "2026-fall" }),
                placed({ courseId: "ADV-UA 2", term: "2027-spring" }),
            ],
        };
        expect(checkPrereqsSatisfied(plan, ctx).ok).toBe(true);
    });

    it("FAIL (prereq_unsatisfiable) when prereq is missing", () => {
        const ctx = buildConstraintContext(makeInput({ prereqs }));
        const plan: PartialPlan = {
            placed: [placed({ courseId: "ADV-UA 2", term: "2026-fall" })],
        };
        const r = checkPrereqsSatisfied(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("prereq_unsatisfiable");
        expect(r.violations[0]!.course).toBe("ADV-UA 2");
    });

    it("source 'ip' is exempt from prereq checks", () => {
        const ctx = buildConstraintContext(makeInput({ prereqs }));
        const plan: PartialPlan = {
            placed: [placed({ courseId: "ADV-UA 2", term: "2026-fall", source: "ip" })],
        };
        expect(checkPrereqsSatisfied(plan, ctx).ok).toBe(true);
    });
});

describe("checkNotClauseClear", () => {
    // ALT-UA 2 is excluded if ALT-UA 1 is taken/placed.
    const prereqs = new Map<string, PrereqGroup[]>([
        ["ALT-UA 2", [{ type: "NOT", courses: [], notCourses: ["ALT-UA 1"] }]],
    ]);

    it("PASS when no NOT-clause course is present", () => {
        const ctx = buildConstraintContext(makeInput({ prereqs }));
        const plan: PartialPlan = {
            placed: [placed({ courseId: "ALT-UA 2", term: "2026-fall" })],
        };
        expect(checkNotClauseClear(plan, ctx).ok).toBe(true);
    });

    it("FAIL (not_clause) when an excluded sibling is also placed", () => {
        const ctx = buildConstraintContext(makeInput({ prereqs }));
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "ALT-UA 1", term: "2026-fall" }),
                placed({ courseId: "ALT-UA 2", term: "2027-spring" }),
            ],
        };
        const r = checkNotClauseClear(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("not_clause");
        expect(r.violations[0]!.course).toBe("ALT-UA 2");
    });

    it("a course never excludes ITSELF via the NOT clause", () => {
        // ALT-UA 1 has a NOT clause naming itself — placing only ALT-UA 1
        // must not self-trip (placedBefore excludes the course itself).
        const selfPrereqs = new Map<string, PrereqGroup[]>([
            ["ALT-UA 1", [{ type: "NOT", courses: [], notCourses: ["ALT-UA 1"] }]],
        ]);
        const ctx = buildConstraintContext(makeInput({ prereqs: selfPrereqs }));
        const plan: PartialPlan = {
            placed: [placed({ courseId: "ALT-UA 1", term: "2026-fall" })],
        };
        expect(checkNotClauseClear(plan, ctx).ok).toBe(true);
    });

    it("FAIL when coursesTaken contains the excluded course", () => {
        const ctx = buildConstraintContext(
            makeInput({ prereqs, coursesTaken: new Set(["ALT-UA 1"]) }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "ALT-UA 2", term: "2026-fall" })],
        };
        expect(checkNotClauseClear(plan, ctx).ok).toBe(false);
    });
});

describe("checkCoreqsSameTerm", () => {
    const coreqs = new Map<string, string[]>([["LEC-UA 1", ["LAB-UA 1"]]]);

    it("PASS when coreq is placed in the same term", () => {
        const ctx = buildConstraintContext(makeInput({ coreqs }));
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "LEC-UA 1", term: "2026-fall" }),
                placed({ courseId: "LAB-UA 1", term: "2026-fall" }),
            ],
        };
        expect(checkCoreqsSameTerm(plan, ctx).ok).toBe(true);
    });

    it("PASS when coreq is unplaced (coverage handles that, not this)", () => {
        const ctx = buildConstraintContext(makeInput({ coreqs }));
        const plan: PartialPlan = {
            placed: [placed({ courseId: "LEC-UA 1", term: "2026-fall" })],
        };
        expect(checkCoreqsSameTerm(plan, ctx).ok).toBe(true);
    });

    it("FAIL (other) when coreq is placed in a DIFFERENT term", () => {
        const ctx = buildConstraintContext(makeInput({ coreqs }));
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "LEC-UA 1", term: "2026-fall" }),
                placed({ courseId: "LAB-UA 1", term: "2027-spring" }),
            ],
        };
        const r = checkCoreqsSameTerm(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("other");
        expect(r.violations[0]!.course).toBe("LEC-UA 1");
    });

    it("coreq already in coursesInProgress is not a same-term violation", () => {
        const ctx = buildConstraintContext(
            makeInput({ coreqs, coursesInProgress: new Map([["LAB-UA 1", { term: "2026-fall" }]]) }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "LEC-UA 1", term: "2027-spring" })],
        };
        expect(checkCoreqsSameTerm(plan, ctx).ok).toBe(true);
    });
});

describe("checkPerTermCeiling", () => {
    it("PASS when term credits are at the ceiling", () => {
        const ctx = buildConstraintContext(makeInput({ creditCeiling: 18 }));
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 12 }),
                placed({ courseId: "B", term: "2026-fall", credits: 6 }),
            ],
        };
        expect(checkPerTermCeiling(plan, ctx).ok).toBe(true);
    });

    it("FAIL (credit_ceiling) when a term exceeds the ceiling", () => {
        const ctx = buildConstraintContext(makeInput({ creditCeiling: 18 }));
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 16 }),
                placed({ courseId: "B", term: "2026-fall", credits: 4 }),
            ],
        };
        const r = checkPerTermCeiling(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("credit_ceiling");
        expect(r.violations[0]!.term).toBe("2026-fall");
    });
});

describe("checkPerTermFloor", () => {
    it("PASS when each non-empty term meets the F-1 floor (12)", () => {
        const ctx = buildConstraintContext(makeInput({ f1Floor: 12, visaStatus: "f1" }));
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 12 }),
                placed({ courseId: "B", term: "2027-spring", credits: 12 }),
            ],
        };
        expect(checkPerTermFloor(plan, ctx).ok).toBe(true);
    });

    it("FAIL (credit_floor) when a non-final term is below the F-1 floor", () => {
        const ctx = buildConstraintContext(makeInput({ f1Floor: 12, visaStatus: "f1" }));
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 8 }),
                placed({ courseId: "B", term: "2027-spring", credits: 12 }),
            ],
        };
        const r = checkPerTermFloor(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations.some(v => v.kind === "credit_floor" && v.term === "2026-fall")).toBe(true);
    });

    it("empty term (0 credits) is skipped — not a floor violation", () => {
        const ctx = buildConstraintContext(makeInput({ f1Floor: 12, visaStatus: "f1" }));
        const plan: PartialPlan = {
            placed: [placed({ courseId: "A", term: "2026-fall", credits: 12 })],
        };
        // 2027-spring has 0 placed → skipped.
        expect(checkPerTermFloor(plan, ctx).ok).toBe(true);
    });
});

describe("checkRequirementCoverage", () => {
    const reqInput = makeInput({
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
    });

    it("PASS when a bound placement satisfies the requirement", () => {
        const ctx = buildConstraintContext(reqInput);
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "REQ-UA 1", term: "2026-fall", satisfiesRId: "r1", source: "requirement" }),
            ],
        };
        expect(checkRequirementCoverage(plan, ctx).ok).toBe(true);
    });

    it("FAIL (other) when the requirement is uncovered", () => {
        const ctx = buildConstraintContext(reqInput);
        const plan: PartialPlan = { placed: [] };
        const r = checkRequirementCoverage(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("other");
        expect(r.violations[0]!.detail).toContain("r1");
    });

    it("a 'free'-source placement does NOT count as a satisfier", () => {
        const ctx = buildConstraintContext(reqInput);
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "REQ-UA 1", term: "2026-fall", satisfiesRId: "r1", source: "free" }),
            ],
        };
        expect(checkRequirementCoverage(plan, ctx).ok).toBe(false);
    });

    it("a requirement with no viable candidates is NOT required to be covered", () => {
        // Candidate course not in catalog → empty candidates → placeholder downstream.
        const ctx = buildConstraintContext(
            makeInput({
                unmetRequirements: [
                    {
                        rId: "rEmpty",
                        title: "Unmappable",
                        category: "free_elective",
                        credits: 4,
                        candidateCourses: ["MISSING-UA 99"],
                    },
                ],
                courseCatalog: new Map(),
            }),
        );
        expect(checkRequirementCoverage({ placed: [] }, ctx).ok).toBe(true);
    });
});

describe("checkCreditMinimum", () => {
    it("PASS when earned + placed meets the graduation minimum", () => {
        const ctx = buildConstraintContext(
            makeInput({ creditsEarned: 120, graduationCreditMinimum: 128 }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "A", term: "2026-fall", credits: 8 })],
        };
        expect(checkCreditMinimum(plan, ctx).ok).toBe(true);
    });

    it("FAIL (graduation_total) when total falls short", () => {
        const ctx = buildConstraintContext(
            makeInput({ creditsEarned: 120, graduationCreditMinimum: 128 }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "A", term: "2026-fall", credits: 4 })],
        };
        const r = checkCreditMinimum(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("graduation_total");
    });
});

describe("checkGraduationTarget", () => {
    it("PASS when the minimum is reached on/before the graduation term", () => {
        const ctx = buildConstraintContext(
            makeInput({
                creditsEarned: 120,
                graduationCreditMinimum: 128,
                currentTerm: "2026-fall",
                graduationTerm: "2027-spring",
            }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "A", term: "2026-fall", credits: 8 })],
        };
        expect(checkGraduationTarget(plan, ctx).ok).toBe(true);
    });

    it("FAIL (graduation_total) when completion lands after the graduation term", () => {
        // Only 4 placed in 2026-fall, 4 in 2027-spring → reaches 128 only in spring,
        // but if graduation target were 2026-fall it would be late. Use that.
        const ctx = buildConstraintContext(
            makeInput({
                creditsEarned: 120,
                graduationCreditMinimum: 128,
                currentTerm: "2026-fall",
                graduationTerm: "2026-fall",
            }),
        );
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 4 }),
                placed({ courseId: "B", term: "2027-spring", credits: 4 }),
            ],
        };
        const r = checkGraduationTarget(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("graduation_total");
    });

    it("FAIL when the minimum is never reached within the horizon", () => {
        const ctx = buildConstraintContext(
            makeInput({
                creditsEarned: 100,
                graduationCreditMinimum: 128,
                currentTerm: "2026-fall",
                graduationTerm: "2027-spring",
            }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "A", term: "2026-fall", credits: 4 })],
        };
        expect(checkGraduationTarget(plan, ctx).ok).toBe(false);
    });
});

describe("checkResidencyFloor", () => {
    it("null residencyMinCredits ⇒ no violation (requires-approval, not fail)", () => {
        const ctx = buildConstraintContext(makeInput()); // residencyMinCredits null by default
        expect(checkResidencyFloor({ placed: [] }, ctx).ok).toBe(true);
    });

    it("PASS when dpr baseline + placed credits meet the floor", () => {
        const dpr = makeMinimalDpr();
        dpr.cumulative.residencyUsed = 60;
        const ctx = buildConstraintContext(
            makeInput({
                dpr,
                programRules: {
                    majorRuleKinds: new Map(),
                    schoolCoreRuleIds: new Set(),
                    generalCategoryRuleIds: new Set(),
                    residencyMinCredits: 64,
                    majorCreditMinimum: null,
                    upperLevelMinCredits: null,
                },
            }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "A", term: "2026-fall", credits: 4, source: "requirement" })],
        };
        expect(checkResidencyFloor(plan, ctx).ok).toBe(true);
    });

    it("FAIL (other) when residency baseline + placed credits fall short", () => {
        const dpr = makeMinimalDpr();
        dpr.cumulative.residencyUsed = 40;
        const ctx = buildConstraintContext(
            makeInput({
                dpr,
                programRules: {
                    majorRuleKinds: new Map(),
                    schoolCoreRuleIds: new Set(),
                    generalCategoryRuleIds: new Set(),
                    residencyMinCredits: 64,
                    majorCreditMinimum: null,
                    upperLevelMinCredits: null,
                },
            }),
        );
        const plan: PartialPlan = {
            placed: [placed({ courseId: "A", term: "2026-fall", credits: 4, source: "requirement" })],
        };
        const r = checkResidencyFloor(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("other");
    });

    it("free-source placements do NOT count toward residency", () => {
        const dpr = makeMinimalDpr();
        dpr.cumulative.residencyUsed = 60;
        const ctx = buildConstraintContext(
            makeInput({
                dpr,
                programRules: {
                    majorRuleKinds: new Map(),
                    schoolCoreRuleIds: new Set(),
                    generalCategoryRuleIds: new Set(),
                    residencyMinCredits: 64,
                    majorCreditMinimum: null,
                    upperLevelMinCredits: null,
                },
            }),
        );
        // 60 + 0 (free doesn't count) = 60 < 64 → fail.
        const plan: PartialPlan = {
            placed: [placed({ courseId: "A", term: "2026-fall", credits: 8, source: "free" })],
        };
        expect(checkResidencyFloor(plan, ctx).ok).toBe(false);
    });
});

describe("checkMajorCreditFloor", () => {
    function ctxWithMajorMin(min: number | null): ConstraintContext {
        return buildConstraintContext(
            makeInput({
                programRules: {
                    majorRuleKinds: new Map(),
                    schoolCoreRuleIds: new Set(),
                    generalCategoryRuleIds: new Set(),
                    residencyMinCredits: null,
                    majorCreditMinimum: min,
                    upperLevelMinCredits: null,
                },
            }),
        );
    }

    it("null majorCreditMinimum ⇒ no violation", () => {
        expect(checkMajorCreditFloor({ placed: [] }, ctxWithMajorMin(null)).ok).toBe(true);
    });

    it("PASS when bound major-tier credits meet the floor", () => {
        const ctx = ctxWithMajorMin(8);
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 4, workloadTier: "major-required", source: "requirement" }),
                placed({ courseId: "B", term: "2026-fall", credits: 4, workloadTier: "major-elective", source: "pin" }),
            ],
        };
        expect(checkMajorCreditFloor(plan, ctx).ok).toBe(true);
    });

    it("FAIL (other) when major-tier credits fall short", () => {
        const ctx = ctxWithMajorMin(8);
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 4, workloadTier: "major-required", source: "requirement" }),
                // free-elective tier does not count
                placed({ courseId: "B", term: "2026-fall", credits: 4, workloadTier: "free-elective", source: "requirement" }),
            ],
        };
        const r = checkMajorCreditFloor(plan, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("other");
        expect(r.violations[0]!.detail).toMatch(/major/i);
    });

    it("major-tier credits from a 'free' source do NOT count", () => {
        const ctx = ctxWithMajorMin(8);
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 4, workloadTier: "major-required", source: "free" }),
                placed({ courseId: "B", term: "2026-fall", credits: 4, workloadTier: "major-required", source: "free" }),
            ],
        };
        expect(checkMajorCreditFloor(plan, ctx).ok).toBe(false);
    });

    it("major-tier credits from an 'ip' (in-progress) source do NOT count — mirrors the validator's specific_planned-only major check", () => {
        const ctx = ctxWithMajorMin(8);
        const plan: PartialPlan = {
            placed: [
                placed({ courseId: "A", term: "2026-fall", credits: 4, workloadTier: "major-required", source: "requirement" }),
                // in_progress major credits must be EXCLUDED (graduationPathValidator axis 4
                // counts only specific_planned, not in_progress). Residency counts ip; major does not.
                placed({ courseId: "B", term: "2026-fall", credits: 4, workloadTier: "major-required", source: "ip" }),
            ],
        };
        // 4 bound (requirement) + 4 ip-excluded = 4 < 8 floor → FAIL (would have passed if ip counted)
        expect(checkMajorCreditFloor(plan, ctx).ok).toBe(false);
    });
});

describe("checkGpaFloors", () => {
    it("PASS when cumulative and major GPA are above their floors", () => {
        const ctx = buildConstraintContext(
            makeInput({ cumulativeGpa: 3.4, graduationGpaFloor: 2.0, majorGpa: 3.0, majorGpaFloor: 2.0 }),
        );
        expect(checkGpaFloors({ placed: [] }, ctx).ok).toBe(true);
    });

    it("FAIL (gpa_floor) when cumulative GPA is below the floor", () => {
        const ctx = buildConstraintContext(
            makeInput({ cumulativeGpa: 1.5, graduationGpaFloor: 2.0 }),
        );
        const r = checkGpaFloors({ placed: [] }, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations[0]!.kind).toBe("gpa_floor");
    });

    it("FAIL (gpa_floor) when major GPA is below the major floor", () => {
        const ctx = buildConstraintContext(
            makeInput({ cumulativeGpa: 3.4, graduationGpaFloor: 2.0, majorGpa: 1.8, majorGpaFloor: 2.0 }),
        );
        const r = checkGpaFloors({ placed: [] }, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations.some(v => v.kind === "gpa_floor")).toBe(true);
    });
});

// ===========================================================================
// 2. Registry + composition
// ===========================================================================

describe("HARD_CONSTRAINTS registry", () => {
    const EXPECTED: Array<{ id: string; phase: string; axis: string }> = [
        { id: "offeringSeasonMatch", phase: "incremental", axis: "perPlacement" },
        { id: "prereqsSatisfied", phase: "incremental", axis: "perPlacement" },
        { id: "notClauseClear", phase: "incremental", axis: "perPlacement" },
        { id: "coreqsSameTerm", phase: "incremental", axis: "perPlacement" },
        { id: "perTermCeiling", phase: "incremental", axis: "visaAxesPass" },
        { id: "perTermFloor", phase: "completion", axis: "visaAxesPass" },
        { id: "requirementCoverage", phase: "completion", axis: "requirementGroupsSatisfied" },
        { id: "creditMinimum", phase: "completion", axis: "totalCreditsMeetMinimum" },
        { id: "graduationTarget", phase: "completion", axis: "graduationTargetMet" },
        { id: "residencyFloor", phase: "completion", axis: "thresholdsMet" },
        { id: "majorCreditFloor", phase: "completion", axis: "thresholdsMet" },
        { id: "gpaFloors", phase: "completion", axis: "visaAxesPass" },
    ];

    it("has all 12 constraints in the documented order with the right phase + axis", () => {
        expect(HARD_CONSTRAINTS).toHaveLength(12);
        for (let i = 0; i < EXPECTED.length; i++) {
            expect(HARD_CONSTRAINTS[i]!.id).toBe(EXPECTED[i]!.id);
            expect(HARD_CONSTRAINTS[i]!.phase).toBe(EXPECTED[i]!.phase);
            expect(HARD_CONSTRAINTS[i]!.axis).toBe(EXPECTED[i]!.axis);
        }
    });

    it("checkHardConstraints composes all constraints; phase filter narrows", () => {
        const ctx = buildConstraintContext(
            makeInput({ offerings: new Map([["X-UA 1", ["fall"]]]) }),
        );
        // Off-season placement → an incremental (offeringSeasonMatch) violation.
        const plan: PartialPlan = { placed: [placed({ courseId: "X-UA 1", term: "2027-spring" })] };

        const all = checkHardConstraints(plan, ctx);
        expect(all.ok).toBe(false);
        expect(all.violations.some(v => v.kind === "offering_pattern")).toBe(true);

        const inc = checkHardConstraints(plan, ctx, "incremental");
        expect(inc.violations.some(v => v.kind === "offering_pattern")).toBe(true);

        // The completion phase does not run offeringSeasonMatch.
        const comp = checkHardConstraints(plan, ctx, "completion");
        expect(comp.violations.some(v => v.kind === "offering_pattern")).toBe(false);
    });
});

describe("buildRequirementVariables", () => {
    it("filters candidates by catalog presence, exclusions, and study-abroad", () => {
        const ctx = buildConstraintContext(
            makeInput({
                currentTerm: "2026-fall",
                graduationTerm: "2027-spring",
                unmetRequirements: [
                    {
                        rId: "r1",
                        title: "Pick One",
                        category: "major_elective",
                        credits: 4,
                        candidateCourses: ["KEEP-UA 1", "MISSING-UA 2", "EXCL-UA 3", "ABROAD-UA 9001"],
                    },
                ],
                courseCatalog: new Map([
                    ["KEEP-UA 1", { title: "Keep", credits: 4 }],
                    ["EXCL-UA 3", { title: "Excluded", credits: 4 }],
                    ["ABROAD-UA 9001", { title: "Abroad", credits: 4 }],
                ]),
                offerings: new Map([["KEEP-UA 1", ["fall"]]]),
                preferences: { exclusions: [{ courseId: "EXCL-UA 3" }] },
            }),
        );
        const vars = buildRequirementVariables(ctx);
        expect(vars).toHaveLength(1);
        expect(vars[0]!.candidates).toEqual(["KEEP-UA 1"]);
        // Domain: KEEP-UA 1 is fall-only → only 2026-fall in the horizon.
        expect(vars[0]!.domain).toEqual([{ courseId: "KEEP-UA 1", term: "2026-fall" }]);
    });
});

// ===========================================================================
// 3. Proof / equivalence test
// ===========================================================================

/**
 * Convert a solved plan into a COMPLETE PartialPlan.
 *
 * The greedy solver leaves free capacity as unbound `placeholder` slots that
 * still carry reserved credits (the validator counts these toward
 * `sem.plannedCredits` for the total-credit / per-term-floor / graduation axes).
 * A complete plan in the constraint model represents those reserved credits as
 * genuinely-placed courses, so we materialise each placeholder as a
 * `source: "free"` placement (synthetic courseId). Free placeholders do not
 * satisfy requirements and are not major-tier from the floor's perspective —
 * exactly mirroring the validator, which counts placeholder credits toward
 * plannedCredits but NOT toward requirement coverage or the major-credit floor.
 *   - specific_planned → source "requirement"
 *   - in_progress      → source "ip"
 *   - placeholder      → source "free" (reserved credits, unbound)
 */
function planFromSolved(out: ReturnType<typeof solveForwardSchedule>): PartialPlan {
    const placedList: PlacedCourse[] = [];
    let phCounter = 0;
    for (const sem of out.semesters) {
        for (const slot of sem.slots) {
            if (slot.kind === "specific_planned") {
                placedList.push({
                    courseId: slot.courseId,
                    term: sem.term,
                    credits: slot.credits,
                    workloadTier: slot.workloadTier,
                    workloadWeight: slot.workloadWeight,
                    satisfiesRId: slot.satisfiesRules[0] ?? null,
                    source: "requirement",
                });
            } else if (slot.kind === "in_progress") {
                placedList.push({
                    courseId: slot.courseId,
                    term: sem.term,
                    credits: slot.credits,
                    workloadTier: "free-elective",
                    workloadWeight: 0.5,
                    satisfiesRId: null,
                    source: "ip",
                });
            } else if (slot.kind === "placeholder") {
                placedList.push({
                    courseId: `__free_${phCounter++}`,
                    term: sem.term,
                    credits: slot.credits,
                    workloadTier: "free-elective",
                    workloadWeight: slot.workloadWeight,
                    satisfiesRId: null,
                    source: "free",
                });
            }
        }
    }
    return { placed: placedList };
}

describe("equivalence: hard predicates agree with runGraduationPathValidator on a real plan", () => {
    // A simple, fully-solvable scenario: 100 earned, two required courses worth
    // 4 credits each, F-1, two-term horizon. The solver fills to the 16-credit
    // target with free electives.
    const baseInput = makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditsEarned: 100,
        graduationCreditMinimum: 128,
        unmetRequirements: [
            {
                rId: "r1",
                title: "Required Course One",
                category: "major_required",
                credits: 4,
                candidateCourses: ["REQ-UA 1"],
            },
            {
                rId: "r2",
                title: "Required Course Two",
                category: "major_required",
                credits: 4,
                candidateCourses: ["REQ-UA 2"],
            },
        ],
        courseCatalog: new Map([
            ["REQ-UA 1", { title: "Required Course One", credits: 4 }],
            ["REQ-UA 2", { title: "Required Course Two", credits: 4 }],
        ]),
        offerings: new Map([
            ["REQ-UA 1", ["fall", "spring"]],
            ["REQ-UA 2", ["fall", "spring"]],
        ]),
        offeringConfidence: new Map([
            ["REQ-UA 1", "historically_likely"],
            ["REQ-UA 2", "historically_likely"],
        ]),
    });

    function makeValidatorArgs(out: ReturnType<typeof solveForwardSchedule>): GraduationPathValidatorArgs {
        // Mirror the solved plan into a ForwardSchedule for the validator.
        const plan = {
            studentId: baseInput.studentId,
            homeSchoolId: baseInput.homeSchoolId,
            graduationTerm: baseInput.graduationTerm,
            creditTargetPerSemester: baseInput.creditTargetPerSemester,
            f1Floor: baseInput.f1Floor,
            domesticPartTimeFloor: baseInput.domesticPartTimeFloor,
            graduationCreditMinimum: baseInput.graduationCreditMinimum,
            degreeCreditsMet: baseInput.creditsEarned >= baseInput.graduationCreditMinimum,
            semesters: out.semesters,
            dprCourseHistoryHash: baseInput.dprCourseHistoryHash,
            computedAt: 0,
            feasibility: out.feasibility,
            state: out.state,
            balanceScore: out.balanceScore,
            assumptions: out.assumptions,
        };
        return {
            plan,
            dpr: baseInput.dpr,
            programRules: {
                degreeCreditMinimum: baseInput.graduationCreditMinimum,
                residencyMinCredits: baseInput.programRules.residencyMinCredits,
                majorCreditMinimum: baseInput.programRules.majorCreditMinimum,
                minorCreditMinimum: null,
                upperLevelMinCredits: baseInput.programRules.upperLevelMinCredits,
                schoolCoreMinCredits: null,
                graduationTargetTerm: baseInput.graduationTerm,
            },
        };
    }

    it("the solved valid plan passes BOTH hard predicates and the validator", () => {
        const out = solveForwardSchedule(baseInput);
        // Sanity: solver produced a feasible plan.
        expect(out.feasibility.feasible).toBe(true);

        const ctx = buildConstraintContext(baseInput);
        const plan = planFromSolved(out);

        const hard = checkHardConstraints(plan, ctx);
        expect(hard.ok).toBe(true);

        const validator = runGraduationPathValidator(makeValidatorArgs(out));
        expect(validator.feasible).toBe(true);
    });

    it("negative: dropping a required course makes checkRequirementCoverage fail", () => {
        const out = solveForwardSchedule(baseInput);
        const ctx = buildConstraintContext(baseInput);
        const plan = planFromSolved(out);

        // Drop the placement covering r1.
        const mutated: PartialPlan = {
            placed: plan.placed.filter(p => p.satisfiesRId !== "r1"),
        };
        const r = checkRequirementCoverage(mutated, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations.some(v => v.detail.includes("r1"))).toBe(true);
    });

    it("negative: overloading a term makes checkPerTermCeiling fail", () => {
        const out = solveForwardSchedule(baseInput);
        const ctx = buildConstraintContext(baseInput);
        const plan = planFromSolved(out);

        // Pile an extra 20 credits into the first term.
        const firstTerm = ctx.futureTerms[0]!;
        const mutated: PartialPlan = {
            placed: [
                ...plan.placed,
                placed({ courseId: "OVERLOAD-UA 1", term: firstTerm, credits: 20 }),
            ],
        };
        const r = checkPerTermCeiling(mutated, ctx);
        expect(r.ok).toBe(false);
        expect(r.violations.some(v => v.kind === "credit_ceiling" && v.term === firstTerm)).toBe(true);
    });
});
