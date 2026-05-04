// ============================================================
// Phase 11 Stage 1 — blockquoteAttribution.ts unit tests
// ============================================================

import { describe, expect, it } from "vitest";
import { verifyBlockquoteAttribution } from "../../src/agent/verifiers/blockquoteAttribution.js";
import type { ToolInvocation } from "../../src/agent/agentLoop.js";

function fakePolicyInv(summary: string): ToolInvocation {
    return { toolName: "search_policy", args: {}, summary };
}

const REAL_CHUNK_SUMMARY = `
RAG hits (confidence=high; scope=cas,nyu_wide; override=false)
  [cas/academic_policies] (rerank 0.92)
    Students with 96 or more credits are not eligible to apply for an internal transfer to another NYU undergraduate school.…
    Source: bulletin/cas/academic-policies (cas-policies.md:438)
  [cas/college-core-curriculum] (rerank 0.81)
    The minor in Economics requires six 4-credit courses (24 credits) completed with a grade of C or better (courses graded Pass/Fail do not count) and offered by the Department of Economics.…
    Source: bulletin/cas/programs/economics-minor (econ-minor.md:42)
`;

describe("verifyBlockquoteAttribution — happy paths", () => {
    it("passes when an attributed blockquote matches a chunk substring", () => {
        const reply = `According to the CAS bulletin:
> Students with 96 or more credits are not eligible to apply for an internal transfer to another NYU undergraduate school.

So you can't apply now.`;
        const verdict = verifyBlockquoteAttribution(reply, [fakePolicyInv(REAL_CHUNK_SUMMARY)]);
        expect(verdict.ok).toBe(true);
    });

    it("passes when an italic-quoted policy is in the chunks", () => {
        const reply = `From the bulletin: *"The minor in Economics requires six 4-credit courses (24 credits)"*.`;
        const verdict = verifyBlockquoteAttribution(reply, [fakePolicyInv(REAL_CHUNK_SUMMARY)]);
        expect(verdict.ok).toBe(true);
    });

    it("ignores unattributed blockquotes (agent's own framing)", () => {
        const reply = `Here's a sample plan:
> Year 1: CSCI-UA 101 + MATH-UA 121
> Year 2: CSCI-UA 102 + MATH-UA 122

Not a bulletin citation, just a plan.`;
        const verdict = verifyBlockquoteAttribution(reply, []);
        expect(verdict.ok).toBe(true);
    });

    it("ignores bare double-quotes when no attribution phrase is nearby", () => {
        const reply = `The student said "I want to graduate" and I agree.`;
        const verdict = verifyBlockquoteAttribution(reply, []);
        expect(verdict.ok).toBe(true);
    });
});

describe("verifyBlockquoteAttribution — fabrication detection", () => {
    it("flags a blockquote attributed to the bulletin that's not in any chunk", () => {
        const reply = `Per the CAS bulletin §Internal Transfer Students:
> "the latest students can begin their study at a new NYU school is the first semester of their junior year."

So you'd need to apply now.`;
        // The chunks DO mention internal transfer but with different wording.
        const verdict = verifyBlockquoteAttribution(reply, [fakePolicyInv(REAL_CHUNK_SUMMARY)]);
        expect(verdict.ok).toBe(false);
        expect(verdict.fabrications).toHaveLength(1);
        expect(verdict.fabrications[0]!.attribution).toMatch(/bulletin|§/i);
    });

    it("flags a fabricated quote when zero policy invocations ran", () => {
        const reply = `According to the bulletin: > "All students must wear a tie on Tuesdays."`;
        const verdict = verifyBlockquoteAttribution(reply, []);
        expect(verdict.ok).toBe(false);
        expect(verdict.fabrications[0]!.chunksSearched).toBe(0);
    });

    it("includes the attribution phrase in the violation when available", () => {
        const reply = `Per the policy: > "Students must register by midnight."`;
        const verdict = verifyBlockquoteAttribution(reply, [fakePolicyInv("nothing relevant here")]);
        expect(verdict.ok).toBe(false);
        expect(verdict.fabrications[0]!.attribution).toMatch(/policy|§/i);
    });

    it("truncates very long fabricated quotes to 200 chars", () => {
        const longQuote = "A".repeat(400);
        const reply = `Per the bulletin:\n> ${longQuote}`;
        const verdict = verifyBlockquoteAttribution(reply, []);
        expect(verdict.fabrications[0]).toBeDefined();
        expect(verdict.fabrications[0]!.quote.length).toBeLessThanOrEqual(201);
    });
});

describe("verifyBlockquoteAttribution — paraphrase tolerance", () => {
    it("accepts a long quote where most content tokens appear in the chunk", () => {
        // Same load-bearing content, slight paraphrase: "must complete" vs
        // "completed". The substring path fails but the token-window path
        // catches it.
        const reply = `Per the bulletin:
> The minor in Economics requires six 4-credit courses (24 credits) completed with a grade of C or better (courses graded Pass/Fail do not count) and offered by the Department of Economics.`;
        const verdict = verifyBlockquoteAttribution(reply, [fakePolicyInv(REAL_CHUNK_SUMMARY)]);
        expect(verdict.ok).toBe(true);
    });

    it("normalizes smart quotes and dashes", () => {
        const reply = `Per the bulletin: > “The minor in Economics requires six 4-credit courses—24 credits—completed with a grade of C or better.”`;
        const verdict = verifyBlockquoteAttribution(reply, [fakePolicyInv(REAL_CHUNK_SUMMARY)]);
        // Should pass — same content with smart quotes / em-dashes
        expect(verdict.ok).toBe(true);
    });
});

describe("verifyBlockquoteAttribution — what_if_audit chunks count as grounding", () => {
    it("accepts a quote that appears in a what_if_audit summary", () => {
        const whatIfSummary = `WHAT-IF AUDIT: This estimate is based on AI-extracted requirements from NYU's bulletin. Verify with an academic adviser before applying for an internal transfer or program change.`;
        const whatIfInv: ToolInvocation = { toolName: "what_if_audit", args: {}, summary: whatIfSummary };
        const reply = `Per the disclaimer: > "Verify with an academic adviser before applying for an internal transfer or program change."`;
        const verdict = verifyBlockquoteAttribution(reply, [whatIfInv]);
        expect(verdict.ok).toBe(true);
    });
});
