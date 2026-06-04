// ============================================================
// Phase 4 — RAG Pipeline tests
// ============================================================
// Verifiable per ARCHITECTURE.md §12.6 row 4:
//   1. `search_policy("can I take courses P/F?")` returns relevant CAS
//      P/F chunks, NOT Stern or Tandon
//   2. T3-program query returns verbatim bulletin quote with citation
//
// Plus deeper checks against §5 flow:
//   - Default-hard scope filter (homeSchool + "all" only when no override)
//   - Explicit-override admits a non-home school when its name appears
//     literally in the query
//   - Confidence gating (high / medium / low) per the §5 thresholds
//   - Curated template fast-path (§5.5) wins over RAG
//   - Stern P/F template excluded for non-Stern students; CAS template
//     applied when a CAS student asks
// ============================================================

import { describe, expect, it } from "vitest";
import {
    chunkMarkdown,
    computeScope,
    detectExplicitSchools,
    LocalHashEmbedder,
    LocalLexicalReranker,
    type PolicyChunk,
} from "../../src/rag/index.js";

// ---- Helpers ----

const embedder = new LocalHashEmbedder(256);
const reranker = new LocalLexicalReranker();

// ============================================================
// chunker — basic shape + heading split + oversize split
// ============================================================
describe("chunker — markdown chunking", () => {
    it("splits on headings and tags each chunk with the section title", () => {
        const md = `# A
para a1
para a2

## B
para b1

## C
para c1
`;
        const chunks = chunkMarkdown(md, {
            source: "test",
            school: "cas",
            year: "2025-2026",
            sourcePath: "test.md",
        });
        const sections = chunks.map((c) => c.meta.section).sort();
        expect(sections).toEqual(["A", "B", "C"]);
    });

    it("oversize sections are split with overlap", () => {
        const long = "word ".repeat(1200).trim();
        const md = `# Big\n${long}`;
        const chunks = chunkMarkdown(md, {
            source: "test",
            school: "cas",
            year: "2025-2026",
            sourcePath: "test.md",
        }, { maxTokens: 500, overlapTokens: 50 });
        expect(chunks.length).toBeGreaterThan(1);
        // Each chunk ≤ ~500 tokens
        for (const c of chunks) {
            expect(c.text.split(/\s+/).length).toBeLessThanOrEqual(500);
        }
    });

    it("assigns stable, sequential chunkIds per source", () => {
        const md = `# A\nfoo\n## B\nbar`;
        const chunks = chunkMarkdown(md, {
            source: "Test Doc",
            school: "cas",
            year: "2025-2026",
            sourcePath: "test.md",
        });
        const ids = chunks.map((c) => c.meta.chunkId);
        expect(ids).toEqual(["test_doc_001", "test_doc_002"]);
    });
});

// ============================================================
// embedder — determinism + reasonable cosine
// ============================================================
describe("LocalHashEmbedder — deterministic, sane cosine", () => {
    it("same input → same vector (across calls)", async () => {
        const a = await embedder.embed("Pass/Fail option for major courses");
        const b = await embedder.embed("Pass/Fail option for major courses");
        for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i] ?? 0, 6);
    });

    it("topically related texts have higher cosine than unrelated ones", async () => {
        const { cosineSim } = await import("../../src/rag/embedder.js");
        const q = await embedder.embed("Pass/Fail option for major courses");
        const close = await embedder.embed("No course in the major may be taken Pass/Fail");
        const far = await embedder.embed("Tandon residency requirement bachelor of science");
        expect(cosineSim(q, close)).toBeGreaterThan(cosineSim(q, far));
    });
});

// ============================================================
// ragScopeFilter — default-hard, explicit override
// ============================================================
describe("ragScopeFilter", () => {
    const allChunks: PolicyChunk[] = [
        { text: "cas content", meta: { source: "x", school: "cas", year: "2025-2026", section: "s", chunkId: "c1", sourcePath: "p", sourceLine: 1 } },
        { text: "stern content", meta: { source: "x", school: "stern", year: "2025-2026", section: "s", chunkId: "c2", sourcePath: "p", sourceLine: 1 } },
        { text: "tandon content", meta: { source: "x", school: "tandon", year: "2025-2026", section: "s", chunkId: "c3", sourcePath: "p", sourceLine: 1 } },
        { text: "all content", meta: { source: "x", school: "all", year: "2025-2026", section: "s", chunkId: "c4", sourcePath: "p", sourceLine: 1 } },
    ];

    it("default-hard: only homeSchool + 'all' admitted when query mentions no other school", () => {
        const scope = computeScope("Can I take courses P/F?", { homeSchool: "cas" });
        const passed = allChunks.filter(scope.predicate).map((c) => c.meta.school).sort();
        expect(passed).toEqual(["all", "cas"]);
        expect(scope.overrideTriggered).toBe(false);
    });

    it("explicit override: query mentions 'Stern' → Stern chunks admitted alongside CAS", () => {
        const scope = computeScope(
            "How does P/F differ between CAS and Stern?",
            { homeSchool: "cas" },
        );
        const passed = allChunks.filter(scope.predicate).map((c) => c.meta.school).sort();
        expect(passed).toEqual(["all", "cas", "stern"]);
        expect(scope.overrideTriggered).toBe(true);
        expect(scope.overrideMatchedSchools).toContain("stern");
    });

    it("override is opt-out: allowExplicitOverride=false suppresses cross-school admission", () => {
        const scope = computeScope(
            "How does P/F differ between CAS and Stern?",
            { homeSchool: "cas", allowExplicitOverride: false },
        );
        const passed = allChunks.filter(scope.predicate).map((c) => c.meta.school).sort();
        expect(passed).toEqual(["all", "cas"]);
        expect(scope.overrideTriggered).toBe(false);
    });

    it("year is no longer a hard filter (Phase 9 — was silently dropping all bulletin chunks tagged 2025-2026 for students on 2024-2025)", () => {
        const oldChunk: PolicyChunk = {
            text: "old content",
            meta: { source: "x", school: "cas", year: "2023-2024", section: "s", chunkId: "old1", sourcePath: "p", sourceLine: 1 },
        };
        // Both should now pass for a CAS student regardless of catalogYear.
        // Year-based deprioritization, if needed, belongs at the reranker
        // layer — not as a hard predicate that produces 0 candidates.
        const scope = computeScope("anything", { homeSchool: "cas", catalogYear: "2025-2026" });
        expect(scope.predicate(allChunks[0]!)).toBe(true);
        expect(scope.predicate(oldChunk)).toBe(true);
    });

    it("detectExplicitSchools picks up multiple schools by literal name", () => {
        const out = detectExplicitSchools("Comparing Stern, Tandon, and Tisch P/F policies");
        expect(out.sort()).toEqual(["stern", "tandon", "tisch"]);
    });
});

// NOTE: the matchTemplate, policySearch-pipeline, and template-body-drift
// blocks were removed when curated templates were deleted (pure-RAG pass).
// Pure-RAG policySearch behavior is covered by searchPolicyConfidenceBand,
// searchPolicyWholeSection, sectionRetrieval, and the search_policy tool tests.
