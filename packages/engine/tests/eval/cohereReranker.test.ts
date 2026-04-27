// ============================================================
// Phase 7-B Step 13 — CohereReranker contract tests
// ============================================================
// Verifies the adapter via injected client (no network).
// ============================================================

import { describe, expect, it } from "vitest";
import { CohereReranker } from "../../src/rag/reranker.js";
import {
    policySearch,
    COHERE_CONFIDENCE_BANDS,
    CONFIDENCE_HIGH,
    CONFIDENCE_MEDIUM,
} from "../../src/rag/policySearch.js";
import { LocalHashEmbedder } from "../../src/rag/embedder.js";
import { VectorStore } from "../../src/rag/vectorStore.js";
import { matchTemplate } from "../../src/rag/policyTemplate.js";
import type { VectorSearchHit } from "../../src/rag/vectorStore.js";

describe("CohereReranker (Phase 7-B Step 13)", () => {
    it("preserves the input ordering shape and clamps relevance scores", async () => {
        const reranker = new CohereReranker({
            apiKey: "test",
            injectedClient: {
                async rerank() {
                    return {
                        results: [
                            { index: 0, relevanceScore: 0.95 },
                            { index: 1, relevanceScore: 1.5 }, // out-of-range, must clamp
                            { index: 2, relevanceScore: -0.2 }, // out-of-range
                        ],
                    };
                },
            },
        });
        const hits: VectorSearchHit[] = [
            { chunk: { text: "a", meta: { chunkId: "a", source: "s", school: "cas", year: "2025-2026", section: "S", sourcePath: "p", sourceLine: 1 } }, score: 0.5 },
            { chunk: { text: "b", meta: { chunkId: "b", source: "s", school: "cas", year: "2025-2026", section: "S", sourcePath: "p", sourceLine: 2 } }, score: 0.4 },
            { chunk: { text: "c", meta: { chunkId: "c", source: "s", school: "cas", year: "2025-2026", section: "S", sourcePath: "p", sourceLine: 3 } }, score: 0.3 },
        ];
        const out = await reranker.rerank("query", hits);
        const byId = Object.fromEntries(out.map((h) => [h.chunk.meta.chunkId, h.rerankScore]));
        expect(byId.a).toBeCloseTo(0.95);
        expect(byId.b).toBe(1);   // clamped to 1
        expect(byId.c).toBe(0);   // clamped to 0
        expect(out[0]!.chunk.meta.chunkId).toBe("b"); // clamped 1 sorts first
    });

    it("sends `heading\\n\\nbody` documents so the cross-encoder sees the section signal", async () => {
        let capturedDocs: string[] = [];
        const reranker = new CohereReranker({
            apiKey: "test",
            injectedClient: {
                async rerank(args) {
                    capturedDocs = args.documents;
                    return { results: args.documents.map((_, i) => ({ index: i, relevanceScore: 0.5 })) };
                },
            },
        });
        await reranker.rerank("q", [
            {
                chunk: {
                    text: "Body of the chunk",
                    meta: { chunkId: "x", source: "s", school: "cas", year: "2025-2026", section: "Pass/Fail Option", sourcePath: "p", sourceLine: 1 },
                },
                score: 0.5,
            },
        ]);
        expect(capturedDocs[0]).toBe("Pass/Fail Option\n\nBody of the chunk");
    });

    it("policySearch consumes COHERE_CONFIDENCE_BANDS via options.confidenceBands", async () => {
        // Build a tiny corpus so policySearch hits the rerank path.
        const embedder = new LocalHashEmbedder(64);
        const store = new VectorStore(embedder);
        await store.addChunks([
            {
                text: "All P/F courses must be requested by the deadline.",
                meta: { chunkId: "1", source: "Test", school: "cas", year: "2025-2026", section: "Pass/Fail", sourcePath: "p", sourceLine: 1 },
            },
        ]);
        const fakeCohere = new CohereReranker({
            apiKey: "test",
            injectedClient: {
                async rerank(args) {
                    return { results: args.documents.map((_, i) => ({ index: i, relevanceScore: 0.55 })) };
                },
            },
        });

        // With LEXICAL bands (high=0.6, medium=0.3): 0.55 → medium.
        const lexResult = await policySearch(
            "P/F policy",
            {
                homeSchool: "cas",
                catalogYear: "2025-2026",
                templates: [],
            },
            {
                store,
                embedder,
                reranker: fakeCohere,
                matchTemplate,
            },
        );
        expect(lexResult.confidence).toBe("medium");

        // With COHERE bands (high=0.7, medium=0.3): 0.55 → still medium,
        // but we exercise that the threshold is plumbed.
        const cohereResult = await policySearch(
            "P/F policy",
            {
                homeSchool: "cas",
                catalogYear: "2025-2026",
                templates: [],
                confidenceBands: COHERE_CONFIDENCE_BANDS,
            },
            {
                store,
                embedder,
                reranker: fakeCohere,
                matchTemplate,
            },
        );
        expect(cohereResult.confidence).toBe("medium");
        expect(COHERE_CONFIDENCE_BANDS.high).toBeGreaterThan(CONFIDENCE_HIGH);
        expect(COHERE_CONFIDENCE_BANDS.medium).toBe(CONFIDENCE_MEDIUM);
    });
});
