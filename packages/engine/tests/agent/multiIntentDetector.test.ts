// ============================================================
// Phase 11 Stage 3 — multiIntentDetector.ts unit tests
// ============================================================

import { describe, expect, it } from "vitest";
import {
    detectMultiIntent,
    renderMultiIntentBriefing,
} from "../../src/agent/verifiers/multiIntentDetector.js";

describe("detectMultiIntent — clear single-intent (no fire)", () => {
    it("does not fire on a single question", () => {
        expect(detectMultiIntent("What's my GPA?").isMultiIntent).toBe(false);
    });

    it("does not fire on a long single question", () => {
        expect(detectMultiIntent("Can you tell me what requirements I still need to graduate?").isMultiIntent).toBe(false);
    });

    it("does not fire on conversational follow-ups without a coordinator", () => {
        expect(detectMultiIntent("yes please").isMultiIntent).toBe(false);
        expect(detectMultiIntent("ok").isMultiIntent).toBe(false);
    });
});

describe("detectMultiIntent — fires on multiple ?", () => {
    it("fires when two questions are separated by ≥ 5 words", () => {
        const r = detectMultiIntent("What's my GPA? Can I add a Math minor?");
        expect(r.isMultiIntent).toBe(true);
        expect(r.signals).toContain("multiple_question_marks");
        expect(r.detectedSubQuestions.length).toBeGreaterThanOrEqual(2);
    });

    it("does not fire on `?!?` style emphasis", () => {
        const r = detectMultiIntent("Really??");
        expect(r.isMultiIntent).toBe(false);
    });
});

describe("detectMultiIntent — fires on coordinated first-person verbs", () => {
    it("fires on 'What's my X and can I do Y'", () => {
        const r = detectMultiIntent("What's my GPA and can I drop CSCI-UA 480?");
        expect(r.isMultiIntent).toBe(true);
        expect(r.signals).toContain("two_distinct_first_person_verbs");
    });

    it("fires on 'How many X and what are my Y'", () => {
        const r = detectMultiIntent("How many credits do I have, and what are my remaining requirements?");
        expect(r.isMultiIntent).toBe(true);
    });
});

describe("detectMultiIntent — fires on compound 'what if'", () => {
    it("fires on two what-ifs", () => {
        const r = detectMultiIntent("What if I add a minor and what if I drop calculus?");
        expect(r.isMultiIntent).toBe(true);
        expect(r.signals).toContain("compound_what_if");
    });
});

describe("detectMultiIntent — coordinator + intent verbs", () => {
    it("fires on 'plan X and find Y'", () => {
        const r = detectMultiIntent("Plan my Spring 2027 and find a CS elective");
        expect(r.isMultiIntent).toBe(true);
    });
});

describe("renderMultiIntentBriefing", () => {
    it("returns empty string for single-intent reports", () => {
        const briefing = renderMultiIntentBriefing(detectMultiIntent("What's my GPA?"));
        expect(briefing).toBe("");
    });

    it("renders sub-questions when split is available", () => {
        const briefing = renderMultiIntentBriefing(detectMultiIntent("What's my GPA? Can I add a Math minor?"));
        expect(briefing).toMatch(/MULTI-INTENT/);
        expect(briefing).toMatch(/GPA/);
        expect(briefing).toMatch(/Math minor/);
    });

    it("falls back to signals-only briefing when split fails", () => {
        const r = detectMultiIntent("Plan my Spring 2027 and find a CS elective");
        const briefing = renderMultiIntentBriefing(r);
        expect(briefing).toMatch(/MULTI-INTENT/);
    });
});
