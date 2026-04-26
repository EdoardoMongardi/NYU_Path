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
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
    };
    modelEcho?: string;
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
}
//# sourceMappingURL=llmClient.d.ts.map