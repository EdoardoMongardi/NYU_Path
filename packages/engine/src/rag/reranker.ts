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

// ============================================================
// CohereReranker (Phase 7-B Step 13)
// ============================================================
// Production cross-encoder reranker. Uses Cohere Rerank v3.5 which
// returns a `relevance_score` in [0, 1] per (query, document) pair.
// Score distribution per Cohere guidance:
//   - >= 0.7 → highly relevant (CONFIDENCE_HIGH)
//   - 0.3 .. 0.7 → somewhat relevant (CONFIDENCE_MEDIUM)
//   - < 0.3 → not relevant (CONFIDENCE_LOW)
// These bands map directly to the policySearch.ts thresholds — see
// the re-tuning note there.
//
// The chunk text passed to Cohere combines section heading + body so
// the cross-encoder can read the heading signal (e.g., "Pass/Fail
// Option") that the local lexical reranker boosts via headingFrac.
// ============================================================

interface CohereRerankResultRow {
    index: number;
    /** Cohere v2 SDK uses camelCase; older v1 returns snake_case. We
     *  read whichever is present so test injections + live calls both
     *  work without forcing a normalizer at every call site. */
    relevanceScore?: number;
    relevance_score?: number;
}

export interface CohereRerankerOptions {
    apiKey: string;
    model?: string;
    /** Optional client injection for tests (bypasses network). */
    injectedClient?: {
        rerank(args: {
            model: string;
            query: string;
            documents: string[];
            top_n?: number;
        }): Promise<{
            results: CohereRerankResultRow[];
        }>;
    };
}

export class CohereReranker implements Reranker {
    public readonly modelId: string;
    private readonly apiKey: string;
    private readonly model: string;
    private readonly injectedClient?: CohereRerankerOptions["injectedClient"];

    constructor(opts: CohereRerankerOptions) {
        this.apiKey = opts.apiKey;
        this.model = opts.model ?? "rerank-v3.5";
        this.modelId = `cohere:${this.model}`;
        this.injectedClient = opts.injectedClient;
    }

    async rerank(query: string, hits: VectorSearchHit[]): Promise<RerankedHit[]> {
        if (hits.length === 0) return [];
        const documents = hits.map((h) => {
            const heading = h.chunk.meta.section?.trim();
            const body = h.chunk.text;
            return heading ? `${heading}\n\n${body}` : body;
        });

        const client = this.injectedClient ?? (await this.lazyCohereClient());
        const response = await client.rerank({
            model: this.model,
            query,
            documents,
            top_n: hits.length,
        });

        const out: RerankedHit[] = hits.map((h) => ({ ...h, rerankScore: 0 }));
        for (const r of response.results) {
            const dst = out[r.index];
            if (!dst) continue;
            const raw = r.relevanceScore ?? r.relevance_score;
            if (typeof raw !== "number" || Number.isNaN(raw)) continue;
            dst.rerankScore = Math.max(0, Math.min(1, raw));
        }
        out.sort((a, b) => {
            if (b.rerankScore !== a.rerankScore) return b.rerankScore - a.rerankScore;
            return a.chunk.meta.chunkId.localeCompare(b.chunk.meta.chunkId);
        });
        return out;
    }

    private async lazyCohereClient(): Promise<NonNullable<CohereRerankerOptions["injectedClient"]>> {
        // Lazy import: callers who stay on `LocalLexicalReranker` never
        // pull `cohere-ai` into their bundle.
        const mod = await import("cohere-ai");
        // The Cohere SDK exports `CohereClient` (v7 API) or `CohereClientV2`.
        // We use v2 which is the current canonical export.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SdkClient: any = (mod as any).CohereClientV2 ?? (mod as any).CohereClient;
        if (!SdkClient) {
            throw new Error("[CohereReranker] cohere-ai package missing CohereClientV2 / CohereClient export");
        }
        const client = new SdkClient({ token: this.apiKey });
        return {
            rerank: async (args) => client.rerank(args),
        };
    }
}
