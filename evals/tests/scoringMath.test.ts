// ============================================================
// Bakeoff scoring-math unit tests
// ============================================================
// Pure math; no LLM calls. Run via:
//   npx vitest run evals/tests/scoringMath.test.ts
// ============================================================

import { describe, expect, it } from "vitest";
import { matchesShape } from "../bakeoffRunner.js";
import { agentScore, gateReport, GATES } from "../modelBakeoff.js";

describe("matchesShape", () => {
    it("exact string value match", () => {
        expect(matchesShape({ a: "b" }, { a: "b" })).toBe(true);
    });
    it("string mismatch fails", () => {
        expect(matchesShape({ a: "x" }, { a: "b" })).toBe(false);
    });
    it("missing key fails", () => {
        expect(matchesShape({}, { a: "b" })).toBe(false);
    });
    it("extra actual keys are allowed", () => {
        expect(matchesShape({ a: "b", c: "d" }, { a: "b" })).toBe(true);
    });
    it("type:'string' accepts any string", () => {
        expect(matchesShape({ a: "anything" }, { a: { type: "string" } })).toBe(true);
        expect(matchesShape({ a: 42 }, { a: { type: "string" } })).toBe(false);
    });
    it("type:'integer' rejects floats", () => {
        expect(matchesShape({ a: 5 }, { a: { type: "integer" } })).toBe(true);
        expect(matchesShape({ a: 5.5 }, { a: { type: "integer" } })).toBe(false);
    });
    it("type:'array' check", () => {
        expect(matchesShape({ a: [1, 2] }, { a: { type: "array" } })).toBe(true);
        expect(matchesShape({ a: "not-an-array" }, { a: { type: "array" } })).toBe(false);
    });

    it("JSONSchema-style format (B): required property must be present", () => {
        const expected = {
            type: "object",
            properties: { targetSchool: { type: "string" } },
            required: ["targetSchool"],
        };
        expect(matchesShape({ targetSchool: "stern" }, expected)).toBe(true);
        expect(matchesShape({ targetSchool: 42 }, expected)).toBe(false);
        expect(matchesShape({}, expected)).toBe(false);
    });

    it("JSONSchema-style format (B): optional property may be absent", () => {
        const expected = {
            type: "object",
            properties: { programFilter: { type: "string", optional: true } },
        };
        expect(matchesShape({}, expected)).toBe(true);
        expect(matchesShape({ programFilter: "cs_major_ba" }, expected)).toBe(true);
        // Present with wrong type → fail
        expect(matchesShape({ programFilter: 42 }, expected)).toBe(false);
    });

    it("JSONSchema-style format (B): extra keys allowed", () => {
        const expected = {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
        };
        expect(matchesShape({ a: "x", b: 99 }, expected)).toBe(true);
    });

    it("Format A: '_note' annotation fields are skipped", () => {
        expect(matchesShape({ a: "x" }, { a: "x", _note: "doc" })).toBe(true);
    });
});

describe("agentScore weights (§6.5.1: 0.4 / 0.4 / 0.2)", () => {
    it("perfect across all three", () => {
        const s = agentScore({
            tsToolScore: 1, tsSynthesisScore: 1, tsDecompScore: 1,
            p50LatencyMs: 0, costPerThousandTurnsUsd: 0,
        });
        expect(s).toBe(1);
    });
    it("tool-only scorer", () => {
        const s = agentScore({
            tsToolScore: 1, tsSynthesisScore: 0, tsDecompScore: 0,
            p50LatencyMs: 0, costPerThousandTurnsUsd: 0,
        });
        expect(s).toBeCloseTo(0.4, 6);
    });
    it("decomp-only scorer", () => {
        const s = agentScore({
            tsToolScore: 0, tsSynthesisScore: 0, tsDecompScore: 1,
            p50LatencyMs: 0, costPerThousandTurnsUsd: 0,
        });
        expect(s).toBeCloseTo(0.2, 6);
    });
});

describe("gateReport thresholds", () => {
    it("min agent-score gate", () => {
        const r = gateReport({ agentScore: GATES.minAgentScore - 0.001, p50LatencyMs: 0 }, GATES.minAgentScore);
        expect(r.minAgentScorePassed).toBe(false);
    });
    it("max latency gate", () => {
        const r = gateReport({ agentScore: 1, p50LatencyMs: GATES.maxP50LatencyMs + 1 }, 1);
        expect(r.maxLatencyPassed).toBe(false);
    });
    it("within-5pct-of-top gate", () => {
        const r1 = gateReport({ agentScore: 0.95, p50LatencyMs: 0 }, 1.0);
        expect(r1.within5PctOfTopPassed).toBe(true);
        const r2 = gateReport({ agentScore: 0.94, p50LatencyMs: 0 }, 1.0);
        expect(r2.within5PctOfTopPassed).toBe(false);
    });
});
