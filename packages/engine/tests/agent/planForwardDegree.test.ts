/**
 * Phase 13 Task 6 — planForwardDegree.test.ts
 *
 * Test contract:
 *  1. Calls buildForwardSchedule and persists to session.forwardSchedule
 *  2. When result is infeasible-draft, persists to session.studentDraftPlan instead
 *  3. Returns the schedule + summary
 */

import { describe, it, expect, vi } from "vitest";
import { planForwardDegreeTool } from "../../src/agent/tools/planForwardDegree.js";
import type { ToolSession, ToolUseContext } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { ForwardSchedule } from "@nyupath/shared";

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

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
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
            residency: { minCredits: 64, note: null },
        },
        degreeProgressReport: makeDpr(),
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
// Tool contract checks
// ---------------------------------------------------------------------------

describe("planForwardDegreeTool — tool contract", () => {
    it("has name 'plan_forward_degree'", () => {
        expect(planForwardDegreeTool.name).toBe("plan_forward_degree");
    });

    it("has isReadOnly: false (it writes to session)", () => {
        expect(planForwardDegreeTool.isReadOnly).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Test 1: Persists to session.forwardSchedule on valid state
// ---------------------------------------------------------------------------

describe("planForwardDegreeTool — persists to forwardSchedule on valid state", () => {
    it("sets session.forwardSchedule when state is valid-clean or valid-with-trade-offs", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await planForwardDegreeTool.call({}, ctx);

        // session.forwardSchedule should be set now
        expect(session.forwardSchedule).toBeTruthy();
        expect(output.storedIn).toBe("forwardSchedule");
        // session.studentDraftPlan should NOT be set for valid states
        expect(session.studentDraftPlan).toBeUndefined();
    });

    it("returned schedule matches what was written to session", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await planForwardDegreeTool.call({}, ctx);

        expect(output.schedule).toBe(session.forwardSchedule ?? session.studentDraftPlan);
    });

    it("returned summary is a non-empty string", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await planForwardDegreeTool.call({}, ctx);

        expect(typeof output.summary).toBe("string");
        expect(output.summary.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Test 2: Persists to session.studentDraftPlan on infeasible-draft
// ---------------------------------------------------------------------------

describe("planForwardDegreeTool — persists to studentDraftPlan on infeasible-draft", () => {
    it("routes infeasible plan to studentDraftPlan, NOT forwardSchedule", async () => {
        // Make a session where the schedule will be infeasible:
        // 1000 credits required, only 1 semester available, no unmet requirements resolvable
        const session = makeSession({
            degreeProgressReport: makeDpr({
                cumulative: {
                    creditsRequired: 1000,
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
            }),
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
        const ctx = makeCtx(session);

        const output = await planForwardDegreeTool.call({ graduationTermOverride: "2026-fall" }, ctx);

        // The solver can't possibly fill 1000 credits in 1 semester → infeasible-draft
        expect(output.schedule.state).toBe("infeasible-draft");
        expect(output.storedIn).toBe("studentDraftPlan");
        expect(session.studentDraftPlan).toBeTruthy();
        // forwardSchedule must NOT be set for infeasible plans
        expect(session.forwardSchedule).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Test 3: Returns schedule + summary
// ---------------------------------------------------------------------------

describe("planForwardDegreeTool — return shape", () => {
    it("summarizeResult produces a truncated-safe string", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await planForwardDegreeTool.call({}, ctx);

        const summarized = planForwardDegreeTool.summarizeResult(output);
        expect(typeof summarized).toBe("string");
        expect(summarized.length).toBeLessThanOrEqual(planForwardDegreeTool.maxResultChars + 1); // +1 for the ellipsis
    });

    it("summary includes graduation term", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await planForwardDegreeTool.call({}, ctx);
        expect(output.summary).toContain("Graduation target:");
    });
});

// ---------------------------------------------------------------------------
// validateInput checks
// ---------------------------------------------------------------------------

describe("planForwardDegreeTool — validateInput", () => {
    it("rejects when degreeProgressReport is absent", async () => {
        const session = makeSession({ degreeProgressReport: undefined });
        const ctx = makeCtx(session);

        const result = await planForwardDegreeTool.validateInput!({}, ctx);
        expect(result.ok).toBe(false);
    });

    it("rejects when student profile is absent", async () => {
        const session = makeSession({ student: undefined, degreeProgressReport: makeDpr() });
        const ctx = makeCtx(session);

        const result = await planForwardDegreeTool.validateInput!({}, ctx);
        expect(result.ok).toBe(false);
    });

    it("passes when both student and DPR are present", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const result = await planForwardDegreeTool.validateInput!({}, ctx);
        expect(result.ok).toBe(true);
    });
});
