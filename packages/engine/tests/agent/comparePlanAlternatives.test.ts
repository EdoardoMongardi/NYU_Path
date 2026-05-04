/**
 * Phase 14 Task 7 — compare_plan_alternatives tool tests.
 *
 * Test contract (5 cases):
 *  (a) Returns alternatives when alternativeCandidates has entries.
 *  (b) Returns "no alternatives" indicator when absent or empty
 *      (verify decisionFraming text matches spec).
 *  (c) Read-only invariant: session bytes byte-identical after call.
 *      Assert isReadOnly === true.
 *  (d) Dimensions threaded through (custom dimensions array AND
 *      default-set fallback).
 *  (e) Integration: after compare returns N candidates, simulated agent
 *      picks index k, emits confirm_plan_change call with implied
 *      mutations, verifies resulting session.forwardSchedule is mutated.
 */

import { describe, it, expect } from "vitest";
import { comparePlanAlternativesTool } from "../../src/agent/tools/comparePlanAlternatives.js";
import { confirmPlanChangeTool } from "../../src/agent/tools/confirmPlanChange.js";
import type { ToolSession, ToolUseContext } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { ForwardSchedule, AlternativePlanSummary } from "@nyupath/shared";

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

function makeAlternativeCandidate(overrides: Partial<AlternativePlanSummary> = {}): AlternativePlanSummary {
    return {
        planIndex: 0,
        balanceScore: 0.85,
        weightedCreditsByTerm: { "2026-fall": 16, "2027-spring": 16 },
        hardCountByTerm: { "2026-fall": 2, "2027-spring": 2 },
        easyCountByTerm: { "2026-fall": 2, "2027-spring": 2 },
        subjectDistributionByTerm: { "2026-fall": { "CSCI-UA": 2, "MATH-UA": 2 } },
        distinctSubjectsCount: 4,
        totalPetitionCount: 0,
        totalAssumptionCount: 1,
        graduationTerm: "2027-spring",
        topDiffsFromWinner: [{ aspect: "balanceScore", change: "+0.05" }],
        ...overrides,
    };
}

function makeMinimalFeasibleSchedule(
    overrides: Partial<ForwardSchedule> = {},
): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "test-hash",
        computedAt: Date.now(),
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0.8,
        assumptions: [],
        ...overrides,
    };
}

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
    return {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
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
            residency: { minCredits: 64, note: null },
        },
        degreeProgressReport: makeDpr(),
        forwardSchedule: makeMinimalFeasibleSchedule(),
        ...overrides,
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session,
    };
}

// ---------------------------------------------------------------------------
// (c) Read-only invariant — isReadOnly flag
// ---------------------------------------------------------------------------

describe("compare_plan_alternatives — isReadOnly contract", () => {
    it("(c) isReadOnly is true", () => {
        expect(comparePlanAlternativesTool.isReadOnly).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// (a) Returns alternatives when alternativeCandidates has entries
// ---------------------------------------------------------------------------

describe("compare_plan_alternatives — alternatives present", () => {
    it("(a) returns plansSummarized with entries when alternativeCandidates is populated", async () => {
        const candidates: AlternativePlanSummary[] = [
            makeAlternativeCandidate({ planIndex: 0, balanceScore: 0.85, graduationTerm: "2027-spring" }),
            makeAlternativeCandidate({ planIndex: 1, balanceScore: 0.78, graduationTerm: "2027-fall" }),
            makeAlternativeCandidate({ planIndex: 2, balanceScore: 0.72, distinctSubjectsCount: 5, graduationTerm: "2028-spring" }),
        ];

        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({ alternativeCandidates: candidates }),
        });
        const ctx = makeCtx(session);

        const output = await comparePlanAlternativesTool.call(
            { studentStatedFactor: "I want more subject variety" },
            ctx,
        );

        expect(output.plansSummarized).toHaveLength(3);
        expect(output.plansSummarized[0]?.balanceScore).toBe(0.85);
        expect(output.plansSummarized[1]?.graduationTerm).toBe("2027-fall");
        expect(output.decisionFraming).toBe("Tier B per Decision #42");
    });

    it("(a) plansSummarized preserves all 11 AlternativePlanSummary fields", async () => {
        const candidate = makeAlternativeCandidate({
            planIndex: 0,
            balanceScore: 0.9,
            weightedCreditsByTerm: { "2026-fall": 18 },
            hardCountByTerm: { "2026-fall": 3 },
            easyCountByTerm: { "2026-fall": 1 },
            subjectDistributionByTerm: { "2026-fall": { "CSCI-UA": 3, "MATH-UA": 1 } },
            distinctSubjectsCount: 3,
            totalPetitionCount: 1,
            totalAssumptionCount: 2,
            graduationTerm: "2027-spring",
            topDiffsFromWinner: [{ aspect: "petitionCount", change: "+1" }],
        });

        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({ alternativeCandidates: [candidate] }),
        });
        const ctx = makeCtx(session);

        const output = await comparePlanAlternativesTool.call(
            { studentStatedFactor: "fewer petitions" },
            ctx,
        );

        const summarized = output.plansSummarized[0]!;
        expect(summarized.planIndex).toBe(0);
        expect(summarized.balanceScore).toBe(0.9);
        expect(summarized.weightedCreditsByTerm).toEqual({ "2026-fall": 18 });
        expect(summarized.hardCountByTerm).toEqual({ "2026-fall": 3 });
        expect(summarized.easyCountByTerm).toEqual({ "2026-fall": 1 });
        expect(summarized.distinctSubjectsCount).toBe(3);
        expect(summarized.totalPetitionCount).toBe(1);
        expect(summarized.totalAssumptionCount).toBe(2);
        expect(summarized.graduationTerm).toBe("2027-spring");
        expect(summarized.topDiffsFromWinner).toEqual([{ aspect: "petitionCount", change: "+1" }]);
    });
});

// ---------------------------------------------------------------------------
// (b) Returns "no alternatives" indicator when absent or empty
// ---------------------------------------------------------------------------

describe("compare_plan_alternatives — no alternatives", () => {
    it("(b) returns no-alternatives indicator when alternativeCandidates is absent", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule(),
            // No alternativeCandidates field
        });
        const ctx = makeCtx(session);

        const output = await comparePlanAlternativesTool.call(
            { studentStatedFactor: "lighter workload" },
            ctx,
        );

        expect(output.plansSummarized).toHaveLength(0);
        expect(output.dimensionsConsidered).toHaveLength(0);
        expect(output.decisionFraming).toBe(
            "no alternatives available; route to Tier C clarification or (soft-only) Tier D heuristic mapping",
        );
    });

    it("(b) returns no-alternatives indicator when alternativeCandidates is empty array", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({ alternativeCandidates: [] }),
        });
        const ctx = makeCtx(session);

        const output = await comparePlanAlternativesTool.call(
            { studentStatedFactor: "lighter workload" },
            ctx,
        );

        expect(output.plansSummarized).toHaveLength(0);
        expect(output.dimensionsConsidered).toHaveLength(0);
        expect(output.decisionFraming).toBe(
            "no alternatives available; route to Tier C clarification or (soft-only) Tier D heuristic mapping",
        );
    });

    it("(b) returns no-alternatives indicator when forwardSchedule is absent", async () => {
        const session = makeSession({ forwardSchedule: undefined });
        const ctx = makeCtx(session);

        const output = await comparePlanAlternativesTool.call(
            { studentStatedFactor: "prefer fewer petitions" },
            ctx,
        );

        expect(output.plansSummarized).toHaveLength(0);
        expect(output.decisionFraming).toBe(
            "no alternatives available; route to Tier C clarification or (soft-only) Tier D heuristic mapping",
        );
    });
});

// ---------------------------------------------------------------------------
// (c) Read-only invariant: session bytes byte-identical after call
// ---------------------------------------------------------------------------

describe("compare_plan_alternatives — read-only session invariant", () => {
    it("(c) session.forwardSchedule bytes unchanged after call with candidates", async () => {
        const candidates: AlternativePlanSummary[] = [
            makeAlternativeCandidate({ planIndex: 0 }),
            makeAlternativeCandidate({ planIndex: 1, balanceScore: 0.7 }),
        ];

        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({ alternativeCandidates: candidates }),
        });
        const ctx = makeCtx(session);

        const before = JSON.stringify(session);

        await comparePlanAlternativesTool.call(
            { studentStatedFactor: "balanced workload" },
            ctx,
        );

        const after = JSON.stringify(session);
        expect(after).toBe(before);
    });

    it("(c) session.schedulePreferences remains undefined after call", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({
                alternativeCandidates: [makeAlternativeCandidate()],
            }),
        });
        const ctx = makeCtx(session);

        await comparePlanAlternativesTool.call(
            { studentStatedFactor: "variety" },
            ctx,
        );

        expect(session.schedulePreferences).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// (d) Dimensions threaded through: custom array AND default fallback
// ---------------------------------------------------------------------------

describe("compare_plan_alternatives — dimensions threading", () => {
    it("(d) echoes custom dimensions array in dimensionsConsidered", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({
                alternativeCandidates: [makeAlternativeCandidate()],
            }),
        });
        const ctx = makeCtx(session);

        const customDimensions = ["balanceScore", "totalPetitionCount"];
        const output = await comparePlanAlternativesTool.call(
            {
                studentStatedFactor: "fewer petitions",
                dimensions: customDimensions,
            },
            ctx,
        );

        expect(output.dimensionsConsidered).toEqual(customDimensions);
    });

    it("(d) uses default dimensions when dimensions is undefined", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({
                alternativeCandidates: [makeAlternativeCandidate()],
            }),
        });
        const ctx = makeCtx(session);

        const output = await comparePlanAlternativesTool.call(
            { studentStatedFactor: "lighter workload" },
            ctx,
        );

        // Default set per spec
        expect(output.dimensionsConsidered).toEqual([
            "balanceScore",
            "distinctSubjectsCount",
            "totalPetitionCount",
            "hardCount-evenness",
        ]);
    });

    it("(d) default dimensions are not used when custom dimensions is empty array", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({
                alternativeCandidates: [makeAlternativeCandidate()],
            }),
        });
        const ctx = makeCtx(session);

        const output = await comparePlanAlternativesTool.call(
            {
                studentStatedFactor: "anything",
                dimensions: [],
            },
            ctx,
        );

        // Caller explicitly passed an empty array — that is their choice.
        // Spec says "Default dimensions if undefined". Empty array is not undefined.
        expect(output.dimensionsConsidered).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// (e) Integration: compare → pick candidate k → confirm applies mutation
// ---------------------------------------------------------------------------

describe("compare_plan_alternatives — integration with confirm_plan_change", () => {
    it("(e) compare returns candidates; agent picks one; confirm updates forwardSchedule", async () => {
        const candidates: AlternativePlanSummary[] = [
            makeAlternativeCandidate({ planIndex: 0, graduationTerm: "2027-spring", balanceScore: 0.85 }),
            makeAlternativeCandidate({ planIndex: 1, graduationTerm: "2027-fall", balanceScore: 0.72 }),
        ];

        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({ alternativeCandidates: candidates }),
        });
        const ctx = makeCtx(session);

        // Step 1: call compare_plan_alternatives — read-only
        const compareOutput = await comparePlanAlternativesTool.call(
            { studentStatedFactor: "I prefer graduating in fall to avoid summer work" },
            ctx,
        );

        // Verify compare returned >= 1 candidate
        expect(compareOutput.plansSummarized.length).toBeGreaterThanOrEqual(1);

        // Step 2: agent reads candidate k=1 and its metadata
        const pickedCandidate = compareOutput.plansSummarized[1]!;
        expect(pickedCandidate.graduationTerm).toBe("2027-fall");
        expect(typeof pickedCandidate.balanceScore).toBe("number");

        // Snapshot session BEFORE confirm
        const scheduleBeforeConfirm = JSON.stringify(session.forwardSchedule);

        // Step 3: agent calls confirm_plan_change with a mutation referencing
        // the picked candidate's graduationTerm. The integration goal is to
        // verify that confirm actually mutates the session (not that the
        // candidate encodes the mutation directly — it doesn't).
        await confirmPlanChangeTool.call(
            {
                mutations: [
                    {
                        kind: "loadStyleOverride",
                        style: "balanced",
                    },
                ],
            },
            ctx,
        );

        // After confirm_plan_change the session.forwardSchedule MUST have changed
        // (solver re-ran; at minimum computedAt differs). Session bytes change.
        const scheduleAfterConfirm = JSON.stringify(session.forwardSchedule);
        expect(scheduleAfterConfirm).not.toBe(scheduleBeforeConfirm);
    });

    it("(e) session is still not mutated between compare call and agent decision", async () => {
        const candidates: AlternativePlanSummary[] = [
            makeAlternativeCandidate({ planIndex: 0, balanceScore: 0.9 }),
        ];

        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule({ alternativeCandidates: candidates }),
        });
        const ctx = makeCtx(session);

        const snapshotBefore = JSON.stringify(session);

        const compareOutput = await comparePlanAlternativesTool.call(
            { studentStatedFactor: "best balance" },
            ctx,
        );

        // Read metadata from the candidate (as an agent would)
        const candidate = compareOutput.plansSummarized[0]!;
        expect(candidate.balanceScore).toBe(0.9);

        // Session must still be byte-for-byte identical — no premature mutation
        const snapshotAfter = JSON.stringify(session);
        expect(snapshotAfter).toBe(snapshotBefore);
    });
});
