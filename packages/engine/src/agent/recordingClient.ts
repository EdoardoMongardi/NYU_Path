// ============================================================
// RecordingLLMClient — replay LLM completions from disk
// ============================================================
// Test-path LLMClient that replays canned (system, messages, tools) →
// completion mappings from a JSONL fixture. Lets unit tests drive the
// agent loop deterministically without network calls.
//
// Recordings file format (JSONL — one JSON object per line):
//   { "match": { "userMessageContains": "graduate" },
//     "completion": { "text": "...", "toolCalls": [...], ... } }
//
// Match strategy (in order): exact-match on the latest user message,
// then `userMessageContains` substring, then `assistantTurnIndex`
// (for chained turns). Throws if no match. Record once via the
// `record` companion (Phase 5 follow-up — not built at v1).
// ============================================================

import { readFileSync } from "node:fs";
import type {
    LLMClient,
    LLMCompletion,
    LLMMessage,
    LLMToolCall,
    LLMToolDef,
} from "./llmClient.js";

interface RecordingMatcher {
    /** Exact match on the latest user message content */
    userMessageEquals?: string;
    /** Substring match on the latest user message content */
    userMessageContains?: string;
    /** Exact tool-result match — the latest message must be a tool message
     *  whose content includes this substring (used for multi-turn replays). */
    latestToolResultContains?: string;
    /** Match by 0-indexed assistant-turn position in the conversation */
    assistantTurnIndex?: number;
}

interface Recording {
    match: RecordingMatcher;
    completion: {
        text: string;
        toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
        latencyMs?: number;
        usage?: { promptTokens?: number; completionTokens?: number };
    };
}

export class RecordingLLMClient implements LLMClient {
    public readonly id: string;
    private readonly recordings: Recording[];

    constructor(opts: { id?: string; recordings: Recording[] }) {
        this.id = opts.id ?? "recording-llm";
        this.recordings = opts.recordings;
    }

    static fromJsonl(path: string, opts?: { id?: string }): RecordingLLMClient {
        const lines = readFileSync(path, "utf-8")
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith("//"));
        const recordings: Recording[] = lines.map((l) => JSON.parse(l) as Recording);
        return new RecordingLLMClient({ id: opts?.id, recordings });
    }

    async complete(args: {
        system: string;
        messages: LLMMessage[];
        tools?: LLMToolDef[];
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    }): Promise<LLMCompletion> {
        const latestUser = [...args.messages]
            .reverse()
            .find((m) => m.role === "user")?.content ?? "";
        const latestTool = [...args.messages]
            .reverse()
            .find((m) => m.role === "tool")?.content ?? "";
        const assistantTurnIndex = args.messages.filter((m) => m.role === "assistant").length;

        const match = this.recordings.find((r) => {
            const m = r.match;
            if (m.userMessageEquals !== undefined && latestUser !== m.userMessageEquals) return false;
            if (m.userMessageContains !== undefined && !latestUser.includes(m.userMessageContains)) return false;
            if (m.latestToolResultContains !== undefined && !latestTool.includes(m.latestToolResultContains)) return false;
            if (m.assistantTurnIndex !== undefined && assistantTurnIndex !== m.assistantTurnIndex) return false;
            return true;
        });
        if (!match) {
            throw new Error(
                `RecordingLLMClient: no recording matched. ` +
                `latestUser="${latestUser.slice(0, 80)}" assistantTurnIndex=${assistantTurnIndex}`,
            );
        }
        const tcs: LLMToolCall[] = (match.completion.toolCalls ?? []).map((t) => ({
            id: t.id, name: t.name, args: t.args,
        }));
        return {
            text: match.completion.text,
            toolCalls: tcs,
            latencyMs: match.completion.latencyMs ?? 0,
            usage: match.completion.usage,
            modelEcho: this.id,
        };
    }
}
