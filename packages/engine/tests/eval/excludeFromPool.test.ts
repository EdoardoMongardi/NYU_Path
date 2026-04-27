// ============================================================
// Phase 7-A P-2 — excludeFromPool regression tests
// ============================================================
// Pins the new pool-exclusion semantics:
//   - choose_n with `excludeFromPool` correctly skips excluded
//     courses even when they match the include wildcard
//   - PHIL-UA 1-8 (introductory) cannot satisfy the
//     cas_philosophy_ba electives requirement (2 additional
//     PHIL-UA courses)
//   - Rules without `excludeFromPool` behave identically to before
//     (back-compat)
// ============================================================

import { describe, expect, it } from "vitest";
import { evaluateRule } from "../../src/audit/ruleEvaluator.js";
import { EquivalenceResolver } from "../../src/equivalence/equivalenceResolver.js";
import type { Course, Rule } from "@nyupath/shared";

const equivalence = new EquivalenceResolver([]);
const catalog = new Map<string, Course>();

const philElectivesRule: Rule = {
    ruleId: "phil_electives",
    label: "Two PHIL-UA Major Electives (excluding intro 1-8)",
    type: "choose_n",
    doubleCountPolicy: "disallow",
    catalogYearRange: ["2018", "2030"],
    n: 2,
    fromPool: ["PHIL-UA *"],
    excludeFromPool: [
        "PHIL-UA 1", "PHIL-UA 2", "PHIL-UA 3", "PHIL-UA 4",
        "PHIL-UA 5", "PHIL-UA 6", "PHIL-UA 7", "PHIL-UA 8",
    ],
};

describe("excludeFromPool (Phase 7-A P-2)", () => {
    it("does NOT count PHIL-UA 1-8 toward the elective requirement", () => {
        const completed = new Set([
            "PHIL-UA 1",   // intro — excluded
            "PHIL-UA 2",   // intro — excluded
            "PHIL-UA 70",  // logic — not excluded BUT (in real audit) covered by phil_logic
        ]);
        const result = evaluateRule(philElectivesRule, completed, catalog, equivalence);
        // Only PHIL-UA 70 satisfies; needs 2, has 1 → unsatisfied.
        expect(result.coursesSatisfying).toEqual(["PHIL-UA 70"]);
        expect(result.status).not.toBe("satisfied");
        expect(result.remaining).toBe(1);
    });

    it("counts non-introductory PHIL-UA courses (numbered ≥ 9) toward the elective", () => {
        const completed = new Set([
            "PHIL-UA 90",   // Phil of Sci — non-intro, eligible
            "PHIL-UA 101",  // Topics — non-intro, eligible
            "PHIL-UA 1",    // intro — excluded
        ]);
        const result = evaluateRule(philElectivesRule, completed, catalog, equivalence);
        expect(result.coursesSatisfying.sort()).toEqual(["PHIL-UA 101", "PHIL-UA 90"]);
        expect(result.status).toBe("satisfied");
    });

    it("rules without excludeFromPool behave identically to before (back-compat)", () => {
        const ruleNoExclude: Rule = {
            ruleId: "no_exclude",
            label: "Any 2 PHIL-UA",
            type: "choose_n",
            doubleCountPolicy: "disallow",
            catalogYearRange: ["2018", "2030"],
            n: 2,
            fromPool: ["PHIL-UA *"],
        };
        const completed = new Set(["PHIL-UA 1", "PHIL-UA 2"]);
        const result = evaluateRule(ruleNoExclude, completed, catalog, equivalence);
        // Without an exclusion list, intro courses count.
        expect(result.coursesSatisfying.sort()).toEqual(["PHIL-UA 1", "PHIL-UA 2"]);
        expect(result.status).toBe("satisfied");
    });

    it("handles non-wildcard excludeFromPool entries (exact-id exclusions)", () => {
        const ruleExactExclude: Rule = {
            ruleId: "exact_exclude",
            label: "Any PHIL-UA except specifically PHIL-UA 70",
            type: "choose_n",
            doubleCountPolicy: "disallow",
            catalogYearRange: ["2018", "2030"],
            n: 1,
            fromPool: ["PHIL-UA *"],
            excludeFromPool: ["PHIL-UA 70"],
        };
        const completed = new Set(["PHIL-UA 70"]);
        const result = evaluateRule(ruleExactExclude, completed, catalog, equivalence);
        expect(result.coursesSatisfying).toEqual([]);
        expect(result.status).not.toBe("satisfied");
    });
});
