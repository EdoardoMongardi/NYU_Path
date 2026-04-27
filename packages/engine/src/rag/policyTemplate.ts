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

/** Token-overlap match threshold per Phase 6 WS6. Wave5 finding #2:
 *  the original contiguous-substring matcher missed common phrasings
 *  like "Can I take a major course P/F?" against the trigger "p/f major"
 *  because the tokens are non-contiguous. The token-overlap path
 *  requires this fraction of trigger tokens to appear (anywhere) in
 *  the query, after stop-word filtering. */
const TOKEN_OVERLAP_THRESHOLD = 0.66;

/** Stop words stripped before token-overlap scoring. Kept tiny on
 *  purpose — the goal is to filter out function words, not domain
 *  terms. Adding nouns or verbs here weakens the matcher. */
const STOP_WORDS = new Set([
    "a", "an", "the",
    "i", "you", "we", "they", "he", "she", "it",
    "is", "are", "was", "were", "be", "been", "being",
    "do", "does", "did",
    "to", "of", "for", "in", "on", "at", "by",
    "and", "or", "but",
    "if", "then", "than",
    "can", "could", "may", "might", "should", "would", "will",
    "this", "that", "these", "those",
    "my", "your", "our", "their", "his", "her",
    "me", "us",
    "what", "how", "when", "where", "which", "who", "why",
    "have", "has", "had",
    "not", "no",
    "any", "some", "all",
]);

/** Split text into lowercase tokens, preserving alphanumeric runs and
 *  punctuation-glued tokens (e.g., "p/f"). */
function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/\s+/)
        .map((tok) => tok.replace(/^[^a-z0-9/+#-]+|[^a-z0-9/+#-]+$/g, ""))
        .filter((tok) => tok.length > 0);
}

function nonStopTokens(text: string): string[] {
    return tokenize(text).filter((t) => !STOP_WORDS.has(t));
}

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
        // §5.5 step 1 — keyword match. Two passes:
        //   (a) contiguous-substring (fast, handles short canonical
        //       triggers like "p/f major" against "...p/f major...").
        //   (b) token-overlap (Wave5 WS6): each trigger's non-stop
        //       tokens must appear in the query at ≥0.66 fraction.
        //       Catches non-contiguous phrasings like "Can I take a
        //       major course P/F?" against trigger "p/f major".
        const matchedSubstring = t.triggerQueries.find((trig) => q.includes(trig.toLowerCase()));
        if (matchedSubstring) {
            return { template: t, matchedTrigger: matchedSubstring };
        }
        const queryTokens = new Set(nonStopTokens(q));
        for (const trig of t.triggerQueries) {
            const trigTokens = nonStopTokens(trig);
            if (trigTokens.length === 0) continue;
            // Require at least one trigger token to be present (guards
            // against vacuous matches when stop-word filtering empties
            // the trigger).
            const overlap = trigTokens.filter((tok) => queryTokens.has(tok)).length;
            if (overlap === 0) continue;
            if (overlap / trigTokens.length >= TOKEN_OVERLAP_THRESHOLD) {
                return { template: t, matchedTrigger: trig };
            }
        }
    }
    return null;
}
