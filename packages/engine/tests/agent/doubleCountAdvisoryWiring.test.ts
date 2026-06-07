/**
 * Wiring test — the double-count advisory surfaces on plan_forward_degree.
 *
 * The advisory itself (buildDoubleCountAdvisory) is unit-tested in
 * forwardSchedule/doubleCountAdvisory.test.ts. This test pins the WIRING:
 * plan_forward_degree attaches the advisory as an envelope `Disclaimer` for
 * multi-program students, renders it in summarizeResult, and never lets it
 * change the schedule / storedIn (advisory only — no enforcement).
 *
 * Construction reuses the planForwardDegree.test.ts session/DPR/ctx pattern
 * (the real forward-schedule solver runs end-to-end) plus the
 * doubleCountAdvisory.test.ts schoolConfig helper (which carries a cited
 * `doubleCounting` config). The solver does NOT read dpr.programs, so adding
 * declared programs is purely additive — the schedule is identical with or
 * without them; only the advisory differs.
 */

import { describe, it, expect } from "vitest";
import { planForwardDegreeTool } from "../../src/agent/tools/planForwardDegree.js";
import { proposePlanChangeTool } from "../../src/agent/tools/proposePlanChange.js";
import { confirmPlanChangeTool } from "../../src/agent/tools/confirmPlanChange.js";
import type { ToolSession, ToolUseContext } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { SchoolConfig } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures (session/DPR/ctx mirror planForwardDegree.test.ts; schoolConfig
// mirrors doubleCountAdvisory.test.ts so it carries a `doubleCounting` config)
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

type DprProgram = DegreeProgressReport["programs"][number];

function program(programType: string, label: string): DprProgram {
    return { programType, label, requirementTerm: "Fall 2024", requirementStatus: "satisfied" };
}

function makeDpr(programs: DprProgram[]): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs,
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
    };
}

// CAS double-counting config (cited, quantified) — same numbers as the unit test.
const CAS_DC: SchoolConfig["doubleCounting"] = {
    cap: { majorToMajor: 2, majorToMinor: 2, minorToMinor: 2 },
    noTripleCounting: true,
    requiresApproval: true,
    sourceRef: "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md:126",
};

function schoolConfig(doubleCounting?: SchoolConfig["doubleCounting"]): SchoolConfig {
    return {
        schoolId: "cas",
        name: "College of Arts and Science",
        courseSuffix: ["-UA"],
        residency: { type: "suffix_based", suffix: "-UA" },
        doubleCounting,
    } as SchoolConfig;
}

function makeSession(programs: DprProgram[], doubleCounting?: SchoolConfig["doubleCounting"]): ToolSession {
    return {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "Major" }],
            coursesTaken: [],
            visaStatus: "f1",
        },
        schoolConfig: schoolConfig(doubleCounting),
        degreeProgressReport: makeDpr(programs),
    } as unknown as ToolSession;
}

function makeCtx(session: ToolSession): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

function hasAdvisory(output: { disclaimers?: { id: string }[] }): boolean {
    return output.disclaimers?.some((d) => d.id === "double_count_advisory") ?? false;
}

const TWO_PROGRAMS: DprProgram[] = [program("Major", "Economics"), program("Minor", "Computer Science")];
const ONE_PROGRAM: DprProgram[] = [program("Major", "Economics")];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

describe("plan_forward_degree — double-count advisory wiring", () => {
    it("attaches the double_count_advisory disclaimer for a multi-program student with a doubleCounting config", async () => {
        const session = makeSession(TWO_PROGRAMS, CAS_DC);
        const output = await planForwardDegreeTool.call({}, makeCtx(session));

        expect(hasAdvisory(output)).toBe(true);
        const advisory = output.disclaimers!.find((d) => d.id === "double_count_advisory");
        expect(advisory).toBeTruthy();

        // summarizeResult must render the advisory text (contains "double-count").
        const summarized = planForwardDegreeTool.summarizeResult(output);
        expect(summarized).toContain("double-count");
    });

    it("does NOT attach the advisory for a single-program student", async () => {
        const session = makeSession(ONE_PROGRAM, CAS_DC);
        const output = await planForwardDegreeTool.call({}, makeCtx(session));

        expect(hasAdvisory(output)).toBe(false);
    });

    it("is purely additive — the advisory does not change storedIn or drop the schedule", async () => {
        const multi = await planForwardDegreeTool.call({}, makeCtx(makeSession(TWO_PROGRAMS, CAS_DC)));
        const single = await planForwardDegreeTool.call({}, makeCtx(makeSession(ONE_PROGRAM, CAS_DC)));

        // The multi-program advisory must not flip routing vs the single-program call.
        expect(multi.storedIn).toBe(single.storedIn);
        // The schedule is still produced (advisory never suppresses it).
        expect(multi.schedule).toBeTruthy();
        expect(single.schedule).toBeTruthy();
    });
});

// ---------------------------------------------------------------------------
// Edit-tool wiring (propose_plan_change / confirm_plan_change)
//
// These tools surface the advisory in `consequences[]` (NOT an envelope
// Disclaimer). Both require an existing plan in the session, so each case
// first runs plan_forward_degree on the SAME session (which writes
// session.forwardSchedule — the multi-program synthetic DPR plans feasibly,
// as the plan_forward_degree block above proves) and then runs the edit tool.
// The mutation is a plan-level `loadStyleOverride: balanced` — the simplest
// PlanMutation that applies cleanly (no no-op) and never depends on a real
// course catalog. The advisory is purely additive: it must NEVER change
// feasible / storedIn / the schedule — only add a string to consequences.
// ---------------------------------------------------------------------------

const SET_BALANCED_LOAD = { kind: "loadStyleOverride", style: "balanced" } as const;

function hasDoubleCountConsequence(consequences: string[]): boolean {
    return consequences.some((c) => /double-count/i.test(c));
}

describe("plan-change tools — double-count advisory wiring", () => {
    it("propose_plan_change pushes a double-count consequence for a multi-program student", async () => {
        const session = makeSession(TWO_PROGRAMS, CAS_DC);
        // Seed session.forwardSchedule so propose_plan_change's validateInput
        // passes and currentPlan is present.
        const plan = await planForwardDegreeTool.call({}, makeCtx(session));
        expect(plan.storedIn).toBe("forwardSchedule");
        expect(session.forwardSchedule).toBeTruthy();

        const output = await proposePlanChangeTool.call(
            { mutations: [SET_BALANCED_LOAD] },
            makeCtx(session),
        );

        expect(hasDoubleCountConsequence(output.consequences)).toBe(true);
    });

    it("confirm_plan_change pushes a double-count consequence for a multi-program student", async () => {
        const session = makeSession(TWO_PROGRAMS, CAS_DC);
        const plan = await planForwardDegreeTool.call({}, makeCtx(session));
        expect(plan.storedIn).toBe("forwardSchedule");
        expect(session.forwardSchedule).toBeTruthy();

        const output = await confirmPlanChangeTool.call(
            { mutations: [SET_BALANCED_LOAD] },
            makeCtx(session),
        );

        expect(hasDoubleCountConsequence(output.consequences)).toBe(true);
    });

    it("does NOT push a double-count consequence for a single-program student", async () => {
        const session = makeSession(ONE_PROGRAM, CAS_DC);
        const plan = await planForwardDegreeTool.call({}, makeCtx(session));
        expect(session.forwardSchedule ?? session.studentDraftPlan).toBeTruthy();

        const proposed = await proposePlanChangeTool.call(
            { mutations: [SET_BALANCED_LOAD] },
            makeCtx(session),
        );
        const confirmed = await confirmPlanChangeTool.call(
            { mutations: [SET_BALANCED_LOAD] },
            makeCtx(session),
        );

        expect(hasDoubleCountConsequence(proposed.consequences)).toBe(false);
        expect(hasDoubleCountConsequence(confirmed.consequences)).toBe(false);
    });
});
