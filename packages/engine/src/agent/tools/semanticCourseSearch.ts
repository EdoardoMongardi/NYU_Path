// ============================================================
// Semantic course search adapter (Phase 7-B Step 3c)
// ============================================================
// Builds a `CourseSearchFn` (the injection shape consumed by
// `searchCourses.ts`) backed by OpenAI text-embedding-3-small
// vectors over the full 17,122-course catalog dumped from
// nyucourses Postgres.
//
// At first invocation it loads two artifacts:
//   - course_descriptions.json (14 MB)
//   - course_embeddings_openai.jsonl (~523 MB) via streaming reader
// Loading is deferred to the first search call so the chat route
// pays no cost when the agent never invokes search_courses.
//
// At query time it embeds the query through the supplied `Embedder`,
// computes cosine similarity against every course vector, and returns
// the top-K matches as `CatalogCourse[]`. A keyword fallback kicks in
// when the embedder throws.
// ============================================================

import { existsSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import type { Embedder } from "../../rag/embedder.js";
import type { CourseSearchFn } from "./searchCourses.js";

interface CourseDescriptionsFile {
    _meta?: Record<string, unknown>;
    courses: Array<{
        courseCode: string;
        title: string;
        description?: string | null;
        catalogData?: Record<string, unknown> | null;
    }>;
}

interface CourseEmbeddingsMeta {
    embedderModelId?: string;
    dimension?: number;
    rowCount?: number;
    format?: string;
}

export interface SemanticCourseSearchOptions {
    embedder: Embedder;
    descriptionsPath: string;
    /**
     * Path to a JSONL file (one `{courseCode, embedding}` row per line)
     * OR a legacy JSON wrapper file with `{ _meta, embeddings: [...] }`.
     * The reader autodetects via `.jsonl` extension.
     */
    embeddingsPath: string;
    /** Optional path to a companion meta JSON file (used with JSONL). */
    embeddingsMetaPath?: string;
    /**
     * Cap the per-query candidate sweep when the catalog is much
     * larger than the user-requested limit. Defaults to 200 — well
     * above any limit the agent will request and small enough to
     * keep the cosine-similarity pass cheap.
     */
    candidatePool?: number;
    /**
     * Validate the embeddings-meta file's `dimension` against the
     * embedder's `dim` at construction time (cheap — only opens the
     * sidecar meta JSON, never the full embeddings file). Disable
     * to defer all validation to the first search call.
     */
    validateMetaEager?: boolean;
}

export interface CourseCatalogEntry {
    courseId: string;
    title: string;
    description?: string;
    credits?: number;
    prereqs?: string[];
    embedding?: Float32Array;
}

function readJsonlEmbeddings(path: string): Map<string, Float32Array> {
    // Stream the JSONL one chunk at a time so we never hold the
    // entire file as a single V8 string (the production embeddings
    // file is ~523 MB, well past V8's 0x1fffffe8 char limit).
    const fd = openSync(path, "r");
    const out = new Map<string, Float32Array>();
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
                const row = JSON.parse(trimmed) as { courseCode: string; embedding: number[] };
                out.set(row.courseCode, new Float32Array(row.embedding));
            }
        }
        if (leftover.trim()) {
            const row = JSON.parse(leftover.trim()) as { courseCode: string; embedding: number[] };
            out.set(row.courseCode, new Float32Array(row.embedding));
        }
    } finally {
        closeSync(fd);
    }
    return out;
}

/**
 * Construct a `CourseSearchFn` backed by OpenAI semantic vectors.
 * Memory cost on full load: 17,122 × 1536 floats × 4 bytes ≈ 105 MB,
 * which fits comfortably in a Vercel Node lambda's 1 GB allotment.
 */
export function createSemanticCourseSearchFn(opts: SemanticCourseSearchOptions): CourseSearchFn {
    const {
        embedder,
        descriptionsPath,
        embeddingsPath,
        embeddingsMetaPath,
        candidatePool = 200,
        validateMetaEager = true,
    } = opts;

    const isJsonl = embeddingsPath.endsWith(".jsonl");
    const metaPath = isJsonl
        ? (embeddingsMetaPath ?? embeddingsPath.replace(/\.jsonl$/, ".meta.json"))
        : null;

    if (validateMetaEager && metaPath && existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as CourseEmbeddingsMeta;
        if (meta.dimension !== undefined && meta.dimension !== embedder.dim) {
            throw new Error(
                `[semanticCourseSearch] embedder dim (${embedder.dim}) ` +
                `mismatches embeddings file dim (${meta.dimension}). ` +
                `Re-embed the catalog with the same model the search-time embedder uses.`,
            );
        }
    }

    let catalog: CourseCatalogEntry[] | null = null;

    function ensureCatalog(): CourseCatalogEntry[] {
        if (catalog) return catalog;

        const descPayload = JSON.parse(readFileSync(descriptionsPath, "utf-8")) as CourseDescriptionsFile;

        let embeddingByCode: Map<string, Float32Array>;
        let meta: CourseEmbeddingsMeta = {};
        if (isJsonl) {
            if (metaPath && existsSync(metaPath)) {
                meta = JSON.parse(readFileSync(metaPath, "utf-8")) as CourseEmbeddingsMeta;
            }
            embeddingByCode = readJsonlEmbeddings(embeddingsPath);
        } else {
            const embPayload = JSON.parse(readFileSync(embeddingsPath, "utf-8")) as {
                _meta?: CourseEmbeddingsMeta;
                embeddings: Array<{ courseCode: string; embedding: number[] }>;
            };
            meta = embPayload._meta ?? {};
            embeddingByCode = new Map();
            for (const row of embPayload.embeddings) {
                embeddingByCode.set(row.courseCode, new Float32Array(row.embedding));
            }
        }

        if (meta.dimension !== undefined && meta.dimension !== embedder.dim) {
            throw new Error(
                `[semanticCourseSearch] embedder dim (${embedder.dim}) ` +
                `mismatches embeddings file dim (${meta.dimension}). ` +
                `Re-embed the catalog with the same model the search-time embedder uses.`,
            );
        }

        catalog = descPayload.courses.map((c) => ({
            courseId: c.courseCode,
            title: c.title,
            description: c.description ?? undefined,
            embedding: embeddingByCode.get(c.courseCode),
        }));
        return catalog;
    }

    function cosineDot(a: Float32Array, b: Float32Array): number {
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
        return dot;
    }

    function keywordScan(
        cat: CourseCatalogEntry[],
        query: string,
        deptPrefix: string | undefined,
        limit: number,
    ): CourseCatalogEntry[] {
        const q = query.toLowerCase();
        const dept = deptPrefix?.toUpperCase();
        const out: CourseCatalogEntry[] = [];
        for (const c of cat) {
            if (out.length >= limit) break;
            if (dept && !c.courseId.toUpperCase().startsWith(dept)) continue;
            const haystack = `${c.courseId} ${c.title} ${c.description ?? ""}`.toLowerCase();
            if (haystack.includes(q)) out.push(c);
        }
        return out;
    }

    const searchFn: CourseSearchFn = async (query, queryOpts) => {
        const limit = queryOpts?.limit ?? 20;
        const deptPrefix = queryOpts?.departmentPrefix;
        const cat = ensureCatalog();

        let queryVec: Float32Array | null = null;
        try {
            queryVec = await embedder.embed(query);
        } catch (err) {
            queryVec = null;
            // eslint-disable-next-line no-console
            console.warn(`[semanticCourseSearch] embedder.embed failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        if (!queryVec) {
            const matches = keywordScan(cat, query, deptPrefix, limit);
            return matches.map(({ embedding: _e, ...c }) => c);
        }

        const dept = deptPrefix?.toUpperCase();
        const scored: Array<{ entry: CourseCatalogEntry; score: number }> = [];
        for (const c of cat) {
            if (!c.embedding) continue;
            if (dept && !c.courseId.toUpperCase().startsWith(dept)) continue;
            const score = cosineDot(queryVec, c.embedding);
            scored.push({ entry: c, score });
        }
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, Math.min(limit, candidatePool));
        return top.map(({ entry }) => {
            const { embedding: _e, ...rest } = entry;
            return rest;
        });
    };

    return searchFn;
}
