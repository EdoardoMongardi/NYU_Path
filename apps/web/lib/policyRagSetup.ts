// ============================================================
// Policy RAG wiring (Phase 7-B Steps 12-13)
// ============================================================
// Lazy-loaded singleton that constructs `session.rag` for the v2
// route. Loads:
//   - VectorStore hydrated from data/policy-corpus/policy_chunks.jsonl
//     (run tools/policy-corpus-embed/embed.ts to generate)
//   - OpenAIEmbedder (for query-time embedding only — chunk vectors
//     are precomputed)
//   - CohereReranker
//   - Curated policy templates corpus
//
// Returns null when any dependency is missing (cache file, OpenAI
// key, or Cohere key) so the v2 route can degrade gracefully —
// search_policy then surfaces "RAG corpus not loaded" via its
// existing validateInput check.
// ============================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    OpenAIEmbedder,
    CohereReranker,
    LocalLexicalReranker,
    loadPolicyCorpusFromCache,
    loadPolicyTemplates,
    COHERE_CONFIDENCE_BANDS,
    type Reranker,
    type ToolSession,
} from "@nyupath/engine";

const REPO_ROOT = process.cwd().includes("apps/web")
    ? join(process.cwd(), "..", "..")
    : process.cwd();

const POLICY_CACHE_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.jsonl");
const POLICY_META_PATH = join(REPO_ROOT, "data/policy-corpus/policy_chunks.meta.json");

let cached: ToolSession["rag"] | null = null;
let cachedFailureReason: string | null = null;

export function getPolicyRagBundle(): ToolSession["rag"] | null {
    if (cached) return cached;
    if (cachedFailureReason) return null;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
        cachedFailureReason = "OPENAI_API_KEY not set";
        return null;
    }
    if (!existsSync(POLICY_CACHE_PATH)) {
        cachedFailureReason = `policy corpus cache missing at ${POLICY_CACHE_PATH} — run tools/policy-corpus-embed/embed.ts`;
        // eslint-disable-next-line no-console
        console.warn(`[policyRagSetup] ${cachedFailureReason}`);
        return null;
    }

    try {
        const embedder = new OpenAIEmbedder({ apiKey: openaiKey });
        const { store } = loadPolicyCorpusFromCache({
            embedder,
            cachePath: POLICY_CACHE_PATH,
            metaPath: POLICY_META_PATH,
        });

        // Cohere is preferred but optional. Fall back to the local
        // lexical reranker so the rest of the pipeline still works
        // while the operator is provisioning the Cohere key.
        const cohereKey = process.env.COHERE_API_KEY;
        const reranker: Reranker = cohereKey
            ? new CohereReranker({ apiKey: cohereKey })
            : new LocalLexicalReranker();
        if (!cohereKey) {
            // eslint-disable-next-line no-console
            console.warn("[policyRagSetup] COHERE_API_KEY not set — falling back to LocalLexicalReranker");
        }

        const templates = loadPolicyTemplates().templates;

        cached = {
            store,
            embedder,
            reranker,
            templates,
            // Cohere v3.5 distribution differs from the lexical reranker;
            // use the calibrated bands when Cohere is active, otherwise
            // let policySearch fall back to its lexical defaults.
            ...(cohereKey ? { confidenceBands: COHERE_CONFIDENCE_BANDS } : {}),
        };
        return cached;
    } catch (err) {
        cachedFailureReason = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[policyRagSetup] failed to construct: ${cachedFailureReason}`);
        return null;
    }
}
