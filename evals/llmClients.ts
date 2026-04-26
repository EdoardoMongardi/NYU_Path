// ============================================================
// LLM Client adapters for the bakeoff (Phase 5 prep)
// ============================================================
// Pluggable interface so the bakeoff can run any candidate behind a
// uniform contract. Production swaps the same adapters into the agent
// orchestrator (Phase 5 proper).
//
// Tool-use semantics: the adapters expose a function-call surface that
// looks the same regardless of vendor. Anthropic returns "tool_use"
// content blocks with `name` + `input`; OpenAI returns
// `tool_calls` with `function.name` + `function.arguments`. The
// `BakeoffToolCall` shape below normalizes both.
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export interface BakeoffToolDef {
    name: string;
    description: string;
    /** JSONSchema-like input shape. Both vendors accept this. */
    parameters: Record<string, unknown>;
}

export interface BakeoffToolCall {
    name: string;
    args: Record<string, unknown>;
}

export interface BakeoffMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface BakeoffCompletion {
    /** The model's text reply (may be empty when only tool_calls were issued) */
    text: string;
    /** Any tool-call requests the model issued */
    toolCalls: BakeoffToolCall[];
    /** Wall-clock latency in ms */
    latencyMs: number;
    /** Raw token counts, if the vendor returned them */
    usage?: { promptTokens?: number; completionTokens?: number };
    /** Raw model id reported by the vendor's response (sanity check) */
    modelEcho?: string;
}

export interface LLMClient {
    /** Stable identifier, e.g., "anthropic:claude-opus-4-7" */
    readonly id: string;
    /** Per-million-tokens input/output USD pricing; used for cost roll-up */
    readonly pricing: { inputUsdPerMtoken: number; outputUsdPerMtoken: number };
    complete(args: {
        system: string;
        messages: BakeoffMessage[];
        tools?: BakeoffToolDef[];
        maxTokens?: number;
        temperature?: number;
    }): Promise<BakeoffCompletion>;
}

// ============================================================
// Anthropic adapter
// ============================================================

export class AnthropicClient implements LLMClient {
    public readonly id: string;
    public readonly pricing: { inputUsdPerMtoken: number; outputUsdPerMtoken: number };
    private readonly model: string;
    private readonly client: Anthropic;

    constructor(opts: {
        modelId: string;
        displayId: string;
        pricing: { inputUsdPerMtoken: number; outputUsdPerMtoken: number };
        apiKey: string;
    }) {
        this.id = opts.displayId;
        this.model = opts.modelId;
        this.pricing = opts.pricing;
        this.client = new Anthropic({ apiKey: opts.apiKey });
    }

    async complete(args: {
        system: string;
        messages: BakeoffMessage[];
        tools?: BakeoffToolDef[];
        maxTokens?: number;
        temperature?: number;
    }): Promise<BakeoffCompletion> {
        const start = Date.now();
        // Anthropic's user/assistant messages — no system role allowed in the
        // messages array; system goes in its own field.
        const userAssistant = args.messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: args.maxTokens ?? 1024,
            temperature: args.temperature ?? 0,
            system: args.system,
            messages: userAssistant,
            tools: args.tools?.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters as Anthropic.Tool.InputSchema,
            })),
        });
        const latencyMs = Date.now() - start;

        const toolCalls: BakeoffToolCall[] = [];
        const textParts: string[] = [];
        for (const block of response.content) {
            if (block.type === "text") textParts.push(block.text);
            else if (block.type === "tool_use") {
                toolCalls.push({
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
// OpenAI adapter
// ============================================================

export class OpenAIClient implements LLMClient {
    public readonly id: string;
    public readonly pricing: { inputUsdPerMtoken: number; outputUsdPerMtoken: number };
    private readonly model: string;
    private readonly client: OpenAI;

    constructor(opts: {
        modelId: string;
        displayId: string;
        pricing: { inputUsdPerMtoken: number; outputUsdPerMtoken: number };
        apiKey: string;
    }) {
        this.id = opts.displayId;
        this.model = opts.modelId;
        this.pricing = opts.pricing;
        this.client = new OpenAI({ apiKey: opts.apiKey });
    }

    async complete(args: {
        system: string;
        messages: BakeoffMessage[];
        tools?: BakeoffToolDef[];
        maxTokens?: number;
        temperature?: number;
    }): Promise<BakeoffCompletion> {
        const start = Date.now();
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: args.system },
            ...args.messages
                .filter((m) => m.role !== "system")
                .map((m) => ({
                    role: m.role as "user" | "assistant",
                    content: m.content,
                })),
        ];
        const tools = args.tools?.map((t): OpenAI.Chat.Completions.ChatCompletionTool => ({
            type: "function",
            function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            },
        }));

        const response = await this.client.chat.completions.create({
            model: this.model,
            max_completion_tokens: args.maxTokens ?? 1024,
            temperature: args.temperature ?? 0,
            messages,
            ...(tools ? { tools, tool_choice: "auto" as const } : {}),
        });
        const latencyMs = Date.now() - start;
        const choice = response.choices[0];
        const message = choice?.message;

        const toolCalls: BakeoffToolCall[] = [];
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
            toolCalls.push({ name: tc.function.name, args: parsedArgs });
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
// Cost calculation
// ============================================================

export function tokensCostUsd(
    tokens: { prompt: number; completion: number },
    pricing: { inputUsdPerMtoken: number; outputUsdPerMtoken: number },
): number {
    return (
        (tokens.prompt / 1_000_000) * pricing.inputUsdPerMtoken +
        (tokens.completion / 1_000_000) * pricing.outputUsdPerMtoken
    );
}
