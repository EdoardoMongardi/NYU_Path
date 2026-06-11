/**
 * D3.2 — double-count advisory CITATION on the plan-change tools.
 *
 * The advisory (buildDoubleCountAdvisory) returns a structured Disclaimer
 * carrying `reason` + `bulletinSource` (the citation). plan_forward_degree
 * already carries it correctly — on the envelope `disclaimers[]`, rendered
 * by renderEnvelopeMeta so the citation surfaces. These tests pin the SAME
 * cited-envelope form on the three plan-change tools, where the citation was
 * previously DROPPED (propose/confirm pushed only the bare `.text` into
 * `consequences[]`) or ABSENT (simulate never built it):
 *
 *   (a)  propose_plan_change  — advisory on output.disclaimers WITH its
 *        bulletinSource; summarizeResult renders the `source:` citation line.
 *   (a2) confirm_plan_change   — same.
 *   (b)  simulate_alternatives — advisory now surfaces (previously absent).
 *   (c)  control: single-program DPR → no advisory anywhere.
 *
 * Fixtures mirror tests/agent/doubleCountAdvisoryWiring.test.ts (the real
 * forward-schedule solver runs end-to-end) + the cited CAS doubleCounting
 * config. The solver does NOT read dpr.programs, so declaring programs is
 * purely additive — the schedule is identical; only the advisory differs.
 */

import { describe, it, expect } from "vitest";
import { proposePlanChangeTool } from "../../../src/agent/tools/proposePlanChange.js";
import { confirmPlanChangeTool } from "../../../src/agent/tools/confirmPlanChange.js";
import { simulateAlternativesTool } from "../../../src/agent/tools/simulateAlternatives.js";
import { planForwardDegreeTool } from "../../../src/agent/tools/planForwardDegree.js";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../../src/dpr/schema.js";
import type { SchoolConfig, ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures
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

function makeDpr(
    programs: DprProgram[],
    cumulativeOverride: Partial<DegreeProgressReport["cumulative"]> = {},
    historyOverride: DegreeProgressReport["courseHistory"] = [],
): DegreeProgressReport {
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
            ...cumulativeOverride,
        },
        requirementGroups: [],
        courseHistory: historyOverride,
    };
}

// Cited, quantified CAS double-counting config — same numbers as the unit test.
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

function makeSession(dpr: DegreeProgressReport, dc?: SchoolConfig["doubleCounting"]): ToolSession {
    return {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "Major" }],
            coursesTaken: [],
            visaStatus: "f1",
        },
        schoolConfig: schoolConfig(dc),
        degreeProgressReport: dpr,
    } as unknown as ToolSession;
}

function makeCtx(session: ToolSession): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

const TWO_PROGRAMS: DprProgram[] = [program("Major", "Economics"), program("Minor", "Computer Science")];
const ONE_PROGRAM: DprProgram[] = [program("Major", "Economics")];

const SET_BALANCED_LOAD = { kind: "loadStyleOverride", style: "balanced" } as const;

// The advisory disclaimer id buildDoubleCountAdvisory emits.
const ADVISORY_ID = "double_count_advisory";

function advisoryOf(output: { disclaimers?: { id: string }[] }) {
    return output.disclaimers?.find((d) => d.id === ADVISORY_ID);
}

// An infeasible ForwardSchedule stub (so simulate_alternatives does not
// short-circuit with "feasible, no alternatives needed").
function makeInfeasibleSchedule(): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2026-fall",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [],
        dprCourseHistoryHash: "test-hash",
        computedAt: Date.now(),
        feasibility: {
            feasible: false,
            infeasibilityReason: "graduation_total: cannot reach 128 credits in time",
            constraintViolations: [
                { kind: "graduation_total", detail: "Only 124 credits reachable" },
            ],
            placementRationale: {},
        },
        state: "infeasible-draft",
        balanceScore: 0,
        assumptions: [],
    };
}

// ---------------------------------------------------------------------------
// (a) propose_plan_change — cited Disclaimer on the envelope
// ---------------------------------------------------------------------------

describe("propose_plan_change — double-count advisory carried as a cited Disclaimer (D3.2)", () => {
    it("carries the advisory as a STRUCTURED Disclaimer with its bulletinSource (not just a bare consequences string)", async () => {
        const session = makeSession(makeDpr(TWO_PROGRAMS), CAS_DC);
        // Seed session.forwardSchedule so validateInput passes + currentPlan exists.
        const plan = await planForwardDegreeTool.call({}, makeCtx(session));
        expect(plan.storedIn).toBe("forwardSchedule");

        const output = await proposePlanChangeTool.call(
            { mutations: [SET_BALANCED_LOAD] },
            makeCtx(session),
        );

        const advisory = advisoryOf(output);
        expect(advisory).toBeTruthy();
        // The citation must be PRESERVED — reason + the bulletin source.
        expect(advisory!.reason).toBeTruthy();
        expect(advisory!.bulletinSource).toBe(CAS_DC!.sourceRef);

        // It must NOT be carried only as a bare string in consequences (the old bug).
        const bareInConsequences = output.consequences.some((c) => /double-count/i.test(c));
        expect(bareInConsequences).toBe(false);

        // summarizeResult must render the citation (the `source:` line).
        const summarized = proposePlanChangeTool.summarizeResult(output);
        expect(summarized).toContain("double-count");
        expect(summarized).toContain(`source: ${CAS_DC!.sourceRef}`);
    });
});

// ---------------------------------------------------------------------------
// (a2) confirm_plan_change — cited Disclaimer on the envelope
// ---------------------------------------------------------------------------

describe("confirm_plan_change — double-count advisory carried as a cited Disclaimer (D3.2)", () => {
    it("carries the advisory as a STRUCTURED Disclaimer with its bulletinSource (not just a bare consequences string)", async () => {
        const session = makeSession(makeDpr(TWO_PROGRAMS), CAS_DC);
        const plan = await planForwardDegreeTool.call({}, makeCtx(session));
        expect(plan.storedIn).toBe("forwardSchedule");

        const output = await confirmPlanChangeTool.call(
            { mutations: [SET_BALANCED_LOAD] },
            makeCtx(session),
        );

        const advisory = advisoryOf(output);
        expect(advisory).toBeTruthy();
        expect(advisory!.reason).toBeTruthy();
        expect(advisory!.bulletinSource).toBe(CAS_DC!.sourceRef);

        const bareInConsequences = output.consequences.some((c) => /double-count/i.test(c));
        expect(bareInConsequences).toBe(false);

        const summarized = confirmPlanChangeTool.summarizeResult(output);
        expect(summarized).toContain("double-count");
        expect(summarized).toContain(`source: ${CAS_DC!.sourceRef}`);
    });
});

// ---------------------------------------------------------------------------
// (b) simulate_alternatives — advisory now surfaces (previously absent)
// ---------------------------------------------------------------------------

describe("simulate_alternatives — double-count advisory now surfaced (D3.2)", () => {
    it("carries the advisory as a cited Disclaimer + cites it in the summary", async () => {
        // Infeasible DPR (1 term available, needs 128 credits, 108 earned) so the
        // tool runs the alternatives generator rather than short-circuiting.
        const dpr = makeDpr(
            TWO_PROGRAMS,
            { creditsUsed: 108 },
            [
                {
                    type: "IP",
                    subject: "CSCI-UA",
                    catalogNbr: "102",
                    description: "Data Structures",
                    credits: 4,
                    grade: null,
                    term: "2026 Fall",
                    ruleIds: [],
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
            ],
        );
        const session = makeSession(dpr, CAS_DC);
        // Infeasible stub so the tool does not short-circuit ("feasible, no alternatives").
        session.forwardSchedule = makeInfeasibleSchedule();

        const output = await simulateAlternativesTool.call({}, makeCtx(session));

        const advisory = advisoryOf(output);
        expect(advisory).toBeTruthy();
        expect(advisory!.bulletinSource).toBe(CAS_DC!.sourceRef);

        const summarized = simulateAlternativesTool.summarizeResult(output);
        expect(summarized).toContain("double-count");
        expect(summarized).toContain(`source: ${CAS_DC!.sourceRef}`);
    });
});

// ---------------------------------------------------------------------------
// (c) control — single-program DPR → no advisory anywhere
// ---------------------------------------------------------------------------

describe("plan-change tools — no advisory for a single-program student (control)", () => {
    it("propose_plan_change: no advisory disclaimer + no double-count line in summary", async () => {
        const session = makeSession(makeDpr(ONE_PROGRAM), CAS_DC);
        await planForwardDegreeTool.call({}, makeCtx(session));

        const output = await proposePlanChangeTool.call(
            { mutations: [SET_BALANCED_LOAD] },
            makeCtx(session),
        );

        expect(advisoryOf(output)).toBeUndefined();
        expect(output.consequences.some((c) => /double-count/i.test(c))).toBe(false);
        expect(proposePlanChangeTool.summarizeResult(output)).not.toContain("double-count");
    });

    it("confirm_plan_change: no advisory disclaimer + no double-count line in summary", async () => {
        const session = makeSession(makeDpr(ONE_PROGRAM), CAS_DC);
        await planForwardDegreeTool.call({}, makeCtx(session));

        const output = await confirmPlanChangeTool.call(
            { mutations: [SET_BALANCED_LOAD] },
            makeCtx(session),
        );

        expect(advisoryOf(output)).toBeUndefined();
        expect(output.consequences.some((c) => /double-count/i.test(c))).toBe(false);
        expect(confirmPlanChangeTool.summarizeResult(output)).not.toContain("double-count");
    });

    it("simulate_alternatives: no advisory disclaimer for a single-program student", async () => {
        const dpr = makeDpr(
            ONE_PROGRAM,
            { creditsUsed: 108 },
            [
                {
                    type: "IP",
                    subject: "CSCI-UA",
                    catalogNbr: "102",
                    description: "Data Structures",
                    credits: 4,
                    grade: null,
                    term: "2026 Fall",
                    ruleIds: [],
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any,
            ],
        );
        const session = makeSession(dpr, CAS_DC);
        session.forwardSchedule = makeInfeasibleSchedule();

        const output = await simulateAlternativesTool.call({}, makeCtx(session));

        expect(advisoryOf(output)).toBeUndefined();
        expect(simulateAlternativesTool.summarizeResult(output)).not.toContain("double-count");
    });
});
