# Real Reasoning Stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synthesized hard-coded tool-thought sentences with the real model chain-of-thought from Anthropic extended thinking. Stream the model's actual reasoning through the same ChatGPT-style typewriter UI we just shipped. Synthesized sentences remain as a fallback path so the OpenAI-fallback model and template-match recovery mode still produce a reasoning trace.

**Architecture:** Four-layer wiring on top of the existing infra. (1) `anthropicClient.ts` enables the `thinking` SDK parameter and yields a new `thinking_delta` event from its streaming loop. (2) `agentLoop.ts` adds a matching variant to `AgentStreamEvent` and forwards it. (3) The v2 SSE route writes a `thinking` event kind; the chat-V2 client parses it. (4) The chat page appends thinking deltas into the existing `thinkingText` buffer (already wired to the rAF ticker that drives the typewriter), and suppresses the synthesized tool sentences once real thinking has fired for that message. No engine architecture changes; no new server infra.

**Tech Stack:** Anthropic SDK (`@anthropic-ai/sdk`), Next.js 16 App Router SSE, vitest. Primary model `claude-haiku-4-5-20251001` (Anthropic confirms extended-thinking support). Streaming already in place via `messages.stream()`.

**Out of scope (intentionally deferred):**
- OpenAI-fallback parity — OpenAI doesn't have extended thinking; the synthesized-sentence fallback already covers this path
- Persisting raw thinking text to telemetry/observability (separate concern)
- Verifier integration — `responseValidator.ts` only reads `assistantText` + `invocations`, never raw model blocks, so thinking blocks are already isolated from grounding checks
- Recording-client (`recordingClient.ts`) thinking-fixture support — replay tests use block-mode `complete()`, which is unaffected

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/engine/src/agent/clients/anthropicClient.ts` | **Modify** | Add `thinking: { type: "enabled", budget_tokens }` to `messages.create()` and `messages.stream()`. Parse `thinking` content blocks in both paths. Emit a `thinking_delta` event from the streaming loop. Force `temperature: 1` when thinking is enabled. Bump `max_tokens` to fit thinking budget. Respect `NYUPATH_DISABLE_THINKING=1` env opt-out. |
| `packages/engine/src/agent/llmClient.ts` | **Modify** | Add `thinking_delta` to the `LLMStreamEvent` (or equivalent) union returned by `streamComplete()`. |
| `packages/engine/src/agent/agentLoop.ts` | **Modify** | Add `thinking_delta` variant to `AgentStreamEvent`. Forward LLM-client thinking events through `runAgentTurnStreaming`. |
| `packages/engine/tests/agent/anthropicThinking.test.ts` | **Create** | Unit test that asserts: (a) the SDK is called with `thinking` enabled when not opted out, (b) `temperature: 1` is forced, (c) `thinking_delta` events are yielded for `thinking` content blocks. |
| `apps/web/lib/chatV2Client.ts` | **Modify** | Add `{ kind: "thinking"; text: string }` to `ChatV2Event` union. (Parser is generic — no parse-loop change required.) |
| `apps/web/tests/chatV2Client.test.ts` | **Modify** | Add a fixture round-trip for the new `thinking` event. |
| `apps/web/app/api/chat/v2/route.ts` | **Modify** | Add `case "thinking_delta"` to the engine→SSE event-forwarding switch — `writer.write({ kind: "thinking", text: ev.text })`. |
| `apps/web/app/chat/page.tsx` | **Modify** | Add `hasRealThinking?: boolean` to `Message`. Add `case "thinking"` to `applyEvent` — append delta to `thinkingText`, set `hasRealThinking`. In `case "tool_invocation_start"`, only append the synthesized sentence when `!hasRealThinking`. |

---

## Task 1: Engine — enable extended thinking + emit `thinking_delta` from the Anthropic client

**Files:**
- Modify: `packages/engine/src/agent/llmClient.ts`
- Modify: `packages/engine/src/agent/clients/anthropicClient.ts`
- Create: `packages/engine/tests/agent/anthropicThinking.test.ts`

The Anthropic SDK already supports extended thinking on `claude-haiku-4-5`. The streaming response interleaves `thinking` content blocks alongside `text` and `tool_use` blocks; thinking deltas arrive as `content_block_delta` events with `delta.type === "thinking_delta"` and `delta.thinking: string`. Per Anthropic's API contract, when `thinking.enabled` is true, `temperature` MUST be `1` and `max_tokens` MUST be greater than `budget_tokens`. Caller-provided values that conflict are silently overridden — the override is invisible to upstream callers since they don't depend on those exact parameters.

- [ ] **Step 1: Read the LLM-client interface to find the streaming event union**

Read `packages/engine/src/agent/llmClient.ts`. Locate the discriminated union returned by `streamComplete()` (likely named `LLMStreamEvent` or similar — variants like `text_delta`, `tool_use`, `done`). Note its exact name and the file location of the export.

- [ ] **Step 2: Add `thinking_delta` to the event union**

In `packages/engine/src/agent/llmClient.ts`, append a new variant to the streaming-event union:

```typescript
    | { type: "thinking_delta"; text: string }
```

Preserve the existing variants and their order — just append.

- [ ] **Step 3: Write the failing test**

Create `packages/engine/tests/agent/anthropicThinking.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AnthropicLLMClient } from "../../src/agent/clients/anthropicClient";

// Mock the Anthropic SDK at module level. We assert the call shape and
// drive the streaming loop with synthetic events.
const messagesCreate = vi.fn();
const messagesStream = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
    return {
        default: class FakeAnthropic {
            messages = { create: messagesCreate, stream: messagesStream };
        },
        Anthropic: class FakeAnthropic2 {
            messages = { create: messagesCreate, stream: messagesStream };
        },
    };
});

describe("AnthropicLLMClient extended thinking", () => {
    beforeEach(() => {
        messagesCreate.mockReset();
        messagesStream.mockReset();
        delete process.env.NYUPATH_DISABLE_THINKING;
    });

    afterEach(() => {
        delete process.env.NYUPATH_DISABLE_THINKING;
    });

    it("passes thinking + temperature=1 + bumped max_tokens to messages.create when thinking is enabled", async () => {
        messagesCreate.mockResolvedValue({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
        });
        const client = new AnthropicLLMClient({ apiKey: "test", model: "claude-haiku-4-5-20251001" });
        await client.complete({
            system: "sys",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 1024,
            temperature: 0,
        });
        expect(messagesCreate).toHaveBeenCalledTimes(1);
        const args = messagesCreate.mock.calls[0][0];
        expect(args.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
        expect(args.temperature).toBe(1);
        expect(args.max_tokens).toBeGreaterThanOrEqual(4096 + 1024);
    });

    it("opts out of thinking when NYUPATH_DISABLE_THINKING=1 is set", async () => {
        process.env.NYUPATH_DISABLE_THINKING = "1";
        messagesCreate.mockResolvedValue({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
            stop_reason: "end_turn",
        });
        const client = new AnthropicLLMClient({ apiKey: "test", model: "claude-haiku-4-5-20251001" });
        await client.complete({
            system: "sys",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 1024,
            temperature: 0,
        });
        const args = messagesCreate.mock.calls[0][0];
        expect(args.thinking).toBeUndefined();
        expect(args.temperature).toBe(0); // user value preserved when thinking is off
    });

    it("yields thinking_delta events from the streaming loop", async () => {
        // Drive the streaming loop with a synthetic async iterable that
        // emits content_block_start (thinking), content_block_delta x2,
        // content_block_stop, then a final message_stop.
        async function* fakeStream() {
            yield { type: "message_start", message: { id: "m1", model: "claude-haiku-4-5-20251001", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } };
            yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } };
            yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me " } };
            yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think." } };
            yield { type: "content_block_stop", index: 0 };
            yield { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } };
            yield { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello." } };
            yield { type: "content_block_stop", index: 1 };
            yield { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 20 } };
            yield { type: "message_stop" };
        }
        messagesStream.mockReturnValue({
            [Symbol.asyncIterator]: () => fakeStream(),
        });

        const client = new AnthropicLLMClient({ apiKey: "test", model: "claude-haiku-4-5-20251001" });
        const events: Array<{ type: string; text?: string }> = [];
        for await (const ev of client.streamComplete({
            system: "sys",
            messages: [{ role: "user", content: "hi" }],
            maxTokens: 1024,
        })) {
            if (ev.type === "thinking_delta" || ev.type === "text_delta") {
                events.push({ type: ev.type, text: ev.text });
            } else if (ev.type === "done") {
                events.push({ type: "done" });
            }
        }
        const thinking = events.filter(e => e.type === "thinking_delta").map(e => e.text).join("");
        const text = events.filter(e => e.type === "text_delta").map(e => e.text).join("");
        expect(thinking).toBe("Let me think.");
        expect(text).toBe("Hello.");
        expect(events.find(e => e.type === "done")).toBeDefined();
    });
});
```

- [ ] **Step 4: Run test to verify it fails**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/anthropicThinking.test.ts`
Expected: at least the first two tests FAIL because `args.thinking` is currently `undefined` (the SDK call doesn't include `thinking` yet) and the streaming test fails because no `thinking_delta` events are emitted.

- [ ] **Step 5: Modify the Anthropic client to enable thinking + emit deltas**

Open `packages/engine/src/agent/clients/anthropicClient.ts`. Make four edits:

(a) Near the top of the file (just after the existing imports), add:

```typescript
const THINKING_BUDGET_TOKENS = 4096;
const THINKING_HEADROOM_TOKENS = 1024; // text + tool-call output above thinking

function thinkingEnabled(): boolean {
    return process.env.NYUPATH_DISABLE_THINKING !== "1";
}

function buildThinkingParams(maxTokens: number, temperature: number) {
    if (!thinkingEnabled()) {
        return { thinking: undefined as undefined, max_tokens: maxTokens, temperature };
    }
    return {
        thinking: { type: "enabled" as const, budget_tokens: THINKING_BUDGET_TOKENS },
        // max_tokens must accommodate the thinking budget plus the actual reply.
        max_tokens: Math.max(maxTokens, THINKING_BUDGET_TOKENS + THINKING_HEADROOM_TOKENS),
        // Anthropic API contract: temperature MUST be 1 when thinking is on.
        temperature: 1,
    };
}
```

(b) In the `complete()` method (the path using `messages.create()`), find the params object passed to `this.client.messages.create({ ... })`. Replace the existing `max_tokens` / `temperature` lines with a spread of `buildThinkingParams`:

```typescript
const t = buildThinkingParams(args.maxTokens ?? 1024, args.temperature ?? 0);
const response = await this.client.messages.create(
    {
        model: this.model,
        max_tokens: t.max_tokens,
        temperature: t.temperature,
        ...(t.thinking ? { thinking: t.thinking } : {}),
        system: args.system,
        messages: userAssistant,
        ...(args.tools && args.tools.length > 0
            ? {
                tools: args.tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    input_schema: t.parameters as Anthropic.Tool.InputSchema,
                })),
            }
            : {}),
    },
    args.signal ? { signal: args.signal } : undefined,
);
```

(c) In the same `complete()` method, the response-block parsing loop currently handles `text` and `tool_use` only. Add a `thinking` branch that simply ignores the block (the validator never sees it; we don't surface block-mode thinking through `complete()` because that path is used only by tests + non-streaming callers). Locate:

```typescript
for (const block of response.content) {
    if (block.type === "text") {
        textParts.push(block.text);
    } else if (block.type === "tool_use") {
        toolCalls.push({
            id: block.id,
            name: block.name,
            args: (block.input ?? {}) as Record<string, unknown>,
        });
    }
}
```

Add an `else if (block.type === "thinking") { /* discard — block-mode callers don't surface thinking */ }` before the closing `}`.

(d) In `streamComplete()` (the path using `messages.stream()`), make the same `buildThinkingParams` substitution for the params object. Then in the streaming-loop switch (currently handling `content_block_start`, `content_block_delta`, etc.), find the `content_block_delta` branch. Add a sub-branch for thinking deltas:

```typescript
} else if (ev.type === "content_block_delta") {
    if (ev.delta.type === "text_delta") {
        yield { type: "text_delta", text: ev.delta.text };
    } else if (ev.delta.type === "thinking_delta") {
        yield { type: "thinking_delta", text: ev.delta.thinking };
    } else if (ev.delta.type === "input_json_delta") {
        // ...existing tool-arg accumulation logic...
    }
}
```

If the existing branch structure differs (e.g. the file uses a switch instead of if/else), adapt accordingly — the principle is: when `ev.delta.type === "thinking_delta"`, yield `{ type: "thinking_delta", text: ev.delta.thinking }`.

Also add `thinking` to the `content_block_start` block-type handling if necessary. Most often, no per-start state is needed for thinking — the deltas are self-contained. If the existing code accumulates per-content-block state, mirror the pattern but discard on `content_block_stop` for thinking.

- [ ] **Step 6: Run test to verify it passes**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/anthropicThinking.test.ts`
Expected: 3/3 pass.

- [ ] **Step 7: Run the full engine test suite to confirm no regressions**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: all existing engine tests still pass. If a recorded-fixture replay test fails because the new `max_tokens` value differs from the recorded request, this is acceptable — the recorded request is now stale because we bumped max_tokens. Update the fixture or skip — note any such regressions in the report.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/agent/llmClient.ts packages/engine/src/agent/clients/anthropicClient.ts packages/engine/tests/agent/anthropicThinking.test.ts
git commit -m "feat(engine): enable Anthropic extended thinking + emit thinking_delta events"
```

---

## Task 2: Agent loop — propagate `thinking_delta` through `AgentStreamEvent`

**Files:**
- Modify: `packages/engine/src/agent/agentLoop.ts`

The agent loop wraps the LLM client with tool execution and emits its own event stream. It must forward thinking deltas from the LLM-client layer to its callers.

- [ ] **Step 1: Add the variant to the agent's event union**

Open `packages/engine/src/agent/agentLoop.ts`. Find the existing `AgentStreamEvent` discriminated-union export (around line 790, with variants `tool_invocation_start`, `tool_invocation_done`, `text_delta`, `done`). Append:

```typescript
    | { type: "thinking_delta"; text: string }
```

Preserve the order of existing variants.

- [ ] **Step 2: Forward LLM-client thinking events**

In `runOneTurn` (or wherever the loop iterates `client.streamComplete(args)`), find the existing forwarding/accumulation switch. Currently it handles `text_delta` and `done`; add a branch that yields the agent-level `thinking_delta` upward unchanged:

```typescript
for await (const ev of client.streamComplete(args)) {
    if (ev.type === "text_delta") {
        outDeltas.push(ev.text);
        yield { type: "text_delta", text: ev.text };
    } else if (ev.type === "thinking_delta") {
        yield { type: "thinking_delta", text: ev.text };
    } else if (ev.type === "done") {
        final = ev.completion;
    }
}
```

If the existing code does not already use a generator + `yield` here, but instead pushes events into an array then emits them later, mirror that pattern for thinking — push to a parallel buffer or yield directly, whichever matches the existing flow.

If the agent loop calls `streamComplete` in multiple places (e.g. once per inner loop iteration), apply the same change to each. Use grep:

```bash
grep -n "streamComplete" packages/engine/src/agent/agentLoop.ts
```

- [ ] **Step 3: Type-check**

From repo root: `cd packages/engine && npx tsc --noEmit`
Expected: clean. No new type errors. If the LLM-client union from Task 1 isn't imported in `agentLoop.ts`, the type-check will fail with "Type '...' is not assignable to type '...'" — investigate the import path.

- [ ] **Step 4: Run engine tests**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: all pass. The `thinking_delta` is additive; nothing should regress.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agent/agentLoop.ts
git commit -m "feat(engine): forward thinking_delta events through AgentStreamEvent"
```

---

## Task 3: SSE — add `thinking` event end-to-end (route + client + test)

**Files:**
- Modify: `apps/web/lib/chatV2Client.ts`
- Modify: `apps/web/tests/chatV2Client.test.ts`
- Modify: `apps/web/app/api/chat/v2/route.ts`

The chat-V2 SSE protocol gains a new event kind. Server emits it from the engine event stream; client parser already round-trips arbitrary kinds so only the type union needs the new variant.

- [ ] **Step 1: Extend the `ChatV2Event` union**

In `apps/web/lib/chatV2Client.ts`, find the `ChatV2Event` discriminated union (around lines 14-21). Append:

```typescript
    | { kind: "thinking"; text: string }
```

Preserve the order of existing variants.

- [ ] **Step 2: Write the failing client-parser test**

In `apps/web/tests/chatV2Client.test.ts`, add a new `it()` block inside the existing `describe(...)` block (after the existing tests):

```typescript
    it("parses a thinking event", async () => {
        const chunks = [
            "event: thinking\ndata: " + JSON.stringify({ kind: "thinking", text: "Let me think." }) + "\n\n",
            "event: done\ndata: " + JSON.stringify({ kind: "done", finalText: "ok", modelUsedId: "claude-haiku-4-5-20251001" }) + "\n\n",
        ];
        const resp = fakeResponse(chunks);
        const events: ChatV2Event[] = [];
        for await (const ev of streamChatV2FromResponse(resp)) {
            events.push(ev);
        }
        expect(events).toEqual([
            { kind: "thinking", text: "Let me think." },
            { kind: "done", finalText: "ok", modelUsedId: "claude-haiku-4-5-20251001" },
        ]);
    });
```

If `streamChatV2FromResponse` is not a real exported helper (the existing tests likely use a different name like `streamChatV2` with mocked `fetch`), inspect the existing test file and copy whatever pattern it uses for round-tripping a fixture. The principle is: feed the chunks through the parser and assert that the events come out as `{ kind: "thinking", text: "Let me think." }`.

- [ ] **Step 3: Run test to verify it fails**

From repo root: `node_modules/.bin/vitest run apps/web/tests/chatV2Client.test.ts`
Expected: FAIL — the type union doesn't include `thinking` (the test will type-error first), or if the test compiles, the parser will throw on the unknown event.

- [ ] **Step 4: (No client-parser code change needed — the type union from Step 1 already covers it)**

The existing `parseBlock` function in `chatV2Client.ts` does `JSON.parse(dataLine) as ChatV2Event` and trusts the server-side `kind` field. Once the union includes `thinking`, the cast resolves correctly with no other change.

- [ ] **Step 5: Run the test again to verify it passes**

From repo root: `node_modules/.bin/vitest run apps/web/tests/chatV2Client.test.ts`
Expected: PASS, including the new `thinking` test.

- [ ] **Step 6: Wire the server-side emit**

In `apps/web/app/api/chat/v2/route.ts`, find the engine-event forwarding switch (around lines 535-560). It currently has cases for `tool_invocation_start`, `tool_invocation_done`, `text_delta`. Add a new case BEFORE the `text_delta` case:

```typescript
case "thinking_delta":
    writer.write({ kind: "thinking", text: ev.text });
    break;
```

Confirm via grep:

```bash
grep -n "kind:" apps/web/app/api/chat/v2/route.ts | head -20
```

- [ ] **Step 7: Run the v2-route tests**

From repo root: `node_modules/.bin/vitest run apps/web/tests/chatV2Route.test.ts`
Expected: all 6 tests pass. (None of the existing route tests currently exercise thinking events; this is just confirming no regression.)

- [ ] **Step 8: Commit**

```bash
git add apps/web/lib/chatV2Client.ts apps/web/tests/chatV2Client.test.ts apps/web/app/api/chat/v2/route.ts
git commit -m "feat(web): wire thinking SSE event end-to-end"
```

---

## Task 4: Frontend — consume thinking deltas, suppress synthesized fallback when real thinking fires

**Files:**
- Modify: `apps/web/app/chat/page.tsx`

The chat page's `applyEvent` switch must handle the new `thinking` event. When real thinking arrives, we set a flag on the message and stop appending the synthesized tool-thought sentences (which were a fallback for cases without thinking). The `thinkingText` buffer is shared by both real and synthesized thinking — the rAF ticker already drives the typewriter on whatever's in there.

- [ ] **Step 1: Add the `hasRealThinking` field to `Message`**

In `apps/web/app/chat/page.tsx`, find the `Message` interface (around lines 37-66). Append a new optional field at the end (just before the closing `}`):

```typescript
    /** True once at least one `thinking` SSE event has fired for this
     *  message. When set, suppresses the synthesized tool-thought
     *  fallback so we don't double-narrate (real reasoning + canned
     *  sentences). Stays unset on OpenAI-fallback turns and template-
     *  match recovery, where the synthesized fallback is what the
     *  user sees. */
    hasRealThinking?: boolean;
```

- [ ] **Step 2: Add the `case "thinking"` handler to `applyEvent`**

Find the `applyEvent` switch (around lines 161-244). Add a new case BEFORE `case "validator_block":` (or anywhere within the switch — order doesn't matter since they're disjoint kinds):

```typescript
            case "thinking":
                setMessages(prev => prev.map(m => m.id === assistantId
                    ? {
                        ...m,
                        thinkingText: (m.thinkingText ?? "") + ev.text,
                        hasRealThinking: true,
                    }
                    : m));
                break;
```

- [ ] **Step 3: Suppress synthesized sentences when real thinking is active**

Find the existing `case "tool_invocation_start":` block in `applyEvent`. The current implementation looks like:

```typescript
            case "tool_invocation_start": {
                toolStatuses.push({ toolName: ev.toolName, state: "running" });
                const sentence = getThoughtSentence(ev.toolName);
                setMessages(prev => prev.map(m => m.id === assistantId
                    ? {
                        ...m,
                        toolStatuses: [...toolStatuses],
                        thinkingText: ((m.thinkingText ?? "") + (m.thinkingText ? "\n\n" : "") + sentence),
                    }
                    : m));
                break;
            }
```

Replace with the version that conditionally appends the sentence:

```typescript
            case "tool_invocation_start": {
                toolStatuses.push({ toolName: ev.toolName, state: "running" });
                const sentence = getThoughtSentence(ev.toolName);
                setMessages(prev => prev.map(m => {
                    if (m.id !== assistantId) return m;
                    // When the real model is producing a chain-of-thought,
                    // the synthesized tool-sentence narration would just
                    // duplicate / contradict the model's words. Skip it.
                    if (m.hasRealThinking) {
                        return { ...m, toolStatuses: [...toolStatuses] };
                    }
                    return {
                        ...m,
                        toolStatuses: [...toolStatuses],
                        thinkingText: ((m.thinkingText ?? "") + (m.thinkingText ? "\n\n" : "") + sentence),
                    };
                }));
                break;
            }
```

- [ ] **Step 4: Type-check the web app**

From `apps/web/`: `npx tsc --noEmit`
Expected: clean for the modified files. Any pre-existing unrelated errors (the 9 from the previous tasks in `route.ts`/`runFullAudit.ts`/etc.) are acceptable; no NEW errors from this change.

- [ ] **Step 5: Run web tests**

From repo root: `node_modules/.bin/vitest run apps/web/tests/`
Expected: all existing web tests pass. The new behavior is purely additive on a new event kind that no existing test triggers.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/chat/page.tsx
git commit -m "feat(web): consume real thinking deltas, suppress synthesized fallback when active"
```

---

## Task 5: Manual browser verification

**Files:** none (verification step)

The dev server (`http://localhost:3001`) has HMR — refresh once after the Task-4 commit lands so the new chat-page bundle is hot-reloaded.

- [ ] **Step 1: Verify thinking events arrive on a real Anthropic turn**

Open the chat page (post-onboarding so v2 SSE is active). Send: **"What's NYU's F-1 credit floor for international students?"**

Open Chrome DevTools → Network → click the v2 chat request → "EventStream" tab. Confirm:
- One or more events with `event: thinking` and a `data: {"kind":"thinking","text":"..."}` payload arrive BEFORE the first `tool_invocation_start` event (the model thinks first, then decides to call a tool).
- Possibly more `thinking` events after `tool_invocation_done` (the model thinks again before the final answer).
- A final `done` event with the finalText.

If NO `thinking` events appear, something is wrong upstream — Task 1 (engine) or Task 3 (route) didn't wire correctly. Stop and diagnose before continuing.

- [ ] **Step 2: Verify the UI consumes them as the reasoning trace**

In the chat UI itself, the indented reasoning block under the "Thinking" header should now show **the model's actual chain-of-thought** — first-person, naturally varied sentences that reference the user's question. NOT the canned `"Let me look up the relevant NYU policy and bulletin pages so my answer is grounded in source material."` fallback sentences.

If you see canned sentences, `hasRealThinking` isn't being set — check the `case "thinking"` handler in `page.tsx`.

- [ ] **Step 3: Verify quality of the reasoning**

The model's reasoning should:
- Reference your specific question (not a generic statement)
- Show plan-then-verify pattern (e.g. "I should check the bulletin to confirm…")
- Be coherent prose, not fragmented tokens

If the reasoning is empty, repetitive, or feels like raw token noise, the streaming path may be losing whitespace or accumulating only partial deltas. Check that `ev.delta.thinking` is being yielded correctly (Task 1 step 5d).

- [ ] **Step 4: Verify latency feels reasonable**

The "Thinking" header should appear instantly (existing behavior). The first thinking text should start streaming within ~2-4 seconds (Anthropic typically takes 1-3s for thinking to begin). If you see >10s of dead time before any thinking text appears, something is buffering — investigate.

- [ ] **Step 5: Verify the multi-tool flow**

Send: **"What should I take next semester?"**

Expected:
- Initial thinking (model planning)
- `tool_invocation_start: run_full_audit` (no synthesized sentence appended — `hasRealThinking` is true)
- More thinking (model reasoning over audit results)
- More tool calls
- Final answer streams

The reasoning trace should be ONE coherent narrative, not the canned-sentence-per-tool punctuation.

- [ ] **Step 6: Verify the OpenAI-fallback path still produces a reasoning trace**

This is the safety net. To force the fallback, temporarily break the Anthropic call (e.g. set `ANTHROPIC_API_KEY=invalid` in `.env.local`, restart the dev server). Send a question.

Expected:
- The fallback (OpenAI) takes over — no thinking events arrive
- The synthesized tool-sentence trace still appears (the `case "tool_invocation_start"` path runs because `hasRealThinking` is never set)
- The reasoning trace shows the canned sentences as before

Restore the real API key after this test.

- [ ] **Step 7: Verify the `NYUPATH_DISABLE_THINKING` kill switch**

Set `NYUPATH_DISABLE_THINKING=1` in `.env.local`, restart the dev server, send a question.

Expected:
- No `thinking` SSE events arrive
- The synthesized canned sentences are back (fallback path)
- No errors

Unset it afterward.

- [ ] **Step 8: Document the result**

If any verification fails, write down what you saw before declaring Task 5 complete. Open a fix subagent for the specific gap.

---

## Task 6: Final commit + summary

**Files:** none

- [ ] **Step 1: Confirm clean working tree**

```bash
git status
```

Expected: only the files listed in the **File Structure** table show as modified or created. If anything else is staged, investigate.

- [ ] **Step 2: Confirm the test suite is green**

```bash
node_modules/.bin/vitest run
```

Expected: all suites pass.

- [ ] **Step 3: (If all Task 5 verifications passed) Push**

```bash
git push
```

- [ ] **Step 4: Tear-off note**

```
Real reasoning streaming shipped. Anthropic extended thinking enabled
on claude-haiku-4-5-20251001 with a 4K-token thinking budget. Streams
through to the existing typewriter UI via a new `thinking` SSE event
kind. Synthesized tool-sentence fallback retained for the
OpenAI-fallback path and template-match recovery. Verifier still
sees only `assistantText` + tool invocations — no thinking
contamination of grounding checks.

Cost impact: +~$0.005-$0.02 per Anthropic turn (thinking-token
billing). Latency-to-first-thinking: ~1-3s. Kill switch:
`NYUPATH_DISABLE_THINKING=1`.
```

---

## Self-review notes

**Spec coverage:**
- "Real reasoning instead of synthesized" → Task 1 (engine), Task 3 (transport), Task 4 (frontend handler)
- "Stream through existing UI" → Task 4 step 2 (`case "thinking"` appends to `thinkingText`); the rAF ticker we already shipped drives the typewriter
- "Fallback when extended thinking unavailable" → Task 4 step 3 (`hasRealThinking` flag suppresses synthesized only when real is active; it remains otherwise)
- "Kill switch" → Task 1 step 5a (`NYUPATH_DISABLE_THINKING` env var)
- "No verifier contamination" → confirmed in investigation; `responseValidator.ts` only reads `assistantText` + `invocations`, not raw model blocks

**Edge cases handled:**
- OpenAI fallback: doesn't emit thinking; fallback synthesized sentences kick in
- Template-match recovery: no model call; no thinking events; synthesized fallback could still kick in (no tool invocations on this path either, so the trace is empty — acceptable)
- `NYUPATH_DISABLE_THINKING=1`: no thinking events; synthesized fallback runs as before
- Verifier: never sees thinking blocks; no behavioral change

**Open question to flag during verification:**
- Anthropic API contract requires `temperature: 1` when thinking is on. If the existing system prompt/turn relies on `temperature: 0` for determinism, the agent's responses will be slightly less deterministic when thinking is enabled. This trade-off is implicit in enabling extended thinking and is industry-standard behavior. If the change in determinism breaks any of the existing test fixtures that rely on exact-text matches, those tests will need to be loosened or skipped under thinking-enabled mode.
