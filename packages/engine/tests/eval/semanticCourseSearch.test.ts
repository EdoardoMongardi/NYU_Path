// ============================================================
// Phase 7-B Step 3c — semantic course search adapter tests
// ============================================================
// Exercises createSemanticCourseSearchFn against a tiny fixture
// using LocalHashEmbedder so the test path stays offline.
// ============================================================

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHashEmbedder } from "../../src/rag/index.js";
import { createSemanticCourseSearchFn } from "../../src/agent/tools/semanticCourseSearch.js";
import type { Embedder } from "../../src/rag/embedder.js";

interface CatalogRow { courseCode: string; title: string; description: string }

function buildFixture(rows: CatalogRow[], embedder: LocalHashEmbedder, dir: string) {
    const descPath = join(dir, "desc.json");
    const embPath = join(dir, "emb.jsonl");
    const metaPath = join(dir, "emb.meta.json");

    writeFileSync(descPath, JSON.stringify({
        _meta: { rowCount: rows.length },
        courses: rows.map((r) => ({
            courseCode: r.courseCode,
            title: r.title,
            description: r.description,
        })),
    }));

    const lines: string[] = [];
    for (const r of rows) {
        const v = embedder.embedSync(`${r.title}\n${r.description}`);
        lines.push(JSON.stringify({
            courseCode: r.courseCode,
            embedding: Array.from(v),
        }));
    }
    writeFileSync(embPath, lines.join("\n") + "\n");

    writeFileSync(metaPath, JSON.stringify({
        embedderModelId: embedder.modelId,
        dimension: embedder.dim,
        rowCount: rows.length,
        format: "jsonl",
    }));

    return { descPath, embPath, metaPath };
}

describe("createSemanticCourseSearchFn (Phase 7-B Step 3c)", () => {
    const embedder = new LocalHashEmbedder(256);
    const fixtureRows: CatalogRow[] = [
        { courseCode: "CSCI-UA 101", title: "Introduction to Computer Science", description: "fundamentals of programming and algorithms" },
        { courseCode: "CSCI-UA 102", title: "Data Structures", description: "trees graphs hashing complexity analysis" },
        { courseCode: "CSCI-UA 480", title: "Machine Learning", description: "supervised learning gradient descent neural networks" },
        { courseCode: "MATH-UA 121", title: "Calculus I", description: "limits derivatives integration single variable" },
        { courseCode: "ECON-UA 1",   title: "Microeconomics",  description: "supply demand market equilibrium consumer behavior" },
    ];

    it("ranks the most semantically similar course first for a topical query", async () => {
        const dir = mkdtempSync(join(tmpdir(), "semsearch-"));
        try {
            const { descPath, embPath, metaPath } = buildFixture(fixtureRows, embedder, dir);
            const fn = createSemanticCourseSearchFn({
                embedder,
                descriptionsPath: descPath,
                embeddingsPath: embPath,
                embeddingsMetaPath: metaPath,
            });
            const matches = await fn("supervised learning gradient descent", { limit: 3 });
            expect(matches.length).toBeGreaterThan(0);
            expect(matches[0]!.courseId).toBe("CSCI-UA 480");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("respects departmentPrefix to filter the candidate pool", async () => {
        const dir = mkdtempSync(join(tmpdir(), "semsearch-"));
        try {
            const { descPath, embPath, metaPath } = buildFixture(fixtureRows, embedder, dir);
            const fn = createSemanticCourseSearchFn({
                embedder,
                descriptionsPath: descPath,
                embeddingsPath: embPath,
                embeddingsMetaPath: metaPath,
            });
            const matches = await fn("integration single variable", {
                departmentPrefix: "MATH-UA",
                limit: 5,
            });
            for (const m of matches) {
                expect(m.courseId.toUpperCase().startsWith("MATH-UA")).toBe(true);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("falls back to keyword scan when the embedder throws", async () => {
        const dir = mkdtempSync(join(tmpdir(), "semsearch-"));
        try {
            const { descPath, embPath, metaPath } = buildFixture(fixtureRows, embedder, dir);
            const flaky: Embedder = {
                dim: embedder.dim,
                modelId: "flaky",
                async embed() { throw new Error("simulated outage"); },
                async embedBatch() { throw new Error("simulated outage"); },
            };
            const fn = createSemanticCourseSearchFn({
                embedder: flaky,
                descriptionsPath: descPath,
                embeddingsPath: embPath,
                embeddingsMetaPath: metaPath,
            });
            const matches = await fn("Microeconomics", { limit: 5 });
            expect(matches.find((m) => m.courseId === "ECON-UA 1")).toBeTruthy();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("throws when embeddings-meta dimension does not match the embedder", async () => {
        const dir = mkdtempSync(join(tmpdir(), "semsearch-"));
        try {
            const { descPath, embPath } = buildFixture(fixtureRows, embedder, dir);
            const wrongMetaPath = join(dir, "wrong.meta.json");
            writeFileSync(wrongMetaPath, JSON.stringify({
                embedderModelId: "openai:text-embedding-3-small",
                dimension: 1536,
                rowCount: fixtureRows.length,
                format: "jsonl",
            }));
            expect(() => createSemanticCourseSearchFn({
                embedder,
                descriptionsPath: descPath,
                embeddingsPath: embPath,
                embeddingsMetaPath: wrongMetaPath,
            })).toThrow(/dim/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reads legacy JSON wrapper format (back-compat)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "semsearch-"));
        try {
            const descPath = join(dir, "desc.json");
            const embPath = join(dir, "emb.json"); // .json (legacy), not .jsonl
            writeFileSync(descPath, JSON.stringify({
                courses: fixtureRows.map((r) => ({
                    courseCode: r.courseCode,
                    title: r.title,
                    description: r.description,
                })),
            }));
            const wrapper = {
                _meta: { embedderModelId: embedder.modelId, dimension: embedder.dim, rowCount: fixtureRows.length },
                embeddings: fixtureRows.map((r) => ({
                    courseCode: r.courseCode,
                    embedding: Array.from(embedder.embedSync(`${r.title}\n${r.description}`)),
                })),
            };
            writeFileSync(embPath, JSON.stringify(wrapper));
            const fn = createSemanticCourseSearchFn({
                embedder,
                descriptionsPath: descPath,
                embeddingsPath: embPath,
            });
            const matches = await fn("trees graphs hashing", { limit: 3 });
            expect(matches[0]!.courseId).toBe("CSCI-UA 102");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
