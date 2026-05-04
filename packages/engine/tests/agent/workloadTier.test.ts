import { describe, it, expect } from "vitest";
import {
    classifyWorkloadTier,
    type WorkloadTierClassifyArgs,
} from "../../src/agent/forwardSchedule/workloadTier.js";
import type { Prerequisite } from "@nyupath/shared";

// --- Helpers ---

function baseArgs(overrides: Partial<WorkloadTierClassifyArgs> = {}): WorkloadTierClassifyArgs {
    return {
        courseId: "CSCI-UA 0101",
        satisfiesRules: [],
        majorRuleKinds: new Map(),
        schoolCoreRuleIds: new Set(),
        generalCategoryRuleIds: new Set(),
        ...overrides,
    };
}

// 1. major-required from must_take rule
describe("classifyWorkloadTier — major-required (must_take)", () => {
    it("returns tier=major-required and weight=1.0 for a must_take rule", () => {
        const args = baseArgs({
            satisfiesRules: ["CS_CORE_REQUIRED"],
            majorRuleKinds: new Map([["CS_CORE_REQUIRED", "must_take"]]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("major-required");
        expect(result.weight).toBe(1.0);
    });
});

// 2. major-elective from choose_n rule
describe("classifyWorkloadTier — major-elective (choose_n)", () => {
    it("returns tier=major-elective and weight=1.0 for a choose_n rule", () => {
        const args = baseArgs({
            satisfiesRules: ["CS_ELECTIVE_POOL"],
            majorRuleKinds: new Map([["CS_ELECTIVE_POOL", "choose_n"]]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("major-elective");
        expect(result.weight).toBe(1.0);
    });
});

// 3. school-core from school-core ruleId
describe("classifyWorkloadTier — school-core", () => {
    it("returns tier=school-core and weight=1.0 for a school-core rule", () => {
        const args = baseArgs({
            satisfiesRules: ["CAS_WRITING_CORE"],
            schoolCoreRuleIds: new Set(["CAS_WRITING_CORE"]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("school-core");
        expect(result.weight).toBe(1.0);
    });
});

// 4. free-elective from isOptional: true
describe("classifyWorkloadTier — free-elective (isOptional)", () => {
    it("returns tier=free-elective and weight=0.5 when isOptional=true", () => {
        const args = baseArgs({ isOptional: true });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("free-elective");
        expect(result.weight).toBe(0.5);
    });
});

// 5. general-elective from generalCategoryRuleIds
describe("classifyWorkloadTier — general-elective", () => {
    it("returns tier=general-elective and weight=0.6 for a general-category rule", () => {
        const args = baseArgs({
            satisfiesRules: ["GEN_ELECTIVE_ARTS"],
            generalCategoryRuleIds: new Set(["GEN_ELECTIVE_ARTS"]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("general-elective");
        expect(result.weight).toBeCloseTo(0.6);
    });
});

// 6. Capstone bump (≥3 prereq groups) — tier unchanged, weight +0.2
describe("classifyWorkloadTier — capstone bump", () => {
    it("adds +0.2 when course has ≥3 prereqGroups (capstone signal)", () => {
        const prereqsEntry: Pick<Prerequisite, "prereqGroups"> = {
            prereqGroups: [
                { courses: ["A"], logic: "all_of" },
                { courses: ["B"], logic: "all_of" },
                { courses: ["C"], logic: "all_of" },
            ],
        };
        const args = baseArgs({
            satisfiesRules: ["CS_CORE_REQUIRED"],
            majorRuleKinds: new Map([["CS_CORE_REQUIRED", "must_take"]]),
            prereqsEntry,
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("major-required");
        expect(result.weight).toBeCloseTo(1.2);
    });
});

// 7. W-suffix bump → +0.2
describe("classifyWorkloadTier — W-suffix bump", () => {
    it("adds +0.2 for courseId ending in W", () => {
        const args = baseArgs({
            courseId: "EXPW-UA 9W",
            satisfiesRules: ["CAS_WRITING_CORE"],
            schoolCoreRuleIds: new Set(["CAS_WRITING_CORE"]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("school-core");
        expect(result.weight).toBeCloseTo(1.2);
    });

    it("adds +0.2 when bulletinKeywords includes 'writing-intensive'", () => {
        const args = baseArgs({
            satisfiesRules: ["CAS_WRITING_CORE"],
            schoolCoreRuleIds: new Set(["CAS_WRITING_CORE"]),
            bulletinKeywords: ["writing-intensive"],
        });
        const result = classifyWorkloadTier(args);
        expect(result.weight).toBeCloseTo(1.2);
    });
});

// 8. L-suffix bump → +0.15
describe("classifyWorkloadTier — L-suffix bump", () => {
    it("adds +0.15 for courseId ending in L", () => {
        const args = baseArgs({
            courseId: "CHEM-UA 125L",
            satisfiesRules: ["CAS_WRITING_CORE"],
            schoolCoreRuleIds: new Set(["CAS_WRITING_CORE"]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.weight).toBeCloseTo(1.15);
    });

    it("adds +0.15 when bulletinTitleHasLab (title contains 'Lab')", () => {
        const args = baseArgs({
            bulletinTitle: "Chemistry Lab I",
            satisfiesRules: ["CAS_WRITING_CORE"],
            schoolCoreRuleIds: new Set(["CAS_WRITING_CORE"]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.weight).toBeCloseTo(1.15);
    });
});

// 9. Advanced level bump — CSCI-UA 4xxx
describe("classifyWorkloadTier — advanced level bump (+0.2)", () => {
    it("adds +0.2 for CAS course ≥4000 level (CSCI-UA 4xxx)", () => {
        const args = baseArgs({
            courseId: "CSCI-UA 4700",
            satisfiesRules: ["CS_CORE_REQUIRED"],
            majorRuleKinds: new Map([["CS_CORE_REQUIRED", "must_take"]]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.weight).toBeCloseTo(1.2);
    });

    it("does NOT add advanced bump for CAS course <4000 (CSCI-UA 3xxx)", () => {
        const args = baseArgs({
            courseId: "CSCI-UA 3800",
            satisfiesRules: ["CS_CORE_REQUIRED"],
            majorRuleKinds: new Map([["CS_CORE_REQUIRED", "must_take"]]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.weight).toBeCloseTo(1.0);
    });

    it("adds +0.2 for Tandon course ≥3000 (CSCI-UY 3xxx)", () => {
        const args = baseArgs({
            courseId: "CSCI-UY 3200",
            satisfiesRules: ["CS_CORE_REQUIRED"],
            majorRuleKinds: new Map([["CS_CORE_REQUIRED", "must_take"]]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.weight).toBeCloseTo(1.2);
    });
});

// 10. Modifier stacking-cap: W + L + advanced + capstone → cap at +0.6
describe("classifyWorkloadTier — modifier cap (+0.6 max)", () => {
    it("caps total modifier at +0.6 even when raw sum exceeds 0.6", () => {
        // W = +0.2, L = +0.15, advanced (UA 4xxx) = +0.2, capstone (3 groups) = +0.2
        // raw sum = 0.75, capped at 0.6 → final weight = 1.0 + 0.6 = 1.6
        const prereqsEntry: Pick<Prerequisite, "prereqGroups"> = {
            prereqGroups: [
                { courses: ["A"], logic: "all_of" },
                { courses: ["B"], logic: "all_of" },
                { courses: ["C"], logic: "all_of" },
            ],
        };
        const args = baseArgs({
            courseId: "CSCI-UA 4900W",  // W suffix + UA + 4xxx
            satisfiesRules: ["CS_CORE_REQUIRED"],
            majorRuleKinds: new Map([["CS_CORE_REQUIRED", "must_take"]]),
            bulletinTitle: "Senior Capstone Lab",  // L in title (Lab)
            prereqsEntry,
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("major-required");
        // base 1.0 + cap(0.75) = 1.0 + 0.6 = 1.6
        expect(result.weight).toBeCloseTo(1.6);
    });
});

// 11. Tier-precedence: course satisfies BOTH major-required and school-core → major-required wins
describe("classifyWorkloadTier — tier precedence", () => {
    it("major-required wins over school-core when course satisfies both rules", () => {
        const args = baseArgs({
            satisfiesRules: ["CS_CORE_REQUIRED", "CAS_WRITING_CORE"],
            majorRuleKinds: new Map([["CS_CORE_REQUIRED", "must_take"]]),
            schoolCoreRuleIds: new Set(["CAS_WRITING_CORE"]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("major-required");
    });

    it("major-elective wins over general-elective", () => {
        const args = baseArgs({
            satisfiesRules: ["CS_ELECTIVE_POOL", "GEN_ELECTIVE_ARTS"],
            majorRuleKinds: new Map([["CS_ELECTIVE_POOL", "choose_n"]]),
            generalCategoryRuleIds: new Set(["GEN_ELECTIVE_ARTS"]),
        });
        const result = classifyWorkloadTier(args);
        expect(result.tier).toBe("major-elective");
    });
});
