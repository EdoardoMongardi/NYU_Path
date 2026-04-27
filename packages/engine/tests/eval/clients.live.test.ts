// ============================================================
// Phase 6 WS1 — LLM client live round-trip tests (env-gated)
// ============================================================
// Skipped unless OPENAI_API_KEY / ANTHROPIC_API_KEY are present in
// the environment. CI runs unit tests only — these live tests run
// locally with `OPENAI_API_KEY=… pnpm test`. Each test costs <$0.01.
//
// What we assert: the engine adapters can complete a real round
// trip — including a tool-call turn — against the vendor APIs. The
// shape of `LLMCompletion` (text, toolCalls with ids preserved,
// usage tokens) must match what `runAgentTurn` expects.
// ============================================================

import { describe, expect, it } from "vitest";
import { OpenAIEngineClient } from "../../src/agent/clients/openaiClient.js";
import { AnthropicEngineClient } from "../../src/agent/clients/anthropicClient.js";
import {
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FALLBACK_MODEL,
} from "../../src/agent/clients/index.js";

const HAS_OPENAI = Boolean(process.env.OPENAI_API_KEY);
const HAS_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!HAS_OPENAI)("OpenAI live round-trip", () => {
    const buildClient = () => new OpenAIEngineClient({
        modelId: DEFAULT_PRIMARY_MODEL,
        apiKey: process.env.OPENAI_API_KEY!,
    });

    it("completes a plain text message", async () => {
        const client = buildClient();
        const out = await client.complete({
            system: "You are a precise assistant. Reply in 3 words or fewer.",
            messages: [{ role: "user", content: "Say hello." }],
            maxTokens: 20,
        });
        expect(out.text.length).toBeGreaterThan(0);
        expect(out.toolCalls).toEqual([]);
        expect(out.usage?.promptTokens).toBeGreaterThan(0);
    }, 30_000);

    it("issues a tool_call when given a tool", async () => {
        const client = buildClient();
        const out = await client.complete({
            system: "Always call get_time when asked the current time. Do not guess.",
            messages: [{ role: "user", content: "What time is it?" }],
            tools: [
                {
                    name: "get_time",
                    description: "Returns the current ISO timestamp.",
                    parameters: { type: "object", properties: {}, additionalProperties: false },
                },
            ],
            maxTokens: 50,
        });
        expect(out.toolCalls.length).toBeGreaterThan(0);
        const tc = out.toolCalls[0]!;
        expect(tc.name).toBe("get_time");
        expect(tc.id).toMatch(/^call_/); // OpenAI assigns "call_..." ids
    }, 30_000);
});

describe.skipIf(!HAS_ANTHROPIC)("Anthropic live round-trip", () => {
    const buildClient = () => new AnthropicEngineClient({
        modelId: DEFAULT_FALLBACK_MODEL,
        apiKey: process.env.ANTHROPIC_API_KEY!,
    });

    it("completes a plain text message", async () => {
        const client = buildClient();
        const out = await client.complete({
            system: "You are a precise assistant. Reply in 3 words or fewer.",
            messages: [{ role: "user", content: "Say hello." }],
            maxTokens: 20,
        });
        expect(out.text.length).toBeGreaterThan(0);
        expect(out.toolCalls).toEqual([]);
        expect(out.usage?.promptTokens).toBeGreaterThan(0);
    }, 30_000);

    it("issues a tool_call when given a tool", async () => {
        const client = buildClient();
        const out = await client.complete({
            system: "Always call get_time when asked the current time. Do not guess.",
            messages: [{ role: "user", content: "What time is it?" }],
            tools: [
                {
                    name: "get_time",
                    description: "Returns the current ISO timestamp.",
                    parameters: { type: "object", properties: {}, additionalProperties: false },
                },
            ],
            maxTokens: 200,
        });
        expect(out.toolCalls.length).toBeGreaterThan(0);
        const tc = out.toolCalls[0]!;
        expect(tc.name).toBe("get_time");
        expect(tc.id).toMatch(/^toolu_/); // Anthropic assigns "toolu_..." ids
    }, 30_000);
});

describe.skipIf(!(HAS_OPENAI && HAS_ANTHROPIC))(
    "Cross-vendor message-shape compatibility",
    () => {
        it("OpenAI tool result fed to Anthropic via translation", async () => {
            // Simulate: agent loop receives a tool_call from OpenAI,
            // executes the tool, then needs to send the result back to
            // Anthropic (fallback case). Exercises both translators
            // against real APIs to confirm tool-id round-trip works.
            const openai = new OpenAIEngineClient({
                modelId: DEFAULT_PRIMARY_MODEL,
                apiKey: process.env.OPENAI_API_KEY!,
            });
            const anthropic = new AnthropicEngineClient({
                modelId: DEFAULT_FALLBACK_MODEL,
                apiKey: process.env.ANTHROPIC_API_KEY!,
            });

            const turn1 = await openai.complete({
                system: "Always call get_time when asked the current time.",
                messages: [{ role: "user", content: "What time is it?" }],
                tools: [
                    {
                        name: "get_time",
                        description: "Returns ISO timestamp.",
                        parameters: { type: "object", properties: {}, additionalProperties: false },
                    },
                ],
                maxTokens: 50,
            });
            expect(turn1.toolCalls.length).toBeGreaterThan(0);
            const toolCall = turn1.toolCalls[0]!;

            // Fall back to Anthropic with the in-flight tool call.
            // Anthropic's tool_use ids must be `toolu_...`. OpenAI's
            // `call_...` id is incompatible, so we generate a fresh
            // anthropic-shaped id for the assistant turn (the cross-
            // vendor fallback rebases ids; this test pins the rebase
            // contract).
            const rebasedId = "toolu_rebased_001";
            const turn2 = await anthropic.complete({
                system: "Continue the conversation.",
                messages: [
                    { role: "user", content: "What time is it?" },
                    {
                        role: "assistant",
                        content: turn1.text,
                        toolCalls: [
                            {
                                id: rebasedId,
                                name: toolCall.name,
                                args: toolCall.args,
                            },
                        ],
                    },
                    {
                        role: "tool",
                        content: "2026-04-26T17:00:00Z",
                        toolCallId: rebasedId,
                    },
                    { role: "user", content: "Now state the time as a sentence." },
                ],
                maxTokens: 100,
            });
            expect(turn2.text.length).toBeGreaterThan(0);
        }, 60_000);
    },
);
