// Engine barrel export
export { degreeAudit } from "./audit/degreeAudit.js";
export { evaluateRule } from "./audit/ruleEvaluator.js";
export { validateCreditCaps } from "./audit/creditCapValidator.js";
export { checkPassFailViolations } from "./audit/passfailGuard.js";
export { calculateStanding, computeSemesterGPA } from "./audit/academicStanding.js";
export { PrereqGraph } from "./graph/prereqGraph.js";
export { EquivalenceResolver } from "./equivalence/equivalenceResolver.js";
export { loadCourses, loadPrereqs, loadPrograms, loadProgram } from "./dataLoader.js";
export { resolveExamCredit, EXAM_GENERAL_RULES } from "./data/examEquivalencies.js";

// Phase 1: Planner
export { planNextSemester } from "./planner/semesterPlanner.js";
export { scoreCourses } from "./planner/priorityScorer.js";
export { detectGraduationRisks } from "./planner/graduationRisk.js";

// Phase 1: NYU API Client
export {
    searchCourses,
    getCourseDetails,
    fetchTermCourses,
    extractAvailableCourseIds,
    extractAllCourseIds,
    generateTermCode,
    getRecentTermOptions,
} from "./api/nyuClassSearch.js";

// Phase 0: Provenance schema
export {
    metaSchema,
    validateMeta,
    isStale,
    STALENESS_DAYS,
    type Meta,
} from "./provenance/schema.js";

// Phase 0: Catalog-year pinning loader
export {
    resolveProgramFile,
    applicableCatalogYear,
    type ResolveResult,
} from "./data/catalogYearLoader.js";

// Phase 0: Departments stub (reserved precedence slot)
export {
    loadDepartmentConfig,
    type DepartmentConfig,
} from "./data/departmentLoader.js";

// Phase 0: Tool registry + first tool
export {
    buildTool,
    getTool,
    listTools,
    registerTool,
    searchAvailability,
    type SearchAvailabilityInput,
    type SearchAvailabilityOutput,
    type SectionView,
    type Tool,
    type ToolContext,
    type ToolDef,
    type ValidationResult,
} from "./tools/index.js";

// Phase 6 WS4: observability
export {
    InMemoryFallbackSink,
    JsonlFileSink,
    NULL_SINK,
    defaultProductionSink,
    emitFallback,
} from "./observability/fallbackLog.js";
export type {
    FallbackEvent,
    FallbackEventKind,
    FallbackSink,
} from "./observability/fallbackLog.js";

// Phase 5 + Phase 6: agent loop, registry, tools, validators, clients
export {
    runAgentTurn,
    runAgentTurnStreaming,
    buildDefaultRegistry,
    buildSystemPrompt,
    preLoopDispatch,
    validateResponse,
    extractClaimNumbers,
    RecordingLLMClient,
    RecorderLLMClient,
    OpenAIEngineClient,
    AnthropicEngineClient,
    createPrimaryClient,
    createFallbackClient,
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FALLBACK_MODEL,
    runFullAuditTool,
    planSemesterTool,
    checkTransferEligibilityTool,
    whatIfAuditTool,
    searchPolicyTool,
    updateProfileTool,
    confirmProfileUpdateTool,
    getCreditCapsTool,
    searchAvailabilityTool,
} from "./agent/index.js";
export type {
    AgentTurnOptions,
    AgentStreamEvent,
    ChatTurnResult,
    ToolInvocation,
    ToolSession,
    LLMClient,
    LLMCompletion,
    LLMMessage,
    LLMStreamEvent,
    LLMToolCall,
    LLMToolDef,
    Violation,
    ViolationKind,
    ValidatorVerdict,
    ValidatorContext,
    PreLoopResult,
    PreLoopOptions,
    SystemPromptOptions,
} from "./agent/index.js";

// Phase 4: RAG entry points (used by the agent's search_policy tool
// + by the v2 web route to load the curated template corpus).
export { loadPolicyTemplates } from "./rag/index.js";
export type { PolicyTemplate } from "./rag/policyTemplate.js";

// Phase 4 + Phase 7-B Step 3: embedder interface + OpenAI adapter
// + semantic course-search wiring (used by the v2 web route to inject
// a CourseSearchFn into the agent session).
export { LocalHashEmbedder, OpenAIEmbedder, cosineSim } from "./rag/embedder.js";
export type { Embedder } from "./rag/embedder.js";

// Phase 4 + Phase 7-B Step 12-13: vector store, reranker, policy
// search, and the disk-cache loader the v2 route uses to hydrate
// the policy corpus without re-embedding on cold start.
export { VectorStore } from "./rag/vectorStore.js";
export type { VectorSearchHit, IndexedChunk } from "./rag/vectorStore.js";
export { LocalLexicalReranker, CohereReranker } from "./rag/reranker.js";
export type { Reranker, RerankedHit, CohereRerankerOptions } from "./rag/reranker.js";
export {
    policySearch,
    CONFIDENCE_HIGH,
    CONFIDENCE_MEDIUM,
    COHERE_CONFIDENCE_BANDS,
    matchTemplate,
    buildCorpus,
    DEFAULT_ENTRIES,
    loadPolicyCorpusFromCache,
} from "./rag/index.js";
export type {
    PolicySearchResult,
    PolicySearchOptions,
    PolicySearchDeps,
    ConfidenceBand,
    ConfidenceBandThresholds,
    PolicyChunk,
    ChunkMeta,
    ChunkOptions,
    BuildCorpusOptions,
    BuildCorpusResult,
    PolicyCorpusCacheMeta,
    LoadPolicyCorpusOptions,
    LoadPolicyCorpusResult,
} from "./rag/index.js";
export {
    searchCoursesTool,
    createSemanticCourseSearchFn,
} from "./agent/index.js";
export type {
    CourseSearchFn,
    SemanticCourseSearchOptions,
    CourseCatalogEntry,
} from "./agent/index.js";

// Phase 6.5 P-4: cohort gate + template-only recovery mode (§12.6.5)
export {
    COHORT_CONFIGS,
    setCohortAssignment,
    getCohortAssignment,
    userInCohort,
    getCohortConfig,
    runTemplateMatcherOnly,
} from "./cohort/gate.js";
export type {
    Cohort,
    CohortConfig,
    CohortAssignment,
    TemplateOnlyResult,
} from "./cohort/gate.js";

// Phase 7-A P-9: §7.3 session-summary persistence (rolling window of 5)
export {
    InMemorySessionStore,
    FileBackedSessionStore,
    defaultSessionStore,
    summariesAsPriorMessage,
    MAX_SESSION_SUMMARIES,
} from "./persistence/sessionStore.js";
export type {
    SessionStore,
    SessionSummary,
    StudentSessionRecord,
} from "./persistence/sessionStore.js";

// Phase 7-B Step 10: confirm_profile_update persistence hook
export { InMemoryProfileStore } from "./persistence/profileStore.js";
export type {
    ProfileStore,
    ProfileMutationAuditEntry,
} from "./persistence/profileStore.js";
