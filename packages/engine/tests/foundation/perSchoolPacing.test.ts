/**
 * Task 1.6 — CAS-8 per-school pacing constants.
 *
 * Asserts that buildForwardSchedule reads creditTargetPerSemester and
 * domesticPartTimeFloor from schoolConfig rather than using hardcoded
 * CAS defaults (16 / 8).
 */

import { describe, it, expect } from "vitest";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
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

function makeDpr(creditsUsed = 96): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: null,
            residencyUsed: null,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: null,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
    };
}

/** Build a session with an overridden creditTargetPerSemester. */
function makeSession(creditTargetPerSemester: number, domesticPartTimeFloor?: number): ToolSession {
    return {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "stern",
            declaredPrograms: [{ programId: "finance", programType: "Major" }],
            coursesTaken: [],
        },
        schoolConfig: {
            schoolId: "stern",
            name: "Stern School of Business",
            courseSuffix: ["-UB"],
            totalCreditsRequired: 128,
            overallGpaMin: 2.0,
            acceptsTransferCredit: true,
            residency: { minCredits: null, note: null },
            maxCreditsPerSemester: 18,
            creditTargetPerSemester,
            ...(domesticPartTimeFloor !== undefined ? { domesticPartTimeFloor } : {}),
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("perSchoolPacing — creditTargetPerSemester read from schoolConfig", () => {
    it("paces at 12 when schoolConfig.creditTargetPerSemester = 12 (not the 16 CAS default)", () => {
        const dpr = makeDpr(96); // 32 credits left
        const session = makeSession(12);
        const result = buildForwardSchedule({ session, dpr });

        expect(result.creditTargetPerSemester).toBe(12);
    });

    it("paces at 16 when schoolConfig.creditTargetPerSemester = 16 (explicit, not implicit)", () => {
        const dpr = makeDpr(96);
        const session = makeSession(16);
        const result = buildForwardSchedule({ session, dpr });

        expect(result.creditTargetPerSemester).toBe(16);
    });

    it("falls back to DEFAULT_CREDIT_TARGET_PER_SEMESTER (16) when schoolConfig has no creditTargetPerSemester", () => {
        const dpr = makeDpr(96);
        const session: ToolSession = {
            student: {
                id: "test-student",
                catalogYear: "2024",
                homeSchool: "gallatin",
                declaredPrograms: [],
                coursesTaken: [],
            },
            schoolConfig: {
                schoolId: "gallatin",
                name: "Gallatin School of Individualized Study",
                courseSuffix: ["-UG"],
                residency: { minCredits: null, note: null },
            },
        };
        const result = buildForwardSchedule({ session, dpr });

        // Must use the fallback default (16), not crash or produce 0
        expect(result.creditTargetPerSemester).toBe(16);
    });

    it("domesticPartTimeFloor is read from schoolConfig (e.g. 6) rather than hardcoded 8", () => {
        const dpr = makeDpr(96);
        const session = makeSession(16, 6);
        const result = buildForwardSchedule({ session, dpr });

        expect(result.domesticPartTimeFloor).toBe(6);
    });

    it("domesticPartTimeFloor falls back to DEFAULT (8) when not set in schoolConfig", () => {
        const dpr = makeDpr(96);
        const session = makeSession(16); // no domesticPartTimeFloor set
        const result = buildForwardSchedule({ session, dpr });

        expect(result.domesticPartTimeFloor).toBe(8);
    });
});

describe("perSchoolPacing — homeSchoolId fallback is school-agnostic", () => {
    it("uses 'unknown' when both student.homeSchool and schoolConfig.schoolId are absent", () => {
        const dpr = makeDpr(96);
        const session: ToolSession = {
            // No student, no schoolConfig
        };
        const result = buildForwardSchedule({ session, dpr });

        expect(result.homeSchoolId).toBe("unknown");
    });
});
