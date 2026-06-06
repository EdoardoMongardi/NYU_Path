/**
 * Phase 2 T1a — feasibility-first search tests (TDD-first).
 * findFirstValidPlan returns the FIRST valid complete leaf and stops — sound +
 * complete for feasibility (finds a valid plan iff one exists when run to
 * exhaustion), but stops at first success so it does NOT enumerate the whole
 * space. On no valid leaf within budget, exhaustive reports proven-infeasible
 * (ran out) vs truncated (hit maxNodes), and blockers/unsatisfiable are
 * populated exactly as searchBestPlan does via computeBlockers.
 *
 * makeMinimalDpr / makeInput / placed are COPIED verbatim from search.test.ts
 * (the established convention: test files copy these helpers between each other).
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    checkOfferingSeasonMatch,
    checkPrereqsSatisfied,
    checkNotClauseClear,
    checkCoreqsSameTerm,
    checkPerTermCeiling,
    checkRequirementCoverage,
    checkMajorCreditFloor,
    checkResidencyFloor,
    type PlacedCourse,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { findFirstValidPlan, searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import { compareSolverTerms } from "../../src/agent/forwardSchedule/solverHelpers.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { PrereqGroup } from "@nyupath/shared";
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
// Suppress unused-variable lint on `placed` (it's part of the copied factory
// set and must stay for convention parity; it may not be used in every test).
// ---------------------------------------------------------------------------
void placed;

// ===========================================================================
// findFirstValidPlan — feasibility-first search
// ===========================================================================

describe("findFirstValidPlan — returns a valid plan fast (feasibility-first)", () => {
    it("the collide case greedy fails: returns a valid plan covering both requirements with distinct courses", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 6,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "C-UA 3"] },
            ],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}],["B-UA 2",{title:"B",credits:4}],["C-UA 3",{title:"C",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall"]],["B-UA 2",["spring"]],["C-UA 3",["spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        const plan = res.plan!;
        expect(checkOfferingSeasonMatch(plan, ctx).ok).toBe(true);
        expect(checkPrereqsSatisfied(plan, ctx).ok).toBe(true);
        expect(checkNotClauseClear(plan, ctx).ok).toBe(true);
        expect(checkCoreqsSameTerm(plan, ctx).ok).toBe(true);
        expect(checkPerTermCeiling(plan, ctx).ok).toBe(true);
        expect(checkRequirementCoverage(plan, ctx).ok).toBe(true);
        expect(checkMajorCreditFloor(plan, ctx).ok).toBe(true);
        expect(checkResidencyFloor(plan, ctx).ok).toBe(true);
        const r1 = plan.placed.find(p => p.satisfiesRId === "r1")?.courseId;
        const r2 = plan.placed.find(p => p.satisfiesRId === "r2")?.courseId;
        expect(r1).not.toBe(r2);
    });

    it("places a prereq before its dependent (leaf-checked prereqs)", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            prereqs: new Map<string, PrereqGroup[]>([["ADV-UA 2", [{ type: "AND", courses: ["BASE-UA 1"] }]]]),
            unmetRequirements: [
                { rId: "rAdv", title: "Adv", category: "major_required", credits: 4, candidateCourses: ["ADV-UA 2"] },
                { rId: "rBase", title: "Base", category: "major_required", credits: 4, candidateCourses: ["BASE-UA 1"] },
            ],
            courseCatalog: new Map([["ADV-UA 2",{title:"Adv",credits:4}],["BASE-UA 1",{title:"Base",credits:4}]]),
            offerings: new Map([["BASE-UA 1",["fall"]],["ADV-UA 2",["spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        const baseTerm = res.plan!.placed.find(p => p.courseId === "BASE-UA 1")!.term;
        const advTerm = res.plan!.placed.find(p => p.courseId === "ADV-UA 2")!.term;
        expect(compareSolverTerms(baseTerm, advTerm)).toBeLessThan(0);
    });

    it("infeasible (summer-only candidate in fall/spring window): null plan, exhaustive, blocker lists the rId", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            unmetRequirements: [{ rId: "rSum", title: "Summer Only", category: "major_required", credits: 4, candidateCourses: ["SUM-UA 1"] }],
            courseCatalog: new Map([["SUM-UA 1",{title:"Summer Only",credits:4}]]),
            offerings: new Map([["SUM-UA 1",["summer"]]]),
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).toBeNull();
        expect(res.exhaustive).toBe(true);
        expect(res.unsatisfiable).toContain("rSum");
        expect(res.blockers.some(b => b.rId === "rSum")).toBe(true);
    });

    it("determinism: two calls on identical input return the identical plan", () => {
        const make = () => makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 8,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
            ],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}],["B-UA 2",{title:"B",credits:4}],["C-UA 3",{title:"C",credits:4}],["D-UA 4",{title:"D",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall","spring"]],["B-UA 2",["fall","spring"]],["C-UA 3",["fall","spring"]],["D-UA 4",["fall","spring"]]]),
        });
        const a = findFirstValidPlan(buildConstraintContext(make()));
        const b = findFirstValidPlan(buildConstraintContext(make()));
        expect(a.plan!.placed).toEqual(b.plan!.placed);
    });

    it("on a single-leaf-optimal case, the first valid leaf is valid and equals searchBestPlan's choice", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            unmetRequirements: [{ rId: "r1", title: "Only", category: "major_required", credits: 4, candidateCourses: ["ONE-UA 1"] }],
            courseCatalog: new Map([["ONE-UA 1",{title:"Only",credits:4}]]),
            offerings: new Map([["ONE-UA 1",["fall","spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const first = findFirstValidPlan(ctx);
        const best = searchBestPlan(ctx);
        expect(first.plan).not.toBeNull();
        expect(checkRequirementCoverage(first.plan!, ctx).ok).toBe(true);
        expect(first.plan!.placed.find(p => p.satisfiesRId === "r1")!.courseId).toBe("ONE-UA 1");
        expect(first.plan!.placed.find(p => p.satisfiesRId === "r1")!.term)
            .toBe(best.plan!.placed.find(p => p.satisfiesRId === "r1")!.term);
    });

    it("stops early: explores FEWER nodes than the full-space searchBestPlan on a multi-leaf input", () => {
        // Two requirements × two candidates each, all fall+spring over a 2-term horizon ⇒
        // many valid leaves. searchBestPlan must visit ALL of them to prove the optimum;
        // findFirstValidPlan stops at the first valid leaf — strictly fewer recursion nodes.
        const make = () => makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
            ],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}],["B-UA 2",{title:"B",credits:4}],["C-UA 3",{title:"C",credits:4}],["D-UA 4",{title:"D",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall","spring"]],["B-UA 2",["fall","spring"]],["C-UA 3",["fall","spring"]],["D-UA 4",["fall","spring"]]]),
        });
        const first = findFirstValidPlan(buildConstraintContext(make()));
        const best = searchBestPlan(buildConstraintContext(make()));
        expect(first.plan).not.toBeNull();
        expect(best.plan).not.toBeNull();
        // The whole point of feasibility-first: it does NOT enumerate the whole space.
        expect(first.nodesExplored).toBeLessThan(best.nodesExplored);
    });
});
