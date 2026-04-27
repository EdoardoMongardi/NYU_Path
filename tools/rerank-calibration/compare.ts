#!/usr/bin/env -S npx tsx
// ============================================================
// Rerank A/B calibration (Phase 7-B Step 13 verification)
// ============================================================
// Runs N realistic policy queries through the live OpenAI vector
// search, then reranks the same candidate sets with BOTH
// LocalLexicalReranker and Cohere Rerank v3.5. Dumps a side-by-
// side markdown table so we can see whether Cohere is actually
// pulling more relevant chunks to the top.
//
// Usage:
//   OPENAI_API_KEY=... COHERE_API_KEY=... \
//   npx tsx tools/rerank-calibration/compare.ts
//
// Cost: ~10 queries × ~30 candidate chunks × Cohere Rerank v3.5
//        + 10 OpenAI query embeddings ≈ $0.01.
// ============================================================

import {
    OpenAIEmbedder,
    CohereReranker,
    LocalLexicalReranker,
    loadPolicyCorpusFromCache,
} from "../../packages/engine/src/index.js";
import type { VectorSearchHit, RerankedHit } from "../../packages/engine/src/index.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");

interface CalibrationQuery {
    label: string;
    query: string;
    /** Substring expected to appear in the top-1 chunk's text or section
     *  if the reranker is doing its job. Loose oracle. */
    expectInTop1?: string;
}

const QUERIES: CalibrationQuery[] = [
    { label: "f1-credit-floor", query: "F-1 international student minimum credits per semester", expectInTop1: "12" },
    { label: "cas-pf-deadline", query: "CAS pass/fail option deadline", expectInTop1: "Pass" },
    { label: "cas-withdrawal", query: "withdrawal deadline grade of W", expectInTop1: "withdraw" },
    { label: "credit-overload", query: "how to take more than 18 credits per semester", expectInTop1: "credit" },
    { label: "double-counting", query: "double counting courses between two majors", expectInTop1: "major" },
    { label: "stern-internal-transfer", query: "internal transfer requirements to Stern", expectInTop1: "Stern" },
    { label: "stern-residency", query: "Stern residency credit requirement", expectInTop1: "Stern" },
    { label: "advanced-standing-cap", query: "advanced standing credit cap CAS", expectInTop1: "advanced standing" },
    { label: "minor-basics", query: "CAS minor declaration rules", expectInTop1: "minor" },
    { label: "tandon-residency", query: "Tandon engineering residency requirement", expectInTop1: "Tandon" },
];

const TOP_K_VECTOR = 30;
const TOP_K_DISPLAY = 3;

function clip(s: string, n: number): string {
    const trimmed = s.replace(/\s+/g, " ").trim();
    return trimmed.length > n ? trimmed.slice(0, n) + "…" : trimmed;
}

function summarizeHit(h: RerankedHit | (VectorSearchHit & { rerankScore: number })): string {
    const meta = h.chunk.meta;
    return `${meta.school}/${meta.section ?? "?"} (rerank=${h.rerankScore.toFixed(3)})\n      ${clip(h.chunk.text, 160)}`;
}

async function main() {
    const openaiKey = process.env.OPENAI_API_KEY;
    const cohereKey = process.env.COHERE_API_KEY;
    if (!openaiKey) { console.error("OPENAI_API_KEY required"); process.exit(1); }
    if (!cohereKey) { console.error("COHERE_API_KEY required"); process.exit(1); }

    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    const { store } = loadPolicyCorpusFromCache({ embedder, cachePath: CACHE_PATH, metaPath: META_PATH });
    console.error(`Loaded ${store.size} chunks via ${embedder.modelId}`);

    const lex = new LocalLexicalReranker();
    const cohere = new CohereReranker({ apiKey: cohereKey });

    const lines: string[] = ["# Rerank A/B Calibration", "", `Corpus: ${store.size} chunks. ${QUERIES.length} queries × ${TOP_K_VECTOR}-candidate vector search × top-${TOP_K_DISPLAY} display.`, ""];

    let lexAgreesOnTop1 = 0;
    let cohereAgreesOnTop1 = 0;
    let bothAgreeOnTop1 = 0;
    let totalAdjudicable = 0;

    for (const q of QUERIES) {
        const hits = await store.search(q.query, TOP_K_VECTOR);
        const lexRanked = await lex.rerank(q.query, hits);
        const cohereRanked = await cohere.rerank(q.query, hits);

        lines.push(`## ${q.label} — "${q.query}"`);
        if (q.expectInTop1) lines.push(`Loose oracle: top-1 should mention \`${q.expectInTop1}\``);
        lines.push("");

        const lexTop1 = lexRanked[0]!;
        const cohereTop1 = cohereRanked[0]!;
        const lexHit = q.expectInTop1
            ? `${lexTop1.chunk.text} ${lexTop1.chunk.meta.section ?? ""}`.toLowerCase().includes(q.expectInTop1.toLowerCase())
            : null;
        const cohereHit = q.expectInTop1
            ? `${cohereTop1.chunk.text} ${cohereTop1.chunk.meta.section ?? ""}`.toLowerCase().includes(q.expectInTop1.toLowerCase())
            : null;
        if (q.expectInTop1) {
            totalAdjudicable += 1;
            if (lexHit) lexAgreesOnTop1 += 1;
            if (cohereHit) cohereAgreesOnTop1 += 1;
            if (lexHit && cohereHit) bothAgreeOnTop1 += 1;
            lines.push(`- LocalLexical top-1 oracle: ${lexHit ? "PASS" : "FAIL"} (score ${lexTop1.rerankScore.toFixed(3)})`);
            lines.push(`- Cohere       top-1 oracle: ${cohereHit ? "PASS" : "FAIL"} (score ${cohereTop1.rerankScore.toFixed(3)})`);
            lines.push("");
        }

        lines.push("### LocalLexical top-3");
        for (let i = 0; i < TOP_K_DISPLAY && i < lexRanked.length; i++) {
            lines.push(`${i + 1}. ${summarizeHit(lexRanked[i]!)}`);
        }
        lines.push("");
        lines.push("### Cohere top-3");
        for (let i = 0; i < TOP_K_DISPLAY && i < cohereRanked.length; i++) {
            lines.push(`${i + 1}. ${summarizeHit(cohereRanked[i]!)}`);
        }
        lines.push("");

        const lexSet = new Set(lexRanked.slice(0, TOP_K_DISPLAY).map((h) => h.chunk.meta.chunkId));
        const cohereSet = new Set(cohereRanked.slice(0, TOP_K_DISPLAY).map((h) => h.chunk.meta.chunkId));
        let overlap = 0;
        for (const id of lexSet) if (cohereSet.has(id)) overlap += 1;
        lines.push(`Top-${TOP_K_DISPLAY} overlap: ${overlap} / ${TOP_K_DISPLAY}`);
        lines.push("");
    }

    lines.push("## Summary");
    lines.push("");
    if (totalAdjudicable > 0) {
        lines.push(`- LocalLexical top-1 oracle pass rate: **${lexAgreesOnTop1} / ${totalAdjudicable}** (${(100 * lexAgreesOnTop1 / totalAdjudicable).toFixed(0)}%)`);
        lines.push(`- Cohere       top-1 oracle pass rate: **${cohereAgreesOnTop1} / ${totalAdjudicable}** (${(100 * cohereAgreesOnTop1 / totalAdjudicable).toFixed(0)}%)`);
        lines.push(`- Both passed:  ${bothAgreeOnTop1} / ${totalAdjudicable}`);
    }
    lines.push("");
    lines.push("**Caveat:** the loose-substring oracle is a sanity floor, not a calibration. The real cohort-A composite measurement runs at Step 25.");

    const out = lines.join("\n") + "\n";
    process.stdout.write(out);
}

await main();
