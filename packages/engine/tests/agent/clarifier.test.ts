// ============================================================
// Phase 11 Stage 4 — clarifier.ts unit tests (gate only — askClarification is LLM-driven)
// ============================================================

import { describe, expect, it } from "vitest";
import { detectAmbiguity } from "../../src/agent/clarifier.js";

describe("detectAmbiguity — clear queries (no fire)", () => {
    it("does not fire on a complete first-person question", () => {
        expect(detectAmbiguity("What's my GPA?", []).ambiguous).toBe(false);
    });

    it("does not fire on a longer well-formed question", () => {
        expect(detectAmbiguity("Can I take CSCI-UA 472 next semester for my major?", []).ambiguous).toBe(false);
    });

    it("does not fire when pronoun has a clear antecedent in recent history", () => {
        const history = [
            { role: "user" as const, content: "Tell me about CSCI-UA 472." },
            { role: "assistant" as const, content: "CSCI-UA 472 is Artificial Intelligence." },
        ];
        const r = detectAmbiguity("Can I take that next semester?", history);
        // The "MAJOR/CSCI" antecedent rule means this passes; if not,
        // adjust the antecedent regex.
        expect(r.signals).not.toContain("pronoun_no_antecedent");
    });
});

describe("detectAmbiguity — ambiguous queries (fire)", () => {
    it("fires on ultra-short fragment 'a minor?'", () => {
        const r = detectAmbiguity("a minor?", []);
        expect(r.ambiguous).toBe(true);
        expect(r.signals).toContain("ultra_short");
    });

    it("fires on 'is this enough?'", () => {
        const r = detectAmbiguity("is this enough?", []);
        expect(r.ambiguous).toBe(true);
    });

    it("fires on 'can I take that next semester?' with no antecedent in history", () => {
        const r = detectAmbiguity("can I take that next semester?", []);
        expect(r.ambiguous).toBe(true);
        expect(r.signals).toContain("pronoun_no_antecedent");
    });

    it("fires on bare noun-phrase 'the math major?'", () => {
        const r = detectAmbiguity("the math major?", []);
        expect(r.ambiguous).toBe(true);
    });
});

describe("detectAmbiguity — does NOT fire on long messages", () => {
    it("skips long messages even with pronouns", () => {
        const r = detectAmbiguity(
            "I'm thinking about whether to drop CSCI-UA 480 because I find it too hard, but I'm worried it might affect my graduation timeline. What should I do?",
            [],
        );
        // Length cap kicks in.
        expect(r.ambiguous).toBe(false);
    });
});
