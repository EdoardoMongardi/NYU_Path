#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 7-E W8.2 — persona surrogate run (live)
// ============================================================
// Drives the frozen cohort-A 65-case set through the full v2
// pipeline (agent loop + tools + RAG + course catalog) using
// gpt-4.1-mini as the agent and claude-haiku-4-5 as the persona
// (different model families per LLM-as-judge best practice).
//
// Outputs:
//   - tools/cohort-eval/results/cohort_a_surrogate_<datetime>.json
//   - per-case verdicts + composite score + per-dimension means
//   - prints a human-readable summary on stdout
//
// Cost: ~$3-5 in OpenAI + Anthropic tokens. Roughly 65 cases ×
// (1 seed turn + up to 3 follow-ups) × 2 LLM calls per turn
// (agent + persona) ≈ 520 LLM calls.
//
// Usage:
//   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... COHERE_API_KEY=... \
//     npx tsx tools/cohort-eval/runSurrogateW8.ts
// ============================================================

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    OpenAIEngineClient,
    AnthropicEngineClient,
    OpenAIEmbedder,
    CohereReranker,
    LocalLexicalReranker,
    createSemanticCourseSearchFn,
    loadPolicyCorpusFromCache,
    loadPolicyTemplates,
    COHERE_CONFIDENCE_BANDS,
    DEFAULT_PRIMARY_MODEL,
    type LLMClient,
    type CourseSearchFn,
    type Reranker,
} from "../../packages/engine/src/index.js";
import { runPersonaSurrogate } from "../../evals/cohort/personaSurrogate.js";
import { COHORT_A_CASES } from "../../evals/cohorts/cohort_a.js";
import { verifyCohortFrozen } from "../../evals/cohorts/freeze.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
const COHORTS_DIR = join(__dirname, "..", "..", "evals", "cohorts");
const REPO_ROOT = join(__dirname, "..", "..");
const POLICY_CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const POLICY_META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");
const COURSE_DESCRIPTIONS_PATH = join(REPO_ROOT, "data/course-catalog/course_descriptions.json");
const COURSE_EMBEDDINGS_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.jsonl");
const COURSE_META_PATH = join(REPO_ROOT, "data/course-catalog/course_embeddings_openai.meta.json");

function loadInlinePolicyRag(openaiKey: string, cohereKey: string | undefined): {
    store: ReturnType<typeof loadPolicyCorpusFromCache>["store"];
    embedder: OpenAIEmbedder;
    reranker: Reranker;
    templates: ReturnType<typeof loadPolicyTemplates>["templates"];
    confidenceBands?: typeof COHERE_CONFIDENCE_BANDS;
} | null {
    if (!existsSync(POLICY_CACHE_PATH)) return null;
    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    const { store } = loadPolicyCorpusFromCache({
        embedder,
        cachePath: POLICY_CACHE_PATH,
        metaPath: POLICY_META_PATH,
    });
    const reranker: Reranker = cohereKey
        ? new CohereReranker({ apiKey: cohereKey })
        : new LocalLexicalReranker();
    const templates = loadPolicyTemplates().templates;
    return {
        store,
        embedder,
        reranker,
        templates,
        ...(cohereKey ? { confidenceBands: COHERE_CONFIDENCE_BANDS } : {}),
    };
}

function loadInlineCourseSearch(openaiKey: string): CourseSearchFn | null {
    if (!existsSync(COURSE_DESCRIPTIONS_PATH) || !existsSync(COURSE_EMBEDDINGS_PATH)) return null;
    const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
    return createSemanticCourseSearchFn({
        embedder,
        descriptionsPath: COURSE_DESCRIPTIONS_PATH,
        embeddingsPath: COURSE_EMBEDDINGS_PATH,
        embeddingsMetaPath: COURSE_META_PATH,
    });
}

async function main(): Promise<void> {
    const openaiKey = process.env.OPENAI_API_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!openaiKey) { console.error("OPENAI_API_KEY required."); process.exit(1); }
    if (!anthropicKey) { console.error("ANTHROPIC_API_KEY required."); process.exit(1); }

    // Step 1 — refuse to run against an unfrozen cohort.
    const freeze = verifyCohortFrozen("cohort_a", COHORTS_DIR, COHORT_A_CASES);
    if (!freeze.ok) {
        console.error("Cohort A freeze gate FAILED — refusing to score against an unverified case set.");
        console.error(`  reason: ${freeze.reason}`);
        process.exit(1);
    }
    console.error(`✓ Cohort A frozen at ${freeze.meta.frozenAt} — ${freeze.meta.caseCount} cases, ${freeze.meta.sourceHash}`);

    // Step 2 — wire the agent + persona clients.
    const agentClient: LLMClient = new OpenAIEngineClient({
        apiKey: openaiKey,
        modelId: DEFAULT_PRIMARY_MODEL,
    });
    console.error(`Agent client: ${agentClient.id}`);
    const personaClient: LLMClient = new AnthropicEngineClient({
        apiKey: anthropicKey,
        modelId: "claude-haiku-4-5-20251001",
    });
    console.error(`Persona client: ${personaClient.id}`);

    // Step 3 — load production RAG + catalog so tools have real context.
    const cohereKey = process.env.COHERE_API_KEY;
    const ragBundle = loadInlinePolicyRag(openaiKey, cohereKey);
    if (!ragBundle) {
        console.error("WARNING: policy RAG cache missing at data/policy-corpus/. search_policy will not work.");
    } else {
        console.error(`✓ Policy RAG bundle loaded (reranker=${ragBundle.reranker.modelId}, templates=${ragBundle.templates.length}).`);
    }
    const searchCoursesFn = loadInlineCourseSearch(openaiKey);
    if (!searchCoursesFn) {
        console.error("WARNING: course catalog cache missing at data/course-catalog/. search_courses will not work.");
    } else {
        console.error("✓ Course catalog semantic search loaded.");
    }
    const sessionExtras: Record<string, unknown> = {};
    if (ragBundle) sessionExtras.rag = ragBundle;
    if (searchCoursesFn) sessionExtras.searchCoursesFn = searchCoursesFn;

    // Step 4 — run the surrogate.
    console.error(`\nRunning ${COHORT_A_CASES.length} cases × up to 4 turns each...`);
    const startedAt = Date.now();
    const report = await runPersonaSurrogate(COHORT_A_CASES, {
        agentClient,
        personaClient,
        maxFollowUps: 2, // keep cost down; cohort-A cases are mostly single-turn
        sessionExtras: sessionExtras as Parameters<typeof runPersonaSurrogate>[1]["sessionExtras"],
    });
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    // Step 5 — persist + summarize.
    mkdirSync(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = join(RESULTS_DIR, `cohort_a_surrogate_${stamp}.json`);
    const wrapper = {
        _meta: {
            cohort: "cohort_a",
            cohortHash: freeze.meta.sourceHash,
            cohortFrozenAt: freeze.meta.frozenAt,
            agentModel: agentClient.id,
            personaModel: personaClient.id,
            runStartedAt: new Date(startedAt).toISOString(),
            runDurationSec: parseFloat(elapsedSec),
            caseCount: report.cases.length,
            cardinalRule: "§2.1 — every numerical claim traces to a tool result",
            note: "Surrogate composite is an UPPER BOUND on cohort A per §12.6.5 line 4134.",
        },
        ...report,
    };
    writeFileSync(outPath, JSON.stringify(wrapper, null, 2));

    console.error(`\n========== W8 Surrogate Run ==========`);
    console.error(`Composite (cohort): ${report.cohortComposite.toFixed(3)}`);
    console.error(`Per-dimension means:`);
    console.error(`  grounding:       ${report.dimensions.grounding.toFixed(3)}`);
    console.error(`  completeness:    ${report.dimensions.completeness.toFixed(3)}`);
    console.error(`  uncertainty:     ${report.dimensions.uncertainty.toFixed(3)}`);
    console.error(`  nonFabrication:  ${report.dimensions.nonFabrication.toFixed(3)}`);
    console.error(`Cases: ${report.cases.length}, elapsed ${elapsedSec}s`);
    const failing = report.cases.filter((c) => c.composite < 0.85);
    console.error(`Cases below 0.85 composite: ${failing.length}`);
    for (const c of failing.slice(0, 10)) {
        console.error(`  ${c.caseId} → ${c.composite.toFixed(3)} (${c.errors.length} errors)`);
    }
    console.error(`\nFull results: ${outPath}`);

    const passes = report.cohortComposite >= 0.90;
    console.error(`\n§12.6.5 0.90 gate: ${passes ? "PASS (surrogate)" : "FAIL (surrogate)"}`);
    console.error(`Note: surrogate is an upper bound. Real cohort A will score lower.\n`);
}

await main();
