import { describe, it, expect } from "vitest";
import {
    computeBalanceScore,
    classifyBalanceDelta,
    BALANCE_SCORE_COEFFICIENTS,
    type LoadStyle,
} from "../../src/agent/forwardSchedule/balanceScore.js";
import type { ForwardSemester } from "@nyupath/shared";

// --- Helpers ---

function makeSemester(
    term: string,
    plannedCredits: number,
    hardCount: number,
    extraOverrides: Partial<ForwardSemester> = {}
): ForwardSemester {
    return {
        term,
        locked: false,
        slots: [],
        plannedCredits,
        notes: [],
        loadRationale: {
            strategy: "balanced",
            creditsTarget: plannedCredits,
            slack: 0,
            weightedCredits: plannedCredits,
            hardCount,
            easyCount: 0,
            alternativeDistributionsConsidered: [],
        },
        ...extraOverrides,
    };
}

const { weightedCreditsVariance: A, hardCountVariance: B } = BALANCE_SCORE_COEFFICIENTS;

// population variance helper (replicates what balanceScore.ts does internally)
function popVar(arr: number[]): number {
    if (arr.length === 0) return 0;
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    return arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
}

// 1. Perfectly balanced plan → low (ideally 0) score
describe("computeBalanceScore — perfectly balanced", () => {
    it("returns 0 for identical credit-load and hardCount across all terms", () => {
        const semesters = [
            makeSemester("2025-fall", 16, 2),
            makeSemester("2026-spring", 16, 2),
            makeSemester("2026-fall", 16, 2),
        ];
        const score = computeBalanceScore(semesters, "balanced");
        expect(score).toBeCloseTo(0, 3);
    });
});

// 2. One heavy term → moderate score
describe("computeBalanceScore — one heavy term", () => {
    it("returns a moderate positive score when one term has many more credits", () => {
        const semesters = [
            makeSemester("2025-fall", 16, 2),
            makeSemester("2026-spring", 20, 2),  // heavy
            makeSemester("2026-fall", 16, 2),
        ];
        const score = computeBalanceScore(semesters, "balanced");
        const expectedVarianceCredits = popVar([16, 20, 16]);
        expect(score).toBeGreaterThan(0);
        expect(score).toBeCloseTo(A * expectedVarianceCredits, 2);
    });
});

// 3. All hard courses in one term → high score (hardCount variance dominates)
describe("computeBalanceScore — all hard in one term", () => {
    it("returns a high score when all hard courses cluster in one term", () => {
        const semesters = [
            makeSemester("2025-fall", 16, 0),
            makeSemester("2026-spring", 16, 6),  // all hard
            makeSemester("2026-fall", 16, 0),
        ];
        const score = computeBalanceScore(semesters, "balanced");
        const hardVar = popVar([0, 6, 0]);
        expect(score).toBeGreaterThan(0);
        expect(score).toBeCloseTo(B * hardVar, 2);
    });
});

// 4. frontload style with hard courses early → low score
describe("computeBalanceScore — frontload: hard courses early = low", () => {
    it("returns a lower score when credits front-load matches 'frontload' style", () => {
        const semFront = [
            makeSemester("2025-fall", 20, 3),    // heavy early
            makeSemester("2026-spring", 16, 2),
            makeSemester("2026-fall", 12, 1),    // lighter later
        ];
        const semBack = [
            makeSemester("2025-fall", 12, 1),    // lighter early
            makeSemester("2026-spring", 16, 2),
            makeSemester("2026-fall", 20, 3),    // heavy later
        ];
        const frontScore = computeBalanceScore(semFront, "frontload");
        const backScore = computeBalanceScore(semBack, "frontload");
        expect(frontScore).toBeLessThan(backScore);
    });
});

// 5. frontload style with hard courses late → high score (loadStyleDeviation kicks in)
describe("computeBalanceScore — frontload: hard courses late = high penalty", () => {
    it("penalizes credits being late when loadStyle is frontload", () => {
        const semesters = [
            makeSemester("2025-fall", 12, 1),
            makeSemester("2026-spring", 16, 2),
            makeSemester("2026-fall", 20, 3),
        ];
        const score = computeBalanceScore(semesters, "frontload");
        // centroid > median → deviation > 0 → penalty
        expect(score).toBeGreaterThan(0);
    });
});

// 6. backload style with hard courses late → low score
describe("computeBalanceScore — backload: hard courses late = low", () => {
    it("returns a lower score for backloaded plan under 'backload' style", () => {
        const semBack = [
            makeSemester("2025-fall", 12, 1),
            makeSemester("2026-spring", 16, 2),
            makeSemester("2026-fall", 20, 3),
        ];
        const semFront = [
            makeSemester("2025-fall", 20, 3),
            makeSemester("2026-spring", 16, 2),
            makeSemester("2026-fall", 12, 1),
        ];
        const backScore = computeBalanceScore(semBack, "backload");
        const frontScore = computeBalanceScore(semFront, "backload");
        expect(backScore).toBeLessThan(frontScore);
    });
});

// 7. light per-term override → no penalty for balanced semesters
describe("computeBalanceScore — light override behaves like balanced at plan level", () => {
    it("returns ~0 for balanced semesters even when loadStyle is 'light'", () => {
        const semesters = [
            makeSemester("2025-fall", 12, 1),
            makeSemester("2026-spring", 12, 1),
            makeSemester("2026-fall", 12, 1),
        ];
        const score = computeBalanceScore(semesters, "light");
        expect(score).toBeCloseTo(0, 3);
    });
});

// 8. empty semesters → 0
describe("computeBalanceScore — edge case: empty", () => {
    it("returns 0 for an empty semester array", () => {
        expect(computeBalanceScore([], "balanced")).toBe(0);
    });
});

// 9 & 10. classifyBalanceDelta thresholds
describe("classifyBalanceDelta — thresholds", () => {
    it("returns 'improved' when delta ≤ 0", () => {
        expect(classifyBalanceDelta(5, 3)).toBe("improved");
        expect(classifyBalanceDelta(5, 5)).toBe("improved");
    });

    it("returns 'negligible' when |delta| < 1.5", () => {
        expect(classifyBalanceDelta(5, 6)).toBe("negligible");
        expect(classifyBalanceDelta(5, 6.4)).toBe("negligible");
    });

    it("returns 'degraded-mild' when 1.5 ≤ delta < 4", () => {
        expect(classifyBalanceDelta(5, 6.5)).toBe("degraded-mild");
        expect(classifyBalanceDelta(5, 8.9)).toBe("degraded-mild");
    });

    it("returns 'degraded-significant' when delta ≥ 4", () => {
        expect(classifyBalanceDelta(5, 9)).toBe("degraded-significant");
        expect(classifyBalanceDelta(0, 10)).toBe("degraded-significant");
    });
});
