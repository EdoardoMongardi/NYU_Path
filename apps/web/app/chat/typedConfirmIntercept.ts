/**
 * I3 — typed-confirm intercept helper
 *
 * A pure, side-effect-free function that decides whether a chat message
 * submitted by the student should be treated as a confirmation of the
 * currently-staged pending proposal — rather than forwarded to the agent.
 *
 * The rule is deliberately narrow:
 *   • The student's message must be a BARE confirm phrase (matched with
 *     start+end anchors so "confirm my spring courses" falls through to
 *     the agent unchanged).
 *   • A pending proposed scenario must actually be staged (otherwise "yes"
 *     in any other context routes to the agent normally).
 *
 * When both conditions hold, `handleSend` in page.tsx intercepts the
 * message and routes it to the EXISTING `handleWorkspaceConfirm(scenario)`
 * chokepoint — the same path the canvas Confirm button takes.  Because the
 * pending-mutation store is consume-once (Task I3 `db6021b`), a button-click
 * followed by a typed "confirm" (or vice-versa) commits EXACTLY ONCE.
 */

/**
 * Returns `true` when the chat message `text` should be intercepted as a
 * confirmation of a staged pending proposal.
 *
 * @param text                Raw (trimmed) chat input from the student.
 * @param hasPendingProposal  True when `planStore.getActiveScenario()?.kind
 *                            === "proposed"` and that scenario carries a
 *                            `pendingMutationId`.
 */
export function shouldInterceptAsConfirm(
    text: string,
    hasPendingProposal: boolean,
): boolean {
    if (!hasPendingProposal) return false;
    // Only intercept a BARE confirm phrase.  The anchors ensure longer
    // messages like "yes and also change spring" fall through to the agent.
    return CONFIRM_PHRASE_RE.test(text);
}

/**
 * Bare confirm phrases that the UI intercepts while a proposal is pending.
 * Matches are case-insensitive.  The anchors ensure only a standalone phrase
 * is matched — no substring matches inside a longer sentence.
 */
export const CONFIRM_PHRASE_RE =
    /^(confirm|confirm\s+it|yes|yes\s*,?\s*(do|please)\s*(that|it)?|apply(\s+it)?|do\s+it)$/i;
