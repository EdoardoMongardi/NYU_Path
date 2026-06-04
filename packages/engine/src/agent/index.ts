// ============================================================
// Agent module — barrel exports (Phase 5)
// ============================================================
export { buildTool, ToolRegistry } from "./tool.js";
export type {
    Tool,
    ToolUseContext,
    ToolSession,
    ValidationResult,
} from "./tool.js";

export {
    ALL_NYUPATH_TOOLS,
    buildDefaultRegistry,
    runFullAuditTool,
    whatIfAuditTool,
    searchPolicyTool,
    getProgramRequirementsTool,
    updateProfileTool,
    confirmProfileUpdateTool,
    getCreditCapsTool,
    searchAvailabilityTool,
    getAcademicStandingTool,
    searchCoursesTool,
    // Phase 16 Task B — exposed so the Update-DPR route can re-plan
    // programmatically without having to spin up the full agent loop.
    planForwardDegreeTool,
    // Phase 17 Task B — exposed so the deterministic plan-action
    // routes (/api/plan/add|swap|drop|lock|move|confirm) can run the
    // structural validation + persist pipeline without going through
    // the agent loop.
    proposePlanChangeTool,
    confirmPlanChangeTool,
} from "./registry.js";

export { createSemanticCourseSearchFn } from "./tools/semanticCourseSearch.js";
export type {
    SemanticCourseSearchOptions,
    CourseCatalogEntry,
} from "./tools/semanticCourseSearch.js";
export type { CourseSearchFn } from "./tools/searchCourses.js";

export type {
    LLMClient,
    LLMCompletion,
    LLMMessage,
    LLMToolCall,
    LLMToolDef,
} from "./llmClient.js";

export { runAgentTurn, runAgentTurnStreaming } from "./agentLoop.js";
export type {
    AgentTurnOptions,
    ChatTurnResult,
    ToolInvocation,
    AgentStreamEvent,
} from "./agentLoop.js";

export {
    createLoopState,
    recordTransition,
    enforceToolResultBudget,
    measureContextPressure,
    estimateTokens,
    MAX_TOOL_RESULT_BUDGET,
    TOOL_RESULT_KEEP_RECENT,
    DEFAULT_MODEL_WINDOW_TOKENS,
    TIER2_TRIP_FRACTION,
    TIER3_TRIP_FRACTION,
} from "./loopState.js";
export type {
    LoopState,
    LoopStateOptions,
    TransitionReason,
    TransitionRecord,
    ContextPressure,
} from "./loopState.js";

export type { LLMStreamEvent } from "./llmClient.js";

export { buildSystemPrompt } from "./systemPrompt.js";
export type { SystemPromptOptions } from "./systemPrompt.js";

export {
    validateResponse,
    extractClaimNumbers,
} from "./responseValidator.js";
export type {
    Violation,
    ViolationKind,
    ValidatorVerdict,
    ValidatorContext,
} from "./responseValidator.js";

export {
    reviewCompleteness,
} from "./completenessReviewer.js";
export type {
    CompletenessReviewVerdict,
} from "./completenessReviewer.js";

// Phase 11 S3 — multi-intent detector
export {
    detectMultiIntent,
    renderMultiIntentBriefing,
} from "./verifiers/multiIntentDetector.js";
export type {
    MultiIntentReport,
    MultiIntentSignal,
} from "./verifiers/multiIntentDetector.js";

// Phase 11 S4 — gated clarifier sub-agent
export {
    detectAmbiguity,
    askClarification,
} from "./clarifier.js";
export type {
    AmbiguityReport,
    AmbiguitySignal,
    ClarificationResult,
} from "./clarifier.js";

export { RecordingLLMClient } from "./recordingClient.js";
export { RecorderLLMClient } from "./recorderClient.js";
export type { RecorderOptions, RecorderMatchStrategy } from "./recorderClient.js";

// Phase 15 Task 8 — surface the section-materialization domain types
// so the apps/web sidebar can type the SSE `forward_materialization_update`
// payload without reaching deep into engine internals.
//
// NOTE: `SectionView` is intentionally NOT re-exported here — there is
// already an unrelated `SectionView` shape exported via
// `tools/searchAvailability.ts` and adding both would create a name
// collision in the `@nyupath/engine` barrel. The materialization-type
// `SectionView` is referenced through `MaterializedSemester["courses"]`
// for the UI use case; consumers needing the bare shape can import it
// directly from the `sectionMaterialization/types.js` module.
export type {
    AvailabilityState,
    MaterializationResult,
    MaterializedSemester,
    SchedulingPreferenceCheck,
} from "./sectionMaterialization/types.js";

// Phase 17 Task D follow-up — exposed so the /api/plan/stage2 route
// can run the section-materialization pipeline directly per term in
// `futureTerms[]` without spinning up the agent loop.
export { materializeSections } from "./sectionMaterialization/materialize.js";
export type { MaterializeArgs } from "./sectionMaterialization/materialize.js";

export { OpenAIEngineClient, toOpenAIMessage } from "./clients/openaiClient.js";
export type { OpenAIClientOptions } from "./clients/openaiClient.js";
export { AnthropicEngineClient, toAnthropicMessage } from "./clients/anthropicClient.js";
export type { AnthropicClientOptions } from "./clients/anthropicClient.js";
export {
    createPrimaryClient,
    createFallbackClient,
    DEFAULT_PRIMARY_PROVIDER,
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FALLBACK_PROVIDER,
    DEFAULT_FALLBACK_MODEL,
} from "./clients/index.js";
