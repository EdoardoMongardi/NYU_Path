#!/usr/bin/env npx tsx
// ============================================================
// Embedding Generator — Nomic v1.5 via Transformers.js
// ============================================================
// Usage: npx tsx scripts/generate-embeddings.ts
//
// Reads course_catalog_full.json and generates embeddings for
// each course using nomic-embed-text-v1.5 (768 dimensions).
// Saves result as course_embeddings.json.
//
// First run downloads the model (~274MB). Subsequent runs use cache.
// ============================================================

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "packages", "engine", "src", "data");

interface CatalogEntry {
    courseId: string;
    title: string;
    department: string;
    embeddingText: string;
}

interface EmbeddingEntry {
    courseId: string;
    title: string;
    embedding: number[];
}

async function main() {
    // Load catalog
    const catalogPath = path.join(DATA_DIR, "course_catalog_full.json");
    if (!fs.existsSync(catalogPath)) {
        console.error("Error: course_catalog_full.json not found. Run scrape-courses.ts first.");
        process.exit(1);
    }

    const catalog: CatalogEntry[] = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
    console.log(`Loaded ${catalog.length} courses from catalog.\n`);

    // Dynamic import to handle potential loading issues gracefully
    console.log("Loading Transformers.js pipeline...");
    console.log("(First run will download the model — this may take a few minutes)\n");

    const { pipeline } = await import("@huggingface/transformers");

    // Use feature-extraction (embedding) pipeline with Nomic model
    // Fallback: if Nomic is too large, use all-MiniLM-L6-v2 (22MB, 384-dim)
    let embedder;
    try {
        embedder = await pipeline("feature-extraction", "nomic-ai/nomic-embed-text-v1.5", {
            dtype: "q8", // quantized for speed, ~70MB instead of 274MB
        });
        console.log("✓ Loaded nomic-embed-text-v1.5 (quantized)\n");
    } catch (err) {
        console.log(`Nomic model failed: ${err}. Falling back to MiniLM...\n`);
        embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        console.log("✓ Loaded all-MiniLM-L6-v2 (fallback)\n");
    }

    // Generate embeddings in batches
    const BATCH_SIZE = 32;
    const results: EmbeddingEntry[] = [];
    const startTime = Date.now();

    for (let i = 0; i < catalog.length; i += BATCH_SIZE) {
        const batch = catalog.slice(i, i + BATCH_SIZE);
        const texts = batch.map(c =>
            `search_document: ${c.embeddingText}`  // Nomic prefix for document embedding
        );

        try {
            const output = await embedder(texts, { pooling: "mean", normalize: true });

            for (let j = 0; j < batch.length; j++) {
                const embedding = Array.from(output[j].data as Float32Array);
                results.push({
                    courseId: batch[j].courseId,
                    title: batch[j].title,
                    embedding,
                });
            }

            const pct = Math.round(((i + batch.length) / catalog.length) * 100);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            process.stdout.write(`\r  Embedding: ${i + batch.length}/${catalog.length} (${pct}%) — ${elapsed}s`);
        } catch (err) {
            console.error(`\n  ✗ Batch ${i}-${i + batch.length} failed: ${err}`);
        }
    }

    console.log(`\n\n✓ Generated ${results.length} embeddings in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log(`  Dimensions: ${results[0]?.embedding.length ?? "N/A"}`);

    // Save embeddings
    const outPath = path.join(DATA_DIR, "course_embeddings.json");
    fs.writeFileSync(outPath, JSON.stringify(results));
    const sizeMB = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1);
    console.log(`  Saved: ${outPath} (${sizeMB} MB)`);

    // Also save a human-readable version with truncated embeddings
    const preview = results.slice(0, 5).map(r => ({
        ...r,
        embedding: `[${r.embedding.slice(0, 3).map(v => v.toFixed(4)).join(", ")}, ... (${r.embedding.length} dims)]`,
    }));
    console.log("\n  Preview:");
    console.log(JSON.stringify(preview, null, 2));
}

main().catch(console.error);
