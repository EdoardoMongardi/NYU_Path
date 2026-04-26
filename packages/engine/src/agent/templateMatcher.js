// ============================================================
// Template Matcher — pre-loop dispatch (Phase 5 §5.5 + §6.4)
// ============================================================
// Before the agent loop fires, every user query runs through this
// matcher. If a curated policy template matches under the §5.5 5-step
// gate, the matcher returns the template body as the final reply
// directly — no LLM call.
//
// The §5.5 gates themselves (similarity, context-pronoun, school,
// applicability, freshness) live in `rag/policyTemplate.ts:matchTemplate`.
// This module is the per-turn pre-loop wrapper that:
//   - normalizes user message into a query the matcher accepts
//   - threads `transferIntent` from the session
//   - returns a typed `PreLoopResult` so the orchestrator can decide
//     "ship the template" vs "drop into the agent loop"
// ============================================================
import { matchTemplate } from "../rag/policyTemplate.js";
/**
 * Run the template matcher against a user message. Returns:
 *   - `template` when a curated answer fires (skip the LLM)
 *   - `fallthrough` when no template fires (drop into the agent loop)
 *
 * Stateless. Pure for a given (message, templates, session, now).
 */
export function preLoopDispatch(userMessage, session, options) {
    if (!session.student) {
        return { kind: "fallthrough", reason: "no student in session" };
    }
    if (options.templates.length === 0) {
        return { kind: "fallthrough", reason: "no templates loaded" };
    }
    const match = matchTemplate(userMessage, options.templates, session.student.homeSchool, {
        transferIntent: options.transferIntent,
        now: options.now,
    });
    if (!match) {
        return { kind: "fallthrough", reason: "no template trigger matched" };
    }
    // Append the citation suffix the chat layer renders below the body.
    // Per §5.5, every curated answer surfaces its source verbatim — that's
    // the contract the bulletin gives the chat layer.
    const finalText = `${match.template.body}\n\n_— Curated policy answer (last verified ${match.template.lastVerified}; source: ${match.template.source})_`;
    return { kind: "template", match, finalText };
}
//# sourceMappingURL=templateMatcher.js.map