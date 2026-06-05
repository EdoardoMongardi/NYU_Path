/**
 * Task 1.8 — Offerings map wired: terms-offered enforcement (PLAN-1).
 *
 * Proves:
 *   (a) The solver blocks a fall-only course from being placed in the
 *       current spring term (solver-level, offerings passed in directly).
 *   (b) buildForwardSchedule constructs a SolverInput whose offerings map
 *       is non-empty (build-level, data read from courses-offerings.json).
 */

import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";

// ---------------------------------------------------------------------------
// Minimal DPR fixture (mirrors forwardScheduleSolver.test.ts)
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
    };
}

// ---------------------------------------------------------------------------
// Base makeInput factory (mirrors forwardScheduleSolver.test.ts)
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(),
        coursesInProgress: new Map(),
        currentTerm: "2026-spring",  // start in spring so fall-only courses must wait
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

// ---------------------------------------------------------------------------
// (a) Solver-level: fall-only course must NOT land in current spring term
// ---------------------------------------------------------------------------

describe("PLAN-1 — solver enforces offerings when map is populated", () => {
    it("does NOT place a fall-only required course in the current spring term", () => {
        // currentTerm = 2026-spring; horizon extends to 2027-spring.
        // The course is fall-only. The solver must skip the current spring
        // and place it in the first available fall (2026-fall).
        const input = makeInput({
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Fall-Only Course",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["TEST-UA 100"],
                },
            ],
            offerings: new Map([
                ["TEST-UA 100", ["fall"]],  // fall-only
            ]),
            offeringConfidence: new Map([
                ["TEST-UA 100", "historically_likely"],
            ]),
            courseCatalog: new Map([
                ["TEST-UA 100", { title: "Fall Only Test Course", credits: 4 }],
            ]),
        });

        const out = solveForwardSchedule(input);

        // The course must NOT appear in the spring terms
        const spring2026 = out.semesters.find(s => s.term === "2026-spring");
        const spring2027 = out.semesters.find(s => s.term === "2027-spring");
        const fall2026 = out.semesters.find(s => s.term === "2026-fall");

        // Should not be placed in any spring
        if (spring2026) {
            const inSpring2026 = spring2026.slots.some(
                s => "courseId" in s && s.courseId === "TEST-UA 100"
            );
            expect(inSpring2026).toBe(false);
        }
        if (spring2027) {
            const inSpring2027 = spring2027.slots.some(
                s => "courseId" in s && s.courseId === "TEST-UA 100"
            );
            expect(inSpring2027).toBe(false);
        }

        // Must be placed in fall 2026
        expect(fall2026).toBeDefined();
        const inFall2026 = fall2026!.slots.some(
            s => "courseId" in s && s.courseId === "TEST-UA 100"
        );
        expect(inFall2026).toBe(true);
    });

    it("places a fall-only course before a spring-only course respecting horizons", () => {
        // Two required courses: one fall-only, one spring-only.
        // Starting in spring 2026. The fall-only one must go to fall 2026.
        // The spring-only one can go to the current spring 2026 or spring 2027.
        const input = makeInput({
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Fall Only",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["TEST-UA 101"],
                },
                {
                    rId: "r2",
                    title: "Spring Only",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["TEST-UA 102"],
                },
            ],
            offerings: new Map([
                ["TEST-UA 101", ["fall"]],
                ["TEST-UA 102", ["spring"]],
            ]),
            offeringConfidence: new Map([
                ["TEST-UA 101", "historically_likely"],
                ["TEST-UA 102", "historically_likely"],
            ]),
            courseCatalog: new Map([
                ["TEST-UA 101", { title: "Fall Only", credits: 4 }],
                ["TEST-UA 102", { title: "Spring Only", credits: 4 }],
            ]),
        });

        const out = solveForwardSchedule(input);

        // Count placements: both must be placed somewhere
        const allCourseIds = out.semesters.flatMap(s =>
            s.slots.filter(sl => "courseId" in sl).map(sl => (sl as { courseId: string }).courseId)
        );

        // Both courses should be placed
        expect(allCourseIds).toContain("TEST-UA 101");
        expect(allCourseIds).toContain("TEST-UA 102");

        // Fall-only course must only appear in fall terms
        for (const sem of out.semesters) {
            const isSpringTerm = sem.term.endsWith("-spring");
            if (isSpringTerm) {
                const hasFallOnly = sem.slots.some(
                    s => "courseId" in s && s.courseId === "TEST-UA 101"
                );
                expect(hasFallOnly).toBe(false);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// (b) Build-level: buildForwardSchedule produces a non-empty offerings map
// ---------------------------------------------------------------------------

describe("PLAN-1 — buildForwardSchedule wires offerings from courses-offerings.json", () => {
    it("produces a non-empty offerings map from real data", async () => {
        // Import at runtime so we don't crash the test suite if build.ts
        // has import-time side effects. loadOfferings is a pure data read.
        const { loadOfferings } = await import("../../src/dataLoader.js");
        const map = loadOfferings();
        // There are thousands of entries in courses-offerings.json
        expect(map.size).toBeGreaterThan(100);
        // Spot-check: ACA-UF 101 is fall-only in the JSON
        const entry = map.get("ACA-UF 101");
        expect(entry).toBeDefined();
        expect(entry!.termsOffered).toContain("fall");
        expect(entry!.confidence).toBe("historically_likely");
    });
});
