// ============================================================
// RAG module barrel exports (Phase 4)
// ============================================================
export { chunkMarkdown } from "./chunker.js";
export type { PolicyChunk, ChunkMeta, ChunkOptions } from "./chunker.js";

export { LocalHashEmbedder, OpenAIEmbedder, cosineSim } from "./embedder.js";
export type { Embedder } from "./embedder.js";

export { VectorStore } from "./vectorStore.js";
export type { VectorSearchHit, IndexedChunk } from "./vectorStore.js";

export { loadPolicyCorpusFromCache } from "./policyCorpusCache.js";
export type {
    PolicyCorpusCacheMeta,
    LoadPolicyCorpusOptions,
    LoadPolicyCorpusResult,
} from "./policyCorpusCache.js";

export { LocalLexicalReranker, CohereReranker } from "./reranker.js";
export type { Reranker, RerankedHit, CohereRerankerOptions } from "./reranker.js";

export {
    computeScope,
    detectExplicitSchools,
} from "./ragScopeFilter.js";
export type { ScopeOptions, ScopeDecision } from "./ragScopeFilter.js";


export {
    policySearch,
    CONFIDENCE_HIGH,
    CONFIDENCE_MEDIUM,
    COHERE_CONFIDENCE_BANDS,
} from "./policySearch.js";
export type {
    PolicySearchResult,
    PolicySearchOptions,
    PolicySearchDeps,
    ConfidenceBand,
    ConfidenceBandThresholds,
} from "./policySearch.js";

export {
    buildCorpus,
} from "./corpus.js";
export type { BuildCorpusOptions, BuildCorpusResult } from "./corpus.js";
