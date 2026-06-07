/**
 * T6 — F-1 floor edges (validity) tests (TDD-first).
 *
 * Tests two corrections to materializePlan.ts:
 *   (a) A NON-final F-1 term is explicitly clamped to at least f1Floor by the
 *       fill loop — a "light" per-term override or explicit creditTargetPerTerm
 *       below 12 cannot drop a non-final F-1 term below 12.
 *   (b) A FINAL graduating F-1 term is filled only to the degree-minimum
 *       REMAINDER (not forced to 16). If that remainder is < f1Floor, the visa
 *       block emits an RCL/OGS NOTE (→ axis 5 requires-approval) instead of a
 *       hard credit_floor violation (→ plan is valid-with-trade-offs, not refused).
 *
 * makeMinimalDpr / makeInput / placed are copied (minimal) from search.test.ts.
 */

import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (copied from search.test.ts)
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

// ===========================================================================
// T6a — NON-final F-1 term: fill keeps credits ≥ f1Floor
// ===========================================================================

describe("T6a — non-final F-1 term floor", () => {
    it("a mid-degree (non-final) F-1 term is kept ≥ the F-1 floor via fill", () => {
        // 3-term horizon (fall 2026, spring 2027, fall 2027); a single requirement
        // is placed in fall 2026, leaving it with only 4 credits before fill. The
        // fill loop must top it to at least 12 (f1Floor), NOT leave it at 4.
        const input = makeInput({
            visaStatus: "f1",
            f1Floor: 12,
            creditTargetPerSemester: 16,
            currentTerm: "2026-fall",
            graduationTerm: "2027-fall",
            creditsEarned: 80,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["A-UA 1"],
                },
            ],
            courseCatalog: new Map([["A-UA 1", { title: "A", credits: 4 }]]),
            offerings: new Map([["A-UA 1", ["fall"]]]),
        });
        const out = solveForwardSchedule(input);
        // All non-final, non-optional semesters must be ≥ f1Floor
        const nonFinal = out.semesters.slice(0, -1).filter(s => !/summer|january/i.test(s.term));
        for (const sem of nonFinal) {
            expect(sem.plannedCredits).toBeGreaterThanOrEqual(12);
        }
        expect(
            out.feasibility.constraintViolations.some(v => v.kind === "credit_floor"),
        ).toBe(false);
    });

    it("a non-final F-1 term with a 'light' per-term override is STILL kept ≥ the F-1 floor (T6a explicit)", () => {
        // 'light' loadStylePerTerm makes effectiveTermTarget return f1Floor (12),
        // but before Change 1 it was possible for a lower explicit creditTargetPerTerm
        // to cause a sub-floor fill. Change 1 explicitly clamps: target = max(base, f1Floor).
        const input = makeInput({
            visaStatus: "f1",
            f1Floor: 12,
            creditTargetPerSemester: 16,
            currentTerm: "2026-fall",
            graduationTerm: "2027-fall",
            creditsEarned: 80,
            graduationCreditMinimum: 128,
            preferences: { loadStylePerTerm: { "2026-fall": "light" } },
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["A-UA 1"],
                },
            ],
            courseCatalog: new Map([["A-UA 1", { title: "A", credits: 4 }]]),
            offerings: new Map([["A-UA 1", ["fall"]]]),
        });
        const out = solveForwardSchedule(input);
        const fallSem = out.semesters.find(s => s.term === "2026-fall");
        if (fallSem) {
            expect(fallSem.plannedCredits).toBeGreaterThanOrEqual(12);
        }
    });
});

// ===========================================================================
// T6b — FINAL graduating F-1 term: remainder fill + RCL-flagged, not refused
// ===========================================================================

describe("T6b — final graduating F-1 term RCL exemption", () => {
    it("an F-1 FINAL term below 12 is VALID + RCL-flagged, not refused and not padded to 16", () => {
        // Near-graduate: creditsEarned=120, graduationCreditMinimum=128 → only 8 credits
        // of requirements remain, all in the single final term (spring 2027).
        // The fill loop must NOT pad it to 16. The visa block must NOT push a
        // credit_floor violation. Instead, an OGS/RCL note must appear on the final term.
        const input = makeInput({
            visaStatus: "f1",
            f1Floor: 12,
            creditTargetPerSemester: 16,
            currentTerm: "2027-spring",
            graduationTerm: "2027-spring",
            creditsEarned: 120,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["A-UA 1"],
                },
                {
                    rId: "r2",
                    title: "Two",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["B-UA 2"],
                },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }],
                ["B-UA 2", { title: "B", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["spring"]],
                ["B-UA 2", ["spring"]],
            ]),
        });
        const out = solveForwardSchedule(input);
        const finalSem = out.semesters[out.semesters.length - 1]!;

        // (1) NOT padded to 16 — takes only the remainder
        expect(finalSem.plannedCredits).toBeLessThan(16);
        // (2) Exactly 8 credits (the 2 placed requirements = degree remainder)
        expect(finalSem.plannedCredits).toBe(8);
        // (3) No credit_floor violation — plan is not refused
        expect(
            out.feasibility.constraintViolations.some(v => v.kind === "credit_floor"),
        ).toBe(false);
        // (4) RCL/OGS note present on the final semester
        expect(
            finalSem.notes.some(n => /rcl|ogs|reduced course load/i.test(n)),
        ).toBe(true);
        // (5) Plan is feasible overall
        expect(out.feasibility.feasible).toBe(true);
    });

    it("a domestic (non-F-1) FINAL term below 12 does NOT get an RCL note (exemption is F-1-scoped)", () => {
        // Domestic student: same near-graduate scenario. The final-F-1 RCL path must
        // NOT fire. The domestic student may or may not get a credit_floor violation
        // depending on domesticPartTimeFloor, but definitely no RCL note.
        const input = makeInput({
            visaStatus: "domestic",
            f1Floor: null,
            domesticPartTimeFloor: 8,
            creditTargetPerSemester: 16,
            currentTerm: "2027-spring",
            graduationTerm: "2027-spring",
            creditsEarned: 120,
            graduationCreditMinimum: 128,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["A-UA 1"],
                },
                {
                    rId: "r2",
                    title: "Two",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["B-UA 2"],
                },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }],
                ["B-UA 2", { title: "B", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["spring"]],
                ["B-UA 2", ["spring"]],
            ]),
        });
        const out = solveForwardSchedule(input);
        const finalSem = out.semesters[out.semesters.length - 1]!;

        // No RCL note — the RCL exemption is F-1-only
        expect(
            finalSem.notes.some(n => /rcl|reduced course load/i.test(n)),
        ).toBe(false);
    });
});
