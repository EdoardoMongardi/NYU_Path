// ============================================================
// llmPolishPrompt — system prompt + few-shot examples for the
//                   confirm-bubble polish call (Phase 17 Task D)
// ============================================================
// Plan-action routes return a deterministic template explanation in
// 180-600ms. After the bubble appears, the page fires a fire-and-
// forget POST to `/api/plan/explain-polish` which calls Anthropic
// Haiku with this constrained system prompt to rewrite the template
// into more natural prose. The polish stream replaces the template
// text in the bubble; Confirm/Keep-as-is/Override-anyway buttons
// stay live throughout.
//
// Cardinal Rule §2.1 — no fabrication. The system prompt locks the
// model to "rephrase, do NOT add new facts; preserve every course
// code and credit number verbatim." Few-shot examples pin the
// expected behavior so a single misread doesn't drift the model
// toward inventing prerequisites or credit totals.
// ============================================================

/**
 * Constrained system prompt. Renders the template explanation more
 * naturally; never adds facts; preserves course codes + credit
 * numbers + term labels verbatim.
 *
 * The few-shot examples below are baked into this string so a single
 * Anthropic round-trip carries the full instruction surface (no
 * separate `messages` history). Keep the example count small (3) —
 * Haiku's input budget is small enough that adding a 4th would push
 * the prompt past comfortable headroom for typical templates.
 */
export const LLM_POLISH_SYSTEM_PROMPT = [
    "You rewrite plan-change explanations from a degree-planning tool.",
    "",
    "Your ONLY job is to rephrase the input explanation more naturally.",
    "",
    "STRICT RULES:",
    "1. Preserve every course code (e.g. CSCI-UA 101, MATH-UA 343) verbatim.",
    "2. Preserve every credit number (e.g. 4cr, 16 credits) verbatim.",
    "3. Preserve every term label (e.g. Fall 2026, 2027-spring) verbatim.",
    "4. Do NOT add new facts, prerequisites, claims, or speculation.",
    "5. Do NOT remove information present in the input.",
    "6. Output 1-3 sentences of plain English. No markdown, no lists.",
    "7. Do NOT mention 'the input' or that you are rephrasing — just give the rephrased explanation.",
    "",
    "EXAMPLES:",
    "",
    "Input:  Pinning MATH-UA 343 to Spring 2027 would: (1) move it out of Fall 2026, dropping that semester from 28 → 24cr (still over the 18-cap — F-1 floor unaffected). (2) Bump Spring 2027 from 16 → 20cr (within cap).",
    "Output: Pinning MATH-UA 343 to Spring 2027 moves it out of Fall 2026, dropping that term from 28 to 24cr (still over the 18-cap, F-1 floor unaffected) and pushing Spring 2027 from 16 to 20cr — comfortably within the cap.",
    "",
    "Input:  Adding CSCI-UA 480 to Fall 2026 raises the term from 16 → 20cr (within cap). No prereq issues.",
    "Output: Adding CSCI-UA 480 to Fall 2026 raises the term from 16 to 20cr — within the cap — and runs into no prerequisite issues.",
    "",
    "Input:  Dropping MATH-UA 343 from Fall 2026 leaves 24cr in that term and adds an unmet major requirement (Linear Algebra).",
    "Output: Dropping MATH-UA 343 from Fall 2026 leaves the term at 24cr but exposes an unmet major requirement (Linear Algebra) you'd need to backfill elsewhere.",
].join("\n");

/**
 * Build the Anthropic user message that feeds the system prompt above.
 * Receives the deterministic template + an optional structuredDiff
 * (passed through as JSON-stringified context the model is allowed
 * to read but NOT to expand on with new facts).
 */
export function buildPolishUserMessage(args: {
    templateText: string;
    structuredDiffJson?: string;
}): string {
    const lines: string[] = [];
    lines.push("Rephrase this plan-change explanation:");
    lines.push("");
    lines.push(args.templateText);
    if (args.structuredDiffJson) {
        lines.push("");
        lines.push(
            "Reference structured diff (DO NOT add facts beyond what is already present in the explanation above; this JSON is provided only so you can disambiguate phrasing):",
        );
        lines.push(args.structuredDiffJson);
    }
    return lines.join("\n");
}

/**
 * Token budget constants. The polish call is short by design — the
 * deterministic template typically lands in 1-2 sentences; the polish
 * is intentionally constrained to 1-3 sentences. A small budget keeps
 * latency low (Haiku stream completes in <1s for sub-200-token
 * outputs).
 */
export const LLM_POLISH_MAX_TOKENS = 320;

/**
 * The model identifier the polish route requests. Pinned to a
 * concrete Anthropic Haiku snapshot so a future model bump doesn't
 * silently change the polish behavior. Keep in sync with the engine's
 * model selection guide (`docs/MODEL_SELECTION.md`).
 */
export const LLM_POLISH_MODEL_ID = "claude-haiku-4-5-20251001";
