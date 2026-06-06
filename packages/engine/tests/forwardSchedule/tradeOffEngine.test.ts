/**
 * Phase 2 P2.6 — Trade-off engine tests (TDD-first).
 *
 * `diffPlanTradeOffs` fills the consequence fields of a PlanDiff by diffing two
 * ForwardSchedule objects directly:
 *   - newRequiresPetition / removedRequiresPetition (specific_planned slots with
 *     requiresPetition)
 *   - newUnmetRequirements (an rId that had a bound satisfier in BEFORE and lost
 *     it in AFTER)
 *   - cascadedShifts (a course present in both plans whose term changed)
 *   - newAssumptions (an assumption in AFTER with no match in BEFORE)
 *
 * The final test is the EXIT CRITERION: it wires the engine through
 * `buildPlanDiff` and then `explainPlanDiff`, asserting the previously-dead
 * renderer branch (unmet-requirement messaging) now fires.
 *
 * Minimal ForwardSchedule / specific_planned-slot fixtures adapt the
 * specificSlot / semester pattern from materializePlan.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
    diffPlanTradeOffs,
} from "../../src/agent/forwardSchedule/tradeOffEngine.js";
import { buildPlanDiff } from "../../src/agent/forwardSchedule/planChangeHelpers.js";
import { explainPlanDiff } from "../../src/agent/forwardSchedule/explainPlanDiff.js";
import type {
    ForwardSchedule,
    ForwardSemester,
    ScheduleSlot,
    Assumption,
    PlanMutation,
    ValidationResult,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal bound specific_planned slot. */
function specificSlot(
    courseId: string,
    opts: { rules?: string[]; petition?: boolean; credits?: number } = {},
): ScheduleSlot {
    return {
        kind: "specific_planned",
        courseId,
        title: courseId,
        credits: opts.credits ?? 4,
        satisfiesRules: opts.rules ?? [],
        reason: "x",
        ...(opts.petition ? { requiresPetition: true } : {}),
        rationale: {
            satisfiesRequirements: opts.rules ?? [],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: [],
        },
        downstreamImpact: { courseIds: [], graduationDelay: 0 },
        workloadTier: "major-elective",
        workloadWeight: 0.5,
        bindingState: "bound",
        confidence: "historically_partial",
        isCriticalPath: false,
    };
}

/** Minimal in_progress slot. */
function inProgressSlot(courseId: string): ScheduleSlot {
    return { kind: "in_progress", courseId, title: courseId, credits: 4 };
}

/** A ForwardSemester from a term + slots. */
function semester(term: string, slots: ScheduleSlot[]): ForwardSemester {
    const plannedCredits = slots.reduce((s, x) => s + (x.kind === "placeholder" || x.kind === "specific_planned" || x.kind === "completed" || x.kind === "in_progress" ? x.credits : 0), 0);
    return {
        term,
        locked: false,
        slots,
        plannedCredits,
        notes: [],
        loadRationale: {
            strategy: "balanced",
            creditsTarget: 16,
            slack: 0,
            weightedCredits: 0,
            hardCount: 0,
            easyCount: 0,
            alternativeDistributionsConsidered: [],
        },
    };
}

/** A minimal ForwardSchedule from semesters + optional assumptions. */
function forwardSchedule(
    semesters: ForwardSemester[],
    assumptions: Assumption[] = [],
): ForwardSchedule {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters,
        dprCourseHistoryHash: "h",
        computedAt: 0,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 1,
        assumptions,
    };
}

const IP_ASSUMPTION = (courseId: string): Assumption => ({
    type: "IP_COURSE_COMPLETION",
    courseId,
    consequenceIfFalse: "x",
    cascadingSlots: [],
    contingencyPlanAvailable: false,
});

// ===========================================================================
// 1. Petitions
// ===========================================================================

describe("diffPlanTradeOffs — petitions", () => {
    it("a course flagged requiresPetition only in AFTER appears in newRequiresPetition", () => {
        const before = forwardSchedule([semester("2026-fall", [specificSlot("CSCI-UA 1")])]);
        const after = forwardSchedule([
            semester("2026-fall", [specificSlot("CSCI-UA 1", { petition: true })]),
        ]);

        const t = diffPlanTradeOffs(before, after);
        expect(t.newRequiresPetition).toEqual(["CSCI-UA 1"]);
        expect(t.removedRequiresPetition).toEqual([]);
    });

    it("a course flagged requiresPetition only in BEFORE appears in removedRequiresPetition", () => {
        const before = forwardSchedule([
            semester("2026-fall", [specificSlot("CSCI-UA 1", { petition: true })]),
        ]);
        const after = forwardSchedule([semester("2026-fall", [specificSlot("CSCI-UA 1")])]);

        const t = diffPlanTradeOffs(before, after);
        expect(t.newRequiresPetition).toEqual([]);
        expect(t.removedRequiresPetition).toEqual(["CSCI-UA 1"]);
    });

    it("a petition present in both is in neither list; output is sorted", () => {
        const before = forwardSchedule([
            semester("2026-fall", [
                specificSlot("B-UA 2", { petition: true }),
                specificSlot("A-UA 1", { petition: true }),
            ]),
        ]);
        const after = forwardSchedule([
            semester("2026-fall", [
                specificSlot("A-UA 1", { petition: true }), // unchanged
                specificSlot("C-UA 3", { petition: true }), // new
            ]),
        ]);

        const t = diffPlanTradeOffs(before, after);
        expect(t.newRequiresPetition).toEqual(["C-UA 3"]);
        expect(t.removedRequiresPetition).toEqual(["B-UA 2"]);
    });
});

// ===========================================================================
// 2. newUnmetRequirements
// ===========================================================================

describe("diffPlanTradeOffs — newUnmetRequirements", () => {
    it("an rId covered by a bound slot in BEFORE but lost in AFTER becomes newly-unmet", () => {
        const before = forwardSchedule([
            semester("2026-fall", [specificSlot("CSCI-UA 1", { rules: ["R1"] })]),
        ]);
        // AFTER no longer binds R1 (the course is gone entirely).
        const after = forwardSchedule([semester("2026-fall", [])]);

        const t = diffPlanTradeOffs(before, after);
        expect(t.newUnmetRequirements).toEqual(["R1"]);
    });

    it("no-change case: a requirement still covered in AFTER is NOT newly-unmet → []", () => {
        const before = forwardSchedule([
            semester("2026-fall", [specificSlot("CSCI-UA 1", { rules: ["R1"] })]),
        ]);
        // AFTER binds R1 with a different course → still covered.
        const after = forwardSchedule([
            semester("2026-fall", [specificSlot("CSCI-UA 9", { rules: ["R1"] })]),
        ]);

        const t = diffPlanTradeOffs(before, after);
        expect(t.newUnmetRequirements).toEqual([]);
    });
});

// ===========================================================================
// 3. cascadedShifts
// ===========================================================================

describe("diffPlanTradeOffs — cascadedShifts", () => {
    it("a course at 2026-fall before and 2027-spring after yields one shift", () => {
        const before = forwardSchedule([
            semester("2026-fall", [specificSlot("MATH-UA 5")]),
            semester("2027-spring", []),
        ]);
        const after = forwardSchedule([
            semester("2026-fall", []),
            semester("2027-spring", [specificSlot("MATH-UA 5")]),
        ]);

        const t = diffPlanTradeOffs(before, after);
        expect(t.cascadedShifts).toEqual([
            {
                courseId: "MATH-UA 5",
                fromTerm: "2026-fall",
                toTerm: "2027-spring",
                becauseOf: "plan re-solved after the change",
            },
        ]);
    });

    it("covers in_progress slots too, and sorts shifts by courseId", () => {
        const before = forwardSchedule([
            semester("2026-fall", [inProgressSlot("Z-UA 9"), specificSlot("A-UA 1")]),
            semester("2027-spring", []),
        ]);
        const after = forwardSchedule([
            semester("2026-fall", []),
            semester("2027-spring", [specificSlot("A-UA 1"), inProgressSlot("Z-UA 9")]),
        ]);

        const t = diffPlanTradeOffs(before, after);
        expect(t.cascadedShifts.map(s => s.courseId)).toEqual(["A-UA 1", "Z-UA 9"]);
    });

    it("a course that did not move yields no shift", () => {
        const before = forwardSchedule([semester("2026-fall", [specificSlot("A-UA 1")])]);
        const after = forwardSchedule([semester("2026-fall", [specificSlot("A-UA 1")])]);
        expect(diffPlanTradeOffs(before, after).cascadedShifts).toEqual([]);
    });
});

// ===========================================================================
// 4. newAssumptions
// ===========================================================================

describe("diffPlanTradeOffs — newAssumptions", () => {
    it("an IP_COURSE_COMPLETION assumption in AFTER that BEFORE lacks appears", () => {
        const before = forwardSchedule([semester("2026-fall", [])], []);
        const after = forwardSchedule(
            [semester("2026-fall", [])],
            [IP_ASSUMPTION("PRE-UA 1")],
        );

        const t = diffPlanTradeOffs(before, after);
        expect(t.newAssumptions).toHaveLength(1);
        expect(t.newAssumptions[0]).toMatchObject({ type: "IP_COURSE_COMPLETION", courseId: "PRE-UA 1" });
    });

    it("a matching IP_COURSE_COMPLETION assumption (same courseId) is excluded", () => {
        const before = forwardSchedule(
            [semester("2026-fall", [])],
            [IP_ASSUMPTION("PRE-UA 1")],
        );
        const after = forwardSchedule(
            [semester("2026-fall", [])],
            [IP_ASSUMPTION("PRE-UA 1"), IP_ASSUMPTION("PRE-UA 2")],
        );

        const t = diffPlanTradeOffs(before, after);
        // Only PRE-UA 2 is new; PRE-UA 1 matched by (type, courseId).
        expect(t.newAssumptions).toHaveLength(1);
        expect(t.newAssumptions[0]).toMatchObject({ courseId: "PRE-UA 2" });
    });
});

// ===========================================================================
// 5. before undefined
// ===========================================================================

describe("diffPlanTradeOffs — before undefined", () => {
    it("all 'new*' reflect AFTER's contents; 'removed*' empty; cascades empty", () => {
        const after = forwardSchedule(
            [
                semester("2026-fall", [
                    specificSlot("CSCI-UA 1", { rules: ["R1"], petition: true }),
                ]),
            ],
            [IP_ASSUMPTION("PRE-UA 1")],
        );

        const t = diffPlanTradeOffs(undefined, after);
        expect(t.newRequiresPetition).toEqual(["CSCI-UA 1"]);
        expect(t.removedRequiresPetition).toEqual([]);
        // newUnmetRequirements is BEFORE − AFTER; with no BEFORE there is nothing
        // that "lost" a satisfier → empty (even though AFTER covers R1).
        expect(t.newUnmetRequirements).toEqual([]);
        expect(t.cascadedShifts).toEqual([]);
        expect(t.newAssumptions).toHaveLength(1);
        expect(t.newAssumptions[0]).toMatchObject({ courseId: "PRE-UA 1" });
    });
});

// ===========================================================================
// 6. Renderer integration — the EXIT CRITERION
// ===========================================================================

describe("buildPlanDiff + explainPlanDiff — previously-dead renderer branch now fires", () => {
    it("dropping a course that leaves a requirement unmet surfaces the unmet rId in the rendered string", () => {
        // BEFORE: MATH-UA 343 binds the 'Calculus I' requirement.
        const before = forwardSchedule([
            semester("2026-fall", [specificSlot("MATH-UA 343", { rules: ["Calculus I"] })]),
        ]);
        // AFTER: the course (and its only satisfier of that requirement) is gone.
        const after = forwardSchedule([semester("2026-fall", [])]);

        const diff = buildPlanDiff(before, after);

        // The trade-off engine populated the previously-hollow field.
        expect(diff.newUnmetRequirements).toEqual(["Calculus I"]);

        // The renderer's exclude template now has a non-empty field to surface.
        const mutation: PlanMutation = { kind: "exclude", courseId: "MATH-UA 343", term: "2026-fall" };
        const rendered = explainPlanDiff(diff, mutation);
        expect(rendered).toMatch(/Unmet requirement/);
        expect(rendered).toContain("Calculus I");
    });

    it("a swap that newly requires a petition surfaces it via the issues-short branch", () => {
        // BEFORE: no petitions. AFTER: the added course requires a petition, and
        // no other (higher-priority) issue exists → renderIssuesShort falls through
        // to the newRequiresPetition branch.
        const before = forwardSchedule([
            semester("2026-fall", [specificSlot("CORE-UA 700", { rules: ["Core"] })]),
        ]);
        const after = forwardSchedule([
            semester("2026-fall", [
                specificSlot("CORE-UA 555", { rules: ["Core"], petition: true }),
            ]),
        ]);

        const diff = buildPlanDiff(before, after);
        expect(diff.newRequiresPetition).toEqual(["CORE-UA 555"]);
        // 'Core' is still covered by CORE-UA 555 → no newly-unmet requirement.
        expect(diff.newUnmetRequirements).toEqual([]);

        const mutation: PlanMutation = { kind: "swap", drop: "CORE-UA 700", add: "CORE-UA 555", term: "2026-fall" };
        const rendered = explainPlanDiff(diff, mutation);
        expect(rendered).toMatch(/New petition required/);
        expect(rendered).toContain("CORE-UA 555");
    });
});

// ===========================================================================
// validationResultsChanges (P2.7) — per-axis ValidationResult transitions
// ===========================================================================

describe("buildPlanDiff — validationResultsChanges (P2.7)", () => {
    const before = forwardSchedule([semester("2026-fall", [specificSlot("CSCI-UA 1", { rules: ["R1"] })])]);
    const after = forwardSchedule([semester("2026-fall", [])]);

    it("records an axis whose ValidationResult changed (pass → fail) and skips unchanged axes", () => {
        const beforeAxes: Record<string, ValidationResult> = {
            requirementGroupsSatisfied: { status: "pass", verifiedFrom: "DPR" },
            totalCreditsMeetMinimum: { status: "pass", verifiedFrom: "DPR" },
        };
        const afterAxes: Record<string, ValidationResult> = {
            requirementGroupsSatisfied: { status: "fail", reason: "R1 not satisfied by plan or DPR" },
            totalCreditsMeetMinimum: { status: "pass", verifiedFrom: "DPR" },
        };

        const diff = buildPlanDiff(before, after, { before: beforeAxes, after: afterAxes });

        // The flipped axis is recorded with both endpoints...
        expect(diff.validationResultsChanges.requirementGroupsSatisfied).toEqual({
            before: { status: "pass", verifiedFrom: "DPR" },
            after: { status: "fail", reason: "R1 not satisfied by plan or DPR" },
        });
        // ...and the unchanged axis is NOT recorded.
        expect(diff.validationResultsChanges.totalCreditsMeetMinimum).toBeUndefined();
    });

    it("is empty {} when no validator axes are supplied (backward-compatible build path)", () => {
        const diff = buildPlanDiff(before, after);
        expect(diff.validationResultsChanges).toEqual({});
    });
});
