#!/usr/bin/env -S npx tsx
// Retrieval-only probe: for a set of queries, show EXACTLY what
// search_policy surfaces (top reranked hits + the FULL SECTION), so we
// can tell whether the authoritative section was retrieved/ranked
// (retrieval ok → any error is LLM-side) or buried (retrieval issue).

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAIEmbedder } from "../packages/engine/src/rag/embedder.js";
import { loadPolicyCorpusFromCache } from "../packages/engine/src/rag/policyCorpusCache.js";
import { CohereReranker, LocalLexicalReranker, type Reranker } from "../packages/engine/src/rag/reranker.js";
import { policySearch } from "../packages/engine/src/rag/policySearch.js";
import { reassembleSection } from "../packages/engine/src/rag/sectionRetrieval.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const META = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");

const QUERIES = [
    "How many courses can be double counted between a major and a minor in CAS?",
    "What is the credit threshold by which I must declare my major in CAS?",
    "Can a course count toward both my Economics major and a Mathematics minor?",
];

async function main() {
    const embedder = new OpenAIEmbedder({ apiKey: process.env.OPENAI_API_KEY! });
    const { store } = loadPolicyCorpusFromCache({ embedder, cachePath: CACHE, metaPath: META });
    const cohereKey = process.env.COHERE_API_KEY;
    const reranker: Reranker = cohereKey ? new CohereReranker({ apiKey: cohereKey }) : new LocalLexicalReranker();
    console.log(`corpus: ${store.size} chunks · reranker: ${reranker.modelId}\n`);

    for (const query of QUERIES) {
        console.log("================================================================");
        console.log("QUERY:", query);
        const result = await policySearch(
            query,
            { homeSchool: "cas", catalogYear: "2025-2026", allowExplicitOverride: true },
            { store, embedder, reranker },
        );
        console.log(`kind=${result.kind} confidence=${result.confidence} topScore=${result.topScore?.toFixed(3)} candidates=${result.candidateCount}`);
        console.log("TOP RERANKED HITS (source · section · score):");
        for (const h of (result.hits ?? []).slice(0, 5)) {
            console.log(`  [${h.rerankScore.toFixed(3)}] ${h.chunk.meta.school} · ${h.chunk.meta.sourcePath} · §"${h.chunk.meta.section}"`);
        }
        const top = result.hits?.[0];
        if (top) {
            const ws = reassembleSection(store, top.chunk.meta.sourcePath, top.chunk.meta.section);
            console.log(`\nFULL SECTION surfaced (the agent reads this): ${ws?.source} · §"${top.chunk.meta.section}"`);
            console.log("  " + (ws?.text ?? top.chunk.text).replace(/\s+/g, " ").slice(0, 700) + "…");
        }
        // Did the authoritative CAS academic-policies page appear anywhere in the candidate hits?
        const authHit = (result.hits ?? []).find((h) => h.chunk.meta.sourcePath.includes("arts-science/academic-policies"));
        console.log(`\nAuthoritative CAS academic-policies chunk in top hits? ${authHit ? `YES (score ${authHit.rerankScore.toFixed(3)}, §"${authHit.chunk.meta.section}")` : "NO"}`);
        console.log();
    }
}

await main();
