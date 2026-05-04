/**
 * Phase 14 Task 3 — Solver load-style ordering + pins + exclusions tests.
 *
 * Decisions covered: #9, #10, #11, #26 partial, #31
 *
 * 7 test cases per the Phase 14 Task 3 spec.
 */

import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { SchedulePreferences } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Minimal DPR fixture (copied from forwardScheduleSolver.test.ts)
// ---------------------------------------------------------------------------

function makeMinimalDpr(): import("../../src/dpr/schema.js").DegreeProgressReport {
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
    };
}

// ---------------------------------------------------------------------------
// makeInput factory — extends the base factory with preferences support
// ---------------------------------------------------------------------------

function makeInput(
    prefs: SchedulePreferences = {},
    overrides: Partial<SolverInput> = {},
): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(),
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
        preferences: prefs,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Load styles
// ---------------------------------------------------------------------------

describe("solveForwardSchedule — load styles", () => {
    it("frontload places hard requirements in the EARLIEST term first", () => {
        const input = makeInput(
            { loadStyle: "frontload" },
            {
                unmetRequirements: [
                    {
                        rId: "r1",
                        title: "X",
                        category: "cs_major_required",
                        credits: 4,
                        candidateCourses: ["CSCI-UA X"],
                    },
                ],
                offerings: new Map([["CSCI-UA X", ["fall", "spring"]]]),
                courseCatalog: new Map([["CSCI-UA X", { title: "X", credits: 4 }]]),
            },
        );
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        expect(
            fall.slots.some(s => s.kind === "specific_planned" && "courseId" in s && s.courseId === "CSCI-UA X"),
        ).toBe(true);
    });

    it("backload places hard requirements in the LATEST term", () => {
        const input = makeInput(
            { loadStyle: "backload" },
            {
                unmetRequirements: [
                    {
                        rId: "r1",
                        title: "X",
                        category: "cs_major_required",
                        credits: 4,
                        candidateCourses: ["CSCI-UA X"],
                    },
                ],
                offerings: new Map([["CSCI-UA X", ["fall", "spring"]]]),
                courseCatalog: new Map([["CSCI-UA X", { title: "X", credits: 4 }]]),
            },
        );
        const out = solveForwardSchedule(input);
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        expect(
            spring.slots.some(s => s.kind === "specific_planned" && "courseId" in s && s.courseId === "CSCI-UA X"),
        ).toBe(true);
    });

    it("loadStylePerTerm 'light' pulls credit target down to F-1 floor (12)", () => {
        // F-1 student with f1Floor=12. "light" for 2027-spring should cap
        // free-elective fill at 12 credits (f1Floor), not 16 (default target).
        const input = makeInput(
            { loadStylePerTerm: { "2027-spring": "light" } },
            {
                unmetRequirements: [],
                // No hard requirements — all slots will be free-elective placeholders.
            },
        );
        const out = solveForwardSchedule(input);
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        // With light load the fill loop should stop at 12 credits (F-1 floor),
        // not 16.
        expect(spring.plannedCredits).toBe(12);
    });

    it("loadStylePerTerm 'heavy' pushes credit target up to school ceiling (18)", () => {
        const input = makeInput(
            { loadStylePerTerm: { "2027-spring": "heavy" } },
            {
                unmetRequirements: [],
            },
        );
        const out = solveForwardSchedule(input);
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        // With heavy load the fill loop should go up to 18 (ceiling).
        expect(spring.plannedCredits).toBe(18);
    });
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

describe("solveForwardSchedule — pins", () => {
    it("places a pinned course in the pinned term as a hard placement", () => {
        const input = makeInput(
            { pins: [{ courseId: "CSCI-UA X", term: "2026-fall" }] },
            {
                unmetRequirements: [
                    {
                        rId: "r1",
                        title: "X",
                        category: "cs_major_required",
                        credits: 4,
                        candidateCourses: ["CSCI-UA X"],
                    },
                ],
                offerings: new Map([["CSCI-UA X", ["fall", "spring"]]]),
                courseCatalog: new Map([["CSCI-UA X", { title: "X", credits: 4 }]]),
            },
        );
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        expect(
            fall.slots.some(
                s => s.kind === "specific_planned" && "courseId" in s && s.courseId === "CSCI-UA X",
            ),
        ).toBe(true);
    });

    it("flags a violation when the pinned term doesn't match the offering pattern", () => {
        const input = makeInput(
            { pins: [{ courseId: "CSCI-UA 421", term: "2026-fall" }] },
            {
                unmetRequirements: [
                    {
                        rId: "r1",
                        title: "421",
                        category: "cs_major_required",
                        credits: 4,
                        candidateCourses: ["CSCI-UA 421"],
                    },
                ],
                offerings: new Map([["CSCI-UA 421", ["spring"]]]), // spring-only
                courseCatalog: new Map([
                    ["CSCI-UA 421", { title: "Software Engineering", credits: 4 }],
                ]),
            },
        );
        const out = solveForwardSchedule(input);
        expect(
            out.feasibility.constraintViolations.some(v =>
                /offering_pattern|pin_conflict/.test(v.kind),
            ),
        ).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

describe("solveForwardSchedule — exclusions", () => {
    it("does NOT place a course present in exclusions", () => {
        const input = makeInput(
            { exclusions: [{ courseId: "CSCI-UA 421" }] },
            {
                unmetRequirements: [
                    {
                        rId: "r1",
                        title: "421",
                        category: "cs_major_required",
                        credits: 4,
                        candidateCourses: ["CSCI-UA 421"],
                    },
                ],
                offerings: new Map([["CSCI-UA 421", ["fall", "spring"]]]),
                courseCatalog: new Map([
                    ["CSCI-UA 421", { title: "Software Engineering", credits: 4 }],
                ]),
            },
        );
        const out = solveForwardSchedule(input);
        const placed = out.semesters
            .flatMap(s => s.slots)
            .find(s => "courseId" in s && s.courseId === "CSCI-UA 421");
        expect(placed).toBeUndefined();
    });
});
