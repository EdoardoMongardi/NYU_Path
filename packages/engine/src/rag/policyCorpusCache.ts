// ============================================================
// Policy-corpus disk cache loader (Phase 7-B Step 12)
// ============================================================
// Companion to `tools/policy-corpus-embed/embed.mjs`. Reads the
// pre-embedded JSONL + meta produced by that tool and hydrates a
// VectorStore so the v2 route's cold start doesn't re-embed every
// chunk via OpenAI.
//
// The JSONL streaming reader mirrors the course-catalog cache
// (semanticCourseSearch.ts) — chunk-by-chunk so we never hold a
// 100MB+ string in memory.
// ============================================================

import { existsSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import type { Embedder } from "./embedder.js";
import { VectorStore } from "./vectorStore.js";
import type { PolicyChunk } from "./chunker.js";

export interface PolicyCorpusCacheMeta {
    embedderModelId?: string;
    dimension?: number;
    chunkCount?: number;
    skippedEntries?: string[];
    embeddedAt?: string;
    sourceHash?: string;
    format?: string;
}

export interface LoadPolicyCorpusOptions {
    embedder: Embedder;
    /** Path to JSONL produced by tools/policy-corpus-embed/embed.mjs. */
    cachePath: string;
    /** Optional path to companion meta JSON; defaults to <cachePath>.meta.json. */
    metaPath?: string;
    /** Validate meta.dimension against embedder.dim. Default true. */
    validateMeta?: boolean;
}

export interface LoadPolicyCorpusResult {
    store: VectorStore;
    meta: PolicyCorpusCacheMeta;
}

function readJsonlChunks(path: string): Array<{ chunk: PolicyChunk; embedding: Float32Array }> {
    const fd = openSync(path, "r");
    const out: Array<{ chunk: PolicyChunk; embedding: Float32Array }> = [];
    try {
        const chunk = Buffer.alloc(1 << 16);
        let leftover = "";
        let bytesRead = 0;
        while ((bytesRead = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
            const text = leftover + chunk.subarray(0, bytesRead).toString("utf-8");
            const lines = text.split("\n");
            leftover = lines.pop() ?? "";
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const row = JSON.parse(trimmed) as { chunk: PolicyChunk; embedding: number[] };
                out.push({ chunk: row.chunk, embedding: new Float32Array(row.embedding) });
            }
        }
        if (leftover.trim()) {
            const row = JSON.parse(leftover.trim()) as { chunk: PolicyChunk; embedding: number[] };
            out.push({ chunk: row.chunk, embedding: new Float32Array(row.embedding) });
        }
    } finally {
        closeSync(fd);
    }
    return out;
}

/**
 * Hydrate a VectorStore from a precomputed JSONL cache. Throws if the
 * cache file is missing — callers must check `existsSync(cachePath)`
 * first and fall back to building the corpus from markdown when the
 * cache hasn't been generated yet.
 */
export function loadPolicyCorpusFromCache(opts: LoadPolicyCorpusOptions): LoadPolicyCorpusResult {
    const { embedder, cachePath, validateMeta = true } = opts;
    const metaPath = opts.metaPath ?? cachePath.replace(/\.jsonl$/, ".meta.json");

    let meta: PolicyCorpusCacheMeta = {};
    if (existsSync(metaPath)) {
        meta = JSON.parse(readFileSync(metaPath, "utf-8")) as PolicyCorpusCacheMeta;
    }

    if (validateMeta && meta.dimension !== undefined && meta.dimension !== embedder.dim) {
        throw new Error(
            `[loadPolicyCorpusFromCache] embedder dim (${embedder.dim}) ` +
            `mismatches cache dim (${meta.dimension}). Re-run tools/policy-corpus-embed/embed.mjs.`,
        );
    }

    const store = new VectorStore(embedder);
    const items = readJsonlChunks(cachePath);
    store.addPrecomputed(items);
    return { store, meta };
}
