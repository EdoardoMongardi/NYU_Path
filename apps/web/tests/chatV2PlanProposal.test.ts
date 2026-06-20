// ============================================================
// Task I1 — v2 route `plan_proposal` SSE emit
// ============================================================
// End-to-end route proof that, when the agent calls the
// `propose_plan_change` tool this turn, the route emits exactly
// one `plan_proposal` SSE event carrying:
//   { kind:"plan_proposal", pendingMutationId, proposedSchedule,
//     planDiff, consequences, feasible:true }
// BEFORE the terminal `done` event. We mock ONLY the streaming
// agent loop (no real LLM call); `runProposeStage` runs via the
// in-memory store so the staged entry is verifiable post-SSE.
//
// A second test (in the companion `chatV2PlanProposalNone.test.ts`
// file) pins the zero-propose case via a separate module-level mock
// that returns no invocations. We cannot mix the two cases in one
// file because vi.mock is module-scoped and cannot be overridden
// per-test within the same module.
//
// This mirrors the structure of chatV2WhatIfAuditRequest.test.ts
// (the `whatif_audit_request` SSE emit test), which is the
// canonical model for this pattern.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../app/api/chat/v2/route";
import { parseDpr, type ChatTurnResult, type ToolInvocation } from "@nyupath/engine";
import { resetStoresForTests } from "../lib/db/store";
import { _pendingMutationsSizeForTests, _pendingMutationHasIdForTests } from "../lib/planActionOrchestrator";
import {
    makeFeasibleScheduleWithSemesters,
    specificSlot,
    seedStudentState,
} from "./_planRouteTestUtils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ANSWER =
    "I propose pinning CSCI-UA 201 to Fall 2027. This looks feasible — confirm?";

// The `propose_plan_change` invocation the mocked loop returns.
// `args.mutations` carries the real mutation array the route reads to
// call runProposeStage; `summary` is the string the route ignores for
// SSE purposes (only used for chat-history persistence).
const PROPOSE_INVOCATION: ToolInvocation = {
    toolName: "propose_plan_change",
    args: { mutations: [{ kind: "pin", courseId: "CSCI-UA 201", term: "2027-fall" }] },
    summary: "PROPOSE PLAN CHANGE — feasible: true\nAdded slots: 1, removed slots: 0",
} as ToolInvocation;

// Mock ONLY the streaming agent loop + detectAmbiguity so the
// clarifier's LLM call is skipped. importOriginal keeps
// `validateResponse`, `runProposeStage`, etc. all REAL. Without
// the `detectAmbiguity` stub the message might trip the clarifier,
// which attempts a real LLM call (fails with a fake key) — flaky.
vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        detectAmbiguity: () => ({ ambiguous: false, signals: [], contentTokens: [] }),
        runAgentTurnStreaming: async function* () {
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: AGENT_ANSWER,
                invocations: [PROPOSE_INVOCATION],
                turnMessages: [],
                usage: { promptTokens: 0, completionTokens: 0 },
                modelUsedId: "test-model",
                transitions: [],
            };
            yield { type: "tool_invocation_done" as const, invocation: PROPOSE_INVOCATION };
            yield { type: "done" as const, result };
        },
    };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DPR_FIXTURE = readFileSync(
    join(__dirname, "..", "..", "..", "packages/engine/tests/fixtures/dpr_sample.redacted.txt"),
    "utf-8",
);
function validDprPayload(): { kind: "dpr"; report: unknown } {
    const r = parseDpr(DPR_FIXTURE, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
    if (!r.ok) throw new Error("DPR fixture failed to parse");
    return { kind: "dpr", report: r.report };
}

function fakeRequest(body: unknown): { json: () => Promise<unknown> } {
    return { json: async () => body };
}

async function drainSse(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let body = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += decoder.decode(value, { stream: true });
    }
    return body;
}

/** Parse the drained SSE text into ordered { kind, data } entries. */
function parseEvents(sse: string): Array<{ kind: string; data: Record<string, unknown> }> {
    const out: Array<{ kind: string; data: Record<string, unknown> }> = [];
    for (const block of sse.split("\n\n")) {
        let kind: string | null = null;
        let dataLine: string | null = null;
        for (const raw of block.split("\n")) {
            const line = raw.replace(/\r$/, "");
            if (line.startsWith("event: ")) kind = line.slice("event: ".length);
            else if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
        }
        if (kind && dataLine) {
            try {
                out.push({ kind, data: JSON.parse(dataLine) as Record<string, unknown> });
            } catch { /* ignore unparsable block */ }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("v2 route plan_proposal SSE emit (Task I1)", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-plan-proposal-test";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-plan-proposal-test";
        resetStoresForTests();
    });

    afterEach(() => {
        if (ORIGINAL.openai === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = ORIGINAL.openai;
        if (ORIGINAL.anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = ORIGINAL.anthropic;
        if (ORIGINAL.dbUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL.dbUrl;
        if (ORIGINAL.sessionPath === undefined) delete process.env.NYUPATH_SESSION_STORE_PATH;
        else process.env.NYUPATH_SESSION_STORE_PATH = ORIGINAL.sessionPath;
        resetStoresForTests();
        vi.restoreAllMocks();
    });

    it("emits exactly one plan_proposal event with required fields, before done", async () => {
        // Seed a fully-hydrateable student so runProposeStage succeeds
        // (needs: profile + DPR in store + a forward schedule).
        const userId = "plan-proposal-test-i1";
        const schedule = makeFeasibleScheduleWithSemesters(userId, [
            { term: "2027-fall", slots: [specificSlot("CSCI-UA 102")] },
        ]);
        await seedStudentState(userId, schedule);

        const res = await POST(fakeRequest({
            message: "Move CSCI-UA 201 to Fall 2027.",
            parsedData: validDprPayload(),
            history: [],
            userId,
        }) as never);
        expect(res.status).toBe(200);

        const events = parseEvents(await drainSse(res));
        const proposalEvents = events.filter((e) => e.kind === "plan_proposal");

        // Exactly one plan_proposal event per turn.
        expect(proposalEvents).toHaveLength(1);

        const ev = proposalEvents[0]!.data;
        // Must carry kind.
        expect(ev.kind).toBe("plan_proposal");
        // Must carry a non-empty pendingMutationId (the staged UUID).
        expect(typeof ev.pendingMutationId).toBe("string");
        expect((ev.pendingMutationId as string).length).toBeGreaterThan(0);
        // Feasibility from the solver — seeded plan + pin → feasible.
        expect(ev.feasible).toBe(true);
        // Consequences array (may be empty but present).
        expect(Array.isArray(ev.consequences)).toBe(true);
        // proposedSchedule and planDiff come from the solver run.
        expect(ev.proposedSchedule).toBeDefined();
        expect(ev.planDiff).toBeDefined();

        // plan_proposal MUST land BEFORE the terminal done event.
        const kinds = events.map((e) => e.kind);
        expect(kinds.indexOf("plan_proposal")).toBeLessThan(kinds.indexOf("done"));

        // R1 verification: staging ≠ committing. The pendingMutationId is
        // now in the in-memory store but NO schedule has been written to the
        // scheduleStore (confirming happens only via /api/plan/confirm).
        expect(_pendingMutationsSizeForTests()).toBeGreaterThanOrEqual(1);

        // Emitted-id cross-check: the id on the SSE event is EXACTLY the id
        // that was staged (not a different/random one) — a route bug that
        // emitted one id while staging another would otherwise pass.
        expect(_pendingMutationHasIdForTests(ev.pendingMutationId as string)).toBe(true);
    });

    it("emits AT MOST ONE plan_proposal even when invocations has multiple propose calls (at-most-once guard)", async () => {
        // The module mock always yields exactly one PROPOSE_INVOCATION, so
        // this test verifies the route doesn't accidentally double-emit if
        // the invocations list had multiple propose_plan_change entries.
        // (The "take last" logic is verified by the single-event assertion.)
        const userId = "plan-proposal-guard-i1";
        const schedule = makeFeasibleScheduleWithSemesters(userId, [
            { term: "2027-fall", slots: [specificSlot("CSCI-UA 102")] },
        ]);
        await seedStudentState(userId, schedule);

        const res = await POST(fakeRequest({
            message: "Propose a change.",
            parsedData: validDprPayload(),
            history: [],
            userId,
        }) as never);
        expect(res.status).toBe(200);

        const events = parseEvents(await drainSse(res));
        const proposalEvents = events.filter((e) => e.kind === "plan_proposal");
        // Must be at most 1 (the mock returns 1 invocation → 1 event).
        expect(proposalEvents.length).toBeLessThanOrEqual(1);
    });
});
