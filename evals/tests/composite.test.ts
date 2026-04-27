// ============================================================
// Phase 6.5 P-5 — Appendix D composite scorer tests
// ============================================================

import { describe, expect, it } from "vitest";
import { scoreTurn, aggregateCohort, COMPOSITE_WEIGHTS } from "../cohort/composite.js";
import type { ToolInvocation } from "../../packages/engine/src/agent/index.js";

const noInvocations: ToolInvocation[] = [];

describe("scoreTurn — §D.1 grounding", () => {
    it("scores 1.0 when there are no claims to ground", () => {
        const r = scoreTurn(
            { assistantText: "Hello there.", invocations: noInvocations },
            { userMessage: "hi" },
        );
        expect(r.dimensions.grounding).toBe(1);
    });

    it("scores 1.0 when every claim appears in a tool result", () => {
        const r = scoreTurn(
            {
                assistantText: "Your GPA is 3.42 with 64 credits.",
                invocations: [
                    { toolName: "run_full_audit", args: {}, summary: "GPA 3.42 / 64 credits" },
                ],
            },
            { userMessage: "audit me" },
        );
        expect(r.dimensions.grounding).toBe(1);
    });

    it("scores 0.5 when one of two claims is ungrounded", () => {
        const r = scoreTurn(
            {
                assistantText: "Your GPA is 3.42 and you have 999 credits.",
                invocations: [
                    { toolName: "run_full_audit", args: {}, summary: "GPA 3.42 only" },
                ],
            },
            { userMessage: "audit me" },
        );
        expect(r.dimensions.grounding).toBe(0.5);
    });
});

describe("scoreTurn — §D.2 completeness", () => {
    it("scores 1.0 when no caveats are required", () => {
        const r = scoreTurn(
            { assistantText: "Sure!", invocations: noInvocations },
            { userMessage: "hi" },
        );
        expect(r.dimensions.completeness).toBe(1);
    });

    it("scores by mentioned/applicable on required caveats", () => {
        const r = scoreTurn(
            {
                assistantText: "F-1 students must keep at least 12 credits this term.",
                invocations: noInvocations,
            },
            {
                userMessage: "drop class",
                requiredCaveats: ["F-1", "12 credits", "consult adviser"],
            },
        );
        // Mentions "F-1" and "12 credits" but not "consult adviser".
        expect(r.dimensions.completeness).toBeCloseTo(2 / 3);
    });
});

describe("scoreTurn — §D.3 uncertainty transparency", () => {
    it("scores 1.0 when no adviser hedge is required", () => {
        const r = scoreTurn(
            { assistantText: "ok", invocations: noInvocations },
            { userMessage: "hi" },
        );
        expect(r.dimensions.uncertainty).toBe(1);
    });

    it("scores 1.0 when hedge is required AND present", () => {
        const r = scoreTurn(
            { assistantText: "I'd recommend you consult your adviser.", invocations: noInvocations },
            { userMessage: "edge case", requiresAdviserCaveat: true },
        );
        expect(r.dimensions.uncertainty).toBe(1);
    });

    it("scores 0.0 when hedge is required but absent", () => {
        const r = scoreTurn(
            { assistantText: "Definitely yes.", invocations: noInvocations },
            { userMessage: "edge case", requiresAdviserCaveat: true },
        );
        expect(r.dimensions.uncertainty).toBe(0);
    });
});

describe("scoreTurn — §D.4 non-fabrication", () => {
    it("scores 1.0 when no forbidden patterns match", () => {
        const r = scoreTurn(
            { assistantText: "Take CSCI-UA 101.", invocations: noInvocations },
            {
                userMessage: "what next?",
                validCourseIds: ["CSCI-UA 101"],
            },
        );
        expect(r.dimensions.nonFabrication).toBe(1);
    });

    it("scores 0.0 when reply cites a course NOT in the whitelist", () => {
        const r = scoreTurn(
            { assistantText: "Take CSCI-UA 999 (a fictional course).", invocations: noInvocations },
            {
                userMessage: "what next?",
                validCourseIds: ["CSCI-UA 101"],
            },
        );
        expect(r.dimensions.nonFabrication).toBe(0);
    });

    it("scores 0.0 when a forbiddenPattern matches", () => {
        const r = scoreTurn(
            { assistantText: "P/F is allowed for the major.", invocations: noInvocations },
            {
                userMessage: "p/f major",
                forbiddenPatterns: [/\bp\/f is allowed for the major\b/i],
            },
        );
        expect(r.dimensions.nonFabrication).toBe(0);
    });
});

describe("composite scoring (§D.5 weighted)", () => {
    it("weights match the architecture exactly", () => {
        expect(COMPOSITE_WEIGHTS.grounding).toBe(0.30);
        expect(COMPOSITE_WEIGHTS.completeness).toBe(0.35);
        expect(COMPOSITE_WEIGHTS.uncertainty).toBe(0.20);
        expect(COMPOSITE_WEIGHTS.nonFabrication).toBe(0.15);
    });

    it("a perfect turn scores 1.0 (within float precision)", () => {
        const r = scoreTurn(
            { assistantText: "OK", invocations: noInvocations },
            { userMessage: "hi" },
        );
        expect(r.composite).toBeCloseTo(1);
    });

    it("composite is the weighted sum", () => {
        const r = scoreTurn(
            {
                assistantText: "Your GPA is 3.42 and you have 999 credits.",
                invocations: [{ toolName: "run_full_audit", args: {}, summary: "GPA 3.42" }],
            },
            { userMessage: "audit", requiredCaveats: ["F-1"], requiresAdviserCaveat: true },
        );
        // grounding=0.5, completeness=0 (no F-1), uncertainty=0 (no hedge), non-fab=1
        const expected =
            COMPOSITE_WEIGHTS.grounding * 0.5
            + COMPOSITE_WEIGHTS.completeness * 0
            + COMPOSITE_WEIGHTS.uncertainty * 0
            + COMPOSITE_WEIGHTS.nonFabrication * 1;
        expect(r.composite).toBeCloseTo(expected);
    });
});

describe("aggregateCohort", () => {
    it("returns 0 for an empty report set", () => {
        const r = aggregateCohort([]);
        expect(r.composite).toBe(0);
    });

    it("averages dimensions across turns + applies weights", () => {
        const a = scoreTurn(
            { assistantText: "OK", invocations: noInvocations },
            { userMessage: "x" },
        );
        const b = scoreTurn(
            {
                assistantText: "Definitely.",
                invocations: noInvocations,
            },
            { userMessage: "edge", requiresAdviserCaveat: true },
        );
        const agg = aggregateCohort([a, b]);
        expect(agg.dimensions.uncertainty).toBeCloseTo((1 + 0) / 2);
        expect(agg.composite).toBeLessThan(1); // b dragged the cohort down
        expect(agg.perCaseScores).toHaveLength(2);
    });
});

describe("invocation-coverage notes", () => {
    it("reports a missing expected tool call without dropping the composite", () => {
        const r = scoreTurn(
            { assistantText: "OK", invocations: [] },
            { userMessage: "audit me", expectedToolCalls: ["run_full_audit"] },
        );
        expect(r.composite).toBeCloseTo(1); // composite isn't affected
        expect(r.notes.some((n) => n.includes("[invocation]") && n.includes("run_full_audit"))).toBe(true);
    });

    it("reports a forbidden tool call", () => {
        const r = scoreTurn(
            {
                assistantText: "ok",
                invocations: [{ toolName: "plan_semester", args: {}, summary: "plan" }],
            },
            { userMessage: "hi", forbiddenToolCalls: ["plan_semester"] },
        );
        expect(r.notes.some((n) => n.includes("[invocation]") && n.includes("forbidden tool"))).toBe(true);
    });
});
