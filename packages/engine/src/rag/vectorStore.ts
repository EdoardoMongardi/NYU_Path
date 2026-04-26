// ============================================================
// In-Memory Vector Store (Phase 4 §5.1)
// ============================================================
// Pure-TS vector store for the test path. Production swaps in a real
// vector DB behind the same interface (`addChunks`, `search`).
//
// `search` accepts a pre-filtered candidate set so callers can run the
// scope filter (school/year) BEFORE vector search — this matches the
// architecture's §5 flow: scope first, then vector, then rerank.
// ============================================================

import type { PolicyChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import { cosineSim } from "./embedder.js";

export interface IndexedChunk extends PolicyChunk {
    embedding: Float32Array;
}

export interface VectorSearchHit {
    chunk: PolicyChunk;
    score: number;
}

export class VectorStore {
    private items: IndexedChunk[] = [];
    private readonly embedder: Embedder;

    constructor(embedder: Embedder) {
        this.embedder = embedder;
    }

    get size(): number {
        return this.items.length;
    }

    get embedderModelId(): string {
        return this.embedder.modelId;
    }

    async addChunks(chunks: PolicyChunk[]): Promise<void> {
        const vecs = await this.embedder.embedBatch(chunks.map((c) => c.text));
        for (let i = 0; i < chunks.length; i++) {
            this.items.push({ ...chunks[i]!, embedding: vecs[i]! });
        }
    }

    /**
     * Search for top-K chunks by cosine similarity. If `predicate` is
     * supplied, candidates are filtered first (scope filter applied
     * before vector search per §5 flow).
     */
    async search(
        query: string,
        topK: number,
        predicate?: (chunk: PolicyChunk) => boolean,
    ): Promise<VectorSearchHit[]> {
        const queryVec = await this.embedder.embed(query);
        const candidates = predicate
            ? this.items.filter((c) => predicate(c))
            : this.items;
        const scored: VectorSearchHit[] = candidates.map((c) => ({
            chunk: { text: c.text, meta: c.meta },
            score: cosineSim(queryVec, c.embedding),
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, topK);
    }

    /** Snapshot for tests/diagnostics. */
    listAll(): PolicyChunk[] {
        return this.items.map((c) => ({ text: c.text, meta: c.meta }));
    }
}
