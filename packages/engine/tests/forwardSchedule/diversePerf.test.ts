/**
 * Perf: findDiverseValidPlans must NOT re-search to the full DEFAULT_MAX_NODES
 * (200k) budget on its terminal "no-more-distinct-plans" iteration.
 *
 * The winner is found separately with the full budget (solver.ts) and is
 * unaffected; only the *alternatives* generator was slow. The fix caps each
 * diverse iteration at DIVERSE_MAX_NODES (20k) so the terminal iteration gives
 * up fast; alternatives become best-effort (may return < k).
 *
 * Fixture: a strict 6-deep prereq chain (CH-UA 1 → … → CH-UA 6) that exactly
 * fills a 6-main-term horizon ⇒ EXACTLY ONE valid plan (each course in its
 * prereq-ordered term). Forbidding that one plan forces the search to explore the
 * whole space to prove "no other distinct plan": ~55,795 nodes uncapped — well
 * above the 20k cap (deterministic; no wall-clock assertions).
 *
 * Factories mirror search.test.ts / diversePlans.test.ts.
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
    type PartialPlan,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import {
    findFirstValidPlan,
    findDiverseValidPlans,
    reqSignature,
    DIVERSE_MAX_NODES,
} from "../../src/agent/forwardSchedule/search.js";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport, PrereqGroup } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Factories (verbatim shape from search.test.ts / diversePlans.test.ts)
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
            creditsUsed: 104,
            cumulativeGpa: 3.4,
            cumulativeGpaRequired: 2.0,
            residencyRequired: null,
            residencyUsed: null,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [],
        ...overrides,
    } as unknown as DegreeProgressReport;
}

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: undefined,
        coursesTaken: new Set(),
        coursesInProgress: new Map(),
        currentTerm: "2024-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: 8,
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 104,
        passFailCap: 32,
        passFailUsed: 0,
        onlineCreditCap: null,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap: null,
        outsideHomeCreditsUsed: 0,
        cumulativeGpa: 3.4,
        majorGpa: null,
        graduationGpaFloor: 2.0,
        majorGpaFloor: null,
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

/**
 * Strict N-deep prereq chain that exactly fills an N-main-term horizon ⇒ exactly
 * one valid plan. Course i requires course i-1; single candidate per requirement;
 * all offered fall+spring; ceiling generous. N=6 ⇒ graduationTerm "2027-spring".
 */
function chainInput(n: number, gradTerm: string): SolverInput {
    const reqs: SolverInput["unmetRequirements"] = [];
    const catalog = new Map<string, { title: string; credits: number }>();
    const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
    const prereqs = new Map<string, PrereqGroup[]>();
    for (let i = 1; i <= n; i++) {
        const id = `CH-UA ${i}`;
        reqs.push({ rId: `r${i}`, title: `Chain ${i}`, category: "major_required", credits: 4, candidateCourses: [id] });
        catalog.set(id, { title: id, credits: 4 });
        offerings.set(id, ["fall", "spring"]);
        if (i > 1) prereqs.set(id, [{ type: "AND", courses: [`CH-UA ${i - 1}`] } as PrereqGroup]);
    }
    return makeInput({ currentTerm: "2024-fall", graduationTerm: gradTerm, unmetRequirements: reqs, courseCatalog: catalog, offerings, prereqs });
}

/** All 8 search-leaf predicates. */
function isValidLeaf(plan: PartialPlan, ctx: ReturnType<typeof buildConstraintContext>): boolean {
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
// 1. The cap constant exists and is well below the default budget.
// ===========================================================================

describe("findDiverseValidPlans perf — DIVERSE_MAX_NODES cap", () => {
    it("DIVERSE_MAX_NODES is a small per-iteration cap (20k), far below the 200k default", () => {
        expect(DIVERSE_MAX_NODES).toBe(20_000);
        expect(DIVERSE_MAX_NODES).toBeLessThan(200_000);
    });

    // =======================================================================
    // 2. Terminal forbidden-signature iteration is bounded by the cap.
    // =======================================================================
    it("the terminal forbidden-winner iteration is bounded by the cap, not the full budget", () => {
        const ctx = buildConstraintContext(chainInput(6, "2027-spring"));
        const winner = findFirstValidPlan(ctx);
        expect(winner.plan).not.toBeNull();
        const winnerSig = reqSignature(winner.plan!);

        // Fixture property: WITHOUT a cap, proving "no other distinct plan" explores
        // the whole space — far more than the cap (deterministically ~55,795 nodes).
        const uncapped = findFirstValidPlan(ctx, { forbiddenSignatures: new Set([winnerSig]) });
        expect(uncapped.plan).toBeNull();
        expect(uncapped.nodesExplored).toBeGreaterThan(DIVERSE_MAX_NODES);

        // The fix's cap bounds that exact iteration: it truncates (exhaustive === false)
        // at the cap (nodesExplored = cap + 1 when the budget is hit) — strictly fewer
        // nodes than the uncapped search.
        const capped = findFirstValidPlan(ctx, {
            forbiddenSignatures: new Set([winnerSig]),
            maxNodes: DIVERSE_MAX_NODES,
        });
        expect(capped.plan).toBeNull();
        expect(capped.exhaustive).toBe(false);
        expect(capped.nodesExplored).toBeLessThanOrEqual(DIVERSE_MAX_NODES + 1);
        expect(capped.nodesExplored).toBeLessThan(uncapped.nodesExplored);
    });

    it("returns just the winner on a single-valid-plan input (no hang, result unchanged by the cap)", () => {
        const ctx = buildConstraintContext(chainInput(6, "2027-spring"));
        const winnerSig = reqSignature(findFirstValidPlan(ctx).plan!);
        const diverse = findDiverseValidPlans(ctx, { k: 5 });
        expect(diverse).toHaveLength(1);
        expect(reqSignature(diverse[0]!)).toBe(winnerSig);
        expect(isValidLeaf(diverse[0]!, ctx)).toBe(true);
    });

    // =======================================================================
    // 3. No regression when distinct plans are cheap to find.
    // =======================================================================
    it("still returns multiple distinct valid plans when alternatives are cheap", () => {
        // 3 independent requirements, each with 2 interchangeable candidates, over 2
        // terms ⇒ many cheap distinct valid plans (each found in a handful of nodes,
        // far under the cap), so the cap does not reduce the alternatives.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 18,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
                { rId: "r3", title: "Three", category: "major_elective", credits: 4, candidateCourses: ["E-UA 5", "F-UA 6"] },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }],
                ["B-UA 2", { title: "B", credits: 4 }],
                ["C-UA 3", { title: "C", credits: 4 }],
                ["D-UA 4", { title: "D", credits: 4 }],
                ["E-UA 5", { title: "E", credits: 4 }],
                ["F-UA 6", { title: "F", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]],
                ["B-UA 2", ["fall", "spring"]],
                ["C-UA 3", ["fall", "spring"]],
                ["D-UA 4", ["fall", "spring"]],
                ["E-UA 5", ["fall", "spring"]],
                ["F-UA 6", ["fall", "spring"]],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const plans = findDiverseValidPlans(ctx, { k: 5 });

        expect(plans.length).toBeGreaterThanOrEqual(3);
        expect(plans.length).toBeLessThanOrEqual(5);
        for (const p of plans) expect(isValidLeaf(p, ctx)).toBe(true);
        // Pairwise distinct.
        const sigs = plans.map(reqSignature);
        expect(new Set(sigs).size).toBe(sigs.length);
        // plans[0] is still findFirstValidPlan's first plan (the cap never changes the winner).
        expect(plans[0]!.placed).toEqual(findFirstValidPlan(ctx).plan!.placed);
    });

    // =======================================================================
    // 4. The winner is unaffected end-to-end.
    // =======================================================================
    it("the winner is unaffected: solveForwardSchedule returns the same valid plan", () => {
        const input = chainInput(6, "2027-spring");
        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(true);

        // The single valid plan places the chain in strict prereq order; assert the
        // endpoints (which pin the whole arrangement) among the bound slots.
        const boundTermOf = new Map<string, string>();
        for (const sem of out.semesters) {
            for (const slot of sem.slots) {
                if (slot.kind === "specific_planned") boundTermOf.set(slot.courseId, sem.term);
            }
        }
        expect(boundTermOf.get("CH-UA 1")).toBe("2024-fall");
        expect(boundTermOf.get("CH-UA 6")).toBe("2027-spring");
    });
});
