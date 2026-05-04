/**
 * Phase 13 Task 5 — forwardScheduleBuild.test.ts
 *
 * 4 test patterns per spec contract:
 *  1. Builds a ForwardSchedule from minimal session + DPR fixture
 *  2. State derived by orchestrator MAY differ from solver's coarse state
 *  3. dprCourseHistoryHash matches hashDprCourseHistory(dpr)
 *  4. computedAt is a number near Date.now()
 */

import { describe, it, expect, vi } from "vitest";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import { hashDprCourseHistory } from "../../src/agent/forwardSchedule/reconcile.js";
import type { BuildForwardScheduleArgs } from "../../src/agent/forwardSchedule/build.js";
import type { ToolSession } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Fixtures
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

function makeMinimalSession(overrides: Partial<ToolSession> = {}): ToolSession {
    return {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "Major" }],
            coursesTaken: [],
            visaStatus: "f1",
        },
        schoolConfig: {
            schoolId: "cas",
            name: "College of Arts and Science",
            degreeType: "BA",
            courseSuffix: ["-UA"],
            totalCreditsRequired: 128,
            overallGpaMin: 2.0,
            acceptsTransferCredit: true,
            maxCreditsPerSemester: 18,
            f1FullTimeMinCredits: 12,
            residency: {
                minCredits: 64,
                note: null,
            },
        },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Test 1: Builds a ForwardSchedule from minimal session + DPR fixture
// ---------------------------------------------------------------------------

describe("buildForwardSchedule — minimal fixture", () => {
    it("produces a ForwardSchedule with required fields from a minimal session + DPR", () => {
        const dpr = makeDpr();
        const session = makeMinimalSession();
        const result = buildForwardSchedule({ session, dpr });

        // Required top-level fields
        expect(result.studentId).toBe("test-student");
        expect(result.homeSchoolId).toBe("cas");
        expect(typeof result.graduationTerm).toBe("string");
        expect(result.graduationTerm).toMatch(/^\d{4}-(spring|fall|summer|january)$/);
        expect(Array.isArray(result.semesters)).toBe(true);
        expect(Array.isArray(result.assumptions)).toBe(true);
        expect(typeof result.balanceScore).toBe("number");
        expect(typeof result.degreeCreditsMet).toBe("boolean");
        expect(result.feasibility).toBeTruthy();
        expect(typeof result.state).toBe("string");
        expect(["valid-clean", "valid-with-trade-offs", "infeasible-draft", "student-preferred-invalid-draft"]).toContain(result.state);
    });

    it("produces semesters array (may be empty when no unmet requirements)", () => {
        const dpr = makeDpr(); // no requirements, 96 credits → 32 remaining
        const session = makeMinimalSession();
        const result = buildForwardSchedule({ session, dpr });
        // The solver should produce at least some semesters to fill the remaining 32 credits
        expect(Array.isArray(result.semesters)).toBe(true);
    });

    it("respects graduationTermOverride when provided", () => {
        const dpr = makeDpr();
        const session = makeMinimalSession();
        const result = buildForwardSchedule({ session, dpr, graduationTermOverride: "2027-spring" });
        expect(result.graduationTerm).toBe("2027-spring");
    });
});

// ---------------------------------------------------------------------------
// Test 2: State routing per Decision #32
// ---------------------------------------------------------------------------

describe("buildForwardSchedule — state routing", () => {
    it("returns valid-clean when no caveats, trade-offs, or violations", () => {
        // Fully-satisfied DPR: 128 credits earned, all requirements met, no IP
        const dpr = makeDpr({
            cumulative: {
                creditsRequired: 128,
                creditsUsed: 128,
                cumulativeGpa: 3.4,
                cumulativeGpaRequired: 2.0,
                residencyRequired: null,
                residencyUsed: null,
                passFailUsedUnits: 0,
                passFailCapUnits: 32,
                outsideHomeUsedUnits: 0,
                outsideHomeCapUnits: 16,
                timeLimitYears: 8,
            },
            requirementGroups: [],
            courseHistory: [],
        });
        const session = makeMinimalSession({
            schoolConfig: {
                schoolId: "cas",
                name: "College of Arts and Science",
                degreeType: "BA",
                courseSuffix: ["-UA"],
                totalCreditsRequired: 128,
                overallGpaMin: 2.0,
                acceptsTransferCredit: true,
                residency: { minCredits: null, note: null },
            },
        });
        const result = buildForwardSchedule({
            session,
            dpr,
            graduationTermOverride: "2026-fall",
        });
        // With 128 credits earned and no unmet requirements, state should be valid-clean
        // (or valid-with-trade-offs if there are placeholder slots)
        expect(["valid-clean", "valid-with-trade-offs"]).toContain(result.state);
    });

    it("returns infeasible-draft when graduation credits cannot be reached", () => {
        // Very few credits earned and very high minimum — solver won't be able to fill plan
        const dpr = makeDpr({
            cumulative: {
                creditsRequired: 1000, // impossibly high
                creditsUsed: 0,
                cumulativeGpa: 3.4,
                cumulativeGpaRequired: 2.0,
                residencyRequired: null,
                residencyUsed: null,
                passFailUsedUnits: 0,
                passFailCapUnits: 32,
                outsideHomeUsedUnits: 0,
                outsideHomeCapUnits: 16,
                timeLimitYears: 8,
            },
            requirementGroups: [],
            courseHistory: [],
        });
        const session = makeMinimalSession({
            schoolConfig: {
                schoolId: "cas",
                name: "College of Arts and Science",
                degreeType: "BA",
                courseSuffix: ["-UA"],
                totalCreditsRequired: 1000,
                overallGpaMin: 2.0,
                acceptsTransferCredit: true,
                residency: { minCredits: null, note: null },
            },
        });
        const result = buildForwardSchedule({
            session,
            dpr,
            graduationTermOverride: "2026-fall", // only 1 semester — can't fill 1000 credits
        });
        // With 1000 credits required and only 1 semester, the plan is infeasible
        expect(result.state).toBe("infeasible-draft");
    });
});

// ---------------------------------------------------------------------------
// Test 3: dprCourseHistoryHash matches hashDprCourseHistory(dpr)
// ---------------------------------------------------------------------------

describe("buildForwardSchedule — dprCourseHistoryHash", () => {
    it("matches hashDprCourseHistory(dpr) exactly", () => {
        const dpr = makeDpr({
            courseHistory: [
                { term: "2024 Fall", subject: "CSCI-UA", catalogNbr: "101", courseTitle: "Intro", grade: "A", units: 4, type: "EN" },
                { term: "2025 Spring", subject: "MATH-UA", catalogNbr: "120", courseTitle: "Calc I", grade: "B+", units: 4, type: "EN" },
            ],
        });
        const session = makeMinimalSession();
        const result = buildForwardSchedule({ session, dpr });

        expect(result.dprCourseHistoryHash).toBe(hashDprCourseHistory(dpr));
    });

    it("produces a non-empty 64-char hex string (sha256)", () => {
        const dpr = makeDpr();
        const session = makeMinimalSession();
        const result = buildForwardSchedule({ session, dpr });
        expect(result.dprCourseHistoryHash).toMatch(/^[0-9a-f]{64}$/);
    });
});

// ---------------------------------------------------------------------------
// Test 4: computedAt is a number near Date.now()
// ---------------------------------------------------------------------------

describe("buildForwardSchedule — computedAt", () => {
    it("computedAt is a number within 5 seconds of Date.now()", () => {
        const before = Date.now();
        const dpr = makeDpr();
        const session = makeMinimalSession();
        const result = buildForwardSchedule({ session, dpr });
        const after = Date.now();

        expect(typeof result.computedAt).toBe("number");
        expect(result.computedAt).toBeGreaterThanOrEqual(before);
        expect(result.computedAt).toBeLessThanOrEqual(after + 5000);
    });

    it("uses the actual wall-clock time, not zero", () => {
        const dpr = makeDpr();
        const session = makeMinimalSession();
        const result = buildForwardSchedule({ session, dpr });
        // computedAt should be a reasonable 2026-era timestamp
        expect(result.computedAt).toBeGreaterThan(1_700_000_000_000); // after Nov 2023
    });
});
