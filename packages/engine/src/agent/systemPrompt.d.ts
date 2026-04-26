import type { StudentProfile } from "@nyupath/shared";
export interface SystemPromptOptions {
    student?: StudentProfile;
    /** Whether the user is exploring an internal transfer */
    transferIntent?: boolean;
    /** Free-form session summaries from prior turns (≤600 tokens, per §7.3) */
    sessionSummaries?: string[];
    /** Inject extra instructions for tests (test-only escape hatch) */
    appendInstructions?: string;
}
/**
 * The canonical NYU Path agent system prompt (Appendix A literal).
 *
 * Stable and deterministic for a given input — the response validator
 * relies on this prompt to reason about the model's expected behavior.
 */
export declare function buildSystemPrompt(opts?: SystemPromptOptions): string;
//# sourceMappingURL=systemPrompt.d.ts.map