// ============================================================
// Reranker Interface + Local Heuristic (Phase 4 §5.2)
// ============================================================
// Per §5.2: "Cohere Rerank v3.5 is a cross-encoder that scores each
// (query, chunk) pair for actual relevance, not just topical
// similarity." Production wires this to Cohere; tests use the local
// heuristic so the pipeline runs deterministically without network.
//
// The local heuristic (LocalLexicalReranker) blends:
//   - Token-overlap fraction between query and chunk
//   - Section-title match boost
// This is NOT a cross-encoder — it cannot tell apart "P/F for transfer
// students" vs "P/F for CAS majors" when token overlap is identical.
// Production MUST swap it. The interface contract is the same so the
// rest of the pipeline doesn't care.
// ============================================================

import type { VectorSearchHit } from "./vectorStore.js";

export interface Reranker {
    readonly modelId: string;
    rerank(query: string, hits: VectorSearchHit[]): Promise<RerankedHit[]>;
}

export interface RerankedHit extends VectorSearchHit {
    /** Reranker's relevance score in [0, 1] */
    rerankScore: number;
}

export class LocalLexicalReranker implements Reranker {
    public readonly modelId = "local-lexical";

    async rerank(query: string, hits: VectorSearchHit[]): Promise<RerankedHit[]> {
        const queryTokens = new Set(tokenize(query));
        if (queryTokens.size === 0) {
            return hits.map((h) => ({ ...h, rerankScore: 0 }));
        }
        const out: RerankedHit[] = [];
        for (const h of hits) {
            const chunkTokens = new Set(tokenize(h.chunk.text));
            const headingTokens = new Set(tokenize(h.chunk.meta.section));

            // Overlap between query and chunk body, normalized by query size
            let bodyOverlap = 0;
            for (const t of queryTokens) if (chunkTokens.has(t)) bodyOverlap += 1;
            const bodyFrac = bodyOverlap / queryTokens.size;

            // Heading-match boost: if any query token also appears in the
            // section heading, the chunk is more likely to be ON-topic for
            // the question (e.g., "P/F" + "Pass/Fail Option" heading).
            let headingHits = 0;
            for (const t of queryTokens) if (headingTokens.has(t)) headingHits += 1;
            const headingFrac = headingHits / queryTokens.size;

            // Blend: body has primary weight, heading is a meaningful kicker.
            const blended = 0.7 * bodyFrac + 0.3 * headingFrac;
            // Clamp to [0, 1]
            const rerankScore = Math.max(0, Math.min(1, blended));
            out.push({ ...h, rerankScore });
        }
        // Primary sort: rerankScore desc. Secondary: stable tie-break on
        // chunkId so eval runs don't flicker on cosine ties.
        out.sort((a, b) => {
            if (b.rerankScore !== a.rerankScore) return b.rerankScore - a.rerankScore;
            return a.chunk.meta.chunkId.localeCompare(b.chunk.meta.chunkId);
        });
        return out;
    }
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s/-]+/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3);
}
