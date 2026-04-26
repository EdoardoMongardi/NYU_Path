import type { LLMClient, LLMMessage } from "./llmClient.js";
import type { ToolSession } from "./tool.js";
import type { ToolRegistry } from "./tool.js";
export interface AgentTurnOptions {
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
}
export interface ToolInvocation {
    toolName: string;
    args: Record<string, unknown>;
    /** Truthy when the tool's `validateInput` rejected the call */
    rejected?: {
        userMessage: string;
    };
    /** Truthy when the tool ran and returned a result */
    summary?: string;
    /** Truthy when the tool threw mid-call */
    error?: {
        message: string;
    };
    /** Wall-clock ms spent inside `tool.call()` (validation excluded) */
    callMs?: number;
}
export type ChatTurnResult = {
    kind: "ok";
    finalText: string;
    invocations: ToolInvocation[];
    /** All messages exchanged THIS turn (model + tool messages) */
    turnMessages: LLMMessage[];
    usage: {
        promptTokens: number;
        completionTokens: number;
    };
    modelUsedId: string;
} | {
    kind: "max_turns";
    invocations: ToolInvocation[];
    turnMessages: LLMMessage[];
    modelUsedId: string;
} | {
    kind: "aborted";
    invocations: ToolInvocation[];
    turnMessages: LLMMessage[];
    modelUsedId: string;
} | {
    kind: "model_error_no_fallback";
    error: string;
    invocations: ToolInvocation[];
    turnMessages: LLMMessage[];
    modelUsedId: string;
};
/**
 * Run a single user message through the agent loop. Stateless w.r.t. the
 * client — the caller manages session/history persistence.
 */
export declare function runAgentTurn(client: LLMClient, registry: ToolRegistry, session: ToolSession, userMessage: string, options: AgentTurnOptions): Promise<ChatTurnResult>;
//# sourceMappingURL=agentLoop.d.ts.map