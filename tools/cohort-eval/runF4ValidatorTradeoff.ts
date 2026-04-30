#!/usr/bin/env -S npx tsx
// ============================================================
// Phase 10 F4 — Validator before/after tradeoff harness
// ============================================================
// Builds a synthetic, structured test bench and runs BOTH the
// current validator and the proposed (F4-modified) validator
// against each case. Prints a side-by-side verdict so the operator
// can decide whether the F4 changes are worth shipping.
//
// The proposed F4 changes (defined inline below — NOT applied to
// the source validator yet):
//
//   1. Negation-aware invocation/caveat triggers: skip a regex
//      match if the 30 chars preceding the match contain "not",
//      "isn't", "aren't", "never", "rather than", "no longer",
//      or "NOT".
//
//   2. Topical relevance for verbatim_drift: skip if the reply
//      contains zero numeric claims AND the user-question keyword
//      set has no overlap with the verbatimText.
//
//   3. Temporal-context number exemption: extractClaimNumbers
//      should drop integers (year-shaped + month-shaped) if those
//      numbers appear in a passed-in temporal-context block.
//
// The harness compares each test case against:
//   - "expected": should this case fire a violation?  yes / no
//   - "current": does the current validator fire?
//   - "proposed": does the proposed validator fire?
//
// True positive  = (expected=yes & fires)
// False positive = (expected=no  & fires)
// False negative = (expected=yes & does-not-fire)
// True negative  = (expected=no  & does-not-fire)
//
// Decision criteria:
//   - Net FP reduction with same-or-better TP coverage = ship F4.
//   - Same FP, fewer TP = do NOT ship; F4 weakens guard rails.
//   - Mixed = let operator weigh the specific tradeoffs.
// ============================================================

import {
    validateResponse as currentValidate,
    type ToolInvocation,
} from "../../packages/engine/src/index.js";

// ============================================================
// PROPOSED F4 VALIDATOR (inline — not yet applied to source)
// ============================================================
// Reimplements the relevant validator logic with the 3 changes.
// We import the *current* validator's internals indirectly by
// reproducing the matching rules here. This is a test-only
// reimplementation; the real source stays untouched.

type Violation = { kind: string; detail: string };

const NEGATION_RE = /\b(?:not|isn'?t|aren'?t|never|no longer|rather than|NOT)\b/i;

function precedingSnippet(text: string, matchIndex: number, windowChars = 30): string {
    return text.slice(Math.max(0, matchIndex - windowChars), matchIndex);
}

function isNegated(text: string, regex: RegExp): boolean {
    // Find the FIRST match of `regex` and check whether the
    // preceding `windowChars` contains a negation marker.
    const m = text.match(regex);
    if (!m || m.index === undefined) return false;
    return NEGATION_RE.test(precedingSnippet(text, m.index));
}

interface ProposedRule {
    triggers: RegExp[];
    requiresAnyOf: string[];
    description: string;
}

const PROPOSED_INVOCATION_RULES: ProposedRule[] = [
    {
        triggers: [/\binternal[- ]transfer\b/i, /\btransfer to (?:cas|stern|tandon|tisch|steinhardt)\b/i, /\bswitch (?:my )?school\b/i],
        requiresAnyOf: ["check_transfer_eligibility"],
        description: "internal transfer mention",
    },
];

interface ProposedCaveatRule {
    id: string;
    triggerPatterns: RegExp[];
    requiredSubstrings: RegExp[];
    description: string;
}

const PROPOSED_CAVEAT_RULES: ProposedCaveatRule[] = [
    {
        id: "internal_transfer_gpa_note",
        triggerPatterns: [/\binternal transfer\b/i, /\btransfer (?:to|into) (?:cas|stern|tandon|tisch|steinhardt)\b/i],
        requiredSubstrings: [
            /\bgpa\b/i,
            /\b(?:not published|aren'?t published|isn'?t published|do(?:es)?n'?t (?:publish|disclose)|not (?:public|disclosed))\b/i,
        ],
        description: "internal_transfer GPA caveat",
    },
];

function proposedCheckInvocations(
    assistantText: string,
    invocations: ReadonlyArray<ToolInvocation>,
): Violation[] {
    const violations: Violation[] = [];
    const calledTools = new Set(invocations.map((i) => i.toolName));
    for (const rule of PROPOSED_INVOCATION_RULES) {
        const triggered = rule.triggers.some((re) => {
            const m = assistantText.match(re);
            if (!m || m.index === undefined) return false;
            // F4 change #1 — negation guard.
            if (NEGATION_RE.test(precedingSnippet(assistantText, m.index))) return false;
            return true;
        });
        if (!triggered) continue;
        if (!rule.requiresAnyOf.some((t) => calledTools.has(t))) {
            violations.push({ kind: "missing_invocation", detail: rule.description });
        }
    }
    return violations;
}

function proposedCheckCompleteness(assistantText: string): Violation[] {
    const violations: Violation[] = [];
    for (const rule of PROPOSED_CAVEAT_RULES) {
        const triggered = rule.triggerPatterns.some((re) => {
            const m = assistantText.match(re);
            if (!m || m.index === undefined) return false;
            // F4 change #1 — negation guard.
            if (NEGATION_RE.test(precedingSnippet(assistantText, m.index))) return false;
            return true;
        });
        if (!triggered) continue;
        const allCovered = rule.requiredSubstrings.every((re) => re.test(assistantText));
        if (!allCovered) {
            violations.push({ kind: "missing_caveat", detail: rule.description });
        }
    }
    return violations;
}

function proposedCheckVerbatim(
    assistantText: string,
    invocations: ReadonlyArray<ToolInvocation>,
    userQuestion: string,
): Violation[] {
    const violations: Violation[] = [];
    const replyNorm = assistantText.replace(/\s+/g, " ").trim();
    for (const inv of invocations) {
        const v = inv.verbatimText;
        if (!v) continue;
        const verbatimNorm = v.replace(/\s+/g, " ").trim();
        if (!verbatimNorm) continue;
        if (replyNorm.includes(verbatimNorm)) continue;

        // F4 change #2 — TWO-LAYER relevance gate.
        //
        // Layer A (numeric overlap): if the reply contains AT LEAST ONE of
        // the verbatim's numbers (e.g., "3.402"), we treat the verbatim as
        // load-bearing and FIRE — the agent reused the number but didn't
        // wrap it with the required surrounding text. This is a real
        // Cardinal Rule §2.1 issue.
        //
        // Layer B (no numeric overlap, no topical overlap): if the reply
        // has NEITHER a verbatim number NOR any keyword shared with the
        // verbatim (e.g., reply talks about study abroad, verbatim is
        // "Cumulative GPA: 3.402"), the verbatim is irrelevant — SKIP.
        //
        // This catches the "agent paraphrased the GPA" case (real bug)
        // while letting the "agent answered an unrelated question" case
        // pass cleanly.
        const replyNumbers = new Set(replyNorm.match(/\d+(?:\.\d+)?/g) ?? []);
        const verbatimNumbers = new Set(verbatimNorm.match(/\d+(?:\.\d+)?/g) ?? []);
        let numOverlap = 0;
        for (const n of verbatimNumbers) if (replyNumbers.has(n)) numOverlap++;
        if (numOverlap > 0) {
            // Layer A: reply reused a verbatim number — fire.
            violations.push({
                kind: "verbatim_drift",
                detail: `verbatim drift on tool "${inv.toolName}" (numeric overlap)`,
            });
            continue;
        }
        // Layer B: no numeric overlap. Skip iff there's also no keyword
        // overlap between the user's question and the verbatim.
        const verbatimTokens = new Set(
            verbatimNorm.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [],
        );
        const questionTokens = new Set(
            userQuestion.toLowerCase().match(/\b[a-z]{3,}\b/g) ?? [],
        );
        let kwOverlap = 0;
        for (const t of questionTokens) if (verbatimTokens.has(t)) kwOverlap++;
        if (kwOverlap === 0) continue; // skip — irrelevant verbatim
        // Topical match but reply omitted the verbatim → fire.
        violations.push({
            kind: "verbatim_drift",
            detail: `verbatim drift on tool "${inv.toolName}" (topic overlap, omitted verbatim)`,
        });
    }
    return violations;
}

function proposedValidate(
    assistantText: string,
    invocations: ReadonlyArray<ToolInvocation>,
    userQuestion: string,
): Violation[] {
    return [
        ...proposedCheckInvocations(assistantText, invocations),
        ...proposedCheckCompleteness(assistantText),
        ...proposedCheckVerbatim(assistantText, invocations, userQuestion),
    ];
}

// ============================================================
// TEST BENCH
// ============================================================
// Each case:
//   - userQuestion: simulates last user turn
//   - assistantText: simulates the model's reply
//   - invocations: simulates tool invocations made this turn
//   - expectFire: should the validator fire AT LEAST ONE violation?
//   - rationale: why we chose this expectation
// ============================================================

interface TestCase {
    id: string;
    label: string;
    userQuestion: string;
    assistantText: string;
    invocations: ToolInvocation[];
    expectFire: boolean;
    rationale: string;
}

const fakeAuditInvocation: ToolInvocation = {
    toolName: "run_full_audit",
    args: {},
    durationMs: 100,
    summary: "AUDIT (from your DPR): ...",
    result: { source: "dpr" },
    verbatimText: "Cumulative GPA: 3.402",
};

const TEST_CASES: TestCase[] = [
    // ---------- NEGATION CASES ----------
    {
        id: "neg01",
        label: "Negation — minor declaration explicitly NOT a transfer",
        userQuestion: "Can I add an Economics minor?",
        assistantText:
            "To officially declare the minor, you would need to contact the Department of Economics office. " +
            "Since the minor is in CAS (your home school), this is a program declaration, not an internal transfer. " +
            "Your status: 138/128 credits earned, GPA 3.402.",
        invocations: [fakeAuditInvocation],
        expectFire: false,
        rationale:
            "The reply explicitly disclaims internal-transfer relevance. Validator should NOT require " +
            "check_transfer_eligibility or the GPA-not-published caveat.",
    },
    {
        id: "neg02",
        label: "Negation — 'this is NOT an internal transfer'",
        userQuestion: "What if I dropped the math half of my major?",
        assistantText:
            "This is NOT an internal transfer — it's a within-CAS major change. " +
            "Verify with an academic adviser before applying. Cumulative GPA: 3.402.",
        invocations: [fakeAuditInvocation],
        expectFire: false,
        rationale: "Same negation pattern; should not fire.",
    },
    {
        id: "neg03",
        label: "Real internal transfer (no negation) — SHOULD fire if no tool",
        userQuestion: "Can I switch from CAS to Stern Finance now?",
        assistantText:
            "An internal transfer to Stern Finance is possible if you meet the GPA bar. " +
            "Your GPA is 3.402.",
        invocations: [fakeAuditInvocation], // NOTE: no check_transfer_eligibility
        expectFire: true,
        rationale: "Real internal transfer claim without check_transfer_eligibility AND no GPA-not-published caveat.",
    },

    // ---------- VERBATIM RELEVANCE CASES ----------
    {
        id: "vbm01",
        label: "Verbatim drift — irrelevant question (study abroad)",
        userQuestion: "Can I do a study abroad semester?",
        assistantText:
            "Study abroad is permitted but at least half of your CS / Math courses must be taken in NY. " +
            "Contact the Office of Global Services to explore options.",
        invocations: [fakeAuditInvocation],
        expectFire: false,
        rationale:
            "User asked about study abroad. The audit's verbatim 'Cumulative GPA: 3.402' isn't relevant " +
            "to the answer; the reply has no numeric claims at all so there's nothing to verify against. " +
            "Forcing the GPA verbatim into the reply is noise, not safety.",
    },
    {
        id: "vbm02",
        label: "Verbatim drift — irrelevant question (drop deadline)",
        userQuestion: "What's the deadline to drop a class with a W?",
        assistantText:
            "You can drop a class with a W from the beginning of the third week through the 14th week of the term. " +
            "After the 14th week, the grade becomes final.",
        invocations: [fakeAuditInvocation],
        expectFire: false,
        rationale: "Reply has numbers (3rd, 14th) but they're week ordinals, not GPA. Question + verbatim share zero keywords.",
    },
    {
        id: "vbm03",
        label: "Verbatim relevant — GPA question",
        userQuestion: "What's my GPA?",
        assistantText: "Your DPR shows you're doing well. Standing: good standing per the audit.",
        invocations: [fakeAuditInvocation],
        expectFire: true,
        rationale:
            "User asked about GPA and the verbatim is the GPA. Reply omits the actual GPA number. " +
            "Validator MUST fire here — both before and after F4 — to catch the drift.",
    },
    {
        id: "vbm04",
        label: "Verbatim relevant — 'am I in good standing'",
        userQuestion: "Am I in good standing?",
        assistantText: "Yes, you are in good standing.",
        invocations: [fakeAuditInvocation],
        expectFire: true,
        rationale:
            "Reply has no number. Question shares 'standing' but not GPA — verbatim is 'Cumulative GPA: 3.402'. " +
            "Tokens 'cumulative', 'gpa' absent from question. F4's relevance gate would let this slide; " +
            "tradeoff: agent might omit the GPA basis. Operator must judge if this is a real issue.",
    },

    // ---------- TOPIC OVERLAP CASES ----------
    {
        id: "vbm05",
        label: "Verbatim drift — credits question (verbatim is GPA, irrelevant)",
        userQuestion: "How many credits do I have?",
        assistantText: "You're at 138 of 128 required.",
        invocations: [fakeAuditInvocation],
        expectFire: false,
        rationale:
            "Reply has '138' and '128' (correct numbers from DPR). Verbatim 'Cumulative GPA: 3.402' is unrelated. " +
            "F4 should NOT fire — the reply has numbers but they're credits not GPA, and verbatim/question keyword overlap is zero. " +
            "Current validator fires (false positive). F4 fixes it.",
    },
    // Two new cases to sharpen the tradeoff
    {
        id: "vbm06",
        label: "Verbatim drift — agent paraphrased GPA ('GPA 3.402' missing 'Cumulative')",
        userQuestion: "What's my current GPA?",
        assistantText: "Your GPA is 3.402.",
        invocations: [fakeAuditInvocation],
        expectFire: true,
        rationale:
            "Reply reused the verbatim's number 3.402 but dropped the 'Cumulative' prefix. Layer A (numeric overlap) " +
            "should fire. This is the real Cardinal Rule §2.1 case the validator must catch.",
    },
    {
        id: "vbm07",
        label: "Off-topic — career planning question, audit verbatim irrelevant",
        userQuestion: "What career paths are common for CS majors?",
        assistantText:
            "CS graduates pursue software engineering, machine learning, data science, and product management among others. " +
            "Many also continue to graduate school. Specific paths depend on your interests and internship experience.",
        invocations: [fakeAuditInvocation],
        expectFire: false,
        rationale:
            "Career question. No numbers. No keyword overlap with 'Cumulative GPA: 3.402'. Verbatim is irrelevant noise. " +
            "F4 correctly skips.",
    },
];

// ============================================================
// HARNESS
// ============================================================

function runOne(c: TestCase): {
    currentFires: boolean;
    proposedFires: boolean;
    currentDetails: string[];
    proposedDetails: string[];
} {
    const cur = currentValidate({
        assistantText: c.assistantText,
        invocations: c.invocations,
        userQuestion: c.userQuestion, // F4c — now wired into the live validator
    });
    const prop = proposedValidate(c.assistantText, c.invocations, c.userQuestion);
    return {
        currentFires: cur.violations.length > 0,
        proposedFires: prop.length > 0,
        currentDetails: cur.violations.map((v) => `${v.kind}: ${v.detail.slice(0, 60)}`),
        proposedDetails: prop.map((v) => `${v.kind}: ${v.detail.slice(0, 60)}`),
    };
}

function classify(fires: boolean, expected: boolean): "TP" | "FP" | "FN" | "TN" {
    if (fires && expected) return "TP";
    if (fires && !expected) return "FP";
    if (!fires && expected) return "FN";
    return "TN";
}

function main(): void {
    console.log(`\nPhase 10 F4 — Validator before/after tradeoff\n`);
    console.log(`${TEST_CASES.length} test cases · current vs. proposed\n`);
    console.log(
        `| Case | Expected | Current | Proposed | Δ |`,
    );
    console.log(`|---|---|---|---|---|`);

    let curTP = 0, curFP = 0, curFN = 0, curTN = 0;
    let propTP = 0, propFP = 0, propFN = 0, propTN = 0;

    const detailRows: Array<{ id: string; label: string; rationale: string; cur: string[]; prop: string[]; expected: boolean }> = [];

    for (const c of TEST_CASES) {
        const r = runOne(c);
        const curClass = classify(r.currentFires, c.expectFire);
        const propClass = classify(r.proposedFires, c.expectFire);
        if (curClass === "TP") curTP++; if (curClass === "FP") curFP++; if (curClass === "FN") curFN++; if (curClass === "TN") curTN++;
        if (propClass === "TP") propTP++; if (propClass === "FP") propFP++; if (propClass === "FN") propFN++; if (propClass === "TN") propTN++;
        const delta = curClass === propClass ? "—" : `${curClass}→${propClass}`;
        console.log(
            `| ${c.id} | ${c.expectFire ? "fire" : "quiet"} | ${r.currentFires ? "fire" : "quiet"} (${curClass}) | ${r.proposedFires ? "fire" : "quiet"} (${propClass}) | ${delta} |`,
        );
        detailRows.push({ id: c.id, label: c.label, rationale: c.rationale, cur: r.currentDetails, prop: r.proposedDetails, expected: c.expectFire });
    }

    console.log(`\n## Confusion matrix\n`);
    console.log(`| Validator | TP | FP | FN | TN |`);
    console.log(`|---|---:|---:|---:|---:|`);
    console.log(`| Current  | ${curTP} | ${curFP} | ${curFN} | ${curTN} |`);
    console.log(`| Proposed | ${propTP} | ${propFP} | ${propFN} | ${propTN} |`);
    console.log(`\n**FP delta**:  ${propFP - curFP}  (negative = fewer false positives, GOOD)`);
    console.log(`**FN delta**:  ${propFN - curFN}  (positive = more false negatives, RISK)`);
    console.log(`**TP delta**:  ${propTP - curTP}  (negative = lost true positives, RISK)`);

    console.log(`\n## Per-case rationale (sorted by where verdicts disagree)\n`);
    const disagreed = detailRows.filter((d) => {
        const c = classify(/fire/.test(d.cur.join("")) || d.cur.length > 0, d.expected);
        const p = classify(d.prop.length > 0, d.expected);
        return c !== p;
    });
    for (const d of disagreed) {
        console.log(`### ${d.id} — ${d.label}`);
        console.log(`  expected: ${d.expected ? "fire" : "quiet"}`);
        console.log(`  current: ${d.cur.join("; ") || "(quiet)"}`);
        console.log(`  proposed: ${d.prop.join("; ") || "(quiet)"}`);
        console.log(`  rationale: ${d.rationale}`);
        console.log("");
    }
    console.log(`\nIf no rows above, current and proposed agree on every case (no tradeoff to make).`);
}

main();
