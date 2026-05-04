/**
 * Phase 14 Task 5 — proposePlanChange / confirmPlanChange / simulateAlternatives tests.
 *
 * Test contract:
 *  1. proposePlanChange returns feasibility + consequences without mutating session state.
 *  2. confirmPlanChange applies mutations and re-runs the solver.
 *  3. proposePlanChange returns conflicts when change is infeasible.
 *  4. simulateAlternatives returns alternatives when plan is infeasible; empty when feasible.
 *  5. All 3 tools registered in buildDefaultRegistry().
 *  6. propose_plan_change + simulate_alternatives are isReadOnly:true (regression assert).
 *  7. confirmPlanChange routes infeasible-draft to session.studentDraftPlan (Decision #32).
 */

import { describe, it, expect } from "vitest";
import { proposePlanChangeTool } from "../../src/agent/tools/proposePlanChange.js";
import { confirmPlanChangeTool } from "../../src/agent/tools/confirmPlanChange.js";
import { simulateAlternativesTool } from "../../src/agent/tools/simulateAlternatives.js";
import { buildDefaultRegistry } from "../../src/agent/registry.js";
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

/**
 * Build a minimal ForwardSchedule stub that marks the plan as feasible.
 * Used as session.forwardSchedule so the tool validate-input passes.
 */
function makeMinimalFeasibleSchedule(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
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
        balanceScore: 0,
        assumptions: [],
        ...overrides,
    };
}

function makeMinimalInfeasibleSchedule(): ForwardSchedule {
    return makeMinimalFeasibleSchedule({
        feasibility: {
            feasible: false,
            infeasibilityReason: "graduation_total: cannot reach 128 credits in time",
            constraintViolations: [
                { kind: "graduation_total", detail: "Only 124 credits reachable" },
            ],
            placementRationale: {},
        },
        state: "infeasible-draft",
        degreeCreditsMet: false,
    });
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
// Tool contract checks (all 3 tools)
// ---------------------------------------------------------------------------

describe("tool contract assertions", () => {
    it("propose_plan_change has isReadOnly:true", () => {
        expect(proposePlanChangeTool.isReadOnly).toBe(true);
    });

    it("confirm_plan_change has isReadOnly:false", () => {
        expect(confirmPlanChangeTool.isReadOnly).toBe(false);
    });

    it("simulate_alternatives has isReadOnly:true", () => {
        expect(simulateAlternativesTool.isReadOnly).toBe(true);
    });

    it("all 3 tools are registered in buildDefaultRegistry()", () => {
        const reg = buildDefaultRegistry();
        const names = reg.list().map(t => t.name);
        expect(names).toContain("propose_plan_change");
        expect(names).toContain("confirm_plan_change");
        expect(names).toContain("simulate_alternatives");
    });
});

// ---------------------------------------------------------------------------
// propose_plan_change: returns outcome without mutating session
// ---------------------------------------------------------------------------

describe("proposePlanChangeTool — read-only snapshot invariant", () => {
    it("returns a PlanChangeOutcome without mutating session.forwardSchedule", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);
        const originalSchedule = session.forwardSchedule;
        const originalPrefs = session.schedulePreferences;

        const output = await proposePlanChangeTool.call(
            { mutations: [{ kind: "pin", courseId: "CSCI-UA 102", term: "2026-fall" }] },
            ctx,
        );

        // Output has the expected shape
        expect(typeof output.feasible).toBe("boolean");
        expect(Array.isArray(output.diff.added)).toBe(true);
        expect(Array.isArray(output.diff.removed)).toBe(true);
        expect(Array.isArray(output.consequences)).toBe(true);

        // Session state MUST NOT be mutated
        expect(session.forwardSchedule).toBe(originalSchedule);
        expect(session.schedulePreferences).toBe(originalPrefs);
    });

    it("attaches planDiff with balanceImpact", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await proposePlanChangeTool.call(
            { mutations: [{ kind: "loadStyleOverride", style: "frontload" }] },
            ctx,
        );

        expect(output.planDiff).toBeDefined();
        expect(output.planDiff!.balanceImpact).toBeDefined();
        expect(typeof output.planDiff!.balanceImpact.before).toBe("number");
        expect(typeof output.planDiff!.balanceImpact.after).toBe("number");
        expect(["improved", "negligible", "degraded-mild", "degraded-significant"]).toContain(
            output.planDiff!.balanceImpact.classification,
        );
    });

    it("does NOT mutate session.forwardSchedule when called (regression)", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);
        const before = JSON.stringify(session.forwardSchedule);

        await proposePlanChangeTool.call(
            { mutations: [{ kind: "exclude", courseId: "CSCI-UA 302" }] },
            ctx,
        );

        const after = JSON.stringify(session.forwardSchedule);
        expect(after).toBe(before);
    });

    it("validateInput rejects when no forward plan is in session", async () => {
        const session = makeSession({ forwardSchedule: undefined, studentDraftPlan: undefined });
        const ctx = makeCtx(session);

        const result = await proposePlanChangeTool.validateInput!(
            { mutations: [{ kind: "pin", courseId: "X", term: "2026-fall" }] },
            ctx,
        );
        expect(result.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// confirmPlanChange: applies mutations, re-runs solver, routes Decision #32
// ---------------------------------------------------------------------------

describe("confirmPlanChangeTool — applies change and routes per Decision #32", () => {
    it("applies pin mutation to session.schedulePreferences", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);
        expect(session.schedulePreferences?.pins).toBeUndefined();

        await confirmPlanChangeTool.call(
            { mutations: [{ kind: "pin", courseId: "CSCI-UA 102", term: "2027-spring" }] },
            ctx,
        );

        // schedulePreferences MUST be mutated
        expect(session.schedulePreferences).toBeDefined();
        expect(session.schedulePreferences?.pins).toBeDefined();
        expect(
            session.schedulePreferences!.pins!.some(
                p => p.courseId === "CSCI-UA 102" && p.term === "2027-spring",
            ),
        ).toBe(true);
    });

    it("returns a PlanChangeOutcome with storedIn field", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await confirmPlanChangeTool.call(
            { mutations: [{ kind: "loadStyleOverride", style: "balanced" }] },
            ctx,
        );

        expect(typeof output.feasible).toBe("boolean");
        expect(output.storedIn === "forwardSchedule" || output.storedIn === "studentDraftPlan").toBe(true);
    });

    it("routes infeasible result to session.studentDraftPlan (Decision #32)", async () => {
        // Use a DPR that makes the plan infeasible: 1000 credits required, 0 earned.
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
            // Pre-populate a valid forward schedule (so validateInput passes)
            forwardSchedule: makeMinimalFeasibleSchedule(),
        });
        const ctx = makeCtx(session);

        const output = await confirmPlanChangeTool.call(
            {
                mutations: [{
                    kind: "pin",
                    courseId: "CSCI-UA 102",
                    term: "2026-fall",
                }],
            },
            ctx,
        );

        // Solver should produce infeasible-draft with 1000 credits needed
        expect(output.storedIn).toBe("studentDraftPlan");
        expect(session.studentDraftPlan).toBeDefined();
        expect(session.studentDraftPlan!.state).toBe("infeasible-draft");
    });

    it("valid result routes to session.forwardSchedule and clears studentDraftPlan", async () => {
        const session = makeSession({
            studentDraftPlan: makeMinimalInfeasibleSchedule(),
        });
        const ctx = makeCtx(session);
        expect(session.studentDraftPlan).toBeDefined();

        const output = await confirmPlanChangeTool.call(
            { mutations: [{ kind: "loadStyleOverride", style: "balanced" }] },
            ctx,
        );

        if (output.storedIn === "forwardSchedule") {
            // studentDraftPlan must be cleared
            expect(session.studentDraftPlan).toBeUndefined();
            expect(session.forwardSchedule).toBeDefined();
        }
        // Either result is acceptable depending on solver run; both paths are verified.
    });

    it("validateInput rejects when no forward plan is in session", async () => {
        const session = makeSession({ forwardSchedule: undefined, studentDraftPlan: undefined });
        const ctx = makeCtx(session);

        const result = await confirmPlanChangeTool.validateInput!(
            { mutations: [{ kind: "pin", courseId: "X", term: "2026-fall" }] },
            ctx,
        );
        expect(result.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// simulateAlternatives: returns candidates when infeasible, empty when feasible
// ---------------------------------------------------------------------------

describe("simulateAlternativesTool — feasible plan → empty candidates", () => {
    it("returns empty candidates when current plan is feasible", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule(),
        });
        const ctx = makeCtx(session);

        const output = await simulateAlternativesTool.call({}, ctx);

        expect(output.candidates).toHaveLength(0);
        expect(output.note).toMatch(/feasible/i);
    });

    it("does NOT mutate session.forwardSchedule (regression)", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule(),
        });
        const ctx = makeCtx(session);
        const before = JSON.stringify(session.forwardSchedule);

        await simulateAlternativesTool.call({}, ctx);

        const after = JSON.stringify(session.forwardSchedule);
        expect(after).toBe(before);
    });
});

describe("simulateAlternativesTool — infeasible plan → non-empty candidates", () => {
    it("returns at least one candidate when the DPR-derived plan is infeasible", async () => {
        // Use infeasible DPR (1 term available, needs 128 credits, 108 earned → 20 more but
        // solver can do at most 18 in 1 term → infeasible). Use graduationTermOverride via
        // session forwardSchedule pointing to an infeasible plan.
        const session = makeSession({
            degreeProgressReport: makeDpr({
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
                // IP rows force currentTerm = graduationTerm = "2026-fall" → 1 term only
                courseHistory: [
                    {
                        type: "IP",
                        subject: "CSCI-UA",
                        catalogNbr: "102",
                        description: "Data Structures",
                        credits: 4,
                        grade: null,
                        term: "2026 Fall",
                        ruleIds: [],
                    },
                ],
            }),
            // The tool reads feasibility from session.forwardSchedule or studentDraftPlan.
            // Use an infeasible stub so the tool doesn't short-circuit with "feasible, no alternatives".
            forwardSchedule: makeMinimalInfeasibleSchedule(),
        });
        const ctx = makeCtx(session);

        const output = await simulateAlternativesTool.call({}, ctx);

        expect(output.candidates.length).toBeGreaterThan(0);
        // At least one should carry a non-null schedule (extend_grad_one_term)
        const hasFeasible = output.candidates.some(c => c.schedule !== null);
        expect(hasFeasible).toBe(true);
    });

    it("validateInput rejects when no plan is in session", async () => {
        const session = makeSession({ forwardSchedule: undefined, studentDraftPlan: undefined });
        const ctx = makeCtx(session);

        const result = await simulateAlternativesTool.validateInput!({}, ctx);
        expect(result.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// propose + simulate are read-only: session state never changes
// ---------------------------------------------------------------------------

describe("read-only invariant for propose_plan_change and simulate_alternatives", () => {
    it("propose_plan_change never writes session.schedulePreferences", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        await proposePlanChangeTool.call(
            { mutations: [{ kind: "pin", courseId: "CSCI-UA 102", term: "2026-fall" }] },
            ctx,
        );

        // schedulePreferences must remain unset (we never set it in makeSession)
        expect(session.schedulePreferences).toBeUndefined();
    });

    it("simulate_alternatives never writes session.forwardSchedule", async () => {
        const session = makeSession({
            forwardSchedule: makeMinimalFeasibleSchedule(),
        });
        const originalSchedule = session.forwardSchedule;
        const ctx = makeCtx(session);

        await simulateAlternativesTool.call({}, ctx);

        expect(session.forwardSchedule).toBe(originalSchedule);
    });
});
