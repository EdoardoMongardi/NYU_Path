// ============================================================
// Phase 6.5 P-3 — runAgentTurnStreaming tests
// ============================================================
// Pins the streaming agent loop's contract:
//   - text-only turns yield text_delta events as the model emits text
//   - tool turns yield tool_invocation_start + _done in arrival order
//   - the final `done` event carries the full ChatTurnResult
//   - clients without streamComplete fall back to complete() and
//     emit one synthetic text_delta with the full text
//   - max_turns / aborted / model_error_no_fallback all terminate
//     the generator with a `done` event of the right kind
// ============================================================

import { describe, expect, it } from "vitest";
import {
    runAgentTurnStreaming,
    buildDefaultRegistry,
    RecordingLLMClient,
    type LLMClient,
    type LLMCompletion,
    type LLMStreamEvent,
    type AgentStreamEvent,
    type ToolSession,
} from "../../src/agent/index.js";

const session: ToolSession = {
    student: {
        id: "u1",
        catalogYear: "2025-2026",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        coursesTaken: [],
    },
};

function makeRecording(recordings: Array<{ match: Record<string, unknown>; completion: Record<string, unknown> }>): RecordingLLMClient {
    return new RecordingLLMClient({ recordings: recordings as never });
}

/** Build a fake LLMClient whose streamComplete yields the given
 *  events in order. Useful for testing the streaming pipeline
 *  without a recording fixture (which is non-streaming). */
function fakeStreamingClient(scripted: LLMStreamEvent[][], id = "fake-streaming"): LLMClient {
    let i = 0;
    return {
        id,
        async complete() { throw new Error("complete() should not be called when streamComplete is present"); },
        async *streamComplete() {
            const events = scripted[i++ % scripted.length];
            for (const ev of events!) yield ev;
        },
    };
}

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, void>): Promise<AgentStreamEvent[]> {
    const out: AgentStreamEvent[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
}

describe("runAgentTurnStreaming (Phase 6.5 P-3)", () => {
    it("yields text_delta events from a streaming client + a final done", async () => {
        const completion: LLMCompletion = {
            text: "Hello, world!",
            toolCalls: [],
            latencyMs: 12,
        };
        const client = fakeStreamingClient([[
            { type: "text_delta", text: "Hello, " },
            { type: "text_delta", text: "world!" },
            { type: "done", completion },
        ]]);
        const events = await collect(runAgentTurnStreaming(
            client,
            buildDefaultRegistry(),
            session,
            "hi",
            { systemPrompt: "test" },
        ));

        const deltas = events.filter((e) => e.type === "text_delta") as Array<{ type: "text_delta"; text: string }>;
        expect(deltas.map((d) => d.text)).toEqual(["Hello, ", "world!"]);
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        if (done.type !== "done") return;
        expect(done.result.kind).toBe("ok");
        if (done.result.kind === "ok") expect(done.result.finalText).toBe("Hello, world!");
    });

    it("yields a single text_delta when the client only implements complete() (synthetic fallback)", async () => {
        // RecordingLLMClient has no streamComplete — the loop falls
        // back to complete() and emits one delta with the full text.
        const client = makeRecording([
            { match: { userMessageContains: "hi" }, completion: { text: "Hi there!", toolCalls: [], latencyMs: 1 } },
        ]);
        const events = await collect(runAgentTurnStreaming(
            client,
            buildDefaultRegistry(),
            session,
            "hi",
            { systemPrompt: "test" },
        ));
        const deltas = events.filter((e) => e.type === "text_delta") as Array<{ type: "text_delta"; text: string }>;
        expect(deltas).toHaveLength(1);
        expect(deltas[0]!.text).toBe("Hi there!");
        expect(events[events.length - 1]!.type).toBe("done");
    });

    it("yields tool_invocation_start + _done in arrival order before any text_delta", async () => {
        // Turn 1: model emits a tool call (no text). Turn 2: model
        // sees the tool result (a validation-failed message because
        // the test session has no rag corpus loaded — that's fine,
        // we just need ANY tool message to round-trip the loop) and
        // emits a text reply.
        const client = makeRecording([
            // Turn 2 first — user message doesn't change between turns.
            {
                match: { latestToolResultContains: "validation failed" },
                completion: { text: "Done.", toolCalls: [], latencyMs: 1 },
            },
            {
                match: { userMessageContains: "look up" },
                completion: {
                    text: "",
                    toolCalls: [{ id: "tc1", name: "search_policy", args: { query: "x" } }],
                    latencyMs: 1,
                },
            },
        ]);
        const events = await collect(runAgentTurnStreaming(
            client,
            buildDefaultRegistry(),
            session,
            "look up a policy",
            { systemPrompt: "test" },
        ));

        const kinds = events.map((e) => e.type);
        // Sequence: tool_invocation_start, tool_invocation_done, text_delta, done
        expect(kinds[0]).toBe("tool_invocation_start");
        expect(kinds[1]).toBe("tool_invocation_done");
        expect(kinds.includes("text_delta")).toBe(true);
        expect(kinds[kinds.length - 1]).toBe("done");

        const startEv = events[0]! as Extract<AgentStreamEvent, { type: "tool_invocation_start" }>;
        expect(startEv.toolName).toBe("search_policy");
    });

    it("terminates with kind=max_turns when the model loops on tool calls forever", async () => {
        const client = makeRecording([
            {
                match: {},
                completion: {
                    text: "calling forever",
                    toolCalls: [{ id: "tc1", name: "search_policy", args: { query: "x" } }],
                    latencyMs: 1,
                },
            },
        ]);
        const events = await collect(runAgentTurnStreaming(
            client,
            buildDefaultRegistry(),
            session,
            "loop",
            { systemPrompt: "test", maxTurns: 2 },
        ));
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        if (done.type === "done") expect(done.result.kind).toBe("max_turns");
    });

    it("terminates with kind=aborted when the signal fires before the loop starts", async () => {
        const client = makeRecording([{ match: {}, completion: { text: "x", toolCalls: [], latencyMs: 1 } }]);
        const ac = new AbortController();
        ac.abort();
        const events = await collect(runAgentTurnStreaming(
            client,
            buildDefaultRegistry(),
            session,
            "anything",
            { systemPrompt: "test", signal: ac.signal },
        ));
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        if (done.type === "done") expect(done.result.kind).toBe("aborted");
    });

    it("falls back to the secondary client when the primary throws", async () => {
        const broken: LLMClient = {
            id: "broken",
            async complete(): Promise<LLMCompletion> { throw new Error("primary down"); },
        };
        const fallback = makeRecording([
            { match: { userMessageContains: "hi" }, completion: { text: "from fallback", toolCalls: [], latencyMs: 1 } },
        ]);
        const events = await collect(runAgentTurnStreaming(
            broken,
            buildDefaultRegistry(),
            session,
            "hi",
            { systemPrompt: "test", fallbackClient: fallback },
        ));
        const done = events[events.length - 1]! as Extract<AgentStreamEvent, { type: "done" }>;
        expect(done.result.kind).toBe("ok");
        if (done.result.kind === "ok") {
            expect(done.result.finalText).toBe("from fallback");
            expect(done.result.modelUsedId).toBe(fallback.id);
        }
    });

    it("returns kind=model_error_no_fallback when both clients throw", async () => {
        const broken: LLMClient = {
            id: "p",
            async complete(): Promise<LLMCompletion> { throw new Error("a"); },
        };
        const brokenFb: LLMClient = {
            id: "f",
            async complete(): Promise<LLMCompletion> { throw new Error("b"); },
        };
        const events = await collect(runAgentTurnStreaming(
            broken,
            buildDefaultRegistry(),
            session,
            "hi",
            { systemPrompt: "test", fallbackClient: brokenFb },
        ));
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        if (done.type === "done") expect(done.result.kind).toBe("model_error_no_fallback");
    });
});
