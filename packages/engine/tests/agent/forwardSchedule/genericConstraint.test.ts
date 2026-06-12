/**
 * D6.2 — rung-2 generic SOFT-constraint primitive.
 *
 * The owner's contract-preserving choice: a generic, structured soft factor
 * (`GenericSoftConstraint`, `framing: "soft"`) that the RANKER (`scorePlan`)
 * reads via `SchedulePreferences.softObjectives[]`. It can change which VALID
 * plan ranks first, but MUST NEVER make a valid plan invalid or an invalid plan
 * valid — the SOLVER's hard feasibility/validity logic never reads it.
 *
 * Four proofs:
 *  (a) compiles + the ranker reads it — a plan that satisfies the objective
 *      scores LOWER; WITHOUT the objective the two plans score equal (additive).
 *  (b) the HARD solver contract is untouched — buildRequirementVariables and a
 *      hard-constraint feasibility run produce identical results with vs without
 *      softObjectives (soft = ranking only).
 *  (c) a HARD-framed instance is rejected at the schema boundary (zod + a
 *      compile-time @ts-expect-error guard).
 *  (d) the apply path — applyMutationsToPreferences writes/clears softObjectives.
 *
 * The representative `dimension` scored here is "departmentDiversity": with
 * preference "diverse", a plan whose placed courses span MORE distinct
 * departments scores lower (better). This reads ONLY plan.placed[].courseId, so
 * it is orthogonal to the existing balance / timeToDegree terms — which is why
 * the "WITHOUT the objective the scores are equal" assertion in (a) is exact.
 */

import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    buildRequirementVariables,
    checkHardConstraints,
    scorePlan,
    DEFAULT_OBJECTIVE_WEIGHTS,
    type PartialPlan,
    type PlacedCourse,
    type ObjectiveWeights,
} from "../../../src/agent/forwardSchedule/constraintModel.js";
import {
    applyMutationsToPreferences,
    GenericSoftConstraintSchema,
} from "../../../src/agent/forwardSchedule/planChangeHelpers.js";
import type { SolverInput } from "../../../src/agent/forwardSchedule/types.js";
import type { DegreeProgressReport } from "../../../src/dpr/schema.js";
import type {
    GenericSoftConstraint,
    SchedulePreferences,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Minimal fixtures (pattern copied from objectiveBalance.test.ts)
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
        visaStatus: "domestic",
        coursesTaken: new Set(),
        coursesInProgress: new Map(),
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: null,
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

// A valid, representative soft objective: prefer department-diverse plans.
const diverseObjective: GenericSoftConstraint = {
    id: "obj-diverse",
    framing: "soft",
    dimension: "departmentDiversity",
    preference: "diverse",
};

// Two plans over the SAME input that differ on the representative dimension.
// concentratedPlan: both placed courses share ONE department (MATH-UA).
// diversePlan: the two placed courses span TWO departments (MATH-UA + HIST-UA).
const concentratedPlan: PartialPlan = {
    placed: [
        placed({ courseId: "MATH-UA 121", term: "2026-fall" }),
        placed({ courseId: "MATH-UA 122", term: "2027-spring" }),
    ],
};
const diversePlan: PartialPlan = {
    placed: [
        placed({ courseId: "MATH-UA 121", term: "2026-fall" }),
        placed({ courseId: "HIST-UA 101", term: "2027-spring" }),
    ],
};

// ===========================================================================
// (a) compiles + ranker reads it
// ===========================================================================

describe("D6.2 (a) — scorePlan reads softObjectives (departmentDiversity)", () => {
    it("with the diverse soft objective, the diverse plan scores strictly LOWER than the concentrated plan", () => {
        const ctx = buildConstraintContext(
            makeInput({ preferences: { softObjectives: [diverseObjective] } }),
        );
        const w: ObjectiveWeights = DEFAULT_OBJECTIVE_WEIGHTS;

        const diverseScore = scorePlan(diversePlan, ctx, w);
        const concentratedScore = scorePlan(concentratedPlan, ctx, w);

        expect(diverseScore).toBeLessThan(concentratedScore);
    });

    it("WITHOUT the soft objective, the two plans score EQUAL (the soft term is additive / default-off)", () => {
        // Same fixture, no softObjectives. The two plans differ ONLY in the
        // department of the second course — a dimension the base balance /
        // timeToDegree terms do not read — so their base scores must match.
        const ctx = buildConstraintContext(makeInput()); // no preferences
        const w: ObjectiveWeights = DEFAULT_OBJECTIVE_WEIGHTS;

        const diverseScore = scorePlan(diversePlan, ctx, w);
        const concentratedScore = scorePlan(concentratedPlan, ctx, w);

        expect(diverseScore).toBe(concentratedScore);
    });

    it("the soft objective only LOWERS the satisfying plan's score relative to base (additive cost ≥ 0)", () => {
        const baseCtx = buildConstraintContext(makeInput());
        const objCtx = buildConstraintContext(
            makeInput({ preferences: { softObjectives: [diverseObjective] } }),
        );
        const w: ObjectiveWeights = DEFAULT_OBJECTIVE_WEIGHTS;

        // The diverse plan FULLY satisfies "diverse" → 0 added soft cost → same score.
        expect(scorePlan(diversePlan, objCtx, w)).toBe(scorePlan(diversePlan, baseCtx, w));
        // The concentrated plan does NOT → strictly higher score WITH the objective.
        expect(scorePlan(concentratedPlan, objCtx, w)).toBeGreaterThan(
            scorePlan(concentratedPlan, baseCtx, w),
        );
    });
});

// ===========================================================================
// (b) HARD solver contract untouched (the invariant)
// ===========================================================================

describe("D6.2 (b) — the HARD solver contract is byte-identical with vs without softObjectives", () => {
    // A trivially-feasible single-requirement fixture.
    const reqInput = (prefs?: SchedulePreferences) =>
        makeInput({
            unmetRequirements: [
                {
                    rId: "r1",
                    title: "Req One",
                    category: "major_required",
                    credits: 4,
                    candidateCourses: ["MATH-UA 121"],
                },
            ],
            courseCatalog: new Map([["MATH-UA 121", { title: "Calc I", credits: 4 }]]),
            offerings: new Map([["MATH-UA 121", ["fall", "spring"]]]),
            ...(prefs ? { preferences: prefs } : {}),
        });

    it("buildRequirementVariables produces the SAME variables with vs without softObjectives", () => {
        const withoutCtx = buildConstraintContext(reqInput());
        const withCtx = buildConstraintContext(
            reqInput({ softObjectives: [diverseObjective] }),
        );

        const withoutVars = buildRequirementVariables(withoutCtx);
        const withVars = buildRequirementVariables(withCtx);

        // Same number of variables, same ids, same legal terms — the solver's
        // hard model is unaffected by the soft objective.
        expect(JSON.stringify(withVars)).toBe(JSON.stringify(withoutVars));
    });

    it("a plan VALID without the objective stays VALID with it — checkHardConstraints is unchanged", () => {
        const validPlan: PartialPlan = {
            placed: [
                placed({
                    courseId: "MATH-UA 121",
                    term: "2026-fall",
                    workloadTier: "major-required",
                    workloadWeight: 1.0,
                    satisfiesRId: "r1",
                    source: "requirement",
                }),
            ],
        };

        const withoutCtx = buildConstraintContext(reqInput());
        const withCtx = buildConstraintContext(
            reqInput({ softObjectives: [diverseObjective] }),
        );

        const withoutResult = checkHardConstraints(validPlan, withoutCtx);
        const withResult = checkHardConstraints(validPlan, withCtx);

        // Same hard-constraint verdict (ok + violations) — soft = ranking only.
        expect(withResult.ok).toBe(withoutResult.ok);
        expect(JSON.stringify(withResult.violations)).toBe(JSON.stringify(withoutResult.violations));
    });
});

// ===========================================================================
// (c) HARD-framed rejected at the schema boundary
// ===========================================================================

describe("D6.2 (c) — a hard-framed instance is rejected at the schema boundary", () => {
    it("GenericSoftConstraintSchema rejects framing: 'hard' at runtime", () => {
        const parsed = GenericSoftConstraintSchema.safeParse({
            ...diverseObjective,
            framing: "hard",
        });
        expect(parsed.success).toBe(false);
    });

    it("GenericSoftConstraintSchema accepts a well-formed soft instance", () => {
        const parsed = GenericSoftConstraintSchema.safeParse(diverseObjective);
        expect(parsed.success).toBe(true);
    });

    it("a framing: 'hard' literal is a TS compile error", () => {
        // @ts-expect-error — framing is the literal "soft"; "hard" must not type-check.
        const bad: GenericSoftConstraint = { ...diverseObjective, framing: "hard" };
        void bad;
    });
});

// ===========================================================================
// (d) apply path
// ===========================================================================

describe("D6.2 (d) — applyMutationsToPreferences writes/clears softObjectives", () => {
    it("addSoftObjective appends the objective to prefs.softObjectives (no input mutation)", () => {
        const base: SchedulePreferences = {};
        const { prefs } = applyMutationsToPreferences(base, [
            { kind: "addSoftObjective", objective: diverseObjective },
        ]);

        expect(prefs.softObjectives).toEqual([diverseObjective]);
        // No mutation of the caller's base object.
        expect(base.softObjectives).toBeUndefined();
    });

    it("clearSoftObjectives empties prefs.softObjectives", () => {
        const base: SchedulePreferences = { softObjectives: [diverseObjective] };
        const { prefs } = applyMutationsToPreferences(base, [
            { kind: "clearSoftObjectives" },
        ]);

        expect(prefs.softObjectives ?? []).toEqual([]);
        // Caller's base is untouched.
        expect(base.softObjectives).toEqual([diverseObjective]);
    });
});
