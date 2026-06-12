// Engine barrel export
export { calculateStanding, computeSemesterGPA } from "./audit/academicStanding.js";
export { loadCourses, loadPrereqs, loadSchoolConfig } from "./dataLoader.js";
export { canonicalizeCourseId, canonicalizeCourseIdSet } from "./courseId.js";
// Phase E (de-CAS) — shared NYU-undergrad registration defaults + school names.
export {
    DEFAULT_PER_SEMESTER_CEILING,
    DEFAULT_F1_FULLTIME_MIN_CREDITS,
    perSemesterCeilingFor,
    schoolDisplayName,
    SCHOOL_DISPLAY_NAMES,
} from "./data/schoolDefaults.js";

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
    validateResponse,
    detectMultiIntent,
    renderMultiIntentBriefing,
    detectAmbiguity,
    askClarification,
    // D7.1/D7.2 — proactive elicitation detector + the append decision
    // the v2 route consumes AFTER the agent loop (append-not-substitute,
    // frequency-bounded). Surfaced on the top-level barrel so the route's
    // `@nyupath/engine` import resolves them.
    detectElicitationOpportunity,
    decideElicitationAppend,
    elicitationQuestionFor,
    ELICITATION_LEAD_IN,
    extractClaimNumbers,
    RecordingLLMClient,
    OpenAIEngineClient,
    AnthropicEngineClient,
    createPrimaryClient,
    createFallbackClient,
    DEFAULT_PRIMARY_MODEL,
    DEFAULT_FALLBACK_MODEL,
    runFullAuditTool,
    whatIfAuditTool,
    searchPolicyTool,
    getProgramRequirementsTool,
    updateProfileTool,
    confirmProfileUpdateTool,
    getCreditCapsTool,
    searchAvailabilityTool,
    // Phase 16 Task B — Update-DPR route invokes this programmatically.
    planForwardDegreeTool,
    // Phase 17 Task B — deterministic plan-action routes invoke these
    // programmatically (no agent loop) for the sidebar's Add/Swap/
    // Drop/Lock/Move/Confirm verbs.
    proposePlanChangeTool,
    confirmPlanChangeTool,
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
    SystemPromptOptions,
    // D7.1/D7.2 — proactive elicitation detector + append-decision types.
    ElicitationReport,
    ElicitationSignal,
    ElicitationAppendInput,
    ElicitationAppendDecision,
    // Phase 15 Task 8 — section-materialization types surfaced for
    // the apps/web sidebar (forward_materialization_update payload).
    AvailabilityState,
    MaterializationResult,
    MaterializedSemester,
    SchedulingPreferenceCheck,
    // Phase 17 Task D follow-up — `MaterializeArgs` shape used by the
    // /api/plan/stage2 route to call the orchestrator directly.
    MaterializeArgs,
} from "./agent/index.js";

// Phase 17 Task D follow-up — exposed for the /api/plan/stage2 route.
export { materializeSections } from "./agent/index.js";

// Phase 7-E: Degree Progress Report (DPR) module — the canonical
// audit ingestion path. The DPR is a structured rendering of NYU's
// PeopleSoft Academic Advisement Report; ingesting it lets the
// agent answer current-program audit questions deterministically
// without authoring per-program rule files.
export {
    parseDpr,
    degreeProgressReportSchema,
    walkRequirements,
    notSatisfiedRequirements,
    findRequirementById,
    dprToAuditResults,
    dprToPrimaryAuditResult,
    deriveTemporalContext,
    normalizeGraduationTarget,
} from "./dpr/index.js";
export type {
    DegreeProgressReport,
    DPRMeta,
    DPRHeader,
    DPRProgram,
    DPRAdvisorNotation,
    DPRCumulative,
    DPRRequirementGroup,
    DPRRequirement,
    DPRCounter,
    DPRCourseRow,
    DPRStatus,
    ParseDprOptions,
    ParseDprResult,
    ParseDprSuccess,
    ParseDprFailure,
    DprToAuditOptions,
    DprTemporalContext,
} from "./dpr/index.js";


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
    buildCorpus,
    loadPolicyCorpusFromCache,
} from "./rag/index.js";
// Improvement-plan Phase B — section-complete (whole-page) retrieval.
export {
    locateBestSource,
    reassembleSource,
    reassembleSection,
} from "./rag/sectionRetrieval.js";
export type {
    ReassembledUnit,
    LocatedSource,
    LocateOptions,
    LocateDeps,
} from "./rag/sectionRetrieval.js";
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
    runRecoveryMode,
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

// Phase 16 Task A: schedule + chat-history persistence + DPR fingerprint
export {
    InMemoryScheduleStore,
    pruneCompletedPins,
} from "./persistence/scheduleStore.js";
export type { ScheduleStore } from "./persistence/scheduleStore.js";
export { InMemoryChatHistoryStore } from "./persistence/chatHistoryStore.js";
export type {
    ChatHistoryStore,
    ChatMessageRecord,
} from "./persistence/chatHistoryStore.js";
export { computeDprFingerprint } from "./dpr/fingerprint.js";
