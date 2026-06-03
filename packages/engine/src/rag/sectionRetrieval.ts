// ============================================================
// Section-complete retrieval (Improvement Plan — Phase B)
// ============================================================
// The default RAG flow (policySearch) returns the top-K *fragments*:
// ~500-token windows ranked by relevance. That is right for "what does
// the P/F deadline say?" but wrong for "what are ALL the requirements
// for the CS major?" — a question a human adviser answers by pulling up
// the WHOLE program page and reading every requirement, not by skimming
// the single best-matching paragraph.
//
// This module adds the missing retrieval mode: given the corpus already
// in the VectorStore, it can
//   1. LOCATE the single best-matching source document for a query
//      (scope-filter → vector top-K → rerank → group by source), and
//   2. REASSEMBLE every chunk of that source (or of one section) back
//      into the original document, in order, with the splitter's
//      inter-chunk overlap removed.
//
// The agent then reasons over the complete page — the way an adviser
// reads the whole requirements block — instead of a lone fragment.
//
// Pure data manipulation over the in-memory store: no network, no LLM.
// The only awaited call is the query embedding inside `locateBestSource`
// (the same embed the regular search already does); reassembly itself
// is synchronous.
// ============================================================

import type { ChunkMeta, PolicyChunk } from "./chunker.js";
import type { Embedder } from "./embedder.js";
import type { Reranker } from "./reranker.js";
import { computeScope, type ScopeOptions } from "./ragScopeFilter.js";
import type { VectorStore } from "./vectorStore.js";

// ------------------------------------------------------------
// Reassembly
// ------------------------------------------------------------

export interface ReassembledUnit {
    /** Source document path — the grouping key. */
    sourcePath: string;
    /** Human-readable document title (e.g. "Computer Science (BA)"). */
    source: string;
    /** Lowercase school id the source belongs to. */
    school: string;
    /** Catalog year tag on the source's chunks. */
    year: string;
    /** Source kind (program / academic_policy / …) when tagged. */
    category?: ChunkMeta["category"];
    /** Distinct section headings, in document order. */
    sections: string[];
    /** How many chunks were stitched back together. */
    chunkCount: number;
    /** The reassembled document: `## heading` + body per section, in
     *  order, with the chunker's inter-piece overlap removed. */
    text: string;
    /** The underlying chunks, in document order. */
    chunks: PolicyChunk[];
}

/** Parse the trailing ordinal from a chunkId like `cs_ba_012` → 12.
 *  chunkIds are minted with a monotonic, zero-padded running index that
 *  increases in document order *within a single source*, so the ordinal
 *  is a reliable document-order key once chunks are grouped by source.
 *  Returns +Infinity when no ordinal is present so malformed ids sort
 *  last rather than colliding at 0. */
function chunkOrdinal(chunkId: string): number {
    const m = chunkId.match(/(\d+)\s*$/);
    return m ? Number.parseInt(m[1]!, 10) : Number.POSITIVE_INFINITY;
}

/** Sort chunks into document order: by source line first (sections
 *  appear in file order), then by chunkId ordinal (orders the pieces
 *  *within* an oversized section that the splitter cut on token
 *  windows). */
function inDocumentOrder(chunks: PolicyChunk[]): PolicyChunk[] {
    return [...chunks].sort((a, b) => {
        if (a.meta.sourceLine !== b.meta.sourceLine) {
            return a.meta.sourceLine - b.meta.sourceLine;
        }
        return chunkOrdinal(a.meta.chunkId) - chunkOrdinal(b.meta.chunkId);
    });
}

const MAX_OVERLAP_TOKENS = 80;

/** Drop a leading overlap from `next` that duplicates the tail of
 *  `prev`. The chunker sub-splits an oversized section into token
 *  windows that overlap by ~`overlapTokens` (default 50); stitching the
 *  pieces back together naively double-prints that seam. We find the
 *  longest token-suffix of `prev` that is also a token-prefix of `next`
 *  (bounded by MAX_OVERLAP_TOKENS) and strip it from `next`. */
function stripLeadingOverlap(prev: string, next: string): string {
    const prevTokens = prev.split(/\s+/).filter((t) => t.length > 0);
    const nextTokens = next.split(/\s+/).filter((t) => t.length > 0);
    const maxK = Math.min(MAX_OVERLAP_TOKENS, prevTokens.length, nextTokens.length);
    for (let k = maxK; k > 0; k--) {
        const prevTail = prevTokens.slice(prevTokens.length - k).join(" ");
        const nextHead = nextTokens.slice(0, k).join(" ");
        if (prevTail === nextHead) {
            return nextTokens.slice(k).join(" ");
        }
    }
    return next;
}

/** Render an ordered chunk list into `## heading` + body sections,
 *  removing the splitter's inter-piece overlap within each section. */
function renderOrderedChunks(ordered: PolicyChunk[]): { text: string; sections: string[] } {
    const blocks: string[] = [];
    const sections: string[] = [];
    let currentSection: string | null = null;
    let lastPieceInSection = "";

    for (const c of ordered) {
        const heading = c.meta.section;
        const body = c.meta.section.trim() === c.text.trim() ? "" : c.text.trim();
        if (heading !== currentSection) {
            // New section: emit the heading, reset overlap tracking.
            currentSection = heading;
            sections.push(heading);
            lastPieceInSection = "";
            blocks.push(body ? `## ${heading}\n${body}` : `## ${heading}`);
            lastPieceInSection = body;
        } else {
            // Continuation of the same section (an oversized split):
            // strip the seam overlap before appending.
            const deduped = lastPieceInSection ? stripLeadingOverlap(lastPieceInSection, body) : body;
            if (deduped.trim().length > 0) blocks.push(deduped);
            lastPieceInSection = body;
        }
    }
    return { text: blocks.join("\n\n"), sections };
}

/** Reassemble every chunk that shares `sourcePath` into one ordered
 *  document. Returns null when no chunk matches that path. */
export function reassembleSource(store: VectorStore, sourcePath: string): ReassembledUnit | null {
    const matching = store.listAll().filter((c) => c.meta.sourcePath === sourcePath);
    if (matching.length === 0) return null;
    const ordered = inDocumentOrder(matching);
    const { text, sections } = renderOrderedChunks(ordered);
    const head = ordered[0]!.meta;
    return {
        sourcePath,
        source: head.source,
        school: head.school,
        year: head.year,
        category: head.category,
        sections,
        chunkCount: ordered.length,
        text,
        chunks: ordered,
    };
}

/** Reassemble every chunk of a single (sourcePath, section) into its
 *  ordered text. Returns null when no chunk matches. */
export function reassembleSection(
    store: VectorStore,
    sourcePath: string,
    section: string,
): ReassembledUnit | null {
    const matching = store
        .listAll()
        .filter((c) => c.meta.sourcePath === sourcePath && c.meta.section === section);
    if (matching.length === 0) return null;
    const ordered = inDocumentOrder(matching);
    const { text, sections } = renderOrderedChunks(ordered);
    const head = ordered[0]!.meta;
    return {
        sourcePath,
        source: head.source,
        school: head.school,
        year: head.year,
        category: head.category,
        sections,
        chunkCount: ordered.length,
        text,
        chunks: ordered,
    };
}

// ------------------------------------------------------------
// Locate
// ------------------------------------------------------------

export interface LocateOptions extends ScopeOptions {
    /** Top-K from vector search before rerank. Default 20. */
    topKVector?: number;
    /** Soft preference: if any reranked candidate carries one of these
     *  categories, restrict the source pick to those candidates. When no
     *  candidate matches, the overall best is used (no hard exclusion).
     *  Lets a curriculum lookup prefer `program` pages over a policy
     *  chunk that merely name-drops the major. */
    preferCategories?: Array<NonNullable<ChunkMeta["category"]>>;
}

export interface LocateDeps {
    store: VectorStore;
    embedder: Embedder;
    reranker: Reranker;
}

export interface LocatedSource {
    sourcePath: string;
    /** Best rerank score among the source's chunks — the locate
     *  confidence signal (same [0,1] scale policySearch gates on). */
    topScore: number;
    /** The reranked chunk that won, for telemetry / source attribution. */
    topChunk: PolicyChunk;
    scopedSchools: string[];
    overrideTriggered: boolean;
    /** Candidate chunks after the scope filter (telemetry). */
    candidateCount: number;
}

/**
 * Locate the single best-matching source document for a query.
 *   scope-filter → vector top-K → rerank → (optional category preference)
 *   → pick the highest-scoring chunk → return its source.
 *
 * Mirrors the first half of `policySearch` but its unit of return is a
 * *source document*, not a fragment — the caller reassembles the whole
 * page via `reassembleSource`.
 */
export async function locateBestSource(
    query: string,
    options: LocateOptions,
    deps: LocateDeps,
): Promise<LocatedSource | null> {
    const scope = computeScope(query, options);
    const topKVector = options.topKVector ?? 20;
    const hits = await deps.store.search(query, topKVector, scope.predicate);
    if (hits.length === 0) return null;

    const reranked = await deps.reranker.rerank(query, hits);
    if (reranked.length === 0) return null;

    // Soft category preference: prefer the requested kinds when present.
    const prefer = options.preferCategories;
    let pool = reranked;
    if (prefer && prefer.length > 0) {
        const preferred = reranked.filter(
            (h) => h.chunk.meta.category && prefer.includes(h.chunk.meta.category),
        );
        if (preferred.length > 0) pool = preferred;
    }

    const best = pool[0]!;
    return {
        sourcePath: best.chunk.meta.sourcePath,
        topScore: best.rerankScore,
        topChunk: best.chunk,
        scopedSchools: scope.scopedSchools,
        overrideTriggered: scope.overrideTriggered,
        candidateCount: hits.length,
    };
}
