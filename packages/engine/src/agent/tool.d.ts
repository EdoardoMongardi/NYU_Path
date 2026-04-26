import type { z } from "zod";
export interface ToolUseContext {
    /** AbortSignal threaded from the agent loop */
    signal: AbortSignal;
    /** Free-form context the tool may read (e.g., student profile, session) */
    session: ToolSession;
}
export interface PendingProfileMutation {
    /** Stable id used by `confirm_profile_update` to apply this mutation */
    id: string;
    field: "homeSchool" | "catalogYear" | "declaredPrograms" | "visaStatus";
    before: unknown;
    after: unknown;
    /** Free-form impacts the chat layer surfaces to the user before confirmation */
    impacts: string[];
}
export interface ToolSession {
    /** The student profile the agent is advising for. Optional — many tools require it. */
    student?: import("@nyupath/shared").StudentProfile;
    /** Programs catalog, courses, prereqs, schoolConfig — things tool calls need */
    courses?: import("@nyupath/shared").Course[];
    prereqs?: import("@nyupath/shared").Prerequisite[];
    programs?: Map<string, import("@nyupath/shared").Program>;
    schoolConfig?: import("@nyupath/shared").SchoolConfig | null;
    /** Whether the user is exploring a transfer (affects template applicability) */
    transferIntent?: boolean;
    /**
     * Profile-mutation previews staged by `update_profile`, awaiting an
     * explicit `confirm_profile_update` call. Per §7.2's two-step
     * contract, `update_profile.call()` MUST NOT mutate the profile —
     * it stages here and the agent loop surfaces the preview.
     */
    pendingMutations?: Map<string, PendingProfileMutation>;
    /** RAG corpus + reranker (Phase 4 wiring) used by search_policy */
    rag?: {
        store: import("../rag/vectorStore.js").VectorStore;
        embedder: import("../rag/embedder.js").Embedder;
        reranker: import("../rag/reranker.js").Reranker;
        templates: import("../rag/policyTemplate.js").PolicyTemplate[];
    };
}
export type ValidationResult = {
    ok: true;
} | {
    ok: false;
    userMessage: string;
};
export interface Tool<InputSchema extends z.ZodTypeAny, Output> {
    /** Stable name the model addresses (e.g., "run_full_audit") */
    readonly name: string;
    /** Free-form description shown to the model */
    readonly description: string;
    /** Zod schema for the call's input */
    readonly inputSchema: InputSchema;
    /** True if the tool never mutates `ToolSession` state */
    readonly isReadOnly: boolean;
    /** Max characters for the tool's stringified result (truncated above) */
    readonly maxResultChars: number;
    /** Optional pre-call validation (returns user-facing reason for rejection) */
    validateInput?(input: z.infer<InputSchema>, ctx: ToolUseContext): Promise<ValidationResult>;
    /** Long-form prompt to expose to the model (system-prompt time) */
    prompt(ctx: {
        session: ToolSession;
    }): string;
    /** Run the tool. Implementations MUST honor `ctx.signal`. */
    call(input: z.infer<InputSchema>, ctx: ToolUseContext): Promise<Output>;
    /** Render a model-readable summary of the output. Bounded by maxResultChars. */
    summarizeResult(output: Output): string;
}
/**
 * `buildTool` is the factory that produces a fully-typed Tool from
 * a literal-shaped definition. The factory exists mostly to enforce
 * the maxResultChars cap and to surface a couple of sane defaults.
 */
export declare function buildTool<InputSchema extends z.ZodTypeAny, Output>(def: {
    name: string;
    description: string;
    inputSchema: InputSchema;
    isReadOnly?: boolean;
    maxResultChars?: number;
    validateInput?: Tool<InputSchema, Output>["validateInput"];
    prompt: Tool<InputSchema, Output>["prompt"];
    call: Tool<InputSchema, Output>["call"];
    summarizeResult: Tool<InputSchema, Output>["summarizeResult"];
}): Tool<InputSchema, Output>;
export declare class ToolRegistry {
    private readonly byName;
    constructor(tools: Array<Tool<z.ZodTypeAny, unknown>>);
    get(name: string): Tool<z.ZodTypeAny, unknown> | undefined;
    list(): Array<Tool<z.ZodTypeAny, unknown>>;
    has(name: string): boolean;
}
//# sourceMappingURL=tool.d.ts.map