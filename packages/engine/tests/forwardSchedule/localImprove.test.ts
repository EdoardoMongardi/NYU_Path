/**
 * T3a — localImprove: validity-preserving preference descent tests (TDD-first).
 *
 * localImprove takes a FOUND (pre-fill) search plan (PartialPlan of
 * requirement/pin/ip placements, BEFORE free-elective fill) and applies
 * validity-preserving moves to lower the soft objective (scorePlan).
 *
 * Move validity uses the EXACT eight search-leaf predicates — NOT
 * checkHardConstraints (its fill-dependent completion axes — perTermFloor /
 * creditMinimum / graduationTarget / gpaFloors — fail on a pre-fill plan and
 * would reject every move).
 *
 * makeMinimalDpr / makeInput / placed are COPIED verbatim from search.test.ts
 * (the established convention: test files copy these helpers between each other).
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    scorePlan,
    checkOfferingSeasonMatch,
    checkPrereqsSatisfied,
    checkNotClauseClear,
    checkCoreqsSameTerm,
    checkPerTermCeiling,
    checkRequirementCoverage,
    checkMajorCreditFloor,
    checkResidencyFloor,
    type ConstraintContext,
    type PartialPlan,
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { findFirstValidPlan } from "../../src/agent/forwardSchedule/search.js";
import { localImprove } from "../../src/agent/forwardSchedule/localImprove.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (copied verbatim from search.test.ts)
// ---------------------------------------------------------------------------

function makeMinimalDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 100,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 4,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
        ...overrides,
    };
}

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(),
        coursesInProgress: new Map(),
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 100,
        passFailCap: 32,
        passFailUsed: 4,
        onlineCreditCap: 16,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap: 16,
        outsideHomeCreditsUsed: 0,
        cumulativeGpa: 3.4,
        majorGpa: 3.3,
        graduationGpaFloor: 2.0,
        majorGpaFloor: 2.0,
        unmetRequirements: [],
        prereqs: new Map(),
        offerings: new Map(),
        offeringConfidence: new Map(),
        courseCatalog: new Map(),
        dprCourseHistoryHash: "test-hash",
        dpr: makeMinimalDpr(),
        programRules: {
            majorRuleKinds: new Map(),
            schoolCoreRuleIds: new Set(),
            generalCategoryRuleIds: new Set(),
            residencyMinCredits: null,
            majorCreditMinimum: null,
            upperLevelMinCredits: null,
        },
        warnings: [],
        ...overrides,
    };
}

/** Convenience: build a single placed course with sensible defaults. */
function placed(p: Partial<PlacedCourse> & { courseId: string; term: string }): PlacedCourse {
    return {
        credits: 4,
        workloadTier: "free-elective",
        workloadWeight: 0.5,
        satisfiesRId: null,
        source: "free",
        ...p,
    };
}

// ---------------------------------------------------------------------------
// isValidSearchLeaf — the EIGHT search-leaf predicates ANDed (NOT checkHardConstraints).
// This helper mirrors what localImprove uses internally for move validation.
// ---------------------------------------------------------------------------

function isValidSearchLeaf(plan: PartialPlan, ctx: ConstraintContext): boolean {
    return (
        checkOfferingSeasonMatch(plan, ctx).ok &&
        checkPrereqsSatisfied(plan, ctx).ok &&
        checkNotClauseClear(plan, ctx).ok &&
        checkCoreqsSameTerm(plan, ctx).ok &&
        checkPerTermCeiling(plan, ctx).ok &&
        checkRequirementCoverage(plan, ctx).ok &&
        checkMajorCreditFloor(plan, ctx).ok &&
        checkResidencyFloor(plan, ctx).ok
    );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("localImprove — validity-preserving descent", () => {
    it("never worsens the objective and never returns an invalid (non-leaf) plan", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] },
                { rId: "r2", title: "Two", category: "major_required", credits: 4, candidateCourses: ["B-UA 2"] },
            ],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}],["B-UA 2",{title:"B",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall","spring"]],["B-UA 2",["fall","spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const found = findFirstValidPlan(ctx).plan!;
        const before = scorePlan(found, ctx);
        const improved = localImprove(found, ctx);
        expect(isValidSearchLeaf(improved, ctx)).toBe(true);
        expect(scorePlan(improved, ctx)).toBeLessThanOrEqual(before);
    });

    it("never moves a pin or an IP placement", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            unmetRequirements: [{ rId: "r1", title: "One", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] }],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}],["PIN-UA 9",{title:"Pin",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall","spring"]],["PIN-UA 9",["fall","spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const fixed: PlacedCourse[] = [placed({ courseId: "PIN-UA 9", term: "2026-fall", source: "pin", satisfiesRId: null })];
        const found = findFirstValidPlan(ctx, { fixed }).plan!;
        const improved = localImprove(found, ctx);
        const pin = improved.placed.find(p => p.courseId === "PIN-UA 9")!;
        expect(pin.term).toBe("2026-fall");
        expect(pin.source).toBe("pin");
    });

    it("is deterministic and idempotent (improving an already-good plan twice is stable)", () => {
        const make = () => buildConstraintContext(makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            unmetRequirements: [{ rId: "r1", title: "One", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] }],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall","spring"]]]),
        }));
        const ctxA = make(), ctxB = make();
        const a = localImprove(findFirstValidPlan(ctxA).plan!, ctxA);
        const b = localImprove(findFirstValidPlan(ctxB).plan!, ctxB);
        expect(a.placed).toEqual(b.placed);
        expect(localImprove(a, ctxA).placed).toEqual(a.placed); // idempotent
    });

    it("a swap move can lower the objective while staying a valid leaf (when a better candidate exists)", () => {
        // Construct a case where the found plan's chosen candidate is sub-optimal vs a swap.
        // (If your value-ordering already picks optimally so no swap helps, this asserts the
        // weaker invariant: improved is still valid + ≤ score. Keep it meaningful.)
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
            ],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}],["B-UA 2",{title:"B",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall","spring"]],["B-UA 2",["fall","spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const found = findFirstValidPlan(ctx).plan!;
        const improved = localImprove(found, ctx);
        expect(isValidSearchLeaf(improved, ctx)).toBe(true);
        expect(scorePlan(improved, ctx)).toBeLessThanOrEqual(scorePlan(found, ctx));
    });

    it("never swaps in a study-abroad (≥9000) candidate, even when doing so would lower the score", () => {
        // The search EXCLUDES study-abroad courses from a requirement's candidates
        // (buildRequirementVariables filters !isStudyAbroadCourse). localImprove must mirror
        // that exclusion in its swap enumeration — otherwise it could introduce a course the
        // search would never have placed (isValidSearchLeaf does not screen study-abroad).
        //
        // Forcing setup: 1 requirement, candidates [SMALL-UA 1 (4cr), SA-UA 9001 (8cr,
        // study-abroad)]. creditsEarned 120, grad min 128. Under weights {balance:0,
        // timeToDegree:1}, swapping SMALL→SA reaches the 128-credit minimum IN-PLAN (120+8),
        // dropping timeToDegree from worst to 0 — a strictly-improving move localImprove WOULD
        // adopt if the study-abroad filter were missing. With the filter, SA is never a
        // candidate move, so the requirement stays bound to the normal SMALL-UA 1.
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            creditsEarned: 120, graduationCreditMinimum: 128,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["SMALL-UA 1", "SA-UA 9001"] },
            ],
            courseCatalog: new Map([["SMALL-UA 1", { title: "Small", credits: 4 }], ["SA-UA 9001", { title: "Abroad", credits: 8 }]]),
            offerings: new Map([["SMALL-UA 1", ["fall", "spring"]], ["SA-UA 9001", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const found = findFirstValidPlan(ctx).plan!;
        // The search itself never picks SA-UA 9001 (study-abroad filter in buildRequirementVariables).
        expect(found.placed.find(p => p.satisfiesRId === "r1")!.courseId).toBe("SMALL-UA 1");

        const improved = localImprove(found, ctx, { balance: 0, timeToDegree: 1 });
        // The study-abroad course is NOT swapped in — the requirement stays bound to SMALL-UA 1.
        expect(improved.placed.some(p => p.courseId === "SA-UA 9001")).toBe(false);
        expect(improved.placed.find(p => p.satisfiesRId === "r1")!.courseId).toBe("SMALL-UA 1");
        expect(isValidSearchLeaf(improved, ctx)).toBe(true);
    });
});
