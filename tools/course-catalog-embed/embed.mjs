#!/usr/bin/env node
// ============================================================
// Course-catalog OpenAI embedder (Phase 7-B Step 3b)
// ============================================================
// Reads data/course-catalog/course_descriptions.json (17,122 courses
// dumped from nyucourses Postgres) and produces
// data/course-catalog/course_embeddings_openai.jsonl (one JSON object
// per line) + a sibling course_embeddings_openai.meta.json file.
//
// Why JSONL: 17,122 × 1536-dim float arrays exceed V8's
// JSON.stringify string-length limit, so we append line-by-line
// instead of buffering the whole array.
//
// Cost: ~17,122 × ~80 tokens × $0.02/1M tokens ≈ $0.03 total.
//
// Usage:
//   OPENAI_API_KEY=sk-... node tools/course-catalog-embed/embed.mjs
//
// Resumable: already-embedded courseCodes (read from the JSONL) are
// skipped on re-run, so re-invocation after a transient API failure
// fills only the missing rows.
// ============================================================

import { readFileSync, writeFileSync, existsSync, appendFileSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

const DESCRIPTIONS_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const EMBEDDINGS_JSONL_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
const EMBEDDINGS_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");
const MODEL = "text-embedding-3-small";
const DIM = 1536;
const BATCH = 100;

function l2Normalize(arr) {
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
    const norm = Math.sqrt(sum);
    if (norm === 0) return arr;
    return arr.map((x) => x / norm);
}

async function readDoneSet(path) {
    if (!existsSync(path)) return new Set();
    const done = new Set();
    const rl = readline.createInterface({
        input: createReadStream(path, { encoding: "utf-8" }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line);
            if (row.courseCode) done.add(row.courseCode);
        } catch {
            // Tolerate a partial trailing line from a previous crash.
        }
    }
    return done;
}

async function writeMeta(rowCount) {
    const sha = createHash("sha256").update(`${MODEL}|${DIM}|${rowCount}`).digest("hex");
    const meta = {
        embedderModelId: `openai:${MODEL}`,
        dimension: DIM,
        embeddedAt: new Date().toISOString(),
        rowCount,
        sourceHash: `sha256:${sha}`,
        format: "jsonl",
    };
    writeFileSync(EMBEDDINGS_META_PATH, JSON.stringify(meta, null, 2));
}

async function main() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        console.error("OPENAI_API_KEY not set. Aborting.");
        process.exit(1);
    }

    const desc = JSON.parse(readFileSync(DESCRIPTIONS_PATH, "utf-8"));
    const courses = desc.courses;
    console.error(`Loaded ${courses.length} courses from ${DESCRIPTIONS_PATH}`);

    const done = await readDoneSet(EMBEDDINGS_JSONL_PATH);
    const todo = courses.filter((c) => !done.has(c.courseCode));
    console.error(`To embed: ${todo.length} courses (${done.size} already done)`);

    if (todo.length === 0) {
        await writeMeta(done.size);
        console.error(`Nothing to do. Meta written to ${EMBEDDINGS_META_PATH}`);
        return;
    }

    const client = new OpenAI({ apiKey });
    let written = done.size;

    for (let i = 0; i < todo.length; i += BATCH) {
        const slice = todo.slice(i, i + BATCH);
        const inputs = slice.map((c) => `${c.title}\n${c.description ?? ""}`);
        try {
            const response = await client.embeddings.create({
                model: MODEL,
                input: inputs,
            });
            // Append line-by-line so we never construct a single
            // string that exceeds V8's max string length.
            const lines = [];
            for (let j = 0; j < slice.length; j++) {
                lines.push(JSON.stringify({
                    courseCode: slice[j].courseCode,
                    embedding: l2Normalize(response.data[j].embedding),
                }));
            }
            appendFileSync(EMBEDDINGS_JSONL_PATH, lines.join("\n") + "\n");
            written += slice.length;
            if ((i / BATCH) % 5 === 0 || i + BATCH >= todo.length) {
                await writeMeta(written);
                console.error(`  checkpoint at ${written} courses`);
            }
        } catch (e) {
            console.error(`  batch starting at ${i} failed: ${e.message ?? e}`);
            await new Promise((r) => setTimeout(r, 2000));
        }
        await new Promise((r) => setTimeout(r, 100));
    }

    await writeMeta(written);
    console.error(`Done. ${written} courses → ${EMBEDDINGS_JSONL_PATH}`);
}

await main();
