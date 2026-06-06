/**
 * Phase 2 P2.9 / PLAN-13 — REAL infeasibility explanation tests (TDD-first).
 *
 * When a plan is infeasible the engine must report the ACTUAL binding constraint,
 * not a generic "could not be placed in any valid (course, term)" stub. This file
 * pins:
 *   1. offering blocker      — a requirement whose only candidate is never offered
 *                              in the window → blocker kind "offering_pattern".
 *   2. ceiling blocker       — fixed pins fill every term to the ceiling so no
 *                              candidate value fits → blocker kind "credit_ceiling".
 *   3. prereq-depth blocker  — a candidate's prereq chain is deeper than the window
 *                              → blocker kind "prereq_unsatisfiable" with depth/window.
 *   4. capacity diagnostic   — unmet requirements whose total credits exceed the
 *                              window capacity → solveForwardSchedule surfaces a
 *                              graduation_total capacity sentence (credits + gradTerm).
 *   5. contingencyPlanAvailable — real STRUCTURAL determination: an IP course whose
 *                              dependent CAN move later → true; cannot → false.
 *   6. feasible case         — a feasible plan → no blockers, no spurious capacity
 *                              violation, feasible:true.
 *
 * makeMinimalDpr / makeInput / placed are copied (minimal) from search.test.ts.
 */

import { describe, it, expect } from "vitest";
import { buildConstraintContext, type PlacedCourse } from "../../src/agent/forwardSchedule/constraintModel.js";
import { searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import type { SolverInput } from "../../src/agent/forwardSchedule/types.js";
import type { PrereqGroup } from "@nyupath/shared";
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

/** A DPR carrying a single in-progress (type "IP") courseHistory row for `courseId`
 *  (subject + " " + catalogNbr). isPrereqSatisfied recognises an "IP" row as
 *  prereq-satisfying (the "ip-attempt" path) regardless of term, so a dependent
 *  course can be placed cleanly while still being a downstream of the IP course. */
function dprWithIpRow(subject: string, catalogNbr: string, termLabel: string): DegreeProgressReport {
    const base = makeMinimalDpr();
    return {
        ...base,
        courseHistory: [
            {
                term: termLabel,
                subject,
                catalogNbr,
                courseTitle: "In Progress Course",
                grade: null,
                units: 4,
                type: "IP",
            },
        ],
    };
}

// ===========================================================================
// 1. Offering blocker
// ===========================================================================

describe("infeasibility — offering blocker", () => {
    // SUM-UA 1 is offered ONLY in summer; the main fall/spring window never
    // includes summer (summer NOT opted in) → no offering-legal value at all.
    function offeringInput(): SolverInput {
        return makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            unmetRequirements: [
                {
                    rId: "rSummer",
                    title: "Summer Only Course",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["SUM-UA 1"],
                },
            ],
            courseCatalog: new Map([["SUM-UA 1", { title: "Summer Only Course", credits: 4 }]]),
            offerings: new Map([["SUM-UA 1", ["summer"]]]),
        });
    }

    it("searchBestPlan.blockers names the requirement with kind offering_pattern", () => {
        const ctx = buildConstraintContext(offeringInput());
        const result = searchBestPlan(ctx);

        expect(result.plan).toBeNull();
        const b = result.blockers.find(x => x.rId === "rSummer");
        expect(b).toBeDefined();
        expect(b!.kind).toBe("offering_pattern");
        // Detail names the rId AND the title.
        expect(b!.detail).toContain("rSummer");
        expect(b!.detail).toContain("Summer Only Course");
        // blockers and unsatisfiable describe the SAME rIds.
        expect(result.unsatisfiable).toContain("rSummer");
    });

    it("solveForwardSchedule surfaces an offering_pattern violation (NOT a generic prereq stub)", () => {
        const out = solveForwardSchedule(offeringInput());

        expect(out.feasibility.feasible).toBe(false);
        const off = out.feasibility.constraintViolations.find(
            v => v.kind === "offering_pattern" && v.detail.includes("rSummer"),
        );
        expect(off).toBeDefined();
        expect(off!.detail).toContain("Summer Only Course");
        // The OLD generic stub must be gone.
        const generic = out.feasibility.constraintViolations.find(v =>
            v.detail.includes("could not be placed in any valid"),
        );
        expect(generic).toBeUndefined();
    });
});

// ===========================================================================
// 2. Ceiling blocker
// ===========================================================================

describe("infeasibility — ceiling blocker", () => {
    // One-term window (2026-fall), ceiling = 8. A FIXED pin (FILL-UA 9, 8 cr)
    // fills the single term to the ceiling. r1's only candidate REQ-UA 1 (4 cr,
    // fall) cannot be placed anywhere without exceeding 8 → ceiling is the binder.
    const fixed: PlacedCourse[] = [
        placed({ courseId: "FILL-UA 9", term: "2026-fall", credits: 8, source: "pin" }),
    ];

    function ceilingInput(): SolverInput {
        return makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            creditCeiling: 8,
            creditsEarned: 124,
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Blocked Requirement",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1"],
                },
            ],
            courseCatalog: new Map([
                ["REQ-UA 1", { title: "Blocked Requirement", credits: 4 }],
                ["FILL-UA 9", { title: "Filler", credits: 8 }],
            ]),
            offerings: new Map([
                ["REQ-UA 1", ["fall", "spring"]],
                ["FILL-UA 9", ["fall", "spring"]],
            ]),
            preferences: { pins: [{ courseId: "FILL-UA 9", term: "2026-fall" }] },
        });
    }

    it("searchBestPlan.blockers reports kind credit_ceiling when every term is at the ceiling", () => {
        const ctx = buildConstraintContext(ceilingInput());
        const result = searchBestPlan(ctx, { fixed });

        expect(result.plan).toBeNull();
        const b = result.blockers.find(x => x.rId === "r1");
        expect(b).toBeDefined();
        expect(b!.kind).toBe("credit_ceiling");
        expect(b!.detail).toContain("r1");
        expect(b!.detail).toMatch(/ceiling/i);
    });

    it("solveForwardSchedule surfaces the credit_ceiling binding constraint", () => {
        const out = solveForwardSchedule(ceilingInput());

        expect(out.feasibility.feasible).toBe(false);
        const ceil = out.feasibility.constraintViolations.find(
            v => v.kind === "credit_ceiling" && /\br1\b/.test(v.detail),
        );
        expect(ceil).toBeDefined();
    });
});

// ===========================================================================
// 3. Prereq-depth blocker
// ===========================================================================

describe("infeasibility — prereq-depth blocker", () => {
    // One-term window (2026-fall → nonOptionalTermCount = 1). r1's only candidate
    // DEEP-UA 1 has a 2-deep prereq chain (DEEP-UA 1 → MID-UA 2 → BASE-UA 3),
    // neither prereq taken/IP/placeable → the chain (depth 2) cannot fit a 1-term
    // window. DEEP-UA 1 is itself offering-legal & incrementalOk-viable (incrementalOk
    // ignores prereqs), so the binding constraint is the prereq DEPTH, surfaced
    // independently of the incremental check.
    const prereqs = new Map<string, PrereqGroup[]>([
        ["DEEP-UA 1", [{ type: "AND", courses: ["MID-UA 2"] }]],
        ["MID-UA 2", [{ type: "AND", courses: ["BASE-UA 3"] }]],
    ]);

    function prereqDepthInput(): SolverInput {
        return makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            creditsEarned: 124,
            unmetRequirements: [
                {
                    rId: "rDeep",
                    title: "Deep Chain Requirement",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["DEEP-UA 1"],
                },
            ],
            courseCatalog: new Map([["DEEP-UA 1", { title: "Deep Chain Requirement", credits: 4 }]]),
            offerings: new Map([["DEEP-UA 1", ["fall", "spring"]]]),
            prereqs,
        });
    }

    it("searchBestPlan.blockers reports kind prereq_unsatisfiable with the depth + window", () => {
        const ctx = buildConstraintContext(prereqDepthInput());
        const result = searchBestPlan(ctx);

        expect(result.plan).toBeNull();
        const b = result.blockers.find(x => x.rId === "rDeep");
        expect(b).toBeDefined();
        expect(b!.kind).toBe("prereq_unsatisfiable");
        // Detail mentions the requirement, the chain depth (2), the window (1 term),
        // and the graduation target.
        expect(b!.detail).toContain("rDeep");
        expect(b!.detail).toMatch(/depth 2/);
        expect(b!.detail).toMatch(/1-term window/);
        expect(b!.detail).toContain("2026-fall");
    });

    it("solveForwardSchedule surfaces the prereq-depth binding constraint", () => {
        const out = solveForwardSchedule(prereqDepthInput());
        expect(out.feasibility.feasible).toBe(false);
        const pr = out.feasibility.constraintViolations.find(
            v => v.kind === "prereq_unsatisfiable" && /depth 2/.test(v.detail),
        );
        expect(pr).toBeDefined();
    });
});

// ===========================================================================
// 4. Capacity diagnostic (jointly infeasible)
// ===========================================================================

describe("infeasibility — capacity diagnostic", () => {
    // One-term window (2026-fall), ceiling = 8. THREE requirements × 4 cr = 12 cr
    // of demand, but only 8 cr of capacity in the single term. Each requirement is
    // INDIVIDUALLY placeable (4 ≤ 8), so no single-requirement blocker fires — the
    // JOINT capacity is the true blocker, surfaced as a graduation_total sentence.
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

    it("surfaces the capacity sentence naming the credit numbers + graduationTerm", () => {
        const out = solveForwardSchedule(capacityInput());

        expect(out.feasibility.feasible).toBe(false);
        const cap = out.feasibility.constraintViolations.find(
            v => v.kind === "graduation_total" && /credits of capacity exist/.test(v.detail),
        );
        expect(cap).toBeDefined();
        // Names the demand (~12) and the capacity (8) and the graduation target.
        expect(cap!.detail).toContain("12");
        expect(cap!.detail).toContain("8");
        expect(cap!.detail).toContain("2026-fall");
    });

    it("does NOT fabricate a capacity violation when demand fits the window", () => {
        // Same shape but only TWO 4-cr requirements (8 cr) into an 8-cr term: fits.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2026-fall",
            creditCeiling: 8,
            creditsEarned: 124,
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
        const cap = out.feasibility.constraintViolations.find(v =>
            /credits of capacity exist/.test(v.detail),
        );
        expect(cap).toBeUndefined();
    });
});

// ===========================================================================
// 5. contingencyPlanAvailable — real structural determination
// ===========================================================================

describe("infeasibility — contingencyPlanAvailable (structural)", () => {
    // The IP course IP-UA 1 is a prereq of the placed requirement course DEP-UA 2,
    // so an IP_COURSE_COMPLETION assumption is emitted with DEP-UA 2 as the
    // cascading slot. IP-UA 1 is recorded as an "IP" row in the DPR so its prereq is
    // satisfied (the "ip-attempt" path) regardless of term → DEP-UA 2 places cleanly,
    // and the structural contingency turns purely on whether a LATER term exists
    // (strictly after the IP course's own term) where DEP-UA 2's offering allows.
    const prereqs = new Map<string, PrereqGroup[]>([
        ["DEP-UA 2", [{ type: "AND", courses: ["IP-UA 1"] }]],
    ]);

    it("true when the dependent CAN move to a later term in the window", () => {
        // Two-term window (2026-fall, 2027-spring). IP-UA 1 in-progress in 2026-fall
        // (the FIRST term); DEP-UA 2 offered fall+spring → a later term (2027-spring)
        // is offering-legal → contingency available → true.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditsEarned: 120,
            coursesInProgress: new Map([["IP-UA 1", { term: "2026-fall" }]]),
            unmetRequirements: [
                { rId: "rDep", title: "Dependent", category: "major_required", credits: 4, candidateCourses: ["DEP-UA 2"] },
            ],
            courseCatalog: new Map([
                ["DEP-UA 2", { title: "Dependent", credits: 4 }],
                ["IP-UA 1", { title: "In Progress", credits: 4 }],
            ]),
            offerings: new Map([
                ["DEP-UA 2", ["fall", "spring"]],
                ["IP-UA 1", ["fall"]],
            ]),
            prereqs,
            dpr: dprWithIpRow("IP-UA", "1", "2026 Fall"),
        });
        const out = solveForwardSchedule(input);
        const a = out.assumptions.find(
            x => x.type === "IP_COURSE_COMPLETION" && x.courseId === "IP-UA 1",
        );
        expect(a).toBeDefined();
        expect(a!.type).toBe("IP_COURSE_COMPLETION");
        if (a!.type === "IP_COURSE_COMPLETION") {
            expect(a!.cascadingSlots).toContain("DEP-UA 2");
            expect(a!.contingencyPlanAvailable).toBe(true);
        }
    });

    it("false when there is no later term for the dependent to move into", () => {
        // Two-term window (2026-fall, 2027-spring). IP-UA 1 in-progress in the LAST
        // term (2027-spring) → there is NO term strictly after it in the window, so
        // the dependent could not be re-placed later → contingency unavailable → false.
        // DEP-UA 2 places via the IP-row "ip-attempt" prereq satisfaction.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditsEarned: 120,
            coursesInProgress: new Map([["IP-UA 1", { term: "2027-spring" }]]),
            unmetRequirements: [
                { rId: "rDep", title: "Dependent", category: "major_required", credits: 4, candidateCourses: ["DEP-UA 2"] },
            ],
            courseCatalog: new Map([
                ["DEP-UA 2", { title: "Dependent", credits: 4 }],
                ["IP-UA 1", { title: "In Progress", credits: 4 }],
            ]),
            offerings: new Map([
                ["DEP-UA 2", ["fall", "spring"]],
                ["IP-UA 1", ["spring"]],
            ]),
            prereqs,
            dpr: dprWithIpRow("IP-UA", "1", "2027 Spring"),
        });
        const out = solveForwardSchedule(input);
        const a = out.assumptions.find(
            x => x.type === "IP_COURSE_COMPLETION" && x.courseId === "IP-UA 1",
        );
        expect(a).toBeDefined();
        if (a!.type === "IP_COURSE_COMPLETION") {
            expect(a!.cascadingSlots).toContain("DEP-UA 2");
            expect(a!.contingencyPlanAvailable).toBe(false);
        }
    });
});

// ===========================================================================
// 6. Feasible case — unaffected
// ===========================================================================

describe("infeasibility — feasible case unaffected", () => {
    it("a feasible plan has no blockers and no spurious capacity violation", () => {
        // Two-term window, ample ceiling. Two 4-cr requirements + free fill reach the
        // 128 minimum from creditsEarned 120. Comfortable fit → feasible, no blockers.
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 18,
            creditsEarned: 120,
            graduationCreditMinimum: 128,
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
        const ctx = buildConstraintContext(input);

        const search = searchBestPlan(ctx);
        expect(search.plan).not.toBeNull();
        expect(search.blockers).toEqual([]);
        expect(search.unsatisfiable).toEqual([]);

        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(true);
        // No capacity sentence, no generic stub.
        const cap = out.feasibility.constraintViolations.find(v =>
            /credits of capacity exist/.test(v.detail),
        );
        expect(cap).toBeUndefined();
    });
});
