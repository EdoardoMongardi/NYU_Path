// ============================================================
// LLM Client — Abstraction over OpenAI GPT-4o-mini
// ============================================================
//
// @deprecated Phase 6 WS3 (scheduled for removal after WS2 lands).
// The agent-loop equivalent lives at
// `packages/engine/src/agent/clients/openaiClient.ts:OpenAIEngineClient`,
// which preserves tool-call IDs and supports tool messages — this
// legacy client is text-only and cannot be used with `runAgentTurn`.
// ============================================================

import OpenAI from "openai";

export interface Message {
    role: "system" | "user" | "assistant";
    content: string;
}

export interface LLMOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
}

export interface LLMClient {
    /** Send messages and get a text response */
    chat(messages: Message[], options?: LLMOptions): Promise<string>;

    /** Send messages and get a structured JSON response */
    chatJSON<T>(messages: Message[], options?: LLMOptions): Promise<T>;
}

const DEFAULT_MODEL = "gpt-4o-mini";

/**
 * Create an LLM client using the OpenAI API.
 * Reads OPENAI_API_KEY from environment.
 */
export function createOpenAIClient(apiKey?: string): LLMClient {
    const client = new OpenAI({
        apiKey: apiKey ?? process.env.OPENAI_API_KEY,
    });

    return {
        async chat(messages: Message[], options?: LLMOptions): Promise<string> {
            const response = await client.chat.completions.create({
                model: options?.model ?? DEFAULT_MODEL,
                messages,
                temperature: options?.temperature ?? 0.3,
                max_tokens: options?.maxTokens ?? 1024,
            });

            return response.choices[0]?.message?.content?.trim() ?? "";
        },

        async chatJSON<T>(messages: Message[], options?: LLMOptions): Promise<T> {
            const response = await client.chat.completions.create({
                model: options?.model ?? DEFAULT_MODEL,
                messages,
                temperature: options?.temperature ?? 0,
                max_tokens: options?.maxTokens ?? 512,
                response_format: { type: "json_object" },
            });

            const content = response.choices[0]?.message?.content?.trim() ?? "{}";
            return JSON.parse(content) as T;
        },
    };
}

/**
 * Create a mock LLM client for testing (no API calls).
 */
export function createMockClient(
    responses: Map<string, string> | ((messages: Message[]) => string)
): LLMClient {
    const getResponse = (messages: Message[]): string => {
        if (typeof responses === "function") {
            return responses(messages);
        }
        // Match based on the last user message
        const lastUser = messages.filter(m => m.role === "user").pop();
        return responses.get(lastUser?.content ?? "") ?? "{}";
    };

    return {
        async chat(messages: Message[]): Promise<string> {
            return getResponse(messages);
        },
        async chatJSON<T>(messages: Message[]): Promise<T> {
            return JSON.parse(getResponse(messages)) as T;
        },
    };
}
