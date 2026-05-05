// ============================================================
// llmPolishPrompt — prompt-shape pin (Phase 17 Task D follow-up)
// ============================================================
// The polish stream rewrites a deterministic plan-change template
// into more natural prose. Cardinal Rule §2.1 (no fabrication)
// requires the system prompt to lock the model to "rephrase, do
// NOT add new facts; preserve every course code and credit number
// verbatim." A drift in this prompt could let the model invent
// prerequisites, credit totals, or term labels — exactly the
// failure mode the deterministic-then-polish flow exists to
// prevent.
//
// This suite pins:
//
//   1. Constraint wording: the system prompt explicitly says
//      "rephrase", forbids adding new facts, and tells the model to
//      preserve course codes / credit numbers / term labels verbatim.
//   2. Few-shot examples: every Input/Output pair in the prompt
//      preserves every course code (e.g. "MATH-UA 343"), credit
//      number (e.g. "20cr", "16 credits"), and term label
//      (e.g. "Fall 2026", "Spring 2027") between the input and the
//      expected polished output.
//   3. Token budget + model id: pinned to detect a silent bump.
//
// (1) is asserted via substring match on the system prompt.
// (2) is asserted by extracting course/credit/term tokens with
// regexes and checking the input set is a SUBSET of the output set.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    LLM_POLISH_SYSTEM_PROMPT,
    LLM_POLISH_MAX_TOKENS,
    LLM_POLISH_MODEL_ID,
    buildPolishUserMessage,
} from "../lib/llmPolishPrompt";

// ---------------------------------------------------------------------------
// Token extractors — the test harness's own copies of the patterns
// the system prompt locks the model to preserving.
// ---------------------------------------------------------------------------

/** Course-code pattern — e.g. "CSCI-UA 101", "MATH-UA 343". The
 *  prompt's strict rule #1 says these are preserved verbatim. */
const COURSE_CODE_RE = /\b[A-Z]{2,5}-[A-Z]{1,3}\s+\d+[A-Z]?\b/g;

/** Credit-number pattern — e.g. "16cr", "20 credits", "16 → 20cr". */
const CREDIT_NUMBER_RE = /\b\d+\s*(?:cr\b|credits?\b)/g;

/** Term-label pattern — e.g. "Fall 2026", "Spring 2027". */
const TERM_LABEL_RE = /\b(?:Spring|Summer|Fall|January|Winter)\s+\d{4}\b/g;

function extractTokens(text: string, re: RegExp): Set<string> {
    return new Set(text.match(re) ?? []);
}

// ---------------------------------------------------------------------------
// 1. Constraint wording — pin the system-prompt anchors.
// ---------------------------------------------------------------------------

describe("LLM_POLISH_SYSTEM_PROMPT — constraint wording", () => {
    it("contains 'rephrase' (the model's job statement)", () => {
        expect(LLM_POLISH_SYSTEM_PROMPT.toLowerCase()).toMatch(/rephrase/);
    });

    it("forbids adding new facts ('do NOT add')", () => {
        // Cardinal Rule §2.1 anchor — without this, the model is free
        // to invent prereqs / credit caps / term labels.
        expect(LLM_POLISH_SYSTEM_PROMPT).toMatch(/do NOT add new facts/i);
    });

    it("locks course-code preservation verbatim", () => {
        expect(LLM_POLISH_SYSTEM_PROMPT.toLowerCase()).toMatch(/preserve every course code/);
        expect(LLM_POLISH_SYSTEM_PROMPT.toLowerCase()).toMatch(/verbatim/);
    });

    it("locks credit-number preservation verbatim", () => {
        expect(LLM_POLISH_SYSTEM_PROMPT.toLowerCase()).toMatch(/preserve every credit number/);
    });

    it("locks term-label preservation verbatim", () => {
        expect(LLM_POLISH_SYSTEM_PROMPT.toLowerCase()).toMatch(/preserve every term label/);
    });

    it("forbids removing information ('do NOT remove')", () => {
        // Symmetric to the no-fabrication rule — the polish must not
        // strip a credit floor / cap warning the template carried.
        expect(LLM_POLISH_SYSTEM_PROMPT).toMatch(/do NOT remove/i);
    });

    it("constrains output length (1-3 sentences)", () => {
        expect(LLM_POLISH_SYSTEM_PROMPT).toMatch(/1-3 sentences/i);
    });

    it("forbids markdown / lists in output", () => {
        // Plain English keeps the bubble visually consistent with the
        // surrounding chat thread.
        expect(LLM_POLISH_SYSTEM_PROMPT.toLowerCase()).toMatch(/no markdown/);
    });
});

// ---------------------------------------------------------------------------
// 2. Few-shot example invariants — every input token survives in the
// expected output.
// ---------------------------------------------------------------------------

interface Example {
    input: string;
    output: string;
}

/** Extract Input/Output pairs from the few-shot block of the system
 *  prompt. The format is line-pair: `Input: ...` then `Output: ...`. */
function extractExamples(prompt: string): Example[] {
    const examples: Example[] = [];
    const lines = prompt.split("\n");
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const inMatch = line.match(/^Input:\s+(.*)$/);
        if (!inMatch) continue;
        // Find the next non-empty line that's an Output.
        for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j]!;
            const outMatch = next.match(/^Output:\s+(.*)$/);
            if (outMatch) {
                examples.push({ input: inMatch[1]!, output: outMatch[1]! });
                break;
            }
            // If we hit another `Input:` first, the prior input has
            // no output — skip.
            if (next.match(/^Input:/)) break;
        }
    }
    return examples;
}

describe("LLM_POLISH_SYSTEM_PROMPT — few-shot examples", () => {
    const examples = extractExamples(LLM_POLISH_SYSTEM_PROMPT);

    it("includes at least 2 positive few-shot examples", () => {
        // Plan §6 calls for "at least 2 positive examples"; the
        // current prompt ships 3.
        expect(examples.length).toBeGreaterThanOrEqual(2);
    });

    it("every example: course codes from the input survive in the output", () => {
        for (const ex of examples) {
            const inputCodes = extractTokens(ex.input, COURSE_CODE_RE);
            const outputCodes = extractTokens(ex.output, COURSE_CODE_RE);
            for (const code of inputCodes) {
                expect(outputCodes.has(code), `course code "${code}" missing from output of example: ${ex.input.slice(0, 60)}…`).toBe(true);
            }
        }
    });

    it("every example: credit numbers from the input survive in the output", () => {
        for (const ex of examples) {
            const inputCreds = extractTokens(ex.input, CREDIT_NUMBER_RE);
            const outputCreds = extractTokens(ex.output, CREDIT_NUMBER_RE);
            // Normalize whitespace ("16 cr" vs "16cr") so a polish
            // that preserves the digit + unit but drops the space is
            // not flagged as drift. The system-prompt rule is on the
            // NUMBER, not the formatting — but the digit survives in
            // both forms.
            const norm = (s: Set<string>) => new Set(Array.from(s).map((x) => x.replace(/\s+/g, "")));
            const inN = norm(inputCreds);
            const outN = norm(outputCreds);
            for (const c of inN) {
                expect(outN.has(c), `credit number "${c}" missing from output of example: ${ex.input.slice(0, 60)}…`).toBe(true);
            }
        }
    });

    it("every example: term labels from the input survive in the output", () => {
        for (const ex of examples) {
            const inputTerms = extractTokens(ex.input, TERM_LABEL_RE);
            const outputTerms = extractTokens(ex.output, TERM_LABEL_RE);
            for (const term of inputTerms) {
                expect(outputTerms.has(term), `term label "${term}" missing from output of example: ${ex.input.slice(0, 60)}…`).toBe(true);
            }
        }
    });
});

// ---------------------------------------------------------------------------
// 3. Token + model pins.
// ---------------------------------------------------------------------------

describe("LLM_POLISH_MAX_TOKENS / LLM_POLISH_MODEL_ID", () => {
    it("MAX_TOKENS is small (<= 1024) so polish stays cheap", () => {
        expect(LLM_POLISH_MAX_TOKENS).toBeLessThanOrEqual(1024);
        expect(LLM_POLISH_MAX_TOKENS).toBeGreaterThan(0);
    });

    it("MODEL_ID points at a Haiku snapshot (latency-optimized)", () => {
        // Pinning at a snapshot guards against a future model bump
        // that could silently change the polish behavior. The plan
        // calls out Haiku specifically; if we ever want to upgrade
        // to a different model this test fails and forces a
        // deliberate constant change.
        expect(LLM_POLISH_MODEL_ID).toMatch(/haiku/i);
    });
});

// ---------------------------------------------------------------------------
// 4. buildPolishUserMessage — pinned shape.
// ---------------------------------------------------------------------------

describe("buildPolishUserMessage", () => {
    it("includes the deterministic template verbatim", () => {
        const tpl = "Pinning MATH-UA 343 to Spring 2027 would push the term to 20cr.";
        const out = buildPolishUserMessage({ templateText: tpl });
        expect(out).toContain(tpl);
        expect(out.toLowerCase()).toContain("rephrase");
    });

    it("includes structuredDiff JSON when supplied", () => {
        const tpl = "Adding CSCI-UA 480 raises Fall 2026 to 20cr.";
        const diff = JSON.stringify({ added: [{ courseId: "CSCI-UA 480" }] });
        const out = buildPolishUserMessage({ templateText: tpl, structuredDiffJson: diff });
        expect(out).toContain(diff);
        // The reminder line tells the model the JSON is read-only,
        // not a license to add facts.
        expect(out.toLowerCase()).toContain("do not add facts");
    });

    it("omits the structured diff block entirely when not supplied", () => {
        const tpl = "Adding CSCI-UA 480 raises Fall 2026 to 20cr.";
        const out = buildPolishUserMessage({ templateText: tpl });
        // No "Reference structured diff" leader when the field is absent.
        expect(out.toLowerCase()).not.toContain("reference structured diff");
    });
});
