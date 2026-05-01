// ============================================================
// Phase 11 Stage 4 — Gated clarifier sub-agent
// ============================================================
// For genuinely ambiguous queries (Class A in the failure-surface
// analysis: "what about a minor?", "can I take that next semester?"),
// ask one clarifying question before sending the message into the
// main agent loop.
//
// Pattern source (claude-code-leak):
//   - exploreAgent.ts:67-74 — disallowed-tools pattern for read-only
//     sub-agents. Our clarifier is even stricter: it has NO tool
//     access, only a chat completion.
//   - AgentTool/prompt.ts:80-96 — when to fork a sub-agent ("when the
//     intermediate output isn't worth keeping in your context"). The
//     clarifier output is one short question; the main loop ignores
//     it on subsequent turns.
//   - prompts.ts:443-461 — `getSystemPrompt`'s CLAUDE_CODE_SIMPLE
//     branch shows that prompts can be conditionally minimal. The
//     clarifier prompt is similarly minimal: ~15 lines.
//
// The gate fires on at most ~10-15% of incoming traffic. The
// clarifier itself is a single haiku call (~$0.0003); on the 85%
// of clear queries the gate skips entirely.
// ============================================================

import type { LLMClient, LLMMessage } from "./llmClient.js";

export type AmbiguitySignal =
    | "ultra_short"             // ≤ 4 tokens after stop-word removal
    | "pronoun_no_antecedent"   // "it" / "that" / "this" / "those"
    | "vague_subject"           // bare noun-phrase question with no verb
    | "fragment";               // missing subject AND verb

export interface AmbiguityReport {
    ambiguous: boolean;
    signals: AmbiguitySignal[];
    /** Tokens that remain after stop-word filtering — useful for
     *  debugging "why did the gate fire?". */
    contentTokens: string[];
}

const STOP_WORDS = new Set([
    "a", "an", "the", "and", "or", "but", "if", "of", "in", "on", "to", "for",
    "is", "are", "was", "were", "be", "been", "being", "do", "does", "did",
    "have", "has", "had", "this", "that", "these", "those", "it", "its",
    "i", "me", "my", "you", "your", "we", "us", "our", "what", "when",
    "where", "how", "why", "which", "who", "whom", "can", "could", "would",
    "should", "may", "might", "will", "shall", "yes", "no", "ok", "okay",
    "please", "thanks", "thank", "really", "actually", "just", "kinda",
    "uh", "um",
]);

const PRONOUN_RE = /\b(?:it|that|this|those|them|they|those)\b/i;
const FIRST_PERSON_VERB_RE = /\b(?:can\s+i|do\s+i|am\s+i|will\s+i|should\s+i|how\s+(?:many|much)|what(?:'s|\s+is)\s+my|what\s+are\s+my|i\s+(?:want|need|plan|hope)\s+to|did\s+i)\b/i;

/**
 * Decide whether the user's message is ambiguous enough to warrant
 * asking a clarifying question. Pure deterministic.
 */
export function detectAmbiguity(
    userMessage: string,
    history: ReadonlyArray<LLMMessage>,
): AmbiguityReport {
    const text = userMessage.trim();
    const signals: AmbiguitySignal[] = [];

    // Token-stripping: remove stop words, get content tokens.
    const lower = text.toLowerCase();
    const allTokens = lower.split(/\W+/).filter((t) => t.length > 0);
    const contentTokens = allTokens.filter((t) => !STOP_WORDS.has(t));

    // Signal 1: ultra-short content. ≤ 4 content tokens AND no
    // first-person verb anchor. Catches "a minor?" / "next semester?"
    // but NOT "what's my GPA?" (which has a first-person verb anchor).
    const hasFirstPersonVerb = FIRST_PERSON_VERB_RE.test(text);
    if (contentTokens.length <= 4 && text.length <= 80 && !hasFirstPersonVerb) {
        signals.push("ultra_short");
    }

    // Signal 2: pronoun without a clear antecedent in the prior 2
    // turns. We look for "it"/"that"/"this"/"those" in the user
    // message and check whether a noun-phrase appeared in the last
    // 1-2 turns of history. If history is empty AND the message
    // uses a pronoun, that's clearly under-specified.
    if (PRONOUN_RE.test(text)) {
        const recentText = history
            .slice(-4)
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join(" ");
        // No history at all → ambiguous pronoun.
        if (recentText.trim().length === 0) {
            signals.push("pronoun_no_antecedent");
        } else {
            // Cheap antecedent check: does the recent history
            // contain any course/program-shaped capitalized noun?
            const hasAntecedent = /\b(?:CSCI|MATH|CORE|MUSIC|HIST|CHEM|BIOL|PHYS|PSYCH|ECON|MAJOR|MINOR|SEMESTER|PROGRAM|DEGREE)\b/i.test(recentText);
            if (!hasAntecedent) signals.push("pronoun_no_antecedent");
        }
    }

    // Signal 3: vague subject — bare noun-phrase question. Triggers
    // on patterns like "a minor?" / "the math major?" — no first-
    // person verb, no other verb either.
    if (text.length < 60 && /\?\s*$/.test(text) && !FIRST_PERSON_VERB_RE.test(text)) {
        const hasVerb = /\b(?:is|are|do|does|can|will|count|satisfy|require|need|count|graduate|take|drop|add|register)\b/i.test(text);
        if (!hasVerb) signals.push("vague_subject");
    }

    // Signal 4: fragment — no subject AND no verb at all.
    if (contentTokens.length >= 1 && contentTokens.length <= 3 && !FIRST_PERSON_VERB_RE.test(text)) {
        const hasSubjectOrVerb = /\b(?:i|you|we|the|a|an|is|are|do|can|will)\b/i.test(text);
        if (!hasSubjectOrVerb) signals.push("fragment");
    }

    // Conservative ambiguity gate: fire only when at least 1 signal
    // was raised AND the message is short enough that a clarifying
    // question is reasonable (not for long compound queries).
    const ambiguous = signals.length > 0 && text.length < 100;

    return { ambiguous, signals, contentTokens };
}

// ----------------------------------------------------------------
// Clarifier sub-agent
// ----------------------------------------------------------------

const CLARIFIER_SYSTEM_PROMPT = `You are a clarification specialist for an academic-advising agent at NYU CAS.

Your ONLY job: when the student's message is ambiguous, ask ONE concise clarifying
question that would let the main agent answer correctly.

You have NO tools. You CANNOT answer the student's question, look up policy, or
quote the bulletin. You can only ask one question or signal "CLEAR".

OUTPUT RULES (strict):
- If the message is ambiguous, output: "Could you clarify: [one focused question]?"
- If the message is actually clear (you disagree with the gate), output exactly: "CLEAR"
- Do NOT prefix with "Sure" or "Hi" — output the question directly.
- Do NOT ask multiple questions. Pick the one that most reduces ambiguity.

EXAMPLES:
- Student: "what about a minor?" → "Could you clarify: which minor are you considering, and are you asking about declaring it or about its requirements?"
- Student: "can I take that next semester?" → "Could you clarify: which course do you mean by 'that'?"
- Student: "is this enough?" → "Could you clarify: enough for what — graduation, your major requirements, or something else?"
- Student: "What's my GPA?" (clear) → "CLEAR"

Stay under 35 words.`;

export interface ClarificationResult {
    /** "CLEAR" when the clarifier disagrees with the gate, or the
     *  clarifying question text. */
    output: string;
    isClear: boolean;
    /** Tokens used (for cost telemetry). */
    promptTokens: number;
    completionTokens: number;
}

/**
 * Run the clarifier sub-agent. Modeled on Claude Code's Explore
 * agent (exploreAgent.ts:64-83) with two key adaptations:
 *   1. No tools at all (Explore has Grep/Glob/Read; we have none)
 *   2. Stricter output schema (one question OR "CLEAR")
 *
 * Use a haiku-tier model for cost; this fires on at most 10-15% of
 * traffic so total monthly cost is < $0.001 at cohort A scale.
 */
export async function askClarification(
    client: LLMClient,
    userMessage: string,
    history: ReadonlyArray<LLMMessage>,
    studentContext: { homeSchool?: string; declaredPrograms?: string[]; visaStatus?: string },
): Promise<ClarificationResult> {
    const contextLine = [
        studentContext.homeSchool ? `home school: ${studentContext.homeSchool}` : null,
        studentContext.declaredPrograms && studentContext.declaredPrograms.length > 0
            ? `declared: ${studentContext.declaredPrograms.join(", ")}`
            : null,
        studentContext.visaStatus ? `visa: ${studentContext.visaStatus}` : null,
    ].filter(Boolean).join(" · ");

    const messages: LLMMessage[] = [];
    // Include the last 2 turns of history for antecedent resolution.
    const recent = history.slice(-2);
    for (const m of recent) {
        if (typeof m.content === "string") messages.push({ role: m.role, content: m.content });
    }
    messages.push({
        role: "user",
        content: contextLine
            ? `[student context: ${contextLine}]\n\nMessage: ${userMessage}`
            : `Message: ${userMessage}`,
    });

    const res = await client.complete({
        system: CLARIFIER_SYSTEM_PROMPT,
        messages,
        temperature: 0.1,
        maxTokens: 80,
    });
    const out = res.text.trim();
    const isClear = out === "CLEAR" || out.toUpperCase() === "CLEAR";
    return {
        output: out,
        isClear,
        promptTokens: res.usage?.promptTokens ?? 0,
        completionTokens: res.usage?.completionTokens ?? 0,
    };
}
