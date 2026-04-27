// ============================================================
// Phase 7-B Steps 14, 16, 17, 18, 20 — LoopState helper tests
// ============================================================
// Pure unit tests against the helpers that the agent loop drives.
// ============================================================

import { describe, expect, it } from "vitest";
import {
    createLoopState,
    recordTransition,
    enforceToolResultBudget,
    estimateTokens,
    measureContextPressure,
    compactConversation,
    isContextLengthExceededError,
    MAX_TOOL_RESULT_BUDGET,
    TOOL_RESULT_KEEP_RECENT,
} from "../../src/agent/loopState.js";
import { InMemoryFallbackSink } from "../../src/observability/fallbackLog.js";
import type { LLMMessage } from "../../src/agent/llmClient.js";

describe("LoopState (Phase 7-B Step 14)", () => {
    it("default budgets match locked decisions: validatorReplayLimit=1, outputTruncationRecoveryLimit=3", () => {
        const s = createLoopState();
        expect(s.validatorReplaysRemaining).toBe(1);
        expect(s.outputTruncationRecoveriesRemaining).toBe(3);
        expect(s.hasAttemptedReactiveCompact).toBe(false);
        expect(s.hasFiredTier2Compaction).toBe(false);
    });

    it("recordTransition appends to state and emits a `transition` event to the sink", () => {
        const s = createLoopState();
        const sink = new InMemoryFallbackSink();
        s.iteration = 2;
        recordTransition(s, "validation_retry", sink, "ungrounded_number");
        expect(s.transitions).toHaveLength(1);
        expect(s.transitions[0]!.iteration).toBe(2);
        expect(s.transitions[0]!.reason).toBe("validation_retry");
        expect(s.transitions[0]!.detail).toBe("ungrounded_number");
        expect(sink.events).toHaveLength(1);
        expect(sink.events[0]!.kind).toBe("transition");
    });
});

describe("MAX_TOOL_RESULT_BUDGET (Phase 7-B Step 16)", () => {
    it("does nothing when total tool content is under budget", () => {
        const msgs: LLMMessage[] = [
            { role: "user", content: "hi" },
            { role: "tool", content: "small", toolCallId: "t1" },
            { role: "tool", content: "small", toolCallId: "t2" },
        ];
        const compacted = enforceToolResultBudget(msgs);
        expect(compacted).toBe(0);
        expect(msgs[1]!.content).toBe("small");
    });

    it("truncates older tool results once aggregate exceeds the budget, keeping last 2 verbatim", () => {
        const big = "X".repeat(20_000);
        const msgs: LLMMessage[] = [
            { role: "user", content: "hi" },
            { role: "tool", content: big, toolCallId: "t1" },
            { role: "tool", content: big, toolCallId: "t2" },
            { role: "tool", content: big, toolCallId: "t3" },
            { role: "tool", content: big, toolCallId: "t4" },
        ];
        // Total = 80k, well over 32k.
        const compacted = enforceToolResultBudget(msgs);
        expect(compacted).toBeGreaterThan(0);
        // Last 2 stay verbatim, earlier ones get truncated.
        expect(msgs[3]!.content.length).toBe(big.length);
        expect(msgs[4]!.content.length).toBe(big.length);
        expect(msgs[1]!.content.length).toBeLessThan(big.length);
        expect(MAX_TOOL_RESULT_BUDGET).toBe(32_000);
        expect(TOOL_RESULT_KEEP_RECENT).toBe(2);
    });
});

describe("Context-pressure tiers (Phase 7-B Steps 17, 18)", () => {
    it("estimates tokens at ~1 token per 4 chars", () => {
        const messages: LLMMessage[] = [{ role: "user", content: "X".repeat(400) }];
        const tokens = estimateTokens(messages, "Y".repeat(400));
        expect(tokens).toBe(200);
    });

    it("trips Tier-2 at 80% and Tier-3 at 95%", () => {
        const window = 1000;
        const ninetyPctChars = 4 * 900;
        const messages: LLMMessage[] = [{ role: "user", content: "X".repeat(ninetyPctChars) }];
        const p = measureContextPressure(messages, "", window);
        expect(p.tier2).toBe(true);
        expect(p.tier3).toBe(false);

        const ninetyEightPctChars = 4 * 980;
        const big: LLMMessage[] = [{ role: "user", content: "X".repeat(ninetyEightPctChars) }];
        const p2 = measureContextPressure(big, "", window);
        expect(p2.tier2).toBe(true);
        expect(p2.tier3).toBe(true);
    });
});

describe("Tier-2 compactConversation (Phase 7-B Step 17)", () => {
    it("replaces the prefix with a system summary and keeps the trailing K verbatim", async () => {
        const messages: LLMMessage[] = [];
        for (let i = 0; i < 20; i++) {
            messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}` });
        }
        const summarize = async () => "BULLET-SUMMARY";
        const out = await compactConversation(messages, { keepTrailing: 6, summarize });
        expect(out).toHaveLength(7);
        expect(out[0]!.role).toBe("system");
        expect(out[0]!.content).toContain("BULLET-SUMMARY");
        expect(out[1]!.content).toBe("msg-14");
        expect(out[6]!.content).toBe("msg-19");
    });

    it("returns the input unchanged when message count <= keepTrailing+1", async () => {
        const messages: LLMMessage[] = [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
        ];
        const out = await compactConversation(messages, { keepTrailing: 6, summarize: async () => "S" });
        expect(out).toBe(messages);
    });
});

describe("isContextLengthExceededError (Phase 7-B Step 20)", () => {
    it("recognizes the common provider error patterns", () => {
        expect(isContextLengthExceededError("context_length_exceeded: 200001 tokens > 128000")).toBe(true);
        expect(isContextLengthExceededError("This model's maximum context length is 128000 tokens")).toBe(true);
        expect(isContextLengthExceededError("HTTP 413 Payload Too Long")).toBe(true);
        expect(isContextLengthExceededError("rate limit exceeded")).toBe(false);
        expect(isContextLengthExceededError("network timeout")).toBe(false);
    });
});
