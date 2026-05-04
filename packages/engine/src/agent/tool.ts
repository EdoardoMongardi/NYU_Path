// ============================================================
// Tool factory + registry (Phase 5 §7.2)
// ============================================================
// Inspired by the Claude Code tool design (Tool.ts in the leaked
// source — `Tool<Input, Output>` interface with isReadOnly / call /
// validateInput / prompt / inputSchema). Adapted for the NYU Path
// scope: read-only tools only, no permissions, no progress streaming,
// no subagent escalation.
//
// A `Tool` here is a typed wrapper that:
//   1. Carries a Zod input schema (validated before `call` runs)
//   2. Declares whether the tool is read-only (always true at v1)
//   3. Provides a `prompt()` factory for the model-facing description
//   4. Provides a `call()` async runner that returns a typed output
//   5. Provides a `summarizeResult()` that produces the user-facing
//      string the agent can quote — this is the SAFE part of the
//      output the response validator can ground against.
// ============================================================

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
     * Phase 11 follow-up — the latest user message text. Threaded by
     * the route layer so tool `validateInput` hooks can apply scope
     * guards based on the user's intent (e.g., reject
     * `check_transfer_eligibility` when the message keys on
     * "minor"). Optional — when unset, scope guards no-op.
     */
    lastUserMessage?: string;
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
        /** Phase 7-B Step 13: confidence-band thresholds calibrated for
         *  the active reranker. Optional — defaults to the lexical
         *  reranker bands when unset. */
        confidenceBands?: import("../rag/policySearch.js").ConfidenceBandThresholds;
    };
    /**
     * Phase 7-E W3 — parsed Albert Degree Progress Report. When present,
     * `run_full_audit` and `plan_semester` read deterministic audit
     * verdicts from here (NYU's pre-computed numbers) instead of running
     * the local rule engine. `what_if_audit` uses it as the transcript
     * source when projecting against just-in-time-extracted hypothetical
     * programs. Cardinal Rule §2.1 holds because every numerical claim
     * traces to a field on this object.
     */
    degreeProgressReport?: import("../dpr/schema.js").DegreeProgressReport;
    /**
     * Optional persistence hook. When present, `confirm_profile_update`
     * (Phase 7-B Step 10) writes the post-mutation profile + an audit
     * row through this store on apply. When absent, the tool is purely
     * in-memory (the historical Phase 5 behavior). Persistence failures
     * are swallowed — the live session remains the source of truth.
     */
    profileStore?: import("../persistence/profileStore.js").ProfileStore;

    /** Phase 13 — solved forward schedule. Set by `plan_forward_degree`
     *  when state ∈ { "valid-clean", "valid-with-trade-offs" }. Read by
     *  `view_forward_plan`, the SSE route, and the chat sidebar. */
    forwardSchedule?: import("@nyupath/shared").ForwardSchedule;

    /** Phase 13 — draft schedule for plans whose state is
     *  "infeasible-draft" OR (Phase 14) "student-preferred-invalid-draft".
     *  Decision #32 mandates these NEVER write to forwardSchedule so the
     *  agent doesn't endorse an illegal plan. */
    studentDraftPlan?: import("@nyupath/shared").ForwardSchedule;

    /** Phase 14 — student-driven preferences for the forward planner
     *  (load styles, pins, exclusions, summer/J-term opt-in, plus the
     *  defined-but-unused-at-Phase-14 SchedulingPreferences slot per
     *  Decision #43). Mutated by `confirm_plan_change`; read by
     *  `solveForwardSchedule` when computing the next plan. In-memory;
     *  lost on session end. */
    schedulePreferences?: import("@nyupath/shared").SchedulePreferences;
}

export type ValidationResult =
    | { ok: true }
    | { ok: false; userMessage: string };

/**
 * Phase 7-B Step 15 — output composition mode (§3.2 lines 192-227).
 *   - "template"      — bypass LLM (template fast-path uses preLoopDispatch).
 *   - "semi_hardened" — tool surfaces a `verbatimText`; the validator
 *                       requires it to appear unchanged in the reply.
 *   - "synthesis"     — free LLM synthesis (default).
 */
export type OutputMode = "template" | "semi_hardened" | "synthesis";

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
    /** Phase 7-B Step 15 — composition mode. Defaults to "synthesis". */
    readonly outputMode?: OutputMode;
    /** Optional pre-call validation (returns user-facing reason for rejection) */
    validateInput?(input: z.infer<InputSchema>, ctx: ToolUseContext): Promise<ValidationResult>;
    /** Long-form prompt to expose to the model (system-prompt time) */
    prompt(ctx: { session: ToolSession }): string;
    /** Run the tool. Implementations MUST honor `ctx.signal`. */
    call(input: z.infer<InputSchema>, ctx: ToolUseContext): Promise<Output>;
    /** Render a model-readable summary of the output. Bounded by maxResultChars. */
    summarizeResult(output: Output): string;
    /**
     * Phase 7-B Step 15 — when `outputMode === "semi_hardened"` the tool
     * MUST also surface the verbatim text the LLM is required to include
     * unchanged. The validator string-matches this against the final reply.
     * Returns null when no verbatim text is required for this output.
     */
    extractVerbatim?(output: Output): string | null;
}

/**
 * `buildTool` is the factory that produces a fully-typed Tool from
 * a literal-shaped definition. The factory exists mostly to enforce
 * the maxResultChars cap and to surface a couple of sane defaults.
 */
export function buildTool<InputSchema extends z.ZodTypeAny, Output>(
    def: {
        name: string;
        description: string;
        inputSchema: InputSchema;
        isReadOnly?: boolean;
        maxResultChars?: number;
        outputMode?: OutputMode;
        validateInput?: Tool<InputSchema, Output>["validateInput"];
        prompt: Tool<InputSchema, Output>["prompt"];
        call: Tool<InputSchema, Output>["call"];
        summarizeResult: Tool<InputSchema, Output>["summarizeResult"];
        extractVerbatim?: Tool<InputSchema, Output>["extractVerbatim"];
    },
): Tool<InputSchema, Output> {
    return {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        isReadOnly: def.isReadOnly ?? true,
        maxResultChars: def.maxResultChars ?? 2000,
        outputMode: def.outputMode ?? "synthesis",
        validateInput: def.validateInput,
        prompt: def.prompt,
        call: def.call,
        summarizeResult: (output) => {
            const raw = def.summarizeResult(output);
            const cap = def.maxResultChars ?? 2000;
            return raw.length > cap ? raw.slice(0, cap) + "…" : raw;
        },
        extractVerbatim: def.extractVerbatim,
    };
}

// ============================================================
// Tool registry
// ============================================================

export class ToolRegistry {
    private readonly byName = new Map<string, Tool<z.ZodTypeAny, unknown>>();

    constructor(tools: Array<Tool<z.ZodTypeAny, unknown>>) {
        for (const tool of tools) {
            if (this.byName.has(tool.name)) {
                throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
            }
            this.byName.set(tool.name, tool);
        }
    }

    get(name: string): Tool<z.ZodTypeAny, unknown> | undefined {
        return this.byName.get(name);
    }

    list(): Array<Tool<z.ZodTypeAny, unknown>> {
        return [...this.byName.values()];
    }

    has(name: string): boolean {
        return this.byName.has(name);
    }
}
