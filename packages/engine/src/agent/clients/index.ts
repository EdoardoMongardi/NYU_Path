// ============================================================
// Production LLM client factory (Phase 6 WS1)
// ============================================================
// Centralizes how the agent loop wires up real LLM clients in
// production. Per `MODEL_SELECTION.md`, the Phase-5 bakeoff selected
// `openai:gpt-4.1-mini` as the default primary; Anthropic is the
// configured fallback. Both can be overridden via env vars without
// code changes (used by ops + the live-test harness).
//
// Env vars:
//   NYUPATH_PRIMARY_PROVIDER    "openai" | "anthropic"  (default: openai)
//   NYUPATH_PRIMARY_MODEL       e.g., "gpt-4.1-mini"     (default: gpt-4.1-mini)
//   NYUPATH_FALLBACK_PROVIDER   "openai" | "anthropic"  (default: anthropic)
//   NYUPATH_FALLBACK_MODEL      e.g., "claude-haiku-4-5-20251001" (default)
//   OPENAI_API_KEY              required to build an OpenAI client
//   ANTHROPIC_API_KEY           required to build an Anthropic client
//
// `createPrimaryClient(env?)` returns null when the configured
// provider's API key is absent — callers can use that signal to
// switch to a recording client / refuse to run live.
// ============================================================

import type { LLMClient } from "../llmClient.js";
import { OpenAIEngineClient } from "./openaiClient.js";
import { AnthropicEngineClient } from "./anthropicClient.js";

export { OpenAIEngineClient } from "./openaiClient.js";
export { AnthropicEngineClient } from "./anthropicClient.js";
export { toOpenAIMessage } from "./openaiClient.js";
export { toAnthropicMessage } from "./anthropicClient.js";
export type { OpenAIClientOptions } from "./openaiClient.js";
export type { AnthropicClientOptions } from "./anthropicClient.js";

/** Defaults baked from MODEL_SELECTION.md (Phase 5 bakeoff winner). */
export const DEFAULT_PRIMARY_PROVIDER = "openai" as const;
export const DEFAULT_PRIMARY_MODEL = "gpt-4.1-mini";
export const DEFAULT_FALLBACK_PROVIDER = "anthropic" as const;
export const DEFAULT_FALLBACK_MODEL = "claude-haiku-4-5-20251001";

type Env = Record<string, string | undefined>;

function buildClient(
    provider: string,
    modelId: string,
    env: Env,
): LLMClient | null {
    if (provider === "openai") {
        const apiKey = env.OPENAI_API_KEY;
        if (!apiKey) return null;
        return new OpenAIEngineClient({ modelId, apiKey });
    }
    if (provider === "anthropic") {
        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return null;
        return new AnthropicEngineClient({ modelId, apiKey });
    }
    throw new Error(`Unknown LLM provider: "${provider}"`);
}

/**
 * Build the production primary client. Returns null when the configured
 * provider's API key is absent.
 */
export function createPrimaryClient(env: Env = process.env): LLMClient | null {
    const provider = env.NYUPATH_PRIMARY_PROVIDER ?? DEFAULT_PRIMARY_PROVIDER;
    const modelId = env.NYUPATH_PRIMARY_MODEL ?? DEFAULT_PRIMARY_MODEL;
    return buildClient(provider, modelId, env);
}

/**
 * Build the production fallback client. Returns null when the configured
 * provider's API key is absent.
 */
export function createFallbackClient(env: Env = process.env): LLMClient | null {
    const provider = env.NYUPATH_FALLBACK_PROVIDER ?? DEFAULT_FALLBACK_PROVIDER;
    const modelId = env.NYUPATH_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL;
    return buildClient(provider, modelId, env);
}
