// ============================================================
// Tool Registry — Phase 0 Boot
// ============================================================
// Phase 0 registers exactly one tool: search_availability.
// Phase 5 will register the full set: run_full_audit, plan_semester,
// search_policy, etc.
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
export {
    searchAvailability,
    type SearchAvailabilityInput,
    type SearchAvailabilityOutput,
    type SectionView,
} from "./searchAvailability.js";

// Boot the Phase 0 registry. Importing this module registers the tool.
import { registerTool } from "./types.js";
import { searchAvailability } from "./searchAvailability.js";

registerTool(searchAvailability);
