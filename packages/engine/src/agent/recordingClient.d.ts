import type { LLMClient, LLMCompletion, LLMMessage, LLMToolDef } from "./llmClient.js";
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
        toolCalls?: Array<{
            id: string;
            name: string;
            args: Record<string, unknown>;
        }>;
        latencyMs?: number;
        usage?: {
            promptTokens?: number;
            completionTokens?: number;
        };
    };
}
export declare class RecordingLLMClient implements LLMClient {
    readonly id: string;
    private readonly recordings;
    constructor(opts: {
        id?: string;
        recordings: Recording[];
    });
    static fromJsonl(path: string, opts?: {
        id?: string;
    }): RecordingLLMClient;
    complete(args: {
        system: string;
        messages: LLMMessage[];
        tools?: LLMToolDef[];
        maxTokens?: number;
        temperature?: number;
        signal?: AbortSignal;
    }): Promise<LLMCompletion>;
}
export {};
//# sourceMappingURL=recordingClient.d.ts.map