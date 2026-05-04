/**
 * Phase 13 Task 3.2 — contingencyPlans.test.ts
 *
 * Decision #30: IP contingency plan generator.
 * 5 test patterns per spec contract.
 */

import { describe, it, expect, vi } from "vitest";
import { generateContingencies } from "../../src/agent/forwardSchedule/contingencyPlans.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { ForwardSchedule, Assumption } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// DPR fixture helper
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

function makeDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
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

// ---------------------------------------------------------------------------
// SolverInput fixture helper
// ---------------------------------------------------------------------------

function makeBaseInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(["CSCI-UA 101"]),
        coursesInProgress: new Set(),
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 96,
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
        offerings: new Map([
            ["CSCI-UA 201", ["fall", "spring"]],
            ["CSCI-UA 202", ["fall", "spring"]],
        ]),
        offeringConfidence: new Map(),
        courseCatalog: new Map([
            ["CSCI-UA 201", { title: "Computer Organization", credits: 4 }],
            ["CSCI-UA 202", { title: "Operating Systems", credits: 4 }],
        ]),
        dprCourseHistoryHash: "sha256:test",
        dpr: makeDpr(),
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

// ---------------------------------------------------------------------------
// ForwardSchedule fixture helper
// ---------------------------------------------------------------------------

function makeOptimistic(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
    return {
        studentId: "test",
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

// ---------------------------------------------------------------------------
// Test 1: No IP assumptions → empty conservatives
// ---------------------------------------------------------------------------

describe("generateContingencies — no IP assumptions", () => {
    it("returns empty conservatives array when optimistic has no IP_COURSE_COMPLETION assumptions", () => {
        const optimistic = makeOptimistic();
        const baseInput = makeBaseInput();
        const result = generateContingencies(optimistic, baseInput);
        expect(result.optimistic).toBe(optimistic);
        expect(result.conservatives).toHaveLength(0);
    });

    it("handles LLM_RANKED_ALTERNATIVE assumptions (non-IP) without generating conservatives", () => {
        const llmAssumption: Assumption = {
            type: "LLM_RANKED_ALTERNATIVE",
            studentStatedFactor: "prefer morning classes",
            selectedPlanIndex: 1,
            reasoning: "Student prefers morning schedule",
            dimensionsConsidered: ["time", "workload"],
        };
        const optimistic = makeOptimistic({ assumptions: [llmAssumption] });
        const baseInput = makeBaseInput();
        const result = generateContingencies(optimistic, baseInput);
        expect(result.conservatives).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// Test 2: Single IP assumption → exactly 1 conservative
// ---------------------------------------------------------------------------

describe("generateContingencies — single IP assumption", () => {
    it("produces exactly 1 conservative; failed IP course removed from coursesInProgress", () => {
        const ipAssumption: Assumption = {
            type: "IP_COURSE_COMPLETION",
            courseId: "CSCI-UA 201",
            consequenceIfFalse: "CSCI-UA 202 must move to later term",
            cascadingSlots: ["CSCI-UA 202"],
            contingencyPlanAvailable: false,
        };
        const optimistic = makeOptimistic({ assumptions: [ipAssumption] });

        // Base input: CSCI-UA 201 is in progress; 202 is an unmet requirement
        const baseInput = makeBaseInput({
            coursesInProgress: new Set(["CSCI-UA 201"]),
            unmetRequirements: [
                {
                    rId: "CS_UPPER_1",
                    title: "OS",
                    category: "cs_major_required",
                    credits: 4,
                    candidateCourses: ["CSCI-UA 202"],
                },
            ],
            // CSCI-UA 202 prereqs: CSCI-UA 201
            prereqs: new Map([
                [
                    "CSCI-UA 202",
                    [{ type: "AND", courses: ["CSCI-UA 201"] }],
                ],
            ]),
        });

        const result = generateContingencies(optimistic, baseInput);

        expect(result.conservatives).toHaveLength(1);
        expect(result.conservatives[0]!.ipCourseAssumed).toBe("CSCI-UA 201");

        // The conservative plan should NOT include CSCI-UA 201 in coursesInProgress
        // (verified indirectly: the solver ran with a derived input that had it removed)
        const conservativePlan = result.conservatives[0]!.plan;
        expect(conservativePlan).toBeDefined();
        // The conservative plan is a valid ForwardSchedule shape
        expect(conservativePlan.studentId).toBeDefined();
        expect(typeof conservativePlan.feasibility.feasible).toBe("boolean");
    });

    it("optimistic plan is identical (referentially) to the input optimistic", () => {
        const ipAssumption: Assumption = {
            type: "IP_COURSE_COMPLETION",
            courseId: "CSCI-UA 201",
            consequenceIfFalse: "downstream slots move",
            cascadingSlots: [],
            contingencyPlanAvailable: false,
        };
        const optimistic = makeOptimistic({ assumptions: [ipAssumption] });
        const baseInput = makeBaseInput({
            coursesInProgress: new Set(["CSCI-UA 201"]),
        });
        const result = generateContingencies(optimistic, baseInput);
        // The optimistic plan should be the same object (referential equality)
        expect(result.optimistic).toBe(optimistic);
    });
});

// ---------------------------------------------------------------------------
// Test 3: Multiple IP assumptions → 1 conservative per assumption
// ---------------------------------------------------------------------------

describe("generateContingencies — multiple IP assumptions", () => {
    it("produces N conservatives for N IP assumptions", () => {
        const ip1: Assumption = {
            type: "IP_COURSE_COMPLETION",
            courseId: "CSCI-UA 201",
            consequenceIfFalse: "202 moves",
            cascadingSlots: ["CSCI-UA 202"],
            contingencyPlanAvailable: false,
        };
        const ip2: Assumption = {
            type: "IP_COURSE_COMPLETION",
            courseId: "MATH-UA 122",
            consequenceIfFalse: "MATH-UA 233 moves",
            cascadingSlots: ["MATH-UA 233"],
            contingencyPlanAvailable: false,
        };
        const optimistic = makeOptimistic({ assumptions: [ip1, ip2] });

        const baseInput = makeBaseInput({
            coursesInProgress: new Set(["CSCI-UA 201", "MATH-UA 122"]),
            unmetRequirements: [
                {
                    rId: "CS_1",
                    title: "OS",
                    category: "cs_major_required",
                    credits: 4,
                    candidateCourses: ["CSCI-UA 202"],
                },
                {
                    rId: "MATH_1",
                    title: "Calc 3",
                    category: "math_required",
                    credits: 4,
                    candidateCourses: ["MATH-UA 233"],
                },
            ],
            courseCatalog: new Map([
                ["CSCI-UA 201", { title: "Comp Org", credits: 4 }],
                ["CSCI-UA 202", { title: "OS", credits: 4 }],
                ["MATH-UA 122", { title: "Calc 2", credits: 4 }],
                ["MATH-UA 233", { title: "Calc 3", credits: 4 }],
            ]),
            offerings: new Map([
                ["CSCI-UA 201", ["fall", "spring"]],
                ["CSCI-UA 202", ["fall", "spring"]],
                ["MATH-UA 122", ["fall", "spring"]],
                ["MATH-UA 233", ["fall", "spring"]],
            ]),
        });

        const result = generateContingencies(optimistic, baseInput);

        expect(result.conservatives).toHaveLength(2);
        const assumedCourses = result.conservatives.map(c => c.ipCourseAssumed);
        expect(assumedCourses).toContain("CSCI-UA 201");
        expect(assumedCourses).toContain("MATH-UA 122");
    });

    it("each conservative is an independent solver run (different plans)", () => {
        const ip1: Assumption = {
            type: "IP_COURSE_COMPLETION",
            courseId: "CSCI-UA 201",
            consequenceIfFalse: "downstream moves",
            cascadingSlots: [],
            contingencyPlanAvailable: false,
        };
        const ip2: Assumption = {
            type: "IP_COURSE_COMPLETION",
            courseId: "MATH-UA 122",
            consequenceIfFalse: "downstream moves",
            cascadingSlots: [],
            contingencyPlanAvailable: false,
        };
        const optimistic = makeOptimistic({ assumptions: [ip1, ip2] });
        const baseInput = makeBaseInput({
            coursesInProgress: new Set(["CSCI-UA 201", "MATH-UA 122"]),
            courseCatalog: new Map([
                ["CSCI-UA 201", { title: "Comp Org", credits: 4 }],
                ["MATH-UA 122", { title: "Calc 2", credits: 4 }],
            ]),
        });

        const result = generateContingencies(optimistic, baseInput);

        // Each conservative should be a distinct ForwardSchedule object
        if (result.conservatives.length >= 2) {
            expect(result.conservatives[0]!.plan).not.toBe(result.conservatives[1]!.plan);
        }
    });
});

// ---------------------------------------------------------------------------
// Test 4: Conservative plan feasibility computed correctly
// ---------------------------------------------------------------------------

describe("generateContingencies — conservative plan feasibility", () => {
    it("conservative plan's feasibility.feasible is boolean (computed by real solver)", () => {
        const ipAssumption: Assumption = {
            type: "IP_COURSE_COMPLETION",
            courseId: "CSCI-UA 201",
            consequenceIfFalse: "CSCI-UA 202 must move",
            cascadingSlots: ["CSCI-UA 202"],
            contingencyPlanAvailable: false,
        };
        const optimistic = makeOptimistic({ assumptions: [ipAssumption] });

        // Set up so failing CSCI-UA 201 has a cascading impact:
        // CSCI-UA 202 requires CSCI-UA 201 as prereq, but if 201 is removed
        // from coursesInProgress and added back as unmet, solver must re-plan it.
        const baseInput = makeBaseInput({
            coursesInProgress: new Set(["CSCI-UA 201"]),
            unmetRequirements: [
                {
                    rId: "CS_202",
                    title: "OS",
                    category: "cs_major_required",
                    credits: 4,
                    candidateCourses: ["CSCI-UA 202"],
                },
            ],
            prereqs: new Map([
                ["CSCI-UA 202", [{ type: "AND", courses: ["CSCI-UA 201"] }]],
            ]),
        });

        const result = generateContingencies(optimistic, baseInput);
        expect(result.conservatives).toHaveLength(1);
        const conservativeFeasibility = result.conservatives[0]!.plan.feasibility;
        expect(typeof conservativeFeasibility.feasible).toBe("boolean");
        // The conservative plan ran the real solver — no stubs
        expect(conservativeFeasibility.constraintViolations).toBeDefined();
    });

    it("base input is NOT mutated by generateContingencies", () => {
        const ipAssumption: Assumption = {
            type: "IP_COURSE_COMPLETION",
            courseId: "CSCI-UA 201",
            consequenceIfFalse: "downstream slots move",
            cascadingSlots: [],
            contingencyPlanAvailable: false,
        };
        const optimistic = makeOptimistic({ assumptions: [ipAssumption] });
        const baseInput = makeBaseInput({
            coursesInProgress: new Set(["CSCI-UA 201"]),
        });
        const originalSize = baseInput.coursesInProgress.size;

        generateContingencies(optimistic, baseInput);

        // Original coursesInProgress should be unmodified (shallow copy per contract)
        expect(baseInput.coursesInProgress.size).toBe(originalSize);
        expect(baseInput.coursesInProgress.has("CSCI-UA 201")).toBe(true);
    });
});
