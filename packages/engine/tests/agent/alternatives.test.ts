/**
 * Phase 14 Task 4 — simulateAlternatives() failure-mode fallback tests.
 *
 * Decisions covered: #12 (alternatives generator)
 *
 * 3 test cases per the Phase 14 Task 4 spec.
 *
 * Solver note: `enumerateMainTerms` in Phase 13 only enumerates fall/spring
 * terms regardless of `preferences.includeSummer` or `preferences.includeJTerm`.
 * Those flags are Phase 14 Task 5 wiring — so include_summer and
 * include_jterm candidates in these tests will always produce
 * `schedule: null` (same infeasible plan, different relaxation label).
 * The extend_grad_one_term candidate CAN produce a feasible schedule
 * because it expands the main-term window, which the existing solver
 * fully honors.
 */

import { describe, it, expect } from "vitest";
import { simulateAlternatives } from "../../src/agent/forwardSchedule/alternatives.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";

// ---------------------------------------------------------------------------
// Minimal DPR fixture (mirrors solverPreferences.test.ts factory pattern)
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
            creditsUsed: 108,
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
// infeasibleInput() factory
//
// Design: student has 108 credits earned, needs 128 → 20 more needed.
// With creditCeiling = 18 and only 1 term (currentTerm = graduationTerm
// = "2026-fall"), the solver can place at most 18 credits → total 126 < 128
// → graduation_total violation → feasible: false.
//
// The extend_grad_one_term relaxation (spring → fall; fall → next-year spring)
// pushes graduationTerm to "2027-spring", giving 2 main terms × 16 credits
// = 32 planned + 108 earned = 140 ≥ 128 → feasible.
// ---------------------------------------------------------------------------

function infeasibleInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t-alt",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(),
        coursesInProgress: new Set(),
        // single-term window: current == graduation → solver can only fill 1 term
        currentTerm: "2026-fall",
        graduationTerm: "2026-fall",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 108, // 108 + 18 (max 1 term) = 126 < 128 → infeasible
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
        dprCourseHistoryHash: "alt-test-hash",
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
// Tests
// ---------------------------------------------------------------------------

describe("simulateAlternatives", () => {
    // Spec case 1: returns ≥1 candidate, and at least one has a non-null schedule.
    // The extend_grad_one_term relaxation gives a second main term, reaching
    // 108 + 32 = 140 ≥ 128 → feasible plan.
    it("returns at least one feasible alternative (non-null schedule) for an infeasible input", () => {
        const input = infeasibleInput();
        const candidates = simulateAlternatives(input);
        expect(candidates.length).toBeGreaterThan(0);
        const someFeasible = candidates.some(c => c.schedule !== null);
        expect(someFeasible).toBe(true);
    });

    // Spec case 2: include_summer candidate is always the first strategy attempted
    // when input.preferences?.includeSummer is falsy.
    it("includes an include_summer candidate when summer is not already set in preferences", () => {
        const input = infeasibleInput(); // preferences is undefined → includeSummer falsy
        const candidates = simulateAlternatives(input);
        const summerCandidate = candidates.find(c => c.relaxation === "include_summer");
        expect(summerCandidate).toBeDefined();
        // Summer relaxation produces a candidate (schedule may be null since solver
        // doesn't yet expand summer terms; Phase 14 Task 5 will wire this up).
        expect(summerCandidate?.summary).toBeTruthy();
    });

    // Spec case 3: extend_grad_one_term appears even when summer + J-term can't fix it.
    // Since the Phase 13 solver ignores includeSummer/includeJTerm, both those
    // relaxations will always be insufficient (schedule: null). The
    // extend_grad_one_term candidate is still emitted with relaxation label set.
    it("emits an extend_grad_one_term candidate regardless of summer/J-term efficacy", () => {
        const input = infeasibleInput();
        const candidates = simulateAlternatives(input);
        const extendCandidate = candidates.find(
            c => c.relaxation === "extend_grad_one_term" || c.relaxation === "extend_grad_one_year",
        );
        expect(extendCandidate).toBeDefined();
        expect(extendCandidate?.relaxation).toBe("extend_grad_one_term");
    });

    // Additional structural invariants
    it("caps total candidates at 3", () => {
        const input = infeasibleInput();
        const candidates = simulateAlternatives(input);
        expect(candidates.length).toBeLessThanOrEqual(3);
    });

    it("each candidate carries a non-empty summary string", () => {
        const input = infeasibleInput();
        const candidates = simulateAlternatives(input);
        for (const c of candidates) {
            expect(typeof c.summary).toBe("string");
            expect(c.summary.length).toBeGreaterThan(0);
        }
    });

    it("infeasible-relaxation candidates carry stillInfeasibleReason", () => {
        const input = infeasibleInput();
        const candidates = simulateAlternatives(input);
        // Summer and J-term are unimplemented in Phase 13 solver → both null schedule
        const summerCand = candidates.find(c => c.relaxation === "include_summer");
        const jtermCand = candidates.find(c => c.relaxation === "include_jterm");
        if (summerCand && summerCand.schedule === null) {
            expect(typeof summerCand.stillInfeasibleReason).toBe("string");
        }
        if (jtermCand && jtermCand.schedule === null) {
            expect(typeof jtermCand.stillInfeasibleReason).toBe("string");
        }
    });

    it("skips include_summer when preferences.includeSummer is already true", () => {
        const input = infeasibleInput({
            preferences: { includeSummer: true },
        });
        const candidates = simulateAlternatives(input);
        const summerCandidate = candidates.find(c => c.relaxation === "include_summer");
        expect(summerCandidate).toBeUndefined();
    });

    it("skips include_jterm when preferences.includeJTerm is already true", () => {
        const input = infeasibleInput({
            preferences: { includeJTerm: true },
        });
        const candidates = simulateAlternatives(input);
        const jtermCandidate = candidates.find(c => c.relaxation === "include_jterm");
        expect(jtermCandidate).toBeUndefined();
    });

    it("extend_grad_one_term produces a non-null schedule when 2 terms suffice", () => {
        // 108 earned + 1 term (max 18) = 126 < 128 (primary infeasible)
        // After extending to 2027-spring: 2 terms × 16 = 32 + 108 = 140 ≥ 128 → feasible
        const input = infeasibleInput();
        const candidates = simulateAlternatives(input);
        const extendCand = candidates.find(c => c.relaxation === "extend_grad_one_term");
        expect(extendCand?.schedule).not.toBeNull();
        expect(extendCand?.schedule?.feasibility.feasible).toBe(true);
    });
});
