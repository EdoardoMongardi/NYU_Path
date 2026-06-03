// ============================================================
// Tool Types — legacy Phase 0 surface
// ============================================================
// Phase 0 originally registered a `searchAvailability` tool here.
// That tool has been superseded by the live agent registry under
// `src/agent/`. This module now exists only to re-export the legacy
// `Tool` / `ToolDef` / `ToolContext` shapes so that `src/index.ts`
// can keep its public type surface stable for downstream consumers.
// ============================================================

export {
    buildTool,
    getTool,
    listTools,
    registerTool,
    type Tool,
    type ToolContext,
    type ToolDef,
    type ValidationResult,
} from "./types.js";
