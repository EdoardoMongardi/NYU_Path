import { describe, it, expect } from "vitest";
import {
    forwardFeasibilityScreen,
    type ForwardFeasibilityArgs,
} from "../../src/agent/forwardSchedule/forwardFeasibility.js";
import type { ConfidenceTier } from "@nyupath/shared";

// --- Helpers ---

function baseArgs(overrides: Partial<ForwardFeasibilityArgs> = {}): ForwardFeasibilityArgs {
    return {
        placedCreditsByTerm: new Map(),
        creditCeilingByTerm: new Map(),
        remainingUnmet: [],
        remainingTerms: [],
        confidenceByCourse: new Map(),
        ...overrides,
    };
}

// 1. Tight schedule that is still feasible → true
describe("forwardFeasibilityScreen — feasible tight schedule", () => {
    it("returns true when demand exactly fits capacity and minDepth ≤ remaining terms", () => {
        const args = baseArgs({
            placedCreditsByTerm: new Map([
                ["2026-fall", 8],
                ["2027-spring", 8],
            ]),
            creditCeilingByTerm: new Map([
                ["2026-fall", 16],
                ["2027-spring", 16],
            ]),
            remainingUnmet: [
                { courseId: "CSCI-UA 101", credits: 4, minDepth: 1 },
                { courseId: "CSCI-UA 201", credits: 4, minDepth: 1 },
            ],
            remainingTerms: ["2026-fall", "2027-spring"],
            confidenceByCourse: new Map([
                ["CSCI-UA 101", "historically_likely" as ConfidenceTier],
                ["CSCI-UA 201", "historically_likely" as ConfidenceTier],
            ]),
        });
        expect(forwardFeasibilityScreen(args)).toBe(true);
    });
});

// 2. Over-stuffed (demand > capacity) → false
describe("forwardFeasibilityScreen — overstuffed plan", () => {
    it("returns false when total credit demand exceeds total remaining capacity", () => {
        const args = baseArgs({
            placedCreditsByTerm: new Map([["2026-fall", 14]]),
            creditCeilingByTerm: new Map([["2026-fall", 16]]),
            remainingUnmet: [
                { courseId: "CSCI-UA 101", credits: 4, minDepth: 1 },
                { courseId: "CSCI-UA 201", credits: 4, minDepth: 1 },
            ],
            remainingTerms: ["2026-fall"],
            confidenceByCourse: new Map([
                ["CSCI-UA 101", "historically_likely" as ConfidenceTier],
                ["CSCI-UA 201", "historically_likely" as ConfidenceTier],
            ]),
        });
        // capacity = 16 - 14 = 2; demand = 8 → false
        expect(forwardFeasibilityScreen(args)).toBe(false);
    });
});

// 3. Pin-induced infeasibility via unmet count given capacity
describe("forwardFeasibilityScreen — pin-induced infeasibility", () => {
    it("returns false when remaining terms can't accommodate all unmet courses given capacity", () => {
        const args = baseArgs({
            placedCreditsByTerm: new Map([
                ["2026-fall", 0],
                ["2027-spring", 0],
            ]),
            creditCeilingByTerm: new Map([
                ["2026-fall", 16],
                ["2027-spring", 16],
            ]),
            remainingUnmet: [
                { courseId: "A", credits: 9, minDepth: 1 },
                { courseId: "B", credits: 9, minDepth: 1 },
                { courseId: "C", credits: 9, minDepth: 1 },
                { courseId: "D", credits: 9, minDepth: 1 },
            ],
            remainingTerms: ["2026-fall", "2027-spring"],
            confidenceByCourse: new Map([
                ["A", "historically_likely" as ConfidenceTier],
                ["B", "historically_likely" as ConfidenceTier],
                ["C", "historically_likely" as ConfidenceTier],
                ["D", "historically_likely" as ConfidenceTier],
            ]),
        });
        // capacity = 32; demand = 36 → false
        expect(forwardFeasibilityScreen(args)).toBe(false);
    });
});

// 4. Low-confidence offering counted as half-capacity (2.0 penalty on demand)
describe("forwardFeasibilityScreen — low-confidence half-capacity penalty", () => {
    it("returns false for irregular course that would fit at full demand but not at 2.0 penalty", () => {
        // Capacity = 16 - 8 = 8 credits
        // One course: 4 credits irregular → effective demand = 4 * 2 = 8 → fits exactly → true
        // Two courses: 4 each irregular → effective demand = 16 → fails
        const argsFits = baseArgs({
            placedCreditsByTerm: new Map([["2026-fall", 8]]),
            creditCeilingByTerm: new Map([["2026-fall", 16]]),
            remainingUnmet: [
                { courseId: "RARE-UA 100", credits: 4, minDepth: 1 },
            ],
            remainingTerms: ["2026-fall"],
            confidenceByCourse: new Map([["RARE-UA 100", "irregular" as ConfidenceTier]]),
        });
        expect(forwardFeasibilityScreen(argsFits)).toBe(true);

        const argsFails = baseArgs({
            placedCreditsByTerm: new Map([["2026-fall", 8]]),
            creditCeilingByTerm: new Map([["2026-fall", 16]]),
            remainingUnmet: [
                { courseId: "RARE-UA 100", credits: 4, minDepth: 1 },
                { courseId: "RARE-UA 200", credits: 4, minDepth: 1 },
            ],
            remainingTerms: ["2026-fall"],
            confidenceByCourse: new Map([
                ["RARE-UA 100", "irregular" as ConfidenceTier],
                ["RARE-UA 200", "permission_only" as ConfidenceTier],
            ]),
        });
        // demand = 4*2 + 4*2 = 16 > capacity 8 → false
        expect(forwardFeasibilityScreen(argsFails)).toBe(false);
    });
});

// 5. prereq-depth edge case: depth ≤ remaining terms → feasible; depth > → infeasible
describe("forwardFeasibilityScreen — depth edge case", () => {
    it("returns true when minDepth exactly equals remainingTerms.length", () => {
        const args = baseArgs({
            placedCreditsByTerm: new Map([
                ["2026-fall", 0],
                ["2027-spring", 0],
            ]),
            creditCeilingByTerm: new Map([
                ["2026-fall", 16],
                ["2027-spring", 16],
            ]),
            remainingUnmet: [
                { courseId: "CSCI-UA 480", credits: 4, minDepth: 2 },
            ],
            remainingTerms: ["2026-fall", "2027-spring"],
            confidenceByCourse: new Map([["CSCI-UA 480", "historically_likely" as ConfidenceTier]]),
        });
        expect(forwardFeasibilityScreen(args)).toBe(true);
    });

    it("returns false when minDepth exceeds remainingTerms.length", () => {
        const args = baseArgs({
            placedCreditsByTerm: new Map([["2026-fall", 0]]),
            creditCeilingByTerm: new Map([["2026-fall", 16]]),
            remainingUnmet: [
                { courseId: "CSCI-UA 480", credits: 4, minDepth: 3 },
            ],
            remainingTerms: ["2026-fall"],
            confidenceByCourse: new Map([["CSCI-UA 480", "historically_likely" as ConfidenceTier]]),
        });
        expect(forwardFeasibilityScreen(args)).toBe(false);
    });
});

// 6. False-positive case: screen returns true for an in-bounds plan that has
//    a hidden choose_n / coreq issue downstream.
//    NOTE: This test confirms the screen IS NOT a proof — it returns true for
//    a plan that appears feasible on capacity+depth alone but would fail the
//    full graduationPathValidator (Phase 13 Task 3.2). The screen is a pruning
//    heuristic only (per Decision #27).
describe("forwardFeasibilityScreen — false-positive: heuristic limitation", () => {
    it("returns true for a plan that passes capacity+depth check despite hidden coreq conflict downstream", () => {
        // Plan looks fine on paper: capacity OK, depths OK.
        // But downstream CSCI-UA 301 requires CSCI-UA 201 as coreq that was
        // already ruled infeasible by the validator (hidden constraint).
        // The SCREEN cannot detect coreq conflicts — it only checks credits + depth.
        const args = baseArgs({
            placedCreditsByTerm: new Map([
                ["2026-fall", 8],
                ["2027-spring", 0],
            ]),
            creditCeilingByTerm: new Map([
                ["2026-fall", 16],
                ["2027-spring", 16],
            ]),
            remainingUnmet: [
                { courseId: "CSCI-UA 201", credits: 4, minDepth: 1 },
                { courseId: "CSCI-UA 301", credits: 4, minDepth: 1 },
            ],
            remainingTerms: ["2026-fall", "2027-spring"],
            confidenceByCourse: new Map([
                ["CSCI-UA 201", "historically_likely" as ConfidenceTier],
                ["CSCI-UA 301", "historically_likely" as ConfidenceTier],
            ]),
        });
        // Screen says: capacity 16 ≥ demand 8, depth 1 ≤ 2 terms → true
        // (Full validator would catch the coreq conflict — out of scope here)
        expect(forwardFeasibilityScreen(args)).toBe(true);
    });
});
