import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicEngineClient } from "../../src/agent/clients/anthropicClient";

const messagesCreate = vi.fn();
const messagesStream = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
    return {
        default: class FakeAnthropic {
            messages = { create: messagesCreate, stream: messagesStream };
        },
        Anthropic: class FakeAnthropic2 {
            messages = { create: messagesCreate, stream: messagesStream };
        },
    };
});

describe("AnthropicEngineClient extended thinking", () => {
    beforeEach(() => {
        messagesCreate.mockReset();
        messagesStream.mockReset();
        delete process.env.NYUPATH_DISABLE_THINKING;
    });

    afterEach(() => {
        delete process.env.NYUPATH_DISABLE_THINKING;
    });

    it("passes thinking + temperature=1 + bumped max_tokens to messages.create when thinking is enabled", async () => {
        messagesCreate.mockResolvedValue({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
        });
        const client = new AnthropicEngineClient({ apiKey: "test", modelId: "claude-haiku-4-5-20251001" });
        await client.complete({
            system: "sys",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 1024,
            temperature: 0,
        });
        expect(messagesCreate).toHaveBeenCalledTimes(1);
        const args = messagesCreate.mock.calls[0][0];
        expect(args.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
        expect(args.temperature).toBe(1);
        expect(args.max_tokens).toBeGreaterThanOrEqual(4096 + 1024);
    });

    it("opts out of thinking when NYUPATH_DISABLE_THINKING=1 is set", async () => {
        process.env.NYUPATH_DISABLE_THINKING = "1";
        messagesCreate.mockResolvedValue({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
        });
        const client = new AnthropicEngineClient({ apiKey: "test", modelId: "claude-haiku-4-5-20251001" });
        await client.complete({
            system: "sys",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 1024,
            temperature: 0,
        });
        const args = messagesCreate.mock.calls[0][0];
        expect(args.thinking).toBeUndefined();
        expect(args.temperature).toBe(0);
    });

    it("yields thinking_delta events from the streaming loop", async () => {
        async function* fakeStream() {
            yield { type: "message_start", message: { id: "m1", model: "claude-haiku-4-5-20251001", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } };
            yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } };
            yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } };
            yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think." } };
            yield { type: "content_block_stop", index: 0 };
            yield { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello." } };
            yield { type: "content_block_stop", index: 1 };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } };
            yield { type: "message_stop" };
        }

        // The streaming path calls stream.finalMessage() at the end — mock it.
        const fakeStreamObj = {
            [Symbol.asyncIterator]: () => fakeStream(),
            finalMessage: vi.fn().mockResolvedValue({
                content: [{ type: "text", text: "Hello." }],
                model: "claude-haiku-4-5-20251001",
                usage: { input_tokens: 10, output_tokens: 20 },
                stop_reason: "end_turn",
            }),
        };
        messagesStream.mockReturnValue(fakeStreamObj);

        const client = new AnthropicEngineClient({ apiKey: "test", modelId: "claude-haiku-4-5-20251001" });
        const events: Array<{ type: string; text?: string }> = [];
        for await (const ev of client.streamComplete!({
            system: "sys",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 1024,
        })) {
            if (ev.type === "thinking_delta" || ev.type === "text_delta") {
                events.push({ type: ev.type, text: ev.text });
            } else if (ev.type === "done") {
                events.push({ type: "done" });
            }
        }
        const thinking = events.filter(e => e.type === "thinking_delta").map(e => e.text).join("");
        const text = events.filter(e => e.type === "text_delta").map(e => e.text).join("");
        expect(thinking).toBe("Let me think.");
        expect(text).toBe("Hello.");
        expect(events.find(e => e.type === "done")).toBeDefined();
    });
});
