import type { StudentProfile } from "@nyupath/shared";
import type { ToolInvocation } from "./agentLoop.js";
export type ViolationKind = "ungrounded_number" | "missing_invocation" | "missing_caveat";
export interface Violation {
    kind: ViolationKind;
    /** Human-readable explanation; the chat layer can surface this */
    detail: string;
    /** When `kind === "ungrounded_number"`, the offending number */
    number?: string;
    /** When `kind === "missing_caveat"`, the caveat id that's required */
    caveatId?: string;
}
export interface ValidatorVerdict {
    ok: boolean;
    violations: Violation[];
}
export interface ValidatorContext {
    /** The model's final text reply this turn */
    assistantText: string;
    /** Tool calls + their summaries from this turn */
    invocations: ToolInvocation[];
    /** Active student profile (for F-1 caveat etc.) */
    student?: StudentProfile;
    /** True when the user is exploring a transfer (changes caveat triggers) */
    transferIntent?: boolean;
}
/**
 * Returns the set of all "claim numbers" present in `text` — numbers
 * that should be grounded against tool results.
 */
declare function extractClaimNumbers(text: string): Set<string>;
export declare function validateResponse(ctx: ValidatorContext): ValidatorVerdict;
export { extractClaimNumbers };
//# sourceMappingURL=responseValidator.d.ts.map