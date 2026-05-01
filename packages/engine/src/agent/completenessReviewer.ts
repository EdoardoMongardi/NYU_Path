// ============================================================
// Completeness reviewer (Phase 10 Stage 4 — Method B)
// ============================================================
// After the main agent emits its final reply, this reviewer
// compares the reply to the union of envelope metadata across all
// tool invocations in the turn. If any disclaimer / anchor was
// dropped, the reviewer returns a structured FAIL with reasons; the
// caller then re-prompts the agent ONCE with the reviewer's notes
// in a system message.
//
// Inspired by Claude Code's verification agent pattern (philosophy:
// "your job is to break it, not confirm it"). The reviewer is
// deterministic — no LLM call — because the envelope already
// encodes what must be surfaced. We just check substring containment
// in the reply.
// ============================================================

import type { ToolInvocation } from "./tool.js";
import type { Disclaimer, BulletinAnchor, EnvelopeMeta } from "./toolEnvelope.js";

export interface CompletenessReviewVerdict {
    pass: boolean;
    droppedDisclaimers: Disclaimer[];
    droppedAnchors: BulletinAnchor[];
    /** A single short prompt-message the caller can hand back to the
     *  agent on retry. Empty when pass=true. */
    retryGuidance: string;
}

/**
 * Extract envelope metadata from a tool invocation's `result`. Tool
 * results are arbitrary objects; we look for the envelope fields by
 * convention. Returns an empty envelope when the tool didn't opt in.
 */
function extractEnvelope(inv: ToolInvocation): EnvelopeMeta {
    const r = inv.result as { disclaimers?: Disclaimer[]; suggestedFollowUps?: unknown; anchors?: BulletinAnchor[]; confidence?: EnvelopeMeta["confidence"] };
    if (!r || typeof r !== "object") return {};
    return {
        disclaimers: Array.isArray(r.disclaimers) ? r.disclaimers : undefined,
        anchors: Array.isArray(r.anchors) ? r.anchors : undefined,
        confidence: typeof r.confidence === "string" ? r.confidence : undefined,
    };
}

/**
 * Substring containment with whitespace + case tolerance. The
 * disclaimer text is what we hand the LLM verbatim, but agents do
 * sometimes lightly reformat (e.g. swap straight quotes for curly).
 * We allow that as long as the load-bearing content is present.
 */
function containsLoosely(haystack: string, needle: string): boolean {
    const norm = (s: string) =>
        s
            .toLowerCase()
            .replace(/[‘’“”]/g, '"')
            .replace(/\s+/g, " ")
            .trim();
    const h = norm(haystack);
    const n = norm(needle);
    if (h.includes(n)) return true;
    // Fall back to a 60% token overlap — catches cases where the LLM
    // breaks a disclaimer across two sentences but keeps the load-
    // bearing nouns/verbs.
    const tokens = n.split(/\W+/).filter((t) => t.length >= 4);
    if (tokens.length === 0) return false;
    const hits = tokens.filter((t) => h.includes(t));
    return hits.length / tokens.length >= 0.6;
}

export function reviewCompleteness(
    finalText: string,
    invocations: ReadonlyArray<ToolInvocation>,
): CompletenessReviewVerdict {
    const droppedDisclaimers: Disclaimer[] = [];
    const droppedAnchors: BulletinAnchor[] = [];

    const seenDisclaimerIds = new Set<string>();
    for (const inv of invocations) {
        const env = extractEnvelope(inv);
        for (const d of env.disclaimers ?? []) {
            if (seenDisclaimerIds.has(d.id)) continue;
            seenDisclaimerIds.add(d.id);
            if (!containsLoosely(finalText, d.text)) {
                droppedDisclaimers.push(d);
            }
        }
        for (const a of env.anchors ?? []) {
            if (!containsLoosely(finalText, a.quote.slice(0, 80))) {
                droppedAnchors.push(a);
            }
        }
    }

    if (droppedDisclaimers.length === 0 && droppedAnchors.length === 0) {
        return { pass: true, droppedDisclaimers, droppedAnchors, retryGuidance: "" };
    }

    const lines: string[] = [];
    lines.push("Your previous draft was incomplete. The following structured tool-result fields were not surfaced verbatim and MUST appear in the next draft:");
    if (droppedDisclaimers.length > 0) {
        lines.push("Missing disclaimers:");
        for (const d of droppedDisclaimers) {
            lines.push(`  • "${d.text}"  (reason: ${d.reason})`);
        }
    }
    if (droppedAnchors.length > 0) {
        lines.push("Missing bulletin anchors:");
        for (const a of droppedAnchors) {
            lines.push(`  • "${a.quote}" — Source: ${a.source}`);
        }
    }
    lines.push("Re-issue the reply with these surfaced. Keep everything else intact.");
    return {
        pass: false,
        droppedDisclaimers,
        droppedAnchors,
        retryGuidance: lines.join("\n"),
    };
}
