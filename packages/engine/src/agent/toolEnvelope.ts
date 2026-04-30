// ============================================================
// Tool envelope (Phase 10 Stage 3)
// ============================================================
// Every agent tool now returns a structured envelope alongside its
// primary `data` payload:
//   {
//     data,                  // the original return shape, untouched
//     disclaimers,           // bulletin facts the agent MUST surface
//     suggestedFollowUps,    // ready-to-call follow-up tool invocations
//     anchors,               // verbatim bulletin quotes with sources
//     confidence,            // honest confidence bound on the result
//     verbatim,              // canonical Cardinal Rule §2.1 anchor text
//   }
//
// The envelope is the architectural lever for Phase 10. Rules that
// used to live as prose in the system prompt — "ALWAYS append the
// C-or-better disclaimer when discussing major requirements" — now
// live as DATA on the envelope: when run_full_audit returns an
// unsatisfied major requirement, it attaches the C-or-better
// disclaimer to its envelope. The system prompt only carries one
// posture rule about envelopes ("surface every disclaimer / anchor
// / follow-up faithfully"), and adding a new disclaimer for a new
// edge case is a data change, not a prompt change.
//
// Tools opt into envelope semantics by returning an EnvelopeAware<T>
// shape — `data` is required, every other field is optional. The
// agent's tool-result renderer (summarizeResult in each tool, or the
// shared default in agent/tool.ts) consults the envelope and embeds
// the structured fields in the text the LLM sees.
// ============================================================

/**
 * One bulletin-derived rule the agent must surface in its reply.
 * Disclaimers are deduplicated by `id` across multiple tool calls in
 * the same turn — if both run_full_audit and search_policy emit the
 * `cas_pf_no_major` disclaimer, the renderer surfaces it once.
 */
export interface Disclaimer {
    /** Stable identifier — used for dedup and tracing. */
    id: string;
    /** Verbatim text the agent must surface (no paraphrase). */
    text: string;
    /** Why this disclaimer applies to the current turn. Supplied to
     *  the LLM as context so it can phrase the surrounding sentence
     *  naturally without erasing the disclaimer's content. */
    reason: string;
    /** Citation pointer (bulletin URL fragment, school config path,
     *  template id, etc.). Optional but encouraged. */
    bulletinSource?: string;
}

/**
 * A ready-to-call follow-up tool invocation. Replaces the legacy
 * "MANDATORY HANDOFF" prose rules — when run_full_audit detects that
 * a requirement is generic, it attaches a SuggestedFollowUp pointing
 * at search_policy with the right query. The agent calls it because
 * the envelope says so, not because the prompt enumerates the case.
 */
export interface SuggestedFollowUp {
    /** Tool name as registered, e.g. "search_policy". */
    tool: string;
    /** Pre-computed args ready to pass to the tool. */
    args: Record<string, unknown>;
    /** One-sentence rationale for the LLM. */
    why: string;
}

/**
 * A verbatim bulletin / data quote with its source. Used for "the
 * sample plan of study places CSCI-UA 421 in 7th semester" anchors —
 * the planner attaches the relevant table row, the agent surfaces it
 * in the answer.
 */
export interface BulletinAnchor {
    /** Where the quote came from, e.g. "CAS Math/CS BA — Sample Plan
     *  of Study, Year 4 Fall". */
    source: string;
    /** Verbatim text, ≤ 240 chars to keep summary frames small. */
    quote: string;
    /** Why this quote was attached. */
    relevance: string;
}

/**
 * Confidence the agent should honestly relay. "uncertain" maps to the
 * "I couldn't find a specific policy on X" cascade. "high" means the
 * tool found an exact match and surface confidently.
 */
export type EnvelopeConfidence = "high" | "medium" | "low" | "uncertain";

/**
 * Envelope metadata attached to a tool result. All fields except
 * `data` are optional — tools opt in incrementally. The renderer
 * silently ignores empty arrays, so a tool that doesn't yet emit
 * disclaimers continues to work.
 */
export interface EnvelopeMeta {
    disclaimers?: Disclaimer[];
    suggestedFollowUps?: SuggestedFollowUp[];
    anchors?: BulletinAnchor[];
    confidence?: EnvelopeConfidence;
    verbatim?: string | null;
}

/**
 * A tool result that carries envelope metadata. Used by callers that
 * inspect the envelope structurally (e.g., the response validator).
 */
export type EnvelopeAware<T> = T & EnvelopeMeta;

/**
 * Render envelope metadata as text the LLM can read. Called by each
 * tool's summarizeResult after it renders the primary data payload.
 * Returns the empty string when there is nothing to surface.
 */
export function renderEnvelopeMeta(meta: EnvelopeMeta | undefined): string {
    if (!meta) return "";
    const lines: string[] = [];
    const ds = meta.disclaimers ?? [];
    const fs = meta.suggestedFollowUps ?? [];
    const as_ = meta.anchors ?? [];
    if (ds.length > 0) {
        lines.push(`-- DISCLAIMERS YOU MUST SURFACE (verbatim) --`);
        for (const d of ds) {
            lines.push(`  • ${d.text}`);
            const tail: string[] = [];
            if (d.reason) tail.push(`reason: ${d.reason}`);
            if (d.bulletinSource) tail.push(`source: ${d.bulletinSource}`);
            if (tail.length > 0) lines.push(`    (${tail.join("; ")})`);
        }
    }
    if (as_.length > 0) {
        lines.push(`-- BULLETIN ANCHORS (cite the source when surfacing) --`);
        for (const a of as_) {
            lines.push(`  • "${a.quote}"`);
            lines.push(`    Source: ${a.source} — Relevance: ${a.relevance}`);
        }
    }
    if (fs.length > 0) {
        lines.push(`-- SUGGESTED FOLLOW-UPS (call the tool if the question is unanswered) --`);
        for (const f of fs) {
            lines.push(`  • call \`${f.tool}\` with ${JSON.stringify(f.args)} — ${f.why}`);
        }
    }
    if (meta.confidence && meta.confidence !== "high") {
        lines.push(`-- CONFIDENCE: ${meta.confidence} (relay this honestly to the student) --`);
    }
    return lines.join("\n");
}

/**
 * Merge envelope fields from multiple tool calls in a turn. Used by
 * the response validator + completeness reviewer (Phase 10 Stage 4
 * Methods B/C) to assess whether the agent surfaced every disclaimer
 * across all envelopes.
 */
export function mergeEnvelopes(...metas: ReadonlyArray<EnvelopeMeta | undefined>): EnvelopeMeta {
    const disclaimers = new Map<string, Disclaimer>();
    const followUps: SuggestedFollowUp[] = [];
    const anchors: BulletinAnchor[] = [];
    let lowest: EnvelopeConfidence = "high";
    const order: EnvelopeConfidence[] = ["high", "medium", "low", "uncertain"];
    for (const m of metas) {
        if (!m) continue;
        for (const d of m.disclaimers ?? []) {
            if (!disclaimers.has(d.id)) disclaimers.set(d.id, d);
        }
        for (const f of m.suggestedFollowUps ?? []) followUps.push(f);
        for (const a of m.anchors ?? []) anchors.push(a);
        if (m.confidence && order.indexOf(m.confidence) > order.indexOf(lowest)) {
            lowest = m.confidence;
        }
    }
    return {
        disclaimers: Array.from(disclaimers.values()),
        suggestedFollowUps: followUps,
        anchors,
        confidence: lowest,
    };
}
