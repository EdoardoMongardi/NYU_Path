// ============================================================
// OpenAI LLM client adapter (Phase 6 WS1)
// ============================================================
// Engine-side adapter implementing the agent's `LLMClient` interface
// against OpenAI's chat-completions API. Differs from
// `evals/llmClients.ts:OpenAIClient` in two important ways:
//
//   1. Preserves tool-call IDs end-to-end. The agent loop uses
//      `LLMToolCall.id` to correlate tool results with tool calls;
//      the bakeoff client throws the id away (it only ever ran
//      single-turn evals). This adapter MUST keep ids so multi-turn
//      tool conversations work.
//
//   2. Translates `LLMMessage.role === "tool"` (with `toolCallId`)
//      into OpenAI's `role: "tool", tool_call_id` shape, and
//      `LLMMessage.role === "assistant"` with `toolCalls` into
//      OpenAI's `role: "assistant", tool_calls: [...]` shape.
// ============================================================

import OpenAI from "openai";
import type {
    LLMClient,
    LLMCompletion,
    LLMMessage,
    LLMToolCall,
    LLMToolDef,
} from "../llmClient.js";

export interface OpenAIClientOptions {
    /** OpenAI model id, e.g., "gpt-4.1-mini" */
    modelId: string;
    /** Display id surfaced as `LLMClient.id`, e.g., "openai:gpt-4.1-mini" */
    displayId?: string;
    apiKey: string;
    /** Override the API base URL (used for proxies / Azure-OpenAI). */
    baseURL?: string;
}

export class OpenAIEngineClient implements LLMClient {
    public readonly id: string;
    private readonly model: string;
    private readonly client: OpenAI;

    constructor(opts: OpenAIClientOptions) {
        this.id = opts.displayId ?? `openai:${opts.modelId}`;
        this.model = opts.modelId;
        this.client = new OpenAI({
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

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: args.system },
            ...args.messages.map(toOpenAIMessage),
        ];

        const tools = args.tools?.map((t): OpenAI.Chat.Completions.ChatCompletionTool => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));

        const response = await this.client.chat.completions.create(
            {
                model: this.model,
                max_completion_tokens: args.maxTokens ?? 1024,
                temperature: args.temperature ?? 0,
                messages,
                ...(tools ? { tools, tool_choice: "auto" as const } : {}),
            },
            args.signal ? { signal: args.signal } : undefined,
        );
        const latencyMs = Date.now() - start;
        const choice = response.choices[0];
        const message = choice?.message;

        const toolCalls: LLMToolCall[] = [];
        for (const tc of message?.tool_calls ?? []) {
            if (tc.type !== "function") continue;
            let parsedArgs: Record<string, unknown> = {};
            try {
                parsedArgs = tc.function.arguments
                    ? JSON.parse(tc.function.arguments)
                    : {};
            } catch {
                parsedArgs = { __raw: tc.function.arguments };
            }
            toolCalls.push({
                id: tc.id,
                name: tc.function.name,
                args: parsedArgs,
            });
        }

        return {
            text: (message?.content ?? "").trim(),
            toolCalls,
            latencyMs,
            usage: {
                promptTokens: response.usage?.prompt_tokens,
                completionTokens: response.usage?.completion_tokens,
            },
            modelEcho: response.model,
        };
    }
}

// ============================================================
// Translation helpers
// ============================================================

/**
 * Translate one engine `LLMMessage` into the OpenAI message shape.
 * Exported for unit testing the role-translation logic without
 * exercising the live API.
 */
export function toOpenAIMessage(
    m: LLMMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    if (m.role === "tool") {
        if (!m.toolCallId) {
            throw new Error(
                `LLMMessage with role="tool" requires toolCallId. Got: ${JSON.stringify(m)}`,
            );
        }
        return {
            role: "tool",
            tool_call_id: m.toolCallId,
            content: m.content,
        };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
            role: "assistant",
            // OpenAI requires `content` to be present (string|null); empty
            // text + tool_calls is the canonical "tool-call only" shape.
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.args ?? {}),
                },
            })),
        };
    }
    if (m.role === "system" || m.role === "user" || m.role === "assistant") {
        return { role: m.role, content: m.content };
    }
    throw new Error(`Unsupported LLMMessage role: ${(m as { role: string }).role}`);
}
