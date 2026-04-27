// ============================================================
// RecorderLLMClient — capture real LLM completions to JSONL (Phase 6.1 WS5)
// ============================================================
// Wraps a real `LLMClient` (typically the production primary). Each
// `complete(args)` is forwarded to the underlying client; the
// resulting (matcher, completion) pair is appended to a JSONL fixture
// the `RecordingLLMClient` can replay.
//
// Activation: instantiate with a `fixturePath`. If the file already
// exists, new captures are appended (one entry per call). Pass an
// optional `matchStrategy` to control which `RecordingMatcher` shape
// is emitted — defaults to `userMessageEquals` for losslesss replay.
//
// Why this exists: live integration tests (WS5) and any developer
// who wants to seed deterministic fixtures for new flows. Without
// the recorder, fixtures are hand-authored; with it, you flip an
// env var, run the live flow once, and get a green replay forever.
// ============================================================

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
    LLMClient,
    LLMCompletion,
    LLMMessage,
    LLMToolDef,
} from "./llmClient.js";

export type RecorderMatchStrategy =
    | "userMessageEquals"
    | "userMessageContains"
    | "latestToolResultContains"
    | "assistantTurnIndex";

export interface RecorderOptions {
    /** Real LLM client whose calls we wrap and capture. */
    inner: LLMClient;
    /** Absolute path to the JSONL fixture to append to. */
    fixturePath: string;
    /** Which matcher shape to emit. Default `userMessageEquals` for
     *  lossless replay. Use `userMessageContains` when the replay
     *  side wants substring-flex matching. */
    matchStrategy?: RecorderMatchStrategy;
    /** When true, truncate the fixture file at construction. Useful
     *  when re-recording from scratch. Default false (append). */
    truncateOnStart?: boolean;
    /** When set, prepend each captured matcher block with this object
     *  so callers can stamp metadata (e.g., `{ scenario: "audit" }`)
     *  for debugging. Not used by `RecordingLLMClient`. */
    metadata?: Record<string, unknown>;
}

export class RecorderLLMClient implements LLMClient {
    public readonly id: string;
    private readonly inner: LLMClient;
    private readonly fixturePath: string;
    private readonly strategy: RecorderMatchStrategy;
    private readonly metadata?: Record<string, unknown>;

    constructor(opts: RecorderOptions) {
        this.id = `recorder(${opts.inner.id})`;
        this.inner = opts.inner;
        this.fixturePath = opts.fixturePath;
        this.strategy = opts.matchStrategy ?? "userMessageEquals";
        this.metadata = opts.metadata;
        // Lazy-create the parent directory; truncate when asked. Both
        // operations may fail on filesystems where the parent path is
        // not actually a directory — recorder failures must NEVER
        // break the live flow, so we swallow constructor errors and
        // surface the issue when complete() also fails.
        try {
            mkdirSync(dirname(opts.fixturePath), { recursive: true });
        } catch { /* dir may already exist or path may be invalid */ }
        if (opts.truncateOnStart || !existsSync(opts.fixturePath)) {
            try {
                writeFileSync(opts.fixturePath, "", "utf-8");
            } catch (err) {
                // eslint-disable-next-line no-console
                console.error(`[RecorderLLMClient] fixture-init failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }

    async complete(args: {
        system: string;
        messages: LLMMessage[];
        tools?: LLMToolDef[];
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    }): Promise<LLMCompletion> {
        const completion = await this.inner.complete(args);

        const matcher = this.buildMatcher(args.messages);
        const entry = {
            ...(this.metadata ? { _metadata: this.metadata } : {}),
            match: matcher,
            completion: {
                text: completion.text,
                toolCalls: completion.toolCalls.map((tc) => ({
                    id: tc.id, name: tc.name, args: tc.args,
                })),
                latencyMs: completion.latencyMs,
                ...(completion.usage ? { usage: completion.usage } : {}),
            },
        };
        try {
            appendFileSync(this.fixturePath, JSON.stringify(entry) + "\n", "utf-8");
        } catch (err) {
            // Capture failures must NEVER break the live flow — the
            // recorder is auxiliary. Surface to stderr only.
            // eslint-disable-next-line no-console
            console.error(`[RecorderLLMClient] fixture-append failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return completion;
    }

    private buildMatcher(messages: LLMMessage[]): Record<string, unknown> {
        const latestUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
        const latestTool = [...messages].reverse().find((m) => m.role === "tool")?.content ?? "";
        const assistantTurnIndex = messages.filter((m) => m.role === "assistant").length;

        switch (this.strategy) {
            case "userMessageEquals":
                return { userMessageEquals: latestUser };
            case "userMessageContains":
                // Substring of length ≥ 8 chars to keep the matcher distinctive.
                return { userMessageContains: latestUser.slice(0, Math.max(8, Math.floor(latestUser.length * 0.3))) };
            case "latestToolResultContains":
                // Pin a chunk of the tool result; needed for turn-2+ replays.
                return { latestToolResultContains: latestTool.slice(0, Math.min(40, latestTool.length)) };
            case "assistantTurnIndex":
                return { assistantTurnIndex };
        }
    }
}
