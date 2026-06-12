// ============================================================
// D7.1 — proactiveElicitation.ts unit tests (pure detector; no API key)
// ============================================================
// Sibling to clarifier.test.ts. The reactive clarifier (detectAmbiguity)
// owns genuinely-AMBIGUOUS messages; this PROACTIVE detector owns
// CLEAR-but-context-thin planning questions where a professional adviser
// would answer first and then ask ONE focused question. These tests pin
// the conservative/bounded contract: positives on the high-value
// signals, and a wide spread of negatives proving a low false-positive
// rate. They are pure-function tests — no LLM, no API key, no network.
// ============================================================

import { describe, expect, it } from "vitest";
import {
    detectElicitationOpportunity,
    type ElicitationReport,
} from "../../src/agent/proactiveElicitation.js";
import type { LLMMessage } from "../../src/agent/llmClient.js";

const NO_PROGRAMS = { homeSchool: "cas", declaredPrograms: [] as string[] };
const WITH_PROGRAM = { homeSchool: "cas", declaredPrograms: ["computer_science_major"] };

function shouldFireWith(signal: string, r: ElicitationReport): void {
    expect(r.shouldElicit).toBe(true);
    expect(r.signals).toContain(signal);
    expect(typeof r.topic).toBe("string");
    expect((r.topic ?? "").length).toBeGreaterThan(0);
}

// ----------------------------------------------------------------
// Structural contract — it's a detector, never a substitute.
// ----------------------------------------------------------------
describe("detectElicitationOpportunity — structural contract", () => {
    it("returns a structured report (never a string, never throws)", () => {
        const r = detectElicitationOpportunity("What should I take next semester?", [], NO_PROGRAMS);
        expect(typeof r).toBe("object");
        expect(typeof r.shouldElicit).toBe("boolean");
        expect(Array.isArray(r.signals)).toBe(true);
    });

    it("does not throw on an empty message", () => {
        expect(() => detectElicitationOpportunity("", [], NO_PROGRAMS)).not.toThrow();
        expect(detectElicitationOpportunity("", [], NO_PROGRAMS).shouldElicit).toBe(false);
    });

    it("does not throw when studentContext fields are absent", () => {
        expect(() => detectElicitationOpportunity("What should I take next semester?", [], {})).not.toThrow();
    });
});

// ----------------------------------------------------------------
// Positives — each signal fires on a representative case.
// ----------------------------------------------------------------
describe("detectElicitationOpportunity — positive signals", () => {
    it("planning_without_declared_program: forward-planning intent + empty declaredPrograms", () => {
        const r = detectElicitationOpportunity("What should I take next semester?", [], NO_PROGRAMS);
        shouldFireWith("planning_without_declared_program", r);
    });

    it("planning_without_declared_program: 'am I on track to graduate?' with no program", () => {
        const r = detectElicitationOpportunity("Am I on track to graduate on time?", [], NO_PROGRAMS);
        shouldFireWith("planning_without_declared_program", r);
    });

    it("major_exploration_without_interest: 'should I major in X?' with no interest cue", () => {
        const r = detectElicitationOpportunity("Should I major in economics or psychology?", [], NO_PROGRAMS);
        shouldFireWith("major_exploration_without_interest", r);
    });

    it("major_exploration_without_interest: 'thinking about adding a minor' with no interest cue", () => {
        const r = detectElicitationOpportunity(
            "I am thinking about adding a minor — which one would make sense for me?",
            [],
            WITH_PROGRAM,
        );
        shouldFireWith("major_exploration_without_interest", r);
    });

    it("global_campus_planning_without_away_intent: Abu Dhabi student, multi-term plan, no study-away mention", () => {
        const r = detectElicitationOpportunity(
            "Can you map out my next few semesters?",
            [],
            { homeSchool: "nyuad", declaredPrograms: ["computer_science_major"] },
        );
        shouldFireWith("global_campus_planning_without_away_intent", r);
    });

    it("global_campus_planning_without_away_intent: Shanghai student is treated as global (case-insensitive)", () => {
        const r = detectElicitationOpportunity(
            "Can you map out my next few semesters?",
            [],
            { homeSchool: "Shanghai", declaredPrograms: ["business_major"] },
        );
        shouldFireWith("global_campus_planning_without_away_intent", r);
    });
});

// ----------------------------------------------------------------
// Negatives — the important half: conservative / bounded by design.
// ----------------------------------------------------------------
describe("detectElicitationOpportunity — does NOT fire (bounded/conservative)", () => {
    it("does not fire when declaredPrograms is already set", () => {
        const r = detectElicitationOpportunity("What should I take next semester?", [], WITH_PROGRAM);
        expect(r.shouldElicit).toBe(false);
        expect(r.signals).not.toContain("planning_without_declared_program");
    });

    it("does not fire on a pure factual lookup ('what's my GPA?')", () => {
        const r = detectElicitationOpportunity("What's my GPA?", [], NO_PROGRAMS);
        expect(r.shouldElicit).toBe(false);
    });

    it("does not fire on another pure lookup ('how many credits do I have?')", () => {
        const r = detectElicitationOpportunity("How many credits do I have?", [], NO_PROGRAMS);
        expect(r.shouldElicit).toBe(false);
    });

    it("does not fire on a continuation of a prior assistant question", () => {
        const history: LLMMessage[] = [
            { role: "user", content: "What should I take next semester?" },
            { role: "assistant", content: "Happy to help — what major or direction are you aiming for?" },
        ];
        const r = detectElicitationOpportunity("Economics, probably.", history, NO_PROGRAMS);
        expect(r.shouldElicit).toBe(false);
    });

    it("does not fire on major-exploration when an interest cue is present in history", () => {
        const history: LLMMessage[] = [
            { role: "user", content: "I want to work in data science after graduation." },
            { role: "assistant", content: "Great — that's a clear direction." },
        ];
        const r = detectElicitationOpportunity("Should I major in math or computer science?", history, NO_PROGRAMS);
        expect(r.shouldElicit).toBe(false);
    });

    it("does not fire on major-exploration when an interest cue is in the message itself", () => {
        const r = detectElicitationOpportunity(
            "I'm interested in a career in finance — should I major in economics?",
            [],
            NO_PROGRAMS,
        );
        expect(r.shouldElicit).toBe(false);
    });

    it("does not fire for a global-campus student who already mentioned study-away intent", () => {
        const history: LLMMessage[] = [
            { role: "user", content: "I want to spend a semester studying away in New York." },
            { role: "assistant", content: "Noted — a study-away term in New York." },
        ];
        const r = detectElicitationOpportunity(
            "Can you plan out my next few semesters?",
            history,
            { homeSchool: "nyuad", declaredPrograms: ["computer_science_major"] },
        );
        expect(r.shouldElicit).toBe(false);
    });

    it("does not fire for a CAS (non-global) student on a multi-term plan with a declared program", () => {
        const r = detectElicitationOpportunity(
            "Can you map out my next few semesters?",
            [],
            WITH_PROGRAM,
        );
        // CAS is not a global campus, and the program is declared → nothing to elicit.
        expect(r.shouldElicit).toBe(false);
    });

    it("does not fire when detectAmbiguity already owns the message (overlap suppression)", () => {
        // "a minor?" is an ambiguous fragment the REACTIVE clarifier owns.
        const r = detectElicitationOpportunity("a minor?", [], NO_PROGRAMS);
        expect(r.shouldElicit).toBe(false);
    });

    it("does not fire on a spread of ordinary clear questions (low false-positive rate)", () => {
        const ordinary = [
            "What's my cumulative GPA?",
            "How many credits do I have left?",
            "Does CSCI-UA 472 count toward my major?",
            "What are the prerequisites for Operating Systems?",
            "When is the add/drop deadline this semester?",
            "Is MATH-UA 120 offered in the spring?",
            "What's the residency requirement for my school?",
            "Can I take a course pass/fail?",
        ];
        for (const msg of ordinary) {
            const r = detectElicitationOpportunity(msg, [], WITH_PROGRAM);
            expect(r.shouldElicit, `expected no elicitation for: ${msg}`).toBe(false);
        }
    });
});
