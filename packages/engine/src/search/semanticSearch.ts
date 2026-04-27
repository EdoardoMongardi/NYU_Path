// ============================================================
// Semantic Search — Cosine similarity search over course embeddings
// ============================================================
//
// @deprecated Phase 6 WS3 (scheduled for removal after WS2 lands).
// Phase 4's RAG pipeline (`packages/engine/src/rag/policySearch.ts`)
// replaces this for policy queries; for course-availability lookups
// the Phase 6 `search_availability` tool is the canonical surface.
// Remaining callers:
//   - `packages/engine/src/chat/chatOrchestrator.ts` (legacy)
//   - `scripts/test-search.ts` (developer utility, not on the user path)
// Do NOT add new callers — use `policySearch` or `search_availability`
// instead.
// ============================================================

/** A single course embedding entry from the pre-computed index */
export interface CourseEmbedding {
    courseId: string;
    title: string;
    description?: string;
    embedding: number[];
}

/** Search result with similarity score */
export interface SemanticSearchResult {
    courseId: string;
    title: string;
    description?: string;
    /** Cosine similarity score, 0 to 1 (1 = identical) */
    score: number;
}

/**
 * Compute cosine similarity between two vectors.
 * Returns value in [-1, 1], where 1 means identical direction.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    }
    if (a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
}

/**
 * Search courses by embedding similarity.
 *
 * @param queryEmbedding - The embedded query vector (e.g. user's interest text)
 * @param index - Pre-computed course embedding index
 * @param topK - Number of top results to return (default: 10)
 * @returns Sorted results, highest similarity first
 */
export function searchByEmbedding(
    queryEmbedding: number[],
    index: CourseEmbedding[],
    topK: number = 10
): SemanticSearchResult[] {
    if (index.length === 0) return [];

    const scored = index.map(entry => ({
        courseId: entry.courseId,
        title: entry.title,
        description: entry.description,
        score: cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, topK);
}

/**
 * Filter search results to only include valid elective candidates.
 *
 * Excludes:
 * - Courses the student has already completed
 * - Courses that are required for the student's program (those are handled by the balanced selector)
 * - Courses the student can't take (missing prerequisites)
 *
 * @param results - Raw search results
 * @param completedCourses - Set of course IDs already taken
 * @param requiredCourses - Set of course IDs that satisfy program rules
 * @param availableCourses - Optional: set of courses with prerequisites met
 */
export function filterForElectives(
    results: SemanticSearchResult[],
    completedCourses: Set<string>,
    requiredCourses: Set<string>,
    availableCourses?: Set<string>
): SemanticSearchResult[] {
    return results.filter(r => {
        // Already taken
        if (completedCourses.has(r.courseId)) return false;
        // Required by program (handled separately by pacing)
        if (requiredCourses.has(r.courseId)) return false;
        // Prerequisites not met
        if (availableCourses && !availableCourses.has(r.courseId)) return false;
        return true;
    });
}

/**
 * Load the embedding index from a JSON file.
 * In production, this is called once and cached.
 */
export function loadEmbeddingIndex(data: unknown): CourseEmbedding[] {
    if (!Array.isArray(data)) {
        throw new Error("Embedding index must be an array");
    }

    return data.map((entry: Record<string, unknown>) => {
        if (!entry.courseId || !entry.embedding || !Array.isArray(entry.embedding)) {
            throw new Error(`Invalid embedding entry: missing courseId or embedding`);
        }
        return {
            courseId: entry.courseId as string,
            title: (entry.title as string) ?? "",
            description: entry.description as string | undefined,
            embedding: entry.embedding as number[],
        };
    });
}

/**
 * Full semantic search pipeline: query → embed → search → filter.
 *
 * Note: In Phase B, the caller must provide the pre-computed query embedding.
 * Phase C will add an LLM layer that generates embeddings from natural language.
 */
export function semanticElectiveSearch(
    queryEmbedding: number[],
    index: CourseEmbedding[],
    completedCourses: Set<string>,
    requiredCourses: Set<string>,
    availableCourses?: Set<string>,
    topK: number = 10
): SemanticSearchResult[] {
    const raw = searchByEmbedding(queryEmbedding, index, topK * 3); // over-fetch for filtering
    const filtered = filterForElectives(raw, completedCourses, requiredCourses, availableCourses);
    return filtered.slice(0, topK);
}
