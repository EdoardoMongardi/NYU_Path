// ============================================================
// CORE-UA Range → Requirement classification (Phase 10 Stage 2)
// ============================================================
// The CAS College Core Curriculum's bulletin page documents that
// CORE-UA course numbers are partitioned by hundreds-range:
//   • CORE-UA 4XX  → Texts and Ideas
//   • CORE-UA 5XX  → Cultures and Contexts
//   • CORE-UA 7XX  → Expressive Culture
//   • CORE-UA 8XX  → Societies and the Social Sciences
//
// Phase 9.5 memorized this mapping inside the system prompt and
// the search_policy tool description. Phase 10 moves it to a
// single source of truth here. `search_policy` and `run_full_audit`
// invoke `classifyCoreUa()` to embed the classification as a
// structured envelope field — the agent surfaces it via posture
// rather than via a per-case prose rule.
//
// Source: https://bulletin.cas.nyu.edu/undergraduate/college-core-curriculum/
// Last verified: 2026-04-29 (Phase 10 Stage 2)
// ============================================================

export interface CoreUaRange {
    /** Inclusive lower bound of the catalog-number range. */
    lo: number;
    /** Inclusive upper bound. */
    hi: number;
    /** The College Core Curriculum requirement this range satisfies. */
    requirement: string;
    /** Bulletin source path for citation. */
    bulletinSource: string;
}

export const CORE_UA_RANGES: ReadonlyArray<CoreUaRange> = [
    {
        lo: 400, hi: 499,
        requirement: "Texts and Ideas",
        bulletinSource: "bulletin/cas/college-core-curriculum#texts-and-ideas",
    },
    {
        lo: 500, hi: 599,
        requirement: "Cultures and Contexts",
        bulletinSource: "bulletin/cas/college-core-curriculum#cultures-and-contexts",
    },
    {
        lo: 700, hi: 799,
        requirement: "Expressive Culture",
        bulletinSource: "bulletin/cas/college-core-curriculum#expressive-culture",
    },
    {
        lo: 800, hi: 899,
        requirement: "Societies and the Social Sciences",
        bulletinSource: "bulletin/cas/college-core-curriculum#societies-and-the-social-sciences",
    },
];

export interface CoreUaClassification {
    /** Original course id, e.g. "CORE-UA 700". */
    courseId: string;
    /** Numeric value extracted from the catalog number, e.g. 700. */
    catalogNbr: number;
    /** The matched range, or null if the number doesn't fall in any. */
    range: CoreUaRange | null;
}

/**
 * Classify a CORE-UA course id against the bulletin's range partition.
 * Returns null if the input isn't a CORE-UA course id; returns a
 * classification with `range: null` if the number falls outside any
 * known range (e.g., CORE-UA 999 doesn't exist).
 */
export function classifyCoreUa(courseId: string): CoreUaClassification | null {
    const m = courseId.match(/^\s*CORE-UA\s+(\d{1,4})\b/i);
    if (!m) return null;
    const nbr = parseInt(m[1]!, 10);
    if (!Number.isFinite(nbr)) return null;
    const range = CORE_UA_RANGES.find((r) => nbr >= r.lo && nbr <= r.hi) ?? null;
    return { courseId: m[0].trim(), catalogNbr: nbr, range };
}

/**
 * Detect any CORE-UA references in a free-text query and return
 * classifications. Used by search_policy to attach
 * `coreUaClassifications` to its envelope when the query touches the
 * core curriculum.
 */
export function detectCoreUaReferences(query: string): CoreUaClassification[] {
    const out: CoreUaClassification[] = [];
    const seen = new Set<string>();
    for (const m of query.matchAll(/CORE-UA\s+(\d{1,4})/gi)) {
        const c = classifyCoreUa(m[0]);
        if (c && !seen.has(c.courseId)) {
            seen.add(c.courseId);
            out.push(c);
        }
    }
    return out;
}

/**
 * Detect any "Texts and Ideas" / "Cultures and Contexts" / etc.
 * mentions in a query and return the matching ranges. Lets the
 * agent answer "what number is Expressive Culture?" without
 * memorizing the mapping.
 */
export function detectRequirementReferences(query: string): CoreUaRange[] {
    const lower = query.toLowerCase();
    const out: CoreUaRange[] = [];
    for (const r of CORE_UA_RANGES) {
        if (lower.includes(r.requirement.toLowerCase())) out.push(r);
    }
    return out;
}
