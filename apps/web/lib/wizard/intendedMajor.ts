// ============================================================
// intendedMajor (Phase 4 Task E5.5) — pure helpers that WIRE the
// existing Lane-B / RAG-preview + intended-major substrate (Phase 1/3)
// into the LAST wizard step. NO new requirement-model logic, NO engine
// import, NO new route — node-testable.
// ============================================================
// CONTEXT — what already exists (we only wire it in):
//   • UNDECLARED is an EXISTING engine concept: a student declares zero
//     or more programs (`StudentProfile.declaredPrograms:
//     ProgramDeclaration[]`, shared/types.ts), and the proactive
//     elicitation detector already keys off it
//     (`proactiveElicitation.ts`: `hasDeclaredProgram =
//     (declaredPrograms ?? []).length > 0`, with an `intended_major`
//     elicitation topic). `isUndeclared` below is the SAME predicate,
//     reused at the wizard edge — it reinvents nothing.
//   • The What-If arm is the EXISTING `/api/onboard` upload. A What-If /
//     "Career Simulation Report" report parses END-TO-END through the
//     same `parseDpr` (parser.ts detects the What-If header; the
//     hypothetical major's requirements + candidate courses + IP rows
//     come through — see packages/engine/tests/foundation/whatIfParse).
//     So an undeclared student can upload an Albert What-If audit for
//     their intended major and it drops straight into Lane A — the
//     wizard's existing `handleFile` already POSTs to `/api/onboard`.
//   • The RAG-preview arm is the EXISTING agent loop: `what_if_audit`
//     (pure-RAG hypothetical-program estimate, non-removable bulletin
//     disclaimer) + `search_policy`, gated behind the §11 confidence +
//     "confirm with your adviser" rail (systemPrompt.ts). We reach it by
//     INJECTING A CHAT TURN through the SAME `addMessage('user', text) →
//     handleSendV2` rail E5.4 uses — NOT a new route, NOT new logic.
//
// THE HEDGE (D4.4 — the binding contract): the preview turn is HONESTLY
// framed as a PREVIEW to VERIFY WITH THE ADVISER and NOT a confirmed /
// finalized plan, and it asks the agent to ATTACH ITS CONFIDENCE — so
// the engine's §11 confidence + adviser rail fires (especially for
// non-CAS / RAG-derived intended majors). The framing is school-AGNOSTIC
// and the major rides through VERBATIM (the general compiler handles ANY
// school's major), so the wizard invents no requirement and ships no
// unqualified plan. The grounded agent owns the actual requirement
// content; the wizard renders no fabricated requirement list.
// ============================================================

import type { ProgramDeclaration } from "@nyupath/shared";

/**
 * True when the student has declared NO program — the EXISTING engine
 * notion of "undeclared" (`proactiveElicitation.ts`'s
 * `hasDeclaredProgram = (declaredPrograms ?? []).length > 0`, negated).
 * Empty array OR absent (undefined) ⇒ undeclared. Any declared program
 * — major, minor, or concentration — ⇒ declared.
 *
 * The wizard derives the argument from the DPR/profile it already holds
 * (the parsed DPR's programs, or a wizard value); this helper adds no
 * new requirement-model logic — it only reuses the existing predicate.
 */
export function isUndeclared(declaredPrograms: ProgramDeclaration[] | undefined): boolean {
    return (declaredPrograms ?? []).length === 0;
}

/**
 * Build the chat-turn that asks the AGENT to PREVIEW an INTENDED major's
 * requirements via its grounded RAG path (`what_if_audit` /
 * `search_policy`), EXPLICITLY framed as a HEDGED preview so the D4.4
 * confidence + "verify with your adviser" rail fires.
 *
 * `intendedMajor` is passed VERBATIM to the agent's GENERIC compiler (no
 * keyword rewrite, no school assumption — the general-fixes-only §11
 * posture; this is school-agnostic, so a non-CAS NYU Shanghai / Abu
 * Dhabi major previews + hedges identically). The turn MUST say it is a
 * PREVIEW, that it is NOT a confirmed/finalized plan, to VERIFY WITH the
 * ADVISER, and to ATTACH CONFIDENCE — so the engine hedges and never
 * emits an unqualified plan. The wizard renders NO fabricated
 * requirement list; the grounded agent answers (no-invention §11).
 *
 * The React handler injects the returned turn via
 * `addMessage('user', text) → handleSendV2(text)` — EXACTLY the E5.4
 * injection pattern. NO engine import; the agent loop owns the RAG +
 * hedge.
 */
export function buildIntendedMajorPreviewTurn(intendedMajor: string): string {
    // Pass the major VERBATIM (general compiler). Frame HONESTLY as a
    // PREVIEW to verify with the adviser, NOT a confirmed plan, and ask
    // for the confidence level — every clause the D4.4 rail keys off.
    return (
        `I'm undeclared but considering majoring in "${intendedMajor}". ` +
        `Please give me a PREVIEW of what that major typically requires — ` +
        `make clear this is a PREVIEW to verify with my academic adviser, ` +
        `NOT a confirmed or finalized degree plan, and attach your confidence level.`
    );
}
