// ============================================================
// Anthropic LLM client adapter (Phase 6 WS1)
// ============================================================
// Engine-side adapter implementing the agent's `LLMClient` interface
// against Anthropic's `messages.create` API. Like the OpenAI sibling,
// it preserves tool-use IDs end-to-end and translates engine
// `LLMMessage` shapes (with `role: "tool"` + `toolCallId`) into
// Anthropic's content-block-array shape.
//
// Anthropic message shape mapping:
//
//   Engine `assistant` with toolCalls →
//     { role: "assistant", content: [
//         { type: "text", text },
//         { type: "tool_use", id, name, input },
//       ]}
//
//   Engine `tool` (with toolCallId) →
//     { role: "user", content: [
//         { type: "tool_result", tool_use_id, content },
//       ]}
//
// (Anthropic carries tool results inside a synthesized "user" turn.)
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import type {
    LLMClient,
    LLMCompletion,
    LLMMessage,
    LLMStreamEvent,
    LLMToolCall,
    LLMToolDef,
} from "../llmClient.js";

export interface AnthropicClientOptions {
    /** Anthropic model id, e.g., "claude-sonnet-4-6" */
    modelId: string;
    /** Display id surfaced as `LLMClient.id` */
    displayId?: string;
    apiKey: string;
    /** Override the API base URL (used for proxies). */
    baseURL?: string;
}

export class AnthropicEngineClient implements LLMClient {
    public readonly id: string;
    private readonly model: string;
    private readonly client: Anthropic;

    constructor(opts: AnthropicClientOptions) {
        this.id = opts.displayId ?? `anthropic:${opts.modelId}`;
        this.model = opts.modelId;
        this.client = new Anthropic({
            apiKey: opts.apiKey,
            ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
        });
    }

    async complete(args: {
        system: string;
        messages: LLMMessage[];
        tools?: LLMToolDef[];
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    }): Promise<LLMCompletion> {
        const start = Date.now();
        const userAssistant = args.messages.map(toAnthropicMessage);

        const response = await this.client.messages.create(
            {
                model: this.model,
                max_tokens: args.maxTokens ?? 1024,
                temperature: args.temperature ?? 0,
                system: args.system,
                messages: userAssistant,
                ...(args.tools && args.tools.length > 0
                    ? {
                        tools: args.tools.map((t) => ({
                            name: t.name,
                            description: t.description,
                            input_schema: t.parameters as Anthropic.Tool.InputSchema,
                        })),
                    }
                    : {}),
            },
            args.signal ? { signal: args.signal } : undefined,
        );
        const latencyMs = Date.now() - start;

        const toolCalls: LLMToolCall[] = [];
        const textParts: string[] = [];
        for (const block of response.content) {
            if (block.type === "text") {
                textParts.push(block.text);
            } else if (block.type === "tool_use") {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    args: (block.input ?? {}) as Record<string, unknown>,
                });
            }
        }

        return {
            text: textParts.join("\n").trim(),
            toolCalls,
            latencyMs,
            usage: {
                promptTokens: response.usage?.input_tokens,
                completionTokens: response.usage?.output_tokens,
            },
            modelEcho: response.model,
        };
    }

    async *streamComplete(args: {
        system: string;
        messages: LLMMessage[];
        tools?: LLMToolDef[];
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    }): AsyncGenerator<LLMStreamEvent, void, void> {
        const start = Date.now();
        const userAssistant = args.messages.map(toAnthropicMessage);

        const stream = this.client.messages.stream(
            {
                model: this.model,
                max_tokens: args.maxTokens ?? 1024,
                temperature: args.temperature ?? 0,
                system: args.system,
                messages: userAssistant,
                ...(args.tools && args.tools.length > 0
                    ? {
                        tools: args.tools.map((t) => ({
                            name: t.name,
                            description: t.description,
                            input_schema: t.parameters as Anthropic.Tool.InputSchema,
                        })),
                    }
                    : {}),
            },
            args.signal ? { signal: args.signal } : undefined,
        );

        // Buffer per content_block index. Anthropic emits
        // `content_block_start` (with type+id+name for tool_use, or
        // type=text), then `content_block_delta` events. We yield
        // text_delta for text deltas, and accumulate tool_use
        // partial_json deltas to JSON.parse at content_block_stop.
        type Buf = { type: "text" | "tool_use"; text?: string; toolId?: string; toolName?: string; argsRaw?: string };
        const blocks = new Map<number, Buf>();
        let modelEcho: string | undefined;

        for await (const ev of stream) {
            if (ev.type === "message_start") {
                modelEcho = ev.message.model ?? modelEcho;
                continue;
            }
            if (ev.type === "content_block_start") {
                const block = ev.content_block;
                if (block.type === "text") {
                    blocks.set(ev.index, { type: "text", text: "" });
                } else if (block.type === "tool_use") {
                    blocks.set(ev.index, {
                        type: "tool_use",
                        toolId: block.id,
                        toolName: block.name,
                        argsRaw: "",
                    });
                }
                continue;
            }
            if (ev.type === "content_block_delta") {
                const buf = blocks.get(ev.index);
                if (!buf) continue;
                const delta = ev.delta;
                if (delta.type === "text_delta" && buf.type === "text") {
                    buf.text = (buf.text ?? "") + delta.text;
                    yield { type: "text_delta", text: delta.text };
                } else if (delta.type === "input_json_delta" && buf.type === "tool_use") {
                    buf.argsRaw = (buf.argsRaw ?? "") + delta.partial_json;
                }
                continue;
            }
            // content_block_stop / message_delta / message_stop are
            // observed but we accumulate via the buffers above.
        }

        // Final message gives us authoritative usage + completed blocks.
        const finalMessage = await stream.finalMessage();

        const textParts: string[] = [];
        const toolCalls: LLMToolCall[] = [];
        for (const block of finalMessage.content) {
            if (block.type === "text") {
                textParts.push(block.text);
            } else if (block.type === "tool_use") {
                toolCalls.push({
                    id: block.id,
                    name: block.name,
                    args: (block.input ?? {}) as Record<string, unknown>,
                });
            }
        }

        const completion: LLMCompletion = {
            text: textParts.join("\n").trim(),
            toolCalls,
            latencyMs: Date.now() - start,
            usage: {
                promptTokens: finalMessage.usage?.input_tokens,
                completionTokens: finalMessage.usage?.output_tokens,
            },
            ...(modelEcho ? { modelEcho } : { modelEcho: finalMessage.model }),
        };
        yield { type: "done", completion };
    }
}

// ============================================================
// Translation helpers
// ============================================================

/**
 * Translate one engine `LLMMessage` into Anthropic's message shape.
 * Exported for unit testing the role-translation logic.
 */
export function toAnthropicMessage(m: LLMMessage): Anthropic.MessageParam {
    if (m.role === "system") {
        // System content is passed in `system` field, not the messages
        // array; callers should strip system messages before this. We
        // keep a defensive translation that demotes system→user just in
        // case (preserves correctness even if a caller forgets).
        return { role: "user", content: m.content };
    }
    if (m.role === "tool") {
        if (!m.toolCallId) {
            throw new Error(
                `LLMMessage with role="tool" requires toolCallId. Got: ${JSON.stringify(m)}`,
            );
        }
        return {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    tool_use_id: m.toolCallId,
                    content: m.content,
                },
            ],
        };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) {
            blocks.push({
                type: "tool_use",
                id: tc.id,
                name: tc.name,
                input: tc.args,
            });
        }
        return { role: "assistant", content: blocks };
    }
    if (m.role === "user" || m.role === "assistant") {
        return { role: m.role, content: m.content };
    }
    throw new Error(`Unsupported LLMMessage role: ${(m as { role: string }).role}`);
}
