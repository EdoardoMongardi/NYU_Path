// ============================================================
// Tool Registry — Thin Stub (ARCHITECTURE.md §6.2 / §11.7.3)
// ============================================================
// Phase 0 deliverable: a minimal Tool interface that Phase 5's full
// orchestrator will fill in. Modeled after Claude Code's Tool.ts but
// trimmed to what Phase 0 actually needs:
//   - typed inputSchema (Zod)
//   - validateInput / call signatures
//   - read-only / concurrency-safe flags (default fail-closed)
//   - maxResultChars cap
//
// Intentionally NOT included at Phase 0:
//   - prompt() (LLM-facing description) — Phase 5
//   - permissions / userConfirmation — Phase 5
//   - streaming output — Phase 5
//   - context modifiers / state mutation — Phase 5
// ============================================================

import type { z } from "zod";

export type ValidationResult =
    | { result: true }
    | { result: false; message: string; errorCode?: number };

export interface ToolContext {
    /**
     * Abort signal propagated from the agent loop so long-running tools
     * can cancel cleanly. Phase 0 tools are not required to honor this,
     * but Phase 5 will require it for read-only tools that hit the network.
     */
    readonly signal?: AbortSignal;
}

export interface Tool<Input, Output> {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: z.ZodType<Input>;
    /** Defaults to `false` (fail-closed). Read-only tools may run in parallel. */
    readonly isReadOnly: boolean;
    /** Defaults to `false` (fail-closed). Tools that mutate shared state cannot run concurrently. */
    readonly isConcurrencySafe: boolean;
    /** Cap on the serialized tool result size — prevents context bloat. */
    readonly maxResultChars: number;
    validateInput(input: Input): ValidationResult;
    call(input: Input, ctx: ToolContext): Promise<Output>;
}

export interface ToolDef<Input, Output>
    extends Partial<Pick<Tool<Input, Output>, "isReadOnly" | "isConcurrencySafe">> {
    name: string;
    description: string;
    inputSchema: z.ZodType<Input>;
    maxResultChars: number;
    validateInput?: (input: Input) => ValidationResult;
    call: (input: Input, ctx: ToolContext) => Promise<Output>;
}

/**
 * Build a Tool with safe defaults.
 *
 *   isReadOnly:        defaults to FALSE (fail-closed; opt-in to read-only)
 *   isConcurrencySafe: defaults to FALSE (fail-closed; opt-in to concurrency)
 *
 * Default validateInput just runs the Zod schema and returns a structured
 * result the LLM can read.
 */
export function buildTool<Input, Output>(def: ToolDef<Input, Output>): Tool<Input, Output> {
    const validateInput =
        def.validateInput ??
        ((input: Input) => {
            const r = def.inputSchema.safeParse(input);
            if (r.success) return { result: true } as const;
            return {
                result: false,
                message: r.error.issues
                    .map((i) => `${i.path.join(".")}: ${i.message}`)
                    .join("; "),
            } as const;
        });
    return {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        isReadOnly: def.isReadOnly ?? false,
        isConcurrencySafe: def.isConcurrencySafe ?? false,
        maxResultChars: def.maxResultChars,
        validateInput,
        call: def.call,
    };
}

// ============================================================
// Registry
// ============================================================
// Phase 0: a single source-of-truth list of registered tools, sorted
// for cache stability per Claude Code's tools.ts pattern.
// ============================================================

const REGISTRY = new Map<string, Tool<unknown, unknown>>();

export function registerTool<I, O>(tool: Tool<I, O>): void {
    if (REGISTRY.has(tool.name)) {
        throw new Error(`Tool name collision: "${tool.name}"`);
    }
    REGISTRY.set(tool.name, tool as Tool<unknown, unknown>);
}

export function getTool(name: string): Tool<unknown, unknown> | undefined {
    return REGISTRY.get(name);
}

export function listTools(): Tool<unknown, unknown>[] {
    return [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Phase 0 testing helper. Not exported from public index. */
export function __resetRegistryForTests(): void {
    REGISTRY.clear();
}
