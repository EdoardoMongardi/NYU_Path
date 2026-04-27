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
