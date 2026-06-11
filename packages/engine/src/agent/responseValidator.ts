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

import type { StudentProfile, ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import type { ToolInvocation } from "./agentLoop.js";
import { verifyBlockquoteAttribution } from "./verifiers/blockquoteAttribution.js";
import { psTermToSolverTerm } from "./forwardSchedule/termLabel.js";

export type ViolationKind =
    | "ungrounded_number"
    | "missing_invocation"
    | "missing_caveat"
    | "verbatim_drift"
    | "fabricated_attribution"
    | "identity_drift"
    | "quantitative_shortfall"
    | "ungrounded_plan_claim";

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
    /**
     * D5.1 — the stored forward plan for this session. When present,
     * `checkPlanClaims` diffs the reply's course-placement / graduation-
     * term / lock-status claims against it and blocks ungrounded ones.
     * Populated by the route (task D5.2); the check NO-OPS when absent.
     */
    forwardSchedule?: ForwardSchedule;
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
 * Returns all numbers present in `text`, including negative.
 */
function extractAllNumbers(text: string): string[] {
    const matches = text.match(/-?\d+(?:\.\d+)?/g);
    return matches ?? [];
}

// ============================================================
// Phase D — Tier-2 estimate detection
// ============================================================
// Tier-2 tools answer from confidence-scored bulletin retrieval, not
// the authoritative DPR. When one of them returns a non-high-confidence
// (or explicitly "estimate") result this turn, the reply is allowed to
// ship a *labeled, hedged, adviser-caveated estimate* — see the
// grounding exemption in `checkGrounding` and the consult-adviser caveat
// rule. Tier-1 (DPR) answers stay hard-grounded.

/** Tools whose output is a Tier-2 (bulletin-cited, confidence-scored)
 *  estimate rather than an authoritative DPR audit. */
const TIER2_ESTIMATE_TOOLS = new Set([
    "search_policy",
    "get_program_requirements",
    "what_if_audit",
]);

/** Markers a Tier-2 tool's summary carries when its result is a
 *  non-high-confidence / estimate answer. */
const TIER2_LOW_CONF_RE =
    /\b(?:confidence\s*[:=]\s*(?:low|medium|uncertain)|(?:low|medium)\s+confidence|POLICY UNCERTAINTY)\b|\(estimate/i;

/** True when a Tier-2 estimate tool returned a non-high-confidence /
 *  estimate result this turn. Drives both the grounding exemption and
 *  the consult-adviser caveat. */
function tier2EstimateInvoked(ctx: ValidatorContext): boolean {
    return ctx.invocations.some(
        (inv) => TIER2_ESTIMATE_TOOLS.has(inv.toolName) && TIER2_LOW_CONF_RE.test(inv.summary ?? ""),
    );
}

/** Hedge words that, immediately before a number, mark it as an explicit
 *  estimate ("about 5 requirements", "~3 semesters", "roughly 18 credits"). */
const HEDGE_BEFORE_RE = /(?:\babout|\bapproximately|\broughly|\baround|\bestimated?|\bballpark|\bon the order of|~)\s*$/i;

/** True when `num` appears in `text` immediately preceded by hedge
 *  language at least once, at a standalone numeric boundary. */
function isHedgedEstimate(text: string, num: string): boolean {
    const lower = text.toLowerCase();
    let from = 0;
    for (;;) {
        const idx = lower.indexOf(num, from);
        if (idx < 0) return false;
        const before = idx > 0 ? lower[idx - 1] : undefined;
        const after = lower[idx + num.length];
        const standalone =
            (before === undefined || !/[0-9.]/.test(before)) &&
            (after === undefined || !/[0-9.]/.test(after));
        if (standalone) {
            const pre = lower.slice(Math.max(0, idx - 20), idx);
            if (HEDGE_BEFORE_RE.test(pre)) return true;
        }
        from = idx + num.length;
    }
}

/**
 * Check whether every claim number in `assistantText` appears verbatim
 * in at least one tool invocation's summary or args this turn.
 *
 * Phase 13 §8a — extend the allow-set so a claim is grounded if it
 * appears verbatim OR equals a ± b for any pair of grounded numbers
 * (tool summaries + user question). Catches "total is 16 (12 already
 * + 4 planned)" without allowing arbitrary hallucinated numbers.
 */
function checkGrounding(ctx: ValidatorContext): Violation[] {
    const violations: Violation[] = [];
    const claims = extractClaimNumbers(ctx.assistantText);
    if (claims.size === 0) return violations;

    // Phase 12.5 Task 2 — numbers the user typed in their question are
    // legitimately groundable by the agent's reply (e.g. "16 credits"
    // echoed back in a clarifying question). Without this, the
    // grounding rule false-positives on every quote-back of a user
    // quantity.
    const sources = [
        ...ctx.invocations.map((inv) => `${inv.summary ?? ""} ${JSON.stringify(inv.args)}`),
        ctx.userQuestion ?? "",
    ];
    const groundCorpus = sources.join(" ").toLowerCase();

    // Phase 13 §8a — collect all groundable numbers (tool results +
    // user question). A claim is grounded if it appears verbatim OR
    // if it equals a ± b for some pair of grounded numbers.
    const groundedNumbers = new Set<number>();
    for (const s of sources) {
        for (const n of extractAllNumbers(s)) {
            const parsed = parseFloat(n);
            if (Number.isFinite(parsed)) groundedNumbers.add(parsed);
        }
    }
    const numbersArr = [...groundedNumbers];

    function isDerivable(claim: string): boolean {
        if (groundCorpus.includes(claim)) return true;
        const claimVal = parseFloat(claim);
        if (!Number.isFinite(claimVal)) return false;
        // Use an epsilon comparison rather than strict equality. The
        // motivating integer cases (12 + 4 = 16) work either way, but
        // strict === fails for decimal arithmetic — `0.1 + 0.2 !== 0.3`
        // in IEEE-754, which would falsely flag GPA-change claims like
        // "your GPA rises by 0.3 (was 3.1, now 3.4)" as ungrounded.
        const EPS = 1e-9;
        for (let i = 0; i < numbersArr.length; i++) {
            for (let j = 0; j < numbersArr.length; j++) {
                if (Math.abs(numbersArr[i]! + numbersArr[j]! - claimVal) < EPS) return true;
                if (Math.abs(numbersArr[i]! - numbersArr[j]! - claimVal) < EPS) return true;
            }
        }
        return false;
    }

    // Phase D — when a Tier-2 estimate tool returned a non-high-confidence
    // result this turn, the reply may ship an explicitly-hedged INTEGER
    // estimate ("about 5 requirements", "~3 semesters") that the agent
    // reasoned from the cited bulletin text but that isn't verbatim in
    // the tool summary. Such a number is exempt from the hard grounding
    // rule. Guard rails keep Tier-1 intact:
    //   - decimals (GPAs, percentages) are NEVER exempt;
    //   - the number must be explicitly hedged as an estimate;
    //   - a Tier-2 estimate tool must have actually run this turn.
    // The mandatory consult-adviser caveat (checkCompleteness) interlocks:
    // an exempt estimate that ISN'T adviser-caveated still fails the
    // completeness check. So an ungroundable number can only ship when
    // it is hedged AND cited AND adviser-caveated — the Tier-2 contract.
    const tier2 = tier2EstimateInvoked(ctx);

    for (const claim of claims) {
        if (isDerivable(claim)) continue;
        if (tier2 && !claim.includes(".") && isHedgedEstimate(ctx.assistantText, claim)) {
            continue; // labeled Tier-2 estimate — allowed
        }
        violations.push({
            kind: "ungrounded_number",
            number: claim,
            detail:
                `Number "${claim}" appears in the reply but does not appear verbatim ` +
                `in any tool result this turn, nor is it a sum or difference of two ` +
                `grounded numbers. Either call the tool that returns it or remove the claim.`,
        });
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
        // Planning recommendation trigger. The legacy `plan_semester` was
        // removed (Phase F decommission); `plan_forward_degree` (Phase 13)
        // is the canonical entry point and `view_forward_plan` its
        // read-back companion. Both satisfy the gate because they produce
        // term-level recommendations grounded in the audit.
        triggers: [/\bnext semester\b.+\b(take|enroll|register)\b/i, /\bplan(?:ning)? .* (?:fall|spring|summer)\b/i],
        requiresAnyOf: ["plan_forward_degree", "view_forward_plan"],
        description: "Reply makes a planning recommendation; this requires `plan_forward_degree` (or `view_forward_plan` if the plan was built earlier this session).",
    },
    {
        // Internal-transfer claims must be grounded in a bulletin
        // retrieval. The authored `check_transfer_eligibility` tool was
        // removed (pure-RAG decommission); `search_policy` over the
        // internal-transfer pages is now the grounding source.
        triggers: [/\binternal[- ]transfer\b/i, /\btransfer to (?:cas|stern|tandon|tisch|steinhardt)\b/i, /\bswitch (?:my )?school\b/i],
        requiresAnyOf: ["search_policy"],
        description:
            "Reply discusses an internal transfer; this requires `search_policy` (over the bulletin's internal-transfer pages).",
    },
    {
        // Hypothetical / what-if trigger. `propose_plan_change` (Phase 14)
        // also satisfies this rule because it models a counterfactual
        // change against the existing forward plan and surfaces a
        // structured impact diff — same intent as `what_if_audit`,
        // different return shape. `simulate_alternatives` (Phase 14)
        // covers the multi-alternative case.
        triggers: [/\bwhat if\b/i, /\bcompar(?:e|ing) [a-z ]+ (?:vs|to|with)\b/i, /\bif i (?:added|switched|dropped) /i],
        requiresAnyOf: ["what_if_audit", "propose_plan_change", "simulate_alternatives"],
        description:
            "Reply runs a hypothetical comparison; this requires `what_if_audit`, `propose_plan_change`, or `simulate_alternatives`.",
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
            "transfer are not published' (from the internal-transfer bulletin pages via search_policy).",
    },
    {
        id: "low_confidence_consult_adviser",
        // Phase D — fires when ANY Tier-2 estimate tool (search_policy,
        // get_program_requirements, what_if_audit) returned a
        // non-high-confidence / estimate result this turn, not just
        // search_policy. The reply must then direct
        // the student to consult their adviser. This is also the
        // interlock for the grounding exemption: a hedged Tier-2 estimate
        // that skips the grounding rule still has to carry this caveat.
        triggerCondition: (ctx) => tier2EstimateInvoked(ctx),
        triggerPatterns: [/.*/], // any reply
        requiredSubstrings: [/\b(?:adviser|advisor|consult)\b/i],
        description:
            "Low/medium-confidence (Tier-2 estimate) lookup detected; the reply must " +
            "direct the student to consult their adviser.",
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
    // Phase 11 follow-up — case-insensitive substring match. The agent
    // legitimately rephrases capitalization ("your cumulative GPA" vs
    // verbatim "Cumulative GPA") and that is NOT drift. Generic
    // across every verbatim-emitting tool.
    const replyNormLower = replyNorm.toLowerCase();
    // Phase 10 F4b/F4c — pre-compute number + keyword sets once.
    const replyNumbers = extractNumbers(replyNorm);
    const questionKeywords = ctx.userQuestion ? extractKeywords(ctx.userQuestion) : new Set<string>();
    for (const inv of ctx.invocations) {
        const v = inv.verbatimText;
        if (!v) continue;
        const verbatimNorm = v.replace(/\s+/g, " ").trim();
        if (!verbatimNorm) continue;
        if (replyNormLower.includes(verbatimNorm.toLowerCase())) continue; // satisfied (case-insensitive)

        // Phase 10 F4b — numeric-overlap layer.
        // If the reply reused at least one of the verbatim's numbers
        // AND did NOT attribute that number to a tool/source, treat as
        // drift. Phase 11 follow-up — added the attribution gate so
        // attributed paraphrases ("Your cumulative GPA: 3.402 (per
        // your DPR)") don't fire. Generic across every numeric
        // verbatim because we only check for the presence of an
        // attribution noun within ~50 chars of the matched number,
        // not a specific phrase.
        const verbatimNumbers = extractNumbers(verbatimNorm);
        const ATTRIBUTION_NOUN_RE = /\b(?:dpr|degree progress report|audit|transcript|albert|registrar|bulletin|tool|gpa(?:\s+breakdown)?)\b/i;
        let numOverlap = 0;
        let attributedNearAll = true;
        for (const n of verbatimNumbers) {
            if (!replyNumbers.has(n)) continue;
            numOverlap++;
            // Locate the number in the reply and check a 60-char
            // window around it for an attribution noun.
            const idx = replyNorm.indexOf(n);
            if (idx === -1) { attributedNearAll = false; continue; }
            const window = replyNorm.slice(Math.max(0, idx - 60), Math.min(replyNorm.length, idx + n.length + 60));
            if (!ATTRIBUTION_NOUN_RE.test(window)) attributedNearAll = false;
        }
        if (numOverlap > 0 && !attributedNearAll) {
            violations.push({
                kind: "verbatim_drift",
                detail:
                    `Tool "${inv.toolName}" returned verbatim text the reply must quote unchanged, ` +
                    `but the reply paraphrased it (kept the number without attributing it to the source). ` +
                    `Required text: ${verbatimNorm.slice(0, 200)}${verbatimNorm.length > 200 ? "…" : ""}`,
            });
            continue;
        }
        if (numOverlap > 0 && attributedNearAll) {
            // Reused the number AND attributed it nearby — treat as
            // satisfied without firing the drift violation.
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

// ============================================================
// 6. Identity-drift validator (Phase 12 §6)
// ============================================================
// Catches structural output bugs where the agent refers to itself
// as a contactable third party. The agent IS the assistant — there
// is no separate entity for the user to "call", "email", or
// "reply to". This is a generic structural-coherence check, not a
// per-case keyword blacklist: it matches the first-person-imperative
// + contact-verb + trailing-pronoun pattern (me/us only), which is
// the precise structural signal of identity drift.

/**
 * Catches identity-drift output bugs where the agent refers to
 * itself in the third person as a contactable entity. The agent
 * IS the assistant — phrasings like "call me", "email me", "reply
 * to me" mistakenly cast it as a separate person the user should
 * contact. Phase 12 §6 — generic structural-coherence check, not
 * a keyword blacklist (matches first-person-imperative + third-
 * party-contact-verb structural pattern).
 */
function checkIdentityDrift(assistantText: string): Violation[] {
    const violations: Violation[] = [];
    // The agent should never instruct the user to "call me" /
    // "email me" / "reply to me" / "message me" / "contact me".
    // The trailing pronoun must be "me" or "us" — NOT a third party
    // (so "call OGS" / "email your adviser" pass through).
    // Two-branch alternation: the simple contact verbs take an optional
    // "back"/"to" modifier between the verb and the pronoun; "reply" is
    // handled separately because it already embeds those modifiers in the
    // verb phrase ("reply back to me") before the pronoun.
    const PATTERN = /\b(?:call|email|message|contact|text|reach)\s+(?:back\s+)?(?:to\s+)?(?:me|us)\b|\breply\s+(?:back\s+)?(?:to\s+)?(?:me|us)\b/i;
    const match = PATTERN.exec(assistantText);
    if (match) {
        violations.push({
            kind: "identity_drift",
            detail:
                `Identity drift: assistant referred to itself as a contactable third party ` +
                `with the phrase "${match[0]}". The agent is the assistant — there is nothing ` +
                `for the user to "contact". Rephrase as a direct first-person commitment ` +
                `("I'll suggest electives in the next message") or as a concrete tool the ` +
                `user can take action on.`,
        });
    }
    return violations;
}

// ============================================================
// 7. Quantitative-shortfall validator (Phase 12.5 §1)
// ============================================================
// Catches "asked for N <unit>, delivered M < N <unit>, punted to user"
// patterns. Generic structural rule: extracts (number, unit) pairs from
// userQuestion, finds the same unit in assistantText, compares
// quantities. If assistantText already acknowledges the shortfall (via
// one of the SHORTFALL_ACKNOWLEDGEMENTS phrases), the rule passes — the
// agent did its job by being explicit about the gap.

const SHORTFALL_ACKNOWLEDGEMENTS = [
    /could not fill/i,
    /below the requested/i,
    /short of the requested/i,
    /f-?1 floor/i,
    /credit ceiling/i,
    /less than (?:the )?requested/i,
    /unable to (?:fill|reach) the (?:requested )?(?:target|amount)/i,
];

/**
 * Catches "asked for N <unit>, delivered M < N <unit>, punted to user"
 * patterns. Generic structural rule: extracts (number, unit) pairs from
 * userQuestion, finds the same unit in assistantText, compares
 * quantities. If assistantText already acknowledges the shortfall (via
 * one of the SHORTFALL_ACKNOWLEDGEMENTS phrases), the rule passes — the
 * agent did its job by being explicit about the gap.
 *
 * Phase 12.5 §1 — generic across all unit-keyword + quantity asks; not
 * a per-case keyword rule.
 */
function checkQuantitativeShortfall(userQuestion: string | undefined, assistantText: string): Violation[] {
    if (!userQuestion) return [];

    // Extract (number, unit) pairs from the user's question. Pattern:
    // a number followed by an optional adjective then a unit-keyword.
    // E.g. "16 credits", "5 electives", "courses of 16 credits in total".
    const requested: Array<{ count: number; unit: string }> = [];
    const REQ_RE = /\b(\d+)\s+(?:[a-z]+\s+)?(credits?|courses?|electives?|units?|classes)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = REQ_RE.exec(userQuestion)) !== null) {
        requested.push({ count: parseInt(m[1]!, 10), unit: m[2]!.toLowerCase().replace(/s$/, "") });
    }
    if (requested.length === 0) return [];

    // Did the assistant acknowledge a shortfall? If so, no violation —
    // the agent already explained the gap.
    const acknowledged = SHORTFALL_ACKNOWLEDGEMENTS.some(re => re.test(assistantText));
    if (acknowledged) return [];

    // For each requested (count, unit), find the highest delivered
    // count for the same unit in the assistant text. If highest < count,
    // fire the violation.
    const violations: Violation[] = [];
    for (const req of requested) {
        // Use the singular-or-plural form of the unit key.
        const DELIV_RE = new RegExp(`\\b(\\d+)\\s+${req.unit}s?\\b`, "gi");
        let highest = 0;
        let mm: RegExpExecArray | null;
        while ((mm = DELIV_RE.exec(assistantText)) !== null) {
            const delivered = parseInt(mm[1]!, 10);
            if (delivered > highest) highest = delivered;
        }
        if (highest > 0 && highest < req.count) {
            violations.push({
                kind: "quantitative_shortfall",
                detail:
                    `User requested ${req.count} ${req.unit}${req.count === 1 ? "" : "s"}; ` +
                    `assistant delivered ${highest}. Either deliver the full request, or explicitly ` +
                    `acknowledge the shortfall ("could not fill", "below the requested ${req.count}", etc.) ` +
                    `and explain why. Do not punt with a clarifying question after a partial delivery.`,
            });
        }
    }
    return violations;
}

// ============================================================
// 8. Plan-claim validator (D5.1 — LAUNCH-BLOCKING)
// ============================================================
// Exit criterion: "ungrounded plan claims blocked." A PURE, no-LLM,
// deterministic diff of the reply's prose against the stored forward
// plan (`ctx.forwardSchedule`). It blocks three classes of ungrounded
// Tier-1 (engine-grounded) plan claim:
//
//   - course-placement: "CSCI-UA 102 is in Fall 2027" that disagrees
//     with where the stored plan places the course (or places a course
//     the plan doesn't place at all);
//   - graduation-term: "you graduate Spring 2028" that disagrees with
//     forwardSchedule.graduationTerm;
//   - lock-status: "CSCI-UA 102 is locked/final" vs "you can still move
//     it" that disagrees with the stored slot's mutability.
//
// Plan claims are Tier-1 — there is NO hedging exemption (opposite the
// Tier-2 estimate exemption in checkGrounding). "Verify with your
// adviser" does NOT excuse an ungrounded placement/grad-term claim.
//
// PURITY / NO-OP: the check returns [] when ctx.forwardSchedule is
// absent — it never invents a plan to diff against.
//
// COUNTERFACTUAL CARVE-OUT (collision with D2 probes): a placement or
// grad-term claim syntactically marked as a probe result / hypothetical
// ("if you failed CSCI-UA 101, you'd graduate Spring 2029", "what if…",
// "suppose…") describes a RE-SOLVED what-if schedule that intentionally
// differs from the stored plan and MUST NOT be flagged. See
// CONDITIONAL_FRAME_RE.

/** Course-id grammar — mirrors buildSolverInput.ts COURSE_ID_RE
 *  ("CSCI-UA 102", "MATH-UA 121"). Global so we can iterate matches. */
const PLAN_COURSE_ID_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{1,4}[A-Z]?)\b/g;

/** Human term label as it appears in prose ("Fall 2027" / "2027 Fall" /
 *  the canonical "2027-fall"). Normalized via psTermToSolverTerm before
 *  any comparison — never raw-string-compared. */
const PLAN_TERM_LABEL_RE =
    /\b(?:(?:Fall|Spring|Summer|January|J[- ]?Term)\s+\d{4}|\d{4}\s+(?:Fall|Spring|Summer|January|J[- ]?Term)|\d{4}-(?:fall|spring|summer|january))\b/gi;

/** Conditional / hypothetical frame markers. When a claim's enclosing
 *  clause carries one of these, the claim describes a counterfactual
 *  re-solve and is SKIPPED. Documented markers: if / would / hypothetical
 *  / what if / suppose / were you to.
 *
 *  KNOWN-LIMIT carve-out: the benign trailing politeness idioms
 *  "if you'd like / if you want / if you prefer / if you'd prefer" are
 *  NOT counterfactual frames — they offer the student a real change to
 *  the CURRENT plan, so a lock-status/placement claim in such a clause
 *  must still be checked. We strip those idioms before testing for a
 *  frame marker so their embedded "if"/"'d" don't suppress the claim. */
const BENIGN_CONDITIONAL_IDIOM_RE = /\bif\s+you(?:'?d|\s+would)?\s+(?:like|want|prefer|wish|choose)\b/gi;
const CONDITIONAL_FRAME_RE = /\b(?:if|would|hypothetical(?:ly)?|what\s+if|suppose|were\s+you\s+to)\b/i;

/** True when the clause is framed as a counterfactual / hypothetical
 *  (after stripping benign politeness idioms). */
function isConditionalFrame(clause: string): boolean {
    return CONDITIONAL_FRAME_RE.test(clause.replace(BENIGN_CONDITIONAL_IDIOM_RE, " "));
}

/** Char window each side of a course code in which we look for a
 *  co-occurring term label (same clause / bounded window). Kept tight so
 *  "CSCI-UA 102 … <unrelated sentence> … Fall 2027" doesn't bind. */
const PLAN_COOCCUR_WINDOW = 60;

/** Lock-asserting language ("locked", "final", "can't change", "fixed",
 *  "set in stone"). */
const LOCK_ASSERT_RE = /\b(?:locked|final(?:ized)?|can'?t (?:be )?(?:change|move)|cannot (?:be )?(?:change|move)|set in stone|fixed in place|already taken)\b/i;
/** Movable-asserting language ("you can still move", "movable",
 *  "can change it", "not locked", "flexible"). */
const MOVABLE_ASSERT_RE = /\b(?:can (?:still )?(?:move|change|swap)|movable|moveable|not locked|isn'?t locked|flexible|reschedul)\b/i;

/**
 * Split `text` into the smallest enclosing clause around char index
 * `idx` (between sentence/clause delimiters). Used to test whether a
 * claim sits inside a conditional/hypothetical frame, and to scope the
 * lock-status assertion search to the course's own clause.
 */
function clauseAround(text: string, idx: number): string {
    // Clause delimiters: sentence terminators + semicolons. Conditional
    // markers ("if …, …") often span a comma, so we DON'T split on commas
    // — a leading "If you failed X, you'd graduate Y" must stay one clause
    // so the carve-out catches the consequent too.
    const [start, end] = clauseBounds(text, idx);
    return text.slice(start, end);
}

/** Absolute [start, end) bounds of the clause enclosing `idx` — same
 *  delimiters as clauseAround (sentence terminators + semicolons, NOT
 *  commas), but returns offsets in `text` so callers can reason about
 *  which course code / term label sits between two positions. */
function clauseBounds(text: string, idx: number): [number, number] {
    const before = text.slice(0, idx);
    const after = text.slice(idx);
    const startM = before.search(/[.!?;][^.!?;]*$/);
    const start = startM === -1 ? 0 : startM + 1;
    const endRel = after.search(/[.!?;]/);
    const end = endRel === -1 ? text.length : idx + endRel;
    return [start, end];
}

/** Absolute char offsets of every course-code match in `text`. Used to
 *  enforce "nearest course code wins": a term label only binds to a
 *  course if no OTHER course code sits between them. */
function courseCodeOffsets(text: string): number[] {
    PLAN_COURSE_ID_RE.lastIndex = 0;
    return [...text.matchAll(PLAN_COURSE_ID_RE)].map((m) => m.index ?? 0);
}

/** Absolute [start, end) spans of every course-code match in `text`. */
function courseCodeSpans(text: string): Array<[number, number]> {
    PLAN_COURSE_ID_RE.lastIndex = 0;
    return [...text.matchAll(PLAN_COURSE_ID_RE)].map((m) => {
        const s = m.index ?? 0;
        return [s, s + m[0].length] as [number, number];
    });
}

/**
 * Resolve the term labels that legitimately bind to the course code at
 * `courseIdx` (length `courseLen`). A label binds only when:
 *   (1) it sits inside the course code's own CLAUSE (no cross-sentence
 *       / cross-semicolon bleed — fixes C3), AND
 *   (2) within the bounded co-occurrence window, AND
 *   (3) NO OTHER course code sits strictly between the course code and
 *       that label ("nearest course code wins" — fixes C1/C2: a
 *       neighbor course's term can't bind to this one).
 * Returns the normalized solver terms (unresolvable labels dropped — we
 * never block on a guess).
 */
function termsBoundToCourse(text: string, courseIdx: number, courseLen: number): string[] {
    const [clauseStart, clauseEnd] = clauseBounds(text, courseIdx);
    const windowStart = Math.max(clauseStart, courseIdx - PLAN_COOCCUR_WINDOW);
    const windowEnd = Math.min(clauseEnd, courseIdx + courseLen + PLAN_COOCCUR_WINDOW);
    const courseEnd = courseIdx + courseLen;
    // Other course codes anywhere in the text — used to gate each label.
    const otherCourses = courseCodeOffsets(text).filter((o) => o !== courseIdx);

    const out: string[] = [];
    PLAN_TERM_LABEL_RE.lastIndex = 0;
    for (const tm of text.matchAll(PLAN_TERM_LABEL_RE)) {
        const labelStart = tm.index ?? 0;
        const labelEnd = labelStart + tm[0].length;
        // Must overlap the bounded window in this course's clause.
        if (labelEnd <= windowStart || labelStart >= windowEnd) continue;
        // Nearest-course-wins: reject if another course code sits between
        // this course code and the label (either side).
        const lo = Math.min(courseEnd, labelStart);
        const hi = Math.max(courseIdx, labelEnd);
        const intervening = otherCourses.some((o) => o >= lo && o < hi);
        if (intervening) continue;
        const solver = psTermToSolverTerm(tm[0]);
        if (solver !== null) out.push(solver);
    }
    return out;
}

/** True when a lock/movable assertion matched by `re` is attributable to
 *  the course code at [courseIdx, courseEnd) — i.e. somewhere inside that
 *  course's CLAUSE there's an assertion match whose position is closer to
 *  THIS course code than to any OTHER course code. So "X is final, and Y
 *  can still move" attributes "final" to X (nearest) and "can still move"
 *  to Y (nearest), instead of testing both regexes against the whole
 *  comma-spanning clause (fixes C5). Distance is to the nearest edge of
 *  the course-code span, so a leading "…final, and CSCI-UA Y" doesn't
 *  drag Y's keyword onto X. */
function assertionAttributedToCourse(
    text: string,
    re: RegExp,
    courseIdx: number,
    courseEnd: number,
): boolean {
    const [clauseStart, clauseEnd] = clauseBounds(text, courseIdx);
    const clause = text.slice(clauseStart, clauseEnd);
    const spans = courseCodeSpans(text).filter(([s]) => s >= clauseStart && s < clauseEnd);
    const distTo = (pos: number, s: number, e: number): number =>
        pos < s ? s - pos : pos >= e ? pos - e + 1 : 0;
    const scan = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const am of clause.matchAll(scan)) {
        const pos = clauseStart + (am.index ?? 0);
        const mine = distTo(pos, courseIdx, courseEnd);
        // Nearest course wins: this match belongs to us only if no OTHER
        // course code is strictly closer to it.
        const nearer = spans.some(
            ([s, e]) => s !== courseIdx && distTo(pos, s, e) < mine,
        );
        if (!nearer) return true;
    }
    return false;
}

/** True when a term label (in [labelStart, labelEnd)) is attributable to
 *  the "graduat…" token at `gradIdx`: adjacent to or following it within
 *  the same clause, with no intervening course code (a placement term in
 *  a graduate clause is NOT a graduation claim — fixes C4). */
function labelAttributableToGrad(
    text: string,
    gradIdx: number,
    labelStart: number,
    labelEnd: number,
    courseOffsets: number[],
): boolean {
    // The label must sit AFTER the "graduat…" token (English: "graduate
    // <term>"), not before some unrelated earlier mention.
    if (labelStart < gradIdx) return false;
    // No course code may sit between "graduat…" and the term label — if
    // one does, the term attaches to the course (placement), not grad.
    const intervening = courseOffsets.some((o) => o > gradIdx && o < labelEnd);
    if (intervening) return false;
    return true;
}

/** All course → canonical-term placements in the stored plan that carry
 *  a courseId (completed / in_progress / specific_planned). Placeholder
 *  slots have no courseId and are unresolvable, so they're excluded. */
interface StoredPlacement {
    canonTerm: string;        // "2027-fall"
    kind: ScheduleSlot["kind"];
    semesterLocked: boolean;
}
function indexPlan(schedule: ForwardSchedule): Map<string, StoredPlacement[]> {
    const byCourse = new Map<string, StoredPlacement[]>();
    for (const sem of schedule.semesters) {
        const canonTerm = psTermToSolverTerm(sem.term) ?? sem.term.toLowerCase();
        for (const slot of sem.slots) {
            if (slot.kind === "placeholder") continue; // no courseId
            const id = slot.courseId.toUpperCase();
            const list = byCourse.get(id) ?? [];
            list.push({ canonTerm, kind: slot.kind, semesterLocked: sem.locked });
            byCourse.set(id, list);
        }
    }
    return byCourse;
}

/** True when the stored slot is effectively immutable (taken / fixed in
 *  term / in a locked semester). specific_planned & placeholder are
 *  movable UNLESS their semester is locked. */
function isStoredLocked(p: StoredPlacement): boolean {
    if (p.kind === "completed" || p.kind === "in_progress") return true;
    return p.semesterLocked;
}

/**
 * D5.1 — diff the reply against the stored plan. PURE / deterministic /
 * no-LLM. Known limits (STATED): we only resolve a course-placement
 * claim when a recognizable term label (PLAN_TERM_LABEL_RE) co-occurs
 * within PLAN_COOCCUR_WINDOW chars of an explicit course code. Paraphrases
 * with no deterministic term label ("next fall", "the following term")
 * are OUT OF SCOPE and produce NO violation — we never block on a guess.
 *
 * Attribution is NEAREST-COURSE-SCOPED to avoid cross-clause / cross-course
 * term-bleed (the worst failure for a launch gate: false-blocking a TRUE
 * reply). Specifically:
 *   - PLACEMENT: a term label binds to a course only inside that course's
 *     own clause (no sentence-boundary bleed) AND only when no OTHER course
 *     code sits between the code and the label ("nearest course wins"), so a
 *     neighbor's term ("…102 requires 101 in Fall 2025") or a prior-sentence
 *     grad term doesn't bind to this course (see termsBoundToCourse).
 *   - LOCK STATUS: a lock/movable assertion is attributed to the nearest
 *     course code by keyword position, so "X is final, and Y can still move"
 *     resolves each course independently (see assertionAttributedToCourse).
 *   - GRADUATION: a term only counts as a grad claim when it follows the
 *     "graduat…" token with no course code between them AND does not
 *     co-occur with a course code (a placement term — "take 102 in Fall
 *     2027" — is never a graduation claim; see labelAttributableToGrad).
 * This tightening makes attribution precise; it does NOT disable detection —
 * a genuinely ungrounded single-course / grad / lock claim still fires.
 */
function checkPlanClaims(ctx: ValidatorContext): Violation[] {
    const schedule = ctx.forwardSchedule;
    if (!schedule) return []; // no-op when there's no stored plan to diff against

    const violations: Violation[] = [];
    const text = ctx.assistantText;
    const planIndex = indexPlan(schedule);
    const canonGradTerm = psTermToSolverTerm(schedule.graduationTerm) ?? schedule.graduationTerm.toLowerCase();

    // ---- (1) course-placement + lock-status claims -------------------
    PLAN_COURSE_ID_RE.lastIndex = 0;
    for (const m of text.matchAll(PLAN_COURSE_ID_RE)) {
        const courseId = `${m[1]} ${m[2]}`.toUpperCase();
        const idx = m.index ?? 0;
        const clause = clauseAround(text, idx);

        // Counterfactual carve-out: skip claims inside a conditional /
        // hypothetical frame.
        if (isConditionalFrame(clause)) continue;

        const stored = planIndex.get(courseId);

        // -- placement: find term labels ATTRIBUTABLE to this course ----
        // Clause-clipped + nearest-course-wins (see termsBoundToCourse):
        // a neighbor course's term or a term across a sentence boundary
        // no longer binds here. Unresolvable labels are dropped (never a
        // guess-block).
        const claimedTerms = termsBoundToCourse(text, idx, m[0]?.length ?? 0);

        if (claimedTerms.length > 0) {
            if (!stored) {
                // The plan places no such course, yet the reply asserts a
                // concrete term for it.
                violations.push({
                    kind: "ungrounded_plan_claim",
                    detail:
                        `Reply places ${courseId} in ${claimedTerms.join("/")}, but the stored plan does ` +
                        `not place ${courseId} at all. Either correct the course/term or rebuild the plan.`,
                });
            } else {
                const storedTerms = new Set(stored.map((p) => p.canonTerm));
                // Fire only when NONE of the nearby claimed terms match a
                // stored placement (a single matching term clears it — the
                // reply may reference grad-term + placement in one window).
                const anyMatch = claimedTerms.some((t) => storedTerms.has(t));
                if (!anyMatch) {
                    violations.push({
                        kind: "ungrounded_plan_claim",
                        detail:
                            `Reply places ${courseId} in ${claimedTerms.join("/")}, but the stored plan ` +
                            `places it in ${[...storedTerms].join("/")}. Correct the term or move the course in the plan.`,
                    });
                }
            }
        }

        // -- lock-status: only when the course IS in the plan -----------
        if (stored && stored.length > 0) {
            const locked = isStoredLocked(stored[0]!);
            // Attribute the assertion to the NEAREST course code (by the
            // keyword-match position), so "X is final, and Y can still
            // move" resolves X→locked and Y→movable independently instead
            // of testing both regexes against the whole comma-spanning
            // clause.
            const courseEnd = idx + (m[0]?.length ?? 0);
            const assertsLocked = assertionAttributedToCourse(text, LOCK_ASSERT_RE, idx, courseEnd);
            const assertsMovable = assertionAttributedToCourse(text, MOVABLE_ASSERT_RE, idx, courseEnd);
            if (assertsLocked && !locked) {
                violations.push({
                    kind: "ungrounded_plan_claim",
                    detail:
                        `Reply asserts ${courseId} is locked/final, but the stored plan has it as a ` +
                        `movable ${stored[0]!.kind} slot (semester not locked). Don't claim it's fixed.`,
                });
            } else if (assertsMovable && locked) {
                violations.push({
                    kind: "ungrounded_plan_claim",
                    detail:
                        `Reply asserts ${courseId} can still be moved, but the stored plan has it as a ` +
                        `${stored[0]!.kind} slot that is fixed/locked. Don't claim it's movable.`,
                });
            }
        }
    }

    // ---- (2) graduation-term claims ----------------------------------
    // Detect "graduate <term>" phrasing and compare the term to the
    // stored graduationTerm. Skip claims inside a conditional frame.
    const GRAD_CLAIM_RE = /\bgraduat\w*\b/gi;
    const allCourseOffsets = courseCodeOffsets(text);
    for (const gm of text.matchAll(GRAD_CLAIM_RE)) {
        const idx = gm.index ?? 0;
        const [clauseStart, clauseEnd] = clauseBounds(text, idx);
        const clause = text.slice(clauseStart, clauseEnd);
        if (isConditionalFrame(clause)) continue;
        // Bind the term to the GRADUATION concept, not "any term in the
        // clause": keep only labels that (a) follow the "graduat…" token
        // with no course code between them, AND (b) do NOT co-occur with a
        // course code (a placement term — "take CSCI-UA 102 in Fall 2027"
        // — is a placement claim, never a grad claim). This stops C4.
        PLAN_TERM_LABEL_RE.lastIndex = 0;
        const labels: string[] = [];
        for (const tm of clause.matchAll(PLAN_TERM_LABEL_RE)) {
            const labelStart = clauseStart + (tm.index ?? 0);
            const labelEnd = labelStart + tm[0].length;
            if (!labelAttributableToGrad(text, idx, labelStart, labelEnd, allCourseOffsets)) continue;
            // Placement-term exclusion (per-label): drop THIS label if a
            // course code sits within the co-occurrence window of it — that
            // makes it a placement term ("take CSCI-UA 102 in Fall 2027"),
            // not a graduation claim.
            const coOccursWithCourse = allCourseOffsets.some(
                (o) => o >= labelStart - PLAN_COOCCUR_WINDOW && o < labelEnd + PLAN_COOCCUR_WINDOW,
            );
            if (coOccursWithCourse) continue;
            const solver = psTermToSolverTerm(tm[0]);
            if (solver !== null) labels.push(solver);
        }
        if (labels.length === 0) continue; // no grad-attributed term → no claim
        // Fire only when NO grad-attributed label matches the stored one.
        if (!labels.includes(canonGradTerm)) {
            violations.push({
                kind: "ungrounded_plan_claim",
                detail:
                    `Reply claims graduation in ${labels.join("/")}, but the stored plan's graduation ` +
                    `term is ${canonGradTerm}. Correct the term or rebuild the plan to that target.`,
            });
        }
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
        ...checkIdentityDrift(ctx.assistantText),
        ...checkQuantitativeShortfall(ctx.userQuestion, ctx.assistantText),
        ...checkPlanClaims(ctx),
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
