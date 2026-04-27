// ============================================================
// policySearch — RAG entry point (Phase 4 §5)
// ============================================================
// Runs the full §5 flow:
//   1. Scope filter (school/year hard-filter + explicit override)
//   2. Vector search (top-K candidates)
//   3. Rerank (cross-encoder relevance)
//   4. Confidence gate
//      - >= 0.6: cite directly
//      - 0.3 to <0.6: cite with caveat
//      - < 0.3: escalate ("I can't answer this confidently; consult adviser")
//
// Also surfaces the curated policy templates (§5.5): if a template
// trigger matches the query AND the template's applicability rules
// permit the student's home school, the template is returned BEFORE
// any vector search. Templates are checked first to keep frequently
// asked answers stable.
// ============================================================

import type { PolicyChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import type { Reranker, RerankedHit } from "./reranker.js";
import { computeScope, type ScopeOptions } from "./ragScopeFilter.js";
import type { VectorStore } from "./vectorStore.js";
import type { PolicyTemplate, TemplateMatchResult } from "./policyTemplate.js";

export type ConfidenceBand = "high" | "medium" | "low";

/** §5 confidence gating thresholds — calibrated for LocalLexicalReranker.
 *  CohereReranker uses different bands (see COHERE_CONFIDENCE_BANDS).
 *  Production overrides via `PolicySearchOptions.confidenceBands`. */
export const CONFIDENCE_HIGH = 0.6;
export const CONFIDENCE_MEDIUM = 0.3;

/** Phase 7-B Step 13 — Cohere Rerank v3.5 distribution.
 *  Cohere docs guidance: >=0.7 highly relevant, 0.3-0.7 somewhat
 *  relevant, <0.3 not relevant. Re-tuning candidate after we measure
 *  on the cohort A composite — Step 25 sets the final calibrated
 *  numbers; these are the published-default starting point. */
export const COHERE_CONFIDENCE_BANDS = {
    high: 0.7,
    medium: 0.3,
} as const;

export interface ConfidenceBandThresholds {
    high: number;
    medium: number;
}

export interface PolicySearchResult {
    /** "template" — direct curated answer; no vector search ran */
    /** "rag" — vector + rerank produced a result above the medium threshold */
    /** "escalate" — top reranked hit was below medium threshold */
    kind: "template" | "rag" | "escalate";
    /** When kind === "template" */
    template?: TemplateMatchResult;
    /** When kind === "rag" or kind === "escalate" — top reranked hits */
    hits?: RerankedHit[];
    /** Confidence band derived from the top hit's rerankScore */
    confidence: ConfidenceBand;
    /** Telemetry: which schools were in scope */
    scopedSchools: string[];
    /** Telemetry: did the query trigger an explicit-school override? */
    overrideTriggered: boolean;
    /** Number of candidate chunks AFTER the scope filter */
    candidateCount: number;
    /** Free-form notes the chat layer should surface */
    notes: string[];
}

export interface PolicySearchOptions extends ScopeOptions {
    /** Top-K from vector search (before rerank). Default 20. */
    topKVector?: number;
    /** How many post-rerank hits to keep. Default 5. */
    topKRerank?: number;
    /** Curated templates checked BEFORE vector search */
    templates?: PolicyTemplate[];
    /** Confidence band thresholds. Defaults to the lexical-reranker bands.
     *  Set to `COHERE_CONFIDENCE_BANDS` (or a re-tuned variant) when the
     *  reranker is `CohereReranker`. */
    confidenceBands?: ConfidenceBandThresholds;
}

export interface PolicySearchDeps {
    store: VectorStore;
    embedder: Embedder;
    reranker: Reranker;
    matchTemplate: (
        query: string,
        templates: PolicyTemplate[],
        homeSchool: string,
    ) => TemplateMatchResult | null;
}

/**
 * Run the full RAG search.
 */
export async function policySearch(
    query: string,
    options: PolicySearchOptions,
    deps: PolicySearchDeps,
): Promise<PolicySearchResult> {
    const notes: string[] = [];

    // 1. Curated template fast-path. We compute the scope first so the
    // returned `scopedSchools` is honest (the architecture's §5.5 flow
    // happens INSIDE the broader §5 box, not before it).
    const scopeForTemplate = computeScope(query, options);
    const templates = options.templates ?? [];
    if (templates.length > 0) {
        const tm = deps.matchTemplate(query, templates, options.homeSchool);
        if (tm) {
            return {
                kind: "template",
                template: tm,
                confidence: "high",
                scopedSchools: scopeForTemplate.scopedSchools,
                overrideTriggered: scopeForTemplate.overrideTriggered,
                candidateCount: 0,
                notes: [
                    `Curated policy template matched: "${tm.template.id}" (${tm.template.school}).`,
                ],
            };
        }
    }

    // 2. Scope filter (already computed above; reuse it)
    const scope = scopeForTemplate;
    if (scope.overrideTriggered) {
        notes.push(
            `Query mentions ${scope.overrideMatchedSchools.join(", ")} — cross-school override applied.`,
        );
    }

    // 3. Vector search (top-K)
    const topKVector = options.topKVector ?? 20;
    const topKRerank = options.topKRerank ?? 5;
    const hits = await deps.store.search(query, topKVector, scope.predicate);

    if (hits.length === 0) {
        return {
            kind: "escalate",
            hits: [],
            confidence: "low",
            scopedSchools: scope.scopedSchools,
            overrideTriggered: scope.overrideTriggered,
            candidateCount: 0,
            notes: [
                ...notes,
                `No chunks in scope (${scope.scopedSchools.join(", ")}). Cannot answer from indexed policy corpus.`,
            ],
        };
    }

    // 4. Rerank
    const reranked = await deps.reranker.rerank(query, hits);
    const top = reranked.slice(0, topKRerank);
    const topScore = top[0]?.rerankScore ?? 0;

    // 5. Confidence gate
    const bands = options.confidenceBands ?? { high: CONFIDENCE_HIGH, medium: CONFIDENCE_MEDIUM };
    let confidence: ConfidenceBand;
    let kind: "rag" | "escalate";
    if (topScore >= bands.high) {
        confidence = "high";
        kind = "rag";
    } else if (topScore >= bands.medium) {
        confidence = "medium";
        kind = "rag";
        notes.push(
            `Confidence is medium (${topScore.toFixed(2)}). Surface the cited policy text but caveat that the match may be partial.`,
        );
    } else {
        confidence = "low";
        kind = "escalate";
        notes.push(
            `Confidence is low (${topScore.toFixed(2)}). Do NOT synthesize an answer; recommend the student contact their adviser.`,
        );
    }

    return {
        kind,
        hits: top,
        confidence,
        scopedSchools: scope.scopedSchools,
        overrideTriggered: scope.overrideTriggered,
        candidateCount: hits.length,
        notes,
    };
}

export type { PolicyChunk } from "./chunker.js";
