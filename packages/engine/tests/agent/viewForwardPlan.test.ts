/**
 * Phase 13 Task 6 — viewForwardPlan.test.ts
 *
 * Test contract:
 *  1. Returns session.forwardSchedule when set
 *  2. Returns session.studentDraftPlan when forwardSchedule absent but draft exists
 *  3. Returns null when neither is set
 *  4. isReadOnly: true on the tool definition
 *  5. Calling the tool does NOT mutate session state (regression assertion)
 */

import { describe, it, expect } from "vitest";
import { viewForwardPlanTool } from "../../src/agent/tools/viewForwardPlan.js";
import type { ToolSession, ToolUseContext } from "../../src/agent/tool.js";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMinimalSchedule(state: ForwardSchedule["state"] = "valid-clean"): ForwardSchedule {
    return {
        studentId: "test",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "sha256:test",
        computedAt: 1_746_000_000_000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state,
        balanceScore: 0,
        assumptions: [],
    };
}

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
    return { ...overrides };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session,
    };
}

// ---------------------------------------------------------------------------
// Test 4: isReadOnly: true
// ---------------------------------------------------------------------------

describe("viewForwardPlanTool — isReadOnly", () => {
    it("has isReadOnly: true", () => {
        expect(viewForwardPlanTool.isReadOnly).toBe(true);
    });

    it("has name 'view_forward_plan'", () => {
        expect(viewForwardPlanTool.name).toBe("view_forward_plan");
    });
});

// ---------------------------------------------------------------------------
// Test 1: Returns session.forwardSchedule when set
// ---------------------------------------------------------------------------

describe("viewForwardPlanTool — returns forwardSchedule when set", () => {
    it("returns the stored forwardSchedule", async () => {
        const schedule = makeMinimalSchedule("valid-clean");
        const session = makeSession({ forwardSchedule: schedule });
        const ctx = makeCtx(session);

        const output = await viewForwardPlanTool.call({}, ctx);

        expect(output.schedule).toBe(schedule);
        expect(output.source).toBe("forwardSchedule");
        expect(output.summary).toContain("VALID (no caveats)");
    });

    it("prefers forwardSchedule over studentDraftPlan when both are set", async () => {
        const forwardSched = makeMinimalSchedule("valid-clean");
        const draftPlan = makeMinimalSchedule("infeasible-draft");
        const session = makeSession({
            forwardSchedule: forwardSched,
            studentDraftPlan: draftPlan,
        });
        const ctx = makeCtx(session);

        const output = await viewForwardPlanTool.call({}, ctx);

        expect(output.schedule).toBe(forwardSched);
        expect(output.source).toBe("forwardSchedule");
    });
});

// ---------------------------------------------------------------------------
// Test 2: Returns studentDraftPlan when forwardSchedule absent
// ---------------------------------------------------------------------------

describe("viewForwardPlanTool — returns studentDraftPlan as fallback", () => {
    it("returns the draft plan when forwardSchedule is absent", async () => {
        const draftPlan = makeMinimalSchedule("infeasible-draft");
        const session = makeSession({ studentDraftPlan: draftPlan });
        const ctx = makeCtx(session);

        const output = await viewForwardPlanTool.call({}, ctx);

        expect(output.schedule).toBe(draftPlan);
        expect(output.source).toBe("studentDraftPlan");
        expect(output.summary).toContain("DRAFT");
    });

    it("summary labels draft plans clearly", async () => {
        const draftPlan = makeMinimalSchedule("infeasible-draft");
        const session = makeSession({ studentDraftPlan: draftPlan });
        const ctx = makeCtx(session);

        const output = await viewForwardPlanTool.call({}, ctx);

        expect(output.summary).toContain("DRAFT");
        expect(output.summary).toContain("infeasible");
    });
});

// ---------------------------------------------------------------------------
// Test 3: Returns null when neither is set
// ---------------------------------------------------------------------------

describe("viewForwardPlanTool — returns null when no plan stored", () => {
    it("returns schedule: null and source: 'none' when no plan is stored", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await viewForwardPlanTool.call({}, ctx);

        expect(output.schedule).toBeNull();
        expect(output.source).toBe("none");
    });

    it("summary says to call plan_forward_degree when no plan stored", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await viewForwardPlanTool.call({}, ctx);

        expect(output.summary).toContain("plan_forward_degree");
    });

    it("summarizeResult produces a non-empty string for the no-plan case", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const output = await viewForwardPlanTool.call({}, ctx);
        const summarized = viewForwardPlanTool.summarizeResult(output);
        expect(typeof summarized).toBe("string");
        expect(summarized.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Test 5: Calling the tool does NOT mutate session state
// ---------------------------------------------------------------------------

describe("viewForwardPlanTool — does not mutate session", () => {
    it("leaves session.forwardSchedule unchanged after call", async () => {
        const schedule = makeMinimalSchedule("valid-clean");
        const session = makeSession({ forwardSchedule: schedule });
        const ctx = makeCtx(session);

        // Record state before
        const schedBefore = session.forwardSchedule;
        const draftBefore = session.studentDraftPlan;

        await viewForwardPlanTool.call({}, ctx);

        // State must be identical after call
        expect(session.forwardSchedule).toBe(schedBefore);
        expect(session.studentDraftPlan).toBe(draftBefore);
    });

    it("leaves empty session unchanged after call (no plan case)", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        await viewForwardPlanTool.call({}, ctx);

        expect(session.forwardSchedule).toBeUndefined();
        expect(session.studentDraftPlan).toBeUndefined();
    });

    it("does not overwrite forwardSchedule with draft when draft is present", async () => {
        const draftPlan = makeMinimalSchedule("infeasible-draft");
        const session = makeSession({ studentDraftPlan: draftPlan });
        const ctx = makeCtx(session);

        await viewForwardPlanTool.call({}, ctx);

        // forwardSchedule must still be absent
        expect(session.forwardSchedule).toBeUndefined();
        // draft must still be the original object
        expect(session.studentDraftPlan).toBe(draftPlan);
    });
});

// ---------------------------------------------------------------------------
// Bonus: summarizeResult covers valid-with-trade-offs label
// ---------------------------------------------------------------------------

describe("viewForwardPlanTool — state label rendering", () => {
    it("labels valid-with-trade-offs correctly", async () => {
        const schedule = makeMinimalSchedule("valid-with-trade-offs");
        const session = makeSession({ forwardSchedule: schedule });
        const ctx = makeCtx(session);

        const output = await viewForwardPlanTool.call({}, ctx);

        expect(output.summary).toContain("trade-offs");
    });
});
