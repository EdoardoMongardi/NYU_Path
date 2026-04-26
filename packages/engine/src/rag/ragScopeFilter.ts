// ============================================================
// RAG Scope Filter (Phase 4 §5 flow, lines 680-700)
// ============================================================
// Default-hard school/year filter applied BEFORE vector search. The
// architecture's §5 box reads: "DEFAULT-HARD to homeSchool + 'all'.
// EXPLICIT OVERRIDE: if the search query contains an explicit school
// name (e.g., 'Stern', 'Tandon'), include that school's chunks too."
//
// Why default-hard, not soft (§5 commentary): we don't trust the LLM
// to always reformulate context-dependent references ("there", "here")
// into explicit school names. A hard filter prevents cross-school
// contamination. Explicit school names in the query are a
// deterministic, safe signal for opt-in cross-school inclusion.
//
// V1 matches literal school names only ("Stern", "Tandon", "CAS",
// "Tisch", "Steinhardt", "Nursing", "Liberal Studies", "Gallatin",
// "SPS"). Future enhancement: aliases ("business school" → Stern,
// "engineering" → Tandon).
// ============================================================

import type { PolicyChunk } from "./chunker.js";

export interface ScopeOptions {
    /** Student's home school (lowercase id) — chunks for this school always pass */
    homeSchool: string;
    /** Catalog year for hard-filter (e.g., "2025-2026"). Optional — when omitted, year is not filtered. */
    catalogYear?: string;
    /** When true, allow cross-school inclusion when the query mentions another school by literal name */
    allowExplicitOverride?: boolean;
}

export interface ScopeDecision {
    /**
     * Predicate the vector search should apply BEFORE cosine search.
     * Returns true for chunks that pass the scope filter.
     */
    predicate: (chunk: PolicyChunk) => boolean;
    /** Schools admitted into scope (homeSchool, "all", and any explicit override hits) */
    scopedSchools: string[];
    /** Whether an explicit override was triggered by the query */
    overrideTriggered: boolean;
    /** The explicit-override school name(s) detected in the query, if any */
    overrideMatchedSchools: string[];
}

const SCHOOL_NAME_PATTERNS: Array<[RegExp, string]> = [
    [/\bcas\b|\bcollege of arts and science\b|\barts and science\b/i, "cas"],
    [/\bstern\b/i, "stern"],
    [/\btandon\b|\bengineering school\b/i, "tandon"],
    [/\btisch\b/i, "tisch"],
    [/\bsteinhardt\b/i, "steinhardt"],
    [/\bnursing\b|\bmeyers\b/i, "nursing"],
    [/\bliberal studies\b|\bls program\b/i, "liberal_studies"],
    [/\bgallatin\b/i, "gallatin"],
    [/\bsps\b|\bschool of professional studies\b|\bprofessional studies\b/i, "sps"],
];

/**
 * Compute the scope filter for a given (query, homeSchool) pair.
 * Always-included schools: homeSchool + "all" (NYU-wide chunks).
 * Override schools: each literal school name detected in the query
 * (case-insensitive). When `allowExplicitOverride` is false, override
 * detection is skipped entirely.
 */
export function computeScope(query: string, options: ScopeOptions): ScopeDecision {
    const home = options.homeSchool.toLowerCase();
    const allowOverride = options.allowExplicitOverride ?? true;

    const matchedOverrides: string[] = [];
    if (allowOverride) {
        for (const [re, schoolId] of SCHOOL_NAME_PATTERNS) {
            if (schoolId === home) continue; // home school already included
            if (re.test(query)) matchedOverrides.push(schoolId);
        }
    }
    const scopedSchools = Array.from(new Set([home, "all", ...matchedOverrides]));

    const yearFilter = options.catalogYear;
    const predicate = (chunk: PolicyChunk): boolean => {
        if (!scopedSchools.includes(chunk.meta.school)) return false;
        if (yearFilter && chunk.meta.year !== yearFilter) return false;
        return true;
    };

    return {
        predicate,
        scopedSchools,
        overrideTriggered: matchedOverrides.length > 0,
        overrideMatchedSchools: matchedOverrides,
    };
}

/**
 * Convenience: detect just the school overrides without computing the
 * full predicate. Useful for telemetry / logging.
 */
export function detectExplicitSchools(query: string): string[] {
    const out: string[] = [];
    for (const [re, schoolId] of SCHOOL_NAME_PATTERNS) {
        if (re.test(query)) out.push(schoolId);
    }
    return Array.from(new Set(out));
}
