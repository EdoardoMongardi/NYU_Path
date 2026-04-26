// ============================================================
// Curated Policy Templates (Phase 4 §5.5)
// ============================================================
// Per architecture §5.5:
//
//   "For the top 20-30 most commonly asked policy questions, maintain
//    human-curated stable answer templates. These are checked BEFORE
//    RAG synthesis. If a match is found, the curated answer is used
//    directly (no LLM synthesis)."
//
// Each template carries:
//   - triggerQueries: literal substrings or patterns that match the user's question
//   - body: stable answer text (the curated reply)
//   - source: bulletin citation (file path + section)
//   - school: which school's policy this template applies to ("cas",
//     "stern", ..., or "all" for NYU-wide)
//   - applicability: optional gate excluding the template when the
//     student has programs in conflicting schools or is exploring a
//     transfer (architecture §5.5 example: P/F-major template excluded
//     for Stern students because Stern has different P/F rules)
// ============================================================

export interface PolicyTemplateApplicability {
    /** Don't use this template if the student has programs in any of these schools */
    excludeIfPrograms?: string[];
    /** Don't use this template if the student is exploring a transfer */
    requiresNoTransferIntent?: boolean;
}

export interface PolicyTemplate {
    /** Stable identifier, e.g., "pf_major" */
    id: string;
    /** Substrings (case-insensitive) that should match this template */
    triggerQueries: string[];
    /** The curated answer body (markdown) */
    body: string;
    /** Bulletin citation, e.g., "CAS Academic Policies, §Pass/Fail Option" */
    source: string;
    /** "cas", "stern", "tandon", ..., or "all" */
    school: string;
    /** ISO date the template was last hand-verified */
    lastVerified: string;
    applicability?: PolicyTemplateApplicability;
}

/** §5.5 freshness gate: a template is "fresh" if lastVerified is within
 *  this many days of the current date. */
export const TEMPLATE_FRESHNESS_DAYS = 365;

/** §5.5 context-pronoun guard: queries that are heavily context-dependent
 *  ("can I do that?", "is it allowed?") shouldn't match a literal trigger
 *  because the referent is ambiguous. */
const CONTEXT_PRONOUN_RE = /^\s*(?:can\s+i\s+do|is\s+it|are\s+(?:those|these|they)|what\s+about\s+(?:that|those|these|it|them))\b/i;

export interface TemplateMatchResult {
    template: PolicyTemplate;
    /** Substring that matched */
    matchedTrigger: string;
}

export interface MatchTemplateOptions {
    /** Catalog year the request is for. When supplied, templates whose
     *  `_meta.catalogYear` differs are skipped. The loader strips _meta
     *  off the body, so the template object itself doesn't carry the
     *  year — callers pass it through. */
    catalogYear?: string;
    /** When the student is exploring a transfer, suppress templates
     *  whose applicability requires no transfer intent. */
    transferIntent?: boolean;
    /** Override the freshness window (days). Defaults to 365. */
    freshnessDays?: number;
    /** Reference date for freshness check (testing override). Defaults to now. */
    now?: Date;
}

/**
 * Match a query against a list of templates. Returns the FIRST template
 * whose trigger appears (case-insensitive substring) in the query AND
 * whose applicability rules allow it for the given home school AND that
 * passes the freshness + context-pronoun gates.
 *
 * Priority: same-school templates first, then "all" templates.
 */
export function matchTemplate(
    query: string,
    templates: PolicyTemplate[],
    homeSchool: string,
    options: MatchTemplateOptions = {},
): TemplateMatchResult | null {
    const q = query.toLowerCase().trim();
    const home = homeSchool.toLowerCase();

    // §5.5 step 2 — context-pronoun guard. "can i do that?", "is it ok?"
    // and similar context-dependent phrasings refer to a prior turn we
    // don't have here; refuse the literal-trigger fast-path so the chat
    // layer falls through to RAG (which carries the caveat).
    if (CONTEXT_PRONOUN_RE.test(q)) return null;

    const freshnessDays = options.freshnessDays ?? TEMPLATE_FRESHNESS_DAYS;
    const now = options.now ?? new Date();

    // Sort: prefer same-school templates over "all"
    const ordered = [...templates].sort((a, b) => {
        const aRank = a.school === home ? 0 : a.school === "all" ? 1 : 2;
        const bRank = b.school === home ? 0 : b.school === "all" ? 1 : 2;
        return aRank - bRank;
    });

    for (const t of ordered) {
        // Skip templates that aren't in scope for the home school
        if (t.school !== home && t.school !== "all") continue;
        // §5.5 step 4 — applicability exclusions (excludeIfPrograms,
        // requiresNoTransferIntent)
        if (t.applicability?.excludeIfPrograms?.includes(home)) continue;
        if (t.applicability?.requiresNoTransferIntent && options.transferIntent) continue;
        // §5.5 step 5 — freshness check
        const verified = new Date(t.lastVerified + "T00:00:00Z");
        if (Number.isNaN(verified.getTime())) continue;
        const ageMs = now.getTime() - verified.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > freshnessDays) continue;
        // Find the first trigger that appears in the query
        const matched = t.triggerQueries.find((trig) => q.includes(trig.toLowerCase()));
        if (matched) {
            return { template: t, matchedTrigger: matched };
        }
    }
    return null;
}
