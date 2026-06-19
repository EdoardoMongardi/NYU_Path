// ============================================================
// Task I1 companion — zero plan_proposal events when
// propose_plan_change is NOT called this turn.
// ============================================================
// This file lives separately from chatV2PlanProposal.test.ts because
// vi.mock is module-scoped: each file gets its own mock scope, so the
// no-propose mock (empty invocations) doesn't bleed into the positive
// case. The pattern mirrors chatV2WhatIfAuditRequest.test.ts.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../app/api/chat/v2/route";
import { parseDpr, type ChatTurnResult } from "@nyupath/engine";
import { resetStoresForTests } from "../lib/db/store";

const AGENT_ANSWER = "Here are some general course recommendations for next semester.";

// Mock with NO propose_plan_change invocation — empty invocations list.
vi.mock("@nyupath/engine", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@nyupath/engine")>();
    return {
        ...actual,
        detectAmbiguity: () => ({ ambiguous: false, signals: [], contentTokens: [] }),
        runAgentTurnStreaming: async function* () {
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: AGENT_ANSWER,
                invocations: [], // ← NO propose_plan_change
                turnMessages: [],
                usage: { promptTokens: 0, completionTokens: 0 },
                modelUsedId: "test-model",
                transitions: [],
            };
            yield { type: "done" as const, result };
        },
    };
});

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

describe("v2 route — NO plan_proposal when propose_plan_change not called (Task I1)", () => {
    const ORIGINAL = {
        openai: process.env.OPENAI_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        dbUrl: process.env.DATABASE_URL,
        sessionPath: process.env.NYUPATH_SESSION_STORE_PATH,
    };

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        delete process.env.NYUPATH_SESSION_STORE_PATH;
        process.env.OPENAI_API_KEY = "sk-test-fake-key-for-plan-proposal-none-test";
        process.env.ANTHROPIC_API_KEY = "sk-ant-test-fake-key-for-plan-proposal-none-test";
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

    it("emits ZERO plan_proposal events when no propose_plan_change invocation occurred", async () => {
        const res = await POST(fakeRequest({
            message: "What courses should I take next semester?",
            parsedData: validDprPayload(),
            history: [],
        }) as never);
        expect(res.status).toBe(200);

        const events = parseEvents(await drainSse(res));
        const proposalEvents = events.filter((e) => e.kind === "plan_proposal");

        // No propose_plan_change call → zero plan_proposal SSE events.
        expect(proposalEvents).toHaveLength(0);

        // The done event still arrives.
        expect(events.some((e) => e.kind === "done")).toBe(true);
    });
});
