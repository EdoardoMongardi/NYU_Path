// ============================================================
// Phase 11 Stage 3 — Multi-intent enumeration detector (deterministic)
// ============================================================
// Catches the "user asked two questions, agent answered one" failure
// mode by recognizing compound queries before the agent loop runs.
// When detected, the route layer prepends a system message that
// enumerates the sub-questions, ensuring the agent addresses each.
//
// Pattern source (claude-code-leak):
//   - AgentTool/prompt.ts:99-113 — the "brief the agent like a smart
//     colleague who just walked in the room" pattern. The relevant
//     insight: good agents ENUMERATE what they were asked to do
//     before doing it. We adopt the enumeration step deterministically.
//   - prompts.ts:291-310 — example of injecting context-dependent
//     guidance into the prompt dynamically. Same shape: only inject
//     the enumeration hint when the detector fires.
//
// Pure deterministic. No LLM call. ~30 lines of regex heuristics.
// ============================================================

export type MultiIntentSignal =
    | "multiple_question_marks"
    | "coordinating_conjunction"
    | "compound_what_if"
    | "two_distinct_first_person_verbs";

export interface MultiIntentReport {
    isMultiIntent: boolean;
    /** Best-effort split of the user message into sub-question
     *  fragments. May be empty when the detector fires on a signal
     *  that doesn't naturally split (e.g., "compound what if"). */
    detectedSubQuestions: string[];
    signals: MultiIntentSignal[];
}

// Two `?` separated by ≥ 3 word tokens: "What's my GPA? Can I add a Math minor?"
// Threshold is deliberately low so compact compound queries fire,
// while emphasis like "Really??" doesn't.
function hasMultipleQuestionMarks(text: string): boolean {
    const indices: number[] = [];
    for (let i = 0; i < text.length; i++) if (text[i] === "?") indices.push(i);
    if (indices.length < 2) return false;
    const gap = text.slice(indices[0]! + 1, indices[indices.length - 1]!);
    const words = gap.split(/\W+/).filter((t) => t.length >= 2);
    return words.length >= 3;
}

// "what is X AND can I Y" — distinct first-person verbs joined by a
// conjunction. Designed to catch coordinated requests, not just any
// "and". Looks for two verb-phrase signatures separated by a
// coordinator within ≤ 60 chars.
const FIRST_PERSON_VERB_RE = /\b(?:can\s+i|do\s+i|am\s+i|will\s+i|should\s+i|how\s+(?:many|much|do\s+i)|what(?:'s|\s+is)\s+my|what\s+are\s+my|have\s+i|did\s+i|when\s+do\s+i|where\s+(?:can|do)\s+i|i\s+(?:want|need|plan|hope)\s+to)\b/gi;
const COORDINATOR_RE = /\b(?:and|also|plus|then|;|,\s+(?:and|also))\b/gi;

function hasCoordinatedFirstPersonRequests(text: string): boolean {
    const verbMatches = Array.from(text.matchAll(FIRST_PERSON_VERB_RE));
    if (verbMatches.length < 2) return false;
    const coordMatches = Array.from(text.matchAll(COORDINATOR_RE));
    if (coordMatches.length === 0) return false;
    // Require at least one coordinator that splits two verb matches
    // (i.e., a coordinator falls between any earlier verb and any
    // later verb). This catches "How many X do I have, AND what are
    // my Y" where the coordinator sits between the 2nd and 3rd verb
    // match, not necessarily between the 1st and 2nd.
    const firstVerbIdx = verbMatches[0]!.index!;
    const lastVerbIdx = verbMatches[verbMatches.length - 1]!.index!;
    return coordMatches.some((c) => {
        const ci = c.index!;
        return ci > firstVerbIdx && ci < lastVerbIdx;
    });
}

// "What if I add a minor and what if I drop calculus?"
function hasCompoundWhatIf(text: string): boolean {
    const matches = text.match(/\bwhat\s+if\b/gi);
    return (matches?.length ?? 0) >= 2;
}

// Coordinator joining two distinct intent verbs. This is a softer
// version of hasCoordinatedFirstPersonRequests.
function hasCoordinatingConjunctionWithIntents(text: string): boolean {
    const intentVerbs = /\b(?:plan|drop|add|register|switch|graduate|take|count|satisfy|meet|need|want|change|declare|transfer|find|search|check|see|know)\b/gi;
    const matches = Array.from(text.matchAll(intentVerbs));
    if (matches.length < 2) return false;
    const coords = Array.from(text.matchAll(COORDINATOR_RE));
    if (coords.length === 0) return false;
    const firstVerb = matches[0]!.index!;
    const secondVerb = matches[1]!.index!;
    return coords.some((c) => {
        const ci = c.index!;
        return ci > firstVerb && ci < secondVerb;
    });
}

/**
 * Best-effort split of a multi-intent message into sub-question
 * fragments. Splits on `?` first; falls back to splitting on
 * `and|also|plus|then` between intent verbs.
 */
function splitIntoSubQuestions(text: string): string[] {
    // Question-mark splits — one fragment per `?`.
    if (text.includes("?")) {
        const parts = text.split("?")
            .map((p) => p.trim())
            .filter((p) => p.length >= 4);
        if (parts.length >= 2) return parts.map((p) => `${p}?`);
    }
    // Fall back to coordinator split.
    const coords = /\b(?:and|also|plus|then)\b/gi;
    const fragments = text.split(coords).map((s) => s.trim()).filter((s) => s.length >= 8);
    if (fragments.length >= 2) return fragments;
    return [];
}

export function detectMultiIntent(userMessage: string): MultiIntentReport {
    const text = userMessage.trim();
    const signals: MultiIntentSignal[] = [];

    if (hasMultipleQuestionMarks(text)) signals.push("multiple_question_marks");
    if (hasCoordinatedFirstPersonRequests(text)) signals.push("two_distinct_first_person_verbs");
    if (hasCompoundWhatIf(text)) signals.push("compound_what_if");
    if (hasCoordinatingConjunctionWithIntents(text)) signals.push("coordinating_conjunction");

    const isMultiIntent = signals.length > 0;
    return {
        isMultiIntent,
        detectedSubQuestions: isMultiIntent ? splitIntoSubQuestions(text) : [],
        signals,
    };
}

/**
 * Render a system-message string the route layer can inject before
 * the agent loop. Uses the briefing pattern from
 * AgentTool/prompt.ts:99-113 — give the agent the intent enumeration
 * up front so it doesn't have to infer it.
 */
export function renderMultiIntentBriefing(report: MultiIntentReport): string {
    if (!report.isMultiIntent) return "";
    const lines: string[] = [];
    lines.push("MULTI-INTENT DETECTED: the user's message contains multiple distinct requests.");
    if (report.detectedSubQuestions.length > 0) {
        lines.push("Sub-questions to address:");
        for (let i = 0; i < report.detectedSubQuestions.length; i++) {
            lines.push(`  ${i + 1}. ${report.detectedSubQuestions[i]}`);
        }
    } else {
        lines.push(`Signals detected: ${report.signals.join(", ")}.`);
    }
    lines.push(
        "Address EACH sub-question in your reply. Don't drop one half. " +
        "If two questions need different tools, call them all (in parallel when independent).",
    );
    return lines.join("\n");
}
