#!/usr/bin/env -S npx tsx
// ============================================================
// Policy-corpus OpenAI embedder (Phase 7-B Step 12)
// ============================================================
// Reads bulletin markdown via the engine's `buildCorpus`, re-embeds
// every chunk with OpenAI text-embedding-3-small, and writes the
// result as JSONL (one `{chunk, embedding}` row per line) plus a
// companion meta JSON.
//
// At runtime the v2 route hydrates the VectorStore from this cache
// (no per-cold-start re-embed) via `loadPolicyCorpusFromCache`.
// Re-run this tool whenever bulletin markdown changes — the meta
// file's `chunkCount` + `sourceHash` makes drift loud.
//
// Usage:
//   OPENAI_API_KEY=sk-... npx tsx tools/policy-corpus-embed/embed.ts
//
// Cost: ~5-10k chunks × ~120 tokens × $0.02/M ≈ $0.02 per run.
// ============================================================

import { writeFileSync, appendFileSync, openSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { buildCorpus } from "../../packages/engine/src/rag/corpus.js";
import type { Embedder } from "../../packages/engine/src/rag/embedder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const OUTPUT_JSONL = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const OUTPUT_META = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");
const MODEL = "text-embedding-3-small";
const DIM = 1536;
const BATCH = 100;

function l2Normalize(arr: number[]): number[] {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i]! * arr[i]!;
    const norm = Math.sqrt(sum);
    if (norm === 0) return arr;
    return arr.map((x) => x / norm);
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("OPENAI_API_KEY not set. Aborting.");
        process.exit(1);
    }

    // Use the engine's buildCorpus for chunking only — we discard the
    // VectorStore and re-embed below in batches with checkpointing.
    // The buildCorpus call still goes through the embedder once on
    // `addChunks`, so we hand it a no-op stub to skip the actual
    // OpenAI call there.
    const stubEmbedder: Embedder = {
        dim: DIM,
        modelId: `openai:${MODEL}`,
        embed: async () => new Float32Array(DIM),
        embedBatch: async (texts) => texts.map(() => new Float32Array(DIM)),
    };
    const { chunks, skipped } = await buildCorpus(stubEmbedder, { warnOnSkip: false });
    console.error(`Chunked ${chunks.length} chunks (${skipped.length} entries skipped)`);

    // Truncate the JSONL — non-resumable in this tool because the
    // chunk set is small enough to redo from scratch (~30 sec total).
    const fd = openSync(OUTPUT_JSONL, "w");
    closeSync(fd);

    const client = new OpenAI({ apiKey });
    let written = 0;
    for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const inputs = slice.map((c) => {
            const heading = c.meta.section?.trim() ?? "";
            return heading ? `${heading}\n\n${c.text}` : c.text;
        });
        const response = await client.embeddings.create({
            model: MODEL,
            input: inputs,
        });
        const lines = [];
        for (let j = 0; j < slice.length; j++) {
            lines.push(JSON.stringify({
                chunk: slice[j],
                embedding: l2Normalize(response.data[j].embedding),
            }));
        }
        appendFileSync(OUTPUT_JSONL, lines.join("\n") + "\n");
        written += slice.length;
        if ((i / BATCH) % 5 === 0 || i + BATCH >= chunks.length) {
            console.error(`  checkpoint ${written} / ${chunks.length}`);
        }
        await new Promise((r) => setTimeout(r, 100));
    }

    const sha = createHash("sha256").update(`${MODEL}|${DIM}|${written}`).digest("hex");
    const meta = {
        embedderModelId: `openai:${MODEL}`,
        dimension: DIM,
        chunkCount: written,
        skippedEntries: skipped.map((s) => s.relPath),
        embeddedAt: new Date().toISOString(),
        sourceHash: `sha256:${sha}`,
        format: "jsonl",
    };
    writeFileSync(OUTPUT_META, JSON.stringify(meta, null, 2));
    console.error(`Done. ${written} chunks → ${OUTPUT_JSONL}`);
}

await main();
