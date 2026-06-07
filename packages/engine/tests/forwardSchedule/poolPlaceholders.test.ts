/**
 * T4a — pool placeholder variable + sound term-legality (SEARCH side).
 *
 * A "choose-N from a pool" requirement (e.g. "complete one course from
 * CSCI-UA 400-499") carries a `pool: {dept, levelMin, levelMax}` descriptor with
 * EMPTY/few enumerated candidateCourses. The search represents it as ONE heavy
 * pool variable (NOT N branches), placing a synthetic `POOL-<rId>` placeholder
 * ONLY where a REAL catalog member fits the term (offered + prereq-satisfiable).
 *
 * Exceptions:
 *  - chain-linked: when a pool member is a prereq-provider of another required
 *    course, the pool is ENUMERATED (kind "specific", candidates = members) so the
 *    member can be placed concretely.
 *  - no real members: the requirement stays the existing empty/specific variable
 *    (no regression).
 *
 * makeMinimalDpr / makeInput / placed are copied (minimal) from search.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    buildRequirementVariables,
    checkRequirementCoverage,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { findFirstValidPlan } from "../../src/agent/forwardSchedule/search.js";
import { materializePlan } from "../../src/agent/forwardSchedule/materializePlan.js";
import {
    runGraduationPathValidator,
    type GraduationPathValidatorArgs,
} from "../../src/agent/forwardSchedule/graduationPathValidator.js";
import { finalizeForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import type { SolverInput, SolverOutput } from "../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { ForwardSchedule } from "@nyupath/shared";

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

/**
 * Wrap a SolverOutput into a ForwardSchedule for the validator — mirrors
 * build.ts's `initialSchedule` construction (copied from materializePlan.test.ts).
 */
function toForwardSchedule(input: SolverInput, out: SolverOutput): ForwardSchedule {
    const plannedCredits = out.semesters.reduce((s, sem) => s + sem.plannedCredits, 0);
    const degreeCreditsMet = input.creditsEarned + plannedCredits >= input.graduationCreditMinimum;
    return {
        studentId: input.studentId,
        homeSchoolId: input.homeSchoolId,
        graduationTerm: input.graduationTerm,
        creditTargetPerSemester: input.creditTargetPerSemester,
        f1Floor: input.f1Floor,
        domesticPartTimeFloor: input.domesticPartTimeFloor,
        graduationCreditMinimum: input.graduationCreditMinimum,
        degreeCreditsMet,
        semesters: out.semesters,
        dprCourseHistoryHash: input.dprCourseHistoryHash,
        computedAt: 0,
        feasibility: out.feasibility,
        state: out.state,
        balanceScore: out.balanceScore,
        assumptions: out.assumptions,
        ...(out.alternativeCandidates ? { alternativeCandidates: out.alternativeCandidates } : {}),
    };
}

/** Build the validator args from a SolverInput + ForwardSchedule (mirrors build.ts). */
function makeValidatorArgs(input: SolverInput, plan: ForwardSchedule): GraduationPathValidatorArgs {
    return {
        plan,
        dpr: input.dpr,
        programRules: {
            degreeCreditMinimum: input.graduationCreditMinimum,
            residencyMinCredits: input.programRules.residencyMinCredits,
            majorCreditMinimum: input.programRules.majorCreditMinimum,
            minorCreditMinimum: null,
            upperLevelMinCredits: input.programRules.upperLevelMinCredits,
            schoolCoreMinCredits: null,
            graduationTargetTerm: input.graduationTerm,
        },
    };
}

/** A 16-member CSCI-UA 4xx pool input (offered fall+spring), with a matching
 *  DPR `not_satisfied` leaf for the pool requirement so the authoritative
 *  validator axis 1 actually sees the gap. Used by the materialize + validator
 *  + end-to-end pool tests below. */
function poolInputWithDprLeaf(overrides: Partial<SolverInput> = {}): SolverInput {
    const catalog = new Map<string, { title: string; credits: number }>();
    const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
    for (let n = 421; n <= 436; n++) {
        const id = `CSCI-UA ${n}`;
        catalog.set(id, { title: id, credits: 4 });
        offerings.set(id, ["fall", "spring"]);
    }
    // creditsUsed must match creditsEarned:120 below — the validator axis-3 uses DPR.creditsUsed.
    const baseDpr = makeMinimalDpr();
    const dpr: DegreeProgressReport = {
        ...baseDpr,
        cumulative: { ...baseDpr.cumulative, creditsUsed: 120 },
        requirementGroups: [
            {
                rgId: "RGCS",
                title: "CS Electives",
                status: "overall_not_satisfied",
                statusText: "Overall Requirement Not Satisfied: CS Electives",
                children: [
                    {
                        rId: "r1",
                        title: "CS Elective",
                        status: "not_satisfied",
                        statusText: "Not Satisfied: CS Elective",
                        coursesUsed: [],
                    },
                ],
            },
        ],
    };
    return makeInput({
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditsEarned: 120,
        graduationCreditMinimum: 128,
        dpr,
        unmetRequirements: [
            {
                rId: "r1",
                title: "CS Elective",
                category: "major_elective",
                credits: 4,
                candidateCourses: [],
                pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
            },
        ],
        courseCatalog: catalog,
        offerings,
        programRules: {
            majorRuleKinds: new Map([["r1", "choose_n"]]),
            schoolCoreRuleIds: new Set(),
            generalCategoryRuleIds: new Set(),
            residencyMinCredits: null,
            majorCreditMinimum: null,
            upperLevelMinCredits: null,
        },
        ...overrides,
    });
}

// ===========================================================================
// 1. A 16-member pool → ONE pool variable, placed as POOL-<rId> with HEAVY weight
// ===========================================================================

describe("pool placeholder — one heavy pool variable (no member enumeration)", () => {
    it("a 16-member pool becomes ONE pool variable and is placed as POOL-<rId> with HEAVY weight", () => {
        const catalog = new Map<string, { title: string; credits: number }>();
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
        for (let n = 421; n <= 436; n++) {
            const id = `CSCI-UA ${n}`;
            catalog.set(id, { title: id, credits: 4 });
            offerings.set(id, ["fall", "spring"]);
        }
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: [],
                    pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
                },
            ],
            courseCatalog: catalog,
            offerings,
            programRules: {
                majorRuleKinds: new Map([["r1", "choose_n"]]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
        const ctx = buildConstraintContext(input);
        const vars = buildRequirementVariables(ctx);
        const v = vars.find(x => x.rId === "r1")!;
        expect(v.kind).toBe("pool");
        // ONE pool variable — it carries the 16 members but is NOT enumerated as
        // 16 separate variables.
        expect(vars.filter(x => x.rId === "r1")).toHaveLength(1);
        expect(v.poolMembers).toHaveLength(16);

        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        const poolPlacement = res.plan!.placed.find(p => p.satisfiesRId === "r1")!;
        expect(poolPlacement.courseId).toBe("POOL-r1");
        expect(poolPlacement.source).toBe("requirement");
        expect(poolPlacement.workloadWeight).toBeGreaterThanOrEqual(1.0); // heavy, not light/free
        expect(checkRequirementCoverage(res.plan!, ctx).ok).toBe(true);
    });
});

// ===========================================================================
// 2. Sound legality — no false reservation when no member is offered in a term
// ===========================================================================

describe("pool placeholder — sound term-legality", () => {
    it("is NOT legal in a term where no real member is offered (no false reservation)", () => {
        const catalog = new Map([["CSCI-UA 421", { title: "x", credits: 4 }]]);
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>([
            ["CSCI-UA 421", ["fall"]],
        ]);
        const input = makeInput({
            currentTerm: "2027-spring",
            graduationTerm: "2027-spring", // single spring term; the only member is fall-only
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: [],
                    pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
                },
            ],
            courseCatalog: catalog,
            offerings,
            programRules: {
                majorRuleKinds: new Map([["r1", "choose_n"]]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).toBeNull(); // no legal term for the pool
        expect(res.blockers.some(b => b.rId === "r1")).toBe(true);
    });

    it("a member whose prereq is unsatisfiable by taken/IP makes the pool illegal in that term", () => {
        // Single-term spring window; the only pool member ADV-UA 480 requires
        // PRE-UA 1, which is NEITHER taken nor in-progress (and the pool only
        // checks taken/IP, NOT future placements) → no member fits → infeasible.
        const catalog = new Map([
            ["ADV-UA 480", { title: "Advanced", credits: 4 }],
        ]);
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>([
            ["ADV-UA 480", ["spring"]],
        ]);
        const input = makeInput({
            currentTerm: "2027-spring",
            graduationTerm: "2027-spring",
            prereqs: new Map([["ADV-UA 480", [{ type: "AND", courses: ["PRE-UA 1"] }]]]),
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: [],
                    pool: { dept: "ADV-UA", levelMin: 400, levelMax: 499 },
                },
            ],
            courseCatalog: catalog,
            offerings,
            programRules: {
                majorRuleKinds: new Map([["r1", "choose_n"]]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).toBeNull();
        expect(res.blockers.some(b => b.rId === "r1")).toBe(true);
    });

    it("a member whose prereq IS taken makes the pool legal (prereq-satisfied-by-taken)", () => {
        // Same as above but PRE-UA 1 is already taken → ADV-UA 480 fits → legal.
        const catalog = new Map([["ADV-UA 480", { title: "Advanced", credits: 4 }]]);
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>([
            ["ADV-UA 480", ["spring"]],
        ]);
        const input = makeInput({
            currentTerm: "2027-spring",
            graduationTerm: "2027-spring",
            coursesTaken: new Set(["PRE-UA 1"]),
            prereqs: new Map([["ADV-UA 480", [{ type: "AND", courses: ["PRE-UA 1"] }]]]),
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: [],
                    pool: { dept: "ADV-UA", levelMin: 400, levelMax: 499 },
                },
            ],
            courseCatalog: catalog,
            offerings,
            programRules: {
                majorRuleKinds: new Map([["r1", "choose_n"]]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        const poolPlacement = res.plan!.placed.find(p => p.satisfiesRId === "r1")!;
        expect(poolPlacement.courseId).toBe("POOL-r1");
        expect(checkRequirementCoverage(res.plan!, ctx).ok).toBe(true);
    });
});

// ===========================================================================
// 3. Chain-linked — a pool member that is a prereq of another required course
//    is ENUMERATED (specific), not pooled.
// ===========================================================================

describe("pool placeholder — chain-linked members are enumerated", () => {
    it("a pool whose member is a prereq of another required course is ENUMERATED (specific), not pooled", () => {
        // CSCI-UA 421 (a pool member) is a prereq of REQ-UA 2 (another required course).
        // → r1 must be a SPECIFIC variable enumerating members, so 421 can be placed concretely.
        const catalog = new Map([
            ["CSCI-UA 421", { title: "x", credits: 4 }],
            ["CSCI-UA 430", { title: "y", credits: 4 }],
            ["REQ-UA 2", { title: "z", credits: 4 }],
        ]);
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>([
            ["CSCI-UA 421", ["fall", "spring"]],
            ["CSCI-UA 430", ["fall", "spring"]],
            ["REQ-UA 2", ["fall", "spring"]],
        ]);
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            prereqs: new Map([["REQ-UA 2", [{ type: "AND", courses: ["CSCI-UA 421"] }]]]),
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: [],
                    pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
                },
                {
                    rId: "r2",
                    title: "Dependent",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 2"],
                },
            ],
            courseCatalog: catalog,
            offerings,
            programRules: {
                majorRuleKinds: new Map([
                    ["r1", "choose_n"],
                    ["r2", "must_take"],
                ]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
        const ctx = buildConstraintContext(input);
        const v = buildRequirementVariables(ctx).find(x => x.rId === "r1")!;
        expect(v.kind).toBe("specific"); // enumerated because a member is chain-linked
        expect(v.candidates).toContain("CSCI-UA 421"); // members became the candidate list
        expect(v.candidates).toContain("CSCI-UA 430");

        // The search can satisfy BOTH (place the prereq member concretely before REQ-UA 2).
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        expect(checkRequirementCoverage(res.plan!, ctx).ok).toBe(true);
        // No synthetic POOL placeholder exists (the requirement was enumerated).
        expect(res.plan!.placed.some(p => p.courseId.startsWith("POOL-"))).toBe(false);
    });
});

// ===========================================================================
// 4. No real members → not a pool variable (no regression); empty placeholder.
// ===========================================================================

describe("pool placeholder — empty pool degrades to the existing placeholder path", () => {
    it("a pool descriptor with NO catalog members yields a non-pool empty variable", () => {
        // No catalog course matches CSCI-UA 400-499 → members empty → existing
        // empty/specific behavior (no pool variable, no regression).
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: [],
                    pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
                },
            ],
            courseCatalog: new Map(), // empty catalog → no members
            offerings: new Map(),
            programRules: {
                majorRuleKinds: new Map([["r1", "choose_n"]]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
        const ctx = buildConstraintContext(input);
        const v = buildRequirementVariables(ctx).find(x => x.rId === "r1")!;
        expect(v.kind).toBe("specific");
        expect(v.candidates).toHaveLength(0); // empty placeholder downstream — not searched
        expect(v.poolMembers).toEqual([]);
    });

    it("a requirement with NO pool descriptor is a plain specific variable (unchanged)", () => {
        const input = makeInput({
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Required Course",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["REQ-UA 1"],
                },
            ],
            courseCatalog: new Map([["REQ-UA 1", { title: "Required Course", credits: 4 }]]),
            offerings: new Map([["REQ-UA 1", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const v = buildRequirementVariables(ctx).find(x => x.rId === "r1")!;
        expect(v.kind).toBe("specific");
        expect(v.candidates).toEqual(["REQ-UA 1"]);
        expect(v.poolMembers).toEqual([]);
    });
});

// ===========================================================================
// 5. Mixed case — enumerated candidates + pool range are UNIONed.
// ===========================================================================

describe("pool placeholder — mixed enumerated + range members", () => {
    it("unions explicit candidateCourses (catalog-present) with the range members", () => {
        // Pool range CSCI-UA 400-499 has one catalog member (421); plus an explicit
        // candidate from a DIFFERENT dept (MATH-UA 240) that is catalog-present.
        const catalog = new Map([
            ["CSCI-UA 421", { title: "x", credits: 4 }],
            ["MATH-UA 240", { title: "m", credits: 4 }],
        ]);
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>([
            ["CSCI-UA 421", ["fall", "spring"]],
            ["MATH-UA 240", ["fall", "spring"]],
        ]);
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: ["MATH-UA 240"],
                    pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
                },
            ],
            courseCatalog: catalog,
            offerings,
            programRules: {
                majorRuleKinds: new Map([["r1", "choose_n"]]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
        const ctx = buildConstraintContext(input);
        const v = buildRequirementVariables(ctx).find(x => x.rId === "r1")!;
        expect(v.kind).toBe("pool");
        // Both the range member AND the explicit catalog-present candidate are members.
        expect(new Set(v.poolMembers)).toEqual(new Set(["CSCI-UA 421", "MATH-UA 240"]));
        // Deterministic order: sorted by id.
        expect(v.poolMembers).toEqual([...v.poolMembers].sort());
    });
});

// ===========================================================================
// 6. Determinism — two calls on a pool input return identical plans.
// ===========================================================================

describe("pool placeholder — determinism", () => {
    const makeScenario = () => {
        const catalog = new Map<string, { title: string; credits: number }>();
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
        for (let n = 421; n <= 430; n++) {
            const id = `CSCI-UA ${n}`;
            catalog.set(id, { title: id, credits: 4 });
            offerings.set(id, ["fall", "spring"]);
        }
        return makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: [],
                    pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
                },
            ],
            courseCatalog: catalog,
            offerings,
            programRules: {
                majorRuleKinds: new Map([["r1", "choose_n"]]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
    };

    it("identical pool input → two findFirstValidPlan calls return identical plans + score", () => {
        const r1 = findFirstValidPlan(buildConstraintContext(makeScenario()));
        const r2 = findFirstValidPlan(buildConstraintContext(makeScenario()));
        expect(r1.plan).not.toBeNull();
        expect(r1.score).toBe(r2.score);
        expect(r1.plan!.placed).toEqual(r2.plan!.placed);
    });
});

// ===========================================================================
// 7. Pool legality respects prereqs satisfied by an IP course.
// ===========================================================================

describe("pool placeholder — legality counts in-progress prereqs", () => {
    it("a member whose prereq is IN-PROGRESS makes the pool legal", () => {
        const catalog = new Map([["ADV-UA 480", { title: "Advanced", credits: 4 }]]);
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>([
            ["ADV-UA 480", ["spring"]],
        ]);
        const input = makeInput({
            currentTerm: "2027-spring",
            graduationTerm: "2027-spring",
            coursesInProgress: new Map([["PRE-UA 1", { term: "2026-fall" }]]),
            prereqs: new Map([["ADV-UA 480", [{ type: "AND", courses: ["PRE-UA 1"] }]]]),
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "CS Elective",
                    category: "major_elective",
                    credits: 4,
                    candidateCourses: [],
                    pool: { dept: "ADV-UA", levelMin: 400, levelMax: 499 },
                },
            ],
            courseCatalog: catalog,
            offerings,
            programRules: {
                majorRuleKinds: new Map([["r1", "choose_n"]]),
                schoolCoreRuleIds: new Set(),
                generalCategoryRuleIds: new Set(),
                residencyMinCredits: null,
                majorCreditMinimum: null,
                upperLevelMinCredits: null,
            },
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        const poolPlacement = res.plan!.placed.find(p => p.satisfiesRId === "r1")!;
        expect(poolPlacement.courseId).toBe("POOL-r1");
    });
});

// ===========================================================================
// 8. T4b — Materialize a POOL placement as a resolvable pool PLACEHOLDER slot.
// ===========================================================================

describe("pool placeholder — materialize renders a resolvable pool placeholder (T4b)", () => {
    it("a POOL placement materializes as a heavy pool PLACEHOLDER slot carrying poolBinding members (not a phantom specific course)", () => {
        const input = poolInputWithDprLeaf();
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();

        // The members the pool expands to (real catalog ids).
        const members: string[] = [];
        for (let n = 421; n <= 436; n++) members.push(`CSCI-UA ${n}`);

        const out = materializePlan(res.plan!, ctx);
        const allSlots = out.semesters.flatMap(s => s.slots);

        // NO specific_planned slot with the synthetic POOL- courseId (the bug T4b fixes).
        const phantom = allSlots.find(
            s => s.kind === "specific_planned" && s.courseId.startsWith("POOL-"),
        );
        expect(phantom).toBeUndefined();

        // The pool requirement is rendered as a placeholder carrying a resolvable poolBinding.
        const poolSlot = allSlots.find(
            s =>
                s.kind === "placeholder" &&
                s.satisfiesRules.includes("r1") &&
                s.poolBinding !== undefined,
        );
        expect(poolSlot).toBeDefined();
        if (poolSlot && poolSlot.kind === "placeholder") {
            expect(poolSlot.satisfiesRules).toEqual(["r1"]);
            // poolBinding.candidates = the real members (non-empty, resolvable).
            expect(poolSlot.poolBinding).toBeDefined();
            expect(poolSlot.poolBinding!.poolId).toBe("POOL-r1");
            expect(poolSlot.poolBinding!.satisfiesRule).toBe("r1");
            expect(new Set(poolSlot.poolBinding!.candidates)).toEqual(new Set(members));
            expect(poolSlot.poolBinding!.candidates.length).toBeGreaterThan(0);
            // HEAVY weight (≥1.0) — a major-elective pool, not a 0.3 free placeholder.
            expect(poolSlot.workloadWeight).toBeGreaterThanOrEqual(1.0);
            // flexibility.alternativeCourses lists the real members too.
            expect(new Set(poolSlot.flexibility.alternativeCourses)).toEqual(new Set(members));
            expect(poolSlot.placeholderId).toBe("POOL-r1");
        }

        // The placeholder pass did NOT also emit a generic REQ-r1 placeholder for the
        // covered pool requirement (no double-emit).
        const genericReqPlaceholder = allSlots.find(
            s => s.kind === "placeholder" && s.placeholderId === "REQ-r1",
        );
        expect(genericReqPlaceholder).toBeUndefined();
    });
});

// ===========================================================================
// 9. T4b — Validator axis 1 counts a RESOLVABLE pool placeholder as satisfying.
// ===========================================================================

describe("pool placeholder — validator axis-1 narrowed re-allow (T4b)", () => {
    it("the post-hoc validator counts a resolvable pool placeholder as satisfying its requirement (axis 1)", () => {
        const input = poolInputWithDprLeaf();
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();

        const out = materializePlan(res.plan!, ctx);
        const fs = toForwardSchedule(input, out);
        const validator = runGraduationPathValidator(makeValidatorArgs(input, fs));

        // r1 (the pool requirement, a not_satisfied DPR leaf) is covered ONLY by a
        // resolvable pool placeholder. Axis 1 must NOT fail (pass or assumed-pass).
        expect(validator.axisResults.requirementGroupsSatisfied.status).not.toBe("fail");
        expect(validator.feasible).toBe(true);
    });

    it("an EMPTY/non-pool placeholder still does NOT satisfy axis 1 (the PLAN-4 narrowing holds)", () => {
        // rGap's only candidate is off-catalog → buildRequirementVariables yields an
        // empty-candidate variable → the search cannot place it → materializePlan emits
        // a GENERIC placeholder (no poolBinding). That placeholder must NOT satisfy axis 1.
        const dpr = makeMinimalDpr({
            requirementGroups: [
                {
                    rgId: "RGGAP",
                    title: "Gap Group",
                    status: "overall_not_satisfied",
                    statusText: "Overall Requirement Not Satisfied: Gap Group",
                    children: [
                        {
                            rId: "rGap",
                            title: "Unmappable Requirement",
                            status: "not_satisfied",
                            statusText: "Not Satisfied: Unmappable Requirement",
                            coursesUsed: [],
                        },
                    ],
                },
            ],
        });
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditsEarned: 120,
            graduationCreditMinimum: 128,
            dpr,
            unmetRequirements: [
                {
                    rId: "rGap",
                    title: "Unmappable Requirement",
                    category: "cas_core",
                    credits: 4,
                    candidateCourses: ["MISSING-UA 99"], // off-catalog → empty candidates
                },
            ],
            courseCatalog: new Map(), // no catalog members, no pool descriptor
            offerings: new Map(),
        });
        const ctx = buildConstraintContext(input);
        const out = materializePlan(findFirstValidPlan(ctx).plan!, ctx);

        // The emitted placeholder for rGap carries NO poolBinding.
        const gapPlaceholder = out.semesters
            .flatMap(s => s.slots)
            .find(s => s.kind === "placeholder" && s.satisfiesRules.includes("rGap"));
        expect(gapPlaceholder).toBeDefined();
        if (gapPlaceholder && gapPlaceholder.kind === "placeholder") {
            expect(gapPlaceholder.poolBinding).toBeUndefined();
        }

        const fs = toForwardSchedule(input, out);
        const validator = runGraduationPathValidator(makeValidatorArgs(input, fs));
        expect(validator.axisResults.requirementGroupsSatisfied.status).toBe("fail");
        expect(validator.feasible).toBe(false);
    });
});

// ===========================================================================
// 10. T4b — End-to-end: a pool requirement yields a VALID plan (Option B proof).
// ===========================================================================

describe("pool placeholder — end-to-end VALID plan (T4b/Option B)", () => {
    it("a CAS student with a pool requirement gets a VALID plan (state not infeasible-draft)", () => {
        const input = poolInputWithDprLeaf();
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();

        const out = materializePlan(res.plan!, ctx);
        // Derive the AUTHORITATIVE state via the validator (finalizeForwardSchedule
        // runs runGraduationPathValidator + derivePlanStateFromValidator).
        const validatorRules: GraduationPathValidatorArgs["programRules"] = {
            degreeCreditMinimum: input.graduationCreditMinimum,
            residencyMinCredits: input.programRules.residencyMinCredits,
            majorCreditMinimum: input.programRules.majorCreditMinimum,
            minorCreditMinimum: null,
            upperLevelMinCredits: input.programRules.upperLevelMinCredits,
            schoolCoreMinCredits: null,
            graduationTargetTerm: input.graduationTerm,
        };
        const finalized = finalizeForwardSchedule(out, input, input.dpr, validatorRules);

        // The resolvable pool placeholder satisfies coverage → a valid plan state.
        expect(finalized.validatorResult.feasible).toBe(true);
        expect(finalized.schedule.state).toMatch(/^valid/);
    });
});
