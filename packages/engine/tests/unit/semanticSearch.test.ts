// ============================================================
// Unit Tests — Semantic Search
// ============================================================
import { describe, it, expect } from "vitest";
import {
    cosineSimilarity,
    searchByEmbedding,
    filterForElectives,
    loadEmbeddingIndex,
    semanticElectiveSearch,
    type CourseEmbedding,
} from "../../src/search/semanticSearch.js";

// Helper: create a simple embedding (unit vector in one direction)
function basisVector(dim: number, index: number): number[] {
    const v = new Array(dim).fill(0);
    v[index] = 1;
    return v;
}

// Helper: create a mock course embedding
function mockCourseEmbed(
    courseId: string,
    title: string,
    embedding: number[]
): CourseEmbedding {
    return { courseId, title, embedding };
}

// ============================================================
// Cosine Similarity
// ============================================================
describe("Semantic Search: cosineSimilarity", () => {
    it("identical vectors → 1.0", () => {
        const v = [0.5, 0.3, 0.8, 0.1];
        expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it("orthogonal vectors → 0.0", () => {
        const a = basisVector(4, 0); // [1, 0, 0, 0]
        const b = basisVector(4, 1); // [0, 1, 0, 0]
        expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
    });

    it("opposite vectors → -1.0", () => {
        const a = [1, 0, 0];
        const b = [-1, 0, 0];
        expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    it("zero vector → 0.0", () => {
        const a = [1, 2, 3];
        const b = [0, 0, 0];
        expect(cosineSimilarity(a, b)).toBe(0);
    });

    it("dimension mismatch → throws", () => {
        expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow("dimension mismatch");
    });

    it("empty vectors → 0.0", () => {
        expect(cosineSimilarity([], [])).toBe(0);
    });

    it("similar vectors have high score", () => {
        const a = [0.9, 0.1, 0.0];
        const b = [0.8, 0.2, 0.0]; // close to a
        const c = [0.0, 0.0, 1.0]; // orthogonal
        expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
    });
});

// ============================================================
// searchByEmbedding
// ============================================================
describe("Semantic Search: searchByEmbedding", () => {
    const index: CourseEmbedding[] = [
        mockCourseEmbed("ML-101", "Machine Learning", [0.9, 0.1, 0.0]),
        mockCourseEmbed("ART-101", "Art History", [0.0, 0.1, 0.9]),
        mockCourseEmbed("AI-201", "Artificial Intelligence", [0.8, 0.2, 0.0]),
        mockCourseEmbed("MUSIC-101", "Music Theory", [0.0, 0.0, 0.8]),
    ];

    it("returns results sorted by similarity (highest first)", () => {
        const query = [0.9, 0.1, 0.0]; // very similar to ML-101
        const results = searchByEmbedding(query, index);
        expect(results[0].courseId).toBe("ML-101");
        expect(results[1].courseId).toBe("AI-201");
    });

    it("respects topK limit", () => {
        const query = [0.5, 0.5, 0.5];
        const results = searchByEmbedding(query, index, 2);
        expect(results).toHaveLength(2);
    });

    it("empty index → empty results", () => {
        const results = searchByEmbedding([1, 0, 0], []);
        expect(results).toHaveLength(0);
    });

    it("all results have scores", () => {
        const results = searchByEmbedding([0.5, 0.5, 0.0], index);
        for (const r of results) {
            expect(typeof r.score).toBe("number");
            expect(r.score).toBeGreaterThanOrEqual(-1);
            expect(r.score).toBeLessThanOrEqual(1);
        }
    });
});

// ============================================================
// filterForElectives
// ============================================================
describe("Semantic Search: filterForElectives", () => {
    const results = [
        { courseId: "ML-101", title: "Machine Learning", score: 0.95 },
        { courseId: "CALC-101", title: "Calculus I", score: 0.80 },
        { courseId: "ART-101", title: "Art History", score: 0.70 },
        { courseId: "CS-201", title: "Data Structures", score: 0.60 },
    ];

    it("excludes completed courses", () => {
        const completed = new Set(["ML-101"]);
        const filtered = filterForElectives(results, completed, new Set());
        expect(filtered.find(r => r.courseId === "ML-101")).toBeUndefined();
        expect(filtered).toHaveLength(3);
    });

    it("excludes required courses", () => {
        const required = new Set(["CALC-101", "CS-201"]);
        const filtered = filterForElectives(results, new Set(), required);
        expect(filtered).toHaveLength(2);
        expect(filtered.map(r => r.courseId)).toEqual(["ML-101", "ART-101"]);
    });

    it("excludes courses with unmet prerequisites", () => {
        const available = new Set(["ML-101", "ART-101"]); // only these are unlocked
        const filtered = filterForElectives(results, new Set(), new Set(), available);
        expect(filtered).toHaveLength(2);
    });

    it("combined filters", () => {
        const completed = new Set(["ML-101"]);
        const required = new Set(["CS-201"]);
        const available = new Set(["ML-101", "CALC-101", "ART-101", "CS-201"]);
        const filtered = filterForElectives(results, completed, required, available);
        // ML-101 excluded (completed), CS-201 excluded (required)
        expect(filtered.map(r => r.courseId)).toEqual(["CALC-101", "ART-101"]);
    });
});

// ============================================================
// loadEmbeddingIndex
// ============================================================
describe("Semantic Search: loadEmbeddingIndex", () => {
    it("loads valid index", () => {
        const data = [
            { courseId: "CS-101", title: "Intro CS", embedding: [0.1, 0.2] },
            { courseId: "MATH-101", title: "Calculus", embedding: [0.3, 0.4] },
        ];
        const index = loadEmbeddingIndex(data);
        expect(index).toHaveLength(2);
        expect(index[0].courseId).toBe("CS-101");
        expect(index[0].embedding).toEqual([0.1, 0.2]);
    });

    it("non-array → throws", () => {
        expect(() => loadEmbeddingIndex("not an array")).toThrow("must be an array");
    });

    it("missing courseId → throws", () => {
        expect(() => loadEmbeddingIndex([{ embedding: [1, 2] }])).toThrow("missing courseId");
    });
});

// ============================================================
// semanticElectiveSearch (full pipeline)
// ============================================================
describe("Semantic Search: full pipeline", () => {
    const index: CourseEmbedding[] = [
        mockCourseEmbed("ML-101", "Machine Learning", [0.9, 0.1, 0.0, 0.0]),
        mockCourseEmbed("AI-201", "Artificial Intelligence", [0.8, 0.2, 0.0, 0.0]),
        mockCourseEmbed("ART-101", "Art History", [0.0, 0.1, 0.9, 0.0]),
        mockCourseEmbed("MUSIC-101", "Music Theory", [0.0, 0.0, 0.8, 0.2]),
        mockCourseEmbed("CS-201", "Data Structures", [0.5, 0.5, 0.0, 0.0]),
        mockCourseEmbed("CALC-101", "Calculus I", [0.3, 0.3, 0.0, 0.4]),
    ];

    it("finds ML courses when querying for ML-like embedding", () => {
        const query = [0.85, 0.15, 0.0, 0.0]; // ML-ish
        const completed = new Set(["CALC-101"]);
        const required = new Set(["CS-201"]);
        const results = semanticElectiveSearch(query, index, completed, required, undefined, 3);
        // ML-101 and AI-201 should rank high, CS-201 excluded (required), CALC-101 excluded (completed)
        expect(results[0].courseId).toBe("ML-101");
        expect(results[1].courseId).toBe("AI-201");
        expect(results.find(r => r.courseId === "CALC-101")).toBeUndefined();
        expect(results.find(r => r.courseId === "CS-201")).toBeUndefined();
    });

    it("finds art courses when querying for art-like embedding", () => {
        const query = [0.0, 0.1, 0.95, 0.0]; // strong art signal, no music signal
        const results = semanticElectiveSearch(query, index, new Set(), new Set(), undefined, 2);
        expect(results[0].courseId).toBe("ART-101");
        expect(results[1].courseId).toBe("MUSIC-101");
    });

    it("respects topK", () => {
        const query = [0.5, 0.5, 0.0, 0.0];
        const results = semanticElectiveSearch(query, index, new Set(), new Set(), undefined, 1);
        expect(results).toHaveLength(1);
    });
});
