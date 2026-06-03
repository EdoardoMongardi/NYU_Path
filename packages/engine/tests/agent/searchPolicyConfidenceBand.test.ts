// ============================================================
// Phase D — search_policy envelope confidence bands on the NUMERIC score
// ============================================================
// Before Phase D the envelope banded on `result.confidence` (a band
// STRING compared to a number), so the low/medium branches never fired
// and search_policy could only report "high" or "uncertain". Now
// policySearch exposes `topScore` and the envelope bands on it. A fixed
// reranker lets us pin each band deterministically.

import { describe, expect, it } from "vitest";
import { LocalHashEmbedder } from "../../src/rag/embedder.js";
import { VectorStore } from "../../src/rag/vectorStore.js";
import type { Reranker } from "../../src/rag/reranker.js";
import type { PolicyChunk } from "../../src/rag/chunker.js";
import { searchPolicyTool } from "../../src/agent/tools/searchPolicy.js";
import type { ToolSession } from "../../src/agent/tool.js";

function fixedReranker(score: number): Reranker {
    return {
        modelId: `fixed-${score}`,
        rerank: async (_q, hits) => hits.map((h) => ({ ...h, rerankScore: score })),
    };
}

const CHUNK: PolicyChunk = {
    text: "Students may take courses under the pass fail option per the rules below.",
    meta: {
        source: "CAS Academic Policies",
        school: "cas",
        year: "2025-2026",
        section: "Pass/Fail Option",
        chunkId: "cas_pf_001",
        sourcePath: "bulletin/cas/policies.md",
        sourceLine: 1,
        category: "academic_policy",
    },
};

async function sessionWithScore(score: number): Promise<ToolSession> {
    const embedder = new LocalHashEmbedder(64);
    const store = new VectorStore(embedder);
    await store.addChunks([CHUNK]);
    return {
        student: { id: "u1", catalogYear: "2025-2026", homeSchool: "cas", declaredPrograms: [], coursesTaken: [] },
        rag: { store, embedder, reranker: fixedReranker(score), templates: [] },
    };
}

const ctx = { signal: new AbortController().signal } as const;

describe("search_policy — envelope confidence bands on numeric topScore (Phase D)", () => {
    it("weak RAG hit (0.45) → envelope 'low' + low-confidence disclaimer", async () => {
        const out = await searchPolicyTool.call(
            { query: "pass fail option" },
            { ...ctx, session: await sessionWithScore(0.45) },
        );
        expect(out.kind).toBe("rag");
        expect((out as { topScore?: number }).topScore).toBeCloseTo(0.45);
        expect((out as { confidence?: string }).confidence).toBe("low");
        const ids = (out as { disclaimers?: Array<{ id: string }> }).disclaimers?.map((d) => d.id) ?? [];
        expect(ids).toContain("policy_low_confidence_no_fabrication");
    });

    it("moderate RAG hit (0.6) → envelope 'medium'", async () => {
        const out = await searchPolicyTool.call(
            { query: "pass fail option" },
            { ...ctx, session: await sessionWithScore(0.6) },
        );
        expect(out.kind).toBe("rag");
        expect((out as { confidence?: string }).confidence).toBe("medium");
    });

    it("strong RAG hit (0.85) → envelope 'high', no low-confidence disclaimer", async () => {
        const out = await searchPolicyTool.call(
            { query: "pass fail option" },
            { ...ctx, session: await sessionWithScore(0.85) },
        );
        expect(out.kind).toBe("rag");
        expect((out as { confidence?: string }).confidence).toBe("high");
        const ids = (out as { disclaimers?: Array<{ id: string }> }).disclaimers?.map((d) => d.id) ?? [];
        expect(ids).not.toContain("policy_low_confidence_no_fabrication");
    });

    it("below-threshold hit (0.1) → escalate → envelope 'uncertain'", async () => {
        const out = await searchPolicyTool.call(
            { query: "pass fail option" },
            { ...ctx, session: await sessionWithScore(0.1) },
        );
        expect(out.kind).toBe("escalate");
        expect((out as { confidence?: string }).confidence).toBe("uncertain");
    });
});
