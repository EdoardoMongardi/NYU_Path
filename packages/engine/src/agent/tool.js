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
/**
 * `buildTool` is the factory that produces a fully-typed Tool from
 * a literal-shaped definition. The factory exists mostly to enforce
 * the maxResultChars cap and to surface a couple of sane defaults.
 */
export function buildTool(def) {
    return {
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        isReadOnly: def.isReadOnly ?? true,
        maxResultChars: def.maxResultChars ?? 2000,
        validateInput: def.validateInput,
        prompt: def.prompt,
        call: def.call,
        summarizeResult: (output) => {
            const raw = def.summarizeResult(output);
            const cap = def.maxResultChars ?? 2000;
            return raw.length > cap ? raw.slice(0, cap) + "…" : raw;
        },
    };
}
// ============================================================
// Tool registry
// ============================================================
export class ToolRegistry {
    byName = new Map();
    constructor(tools) {
        for (const tool of tools) {
            if (this.byName.has(tool.name)) {
                throw new Error(`ToolRegistry: duplicate tool name "${tool.name}"`);
            }
            this.byName.set(tool.name, tool);
        }
    }
    get(name) {
        return this.byName.get(name);
    }
    list() {
        return [...this.byName.values()];
    }
    has(name) {
        return this.byName.has(name);
    }
}
//# sourceMappingURL=tool.js.map