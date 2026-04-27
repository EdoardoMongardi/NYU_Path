// ============================================================
// Agent Loop (Phase 5 §6.4)
// ============================================================
// Runs the model→tool→model cycle until the model emits a final
// text-only reply, max turns is reached, or the user aborts.
//
// Inspired by the Claude Code QueryEngine.submitMessage / query
// generators (referenced in the leaked recovered-src/src/QueryEngine.ts
// + query.ts). Trimmed for NYU Path scope:
//   - One model fallback (architecture's design decision #6)
//   - No subagent escalation, no MCP, no permission elicitation
//   - No streaming UI; the loop returns a final ChatTurn record
//
// Public surface:
//   runAgentTurn(client, registry, session, userMessage, options) →
//     ChatTurnResult
//
// The loop never throws on terminal conditions — it returns a
// `ChatTurnResult.kind` that disambiguates "ok" / "max_turns" /
// "aborted" / "model_error_no_fallback". Validation/runtime errors
// inside a tool are returned to the model as a `tool` message; the
// loop DOES NOT swallow them silently.
// ============================================================

import type { z } from "zod";
import type {
    LLMClient,
    LLMCompletion,
    LLMMessage,
    LLMStreamEvent,
    LLMToolCall,
    LLMToolDef,
} from "./llmClient.js";
import type { Tool, ToolSession, ToolUseContext } from "./tool.js";
import type { ToolRegistry } from "./tool.js";
import { type FallbackSink, NULL_SINK, emitFallback } from "../observability/fallbackLog.js";
import {
    createLoopState,
    recordTransition,
    enforceToolResultBudget,
    measureContextPressure,
    compactConversation,
    isContextLengthExceededError,
    type LoopState,
    type TransitionRecord,
    type LoopStateOptions,
} from "./loopState.js";

export interface AgentTurnOptions extends LoopStateOptions {
    /** Max model→tool→model rounds before the loop bails. Default 10. */
    maxTurns?: number;
    /** Optional fallback LLM client used when the primary errors */
    fallbackClient?: LLMClient;
    /** Caller-supplied AbortSignal — when triggered, the loop terminates */
    signal?: AbortSignal;
    /** Conversation history before this turn (system + prior turns) */
    priorMessages?: LLMMessage[];
    /** System prompt — should already include the 25 rules */
    systemPrompt: string;
    /** Per-turn token cap. Default 1024. */
    maxTokens?: number;
    /**
     * Phase 6 WS4: structured-event sink for operational signals
     * (model fallback fired, max_turns hit, tool unsupported, etc.).
     * Default is a no-op sink so existing callers + unit tests are
     * unaffected. Production wires `defaultProductionSink(process.env)`.
     */
    fallbackSink?: FallbackSink;
    /** Optional correlation id stamped onto every emitted fallback event. */
    correlationId?: string;
    /**
     * Phase 7-B Step 19: callback invoked after the model produces a
     * final reply but before the loop returns. When provided AND the
     * verdict is `ok: false` AND `validatorReplaysRemaining > 0`, the
     * loop appends a system message describing the violations and
     * continues for one more pass. The architecture (§9.1) calls this
     * the "stop-hook re-prompt" pattern.
     */
    validateResponse?: (ctx: { assistantText: string; invocations: ToolInvocation[]; session: ToolSession }) => {
        ok: boolean;
        violations: Array<{ kind: string; detail: string }>;
    };
}

export interface ToolInvocation {
    toolName: string;
    args: Record<string, unknown>;
    /** Truthy when the tool's `validateInput` rejected the call */
    rejected?: { userMessage: string };
    /** Truthy when the tool ran and returned a result */
    summary?: string;
    /** Truthy when the tool threw mid-call */
    error?: { message: string };
    /** Wall-clock ms spent inside `tool.call()` (validation excluded) */
    callMs?: number;
    /** Phase 7-B Step 15 — verbatim text the LLM is required to include
     *  in the final reply when the tool's outputMode is "semi_hardened". */
    verbatimText?: string;
}

export type ChatTurnResult =
    | {
        kind: "ok";
        finalText: string;
        invocations: ToolInvocation[];
        /** All messages exchanged THIS turn (model + tool messages) */
        turnMessages: LLMMessage[];
        usage: { promptTokens: number; completionTokens: number };
        modelUsedId: string;
        /** Phase 7-B Step 14 — chronological list of loop transitions. */
        transitions: TransitionRecord[];
    }
    | {
        kind: "max_turns";
        invocations: ToolInvocation[];
        turnMessages: LLMMessage[];
        modelUsedId: string;
        transitions: TransitionRecord[];
    }
    | {
        kind: "aborted";
        invocations: ToolInvocation[];
        turnMessages: LLMMessage[];
        modelUsedId: string;
        transitions: TransitionRecord[];
    }
    | {
        kind: "model_error_no_fallback";
        error: string;
        invocations: ToolInvocation[];
        turnMessages: LLMMessage[];
        modelUsedId: string;
        transitions: TransitionRecord[];
    }
    | {
        /** Phase 7-B Step 18 — Tier-3 graceful termination. */
        kind: "context_limit";
        finalText: string;
        invocations: ToolInvocation[];
        turnMessages: LLMMessage[];
        modelUsedId: string;
        transitions: TransitionRecord[];
    };

/**
 * Run a single user message through the agent loop. Stateless w.r.t. the
 * client — the caller manages session/history persistence.
 */
export async function runAgentTurn(
    client: LLMClient,
    registry: ToolRegistry,
    session: ToolSession,
    userMessage: string,
    options: AgentTurnOptions,
): Promise<ChatTurnResult> {
    const maxTurns = options.maxTurns ?? 10;
    const tools = toLLMToolDefs(registry, session);
    const sink = options.fallbackSink ?? NULL_SINK;
    const correlationId = options.correlationId;
    const conversation: LLMMessage[] = [
        ...(options.priorMessages ?? []),
        { role: "user", content: userMessage },
    ];
    const turnMessages: LLMMessage[] = [{ role: "user", content: userMessage }];
    const invocations: ToolInvocation[] = [];
    const totalUsage = { promptTokens: 0, completionTokens: 0 };
    let modelUsedId = client.id;
    const state = createLoopState(options);

    for (let turn = 0; turn < maxTurns; turn++) {
        state.iteration = turn;
        if (options.signal?.aborted) {
            return { kind: "aborted", invocations, turnMessages, modelUsedId, transitions: state.transitions };
        }

        // Phase 7-B Step 18 — Tier-3 graceful termination. Check BEFORE
        // any model call so we don't spend a (likely 413-prone) round
        // trip when we already know context is at 95%+.
        const pressure = measureContextPressure(conversation, options.systemPrompt);
        if (pressure.tier3) {
            recordTransition(state, "context_limit_terminate", sink, `fraction=${pressure.fraction.toFixed(3)}`, correlationId);
            emitFallback(sink, "context_limit_terminate", `Tier-3 trip at fraction=${pressure.fraction.toFixed(3)}; terminating turn so the user can start fresh.`, {
                correlationId,
                modelId: modelUsedId,
                extra: { ...pressure },
            });
            const finalText =
                "I'm running out of context for this conversation. " +
                "Please start a new chat with the question you'd like me to focus on — " +
                "I'll have your prior session summary loaded so we don't lose progress.";
            return { kind: "context_limit", finalText, invocations, turnMessages, modelUsedId, transitions: state.transitions };
        }

        // Phase 7-B Step 17 — Tier-2 auto-compaction. Fires once per
        // turn at 80% context pressure, IFF a fallback client is
        // available to do the cheap summarization call.
        if (pressure.tier2 && !state.hasFiredTier2Compaction && options.fallbackClient) {
            const compacted = await tryTier2Compact(conversation, options.fallbackClient, options.systemPrompt, options.signal);
            if (compacted) {
                conversation.length = 0;
                conversation.push(...compacted);
                state.hasFiredTier2Compaction = true;
                recordTransition(state, "session_compacted", sink, `fraction=${pressure.fraction.toFixed(3)}`, correlationId);
                emitFallback(sink, "session_compacted", `Tier-2 compaction at fraction=${pressure.fraction.toFixed(3)}; older turns summarized.`, {
                    correlationId,
                    modelId: modelUsedId,
                    extra: { ...pressure },
                });
            }
        }

        // Phase 7-B Step 16 — apply MAX_TOOL_RESULT_BUDGET before each
        // model call so we don't pay the round-trip cost on bloated
        // tool_result history. Counts characters (not tokens) per the
        // architecture's §6 recipe.
        const compactedCount = enforceToolResultBudget(conversation);
        if (compactedCount > 0) {
            recordTransition(state, "tool_results_compacted", sink, `count=${compactedCount}`, correlationId);
            emitFallback(sink, "tool_results_compacted", `${compactedCount} older tool result(s) truncated under MAX_TOOL_RESULT_BUDGET.`, {
                correlationId,
                modelId: modelUsedId,
                extra: { count: compactedCount },
            });
        }

        recordTransition(state, "next_turn", sink, undefined, correlationId);

        // Phase 7-B Step 20 — reactive compact path. We probe the
        // primary client BEFORE callWithFallback so a context-length
        // error doesn't get swallowed by the fallback (which is also
        // our summarizer). On detection, run Tier-2 compact + retry
        // primary once. If reactive-compact already fired for this
        // conversation, skip directly to the fallback path.
        let perCallMaxTokens = options.maxTokens ?? 1024;
        const callArgs = {
            system: options.systemPrompt,
            messages: conversation,
            tools,
            maxTokens: perCallMaxTokens,
            temperature: 0,
            signal: options.signal,
        };
        let completionResult: Awaited<ReturnType<typeof callWithFallback>>;
        let primaryError: string | null = null;
        try {
            const primary = await client.complete(callArgs);
            completionResult = { ok: true, completion: primary, usedClientId: client.id };
        } catch (e) {
            primaryError = e instanceof Error ? e.message : String(e);
            if (
                isContextLengthExceededError(primaryError)
                && !state.hasAttemptedReactiveCompact
                && options.fallbackClient
            ) {
                const compacted = await tryTier2Compact(conversation, options.fallbackClient, options.systemPrompt, options.signal);
                if (compacted) {
                    conversation.length = 0;
                    conversation.push(...compacted);
                    state.hasAttemptedReactiveCompact = true;
                    state.hasFiredTier2Compaction = true;
                    recordTransition(state, "reactive_compact", sink, "context_length_exceeded", correlationId);
                    emitFallback(sink, "reactive_compact", "Model returned context_length_exceeded; reactive compaction fired and retrying once.", {
                        correlationId,
                        modelId: client.id,
                    });
                    try {
                        const retried = await client.complete({ ...callArgs, messages: conversation });
                        completionResult = { ok: true, completion: retried, usedClientId: client.id };
                    } catch (e2) {
                        completionResult = await callWithFallback(client, options.fallbackClient, { ...callArgs, messages: conversation });
                        // If even fallback fails, surface the original error context.
                        if (!completionResult.ok) {
                            completionResult = { ok: false, error: `Primary "${client.id}" errored after reactive compact: ${e2 instanceof Error ? e2.message : String(e2)}` };
                        }
                    }
                } else {
                    completionResult = await callWithFallback(client, options.fallbackClient, callArgs);
                }
            } else {
                completionResult = await callWithFallback(client, options.fallbackClient, callArgs);
            }
        }

        // Phase 7-B Step 20 — output-truncation recovery loop. When
        // the model returns finish_reason: "length", retry with
        // doubled max_tokens up to N attempts.
        while (
            completionResult.ok
            && completionResult.completion.finishReason === "length"
            && completionResult.completion.toolCalls.length === 0
            && state.outputTruncationRecoveriesRemaining > 0
        ) {
            state.outputTruncationRecoveriesRemaining -= 1;
            perCallMaxTokens = Math.min(perCallMaxTokens * 2, 16_384);
            recordTransition(state, "output_truncation_recovery", sink, `attempt=${(options.outputTruncationRecoveryLimit ?? 3) - state.outputTruncationRecoveriesRemaining} max_tokens=${perCallMaxTokens}`, correlationId);
            emitFallback(sink, "output_truncation_recovery", `finish_reason=length; doubling max_tokens to ${perCallMaxTokens}; ${state.outputTruncationRecoveriesRemaining} retries remaining.`, {
                correlationId,
                modelId: completionResult.usedClientId,
                extra: { maxTokens: perCallMaxTokens, remaining: state.outputTruncationRecoveriesRemaining },
            });
            const continuation: LLMMessage = {
                role: "user",
                content: "Continue from where you left off. Do not repeat earlier text.",
            };
            const retryConv = [...conversation, {
                role: "assistant" as const,
                content: completionResult.completion.text,
            }, continuation];
            completionResult = await callWithFallback(
                client,
                options.fallbackClient,
                {
                    system: options.systemPrompt,
                    messages: retryConv,
                    tools,
                    maxTokens: perCallMaxTokens,
                    temperature: 0,
                    signal: options.signal,
                },
            );
            if (completionResult.ok) {
                // Stitch the recovered text onto the original.
                completionResult = {
                    ok: true,
                    completion: {
                        ...completionResult.completion,
                        text: completionResult.completion.text,
                    },
                    usedClientId: completionResult.usedClientId,
                };
            }
        }
        if (!completionResult.ok) {
            emitFallback(sink, "model_error_no_fallback", completionResult.error, {
                correlationId,
                modelId: client.id,
            });
            return {
                kind: "model_error_no_fallback",
                error: completionResult.error,
                invocations,
                turnMessages,
                modelUsedId,
                transitions: state.transitions,
            };
        }
        const completion = completionResult.completion;
        // Phase 6 WS4: emit when the fallback was used (primary failed
        // and the fallback succeeded). callWithFallback signals this
        // by `usedClientId !== client.id`.
        if (completionResult.usedClientId !== client.id) {
            emitFallback(sink, "model_fallback_triggered", `Primary "${client.id}" errored; recovered via fallback "${completionResult.usedClientId}".`, {
                correlationId,
                modelId: client.id,
            });
            recordTransition(state, "model_fallback", sink, `to=${completionResult.usedClientId}`, correlationId);
        }
        modelUsedId = completionResult.usedClientId;
        if (completion.usage?.promptTokens) totalUsage.promptTokens += completion.usage.promptTokens;
        if (completion.usage?.completionTokens) totalUsage.completionTokens += completion.usage.completionTokens;

        // Record assistant message into the running conversation
        const assistantMsg: LLMMessage = {
            role: "assistant",
            content: completion.text,
            toolCalls: completion.toolCalls.length > 0 ? completion.toolCalls : undefined,
        };
        conversation.push(assistantMsg);
        turnMessages.push(assistantMsg);

        // No tool calls → final reply (subject to validator replay).
        if (completion.toolCalls.length === 0) {
            const replayed = maybeQueueValidatorReplay({
                state,
                sink,
                correlationId,
                conversation,
                turnMessages,
                invocations,
                session,
                assistantText: completion.text,
                validateResponse: options.validateResponse,
            });
            if (replayed) {
                continue;
            }
            return {
                kind: "ok",
                finalText: completion.text,
                invocations,
                turnMessages,
                usage: totalUsage,
                modelUsedId,
                transitions: state.transitions,
            };
        }

        // Execute every tool call in order. Tool errors are reported back
        // to the model so it can decide how to proceed.
        for (const tc of completion.toolCalls) {
            if (options.signal?.aborted) {
                return { kind: "aborted", invocations, turnMessages, modelUsedId, transitions: state.transitions };
            }
            const tool = registry.get(tc.name);
            if (!tool) {
                const msg = `Tool "${tc.name}" not found in registry. Available: ${registry.list().map((t) => t.name).join(", ")}`;
                emitFallback(sink, "tool_unsupported", msg, {
                    correlationId,
                    toolName: tc.name,
                });
                pushToolMessage(conversation, turnMessages, tc.id, msg);
                invocations.push({ toolName: tc.name, args: tc.args, error: { message: msg } });
                continue;
            }
            const invocation = await executeTool(tool, tc, session, options.signal);
            invocations.push(invocation);
            // Phase 6 WS6 (wave5 finding #3): the model-facing summary
            // for `validateInput` rejections includes "validation
            // failed:" so the response validator + recording matchers
            // can recognize the rejection class. Both `rejected.userMessage`
            // (clean original) and `error.message` (wrapped) are
            // populated by executeTool; we pick the wrapped form here.
            const summary = invocation.summary
                ?? invocation.error?.message
                ?? invocation.rejected?.userMessage
                ?? "(no result)";
            pushToolMessage(conversation, turnMessages, tc.id, summary);
        }
    }

    emitFallback(sink, "max_turns", `Agent loop exhausted ${maxTurns} turns without producing a final reply.`, {
        correlationId,
        modelId: modelUsedId,
        extra: { maxTurns, invocationCount: invocations.length },
    });
    return { kind: "max_turns", invocations, turnMessages, modelUsedId, transitions: state.transitions };
}

// ============================================================
// Validator-driven re-prompt (Phase 7-B Step 19 / §9.1)
// ============================================================
// When the response validator rejects the model's final reply AND
// `validatorReplaysRemaining > 0`, we append a system message
// describing the violations so the model can self-correct on the
// next iteration. Mirrors Claude Code's stop-hook blocking-error
// pattern (query.ts L1267-1306). The replay budget defaults to 1
// per architecture's locked decision.
// ============================================================
function maybeQueueValidatorReplay(args: {
    state: LoopState;
    sink: FallbackSink;
    correlationId?: string;
    conversation: LLMMessage[];
    turnMessages: LLMMessage[];
    invocations: ToolInvocation[];
    session: ToolSession;
    assistantText: string;
    validateResponse?: AgentTurnOptions["validateResponse"];
}): boolean {
    const { state, sink, correlationId, conversation, turnMessages, invocations, session, assistantText, validateResponse } = args;
    if (!validateResponse) return false;
    // Always validate (so the caller's metrics + observability fire on
    // every reply); only replay when budget remains.
    const verdict = validateResponse({ assistantText, invocations, session });
    if (verdict.ok) return false;
    if (state.validatorReplaysRemaining <= 0) return false;

    state.validatorReplaysRemaining -= 1;
    const detail = verdict.violations.map((v) => `${v.kind}: ${v.detail}`).join(" | ");
    recordTransition(state, "validation_retry", sink, detail, correlationId);
    emitFallback(sink, "validator_replay", `Validator rejected reply; one replay attempt remaining=${state.validatorReplaysRemaining}.`, {
        correlationId,
        extra: { violations: verdict.violations, remaining: state.validatorReplaysRemaining },
    });
    const reprompt: LLMMessage = {
        role: "system",
        content:
            "Your previous reply was REJECTED by the response validator with the following violations:\n" +
            verdict.violations.map((v) => `- [${v.kind}] ${v.detail}`).join("\n") +
            "\n\nReturn a CORRECTED reply. Ground every numerical claim in a tool result this turn, " +
            "do not synthesize numbers, and add any required caveats.",
    };
    conversation.push(reprompt);
    turnMessages.push(reprompt);
    return true;
}

// ============================================================
// Helpers
// ============================================================

function pushToolMessage(
    conversation: LLMMessage[],
    turnMessages: LLMMessage[],
    toolCallId: string,
    content: string,
): void {
    const msg: LLMMessage = { role: "tool", content, toolCallId };
    conversation.push(msg);
    turnMessages.push(msg);
}

async function executeTool(
    tool: Tool<z.ZodTypeAny, unknown>,
    tc: LLMToolCall,
    session: ToolSession,
    signal?: AbortSignal,
): Promise<ToolInvocation> {
    const ctx: ToolUseContext = { signal: signal ?? new AbortController().signal, session };

    // Zod-validate the input
    const parsed = tool.inputSchema.safeParse(tc.args);
    if (!parsed.success) {
        return {
            toolName: tc.name,
            args: tc.args,
            error: {
                message:
                    `Input validation failed for ${tc.name}: ` +
                    parsed.error.issues
                        .map((i) => `${i.path.join(".")}: ${i.message}`)
                        .join("; "),
            },
        };
    }

    // Tool-specific validation (e.g., "needs a profile loaded")
    if (tool.validateInput) {
        const v = await tool.validateInput(parsed.data, ctx);
        if (!v.ok) {
            return {
                toolName: tc.name,
                args: tc.args,
                rejected: { userMessage: v.userMessage },
                // Phase 6 WS6: also surface a wrapped `error.message`
                // so observability + test consumers see a unified
                // "validation failed:" prefix for both Zod and tool-
                // specific rejections.
                error: { message: `validation failed: ${v.userMessage}` },
            };
        }
    }

    // §6.4 error recovery cascade (Phase 7-A P-4).
    //   1. Transient errors (network/timeout) → retry once.
    //   2. Tool-unsupported errors → return a structured "not in
    //      system" message the model can route to a contact.
    //   3. Other errors → graceful "encountered an unexpected
    //      issue" wrapper that includes the tool name.
    const startedAt = Date.now();
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (ctx.signal.aborted) {
            return {
                toolName: tc.name,
                args: tc.args,
                error: { message: `Tool "${tc.name}" aborted by signal.` },
                callMs: Date.now() - startedAt,
            };
        }
        try {
            const out = await tool.call(parsed.data, ctx);
            const summary = tool.summarizeResult(out);
            const verbatim = tool.outputMode === "semi_hardened" && tool.extractVerbatim
                ? tool.extractVerbatim(out)
                : null;
            return {
                toolName: tc.name,
                args: tc.args,
                summary,
                callMs: Date.now() - startedAt,
                ...(verbatim ? { verbatimText: verbatim } : {}),
            };
        } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            // Only retry transient errors (network / timeout / 5xx).
            // Validation errors (the model passing bad args) and
            // tool_unsupported errors (deterministic refusals) should
            // surface immediately so the model can adapt.
            if (attempt === 0 && isTransient(lastError)) {
                // Brief backoff before the second attempt.
                await new Promise((r) => setTimeout(r, 100));
                continue;
            }
            break;
        }
    }
    const message = lastError?.message ?? "(unknown)";
    if (/\bunsupported\b|not in system|no data for/i.test(message)) {
        // Surface as a structured tool_unsupported response per §6.4.
        return {
            toolName: tc.name,
            args: tc.args,
            error: {
                message:
                    `tool_unsupported: ${message}. ` +
                    `Tell the student you don't have data for this yet ` +
                    `and provide the appropriate NYU contact.`,
            },
            callMs: Date.now() - startedAt,
        };
    }
    return {
        toolName: tc.name,
        args: tc.args,
        error: {
            message:
                `Tool "${tc.name}" encountered an unexpected issue: ${message}. ` +
                `If retrying, suggest the student try again in a moment.`,
        },
        callMs: Date.now() - startedAt,
    };
}

/**
 * Phase 7-B Step 17 — runs the cheap LLM call that summarizes the
 * conversation prefix. Returns the new conversation array on success
 * or `null` when the summarizer itself fails (we never want a busted
 * summary call to break the live turn).
 */
async function tryTier2Compact(
    conversation: LLMMessage[],
    summarizer: LLMClient,
    _systemPrompt: string,
    signal?: AbortSignal,
): Promise<LLMMessage[] | null> {
    try {
        return await compactConversation(conversation, {
            keepTrailing: 6,
            summarize: async (head) => {
                const condensed = head
                    .map((m) => `[${m.role}]: ${m.content.slice(0, 800)}`)
                    .join("\n\n");
                const result = await summarizer.complete({
                    system:
                        "Summarize the following advising conversation segment in 6-12 bullets, " +
                        "preserving every fact the student or assistant established about courses, " +
                        "GPA, declared programs, deadlines, and visa status. Do not invent details.",
                    messages: [{ role: "user", content: condensed }],
                    maxTokens: 800,
                    temperature: 0,
                    signal,
                });
                return result.text;
            },
        });
    } catch {
        return null;
    }
}

/** Heuristic: errors that are worth retrying once. */
function isTransient(err: Error): boolean {
    const m = err.message.toLowerCase();
    return (
        m.includes("etimedout")
        || m.includes("econnreset")
        || m.includes("network")
        || m.includes("timeout")
        || m.includes("temporarily unavailable")
        || m.includes("503")
        || m.includes("502")
        || m.includes("504")
        || m.includes("rate limit")
    );
}

async function callWithFallback(
    primary: LLMClient,
    fallback: LLMClient | undefined,
    args: Parameters<LLMClient["complete"]>[0],
): Promise<
    | { ok: true; completion: Awaited<ReturnType<LLMClient["complete"]>>; usedClientId: string }
    | { ok: false; error: string }
> {
    try {
        const completion = await primary.complete(args);
        return { ok: true, completion, usedClientId: primary.id };
    } catch (e) {
        const primaryErr = e instanceof Error ? e.message : String(e);
        if (!fallback) {
            return { ok: false, error: `Primary model "${primary.id}" errored: ${primaryErr}` };
        }
        try {
            const completion = await fallback.complete(args);
            return { ok: true, completion, usedClientId: fallback.id };
        } catch (e2) {
            const fbErr = e2 instanceof Error ? e2.message : String(e2);
            return {
                ok: false,
                error:
                    `Primary "${primary.id}" errored: ${primaryErr}. ` +
                    `Fallback "${fallback.id}" errored: ${fbErr}`,
            };
        }
    }
}

/**
 * Convert the registry's tools into the vendor-neutral
 * `LLMToolDef` shape the LLMClient expects. Uses each tool's Zod
 * schema → JSON-schema-shaped `parameters`. Falls back to a permissive
 * object schema when the Zod schema can't be cleanly reflected.
 */
function toLLMToolDefs(registry: ToolRegistry, session: ToolSession): LLMToolDef[] {
    return registry.list().map((tool) => ({
        name: tool.name,
        description: `${tool.description}\n\n${tool.prompt({ session })}`,
        parameters: zodToJsonSchema(tool.inputSchema),
    }));
}

/**
 * Minimal Zod → JSON-schema converter for the bakeoff/agent's tool
 * descriptors. Handles the shapes the 6 NYU Path tools use; falls back
 * to `{type:"object"}` for anything more exotic. Intentionally lightweight
 * — production should swap in `zod-to-json-schema` if richer shapes
 * appear.
 */
function zodToJsonSchema(schema: unknown): Record<string, unknown> {
    const z = schema as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } };
    const typeName = z._def?.typeName;
    if (typeName === "ZodObject") {
        const shape = z._def!.shape!();
        const properties: Record<string, unknown> = {};
        const required: string[] = [];
        for (const [k, v] of Object.entries(shape)) {
            const innerName = (v as { _def?: { typeName?: string; innerType?: unknown } })._def?.typeName;
            const isOptional = innerName === "ZodOptional" || innerName === "ZodDefault";
            properties[k] = describeZodLeaf(v);
            if (!isOptional) required.push(k);
        }
        return { type: "object", properties, required, additionalProperties: false };
    }
    if (typeName === "ZodDiscriminatedUnion") {
        // For the update_profile tool — accept any object.
        return { type: "object" };
    }
    return { type: "object" };
}

function describeZodLeaf(v: unknown): Record<string, unknown> {
    const z = v as { _def?: { typeName?: string; innerType?: unknown } };
    const t = z._def?.typeName;
    if (t === "ZodOptional" || t === "ZodDefault") return describeZodLeaf(z._def!.innerType);
    if (t === "ZodString") return { type: "string" };
    if (t === "ZodNumber") return { type: "number" };
    if (t === "ZodBoolean") return { type: "boolean" };
    if (t === "ZodArray") return { type: "array", items: describeZodLeaf((z._def as unknown as { type: unknown }).type) };
    if (t === "ZodEnum") return { type: "string" };
    return {};
}

// ============================================================
// runAgentTurnStreaming (Phase 6.5 P-3)
// ============================================================
// Generator variant of `runAgentTurn` that yields lifecycle events
// per turn — including `text_delta` events emitted character-by-
// character on the FINAL model turn (after all tools have resolved
// and the model is producing the user-facing reply).
//
// Event order across a typical turn:
//   1. tool_invocation_start / _done × N (per tool the model calls)
//   2. text_delta × M (final reply tokens)
//   3. done (terminal — yields the full ChatTurnResult)
//
// For non-streaming clients (`client.streamComplete` undefined), the
// loop falls back to `complete()` and emits a single `text_delta`
// with the full text. Block-streaming v2 routes get the same wire
// shape, just one big chunk instead of many small ones.
// ============================================================

export type AgentStreamEvent =
    | { type: "tool_invocation_start"; toolName: string; args: Record<string, unknown> }
    | { type: "tool_invocation_done"; invocation: ToolInvocation }
    | { type: "text_delta"; text: string }
    | { type: "done"; result: ChatTurnResult };

export async function* runAgentTurnStreaming(
    client: LLMClient,
    registry: ToolRegistry,
    session: ToolSession,
    userMessage: string,
    options: AgentTurnOptions,
): AsyncGenerator<AgentStreamEvent, void, void> {
    const maxTurns = options.maxTurns ?? 10;
    const tools = toLLMToolDefs(registry, session);
    const sink = options.fallbackSink ?? NULL_SINK;
    const correlationId = options.correlationId;
    const conversation: LLMMessage[] = [
        ...(options.priorMessages ?? []),
        { role: "user", content: userMessage },
    ];
    const turnMessages: LLMMessage[] = [{ role: "user", content: userMessage }];
    const invocations: ToolInvocation[] = [];
    const totalUsage = { promptTokens: 0, completionTokens: 0 };
    let modelUsedId = client.id;
    const state = createLoopState(options);

    for (let turn = 0; turn < maxTurns; turn++) {
        state.iteration = turn;
        if (options.signal?.aborted) {
            const result: ChatTurnResult = { kind: "aborted", invocations, turnMessages, modelUsedId, transitions: state.transitions };
            yield { type: "done", result };
            return;
        }

        // Phase 7-B Step 18 — Tier-3 graceful termination.
        const pressure = measureContextPressure(conversation, options.systemPrompt);
        if (pressure.tier3) {
            recordTransition(state, "context_limit_terminate", sink, `fraction=${pressure.fraction.toFixed(3)}`, correlationId);
            emitFallback(sink, "context_limit_terminate", `Tier-3 trip at fraction=${pressure.fraction.toFixed(3)}; terminating turn.`, {
                correlationId,
                modelId: modelUsedId,
                extra: { ...pressure },
            });
            const finalText =
                "I'm running out of context for this conversation. " +
                "Please start a new chat with the question you'd like me to focus on — " +
                "I'll have your prior session summary loaded so we don't lose progress.";
            yield { type: "text_delta", text: finalText };
            const result: ChatTurnResult = { kind: "context_limit", finalText, invocations, turnMessages, modelUsedId, transitions: state.transitions };
            yield { type: "done", result };
            return;
        }

        // Phase 7-B Step 17 — Tier-2 auto-compaction (streaming variant).
        if (pressure.tier2 && !state.hasFiredTier2Compaction && options.fallbackClient) {
            const compacted = await tryTier2Compact(conversation, options.fallbackClient, options.systemPrompt, options.signal);
            if (compacted) {
                conversation.length = 0;
                conversation.push(...compacted);
                state.hasFiredTier2Compaction = true;
                recordTransition(state, "session_compacted", sink, `fraction=${pressure.fraction.toFixed(3)}`, correlationId);
                emitFallback(sink, "session_compacted", `Tier-2 compaction at fraction=${pressure.fraction.toFixed(3)}; older turns summarized.`, {
                    correlationId,
                    modelId: modelUsedId,
                    extra: { ...pressure },
                });
            }
        }

        // Phase 7-B Step 16 — MAX_TOOL_RESULT_BUDGET enforcement.
        const compactedCount = enforceToolResultBudget(conversation);
        if (compactedCount > 0) {
            recordTransition(state, "tool_results_compacted", sink, `count=${compactedCount}`, correlationId);
            emitFallback(sink, "tool_results_compacted", `${compactedCount} older tool result(s) truncated under MAX_TOOL_RESULT_BUDGET.`, {
                correlationId,
                modelId: modelUsedId,
                extra: { count: compactedCount },
            });
        }

        recordTransition(state, "next_turn", sink, undefined, correlationId);

        // Stream the turn directly (text deltas pass through); tool
        // calls land in the final completion. If streamComplete isn't
        // implemented by the client, fall back to complete() which
        // produces a single block of text we yield as one delta.
        const args: Parameters<NonNullable<LLMClient["streamComplete"]>>[0] = {
            system: options.systemPrompt,
            messages: conversation,
            tools,
            maxTokens: options.maxTokens ?? 1024,
            temperature: 0,
            signal: options.signal,
        };

        const bufferedDeltas: string[] = [];
        let runResult:
            | { ok: true; completion: LLMCompletion; usedClientId: string; fallbackTriggered: boolean }
            | { ok: false; error: string };
        try {
            const primaryEvents = await runOneTurn(client, args, bufferedDeltas);
            if (primaryEvents.ok) {
                runResult = { ok: true, completion: primaryEvents.completion, usedClientId: client.id, fallbackTriggered: false };
            } else if (options.fallbackClient) {
                bufferedDeltas.length = 0; // discard any partial primary deltas before fallback
                const fbEvents = await runOneTurn(options.fallbackClient, args, bufferedDeltas);
                if (fbEvents.ok) {
                    runResult = { ok: true, completion: fbEvents.completion, usedClientId: options.fallbackClient.id, fallbackTriggered: true };
                } else {
                    runResult = { ok: false, error: `Primary "${client.id}" errored: ${primaryEvents.error}; fallback "${options.fallbackClient.id}" errored: ${fbEvents.error}` };
                }
            } else {
                runResult = { ok: false, error: `Primary model "${client.id}" errored: ${primaryEvents.error}` };
            }
        } catch (e) {
            runResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }

        if (!runResult.ok) {
            emitFallback(sink, "model_error_no_fallback", runResult.error, {
                correlationId,
                modelId: client.id,
            });
            const result: ChatTurnResult = {
                kind: "model_error_no_fallback",
                error: runResult.error,
                invocations,
                turnMessages,
                modelUsedId,
                transitions: state.transitions,
            };
            yield { type: "done", result };
            return;
        }

        if (runResult.fallbackTriggered) {
            emitFallback(sink, "model_fallback_triggered", `Primary "${client.id}" errored; recovered via fallback "${runResult.usedClientId}".`, {
                correlationId,
                modelId: client.id,
            });
            recordTransition(state, "model_fallback", sink, `to=${runResult.usedClientId}`, correlationId);
        }
        modelUsedId = runResult.usedClientId;
        const c = runResult.completion;
        if (c.usage?.promptTokens) totalUsage.promptTokens += c.usage.promptTokens;
        if (c.usage?.completionTokens) totalUsage.completionTokens += c.usage.completionTokens;

        const assistantMsg: LLMMessage = {
            role: "assistant",
            content: c.text,
            toolCalls: c.toolCalls.length > 0 ? c.toolCalls : undefined,
        };
        conversation.push(assistantMsg);
        turnMessages.push(assistantMsg);

        // Final reply (no tool calls): emit text deltas to the consumer.
        if (c.toolCalls.length === 0) {
            const replayed = maybeQueueValidatorReplay({
                state,
                sink,
                correlationId,
                conversation,
                turnMessages,
                invocations,
                session,
                assistantText: c.text,
                validateResponse: options.validateResponse,
            });
            if (replayed) {
                // Drop the deltas; we'll regenerate on the next turn.
                continue;
            }
            // Flush any deltas the streaming client emitted.
            for (const d of bufferedDeltas) yield { type: "text_delta", text: d };
            // If the client had no streamComplete (synthetic path),
            // bufferedDeltas is empty and we yield the full text as a
            // single delta so v2-route consumers see one token event.
            if (bufferedDeltas.length === 0 && c.text.length > 0) {
                yield { type: "text_delta", text: c.text };
            }
            const result: ChatTurnResult = {
                kind: "ok",
                finalText: c.text,
                invocations,
                turnMessages,
                usage: totalUsage,
                modelUsedId,
                transitions: state.transitions,
            };
            yield { type: "done", result };
            return;
        }
        // Tool-call turn: any incidental text the model produced
        // alongside tool_calls is preserved on assistantMsg but NOT
        // emitted as text_delta (the user gets the final reply on a
        // later turn after tools resolve).

        // Tool-call turn: execute every tool sequentially.
        for (const tc of c.toolCalls) {
            if (options.signal?.aborted) {
                const result: ChatTurnResult = { kind: "aborted", invocations, turnMessages, modelUsedId, transitions: state.transitions };
                yield { type: "done", result };
                return;
            }
            yield { type: "tool_invocation_start", toolName: tc.name, args: tc.args };
            const tool = registry.get(tc.name);
            if (!tool) {
                const msg = `Tool "${tc.name}" not found in registry. Available: ${registry.list().map((t) => t.name).join(", ")}`;
                emitFallback(sink, "tool_unsupported", msg, { correlationId, toolName: tc.name });
                pushToolMessage(conversation, turnMessages, tc.id, msg);
                const inv: ToolInvocation = { toolName: tc.name, args: tc.args, error: { message: msg } };
                invocations.push(inv);
                yield { type: "tool_invocation_done", invocation: inv };
                continue;
            }
            const inv = await executeTool(tool, tc, session, options.signal);
            invocations.push(inv);
            const summary = inv.summary ?? inv.error?.message ?? inv.rejected?.userMessage ?? "(no result)";
            pushToolMessage(conversation, turnMessages, tc.id, summary);
            yield { type: "tool_invocation_done", invocation: inv };
        }
    }

    emitFallback(sink, "max_turns", `Agent loop exhausted ${maxTurns} turns without producing a final reply.`, {
        correlationId,
        modelId: modelUsedId,
        extra: { maxTurns, invocationCount: invocations.length },
    });
    const result: ChatTurnResult = { kind: "max_turns", invocations, turnMessages, modelUsedId, transitions: state.transitions };
    yield { type: "done", result };
}

/** Run one model turn against a single client, capturing any
 *  text_delta events into `outDeltas` and returning the final
 *  completion. */
async function runOneTurn(
    client: LLMClient,
    args: Parameters<NonNullable<LLMClient["streamComplete"]>>[0],
    outDeltas: string[],
): Promise<
    | { ok: true; completion: LLMCompletion }
    | { ok: false; error: string }
> {
    try {
        if (client.streamComplete) {
            let final: LLMCompletion | null = null;
            for await (const ev of client.streamComplete(args)) {
                if (ev.type === "text_delta") outDeltas.push(ev.text);
                else if (ev.type === "done") final = ev.completion;
            }
            if (!final) return { ok: false, error: "streamComplete returned without a done event" };
            return { ok: true, completion: final };
        }
        const c = await client.complete(args);
        return { ok: true, completion: c };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
