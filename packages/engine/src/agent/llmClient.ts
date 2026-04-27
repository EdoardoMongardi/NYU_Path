// ============================================================
// LLMClient interface for the agent loop (Phase 5 §6)
// ============================================================
// Mirrors the bakeoff's LLMClient (`evals/llmClients.ts`) but lives in
// the engine package so tests don't pull in eval-only dependencies.
// Implementations: a thin OpenAI/Anthropic wrapper for production, a
// `RecordingLLMClient` that replays JSONL fixtures for unit tests.
// ============================================================

export interface LLMToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export interface LLMToolCall {
    /** Stable id assigned by the vendor; used to correlate tool_result back */
    id: string;
    name: string;
    args: Record<string, unknown>;
}

export interface LLMMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    /** Only present when role === "tool" */
    toolCallId?: string;
    /** Only present when role === "assistant" — tool calls the model issued */
    toolCalls?: LLMToolCall[];
}

export interface LLMCompletion {
    text: string;
    toolCalls: LLMToolCall[];
    latencyMs: number;
    usage?: { promptTokens?: number; completionTokens?: number };
    modelEcho?: string;
    /**
     * Phase 7-B Step 20 — vendor-neutral finish reason. Populated when
     * the underlying API surfaces one. The agent loop reads this to
     * trigger output-truncation recovery (`length`) and reactive
     * compaction (`context_length_exceeded` is signaled as an error,
     * not a finish reason — see runAgentTurn for that path).
     */
    finishReason?: "stop" | "length" | "tool_calls" | "content_filter" | "other";
}

export interface LLMClient {
    readonly id: string;
    complete(args: {
        system: string;
        messages: LLMMessage[];
        tools?: LLMToolDef[];
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    }): Promise<LLMCompletion>;
    /**
     * Phase 6.5 P-3 — optional intra-token streaming. When present,
     * the agent loop's `runAgentTurnStreaming` calls this instead of
     * `complete()` on the FINAL model turn (after all tools have
     * resolved) so the user sees text appear character-by-character.
     *
     * Tool-call deltas are NOT streamed — only text. When the model
     * issues tool_calls instead of a text reply, the stream emits a
     * single `done` event with the full completion (no tokens) and
     * the agent loop runs the tools as usual, then re-streams the
     * next turn's text.
     *
     * Implementations that don't support streaming MAY omit this
     * method; the agent loop falls back to `complete()` + a single
     * text_delta with the full text.
     */
    streamComplete?(args: {
        system: string;
        messages: LLMMessage[];
        tools?: LLMToolDef[];
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    }): AsyncGenerator<LLMStreamEvent, void, void>;
}

/**
 * Streaming events emitted by `LLMClient.streamComplete`. Tool-call
 * argument JSON is delivered fully-formed in the final `done` event
 * (no `tool_call_args_delta` events) — see the streamComplete
 * docstring for rationale.
 */
export type LLMStreamEvent =
    | { type: "text_delta"; text: string }
    | { type: "done"; completion: LLMCompletion };
