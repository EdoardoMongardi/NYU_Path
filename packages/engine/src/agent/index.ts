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
    planSemesterTool,
    checkTransferEligibilityTool,
    whatIfAuditTool,
    searchPolicyTool,
    updateProfileTool,
    confirmProfileUpdateTool,
    getCreditCapsTool,
    searchAvailabilityTool,
} from "./registry.js";

export type {
    LLMClient,
    LLMCompletion,
    LLMMessage,
    LLMToolCall,
    LLMToolDef,
} from "./llmClient.js";

export { runAgentTurn } from "./agentLoop.js";
export type {
    AgentTurnOptions,
    ChatTurnResult,
    ToolInvocation,
} from "./agentLoop.js";

export { buildSystemPrompt } from "./systemPrompt.js";
export type { SystemPromptOptions } from "./systemPrompt.js";

export { preLoopDispatch } from "./templateMatcher.js";
export type { PreLoopResult, PreLoopOptions } from "./templateMatcher.js";

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

export { RecordingLLMClient } from "./recordingClient.js";

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
