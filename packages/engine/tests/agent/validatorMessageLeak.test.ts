// ============================================================
// Phase 12.5 Task 3 — validator-replay messages must not leak
// ============================================================
// Regression test for the diagnosis in Phase 12.5 Task 3:
//
//   Leak path (b): on a replay turn the model emits thinking_delta
//   events that reference the validator's complaint (because the
//   system message describes the violation). The previous code
//   yielded thinking_delta immediately — before the validator
//   decided to replay — so even though text_delta was suppressed
//   via `continue`, the thinking monologue had already escaped to
//   the SSE writer.
//
//   Fix: buffer thinking_delta per-turn (parallel to bufferedDeltas
//   for text) and discard the buffer when replayed = true.
// ============================================================

import { describe, expect, it } from "vitest";
import {
    runAgentTurnStreaming,
    buildDefaultRegistry,
    type LLMClient,
    type LLMCompletion,
    type LLMStreamEvent,
    type AgentStreamEvent,
    type ToolSession,
} from "../../src/agent/index.js";

const session: ToolSession = {
    student: {
        id: "u-leak-test",
        catalogYear: "2025-2026",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
        coursesTaken: [],
    },
};

/** Fake LLM client with pre-scripted event sequences, one array per call. */
function fakeStreamingClient(scripted: LLMStreamEvent[][], id = "fake-leak"): LLMClient {
    let i = 0;
    return {
        id,
        async complete(): Promise<LLMCompletion> { throw new Error("complete() must not be called in these tests"); },
        async *streamComplete() {
            const events = scripted[i++ % scripted.length];
            for (const ev of events!) yield ev;
        },
    };
}

async function collect(gen: AsyncGenerator<AgentStreamEvent, void, void>): Promise<AgentStreamEvent[]> {
    const out: AgentStreamEvent[] = [];
    for await (const ev of gen) out.push(ev);
    return out;
}

// ---------------------------------------------------------------
// Validator that rejects the first reply (simulating ungrounded_number)
// and accepts anything on the second.
// ---------------------------------------------------------------
let callCount = 0;
function makeOneRejectValidator() {
    callCount = 0;
    return (ctx: { assistantText: string }) => {
        callCount += 1;
        if (callCount === 1) {
            return {
                ok: false,
                violations: [{ kind: "ungrounded_number", detail: "The number '8' was not grounded by a tool call." }],
            };
        }
        return { ok: true, violations: [] };
    };
}

describe("validator-replay messages do not leak into user-facing content", () => {
    it("thinking_delta from the rejected turn is NOT forwarded after a validator replay", async () => {
        // Turn 1: model emits thinking mentioning the validator complaint,
        // then a text reply that triggers the validator.
        // Turn 2 (replay): model emits clean thinking + clean reply.
        //
        // Phase 12.5 Task 3: turn-1 thinking is suppressed (buffer discard).
        // Phase 13 §8b: turn-2 (replay turn) thinking is ALSO suppressed
        // (isReplayTurn flag). On replay turns the model often narrates
        // its self-correction in the open — that monologue is internal
        // and must not reach the user. Only the final text_delta flows.

        const leakyThinking = "The validator is catching several issues: ungrounded_number found.";
        const cleanThinking = "I should look up the course count properly.";

        const rejectCompletion: LLMCompletion = {
            text: "You have 8 free electives available.",
            toolCalls: [],
            latencyMs: 1,
        };
        const acceptCompletion: LLMCompletion = {
            text: "Let me verify that for you.",
            toolCalls: [],
            latencyMs: 1,
        };

        const client = fakeStreamingClient([
            // Turn 1 — will be rejected
            [
                { type: "thinking_delta", text: leakyThinking },
                { type: "text_delta", text: "You have 8 free electives available." },
                { type: "done", completion: rejectCompletion },
            ],
            // Turn 2 — replay (isReplayTurn=true; thinking suppressed)
            [
                { type: "thinking_delta", text: cleanThinking },
                { type: "text_delta", text: "Let me verify that for you." },
                { type: "done", completion: acceptCompletion },
            ],
        ]);

        const validator = makeOneRejectValidator();
        const events = await collect(runAgentTurnStreaming(
            client,
            buildDefaultRegistry(),
            session,
            "How many free electives do I have?",
            {
                systemPrompt: "test",
                validateResponse: (ctx) => validator(ctx),
            },
        ));

        const thinkingEvents = events.filter((e) => e.type === "thinking_delta") as Array<{ type: "thinking_delta"; text: string }>;
        const thinkingTexts = thinkingEvents.map((e) => e.text).join(" ");

        // Phase 12.5: The leaky thinking from the rejected turn must NOT appear.
        expect(thinkingTexts).not.toMatch(/the validator is catching/i);
        expect(thinkingTexts).not.toMatch(/ungrounded_number/i);
        expect(thinkingTexts).not.toMatch(/the validator (is|caught|flagged)/i);

        // Phase 13 §8b: The replay turn's thinking is ALSO suppressed.
        // No thinking_delta events should be emitted at all across both turns.
        expect(thinkingEvents).toHaveLength(0);

        // The final text_delta must be from the accepted reply.
        const textEvents = events.filter((e) => e.type === "text_delta") as Array<{ type: "text_delta"; text: string }>;
        const allText = textEvents.map((e) => e.text).join("");
        expect(allText).toContain("Let me verify");

        // The done event must be ok.
        const done = events[events.length - 1]!;
        expect(done.type).toBe("done");
        if (done.type === "done") expect(done.result.kind).toBe("ok");
    });

    it("text_delta from the rejected turn is also not forwarded (existing protection)", async () => {
        // Confirm the existing `continue` suppression for text_delta still holds.
        const client = fakeStreamingClient([
            [
                { type: "text_delta", text: "REJECTED TEXT" },
                { type: "done", completion: { text: "REJECTED TEXT", toolCalls: [], latencyMs: 1 } },
            ],
            [
                { type: "text_delta", text: "clean reply" },
                { type: "done", completion: { text: "clean reply", toolCalls: [], latencyMs: 1 } },
            ],
        ]);

        const validator = makeOneRejectValidator();
        const events = await collect(runAgentTurnStreaming(
            client,
            buildDefaultRegistry(),
            session,
            "anything",
            {
                systemPrompt: "test",
                validateResponse: (ctx) => validator(ctx),
            },
        ));

        const textEvents = events.filter((e) => e.type === "text_delta") as Array<{ type: "text_delta"; text: string }>;
        const allText = textEvents.map((e) => e.text).join("");
        expect(allText).not.toContain("REJECTED TEXT");
        expect(allText).toContain("clean reply");
    });

    it("when no replay occurs, thinking_delta events from the accepted turn still flow normally", async () => {
        const client = fakeStreamingClient([
            [
                { type: "thinking_delta", text: "Normal thinking here." },
                { type: "text_delta", text: "My answer." },
                { type: "done", completion: { text: "My answer.", toolCalls: [], latencyMs: 1 } },
            ],
        ]);

        const events = await collect(runAgentTurnStreaming(
            client,
            buildDefaultRegistry(),
            session,
            "a question",
            { systemPrompt: "test" }, // no validateResponse → no replay possible
        ));

        const thinkingEvents = events.filter((e) => e.type === "thinking_delta") as Array<{ type: "thinking_delta"; text: string }>;
        expect(thinkingEvents).toHaveLength(1);
        expect(thinkingEvents[0]!.text).toBe("Normal thinking here.");
    });
});
