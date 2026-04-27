// ============================================================
// RAG module barrel exports (Phase 4)
// ============================================================
export { chunkMarkdown } from "./chunker.js";
export type { PolicyChunk, ChunkMeta, ChunkOptions } from "./chunker.js";

export { LocalHashEmbedder, OpenAIEmbedder, cosineSim } from "./embedder.js";
export type { Embedder } from "./embedder.js";

export { VectorStore } from "./vectorStore.js";
export type { VectorSearchHit, IndexedChunk } from "./vectorStore.js";

export { LocalLexicalReranker } from "./reranker.js";
export type { Reranker, RerankedHit } from "./reranker.js";

export {
    computeScope,
    detectExplicitSchools,
} from "./ragScopeFilter.js";
export type { ScopeOptions, ScopeDecision } from "./ragScopeFilter.js";

export {
    matchTemplate,
} from "./policyTemplate.js";
export type {
    PolicyTemplate,
    PolicyTemplateApplicability,
    TemplateMatchResult,
} from "./policyTemplate.js";

export { loadPolicyTemplates } from "./policyTemplateLoader.js";
export type { PolicyTemplateLoadResult } from "./policyTemplateLoader.js";

export {
    policySearch,
    CONFIDENCE_HIGH,
    CONFIDENCE_MEDIUM,
} from "./policySearch.js";
export type {
    PolicySearchResult,
    PolicySearchOptions,
    PolicySearchDeps,
    ConfidenceBand,
} from "./policySearch.js";

export {
    buildCorpus,
    DEFAULT_ENTRIES,
} from "./corpus.js";
export type { BuildCorpusOptions, BuildCorpusResult } from "./corpus.js";
