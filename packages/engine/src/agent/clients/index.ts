// ============================================================
// Production LLM client factory (Phase 6 WS1; updated Phase 8 B5)
// ============================================================
// Centralizes how the agent loop wires up real LLM clients in
// production. Phase 5 bakeoff picked `openai:gpt-4.1-mini` as the
// default primary; the Phase 8 25-question bake-off (after the
// architectural cleanup) selected `claude-haiku-4-5-20251001` as
// the new default primary based on:
//   - composite 4.42 (vs gpt-4.1-mini 4.00, gpt-4.1 3.95)
//   - 92% deterministic auto-pass rate (highest of any model)
//   - 5.1s median latency (essentially tied with mini's 5.3s)
//   - $26 estimated 4-week pilot cost (8x more than mini's $3,
//     but $53 less than sonnet's $79; the +$23 vs mini buys real
//     wins on Q18 / Q11 / Q15 — see bakeoff_phase8_summary.md)
//   - claude-sonnet-4-6 scored 4.54 (best) but at 3x the cost; the
//     0.12-point composite gap is within judge noise
//   - gpt-5 catastrophically failed (1.55 composite, 4% auto-pass)
//     — likely client-implementation issue (model expects
//     reasoning_effort param / Responses API); deferred to Phase 9
//
// Fallback stays `gpt-4.1-mini` (cheap, fast, decent quality) so
// that haiku errors don't tank the live turn.
//
// Both can be overridden via env vars without code changes (used by
// ops + the live-test harness).
//
// Env vars:
//   NYUPATH_PRIMARY_PROVIDER    "openai" | "anthropic"  (default: anthropic)
//   NYUPATH_PRIMARY_MODEL       e.g., "claude-haiku-4-5-20251001" (default)
//   NYUPATH_FALLBACK_PROVIDER   "openai" | "anthropic"  (default: openai)
//   NYUPATH_FALLBACK_MODEL      e.g., "gpt-4.1-mini" (default)
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

/** Defaults baked from MODEL_SELECTION.md.
 *  Phase 5 bakeoff: openai:gpt-4.1-mini primary.
 *  Phase 8 bakeoff (post-architectural-cleanup): swapped to
 *  anthropic:claude-haiku-4-5 primary; gpt-4.1-mini moved to fallback. */
export const DEFAULT_PRIMARY_PROVIDER = "anthropic" as const;
export const DEFAULT_PRIMARY_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_FALLBACK_PROVIDER = "openai" as const;
export const DEFAULT_FALLBACK_MODEL = "gpt-4.1-mini";

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
