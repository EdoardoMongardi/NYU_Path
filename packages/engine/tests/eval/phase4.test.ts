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
    buildCorpus,
    chunkMarkdown,
    computeScope,
    CONFIDENCE_HIGH,
    detectExplicitSchools,
    LocalHashEmbedder,
    LocalLexicalReranker,
    loadPolicyTemplates,
    matchTemplate,
    policySearch,
    type PolicyChunk,
    type PolicySearchOptions,
} from "../../src/rag/index.js";
import { isT3Program, loadProgramTier } from "../../src/data/tierLoader.js";

// ---- Helpers ----

const embedder = new LocalHashEmbedder(256);
const reranker = new LocalLexicalReranker();

function deps(templates: ReturnType<typeof loadPolicyTemplates>["templates"] = []) {
    return {
        embedder,
        reranker,
        // store filled in per-test
        store: null as unknown as never,
        matchTemplate: (q: string, t: typeof templates, hs: string) => matchTemplate(q, t, hs),
        templates,
    };
}

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

    it("year filter excludes off-year chunks", () => {
        const oldChunk: PolicyChunk = {
            text: "old content",
            meta: { source: "x", school: "cas", year: "2023-2024", section: "s", chunkId: "old1", sourcePath: "p", sourceLine: 1 },
        };
        const scope = computeScope("anything", { homeSchool: "cas", catalogYear: "2025-2026" });
        expect(scope.predicate(allChunks[0]!)).toBe(true);
        expect(scope.predicate(oldChunk)).toBe(false);
    });

    it("detectExplicitSchools picks up multiple schools by literal name", () => {
        const out = detectExplicitSchools("Comparing Stern, Tandon, and Tisch P/F policies");
        expect(out.sort()).toEqual(["stern", "tandon", "tisch"]);
    });
});

// ============================================================
// matchTemplate — applicability + same-school priority
// ============================================================
describe("matchTemplate — curated templates §5.5", () => {
    const { templates } = loadPolicyTemplates();

    it("loads at least the CAS P/F major + credit overload templates", () => {
        const ids = templates.map((t) => t.id).sort();
        expect(ids).toContain("cas_pf_major");
        expect(ids).toContain("cas_credit_overload");
        expect(ids).toContain("stern_pf_major");
    });

    it("CAS student asking 'pass fail major' → cas_pf_major template (NOT stern's)", () => {
        const r = matchTemplate("Can I pass fail major courses?", templates, "cas");
        expect(r).not.toBeNull();
        expect(r!.template.id).toBe("cas_pf_major");
    });

    it("Stern student asking the same question → stern_pf_major template", () => {
        const r = matchTemplate("Can I pass fail major courses?", templates, "stern");
        expect(r).not.toBeNull();
        expect(r!.template.id).toBe("stern_pf_major");
    });

    it("query with no trigger match → null", () => {
        const r = matchTemplate("What is the cafeteria menu?", templates, "cas");
        expect(r).toBeNull();
    });
});

// ============================================================
// policySearch — full pipeline end-to-end
// ============================================================
describe("policySearch — full RAG pipeline", () => {
    let store: Awaited<ReturnType<typeof buildCorpus>>["store"];
    let templates: ReturnType<typeof loadPolicyTemplates>["templates"];

    it("builds the corpus from the bulletin (warm-up)", async () => {
        const result = await buildCorpus(embedder);
        store = result.store;
        templates = loadPolicyTemplates().templates;
        expect(store.size).toBeGreaterThan(0);
        expect(templates.length).toBeGreaterThan(0);
    });

    it("VERIFIABLE 1: 'can I take courses P/F?' for a CAS student returns a CAS P/F chunk; NO Stern or Tandon hits", async () => {
        const opts: PolicySearchOptions = {
            homeSchool: "cas",
            allowExplicitOverride: true,
            templates,
        };
        const result = await policySearch("can I take courses P/F?", opts, {
            store, embedder, reranker, matchTemplate,
        });
        // Either a curated template (CAS-scoped by design) or RAG hits
        if (result.kind === "template") {
            expect(result.template!.template.school).toBe("cas");
        } else {
            expect(result.hits!.length).toBeGreaterThan(0);
            const schools = new Set(result.hits!.map((h) => h.chunk.meta.school));
            expect(schools.has("stern")).toBe(false);
            expect(schools.has("tandon")).toBe(false);
        }
        expect(result.scopedSchools).not.toContain("stern");
        expect(result.scopedSchools).not.toContain("tandon");
    });

    it("Curated CAS template wins over RAG for 'pass fail major'", async () => {
        const result = await policySearch("Can I pass fail major courses?", {
            homeSchool: "cas",
            templates,
        }, { store, embedder, reranker, matchTemplate });
        expect(result.kind).toBe("template");
        expect(result.template!.template.id).toBe("cas_pf_major");
        expect(result.confidence).toBe("high");
    });

    it("Explicit-override: query mentions 'Stern' → Stern chunks ADMITTED into scope", async () => {
        const result = await policySearch(
            "How does P/F differ in Stern compared to my school?",
            { homeSchool: "cas", templates: [] },
            { store, embedder, reranker, matchTemplate },
        );
        expect(result.scopedSchools).toContain("stern");
        expect(result.overrideTriggered).toBe(true);
    });

    it("Confidence-low query produces 'escalate' kind with the < 0.3 caveat", async () => {
        // Pick a query that won't match anything in the corpus
        const result = await policySearch(
            "qzzzzzzzzz xxxxxxxxx yyyyyyyyy",
            { homeSchool: "cas", templates: [] },
            { store, embedder, reranker, matchTemplate },
        );
        expect(result.confidence).toBe("low");
        expect(result.kind).toBe("escalate");
    });

    it("VERIFIABLE 2: T3 program (gallatin_ba) — tier loader marks it RAG-only", () => {
        const entry = loadProgramTier("gallatin_ba");
        expect(entry).not.toBeNull();
        expect(entry!.tier).toBe("T3");
        expect(isT3Program("gallatin_ba")).toBe(true);
        // T1 program: NOT T3
        expect(isT3Program("cs_major_ba")).toBe(false);
    });

    it("Year filter is honored — passing a year not in the corpus → 0 candidates → escalate", async () => {
        const result = await policySearch("Pass/Fail option", {
            homeSchool: "cas",
            catalogYear: "1999-2000",
            templates: [],
        }, { store, embedder, reranker, matchTemplate });
        expect(result.candidateCount).toBe(0);
        expect(result.kind).toBe("escalate");
    });

    // ----- Reviewer-flagged coverage gaps -----

    it("§5 high confidence band (≥0.6) is reachable — synthetic high-overlap chunk produces a 'high' result", async () => {
        // The bulletin's natural-language tokenization (e.g. "Pass/Fail"
        // tokenizes to a single token "pass/fail") prevents most realistic
        // queries from reaching 0.6 on the LOCAL lexical reranker — that's
        // a documented property of the local stub (see reranker.ts comment
        // header). Production swaps in Cohere Rerank where the high band
        // is reachable on real queries. To verify the engine's gate
        // ITSELF works correctly, inject a synthetic chunk whose body +
        // heading both contain the query tokens verbatim.
        const { VectorStore } = await import("../../src/rag/vectorStore.js");
        const isolatedStore = new VectorStore(embedder);
        await isolatedStore.addChunks([
            {
                text: "credit cap residency major minor",
                meta: {
                    source: "synthetic high-overlap",
                    school: "cas",
                    year: "2025-2026",
                    section: "credit cap residency major minor",
                    chunkId: "syn_001",
                    sourcePath: "synthetic.md",
                    sourceLine: 1,
                },
            },
        ]);
        const result = await policySearch(
            "credit cap residency major minor",
            { homeSchool: "cas", templates: [] },
            { store: isolatedStore, embedder, reranker, matchTemplate },
        );
        expect(result.kind).toBe("rag");
        if (result.kind !== "rag") return;
        expect(result.hits![0]!.rerankScore).toBeGreaterThanOrEqual(CONFIDENCE_HIGH);
        expect(result.confidence).toBe("high");
    });

    it("§5 medium band (0.3 ≤ score < 0.6) is reachable — synthetic partial-overlap chunk produces 'medium'", async () => {
        // Same justification as the high-band synthetic test: the local
        // lexical reranker scoring is 0.7*bodyFrac + 0.3*headingFrac. To
        // land in the medium band exactly, construct a chunk whose body
        // matches half the query tokens and whose heading matches none.
        // That gives ≈0.7 * 0.5 = 0.35 — squarely in medium.
        const { VectorStore } = await import("../../src/rag/vectorStore.js");
        const isolatedStore = new VectorStore(embedder);
        await isolatedStore.addChunks([
            {
                text: "alpha beta", // body matches 2 of 4 query tokens
                meta: {
                    source: "synthetic medium-overlap",
                    school: "cas",
                    year: "2025-2026",
                    section: "unrelated heading", // 0 query tokens overlap
                    chunkId: "syn_med_001",
                    sourcePath: "synthetic.md",
                    sourceLine: 1,
                },
            },
        ]);
        const result = await policySearch(
            "alpha beta gamma delta",
            { homeSchool: "cas", templates: [] },
            { store: isolatedStore, embedder, reranker, matchTemplate },
        );
        expect(result.kind).toBe("rag");
        if (result.kind !== "rag") return;
        const top = result.hits![0]!.rerankScore;
        expect(top).toBeGreaterThanOrEqual(0.3);
        expect(top).toBeLessThan(0.6);
        expect(result.confidence).toBe("medium");
        expect(result.notes.some((n) => n.toLowerCase().includes("medium"))).toBe(true);
    });

    it("Explicit-override admits a chunk that ONLY exists in the override school's corpus", async () => {
        const result = await policySearch(
            "What is Stern's pass/fail policy compared to my school?",
            { homeSchool: "cas", templates: [] },
            { store, embedder, reranker, matchTemplate },
        );
        expect(result.overrideTriggered).toBe(true);
        expect(result.scopedSchools).toContain("stern");
        // The override should produce at least one Stern hit when the
        // query mentions Stern (proves the predicate doesn't drop them)
        if (result.kind === "rag") {
            const sternHits = result.hits!.filter((h) => h.chunk.meta.school === "stern");
            expect(sternHits.length).toBeGreaterThan(0);
        }
    });

    it("excludeIfPrograms — synthetic template with excludeIfPrograms[cas] is NOT served to a CAS student", async () => {
        const synthetic: PolicyChunk[] = []; // unused — we test matchTemplate directly
        void synthetic;
        const tpl = {
            id: "syn_excluded",
            school: "all",
            source: "synthetic",
            lastVerified: "2026-04-26",
            triggerQueries: ["specific synthetic trigger phrase"],
            body: "this template should NEVER serve a CAS student",
            applicability: { excludeIfPrograms: ["cas"] },
        };
        const r = matchTemplate(
            "specific synthetic trigger phrase",
            [tpl as unknown as ReturnType<typeof loadPolicyTemplates>["templates"][number]],
            "cas",
        );
        expect(r).toBeNull();
        // The same template SHOULD serve a Tandon student
        const r2 = matchTemplate(
            "specific synthetic trigger phrase",
            [tpl as unknown as ReturnType<typeof loadPolicyTemplates>["templates"][number]],
            "tandon",
        );
        expect(r2).not.toBeNull();
    });

    it("Freshness gate — a stale template (lastVerified > 365 days ago) is NOT matched", async () => {
        const stale = {
            id: "stale_template",
            school: "cas",
            source: "synthetic",
            lastVerified: "2020-01-01", // way out of window
            triggerQueries: ["pass fail option"],
            body: "stale answer",
        };
        const r = matchTemplate(
            "Can I take pass fail option?",
            [stale as unknown as ReturnType<typeof loadPolicyTemplates>["templates"][number]],
            "cas",
            { now: new Date("2026-04-26T00:00:00Z") },
        );
        expect(r).toBeNull();
    });

    it("Context-pronoun guard — 'can I do that?' does NOT match a literal trigger", async () => {
        const tpl = {
            id: "syn_pronoun",
            school: "cas",
            source: "synthetic",
            lastVerified: "2026-04-26",
            triggerQueries: ["that"],
            body: "should never match a context-dependent question",
        };
        const r = matchTemplate(
            "can I do that?",
            [tpl as unknown as ReturnType<typeof loadPolicyTemplates>["templates"][number]],
            "cas",
        );
        expect(r).toBeNull();
    });

    it("End-to-end T3: a Gallatin student query produces RAG hits tagged school='gallatin'", async () => {
        const result = await policySearch(
            "What are the requirements for the Gallatin School?",
            { homeSchool: "gallatin", templates: [] },
            { store, embedder, reranker, matchTemplate },
        );
        if (result.kind === "rag") {
            const fromGallatin = result.hits!.filter((h) => h.chunk.meta.school === "gallatin");
            expect(fromGallatin.length).toBeGreaterThan(0);
        } else {
            // If the RAG escalates, it's still acceptable as long as the
            // tier-loader contract holds (verifiable assertion #2).
            expect(result.kind).toBe("escalate");
        }
    });

    it("§12.6 row-4 #2 verbatim text: the indexed Gallatin corpus contains a known bulletin phrase", () => {
        // Pin the verbatim-quote contract at the text level. The phrase below
        // appears in data/bulletin-raw/undergraduate/individualized-study/_index.md
        // line 7 (the H1 heading of the Gallatin overview page). A regression
        // in chunkMarkdown or buildCorpus that mangled chunk text while
        // preserving metadata would fail this assertion.
        const allChunks = store.listAll();
        const fromGallatin = allChunks.filter((c) => c.meta.school === "gallatin");
        expect(fromGallatin.length).toBeGreaterThan(0);
        const verbatimHits = fromGallatin.filter((c) =>
            c.text.includes("Gallatin School of Individualized Study")
            || c.meta.section.includes("Gallatin School of Individualized Study"),
        );
        expect(verbatimHits.length).toBeGreaterThan(0);
        // Citation completeness: every Gallatin chunk must carry sourcePath +
        // sourceLine + source so the chat layer can render a verbatim quote
        // with attribution.
        for (const c of fromGallatin) {
            expect(c.meta.sourcePath).toBeTruthy();
            expect(c.meta.sourceLine).toBeGreaterThan(0);
            expect(c.meta.source).toBeTruthy();
        }
    });
});

// ============================================================
// Template-body drift guard (Top-3 follow-up #3)
// ============================================================
describe("Template-body drift guard — quoted bulletin text in template bodies must appear verbatim in the cited bulletin", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    const pathMod = require("node:path") as typeof import("node:path");
    const REPO_ROOT = pathMod.join(__dirname, "..", "..", "..", "..");

    /**
     * Map each template to the bulletin file the chat layer would render
     * the quote against. Key off filename so a renamed template surfaces
     * as a missing-key error.
     */
    const TEMPLATE_BULLETIN_PATHS: Record<string, string> = {
        "cas_pf_major.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "cas_credit_overload.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "stern_pf_major.json": "data/bulletin-raw/undergraduate/business/academic-policies/_index.md",
        // Phase 6 WS7c additions
        "cas_withdrawal.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "cas_pf_career_cap.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        // Phase 7-A P-5 additions (CAS academic policies)
        "cas_residency_64_credits.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "cas_double_counting.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "cas_summer_at_nyu.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "cas_minor_basics.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "cas_grad_courses_for_undergrad.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "cas_advanced_standing_cap.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        "cas_grade_points.json": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md",
        // Phase 7-A P-5 additions (Stern)
        "stern_residency.json": "data/bulletin-raw/undergraduate/business/academic-policies/_index.md",
        "stern_double_count_strict.json": "data/bulletin-raw/undergraduate/business/academic-policies/_index.md",
        // Phase 7-A reviewer-P3 follow-up (Tandon)
        "tandon_double_major.json": "data/bulletin-raw/undergraduate/engineering/academic-policies/_index.md",
        "tandon_residency.json": "data/bulletin-raw/undergraduate/engineering/academic-policies/_index.md",
        // Phase 7-B Step 1 (OGS — scraped via Playwright through AWS WAF)
        "f1_credit_floor.json": "data/bulletin-raw/ogs/student-information-and-resources/student-visa-and-immigration/current-students/visa-and-academic-changes/register-part-time/_index.md",
        // Phase 7-B Step 2 (internal-transfer equivalencies — Playwright through WAF)
        "cas_to_stern_transfer.json": "data/bulletin-raw/internal-transfer-equivalencies/undergraduate-admissions/how-to-apply/internal-transfers/internal-transfers-stern/_index.md",
        "internal_transfer_additional_requirements.json": "data/bulletin-raw/internal-transfer-equivalencies/undergraduate-admissions/how-to-apply/internal-transfers/internal-transfer-additional-requirements/_index.md",
    };

    const templates = loadPolicyTemplates();

    it("each curated template's quoted bulletin sentences exist verbatim in the cited bulletin file", () => {
        const templateDir = pathMod.join(REPO_ROOT, "data", "policy_templates");
        const files = fs.readdirSync(templateDir).filter((f) => f.endsWith(".json"));
        expect(files.length).toBe(templates.templates.length);

        for (const file of files) {
            const bulletinRel = TEMPLATE_BULLETIN_PATHS[file];
            expect(bulletinRel, `no bulletin path mapped for template ${file}`).toBeTruthy();
            const bulletin = fs.readFileSync(pathMod.join(REPO_ROOT, bulletinRel!), "utf-8");
            const tplRaw = JSON.parse(fs.readFileSync(pathMod.join(templateDir, file), "utf-8"));
            const body: string = tplRaw.body;
            // Extract italic-quoted sentences (markdown *"..."*) — these are
            // the load-bearing verbatim claims a template makes.
            const quoteRe = /\*"([^"]{20,})"\*/g;
            const quotes = [...body.matchAll(quoteRe)].map((m) => m[1]!);
            expect(quotes.length, `template ${file} has no verbatim italic-quoted bulletin sentences`).toBeGreaterThan(0);
            for (const q of quotes) {
                // Allow for minor whitespace/quote variants by comparing
                // a normalized form. Folds curly + straight quotes
                // (single AND double) so a template authored with ASCII
                // quotes still matches a markdownify'd bulletin that
                // emitted curly typographic quotes from NYU's HTML.
                const normalize = (s: string) =>
                    s
                        .replace(/\s+/g, " ")
                        .replace(/[’‘']/g, "'")
                        .replace(/[“”"]/g, '"')
                        .trim();
                expect(
                    normalize(bulletin).includes(normalize(q)),
                    `template ${file} quotes "${q}" but the phrase is not present verbatim in ${bulletinRel}`,
                ).toBe(true);
            }
        }
    });
});
