import { describe, it, expect } from "vitest";
import {
    canDropSlot,
    type AuditOptionalityArgs,
} from "../../src/agent/forwardSchedule/auditOptionality.js";
import type { ForwardSchedule, ScheduleSlotSpecificPlanned } from "@nyupath/shared";

// --- Helpers ---

function makeSlot(courseId: string, credits: number, overrides: Partial<ScheduleSlotSpecificPlanned> = {}): ScheduleSlotSpecificPlanned {
    return {
        kind: "specific_planned",
        courseId,
        title: courseId,
        credits,
        satisfiesRules: [],
        reason: "test",
        rationale: {
            satisfiesRequirements: [],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: [],
        },
        downstreamImpact: {
            courseIds: [],
            graduationDelay: 0,
        },
        workloadTier: "major-required",
        workloadWeight: 1.0,
        bindingState: "bound",
        confidence: "historically_likely",
        isCriticalPath: false,
        ...overrides,
    };
}

function makePlan(totalSemesterCredits: number): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "CAS",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [
            {
                term: "2026-fall",
                locked: false,
                slots: [],
                plannedCredits: totalSemesterCredits,
                notes: [],
                loadRationale: {
                    strategy: "balanced",
                    creditsTarget: totalSemesterCredits,
                    slack: 0,
                    weightedCredits: totalSemesterCredits,
                    hardCount: 0,
                    easyCount: 4,
                    alternativeDistributionsConsidered: [],
                },
            },
        ],
        dprCourseHistoryHash: "abc123",
        computedAt: Date.now(),
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

function baseArgs(overrides: Partial<AuditOptionalityArgs> = {}): AuditOptionalityArgs {
    return {
        slot: makeSlot("CSCI-UA 101", 4),
        plan: makePlan(16),
        programRules: {
            degreeCreditMinimum: 128,
            residencyMinCredits: null,
            majorCreditMinimum: null,
            upperLevelMinCredits: null,
            graduationTargetTerm: "2027-spring",
        },
        f1Floor: null,
        perTermCreditsAfterRemoval: new Map([["2026-fall", 12]]),
        forwardFeasibilityAfterRemoval: true,
        ...overrides,
    };
}

// For degree credit: plan has 1 semester × plannedCredits.
// After removal, total = plannedCredits - slot.credits.
// We treat plan total as sum of semesters[].plannedCredits.

// 1. droppable: true when all checks pass
describe("canDropSlot — droppable: true", () => {
    it("returns droppable=true when all constraints pass", () => {
        // Plan has 130 credits total (≥128 minimum) minus 4 = 126 < 128 → need enough credits
        // Use higher total so drop still passes
        const plan = makePlan(70);  // 70 credits in one semester (unrealistic but sufficient for test)
        // post-removal total = 70 - 4 = 66, but minimum is only 40 for this test
        const args = baseArgs({
            plan,
            programRules: {
                degreeCreditMinimum: 40,  // low minimum so drop is safe
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
                graduationTargetTerm: "2027-spring",
            },
            forwardFeasibilityAfterRemoval: true,
        });
        const result = canDropSlot(args);
        expect(result.droppable).toBe(true);
        expect(result.blockingConstraints).toBeUndefined();
    });
});

// 2. fail on degree minimum
describe("canDropSlot — fail: degree minimum", () => {
    it("blocks drop when removing the slot would drop total credits below the minimum", () => {
        // plan has 128 credits in one semester, slot has 4 credits
        // post-removal: 124 < 128 → fail
        const plan = makePlan(128);
        const args = baseArgs({
            slot: makeSlot("CSCI-UA 101", 4),
            plan,
            programRules: {
                degreeCreditMinimum: 128,
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
                graduationTargetTerm: "2027-spring",
            },
        });
        const result = canDropSlot(args);
        expect(result.droppable).toBe(false);
        expect(result.blockingConstraints).toBeDefined();
        expect(result.blockingConstraints!.some(c => /degree.*credit|credit.*minimum/i.test(c))).toBe(true);
    });
});

// 3. fail on F-1 floor (term drops below 12)
describe("canDropSlot — fail: F-1 floor", () => {
    it("blocks drop when a term would fall below F-1 floor after removal", () => {
        const args = baseArgs({
            plan: makePlan(50),  // total sufficient
            programRules: {
                degreeCreditMinimum: 40,
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
                graduationTargetTerm: "2027-spring",
            },
            f1Floor: 12,
            perTermCreditsAfterRemoval: new Map([["2026-fall", 8]]),  // 8 < 12 → fail
            forwardFeasibilityAfterRemoval: true,
        });
        const result = canDropSlot(args);
        expect(result.droppable).toBe(false);
        expect(result.blockingConstraints!.some(c => /f.?1|visa|floor/i.test(c))).toBe(true);
    });
});

// 4. fail on forward-feasibility
describe("canDropSlot — fail: forward-feasibility", () => {
    it("blocks drop when post-removal forward feasibility fails", () => {
        const args = baseArgs({
            plan: makePlan(50),
            programRules: {
                degreeCreditMinimum: 40,
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
                graduationTargetTerm: "2027-spring",
            },
            forwardFeasibilityAfterRemoval: false,  // fails
        });
        const result = canDropSlot(args);
        expect(result.droppable).toBe(false);
        expect(result.blockingConstraints!.some(c => /feasib/i.test(c))).toBe(true);
    });
});

// 5. fail on multiple constraints simultaneously — blockingConstraints lists ALL
describe("canDropSlot — fail: multiple constraints accumulated", () => {
    it("collects all blocking constraints when multiple checks fail simultaneously", () => {
        // degree minimum fail + F-1 floor fail + forward-feasibility fail
        const plan = makePlan(128);  // 128 - 4 = 124 < 128 → degree fail
        const args = baseArgs({
            slot: makeSlot("CSCI-UA 101", 4),
            plan,
            programRules: {
                degreeCreditMinimum: 128,
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
                graduationTargetTerm: "2027-spring",
            },
            f1Floor: 12,
            perTermCreditsAfterRemoval: new Map([["2026-fall", 8]]),  // 8 < 12 → F-1 fail
            forwardFeasibilityAfterRemoval: false,  // feasibility fail
        });
        const result = canDropSlot(args);
        expect(result.droppable).toBe(false);
        // Must have multiple entries — degree + F-1 + feasibility
        expect(result.blockingConstraints!.length).toBeGreaterThanOrEqual(2);
    });
});

// 6. residency check passes when residencyMinCredits is null (no rule)
describe("canDropSlot — residency: null means no check", () => {
    it("does not block when residencyMinCredits is null", () => {
        const args = baseArgs({
            plan: makePlan(50),
            programRules: {
                degreeCreditMinimum: 40,
                residencyMinCredits: null,  // no residency rule
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
                graduationTargetTerm: "2027-spring",
            },
        });
        const result = canDropSlot(args);
        expect(result.droppable).toBe(true);
    });
});
