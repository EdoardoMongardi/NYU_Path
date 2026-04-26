import type { PolicyTemplate, TemplateMatchResult } from "../rag/policyTemplate.js";
import type { ToolSession } from "./tool.js";
export type PreLoopResult = {
    kind: "template";
    match: TemplateMatchResult;
    /** Reply body (template.body, with citation appended) */
    finalText: string;
} | {
    kind: "fallthrough";
    reason: string;
};
export interface PreLoopOptions {
    /** Templates registry (typically from `loadPolicyTemplates()`) */
    templates: PolicyTemplate[];
    /** Whether the user is exploring an internal transfer */
    transferIntent?: boolean;
    /** Reference date for freshness check (testing override). Defaults to now. */
    now?: Date;
}
/**
 * Run the template matcher against a user message. Returns:
 *   - `template` when a curated answer fires (skip the LLM)
 *   - `fallthrough` when no template fires (drop into the agent loop)
 *
 * Stateless. Pure for a given (message, templates, session, now).
 */
export declare function preLoopDispatch(userMessage: string, session: ToolSession, options: PreLoopOptions): PreLoopResult;
//# sourceMappingURL=templateMatcher.d.ts.map