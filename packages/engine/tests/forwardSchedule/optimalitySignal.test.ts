/**
 * T7 — Structured optimality signal tests (TDD-first).
 *
 * Verifies that every SolverOutput return path carries a defined `optimality`
 * field, and that the correct status is assigned:
 *   "best-effort"              — feasibility-first found a valid plan
 *   "feasibility-unconfirmed"  — budget exhausted without finding a valid plan
 *   "optimal"                  — trivially-optimal empty plan (empty horizon)
 */

import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { PlacedCourse } from "../../src/agent/forwardSchedule/constraintModel.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories
// (verbatim copy from packages/engine/tests/forwardSchedule/search.test.ts)
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("structured optimality signal", () => {
    it("a feasibility-first found plan carries optimality 'best-effort'", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-fall",
            creditCeiling: 18,
            creditsEarned: 100,
            graduationCreditMinimum: 128,
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
        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(true);
        expect(out.optimality).toBe("best-effort");
    });

    it("a forced-truncation empty result is 'feasibility-unconfirmed'", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
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
        const out = solveForwardSchedule(input, 1); // maxNodes=1 forces truncation before any leaf
        expect(out.optimality).toBe("feasibility-unconfirmed");
    });

    it("empty-horizon early-return (grad < current term) carries optimality 'optimal'", () => {
        // The empty-horizon early-return triggers when futureTerms.length === 0,
        // which happens when graduationTerm is BEFORE (or equal-then-no-future) the
        // currentTerm — enumerateTerms("2026-fall", "2025-spring") returns [].
        // In this case no search runs: the plan is trivially the empty valid plan,
        // which is trivially optimal (it is the ONLY possible plan; nothing can be
        // preferred over it). So optimality must be "optimal".
        //
        // Note: currentTerm === graduationTerm ("2026-fall" == "2026-fall") gives
        // futureTerms = ["2026-fall"] (one term), so the early-return does NOT trigger
        // and the search runs — returning "best-effort". Use a grad term that is
        // strictly before current to force the empty-horizon path.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2025-spring", // before currentTerm → futureTerms = []
            unmetRequirements: [],
        });
        const out = solveForwardSchedule(input);
        // The empty plan is trivially optimal (it is the only plan; nothing to prefer).
        expect(out.optimality).toBe("optimal");
    });
});
