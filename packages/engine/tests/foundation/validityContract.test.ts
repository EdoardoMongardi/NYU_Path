/**
 * PLAN-4 Task 1.9 — validity-contract harness (folds in Task 0.3).
 *
 * Asserts two correctness properties:
 *
 * 1. An unbound placeholder as the ONLY satisfier for a required rule
 *    does NOT count as satisfied → requirementGroupsSatisfied axis fails →
 *    derivePlanStateFromValidator === "infeasible-draft".
 *
 * 2. A plan where planned major credits fall below majorCreditMinimum →
 *    checkThresholdsMet does NOT pass (must be "fail").
 *
 * Constructed entirely inline — no external fixtures or I/O.
 */

import { describe, it, expect } from "vitest";
import {
    runGraduationPathValidator,
    derivePlanStateFromValidator,
} from "../../src/agent/forwardSchedule/graduationPathValidator.js";
import type { GraduationPathValidatorArgs } from "../../src/agent/forwardSchedule/graduationPathValidator.js";
import type { ForwardSchedule } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared fixture helpers (minimal, self-contained)
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:test",
        sourcePdfPageCount: 1,
        parseDurationMs: 0,
        warnings: [],
    };
}

function makeBaseDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Contract Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 96,
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

function makeBasePlan(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
    return {
        studentId: "contract-test",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "sha256:test",
        computedAt: 0,
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
        ...overrides,
    };
}

function makeProgramRules(
    overrides: Partial<GraduationPathValidatorArgs["programRules"]> = {},
): GraduationPathValidatorArgs["programRules"] {
    return {
        degreeCreditMinimum: 128,
        residencyMinCredits: 64,
        majorCreditMinimum: 32,
        minorCreditMinimum: null,
        upperLevelMinCredits: null,
        schoolCoreMinCredits: null,
        graduationTargetTerm: "2027-spring",
        ...overrides,
    };
}

// Reusable semester builder
function makeSemester(
    term: string,
    plannedCredits: number,
    slots: ForwardSchedule["semesters"][number]["slots"],
): ForwardSchedule["semesters"][number] {
    return {
        term,
        locked: false,
        plannedCredits,
        notes: [],
        loadRationale: {
            strategy: "balanced",
            creditsTarget: 16,
            slack: 16 - plannedCredits,
            weightedCredits: plannedCredits,
            hardCount: Math.floor(plannedCredits / 4),
            easyCount: 0,
            alternativeDistributionsConsidered: [],
        },
        slots,
    };
}

// ---------------------------------------------------------------------------
// Contract 1 — unbound placeholder as sole satisfier → infeasible-draft
// ---------------------------------------------------------------------------

describe("PLAN-4 Contract 1: unbound placeholder does NOT satisfy a required rule", () => {
    /**
     * Setup:
     *   - DPR has one not-satisfied requirement leaf R-CONTRACT/10 with coursesUsed = []
     *   - Plan has one semester with ONE slot: a placeholder (unbound, bindingState:
     *     "placeholder-pending") whose satisfiesRules = ["R-CONTRACT/10"]
     *   - programRules: residencyMinCredits = 64, majorCreditMinimum = null (so only
     *     Axis 1 is the target failure here; thresholds won't fire for major)
     *
     * Expected after Bug B fix:
     *   - requirementGroupsSatisfied.status === "fail" (placeholder not counted)
     *   - derivePlanStateFromValidator === "infeasible-draft"
     */
    it("requirementGroupsSatisfied fails when only satisfier is an unbound placeholder", () => {
        const dpr = makeBaseDpr({
            requirementGroups: [
                {
                    rgId: "RG-CONTRACT",
                    title: "Contract Test Group",
                    status: "not_satisfied",
                    statusText: "Not Satisfied",
                    children: [
                        {
                            rId: "R-CONTRACT/10",
                            title: "Required Contract Course",
                            status: "not_satisfied",
                            statusText: "Not Satisfied",
                            coursesUsed: [],  // no DPR credit
                        },
                    ],
                },
            ],
        });

        const plan = makeBasePlan({
            semesters: [
                makeSemester("2026-fall", 4, [
                    {
                        kind: "placeholder",
                        category: "contract-required",
                        credits: 4,
                        satisfiesRules: ["R-CONTRACT/10"],  // sole satisfier
                        optional: false,
                        reason: "Must take a contract course",
                        rationale: {
                            satisfiesRequirements: ["R-CONTRACT/10"],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2026-fall",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",
                        workloadWeight: 1.0,
                        bindingState: "placeholder-pending",  // UNBOUND
                        placeholderId: "PH-CONTRACT-1",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                ]),
            ],
        });

        const args: GraduationPathValidatorArgs = {
            plan,
            dpr,
            programRules: makeProgramRules({
                // residency already met (residencyUsed=64 >= residencyMinCredits=64),
                // plan has no specific_planned slots so residency contribution = 0 from plan.
                // But residencyUsed=64 >= 64 already → residency passes.
                residencyMinCredits: 64,
                majorCreditMinimum: null,  // don't conflate with Axis 4
                degreeCreditMinimum: 100,  // 96 earned + 4 planned = 100 → meets minimum
                graduationTargetTerm: "2027-spring",
            }),
        };

        const result = runGraduationPathValidator(args);

        // Core assertion: Axis 1 must FAIL (placeholder does not satisfy the requirement)
        expect(result.axisResults.requirementGroupsSatisfied.status).toBe("fail");
        expect(result.feasible).toBe(false);

        // Derived state must be infeasible-draft
        const state = derivePlanStateFromValidator(result, plan);
        expect(state).toBe("infeasible-draft");
    });

    /**
     * Counterpoint: a specific_planned slot (bound) DOES satisfy the requirement.
     * Verifies the fix doesn't over-correct and break the happy path.
     */
    it("requirementGroupsSatisfied passes when satisfier is a bound specific_planned slot", () => {
        const dpr = makeBaseDpr({
            requirementGroups: [
                {
                    rgId: "RG-CONTRACT",
                    title: "Contract Test Group",
                    status: "not_satisfied",
                    statusText: "Not Satisfied",
                    children: [
                        {
                            rId: "R-CONTRACT/10",
                            title: "Required Contract Course",
                            status: "not_satisfied",
                            statusText: "Not Satisfied",
                            coursesUsed: [],
                        },
                    ],
                },
            ],
        });

        const plan = makeBasePlan({
            semesters: [
                makeSemester("2026-fall", 4, [
                    {
                        kind: "specific_planned",
                        courseId: "MATH-UA 123",
                        title: "Contract Course",
                        credits: 4,
                        satisfiesRules: ["R-CONTRACT/10"],
                        reason: "Required",
                        rationale: {
                            satisfiesRequirements: ["R-CONTRACT/10"],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2026-fall",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",
                        workloadWeight: 1.0,
                        bindingState: "bound",  // BOUND
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                ]),
            ],
        });

        const args: GraduationPathValidatorArgs = {
            plan,
            dpr,
            programRules: makeProgramRules({
                residencyMinCredits: 64,
                majorCreditMinimum: null,
                degreeCreditMinimum: 100,
                graduationTargetTerm: "2027-spring",
            }),
        };

        const result = runGraduationPathValidator(args);
        expect(result.axisResults.requirementGroupsSatisfied.status).toBe("pass");
    });
});

// ---------------------------------------------------------------------------
// Contract 3 — unbound placeholders do NOT count toward major-credit floor
// ---------------------------------------------------------------------------

describe("PLAN-4 Contract 3: unbound placeholders excluded from major-credit total (Fix 1)", () => {
    /**
     * Setup:
     *   - programRules.majorCreditMinimum = 32 (non-null → must be checked)
     *   - Plan has semesters whose ONLY major-tier slots are UNBOUND placeholders
     *     (kind: "placeholder", workloadTier: "major-required", credits: 4 each × 8 = 32)
     *   - No specific_planned major slots exist at all
     *   - residencyMinCredits = null (skip residency check; isolate the major-credit axis)
     *
     * Before Fix 1: placeholder credits were counted (|| slot.kind === "placeholder"),
     *   so 8 × 4 = 32 >= 32 → thresholdsMet would pass. BUG.
     * After Fix 1: only specific_planned counts → 0 credits < 32 → thresholdsMet FAILS.
     */
    it("thresholdsMet does NOT pass when only major-tier slots are unbound placeholders", () => {
        const dpr = makeBaseDpr({
            requirementGroups: [],  // no unmet requirements — isolate Axis 4
            cumulative: {
                creditsRequired: 128,
                creditsUsed: 96,
                cumulativeGpa: 3.4,
                cumulativeGpaRequired: 2.0,
                residencyRequired: null,
                residencyUsed: null,
                passFailUsedUnits: 4,
                passFailCapUnits: 32,
                outsideHomeUsedUnits: 0,
                outsideHomeCapUnits: 16,
                timeLimitYears: 8,
            },
        });

        // Build 8 unbound placeholder slots with major-required tier (8 × 4 = 32 credits)
        const makeMajorPlaceholder = (id: string, term: string) => ({
            kind: "placeholder" as const,
            category: "major-required",
            credits: 4,
            satisfiesRules: [],
            optional: false,
            reason: "Major requirement placeholder",
            rationale: {
                satisfiesRequirements: [],
                termConstraints: [],
                consideredAlternatives: [],
                decisionsApplied: [],
            },
            flexibility: {
                earliestPossibleTerm: term,
                latestPossibleTerm: "2027-spring",
                alternativeCourses: [],
            },
            downstreamImpact: { courseIds: [], graduationDelay: 0 },
            workloadTier: "major-required" as const,
            workloadWeight: 1.0,
            bindingState: "placeholder-pending" as const,  // UNBOUND
            placeholderId: id,
            confidence: "historically_likely" as const,
            isCriticalPath: false,
        });

        const plan = makeBasePlan({
            semesters: [
                makeSemester("2026-fall", 16, [
                    makeMajorPlaceholder("PH-MAJ-1", "2026-fall"),
                    makeMajorPlaceholder("PH-MAJ-2", "2026-fall"),
                    makeMajorPlaceholder("PH-MAJ-3", "2026-fall"),
                    makeMajorPlaceholder("PH-MAJ-4", "2026-fall"),
                ]),
                makeSemester("2027-spring", 16, [
                    makeMajorPlaceholder("PH-MAJ-5", "2027-spring"),
                    makeMajorPlaceholder("PH-MAJ-6", "2027-spring"),
                    makeMajorPlaceholder("PH-MAJ-7", "2027-spring"),
                    makeMajorPlaceholder("PH-MAJ-8", "2027-spring"),
                ]),
            ],
        });

        const args: GraduationPathValidatorArgs = {
            plan,
            dpr,
            programRules: makeProgramRules({
                // residencyMinCredits must be non-null (and already met by DPR) so the
                // function doesn't short-circuit to "requires-approval" before reaching
                // the major-credit check. The DPR has residencyUsed = null here, so we
                // set residencyMinCredits = 0 (floor trivially met by 0 planned residency).
                residencyMinCredits: 0,
                majorCreditMinimum: 32,       // 8 × 4 = 32 placeholder credits — must NOT satisfy this
                degreeCreditMinimum: 112,     // 96 + 32 = 128 > 112 → total-credits axis passes
                graduationTargetTerm: "2027-spring",
            }),
        };

        const result = runGraduationPathValidator(args);

        // After Fix 1: unbound placeholders do NOT count → 0 planned major credits < 32 → FAIL
        expect(result.axisResults.thresholdsMet.status).toBe("fail");
        if (result.axisResults.thresholdsMet.status === "fail") {
            expect(result.axisResults.thresholdsMet.reason).toMatch(/major/i);
        }
        expect(result.feasible).toBe(false);
    });

    /**
     * Counterpoint: a mix of bound specific_planned (major-tier) + unbound
     * placeholders (major-tier), where the specific_planned slots alone meet
     * the floor — should PASS (placeholders don't help, but bound slots do).
     */
    it("thresholdsMet passes when specific_planned major credits alone meet the floor (placeholders ignored)", () => {
        const dpr = makeBaseDpr({
            requirementGroups: [],
            cumulative: {
                creditsRequired: 128,
                creditsUsed: 96,
                cumulativeGpa: 3.4,
                cumulativeGpaRequired: 2.0,
                residencyRequired: null,
                residencyUsed: null,
                passFailUsedUnits: 4,
                passFailCapUnits: 32,
                outsideHomeUsedUnits: 0,
                outsideHomeCapUnits: 16,
                timeLimitYears: 8,
            },
        });

        const makeBoundMajorSlot = (courseId: string) => ({
            kind: "specific_planned" as const,
            courseId,
            title: `Major Course ${courseId}`,
            credits: 4,
            satisfiesRules: [],
            reason: "Major required",
            rationale: {
                satisfiesRequirements: [],
                termConstraints: [],
                consideredAlternatives: [],
                decisionsApplied: [],
            },
            flexibility: {
                earliestPossibleTerm: "2026-fall",
                latestPossibleTerm: "2027-spring",
                alternativeCourses: [],
            },
            downstreamImpact: { courseIds: [], graduationDelay: 0 },
            workloadTier: "major-required" as const,
            workloadWeight: 1.0,
            bindingState: "bound" as const,
            confidence: "historically_likely" as const,
            isCriticalPath: false,
        });

        const plan = makeBasePlan({
            semesters: [
                makeSemester("2026-fall", 16, [
                    makeBoundMajorSlot("ECON-UA 1"),
                    makeBoundMajorSlot("ECON-UA 2"),
                    makeBoundMajorSlot("ECON-UA 3"),
                    makeBoundMajorSlot("ECON-UA 4"),  // 4 × 4 = 16 bound credits
                ]),
                makeSemester("2027-spring", 20, [
                    makeBoundMajorSlot("ECON-UA 5"),
                    makeBoundMajorSlot("ECON-UA 6"),
                    makeBoundMajorSlot("ECON-UA 7"),
                    makeBoundMajorSlot("ECON-UA 8"),  // 4 × 4 = 16 bound credits (total = 32)
                    // 1 unbound placeholder: should be ignored by the reducer
                    {
                        kind: "placeholder" as const,
                        category: "major-elective",
                        credits: 4,
                        satisfiesRules: [],
                        optional: false,
                        reason: "Extra major elective",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2027-spring",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-elective" as const,
                        workloadWeight: 0.8,
                        bindingState: "placeholder-pending" as const,
                        placeholderId: "PH-EXTRA",
                        confidence: "historically_likely" as const,
                        isCriticalPath: false,
                    },
                ]),
            ],
        });

        const args: GraduationPathValidatorArgs = {
            plan,
            dpr,
            programRules: makeProgramRules({
                // residencyMinCredits = 0 so the residency check passes trivially
                // (0 >= 0), allowing execution to reach the major-credit check.
                residencyMinCredits: 0,
                majorCreditMinimum: 32,       // 8 bound × 4 = 32 → exactly meets floor
                degreeCreditMinimum: 112,
                graduationTargetTerm: "2027-spring",
            }),
        };

        const result = runGraduationPathValidator(args);
        // 32 bound major credits >= 32 minimum → should pass (placeholder ignored)
        expect(result.axisResults.thresholdsMet.status).toBe("pass");
    });
});

// ---------------------------------------------------------------------------
// Contract 2 — majorCreditMinimum floor actually checked when non-null
// ---------------------------------------------------------------------------

describe("PLAN-4 Contract 2: majorCreditMinimum floor is enforced when set", () => {
    /**
     * Setup:
     *   - programRules.majorCreditMinimum = 32 (non-null → must be checked)
     *   - Plan has 0 major-tier slots (no specific_planned or placeholder with
     *     workloadTier = "major-required" or "major-elective")
     *   - Axis 4 must FAIL with a reason containing "major"
     *
     * Before the de-null-gate fix, this would pass (the `if (majorMin !== null)`
     * check was there, but majorMin was always null from build.ts, so the
     * check never ran).
     */
    it("thresholdsMet fails when planned major credits are below majorCreditMinimum", () => {
        const dpr = makeBaseDpr({
            requirementGroups: [],  // no unmet requirements (isolate Axis 4)
            cumulative: {
                creditsRequired: 128,
                creditsUsed: 96,
                cumulativeGpa: 3.4,
                cumulativeGpaRequired: 2.0,
                residencyRequired: null,  // skip residency check
                residencyUsed: null,
                passFailUsedUnits: 4,
                passFailCapUnits: 32,
                outsideHomeUsedUnits: 0,
                outsideHomeCapUnits: 16,
                timeLimitYears: 8,
            },
        });

        // Plan with slots that are NOT major-tier
        const plan = makeBasePlan({
            semesters: [
                makeSemester("2026-fall", 16, [
                    {
                        kind: "specific_planned",
                        courseId: "CORE-UA 001",
                        title: "Texts and Ideas",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Free elective",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2026-fall",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "free-elective",  // NOT major-required or major-elective
                        workloadWeight: 0.5,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                ]),
                makeSemester("2027-spring", 16, []),
            ],
        });

        const args: GraduationPathValidatorArgs = {
            plan,
            dpr,
            programRules: makeProgramRules({
                residencyMinCredits: null,   // skip residency
                majorCreditMinimum: 32,      // requires 32 major credits; plan has 0
                degreeCreditMinimum: 112,    // 96 + 16 + 16 = 128 > 112 → credits axis passes
                graduationTargetTerm: "2027-spring",
            }),
        };

        const result = runGraduationPathValidator(args);

        // Axis 4 must FAIL because 0 planned major credits < 32 minimum
        expect(result.axisResults.thresholdsMet.status).toBe("fail");
        if (result.axisResults.thresholdsMet.status === "fail") {
            expect(result.axisResults.thresholdsMet.reason).toMatch(/major/i);
        }
        expect(result.feasible).toBe(false);
    });

    /**
     * Counterpoint: plan MEETS both residencyMinCredits AND majorCreditMinimum → Axis 4 passes.
     * Both must be non-null and met for a clean pass (null → requires-approval per fix).
     */
    it("thresholdsMet passes when both residency and major credit minimums are set and met", () => {
        const dpr = makeBaseDpr({
            requirementGroups: [],
            cumulative: {
                creditsRequired: 128,
                creditsUsed: 96,
                cumulativeGpa: 3.4,
                cumulativeGpaRequired: 2.0,
                residencyRequired: 32,
                residencyUsed: 32,  // residency already met in DPR
                passFailUsedUnits: 4,
                passFailCapUnits: 32,
                outsideHomeUsedUnits: 0,
                outsideHomeCapUnits: 16,
                timeLimitYears: 8,
            },
        });

        const plan = makeBasePlan({
            semesters: [
                makeSemester("2026-fall", 16, [
                    {
                        kind: "specific_planned",
                        courseId: "CSCI-UA 480",
                        title: "Advanced CS",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Major elective",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2026-fall",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-elective",  // counts toward major
                        workloadWeight: 0.9,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                    {
                        kind: "specific_planned",
                        courseId: "CSCI-UA 310",
                        title: "Basic Algorithms",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Major required",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2026-fall",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",  // counts toward major
                        workloadWeight: 1.0,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                    {
                        kind: "specific_planned",
                        courseId: "CSCI-UA 420",
                        title: "Parallel Computing",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Major required",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2026-fall",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",
                        workloadWeight: 1.0,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                    {
                        kind: "specific_planned",
                        courseId: "CSCI-UA 490",
                        title: "Honors Thesis",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Major required",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2026-fall",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",
                        workloadWeight: 1.0,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                ]),
                makeSemester("2027-spring", 16, [
                    // 4 more major-required slots (4 + 4 + 4 + 4 + 4*4 = 32 total major credits)
                    {
                        kind: "specific_planned",
                        courseId: "CSCI-UA 453",
                        title: "Theory of Computation",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Major required",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2027-spring",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",
                        workloadWeight: 1.0,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                    {
                        kind: "specific_planned",
                        courseId: "CSCI-UA 473",
                        title: "Fundamentals of Machine Learning",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Major required",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2027-spring",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",
                        workloadWeight: 1.0,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                    {
                        kind: "specific_planned",
                        courseId: "CSCI-UA 467",
                        title: "Responsible Data Science",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Major required",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2027-spring",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",
                        workloadWeight: 1.0,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                    {
                        kind: "specific_planned",
                        courseId: "CSCI-UA 460",
                        title: "Artificial Intelligence",
                        credits: 4,
                        satisfiesRules: [],
                        reason: "Major required",
                        rationale: {
                            satisfiesRequirements: [],
                            termConstraints: [],
                            consideredAlternatives: [],
                            decisionsApplied: [],
                        },
                        flexibility: {
                            earliestPossibleTerm: "2027-spring",
                            latestPossibleTerm: "2027-spring",
                            alternativeCourses: [],
                        },
                        downstreamImpact: { courseIds: [], graduationDelay: 0 },
                        workloadTier: "major-required",
                        workloadWeight: 1.0,
                        bindingState: "bound",
                        confidence: "historically_likely",
                        isCriticalPath: false,
                    },
                ]),
            ],
        });

        // 4 slots * 4 credits each in fall + 4 slots * 4 credits in spring = 32 total major credits.
        // residencyMinCredits = 32 and residencyUsed = 32 → residency met (0 planned residency needed).
        // majorCreditMinimum = 32 → exactly meets via specific_planned major slots.
        // Both non-null thresholds are met → should pass.
        const args: GraduationPathValidatorArgs = {
            plan,
            dpr,
            programRules: makeProgramRules({
                residencyMinCredits: 32,  // non-null, met by DPR residencyUsed=32
                majorCreditMinimum: 32,   // non-null, met by 32 major-tier planned credits
                degreeCreditMinimum: 112,
                graduationTargetTerm: "2027-spring",
            }),
        };

        const result = runGraduationPathValidator(args);
        expect(result.axisResults.thresholdsMet.status).toBe("pass");
    });

    /**
     * Null majorCreditMinimum → should NOT produce a silent pass with no
     * accountability. After the de-null-gate fix, null thresholds for
     * residency/major that we expect to be present should return
     * "requires-approval", flowing to "valid-with-trade-offs".
     *
     * This test asserts the specific expected behavior: when majorCreditMinimum
     * IS present and non-null, the check fires. When null, the status must NOT
     * be "fail" (so the plan isn't wrongly infeasible), but it MUST NOT be a
     * silent "pass" that hides the missing floor — it should be "requires-approval"
     * or the overall state should be "valid-with-trade-offs" or better.
     *
     * Per spec: "When a threshold is ABSENT (null) AND it's an axis we expect
     * (residency/major), do NOT silently pass — return requires-approval."
     */
    it("thresholdsMet returns requires-approval (not silent pass) when majorCreditMinimum is null", () => {
        const dpr = makeBaseDpr({
            requirementGroups: [],
            cumulative: {
                creditsRequired: 128,
                creditsUsed: 96,
                cumulativeGpa: 3.4,
                cumulativeGpaRequired: 2.0,
                residencyRequired: null,  // also null to isolate the test
                residencyUsed: null,
                passFailUsedUnits: 4,
                passFailCapUnits: 32,
                outsideHomeUsedUnits: 0,
                outsideHomeCapUnits: 16,
                timeLimitYears: 8,
            },
        });

        const plan = makeBasePlan({
            semesters: [
                makeSemester("2026-fall", 16, []),
                makeSemester("2027-spring", 16, []),
            ],
        });

        const args: GraduationPathValidatorArgs = {
            plan,
            dpr,
            programRules: makeProgramRules({
                residencyMinCredits: null,
                majorCreditMinimum: null,  // threshold unknown
                degreeCreditMinimum: 112,
                graduationTargetTerm: "2027-spring",
            }),
        };

        const result = runGraduationPathValidator(args);

        // After the fix: null thresholds → requires-approval, NOT silent pass
        expect(result.axisResults.thresholdsMet.status).toBe("requires-approval");
        // Plan must not be infeasible (requires-approval ≠ fail)
        expect(result.feasible).toBe(true);
    });
});
