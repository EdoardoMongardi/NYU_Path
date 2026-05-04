// ============================================================
// Phase 11 Stage 1 — Blockquote-attribution verifier (deterministic)
// ============================================================
// Catches the Class E "confidently-wrong fabrication" failure mode:
// the agent emits a blockquote attributed to "the bulletin" /
// "CAS bulletin" / "§..." with text that does NOT appear in any
// search_policy chunk this turn.
//
// Pattern source (claude-code-leak):
//   - verificationAgent.ts:81-128 — every PASS must include the
//     evidence (the executed command's output). We mirror the
//     evidence-required pattern: every blockquote must have a
//     supporting chunk substring; otherwise it's fabricated.
//   - verificationAgent.ts:93-100 — bad-example block: "Reading
//     code is not verification." Same logic: "describing what
//     the bulletin says without the chunk substring is not a
//     citation, it's a paraphrase from training data."
//
// No LLM call. Pure substring containment with whitespace +
// smart-quote normalization. Designed to run in <2ms on a typical
// reply.
// ============================================================

import type { ToolInvocation } from "../agentLoop.js";

export interface FabricatedAttribution {
    /** The blockquote text we couldn't ground. Truncated to 200 chars
     *  for the violation detail. */
    quote: string;
    /** The attribution phrase that triggered the check
     *  ("CAS bulletin §Internal Transfer Students", "the bulletin",
     *  etc.). Empty when the blockquote was attributed implicitly
     *  (a bare blockquote). */
    attribution: string;
    /** How many search_policy summaries we substring-checked. Useful
     *  for debugging "did the verifier even have access to chunks?". */
    chunksSearched: number;
}

export interface BlockquoteVerdict {
    ok: boolean;
    fabrications: FabricatedAttribution[];
}

// ----------------------------------------------------------------
// Quote extraction
// ----------------------------------------------------------------

/**
 * Pull every quoted bulletin claim out of the assistant text.
 * Matches three formats commonly produced by the agent:
 *   1. Markdown blockquote lines (lines starting with `>`)
 *   2. Italicized policy quotes (`*"..."*` or `_"..."_`)
 *   3. Bare double-quoted strings ≥ 25 chars when accompanied by an
 *      attribution phrase ("the bulletin", "§...", "per the policy")
 */
const ATTRIBUTION_RE = /\b(?:the (?:CAS )?bulletin|CAS bulletin|the policy|per the (?:CAS )?bulletin|according to (?:the )?bulletin|§\s*[A-Z][a-zA-Z /\-]+|the catalog|NYU bulletin)\b/g;
const BLOCKQUOTE_LINE_RE = /^>\s*(.+?)\s*$/gm;
const ITALIC_QUOTE_RE = /\*"([^"]{15,})"\*|_"([^"]{15,})"_/g;
const BARE_QUOTE_RE = /"([^"]{25,500})"/g;

interface ExtractedQuote {
    text: string;
    /** Approximate start position in the reply for nearby-attribution lookup. */
    index: number;
    /** Approximate end position. Used to dedupe nested matches. */
    end: number;
    kind: "blockquote" | "italic" | "bare";
}

function extractQuotes(text: string): ExtractedQuote[] {
    const raw: ExtractedQuote[] = [];

    // Blockquotes — collapse consecutive `>` lines into a single quote.
    const blockMatches = Array.from(text.matchAll(BLOCKQUOTE_LINE_RE));
    let bufferStart = -1;
    let bufferLines: string[] = [];
    let bufferIndex = -1;
    let bufferEnd = -1;
    for (let i = 0; i < blockMatches.length; i++) {
        const m = blockMatches[i]!;
        const line = m[1]!.trim();
        const matchEnd = (m.index ?? 0) + m[0].length;
        if (line.length === 0) {
            if (bufferLines.length > 0) {
                raw.push({ text: bufferLines.join(" "), index: bufferIndex, end: bufferEnd, kind: "blockquote" });
                bufferLines = []; bufferIndex = -1; bufferEnd = -1;
            }
            continue;
        }
        if (bufferStart === -1 || (m.index ?? 0) - bufferStart < 200) {
            if (bufferIndex === -1) bufferIndex = m.index ?? 0;
            bufferLines.push(line);
            bufferStart = m.index ?? 0;
            bufferEnd = matchEnd;
        } else {
            if (bufferLines.length > 0) {
                raw.push({ text: bufferLines.join(" "), index: bufferIndex, end: bufferEnd, kind: "blockquote" });
            }
            bufferLines = [line];
            bufferIndex = m.index ?? 0;
            bufferStart = m.index ?? 0;
            bufferEnd = matchEnd;
        }
    }
    if (bufferLines.length > 0) {
        raw.push({ text: bufferLines.join(" "), index: bufferIndex, end: bufferEnd, kind: "blockquote" });
    }

    // Italicized policy quotes
    for (const m of text.matchAll(ITALIC_QUOTE_RE)) {
        raw.push({
            text: (m[1] ?? m[2] ?? "").trim(),
            index: m.index ?? 0,
            end: (m.index ?? 0) + m[0].length,
            kind: "italic",
        });
    }

    // Bare double-quoted strings (only when an attribution phrase is
    // nearby — otherwise this is just dialogue / paraphrase)
    for (const m of text.matchAll(BARE_QUOTE_RE)) {
        const idx = m.index ?? 0;
        const end = idx + m[0].length;
        const window = text.slice(Math.max(0, idx - 80), Math.min(text.length, end + 80));
        if (ATTRIBUTION_RE.test(window)) {
            raw.push({ text: m[1]!.trim(), index: idx, end, kind: "bare" });
        }
        ATTRIBUTION_RE.lastIndex = 0;
    }

    // Dedupe: when a quote's range overlaps a blockquote's range,
    // drop the inner one (the blockquote takes precedence). This
    // prevents counting `> "..."` as both a blockquote and a bare
    // quote.
    const blockquotes = raw.filter((q) => q.kind === "blockquote");
    const others = raw.filter((q) => q.kind !== "blockquote").filter((q) => {
        for (const bq of blockquotes) {
            if (q.index >= bq.index && q.end <= bq.end) return false;
        }
        return true;
    });
    return [...blockquotes, ...others].sort((a, b) => a.index - b.index);
}

/**
 * Find the closest attribution phrase to a quote. Looks within 200
 * chars before and 80 chars after the quote's index.
 */
function findAttribution(text: string, quoteIndex: number): string {
    const before = text.slice(Math.max(0, quoteIndex - 200), quoteIndex);
    const after = text.slice(quoteIndex, Math.min(text.length, quoteIndex + 80));
    const window = before + after;
    const matches = Array.from(window.matchAll(ATTRIBUTION_RE));
    ATTRIBUTION_RE.lastIndex = 0;
    if (matches.length === 0) return "";
    // Prefer the LAST attribution before the quote (the one that
    // introduced it, like "the bulletin says: > ...").
    const beforeMatches = matches.filter((m) => (m.index ?? 0) < before.length);
    if (beforeMatches.length > 0) return beforeMatches[beforeMatches.length - 1]![0];
    return matches[0]![0];
}

// ----------------------------------------------------------------
// Substring matching against search_policy chunks
// ----------------------------------------------------------------

function normalize(s: string): string {
    return s
        .toLowerCase()
        // Smart-quote normalization
        .replace(/[‘’‚‛]/g, "'")
        .replace(/[“”„‟]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * A quote is "grounded" if at least N consecutive content tokens
 * (length ≥ 4) appear contiguously in any search_policy summary.
 * We use a sliding-window check rather than exact substring because
 * the agent often lightly paraphrases (changes "must" to "shall",
 * drops parenthetical asides, etc.) — but the load-bearing
 * content tokens stay.
 */
const GROUNDING_TOKEN_WINDOW = 6;

function isGroundedInChunks(quote: string, chunkSummaries: string[]): boolean {
    const normalizedQuote = normalize(quote);
    if (chunkSummaries.length === 0) return false;
    // Strict substring path — most quotes that are actually grounded
    // pass here (the chunk text includes the quote verbatim).
    for (const summary of chunkSummaries) {
        const normalizedSummary = normalize(summary);
        if (normalizedSummary.includes(normalizedQuote)) return true;
        // For long quotes (>120 chars), accept a partial substring
        // match: any contiguous 100-char window of the quote.
        if (normalizedQuote.length > 120) {
            for (let start = 0; start + 100 <= normalizedQuote.length; start += 40) {
                const window = normalizedQuote.slice(start, start + 100);
                if (normalizedSummary.includes(window)) return true;
            }
        }
    }
    // Token-window path — looser, catches mild paraphrases.
    const quoteTokens = normalizedQuote
        .split(/\W+/)
        .filter((t) => t.length >= 4);
    if (quoteTokens.length < GROUNDING_TOKEN_WINDOW) {
        // Quote is too short for the token-window path; substring
        // already failed, so call it ungrounded.
        return false;
    }
    for (const summary of chunkSummaries) {
        const summaryNormalized = normalize(summary);
        for (let i = 0; i + GROUNDING_TOKEN_WINDOW <= quoteTokens.length; i++) {
            const window = quoteTokens.slice(i, i + GROUNDING_TOKEN_WINDOW).join(" ");
            if (summaryNormalized.includes(window)) return true;
        }
    }
    return false;
}

// ----------------------------------------------------------------
// Public entry
// ----------------------------------------------------------------

/**
 * Verify that every blockquote / italic-quote / attributed-bare-quote
 * in `assistantText` is grounded in some `search_policy` invocation
 * this turn. Emits one FabricatedAttribution per quote that fails.
 *
 * NOTE: this verifier IGNORES quotes that are NOT attributed to a
 * bulletin / catalog / policy source. The agent legitimately uses
 * blockquotes for emphasis, sample plans, etc. — those don't need
 * to be in the RAG corpus.
 */
export function verifyBlockquoteAttribution(
    assistantText: string,
    invocations: ReadonlyArray<ToolInvocation>,
): BlockquoteVerdict {
    const fabrications: FabricatedAttribution[] = [];

    // Gather all search_policy summaries (the agent's view of the
    // chunks). Other tools' summaries are excluded — we only verify
    // bulletin claims against bulletin retrievals.
    const policySummaries: string[] = invocations
        .filter((inv) => inv.toolName === "search_policy" && typeof inv.summary === "string")
        .map((inv) => inv.summary as string);

    // Also gather what_if_audit summaries (they emit bulletin
    // disclaimers as part of the synthesis). These count as
    // grounding sources so that a bulletin disclaimer surfaced
    // by what_if isn't flagged as fabricated.
    for (const inv of invocations) {
        if (inv.toolName === "what_if_audit" && typeof inv.summary === "string") {
            policySummaries.push(inv.summary);
        }
    }

    const quotes = extractQuotes(assistantText);
    for (const q of quotes) {
        const attribution = findAttribution(assistantText, q.index);
        // Only verify quotes that are actually attributed to a
        // bulletin/policy source. A bare blockquote with no
        // attribution is the agent's own framing, not a citation.
        if (!attribution && q.kind === "blockquote") continue;
        if (!attribution && q.kind === "bare") continue;
        // Italic-quote with no nearby attribution: still suspect (the
        // agent chose italic+quotes for a reason). Verify anyway.
        if (isGroundedInChunks(q.text, policySummaries)) continue;
        fabrications.push({
            quote: q.text.length > 200 ? `${q.text.slice(0, 197)}…` : q.text,
            attribution,
            chunksSearched: policySummaries.length,
        });
    }

    return {
        ok: fabrications.length === 0,
        fabrications,
    };
}
