// ============================================================
// Phase 6 WS1 — LLM client adapter unit tests
// ============================================================
// No live API calls. We assert role/tool-id translation by feeding
// `LLMMessage` shapes through the exported helpers. The live
// round-trip lives in tests/eval/clients.live.test.ts (env-gated).
// ============================================================

import { describe, expect, it } from "vitest";
import {
    toOpenAIMessage,
    toAnthropicMessage,
    createPrimaryClient,
    createFallbackClient,
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FALLBACK_MODEL,
} from "../../src/agent/index.js";
import type { LLMMessage } from "../../src/agent/index.js";

describe("OpenAI message translation", () => {
    it("translates user/assistant text messages directly", () => {
        const u = toOpenAIMessage({ role: "user", content: "hi" });
        expect(u).toEqual({ role: "user", content: "hi" });
        const a = toOpenAIMessage({ role: "assistant", content: "hello" });
        expect(a).toEqual({ role: "assistant", content: "hello" });
    });

    it("translates assistant tool_calls to OpenAI's tool_calls + JSON.stringify args", () => {
        const m: LLMMessage = {
            role: "assistant",
            content: "",
            toolCalls: [
                { id: "call_1", name: "run_full_audit", args: { dryRun: true } },
            ],
        };
        const out = toOpenAIMessage(m);
        expect(out.role).toBe("assistant");
        // OpenAI's tool-call-only assistant message: content can be null.
        expect((out as { content: unknown }).content).toBeNull();
        const tc = (out as unknown as { tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] }).tool_calls[0];
        expect(tc.id).toBe("call_1");
        expect(tc.type).toBe("function");
        expect(tc.function.name).toBe("run_full_audit");
        expect(JSON.parse(tc.function.arguments)).toEqual({ dryRun: true });
    });

    it("translates tool messages (with toolCallId) to OpenAI's role:'tool' shape", () => {
        const m: LLMMessage = {
            role: "tool",
            content: "PROGRAM: CS BA — credits 64/128",
            toolCallId: "call_1",
        };
        const out = toOpenAIMessage(m);
        expect(out).toEqual({
            role: "tool",
            tool_call_id: "call_1",
            content: "PROGRAM: CS BA — credits 64/128",
        });
    });

    it("rejects role:'tool' without a toolCallId", () => {
        expect(() => toOpenAIMessage({ role: "tool", content: "x" }))
            .toThrow(/requires toolCallId/i);
    });
});

describe("Anthropic message translation", () => {
    it("translates user/assistant text messages directly", () => {
        const u = toAnthropicMessage({ role: "user", content: "hi" });
        expect(u).toEqual({ role: "user", content: "hi" });
        const a = toAnthropicMessage({ role: "assistant", content: "hello" });
        expect(a).toEqual({ role: "assistant", content: "hello" });
    });

    it("translates assistant tool_calls to Anthropic's tool_use content blocks", () => {
        const m: LLMMessage = {
            role: "assistant",
            content: "calling now",
            toolCalls: [
                { id: "toolu_1", name: "run_full_audit", args: { dryRun: true } },
            ],
        };
        const out = toAnthropicMessage(m);
        expect(out.role).toBe("assistant");
        const blocks = out.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
        // Order: text first, then tool_use
        expect(blocks[0]).toEqual({ type: "text", text: "calling now" });
        expect(blocks[1]).toMatchObject({
            type: "tool_use",
            id: "toolu_1",
            name: "run_full_audit",
            input: { dryRun: true },
        });
    });

    it("translates tool messages to Anthropic's user-role tool_result block", () => {
        const m: LLMMessage = {
            role: "tool",
            content: "result text",
            toolCallId: "toolu_1",
        };
        const out = toAnthropicMessage(m);
        expect(out.role).toBe("user");
        const blocks = out.content as Array<{ type: string; tool_use_id?: string; content?: string }>;
        expect(blocks[0]).toEqual({
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "result text",
        });
    });

    it("omits the text block when assistant message has tool_calls but no text", () => {
        const m: LLMMessage = {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "toolu_2", name: "search_policy", args: { query: "x" } }],
        };
        const out = toAnthropicMessage(m);
        const blocks = out.content as Array<{ type: string }>;
        // Only the tool_use block; no empty text block (Anthropic rejects those).
        expect(blocks).toHaveLength(1);
        expect(blocks[0].type).toBe("tool_use");
    });

    it("rejects role:'tool' without a toolCallId", () => {
        expect(() => toAnthropicMessage({ role: "tool", content: "x" }))
            .toThrow(/requires toolCallId/i);
    });
});

describe("createPrimaryClient / createFallbackClient", () => {
    it("returns null when the configured provider's API key is absent", () => {
        // No keys → no client.
        const c = createPrimaryClient({});
        expect(c).toBeNull();
        const f = createFallbackClient({});
        expect(f).toBeNull();
    });

    it("builds an OpenAI primary by default when OPENAI_API_KEY is set", () => {
        const c = createPrimaryClient({ OPENAI_API_KEY: "sk-test-fake" });
        expect(c).not.toBeNull();
        expect(c!.id).toBe(`openai:${DEFAULT_PRIMARY_MODEL}`);
    });

    it("builds an Anthropic fallback by default when ANTHROPIC_API_KEY is set", () => {
        const c = createFallbackClient({ ANTHROPIC_API_KEY: "sk-ant-test-fake" });
        expect(c).not.toBeNull();
        expect(c!.id).toBe(`anthropic:${DEFAULT_FALLBACK_MODEL}`);
    });

    it("honors NYUPATH_PRIMARY_PROVIDER / MODEL overrides", () => {
        const c = createPrimaryClient({
            ANTHROPIC_API_KEY: "sk-ant-test-fake",
            NYUPATH_PRIMARY_PROVIDER: "anthropic",
            NYUPATH_PRIMARY_MODEL: "claude-sonnet-4-6",
        });
        expect(c).not.toBeNull();
        expect(c!.id).toBe("anthropic:claude-sonnet-4-6");
    });

    it("throws on an unknown provider name", () => {
        expect(() => createPrimaryClient({
            OPENAI_API_KEY: "x",
            NYUPATH_PRIMARY_PROVIDER: "nonsense",
        })).toThrow(/Unknown LLM provider/i);
    });
});
