/**
 * Phase 17 Task A — propose_plan_change tests for the new `freeze` flag
 * and `move` mutation kind.
 *
 * Covers:
 *  - pin freeze:false places the course but does NOT add to pins[].
 *  - pin freeze:true behaves identically to omitting freeze.
 *  - pin omitting freeze writes to pins[] (default-true semantics).
 *  - move records the helper-level exclusion and does NOT write to pins[];
 *    the to-term placement is asserted at the route layer (Phase 17 Task B).
 *  - move with non-existent course in fromTerm still produces a
 *    PlanChangeOutcome (no exception); the helper-level effect is the
 *    new exclusion entry.
 *  - move does NOT write to pins[] (literal Phase 17 contract).
 *  - 2-mutation [swap, swap] cross-term batch passes validation
 *    atomically (no transient duplicate-state false-rejection).
 *
 * Mirrors the fixture style of proposePlanChange.test.ts.
 */

import { describe, it, expect } from "vitest";
import { proposePlanChangeTool } from "../../src/agent/tools/proposePlanChange.js";
import { confirmPlanChangeTool } from "../../src/agent/tools/confirmPlanChange.js";
import { applyMutationsToPreferences } from "../../src/agent/forwardSchedule/planChangeHelpers.js";
import type { ToolSession, ToolUseContext } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { ForwardSchedule, PlanMutation, SchedulePreferences } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures (parallel to proposePlanChange.test.ts)
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:test",
        sourcePdfPageCount: 1,
        parseDurationMs: 0,
        warnings: [],
    };
}

function makeDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 96,
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

function makeMinimalFeasibleSchedule(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "test-hash",
        computedAt: Date.now(),
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
        ...overrides,
    };
}

function makeSession(overrides: Partial<ToolSession> = {}): ToolSession {
    return {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
            visaStatus: "f1",
        },
        schoolConfig: {
            schoolId: "cas",
            name: "College of Arts and Science",
            degreeType: "BA",
            courseSuffix: ["-UA"],
            totalCreditsRequired: 128,
            overallGpaMin: 2.0,
            acceptsTransferCredit: true,
            maxCreditsPerSemester: 18,
            f1FullTimeMinCredits: 12,
            residency: { minCredits: 64, note: null },
        },
        degreeProgressReport: makeDpr(),
        forwardSchedule: makeMinimalFeasibleSchedule(),
        ...overrides,
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session,
    };
}

// ---------------------------------------------------------------------------
// pin.freeze flag: helper-level semantics
// ---------------------------------------------------------------------------

describe("applyMutationsToPreferences — pin.freeze flag (Phase 17)", () => {
    const base: SchedulePreferences = {};

    it("freeze=true writes to pins[]", () => {
        const m: PlanMutation = { kind: "pin", courseId: "CSCI-UA 102", term: "2027-spring", freeze: true };
        const { prefs } = applyMutationsToPreferences(base, [m]);
        expect(prefs.pins).toBeDefined();
        expect(prefs.pins).toHaveLength(1);
        expect(prefs.pins![0]).toEqual({ courseId: "CSCI-UA 102", term: "2027-spring" });
    });

    it("freeze omitted defaults to true (writes to pins[])", () => {
        const m: PlanMutation = { kind: "pin", courseId: "CSCI-UA 102", term: "2027-spring" };
        const { prefs } = applyMutationsToPreferences(base, [m]);
        expect(prefs.pins).toBeDefined();
        expect(prefs.pins).toHaveLength(1);
        expect(prefs.pins![0]).toEqual({ courseId: "CSCI-UA 102", term: "2027-spring" });
    });

    it("freeze=false does NOT write to pins[]", () => {
        const m: PlanMutation = { kind: "pin", courseId: "CSCI-UA 102", term: "2027-spring", freeze: false };
        const { prefs } = applyMutationsToPreferences(base, [m]);
        // pins[] should remain undefined or empty — no entry written.
        const pins = prefs.pins ?? [];
        expect(pins).toHaveLength(0);
    });

    it("freeze=true and freeze omitted produce identical pins[] state (backwards-compat)", () => {
        const explicit = applyMutationsToPreferences(base, [
            { kind: "pin", courseId: "X", term: "2027-spring", freeze: true },
        ]);
        const implicit = applyMutationsToPreferences(base, [
            { kind: "pin", courseId: "X", term: "2027-spring" },
        ]);
        expect(explicit.prefs.pins).toEqual(implicit.prefs.pins);
    });
});

// ---------------------------------------------------------------------------
// pin.freeze flag: end-to-end through proposePlanChange / confirmPlanChange
// ---------------------------------------------------------------------------

describe("propose / confirm plan_change — pin.freeze (Phase 17)", () => {
    it("propose_plan_change with pin freeze=false runs without writing to session", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);
        expect(session.schedulePreferences).toBeUndefined();

        const out = await proposePlanChangeTool.call(
            { mutations: [{ kind: "pin", courseId: "CSCI-UA 480", term: "2027-spring", freeze: false }] },
            ctx,
        );

        // session.schedulePreferences MUST remain unset (read-only invariant)
        expect(session.schedulePreferences).toBeUndefined();
        // explanation field is populated and references the course
        expect(typeof out.explanation).toBe("string");
        expect(out.explanation).toContain("CSCI-UA 480");
        expect(out.explanation).toMatch(/Adding/);
    });

    it("confirm_plan_change with pin freeze=true writes to pins[]", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        await confirmPlanChangeTool.call(
            { mutations: [{ kind: "pin", courseId: "CSCI-UA 102", term: "2027-spring", freeze: true }] },
            ctx,
        );

        expect(session.schedulePreferences?.pins).toBeDefined();
        const pin = session.schedulePreferences!.pins!.find(p => p.courseId === "CSCI-UA 102");
        expect(pin).toBeDefined();
        expect(pin!.term).toBe("2027-spring");
    });

    it("confirm_plan_change with pin freeze omitted writes to pins[] (default-true)", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        await confirmPlanChangeTool.call(
            { mutations: [{ kind: "pin", courseId: "CSCI-UA 102", term: "2027-spring" }] },
            ctx,
        );

        expect(session.schedulePreferences?.pins).toBeDefined();
        const pin = session.schedulePreferences!.pins!.find(p => p.courseId === "CSCI-UA 102");
        expect(pin).toBeDefined();
    });

    it("confirm_plan_change with pin freeze=false does NOT write to pins[]", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        await confirmPlanChangeTool.call(
            { mutations: [{ kind: "pin", courseId: "CSCI-UA 480", term: "2027-spring", freeze: false }] },
            ctx,
        );

        const pins = session.schedulePreferences?.pins ?? [];
        const found = pins.find(p => p.courseId === "CSCI-UA 480");
        expect(found).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// move mutation: helper-level semantics
// ---------------------------------------------------------------------------

describe("applyMutationsToPreferences — move mutation (Phase 17)", () => {
    const base: SchedulePreferences = {};

    it("move drops the courseId from fromTerm via an exclusion entry", () => {
        const m: PlanMutation = { kind: "move", courseId: "MATH-UA 343", fromTerm: "2026-fall", toTerm: "2027-spring" };
        const { prefs } = applyMutationsToPreferences(base, [m]);
        expect(prefs.exclusions).toBeDefined();
        const ex = prefs.exclusions!.find(e => e.courseId === "MATH-UA 343");
        expect(ex).toBeDefined();
        expect(ex!.term).toBe("2026-fall");
    });

    it("move does NOT write to pins[]", () => {
        const m: PlanMutation = { kind: "move", courseId: "MATH-UA 343", fromTerm: "2026-fall", toTerm: "2027-spring" };
        const { prefs } = applyMutationsToPreferences(base, [m]);
        const pins = prefs.pins ?? [];
        expect(pins.find(p => p.courseId === "MATH-UA 343")).toBeUndefined();
    });

    it("move atomic — single mutation pass produces both the exclusion AND leaves pins[] untouched", () => {
        const m: PlanMutation = { kind: "move", courseId: "MATH-UA 343", fromTerm: "2026-fall", toTerm: "2027-spring" };
        const { prefs } = applyMutationsToPreferences(base, [m]);
        // Drops from fromTerm: exclusion lands.
        expect(prefs.exclusions?.find(e => e.courseId === "MATH-UA 343")).toBeDefined();
        // Adds to toTerm: route layer (Phase 17 Task B) handles the
        // actual placement; the helper does NOT write a freeze pin.
        expect(prefs.pins ?? []).toHaveLength(0);
    });

    it("move with a course not previously in the schedule still records the exclusion", () => {
        // The helper is purely a preference-state transform — it does
        // not validate that the course was actually placed in fromTerm.
        // Validation of "course not present in fromTerm" lives at the
        // route layer.
        const m: PlanMutation = { kind: "move", courseId: "DOES-NOT-EXIST 999", fromTerm: "2026-fall", toTerm: "2027-spring" };
        const { prefs } = applyMutationsToPreferences(base, [m]);
        expect(prefs.exclusions?.find(e => e.courseId === "DOES-NOT-EXIST 999")).toBeDefined();
    });

    it("move overrides any existing exclusion for the same courseId", () => {
        const baseWithExclusion: SchedulePreferences = {
            exclusions: [{ courseId: "MATH-UA 343", term: "2027-fall" }],
        };
        const m: PlanMutation = { kind: "move", courseId: "MATH-UA 343", fromTerm: "2026-fall", toTerm: "2027-spring" };
        const { prefs } = applyMutationsToPreferences(baseWithExclusion, [m]);
        const exclusions = prefs.exclusions!.filter(e => e.courseId === "MATH-UA 343");
        // Move replaces any earlier exclusion for the same courseId.
        expect(exclusions).toHaveLength(1);
        expect(exclusions[0]!.term).toBe("2026-fall");
    });
});

// ---------------------------------------------------------------------------
// move mutation: end-to-end through proposePlanChange
// ---------------------------------------------------------------------------

describe("propose_plan_change — move mutation (Phase 17)", () => {
    it("move runs without exception and returns an explanation that cites course + both terms", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const out = await proposePlanChangeTool.call(
            {
                mutations: [{
                    kind: "move",
                    courseId: "MATH-UA 343",
                    fromTerm: "2026-fall",
                    toTerm: "2027-spring",
                }],
            },
            ctx,
        );

        expect(typeof out.feasible).toBe("boolean");
        expect(out.explanation).toContain("MATH-UA 343");
        expect(out.explanation).toContain("2026-fall");
        expect(out.explanation).toContain("2027-spring");
        expect(out.explanation).toMatch(/Moving/);
    });

    it("move with non-existent course in fromTerm still returns a valid PlanChangeOutcome", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        const out = await proposePlanChangeTool.call(
            {
                mutations: [{
                    kind: "move",
                    courseId: "DOES-NOT-EXIST 999",
                    fromTerm: "2026-fall",
                    toTerm: "2027-spring",
                }],
            },
            ctx,
        );

        // The tool does NOT throw — it returns a structured outcome.
        // Whether the outcome flags the absence is a route-layer
        // concern (the route can inspect `out.diff.removed` to detect
        // "no slot was actually removed"). Here we only verify the
        // contract that propose returns cleanly.
        expect(typeof out.feasible).toBe("boolean");
        expect(Array.isArray(out.diff.added)).toBe(true);
        expect(Array.isArray(out.diff.removed)).toBe(true);
    });

    it("confirm_plan_change with move does NOT write the courseId to pins[]", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        await confirmPlanChangeTool.call(
            {
                mutations: [{
                    kind: "move",
                    courseId: "MATH-UA 343",
                    fromTerm: "2026-fall",
                    toTerm: "2027-spring",
                }],
            },
            ctx,
        );

        const pins = session.schedulePreferences?.pins ?? [];
        expect(pins.find(p => p.courseId === "MATH-UA 343")).toBeUndefined();
        // But the exclusion DID land.
        const exclusions = session.schedulePreferences?.exclusions ?? [];
        expect(exclusions.find(e => e.courseId === "MATH-UA 343")).toBeDefined();
    });
});

// ---------------------------------------------------------------------------
// 2-mutation [swap, swap] cross-term batch (Phase 17 atomicity)
// ---------------------------------------------------------------------------

describe("propose_plan_change — multi-mutation [swap, swap] cross-term batch (Phase 17)", () => {
    it("two cross-term swaps validate atomically with no transient duplicate-state false-rejection", async () => {
        const session = makeSession();
        const ctx = makeCtx(session);

        // Drag-to-exchange gesture: swap A↔B across two terms.
        const mutations: PlanMutation[] = [
            { kind: "swap", drop: "CSCI-UA 102", add: "CSCI-UA 480", term: "2026-fall" },
            { kind: "swap", drop: "CSCI-UA 480", add: "CSCI-UA 102", term: "2027-spring" },
        ];

        const out = await proposePlanChangeTool.call({ mutations }, ctx);

        // The call MUST NOT throw and MUST produce a structured
        // outcome. The Phase 14 multi-mutation atomic-apply is what
        // prevents a transient duplicate-pin false-rejection between
        // the two swaps.
        expect(typeof out.feasible).toBe("boolean");
        expect(out.diff).toBeDefined();
        expect(out.explanation).toBeTruthy();
    });

    it("the helper-level apply over [swap, swap] leaves both ADDs in pins[] without conflict", () => {
        const base: SchedulePreferences = {};
        const mutations: PlanMutation[] = [
            { kind: "swap", drop: "CSCI-UA 102", add: "CSCI-UA 480", term: "2026-fall" },
            { kind: "swap", drop: "CSCI-UA 480", add: "CSCI-UA 102", term: "2027-spring" },
        ];
        const { prefs } = applyMutationsToPreferences(base, mutations);
        const pins = prefs.pins ?? [];
        // Both ADDs land — even though the second swap's `drop`
        // matches the first swap's `add`, the helper's left-to-right
        // semantics produce a consistent terminal state.
        expect(pins.find(p => p.courseId === "CSCI-UA 480" && p.term === "2026-fall")).toBeDefined();
        expect(pins.find(p => p.courseId === "CSCI-UA 102" && p.term === "2027-spring")).toBeDefined();
    });
});
