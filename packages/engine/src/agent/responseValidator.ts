// ============================================================
// Response Validator (Phase 5 §9.1 Part 9 — LAUNCH-BLOCKING)
// ============================================================
// Three validators, all required to pass before a reply is shown to
// the user. Per architecture §12.6 design decision #5, these are NOT
// post-launch additions — Phase 6.5 cohort transitions cannot proceed
// without them passing on the cohort's eval set.
//
//   1. Grounding validator — every numerical claim in the reply must
//      appear verbatim in some tool result this turn. Catches the
//      Cardinal-Rule §2.1 violation ("synthesized GPA").
//   2. Invocation auditor — claims that REQUIRE a tool call must
//      have a corresponding tool invocation this turn. Catches the
//      Cardinal-Rule §9.1 violation ("you have a 3.5 GPA" with no
//      run_full_audit call).
//   3. Completeness checker — required caveats (F-1 visa, low-RAG
//      confidence, internal-transfer GPA, online-for-major) must be
//      present when the trigger condition is met.
//
// All three are pure (no LLM call). They consume the agent loop's
// `ToolInvocation[]` and the final `assistantText`, plus the session.
// Verdict shape:
//   { ok: true } | { ok: false, violations: Violation[] }
// ============================================================

import type { StudentProfile } from "@nyupath/shared";
import type { ToolInvocation } from "./agentLoop.js";
import { verifyBlockquoteAttribution } from "./verifiers/blockquoteAttribution.js";

export type ViolationKind =
    | "ungrounded_number"
    | "missing_invocation"
    | "missing_caveat"
    | "verbatim_drift"
    | "fabricated_attribution";

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
    /**
     * Phase 10 F4c — last user message this turn. Used by
     * `checkVerbatim` to detect topical relevance: when the verbatim's
     * keywords don't overlap with the user question AND the reply has
     * no overlapping numbers, the verbatim is irrelevant noise and the
     * validator skips it. Optional — when unset, the F4c skip is
     * conservative (treats every verbatim as topical).
     */
    userQuestion?: string;
}

// ============================================================
// Phase 10 F4 — context-awareness helpers
// ============================================================
// F4a: negation guard — skip an invocation/caveat trigger when the
// 30-char window preceding the matched phrase contains a negation
// marker. Catches "this is NOT an internal transfer" without
// becoming brittle to specific wordings.
//
// F4b: numeric-overlap layer for verbatim_drift. When the reply
// reuses any of the verbatim's numbers, treat it as a real drift
// (the agent paraphrased around the number).
//
// F4c: no-number-no-keyword skip. When the reply has neither
// numeric nor keyword overlap with the verbatim, the verbatim is
// irrelevant to this answer — skip rather than spam a noisy
// "could not fully ground" banner.

const NEGATION_WINDOW_CHARS = 30;
const NEGATION_RE = /\b(?:not|isn'?t|aren'?t|never|no longer|rather than|NOT)\b/i;

function isMatchNegated(text: string, regex: RegExp): boolean {
    const m = regex.exec(text);
    if (!m || m.index === undefined) return false;
    const window = text.slice(Math.max(0, m.index - NEGATION_WINDOW_CHARS), m.index);
    return NEGATION_RE.test(window);
}

function extractNumbers(text: string): Set<string> {
    return new Set(text.match(/\d+(?:\.\d+)?/g) ?? []);
}

function extractKeywords(text: string): Set<string> {
    return new Set(text.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? []);
}

// ============================================================
// 1. Grounding validator
// ============================================================
//
// A "numerical claim" here is any decimal or integer value of length
// ≥1, with optional decimal point. We allow:
//   - numbers that appear verbatim in any tool's summary this turn
//   - numbers that are part of a date/year (4-digit) when the year is
//     ALSO present in a tool summary or the user message
//   - dates like "March 1" written verbatim
//   - the digits 0..9 standing alone in non-numerical contexts (e.g.,
//     "step 1") — covered by the heuristic that 0..9 alone with no
//     decimal aren't flagged unless attached to a known unit (credit,
//     gpa, %).
//
// This is intentionally CONSERVATIVE: false positives are preferable
// to silent unsynthesized-number leaks. The tunables below can be
// adjusted without changing the contract.

const NUMERIC_CLAIM_RE = /\b(\d+(?:\.\d+)?)\b/g;
/** Words that, when adjacent to a number, mark it as a "claim" worth grounding */
const CLAIM_UNIT_KEYWORDS = new Set([
    "credit", "credits", "credit-hours", "credit-hour",
    "gpa", "average", "mean",
    "course", "courses",
    "rule", "rules", "requirement", "requirements",
    "semester", "semesters", "term", "terms",
    "%", "percent",
    // Date / deadline / year — when the model writes "the deadline is
    // March 1" or "by 2026", those numbers must come from a tool too.
    "deadline", "deadlines", "date", "dates", "due", "by",
    "application", "applications", "year", "years", "ay",
]);

/**
 * Returns the set of all "claim numbers" present in `text` — numbers
 * that should be grounded against tool results.
 */
function extractClaimNumbers(text: string): Set<string> {
    const claims = new Set<string>();
    const lower = text.toLowerCase();
    const matches = [...lower.matchAll(NUMERIC_CLAIM_RE)];
    for (const m of matches) {
        const n = m[1]!;
        const idx = m.index ?? 0;
        // Decimal numbers (likely GPAs/percentages) are claims regardless of context.
        if (n.includes(".")) {
            claims.add(n);
            continue;
        }
        // For integers, only flag when an explicit unit keyword is in the
        // SAME 25-char window AFTER the number. Earlier-sentence words
        // (e.g., "you have 64 credits. Step 1 is to plan") would otherwise
        // pollute the "1"'s context and produce false positives.
        const window = lower.slice(idx + n.length, idx + n.length + 25);
        const ctxWords = window.split(/[^a-z%]+/);
        const hasUnit = ctxWords.some((w) => CLAIM_UNIT_KEYWORDS.has(w));
        if (hasUnit) claims.add(n);
    }
    return claims;
}

/**
 * Check whether every claim number in `assistantText` appears verbatim
 * in at least one tool invocation's summary or args this turn.
 */
function checkGrounding(ctx: ValidatorContext): Violation[] {
    const violations: Violation[] = [];
    const claims = extractClaimNumbers(ctx.assistantText);
    if (claims.size === 0) return violations;
    const groundCorpus = ctx.invocations
        .map((inv) => `${inv.summary ?? ""} ${JSON.stringify(inv.args)}`)
        .join(" ")
        .toLowerCase();
    for (const claim of claims) {
        if (!groundCorpus.includes(claim)) {
            violations.push({
                kind: "ungrounded_number",
                number: claim,
                detail:
                    `Number "${claim}" appears in the reply but does not appear verbatim ` +
                    `in any tool result this turn. Either call the tool that returns it ` +
                    `or remove the claim.`,
            });
        }
    }
    return violations;
}

// ============================================================
// 2. Invocation auditor
// ============================================================
//
// Claims that require deterministic data (the Cardinal Rule §2.1
// trigger phrases) must be backed by an actual tool call this turn.
// We detect them by phrase + role mapping.

interface InvocationRule {
    /** Substring patterns (case-insensitive) that trigger this rule */
    triggers: RegExp[];
    /** One of these tools must have been called this turn */
    requiresAnyOf: string[];
    /** Caveat id surfaced in the violation's `detail` */
    description: string;
}

const INVOCATION_RULES: InvocationRule[] = [
    {
        triggers: [/\byour gpa is\b/i, /\bcumulative gpa is\b/i, /\byou have a \d/i],
        requiresAnyOf: ["run_full_audit"],
        description:
            "Reply states a GPA or credit count; Cardinal Rule §2.1 requires " +
            "a `run_full_audit` call. No such call was made this turn.",
    },
    {
        triggers: [/\bremaining requirements?\b/i, /\bunmet rules?\b/i, /\byou (?:still )?need to take\b/i],
        requiresAnyOf: ["run_full_audit"],
        description:
            "Reply discusses remaining requirements; this requires `run_full_audit`.",
    },
    {
        triggers: [/\bnext semester\b.+\b(take|enroll|register)\b/i, /\bplan(?:ning)? .* (?:fall|spring|summer)\b/i],
        requiresAnyOf: ["plan_semester"],
        description: "Reply makes a planning recommendation; this requires `plan_semester`.",
    },
    {
        triggers: [/\binternal[- ]transfer\b/i, /\btransfer to (?:cas|stern|tandon|tisch|steinhardt)\b/i, /\bswitch (?:my )?school\b/i],
        requiresAnyOf: ["check_transfer_eligibility"],
        description:
            "Reply discusses an internal transfer; this requires `check_transfer_eligibility`.",
    },
    {
        triggers: [/\bwhat if\b/i, /\bcompar(?:e|ing) [a-z ]+ (?:vs|to|with)\b/i, /\bif i (?:added|switched|dropped) /i],
        requiresAnyOf: ["what_if_audit"],
        description:
            "Reply runs a hypothetical comparison; this requires `what_if_audit`.",
    },
    {
        // Policy-claim invocation rule (Phase 5 reviewer P0c). Catches
        // unsourced policy assertions like "the catalog says…" or
        // "NYU requires…" that must be backed by a `search_policy` call.
        triggers: [
            /\b(?:policy|catalog|bulletin) (?:says|states|requires|notes|specifies)\b/i,
            /\b(?:nyu|the university) (?:requires|allows|prohibits|mandates)\b/i,
            /\b(?:p\/f|pass[/-]?fail|withdraw(?:al)?|residency|overload|repeat) (?:rule|policy|limit)\b/i,
            /\baccording to (?:the )?(?:policy|catalog|bulletin)\b/i,
        ],
        requiresAnyOf: ["search_policy"],
        description:
            "Reply makes a policy assertion; Cardinal Rule §2.1 requires a " +
            "`search_policy` call so the claim is sourced to the corpus.",
    },
];

function checkInvocations(ctx: ValidatorContext): Violation[] {
    const violations: Violation[] = [];
    const calledTools = new Set(ctx.invocations.map((inv) => inv.toolName));
    for (const rule of INVOCATION_RULES) {
        // Phase 10 F4a — negation guard. Skip the trigger when its
        // first match in the reply is preceded by a negation marker
        // ("not", "isn't", "never", "rather than", etc.). The agent
        // is explicitly disclaiming the topic, so requiring the
        // associated tool would be a false positive.
        const triggered = rule.triggers.some((re) => {
            if (!re.test(ctx.assistantText)) return false;
            const stateful = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
            if (isMatchNegated(ctx.assistantText, stateful)) return false;
            return true;
        });
        if (!triggered) continue;
        const satisfied = rule.requiresAnyOf.some((name) => calledTools.has(name));
        if (!satisfied) {
            violations.push({
                kind: "missing_invocation",
                detail: rule.description,
            });
        }
    }
    return violations;
}

// ============================================================
// 3. Completeness checker
// ============================================================

interface CaveatRule {
    id: string;
    /** Fires when the reply matches one of these patterns AND the trigger condition is true */
    triggerPatterns: RegExp[];
    /** Trigger must be true for the rule to fire */
    triggerCondition(ctx: ValidatorContext): boolean;
    /** Substrings the reply MUST contain when the rule fires */
    requiredSubstrings: RegExp[];
    description: string;
}

const CAVEAT_RULES: CaveatRule[] = [
    {
        id: "f1_visa",
        triggerCondition: (ctx) => ctx.student?.visaStatus === "f1",
        triggerPatterns: [
            /\b(?:credit load|semester credits|withdraw(?:al)?|part[- ]time|full[- ]time)\b/i,
            // Wave-5 finding: surface forms like "9 credits this term" + a
            // drop/leave action also implicate F-1 minimums even when the
            // canonical phrase "credit load" never appears.
            /\b\d{1,2}\s+credits\s+(?:this\s+(?:term|semester)|per\s+(?:term|semester)|next\s+(?:term|semester))\b/i,
            /\b(?:drop(?:ping)?|leave|leaving|reduce(?:d)?|reducing|enroll(?:ing|ed)?)\b[\s\S]{0,40}\b\d{1,2}\s+credits?\b/i,
        ],
        requiredSubstrings: [/\bf-?1\b/i],
        description:
            "F-1 visa caveat is required when the reply discusses credit load, " +
            "withdrawal, or part-time/full-time status (§D.2). Mention 'F-1' explicitly.",
    },
    {
        id: "internal_transfer_gpa_note",
        triggerCondition: () => true,
        triggerPatterns: [/\binternal transfer\b/i, /\btransfer (?:to|into) (?:cas|stern|tandon|tisch|steinhardt)\b/i],
        // Accept any phrasing that signals "GPA threshold is not public":
        // "not published", "aren't published", "isn't published",
        // "are not published", "do not publish", "doesn't publish".
        requiredSubstrings: [
            /\bgpa\b/i,
            /\b(?:not published|aren'?t published|isn'?t published|do(?:es)?n'?t (?:publish|disclose)|not (?:public|disclosed))\b/i,
        ],
        description:
            "Internal-transfer GPA caveat required: 'GPA thresholds for internal " +
            "transfer are not published' (§7.2 check_transfer_eligibility).",
    },
    {
        id: "low_confidence_consult_adviser",
        triggerCondition: (ctx) => {
            // Strict pattern: only fires when the search_policy summary
            // marks the result with `confidence=low|medium` OR
            // `low confidence` / `medium confidence`. The earlier
            // `.includes("low")` check produced false positives — the
            // word "low" appears in unrelated contexts (e.g.,
            // "follow", "below"), and "medium" is also brittle.
            const CONFIDENCE_RE = /\b(?:confidence\s*[:=]\s*(?:low|medium)|(?:low|medium)\s+confidence)\b/i;
            for (const inv of ctx.invocations) {
                if (inv.toolName !== "search_policy") continue;
                if (CONFIDENCE_RE.test(inv.summary ?? "")) return true;
            }
            return false;
        },
        triggerPatterns: [/.*/], // any reply
        requiredSubstrings: [/\b(?:adviser|advisor|consult)\b/i],
        description:
            "Low/medium-confidence policy lookup detected; the reply must direct " +
            "the student to consult their adviser.",
    },
];

function checkCompleteness(ctx: ValidatorContext): Violation[] {
    const violations: Violation[] = [];
    for (const rule of CAVEAT_RULES) {
        if (!rule.triggerCondition(ctx)) continue;
        // Phase 10 F4a — negation guard on the trigger pattern, same
        // mechanism as checkInvocations. A reply that says "this is
        // NOT an internal transfer" should not require the internal-
        // transfer GPA caveat.
        const replyTriggered = rule.triggerPatterns.some((re) => {
            if (!re.test(ctx.assistantText)) return false;
            const stateful = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
            if (isMatchNegated(ctx.assistantText, stateful)) return false;
            return true;
        });
        if (!replyTriggered) continue;
        const allCovered = rule.requiredSubstrings.every((re) => re.test(ctx.assistantText));
        if (!allCovered) {
            violations.push({
                kind: "missing_caveat",
                caveatId: rule.id,
                detail: rule.description,
            });
        }
    }
    return violations;
}

// ============================================================
// Top-level entry
// ============================================================

// ============================================================
// 4. Verbatim-drift validator (Phase 7-B Step 15 / §3.2 lines 192-227)
// ============================================================
// When a tool result this turn carries `verbatimText` (set by
// `outputMode: "semi_hardened"` tools — currently get_credit_caps
// + run_full_audit), the assistant reply MUST include that text
// verbatim. The validator does an exact substring match.
//
// Whitespace normalization: collapse runs of whitespace before
// comparison so the model can reflow paragraphs without breaking
// the gate, but no other transformations are allowed.
function checkVerbatim(ctx: ValidatorContext): Violation[] {
    const violations: Violation[] = [];
    const replyNorm = ctx.assistantText.replace(/\s+/g, " ").trim();
    // Phase 10 F4b/F4c — pre-compute number + keyword sets once.
    const replyNumbers = extractNumbers(replyNorm);
    const questionKeywords = ctx.userQuestion ? extractKeywords(ctx.userQuestion) : new Set<string>();
    for (const inv of ctx.invocations) {
        const v = inv.verbatimText;
        if (!v) continue;
        const verbatimNorm = v.replace(/\s+/g, " ").trim();
        if (!verbatimNorm) continue;
        if (replyNorm.includes(verbatimNorm)) continue; // satisfied — verbatim is in the reply

        // Phase 10 F4b — numeric-overlap layer.
        // If the reply reused at least one of the verbatim's numbers,
        // it's a paraphrase of the verbatim's load-bearing fact. Fire.
        // (Catches "Your GPA is 3.402" when verbatim is "Cumulative
        // GPA: 3.402" — agent kept the number but dropped attribution.)
        const verbatimNumbers = extractNumbers(verbatimNorm);
        let numOverlap = 0;
        for (const n of verbatimNumbers) if (replyNumbers.has(n)) numOverlap++;
        if (numOverlap > 0) {
            violations.push({
                kind: "verbatim_drift",
                detail:
                    `Tool "${inv.toolName}" returned verbatim text the reply must quote unchanged, ` +
                    `but the reply paraphrased it (kept the number, dropped the attribution). ` +
                    `Required text: ${verbatimNorm.slice(0, 200)}${verbatimNorm.length > 200 ? "…" : ""}`,
            });
            continue;
        }

        // Phase 10 F4c — no-number-no-keyword skip.
        // The reply doesn't share any numbers with the verbatim. If
        // the reply also doesn't share any keyword with the user's
        // question, the verbatim is irrelevant to this answer — skip
        // the violation. Cardinal Rule §2.1 (extractClaimNumbers /
        // checkGrounding) still protects against fabricated numbers
        // via the grounding validator above.
        //
        // CONSERVATIVE FALLBACK: when ctx.userQuestion is undefined
        // (legacy callers, unit tests), preserve the pre-F4c behavior
        // and FIRE. The skip only applies when the caller has
        // explicitly threaded the user's question through the
        // validator context.
        if (ctx.userQuestion === undefined) {
            violations.push({
                kind: "verbatim_drift",
                detail:
                    `Tool "${inv.toolName}" returned verbatim text the reply must quote unchanged, ` +
                    `but the reply does not contain it. Required text: ${verbatimNorm.slice(0, 200)}${verbatimNorm.length > 200 ? "…" : ""}`,
            });
            continue;
        }

        const verbatimKeywords = extractKeywords(verbatimNorm);
        let kwOverlap = 0;
        for (const t of questionKeywords) if (verbatimKeywords.has(t)) kwOverlap++;
        if (kwOverlap === 0) continue; // skip — irrelevant verbatim

        // Topical relevance present but verbatim missing → fire.
        violations.push({
            kind: "verbatim_drift",
            detail:
                `Tool "${inv.toolName}" returned verbatim text the reply must quote unchanged, ` +
                `but the reply does not contain it. Required text: ${verbatimNorm.slice(0, 200)}${verbatimNorm.length > 200 ? "…" : ""}`,
        });
    }
    return violations;
}

export function validateResponse(ctx: ValidatorContext): ValidatorVerdict {
    const violations: Violation[] = [
        ...checkGrounding(ctx),
        ...checkInvocations(ctx),
        ...checkCompleteness(ctx),
        ...checkVerbatim(ctx),
        ...checkAttribution(ctx),
    ];
    return { ok: violations.length === 0, violations };
}

// ============================================================
// 5. Attribution validator (Phase 11 Stage 1)
// ============================================================
// Catches Class E (confidently-wrong fabrication): blockquotes
// attributed to "the bulletin" / "§..." with text that does NOT
// appear in any search_policy chunk this turn. Pattern modeled on
// claude-code-leak/verificationAgent.ts:81-128 — every PASS must
// include the executed evidence; same idea here, every blockquote
// must have a supporting chunk substring.
function checkAttribution(ctx: ValidatorContext): Violation[] {
    const verdict = verifyBlockquoteAttribution(ctx.assistantText, ctx.invocations);
    if (verdict.ok) return [];
    return verdict.fabrications.map((f) => ({
        kind: "fabricated_attribution" as const,
        detail:
            `Blockquote attributed to "${f.attribution || "(unattributed)"}" was not found ` +
            `in any of the ${f.chunksSearched} search_policy result(s) this turn. ` +
            `Either re-run search_policy with a query that surfaces the source, ` +
            `or rephrase without the verbatim attribution. Quote: ${f.quote}`,
    }));
}

// Re-exports for tests
export { extractClaimNumbers };
