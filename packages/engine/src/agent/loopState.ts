// ============================================================
// LoopState (Phase 7-B Steps 14, 16, 19, 20)
// ============================================================
// Centralizes the per-conversation state the agent loop needs to
// track for the architecture-compliance gaps surfaced by the deep
// ARCHITECTURE.md audit:
//
//   §6.1   transition reason per iteration (Step 14)
//   §6     MAX_TOOL_RESULT_BUDGET enforcement (Step 16)
//   §6.4   maxOutputTokensRecoveryCount + hasAttemptedReactiveCompact (Step 20)
//   §9.1   validatorReplayLimit (Step 19)
//
// LoopState is internal to the agent loop. The ChatTurnResult that
// leaves the loop carries a `transitions` array so the v2 route +
// observability can introspect what happened.
// ============================================================

import type { LLMMessage } from "./llmClient.js";
import { type FallbackSink, emitFallback } from "../observability/fallbackLog.js";

export type TransitionReason =
    | "next_turn"
    | "stop_hook_retry"
    | "validation_retry"
    | "error_recovery"
    | "model_fallback"
    | "tool_results_compacted"
    | "session_compacted"
    | "context_limit_terminate"
    | "output_truncation_recovery"
    | "reactive_compact";

export interface TransitionRecord {
    iteration: number;
    reason: TransitionReason;
    /** When the reason is `validation_retry`, which validator violation kind triggered it. */
    detail?: string;
    /** Wall-clock ts the transition was emitted. */
    ts: string;
}

export interface LoopState {
    iteration: number;
    transitions: TransitionRecord[];
    /** Phase 7-B Step 19 — how many validator-driven re-prompts remain. */
    validatorReplaysRemaining: number;
    /** Phase 7-B Step 20 — how many output-truncation recoveries remain. */
    outputTruncationRecoveriesRemaining: number;
    /** Phase 7-B Step 20 — set true the first time the prompt-too-long
     *  reactive compaction fires for this conversation. */
    hasAttemptedReactiveCompact: boolean;
    /** Phase 7-B Step 17 — set true after Tier-2 fires so it doesn't
     *  loop on the next turn before we have new content. */
    hasFiredTier2Compaction: boolean;
}

export interface LoopStateOptions {
    /** §9.1: 1 means "one re-prompt per turn"; 0 disables re-prompts. */
    validatorReplayLimit?: number;
    /** §6.4 line 1066: 3 attempts per the architecture. */
    outputTruncationRecoveryLimit?: number;
}

export function createLoopState(opts: LoopStateOptions = {}): LoopState {
    return {
        iteration: 0,
        transitions: [],
        validatorReplaysRemaining: opts.validatorReplayLimit ?? 1,
        outputTruncationRecoveriesRemaining: opts.outputTruncationRecoveryLimit ?? 3,
        hasAttemptedReactiveCompact: false,
        hasFiredTier2Compaction: false,
    };
}

export function recordTransition(
    state: LoopState,
    reason: TransitionReason,
    sink: FallbackSink,
    detail?: string,
    correlationId?: string,
): void {
    const record: TransitionRecord = {
        iteration: state.iteration,
        reason,
        ts: new Date().toISOString(),
        ...(detail ? { detail } : {}),
    };
    state.transitions.push(record);
    emitFallback(sink, "transition", `iteration=${state.iteration} reason=${reason}${detail ? ` detail=${detail}` : ""}`, {
        correlationId,
        extra: { iteration: state.iteration, reason, ...(detail ? { detail } : {}) },
    });
}

// ============================================================
// MAX_TOOL_RESULT_BUDGET enforcement (Step 16 / §6 lines 953-975)
// ============================================================

/** §6 line 967 — character budget for aggregate tool_result content
 *  before older results are compacted. ~8000 tokens × 4 chars/token. */
export const MAX_TOOL_RESULT_BUDGET = 32_000;

/** Recent tool messages are kept verbatim; older ones get truncated.
 *  Per the architecture, the 2 most recent tool results stay full-fidelity. */
export const TOOL_RESULT_KEEP_RECENT = 2;

/**
 * Walk `messages` and shrink older `role: "tool"` content when the
 * aggregate exceeds MAX_TOOL_RESULT_BUDGET. Mutates `messages` in place
 * and returns the count of messages that were shrunk so the caller can
 * emit a `tool_results_compacted` transition. Per §6 lines 953-975.
 */
export function enforceToolResultBudget(messages: LLMMessage[]): number {
    const toolIdxs: number[] = [];
    let total = 0;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i]!.role === "tool") {
            toolIdxs.push(i);
            total += messages[i]!.content.length;
        }
    }
    if (total <= MAX_TOOL_RESULT_BUDGET || toolIdxs.length <= TOOL_RESULT_KEEP_RECENT) return 0;

    let compactedCount = 0;
    // Shrink from oldest forward; stop when we're under budget OR
    // we've reached the tail we want to preserve.
    const lastFullIdx = toolIdxs[toolIdxs.length - TOOL_RESULT_KEEP_RECENT]!;
    for (const idx of toolIdxs) {
        if (idx >= lastFullIdx) break;
        const msg = messages[idx]!;
        if (msg.content.length <= 200) continue; // already small; skip
        const truncated = msg.content.slice(0, 200) + ` …[older tool result truncated under MAX_TOOL_RESULT_BUDGET; ${msg.content.length - 200} chars elided]`;
        messages[idx] = { ...msg, content: truncated };
        compactedCount += 1;
        // Recompute and bail when we're under budget.
        total = messages.reduce((acc, m) => acc + (m.role === "tool" ? m.content.length : 0), 0);
        if (total <= MAX_TOOL_RESULT_BUDGET) break;
    }
    return compactedCount;
}

// ============================================================
// Token estimation (Steps 17, 18, 20) — §6.6 lines 1204-1221
// ============================================================
//
// Cheap heuristic: ~4 chars/token. Real callers can swap in a real
// tokenizer when accuracy matters (e.g., during the cohort A
// composite measurement). For Tier-2/3 trip points the heuristic is
// more than good enough — the architecture's 80%/95% guard rails
// have ample slack.

export function estimateTokens(messages: LLMMessage[], systemPrompt: string): number {
    let chars = systemPrompt.length;
    for (const m of messages) chars += m.content.length;
    return Math.ceil(chars / 4);
}

/** Default model-window assumptions (gpt-4.1-mini = 128k). Real
 *  callers should pass their own when they know the model. */
export const DEFAULT_MODEL_WINDOW_TOKENS = 128_000;
export const TIER2_TRIP_FRACTION = 0.80;
export const TIER3_TRIP_FRACTION = 0.95;

export interface ContextPressure {
    estimated: number;
    windowTokens: number;
    fraction: number;
    tier2: boolean;
    tier3: boolean;
}

export function measureContextPressure(
    messages: LLMMessage[],
    systemPrompt: string,
    windowTokens = DEFAULT_MODEL_WINDOW_TOKENS,
): ContextPressure {
    const estimated = estimateTokens(messages, systemPrompt);
    const fraction = estimated / windowTokens;
    return {
        estimated,
        windowTokens,
        fraction,
        tier2: fraction >= TIER2_TRIP_FRACTION,
        tier3: fraction >= TIER3_TRIP_FRACTION,
    };
}

// ============================================================
// Tier-2 conversation auto-compaction (Phase 7-B Step 17)
// ============================================================
// Replaces the prefix of `messages` with a single `system` message
// summarizing the dropped content. The most recent user message and
// the last K turns stay verbatim so the model has fresh context.
// The summarizer is the caller's responsibility — typically the
// agent loop's fallback (cheap) client.
//
// Returns the new messages array (does not mutate the input). The
// caller should swap the conversation reference and emit a
// `session_compacted` event.

export interface CompactConversationOptions {
    summarize: (toCompress: LLMMessage[]) => Promise<string>;
    /** Keep this many trailing messages verbatim. Default 6 (~3 turns). */
    keepTrailing?: number;
}

export async function compactConversation(
    messages: LLMMessage[],
    opts: CompactConversationOptions,
): Promise<LLMMessage[]> {
    const keepTrailing = opts.keepTrailing ?? 6;
    if (messages.length <= keepTrailing + 1) return messages;
    const head = messages.slice(0, messages.length - keepTrailing);
    const tail = messages.slice(messages.length - keepTrailing);
    const summary = await opts.summarize(head);
    return [
        {
            role: "system",
            content:
                "[Conversation auto-compacted under Tier-2 pressure. Earlier turns summarized below.]\n" +
                summary,
        },
        ...tail,
    ];
}

/** Cheap heuristic: a message body is identifiable as a 413 / context-
 *  length-exceeded error from common provider error strings. Lets the
 *  agent loop trigger reactive compaction without parsing vendor codes. */
export function isContextLengthExceededError(message: string): boolean {
    const m = message.toLowerCase();
    return (
        m.includes("context_length_exceeded")
        || m.includes("context length exceeded")
        || m.includes("maximum context length")
        || m.includes("too long for context")
        || m.includes("maximum allowed input")
        || m.includes("413")
    );
}
