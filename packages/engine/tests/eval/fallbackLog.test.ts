// ============================================================
// Phase 6 WS4 — fallback log + agent-loop integration tests
// ============================================================

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
    runAgentTurn,
    buildDefaultRegistry,
    RecordingLLMClient,
    buildTool,
    ToolRegistry,
    type LLMClient,
    type LLMCompletion,
    type Tool,
    type ToolSession,
} from "../../src/agent/index.js";
import {
    InMemoryFallbackSink,
    NULL_SINK,
    emitFallback,
} from "../../src/observability/fallbackLog.js";
import type { ZodTypeAny } from "zod";

const session: ToolSession = {
    student: {
        id: "u1",
        catalogYear: "2025-2026",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        coursesTaken: [],
    },
};

function makeClient(recordings: Array<{ match: Record<string, unknown>; completion: Record<string, unknown> }>): RecordingLLMClient {
    return new RecordingLLMClient({ recordings: recordings as never });
}

describe("InMemoryFallbackSink + emitFallback", () => {
    it("records events with auto-stamped ts and merges extra fields", () => {
        const sink = new InMemoryFallbackSink();
        emitFallback(sink, "tool_unsupported", "tool X not found", {
            correlationId: "req-1",
            toolName: "X",
            extra: { reason: "not in registry" },
        });
        expect(sink.events).toHaveLength(1);
        expect(sink.events[0]).toMatchObject({
            kind: "tool_unsupported",
            detail: "tool X not found",
            correlationId: "req-1",
            toolName: "X",
            extra: { reason: "not in registry" },
        });
        expect(sink.events[0]!.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it("clear() empties the buffer", () => {
        const sink = new InMemoryFallbackSink();
        emitFallback(sink, "max_turns", "x");
        expect(sink.events).toHaveLength(1);
        sink.clear();
        expect(sink.events).toHaveLength(0);
    });

    it("NULL_SINK is a no-op (events go nowhere)", () => {
        // The contract is "doesn't throw"; the lack of exposed state
        // is intentional — production callers check the JSONL file.
        expect(() => emitFallback(NULL_SINK, "max_turns", "x")).not.toThrow();
    });
});

describe("agentLoop emits fallback events at terminal states", () => {
    it("emits 'max_turns' when the model loops on tool calls forever", async () => {
        const sink = new InMemoryFallbackSink();
        const client = makeClient([
            {
                match: {},
                completion: {
                    text: "calling forever",
                    toolCalls: [{ id: "tc1", name: "search_policy", args: { query: "anything" } }],
                },
            },
        ]);
        const result = await runAgentTurn(client, buildDefaultRegistry(), session, "loop", {
            systemPrompt: "test",
            maxTurns: 3,
            fallbackSink: sink,
            correlationId: "loop-1",
        });
        expect(result.kind).toBe("max_turns");
        const evs = sink.events.filter((e) => e.kind === "max_turns");
        expect(evs).toHaveLength(1);
        expect(evs[0]!.correlationId).toBe("loop-1");
        expect(evs[0]!.extra?.maxTurns).toBe(3);
    });

    it("emits 'model_error_no_fallback' when both clients throw", async () => {
        const sink = new InMemoryFallbackSink();
        const broken: LLMClient = {
            id: "broken-primary",
            async complete(): Promise<LLMCompletion> { throw new Error("primary down"); },
        };
        const brokenFallback: LLMClient = {
            id: "broken-fallback",
            async complete(): Promise<LLMCompletion> { throw new Error("fallback down"); },
        };
        const result = await runAgentTurn(broken, buildDefaultRegistry(), session, "anything", {
            systemPrompt: "test",
            fallbackClient: brokenFallback,
            fallbackSink: sink,
            correlationId: "err-1",
        });
        expect(result.kind).toBe("model_error_no_fallback");
        const evs = sink.events.filter((e) => e.kind === "model_error_no_fallback");
        expect(evs).toHaveLength(1);
        expect(evs[0]!.modelId).toBe("broken-primary");
        expect(evs[0]!.detail).toMatch(/primary down/i);
    });

    it("emits 'model_fallback_triggered' when primary fails and fallback succeeds", async () => {
        const sink = new InMemoryFallbackSink();
        const broken: LLMClient = {
            id: "broken",
            async complete(): Promise<LLMCompletion> { throw new Error("primary down"); },
        };
        const fallback = makeClient([
            { match: { userMessageContains: "hi" }, completion: { text: "from fallback", toolCalls: [] } },
        ]);
        const result = await runAgentTurn(broken, buildDefaultRegistry(), session, "hi", {
            systemPrompt: "test",
            fallbackClient: fallback,
            fallbackSink: sink,
            correlationId: "fb-1",
        });
        expect(result.kind).toBe("ok");
        const evs = sink.events.filter((e) => e.kind === "model_fallback_triggered");
        expect(evs).toHaveLength(1);
        expect(evs[0]!.modelId).toBe("broken");
        expect(evs[0]!.detail).toMatch(/recovered via fallback/i);
    });

    it("emits 'tool_unsupported' when the model calls a tool not in the registry", async () => {
        const sink = new InMemoryFallbackSink();
        // Use a registry with a single dummy tool so the unknown call
        // is the only meaningful event.
        const reg = new ToolRegistry([
            buildTool({
                name: "dummy",
                description: "",
                inputSchema: z.object({}),
                prompt: () => "",
                async call() { return null; },
                summarizeResult: () => "ok",
            }) as Tool<ZodTypeAny, unknown>,
        ]);
        const client = makeClient([
            {
                match: { latestToolResultContains: "not found in registry" },
                completion: { text: "ok, abandoning", toolCalls: [] },
            },
            {
                match: { userMessageContains: "go" },
                completion: {
                    text: "calling unknown",
                    toolCalls: [{ id: "tc1", name: "totally_unknown_tool", args: {} }],
                },
            },
        ]);
        const result = await runAgentTurn(client, reg, session, "go", {
            systemPrompt: "test",
            fallbackSink: sink,
        });
        expect(result.kind).toBe("ok");
        const evs = sink.events.filter((e) => e.kind === "tool_unsupported");
        expect(evs).toHaveLength(1);
        expect(evs[0]!.toolName).toBe("totally_unknown_tool");
    });

    it("emits no operational events on a normal happy-path turn (transitions don't count)", async () => {
        const sink = new InMemoryFallbackSink();
        const client = makeClient([
            { match: {}, completion: { text: "hello", toolCalls: [] } },
        ]);
        const result = await runAgentTurn(client, buildDefaultRegistry(), session, "hi", {
            systemPrompt: "test",
            fallbackSink: sink,
        });
        expect(result.kind).toBe("ok");
        // Phase 7-B Step 14: every loop iteration emits a `transition`
        // event. These are observability-only and not operational
        // signals, so the original assertion ("emits NOTHING") was
        // tightened to ignore the transition stream specifically.
        const operational = sink.events.filter((e) => e.kind !== "transition");
        expect(operational).toEqual([]);
    });
});
