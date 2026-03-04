#!/usr/bin/env npx tsx
// ============================================================
// Test real semantic search with Nomic embeddings
// ============================================================
// Usage: npx tsx scripts/test-search.ts "machine learning"

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "packages", "engine", "src", "data");

import {
    loadEmbeddingIndex,
    searchByEmbedding,
} from "../packages/engine/src/search/semanticSearch.js";

async function main() {
    const query = process.argv[2] || "artificial intelligence and machine learning";
    console.log(`Query: "${query}"\n`);

    // Load index
    const indexData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "course_embeddings.json"), "utf-8"));
    const index = loadEmbeddingIndex(indexData);
    console.log(`Loaded ${index.length} course embeddings.\n`);

    // Embed the query
    console.log("Embedding query with Nomic...");
    const { pipeline } = await import("@huggingface/transformers");
    const embedder = await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5", {
        dtype: "q8",
    });

    const output = await embedder(`search_query: ${query}`, { pooling: "mean", normalize: true });
    const queryEmbedding = Array.from(output.data as Float32Array);
    console.log(`Query embedding: ${queryEmbedding.length} dimensions\n`);

    // Search
    const results = searchByEmbedding(queryEmbedding, index, 15);

    console.log("Top 15 results:");
    console.log("─".repeat(80));
    for (const r of results) {
        console.log(`  ${r.score.toFixed(4)}  ${r.courseId.padEnd(18)} ${r.title}`);
    }
}

main().catch(console.error);
