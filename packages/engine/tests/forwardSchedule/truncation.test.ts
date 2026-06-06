/**
 * Phase 2 review C1 — search-truncation surfacing (TDD-first).
 *
 * The constraint search is COMPLETE + OPTIMAL only WITHIN its `maxNodes` budget;
 * `exhaustive === false` means the space was NOT fully explored. The headline
 * silent-failure bug was that the solver consumed only `top.plans/.blockers` and
 * NEVER read `top.exhaustive`, so a truncated search could present a non-optimal
 * plan as optimal, or — worse — report a false "infeasible". This file pins the
 * honest surfacing:
 *
 *   1. truncationWarning(exhaustive, hasValidPlan, nodesExplored) — the pure
 *      helper, all three cases.
 *   2. searchTopKPlans with a tiny maxNodes on a multi-leaf input → exhaustive
 *      === false (it truncates).
 *   3. solveForwardSchedule forced to truncate (via the test-supporting maxNodes
 *      seam):
 *        (a) truncated WITH a valid winner → the output `warnings` carry the
 *            "valid but may not be most preferred" advisory, and the returned plan
 *            is still valid (not downgraded).
 *        (b) truncated WITHOUT a valid plan, NO real blockers → the "feasibility
 *            could not be confirmed" advisory is present AND the result is NOT
 *            presented with a definitive capacity / proven-infeasible verdict
 *            (the capacity diagnostic is gated on exhaustive).
 *        (c) CONTROL: the SAME capacity fixture run EXHAUSTIVELY (default budget)
 *            still surfaces the capacity diagnostic — proving the gate only
 *            suppresses under truncation, never on the proven path.
 *
 * makeMinimalDpr / makeInput / placed are copied (minimal) from search.test.ts.
 */

import { describe, it, expect } from "vitest";
import { buildConstraintContext, type PlacedCourse } from "../../src/agent/forwardSchedule/constraintModel.js";
import { searchTopKPlans } from "../../src/agent/forwardSchedule/search.js";
import {
    solveForwardSchedule,
    truncationWarning,
} from "../../src/agent/forwardSchedule/solver.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

// ---------------------------------------------------------------------------
// Shared minimal DPR + SolverInput factories (copied from search.test.ts)
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

// The truncation advisory's stable signature (matches truncationWarning).
const TRUNC_PREFIX = "Plan search was truncated after";

// ===========================================================================
// 1. truncationWarning — the pure helper (three cases)
// ===========================================================================

describe("truncationWarning — pure helper", () => {
    it("exhaustive → null (no advisory; today's proven verdicts hold)", () => {
        expect(truncationWarning(true, true, 42)).toBeNull();
        expect(truncationWarning(true, false, 42)).toBeNull();
    });

    it("truncated WITH a valid plan → 'valid but may not be most preferred' advisory naming nodesExplored", () => {
        const msg = truncationWarning(false, true, 1234);
        expect(msg).not.toBeNull();
        expect(msg!).toContain(TRUNC_PREFIX);
        expect(msg!).toContain("1234");
        // It must NOT claim infeasibility / unconfirmed — the plan is valid.
        expect(msg!).toMatch(/valid but may not be the most preferred/i);
        expect(msg!).not.toMatch(/could not be confirmed/i);
    });

    it("truncated WITHOUT a valid plan → 'feasibility could not be confirmed' (NOT proven infeasible)", () => {
        const msg = truncationWarning(false, false, 5);
        expect(msg).not.toBeNull();
        expect(msg!).toContain(TRUNC_PREFIX);
        expect(msg!).toContain("5");
        expect(msg!).toMatch(/feasibility could not be confirmed/i);
        // It must explicitly hold open that a valid plan may still exist (not infeasible).
        expect(msg!).toMatch(/may still exist/i);
    });
});

// ===========================================================================
// 2. searchTopKPlans — a tiny maxNodes truncates a multi-leaf input
// ===========================================================================

describe("searchTopKPlans — tiny maxNodes truncates", () => {
    // 2 requirements × 2 candidates each, all offered fall+spring, 2-term window,
    // generous ceiling ⇒ many valid (course, term) leaves. maxNodes:5 cannot
    // explore them all ⇒ exhaustive === false.
    function multiLeafInput(): SolverInput {
        return makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 18,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }],
                ["B-UA 2", { title: "B", credits: 4 }],
                ["C-UA 3", { title: "C", credits: 4 }],
                ["D-UA 4", { title: "D", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]],
                ["B-UA 2", ["fall", "spring"]],
                ["C-UA 3", ["fall", "spring"]],
                ["D-UA 4", ["fall", "spring"]],
            ]),
        });
    }

    it("exhaustive === false under a tiny budget, but exhaustive === true under the default", () => {
        const ctx = buildConstraintContext(multiLeafInput());

        const truncated = searchTopKPlans(ctx, { k: 5, maxNodes: 5 });
        expect(truncated.exhaustive).toBe(false);
        expect(truncated.nodesExplored).toBeGreaterThan(0);

        // Same fixture, default budget → fully explored.
        const full = searchTopKPlans(ctx, { k: 5 });
        expect(full.exhaustive).toBe(true);
    });

    it("any plan returned under truncation is still VALID (passed the completion-leaf check)", () => {
        const ctx = buildConstraintContext(multiLeafInput());
        // A modestly larger tiny budget tends to surface ≥1 valid leaf before truncating.
        const truncated = searchTopKPlans(ctx, { k: 5, maxNodes: 6 });
        expect(truncated.exhaustive).toBe(false);
        // The search may or may not have reached a leaf in 6 nodes; if it did, that
        // leaf is valid (the search only emits leaves that pass the hard checks).
        for (const plan of truncated.plans) {
            // Every placement is a real (course, term); coverage is the validator's
            // job, but a returned leaf always covered both requirements.
            const rIds = new Set(plan.placed.filter(p => p.satisfiesRId).map(p => p.satisfiesRId));
            expect(rIds.has("r1")).toBe(true);
            expect(rIds.has("r2")).toBe(true);
        }
    });
});

// ===========================================================================
// 3. solveForwardSchedule — truncation gating (the C1 headline)
// ===========================================================================

describe("solveForwardSchedule — truncation surfacing + gating (C1)", () => {
    // ---- (a) truncated WITH a valid winner ----
    it("truncated-with-plan: warnings carry the 'valid but maybe not preferred' advisory; the plan is NOT downgraded", () => {
        // Multi-leaf feasible input. A budget large enough to find a valid winner
        // but too small to exhaust the space → exhaustive false, plans non-empty.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 18,
            creditsEarned: 120,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }],
                ["B-UA 2", { title: "B", credits: 4 }],
                ["C-UA 3", { title: "C", credits: 4 }],
                ["D-UA 4", { title: "D", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]],
                ["B-UA 2", ["fall", "spring"]],
                ["C-UA 3", ["fall", "spring"]],
                ["D-UA 4", ["fall", "spring"]],
            ]),
        });

        // maxNodes 6: reaches ≥1 valid leaf (first leaf is at recursion depth 2)
        // yet truncates before exhausting the multi-leaf tree.
        const out = solveForwardSchedule(input, 6);

        expect(out.warnings).toBeDefined();
        const advisory = out.warnings!.find(w => w.startsWith(TRUNC_PREFIX));
        expect(advisory).toBeDefined();
        expect(advisory!).toMatch(/valid but may not be the most preferred/i);

        // The winner is materialised normally — both requirements are placed as
        // specific courses (the valid winner is returned as-is, not downgraded to
        // an all-placeholder/infeasible plan).
        const placedCourseIds = out.semesters
            .flatMap(s => s.slots)
            .filter(s => s.kind === "specific_planned")
            .map(s => (s as { courseId: string }).courseId);
        expect(placedCourseIds.length).toBeGreaterThanOrEqual(2);
    });

    // ---- (b) truncated WITHOUT a valid plan, no real blockers ----
    // The capacity fixture from infeasibility.test.ts: THREE 4-cr requirements into
    // a single 8-cr term. Each is INDIVIDUALLY placeable (4 ≤ 8) so NO per-
    // requirement blocker fires; the only infeasibility signal is the JOINT
    // capacity diagnostic. Run with a tiny budget so the search truncates before
    // reaching any complete leaf → no plan, no blockers.
    function capacityInput(): SolverInput {
        return makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            creditCeiling: 8,
            creditsEarned: 124,
            unmetRequirements: [
                { rId: "rA", title: "Req A", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] },
                { rId: "rB", title: "Req B", category: "major_required", credits: 4, candidateCourses: ["B-UA 2"] },
                { rId: "rC", title: "Req C", category: "major_required", credits: 4, candidateCourses: ["C-UA 3"] },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "Req A", credits: 4 }],
                ["B-UA 2", { title: "Req B", credits: 4 }],
                ["C-UA 3", { title: "Req C", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]],
                ["B-UA 2", ["fall", "spring"]],
                ["C-UA 3", ["fall", "spring"]],
            ]),
        });
    }

    it("truncated-without-plan: surfaces the 'could not be confirmed' advisory and does NOT emit the proven capacity verdict", () => {
        // maxNodes 2: the recursion stops at node 3 (3 > 2) BEFORE reaching any
        // depth-3 leaf → plans empty, search truncated, no individual blockers.
        const out = solveForwardSchedule(capacityInput(), 2);

        // The honest truncation advisory is present and is the feasibility-unconfirmed flavour.
        expect(out.warnings).toBeDefined();
        const advisory = out.warnings!.find(w => w.startsWith(TRUNC_PREFIX));
        expect(advisory).toBeDefined();
        expect(advisory!).toMatch(/feasibility could not be confirmed/i);

        // CRITICAL: the capacity diagnostic ("~12 credits ... credits of capacity
        // exist") must NOT be emitted — it is a PROVEN joint-infeasibility verdict,
        // gated on exhaustive. Under truncation it is suppressed.
        const capacityVerdict = out.feasibility.constraintViolations.find(v =>
            /credits of capacity exist/.test(v.detail),
        );
        expect(capacityVerdict).toBeUndefined();

        // And no per-requirement blocker fired either (each req is individually
        // placeable), so there is NO definitive "this requirement is unplaceable"
        // framing masquerading as proven infeasibility.
        const blockerVerdict = out.feasibility.constraintViolations.find(v =>
            /no candidate|cannot be placed|prerequisite chain|excluded by a NOT/i.test(v.detail),
        );
        expect(blockerVerdict).toBeUndefined();
    });

    // ---- (c) CONTROL: the SAME fixture, exhaustively, STILL proves capacity infeasible ----
    it("exhaustive control: the same capacity fixture at the default budget DOES surface the capacity verdict (gate only suppresses under truncation)", () => {
        const out = solveForwardSchedule(capacityInput()); // default budget → exhaustive

        // No truncation advisory on the proven path.
        const advisory = (out.warnings ?? []).find(w => w.startsWith(TRUNC_PREFIX));
        expect(advisory).toBeUndefined();

        // The capacity diagnostic IS proven and surfaced (unchanged from P2.9).
        expect(out.feasibility.feasible).toBe(false);
        const capacityVerdict = out.feasibility.constraintViolations.find(
            v => v.kind === "graduation_total" && /credits of capacity exist/.test(v.detail),
        );
        expect(capacityVerdict).toBeDefined();
        expect(capacityVerdict!.detail).toContain("12");
        expect(capacityVerdict!.detail).toContain("8");
    });

    it("no truncation on a small feasible input at the default budget → no advisory, plan feasible", () => {
        // A trivially small, fully-explorable feasible input must carry NO
        // truncation advisory (exhaustive → truncationWarning returns null).
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 18,
            creditsEarned: 120,
            unmetRequirements: [
                { rId: "rA", title: "Req A", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] },
                { rId: "rB", title: "Req B", category: "major_required", credits: 4, candidateCourses: ["B-UA 2"] },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "Req A", credits: 4 }],
                ["B-UA 2", { title: "Req B", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]],
                ["B-UA 2", ["fall", "spring"]],
            ]),
        });
        const out = solveForwardSchedule(input);
        const advisory = (out.warnings ?? []).find(w => w.startsWith(TRUNC_PREFIX));
        expect(advisory).toBeUndefined();
        expect(out.feasibility.feasible).toBe(true);
    });

    it("build-time warnings are preserved AND the truncation advisory is appended (not replaced)", () => {
        // input.warnings (the P2.10 channel) must survive alongside the C1 advisory.
        const base = capacityInput();
        const input = makeInput({ ...base, warnings: ["[build] assumed a default degree minimum."] });
        const out = solveForwardSchedule(input, 2);

        expect(out.warnings).toBeDefined();
        // The pre-existing build advisory is still present...
        expect(out.warnings!.some(w => w.includes("assumed a default degree minimum"))).toBe(true);
        // ...and the truncation advisory was appended.
        expect(out.warnings!.some(w => w.startsWith(TRUNC_PREFIX))).toBe(true);
    });
});
