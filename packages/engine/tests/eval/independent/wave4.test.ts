// =============================================================================
// Wave 4 — Independent (bulletin-only) test harness for Phase 4 RAG modules.
//
// IMPORTANT: The assertions in this file come from BULLETIN reading + the
// engine's exported function SIGNATURES only (no engine source bodies were
// read except where noted in wave4_fixtures.md). Each `expect(...)` is paired
// with a comment citing the bulletin/signature line that drives the
// prediction.
//
// A failing expectation is a candidate engine bug (or "engine encoding
// diverges from bulletin"). Wave 4 deliberately leaves failing assertions
// as failures and documents them in wave4_run_report.md rather than
// loosening the assertion to make tests green.
// =============================================================================

import { describe, it, expect, beforeAll } from "vitest";
import {
    buildCorpus,
    LocalHashEmbedder,
    LocalLexicalReranker,
    matchTemplate,
    computeScope,
    policySearch,
    loadPolicyTemplates,
    type PolicySearchDeps,
    type PolicySearchOptions,
    type PolicySearchResult,
} from "../../../src/rag/index.js";
import { isT3Program, loadProgramTier } from "../../../src/data/tierLoader.js";

// ---- shared fixtures --------------------------------------------------------
//
// Build the corpus + deps once. Each scenario reuses them so the run is fast
// and deterministic. The LocalHashEmbedder + LocalLexicalReranker are the
// engine's TEST-PATH defaults (see embedder.ts / reranker.ts top-of-file
// comments). They are deterministic and offline, which is exactly what the
// independent eval needs.

interface SharedFixtures {
    deps: PolicySearchDeps;
    templates: ReturnType<typeof loadPolicyTemplates>["templates"];
    skipped: Awaited<ReturnType<typeof buildCorpus>>["skipped"];
    store: Awaited<ReturnType<typeof buildCorpus>>["store"];
}

let SHARED: SharedFixtures;

beforeAll(async () => {
    const embedder = new LocalHashEmbedder();
    const corpus = await buildCorpus(embedder);
    const reranker = new LocalLexicalReranker();
    const templatesResult = loadPolicyTemplates();
    SHARED = {
        deps: {
            store: corpus.store,
            embedder,
            reranker,
            matchTemplate,
        },
        templates: templatesResult.templates,
        skipped: corpus.skipped,
        store: corpus.store,
    };
});

function baseOptions(homeSchool: string): PolicySearchOptions {
    return {
        homeSchool,
        catalogYear: "2025-2026",
        allowExplicitOverride: true,
        topKVector: 20,
        topKRerank: 5,
        templates: SHARED.templates,
    };
}

// =============================================================================
// Scenario 1 — CAS junior asking about P/F for Stern's microeconomics
// =============================================================================

describe("Wave 4 — Scenario 1: CAS junior, P/F for Stern microeconomics", () => {
    const query = "Can I take Stern's microeconomics requirement P/F?";

    it("matchTemplate returns null (no curated trigger fires for this phrasing)", () => {
        // Citation: cas_pf_major.json triggerQueries are "p/f major" / "pass fail major" / etc.
        // None appear (case-insensitive) in the query lowercased.
        const m = matchTemplate(query, SHARED.templates, "cas");
        expect(m).toBeNull();
    });

    it("scope filter triggers explicit override on 'Stern' and admits cas+all+stern", () => {
        // Citation: ragScopeFilter.ts SCHOOL_NAME_PATTERNS includes /\bstern\b/i.
        const scope = computeScope(query, { homeSchool: "cas", allowExplicitOverride: true });
        expect(scope.overrideTriggered).toBe(true);
        expect(scope.overrideMatchedSchools).toContain("stern");
        expect(scope.scopedSchools).toEqual(expect.arrayContaining(["cas", "all", "stern"]));
    });

    it("policySearch falls through to RAG and returns Stern + CAS chunks", async () => {
        const result: PolicySearchResult = await policySearch(query, baseOptions("cas"), SHARED.deps);

        // Citation: matchTemplate returns null → kind cannot be "template".
        expect(result.kind).not.toBe("template");

        // Citation: scope filter contract.
        expect(result.overrideTriggered).toBe(true);
        expect(result.scopedSchools).toEqual(expect.arrayContaining(["cas", "all", "stern"]));

        // Citation: both CAS line 408-414 and Stern line 390-432 have substantive
        // P/F content; both should be in scope.
        expect(result.candidateCount).toBeGreaterThan(0);

        // The reranked top-K should include at least one Stern-tagged chunk —
        // proving that the override actually pulled Stern content into the
        // ranked output, not just into the candidate set.
        const sternHits = (result.hits ?? []).filter((h) => h.chunk.meta.school === "stern");
        expect(sternHits.length).toBeGreaterThan(0);
    });
});

// =============================================================================
// Scenario 2 — Tandon student asking about credit overload
// =============================================================================

describe("Wave 4 — Scenario 2: Tandon overload (>18 credits)", () => {
    const query = "can I take more than 18 credits?";

    it("matchTemplate returns null for Tandon home school (CAS overload template is filtered out)", () => {
        // Citation: matchTemplate signature — templates with school !== home && school !== "all" are skipped.
        // cas_credit_overload.json has school === "cas", so for homeSchool === "tandon" it should NOT match.
        const m = matchTemplate(query, SHARED.templates, "tandon");
        expect(m).toBeNull();
    });

    it("scope filter does NOT trigger override (no school name in query)", () => {
        const scope = computeScope(query, { homeSchool: "tandon", allowExplicitOverride: true });
        expect(scope.overrideTriggered).toBe(false);
        expect(scope.scopedSchools).toEqual(expect.arrayContaining(["tandon", "all"]));
        // Should NOT contain other school names.
        expect(scope.scopedSchools).not.toContain("cas");
        expect(scope.scopedSchools).not.toContain("stern");
    });

    it("policySearch returns RAG result with confidence at least 'medium'", async () => {
        const result = await policySearch(query, baseOptions("tandon"), SHARED.deps);

        // Citation: Tandon bulletin lines 326 + 357 explicitly contain "18 credits".
        expect(result.kind).toBe("rag");
        expect(result.candidateCount).toBeGreaterThan(0);
        // Bulletin-derived prediction: not "low" because the literal "18 credits" appears in
        // multiple Tandon chunks (high lexical-rerank overlap).
        expect(result.confidence).not.toBe("low");
    });
});

// =============================================================================
// Scenario 3 — F-1 visa full-time question
// =============================================================================

describe("Wave 4 — Scenario 3: F-1 visa full-time", () => {
    const query = "what counts as full-time for F-1 status?";

    it("scope filter admits 'all' chunks (NYU-wide content)", () => {
        // Citation: ragScopeFilter.ts comment lines 10-12 — homeSchool + "all" are
        // ALWAYS in scope, regardless of the query content.
        const scope = computeScope(query, { homeSchool: "cas", allowExplicitOverride: true });
        expect(scope.scopedSchools).toContain("all");
        expect(scope.scopedSchools).toContain("cas");
    });

    it("policySearch result is bounded — no high-confidence RAG match for unindexed F-1 vocabulary", async () => {
        const result = await policySearch(query, baseOptions("cas"), SHARED.deps);

        // Citation: corpus.ts DEFAULT_ENTRIES — no F-1-specific bulletin file is enumerated.
        // The literal "F-1" / "visa" tokens have no source in any indexed chunk, so a
        // truly relevant high-confidence match is not bulletin-supportable.
        if (result.kind === "rag") {
            // At MINIMUM, do not allow "high" confidence on a query whose distinctive
            // tokens (F-1, visa) are absent from the indexed corpus. Bulletin-derived
            // expectation: medium or low.
            expect(result.confidence).not.toBe("high");
        }

        // The scope filter should still have produced candidates — the corpus has
        // generic "full-time" content from CAS + the 'all'-tagged internal-transfer
        // file. Empty candidates would mean the scope filter dropped everything,
        // which contradicts the §5 default-hard rule.
        expect(result.candidateCount).toBeGreaterThan(0);

        // At least one selected hit should have school === "cas" or "all" — i.e.,
        // scope filter admitted the right school tags.
        const allowedSchools = new Set(["cas", "all"]);
        for (const h of result.hits ?? []) {
            expect(allowedSchools.has(h.chunk.meta.school)).toBe(true);
        }
    });
});

// =============================================================================
// Scenario 4 — Cross-school P/F comparison
// =============================================================================

describe("Wave 4 — Scenario 4: Cross-school P/F comparison", () => {
    const query = "How does P/F differ between CAS and Stern?";

    it("scope filter triggers override for both CAS and Stern", () => {
        const scope = computeScope(query, { homeSchool: "cas", allowExplicitOverride: true });
        expect(scope.overrideTriggered).toBe(true);
        // Citation: SCHOOL_NAME_PATTERNS — both /\bcas\b/i and /\bstern\b/i match.
        expect(scope.overrideMatchedSchools).toEqual(expect.arrayContaining(["stern"]));
        expect(scope.scopedSchools).toEqual(expect.arrayContaining(["cas", "all", "stern"]));
    });

    it("policySearch top-K hits include at least one CAS chunk and one Stern chunk", async () => {
        const result = await policySearch(query, baseOptions("cas"), SHARED.deps);

        expect(result.overrideTriggered).toBe(true);
        expect(result.scopedSchools).toEqual(expect.arrayContaining(["cas", "all", "stern"]));
        expect(result.candidateCount).toBeGreaterThanOrEqual(2);

        const hits = result.hits ?? [];
        const hasCas = hits.some((h) => h.chunk.meta.school === "cas");
        const hasStern = hits.some((h) => h.chunk.meta.school === "stern");
        expect(hasCas).toBe(true);
        expect(hasStern).toBe(true);
    });
});

// =============================================================================
// Scenario 5 — Gallatin BA program tier and RAG retrieval
// =============================================================================

describe("Wave 4 — Scenario 5: Gallatin BA T3 retrieval", () => {
    it("isT3Program('gallatin_ba') returns true", () => {
        // Citation: data/_tiers.json — gallatin_ba is tier T3.
        expect(isT3Program("gallatin_ba")).toBe(true);
    });

    it("loadProgramTier('gallatin_ba').tier === 'T3'", () => {
        const entry = loadProgramTier("gallatin_ba");
        expect(entry).not.toBeNull();
        expect(entry?.tier).toBe("T3");
    });

    it("Gallatin chunks are present in the indexed corpus (post-fix: labels reflect actual bulletin location at undergraduate/individualized-study/)", async () => {
        // Bulletin-derived prediction: bulletin files exist on disk at
        // data/bulletin-raw/undergraduate/individualized-study/_index.md and
        // .../individualized-study/academic-policies/_index.md. After the corpus
        // path fix, both should produce chunks tagged school: "gallatin".
        const allChunks = SHARED.store.listAll();
        const gallatinChunks = allChunks.filter((c) => c.meta.school === "gallatin");
        expect(gallatinChunks.length).toBeGreaterThan(0);
    });

    it("buildCorpus does NOT skip the Gallatin entry", async () => {
        // Bulletin-derived prediction: bulletin file exists on disk; therefore the
        // corpus builder should NOT skip it. The engine's hard-coded path is wrong,
        // so the entry IS skipped — leave the assertion strict so the regression
        // surfaces.
        const skipped = SHARED.skipped;
        const skippedGallatin = skipped.filter((e) => e.school === "all" && e.relPath.includes("gallatin"));
        expect(skippedGallatin).toEqual([]);
    });

    it("policySearch for a Gallatin query returns chunks tagged school='gallatin'", async () => {
        const result = await policySearch(
            "What are the requirements for the Gallatin BA?",
            baseOptions("gallatin"),
            SHARED.deps,
        );
        // After the corpus path fix, the home="gallatin" + "all" scope contains
        // chunks tagged school: "gallatin" sourced from the actual on-disk path.
        const fromGallatin = (result.hits ?? []).filter((h) => h.chunk.meta.school === "gallatin");
        expect(fromGallatin.length).toBeGreaterThan(0);
    });
});

// =============================================================================
// Scenario 6 — Confidence-gate boundary (medium-band probe)
// =============================================================================

describe("Wave 4 — Scenario 6: confidence-gate medium band", () => {
    const query = "audit a CAS class for credit";

    it("policySearch returns a RAG result whose top score is bulletin-supportable", async () => {
        const result = await policySearch(query, baseOptions("cas"), SHARED.deps);

        // Citation: CAS bulletin "Auditing" section (lines 446-452) — partial overlap.
        // Bulletin-derived prediction is medium (0.3 <= rerankScore < 0.6). Verify
        // strictly: if the actual score lands outside, this assertion fails and the
        // run report documents the actual value (per the wave-4 brief).
        expect(result.kind).toBe("rag");
        expect(result.confidence).toBe("medium");
        // The medium-band caveat must appear in result.notes (per policySearch.ts
        // signature comment lines 145-147).
        const hasCaveat = result.notes.some((n) => n.toLowerCase().includes("medium"));
        expect(hasCaveat).toBe(true);
    });
});
