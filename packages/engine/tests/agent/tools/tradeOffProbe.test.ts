/**
 * D3.1 — agent-reachable trade-off diff via probe_counterfactual.
 *
 * The probe ALREADY computes the rich trade-off delta on `output.planDiff`
 * (via `buildPlanDiff` → `diffPlanTradeOffs`): `newRequiresPetition`,
 * `removedRequiresPetition`, `newUnmetRequirements`, `cascadedShifts`,
 * `newAssumptions`. But `summarizeResult` historically rendered ONLY
 * `balanceImpact` + `planStateChange` — so the trade-off fields were CARRIED
 * but NOT visible to the LLM.
 *
 * D3.1 makes them VISIBLE: `summarizeResult` now renders a concise
 * "Trade-offs:" section from the non-empty trade-off fields, so the agent can
 * read (and reason over) the engine's computed delta openly — it cannot invent
 * one; it reads `diffPlanTradeOffs`'s output.
 *
 * Assertions:
 *   (a) REACHABILITY — a real probe call carries a `planDiff` exposing the
 *       trade-off fields (pins that `diffPlanTradeOffs`'s output is reachable
 *       through the probe; likely already passes).
 *   (b) SURFACED — for a probe output whose `planDiff` carries a REAL non-empty
 *       trade-off delta (built via the real `diffPlanTradeOffs` over two
 *       directly-constructed schedules, NOT hand-faked), `summarizeResult`
 *       emits a "Trade-offs:" section naming the re-opened requirement, the
 *       cascaded shift, the new petition, and the new assumption. RED→GREEN.
 *   (c) GUARDED CONTROL — a probe output with all-empty trade-off fields does
 *       NOT emit a spurious "Trade-offs:" section.
 *
 * The (b)/(c) trade-off DATA is produced by the SAME engine the probe uses
 * (`diffPlanTradeOffs`); the schedule fixtures mirror the proven pattern in
 * `tests/forwardSchedule/tradeOffEngine.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { probeCounterfactualTool } from "../../../src/agent/tools/probeCounterfactual.js";
import type { ProbeCounterfactualOutput } from "../../../src/agent/tools/probeCounterfactual.js";
import { diffPlanTradeOffs } from "../../../src/agent/forwardSchedule/tradeOffEngine.js";
import { buildForwardSchedule } from "../../../src/agent/forwardSchedule/build.js";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
} from "../../../src/dpr/schema.js";
import type {
    Course,
    ForwardSchedule,
    ForwardSemester,
    ScheduleSlot,
    Assumption,
    PlanDiff,
} from "@nyupath/shared";

// ===========================================================================
// Part 1 fixtures — a REAL probe call (reachability), mirroring D2.1.
// ===========================================================================

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:SYNTHETIC-tradeoff-probe-fixture",
        sourcePdfPageCount: 0,
        parseDurationMs: 0,
        warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
    };
}

function makePlannableDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    const dpr: DegreeProgressReport = {
        _meta: makeMeta(),
        reportKind: "dpr",
        header: { studentName: "Synthetic Student (fabricated)", preparedDate: "01/01/2026" },
        programs: [
            {
                programType: "Undergraduate Career",
                label: "UA-Coll of Arts & Sci",
                requirementTerm: "Fall 2024",
                requirementStatus: "not_satisfied",
            },
        ],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 120,
            cumulativeGpa: 3.5,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [
            {
                rgId: "RG1",
                title: "Computer Science Major",
                status: "not_satisfied",
                statusText: "Not Satisfied: Complete the Computer Science major.",
                children: [
                    {
                        rId: "SR/10",
                        title: "Intro Requirement",
                        status: "satisfied",
                        statusText: "Satisfied: Intro completed.",
                        counter: { kind: "courses", required: 1, used: 1, needed: 0 },
                        coursesUsed: [
                            {
                                term: "2024 Fall",
                                subject: "CSCI-UA",
                                catalogNbr: "101",
                                courseTitle: "Intro to Computer Science",
                                grade: "A",
                                units: 4,
                                type: "EN",
                            },
                        ],
                    },
                    {
                        rId: "SR/20",
                        title: "Algorithms Requirement",
                        status: "not_satisfied",
                        statusText: "Not Satisfied: Choose CSCI-UA 201.",
                        counter: { kind: "courses", required: 1, used: 0, needed: 1 },
                        coursesUsed: [],
                    },
                ],
            },
        ],
        courseHistory: [
            {
                term: "2024 Fall",
                subject: "CSCI-UA",
                catalogNbr: "101",
                courseTitle: "Intro to Computer Science",
                grade: "A",
                units: 4,
                type: "EN",
            },
        ],
        ...overrides,
    };
    return degreeProgressReportSchema.parse(dpr);
}

function makeCourses(): Course[] {
    return [
        {
            id: "CSCI-UA 201",
            title: "Computer Systems Organization",
            credits: 4,
            termsOffered: ["fall", "spring"],
        },
        {
            id: "CSCI-UA 101",
            title: "Intro to Computer Science",
            credits: 4,
            termsOffered: ["fall", "spring"],
        },
    ];
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
        degreeProgressReport: makePlannableDpr(),
        courses: makeCourses(),
        ...overrides,
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session,
    };
}

function makeSessionWithRealPlan(overrides: Partial<ToolSession> = {}): ToolSession {
    const session = makeSession(overrides);
    const forwardSchedule = buildForwardSchedule({
        session,
        dpr: session.degreeProgressReport!,
        graduationTermOverride: "2027-spring",
    });
    return { ...session, forwardSchedule };
}

// ===========================================================================
// Part 2 fixtures — direct ForwardSchedule builders (proven pattern from
// tests/forwardSchedule/tradeOffEngine.test.ts) to feed the REAL
// diffPlanTradeOffs and produce a non-empty trade-off delta deterministically.
// ===========================================================================

function specificSlot(
    courseId: string,
    opts: { rules?: string[]; petition?: boolean; credits?: number } = {},
): ScheduleSlot {
    return {
        kind: "specific_planned",
        courseId,
        title: courseId,
        credits: opts.credits ?? 4,
        satisfiesRules: opts.rules ?? [],
        reason: "x",
        ...(opts.petition ? { requiresPetition: true } : {}),
        rationale: {
            satisfiesRequirements: opts.rules ?? [],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: [],
        },
        downstreamImpact: { courseIds: [], graduationDelay: 0 },
        workloadTier: "major-elective",
        workloadWeight: 0.5,
        bindingState: "bound",
        confidence: "historically_partial",
        isCriticalPath: false,
    };
}

function semester(term: string, slots: ScheduleSlot[]): ForwardSemester {
    const plannedCredits = slots.reduce(
        (s, x) =>
            s +
            (x.kind === "placeholder" ||
            x.kind === "specific_planned" ||
            x.kind === "completed" ||
            x.kind === "in_progress"
                ? x.credits
                : 0),
        0,
    );
    return {
        term,
        locked: false,
        slots,
        plannedCredits,
        notes: [],
        loadRationale: {
            strategy: "balanced",
            creditsTarget: 16,
            slack: 0,
            weightedCredits: 0,
            hardCount: 0,
            easyCount: 0,
            alternativeDistributionsConsidered: [],
        },
    };
}

function forwardSchedule(
    semesters: ForwardSemester[],
    assumptions: Assumption[] = [],
): ForwardSchedule {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters,
        dprCourseHistoryHash: "h",
        computedAt: 0,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 1,
        assumptions,
    };
}

const IP_ASSUMPTION = (courseId: string): Assumption => ({
    type: "IP_COURSE_COMPLETION",
    courseId,
    consequenceIfFalse: "if you don't pass it, the plan shifts",
    cascadingSlots: [],
    contingencyPlanAvailable: false,
});

/**
 * An empty-balance/no-state scaffold so we can splice a real trade-off
 * `planDiff` onto a ProbeCounterfactualOutput for the summarizeResult unit.
 */
function emptyBalance(): PlanDiff["balanceImpact"] {
    return { before: 1, after: 1, delta: 0, classification: "negligible" };
}

/**
 * Build a ProbeCounterfactualOutput carrying `tradeOffs` on its planDiff.
 * The trade-off fields come from the REAL diffPlanTradeOffs; everything else
 * is a benign feasible scaffold so summarizeResult's non-trade-off branches
 * stay quiet.
 */
function probeOutputWithTradeOffs(
    tradeOffs: ReturnType<typeof diffPlanTradeOffs>,
): ProbeCounterfactualOutput {
    const planDiff: PlanDiff = {
        creditsByTermDelta: {},
        graduationTermShift: 0,
        newRequiresPetition: tradeOffs.newRequiresPetition,
        removedRequiresPetition: tradeOffs.removedRequiresPetition,
        newUnmetRequirements: tradeOffs.newUnmetRequirements,
        cascadedShifts: tradeOffs.cascadedShifts,
        weightedCreditsByTermDelta: {},
        workloadTierShifts: [],
        balanceImpact: emptyBalance(),
        newAssumptions: tradeOffs.newAssumptions,
        validationResultsChanges: {},
    };
    return {
        arm: "fail_completed",
        feasible: true,
        diff: { added: [], removed: [] },
        consequences: [],
        schedule: forwardSchedule([]),
        state: "valid-clean",
        planDiff,
    };
}

// ===========================================================================
// (a) REACHABILITY — a real probe carries the trade-off fields on planDiff.
// ===========================================================================

describe("D3.1 — trade-off diff is reachable on the probe output", () => {
    it("a real probe call carries a planDiff exposing the trade-off fields", async () => {
        const session = makeSessionWithRealPlan();
        const ctx = makeCtx(session);

        const output = await probeCounterfactualTool.call(
            { kind: "fail_completed", courseId: "CSCI-UA 101" },
            ctx,
        );

        // The rich delta — and specifically the trade-off fields produced by
        // diffPlanTradeOffs — is reachable on the probe output (not just
        // balanceImpact/planStateChange). This pins the reachability contract.
        expect(output.planDiff).toBeDefined();
        const pd = output.planDiff!;
        expect(Array.isArray(pd.newRequiresPetition)).toBe(true);
        expect(Array.isArray(pd.newUnmetRequirements)).toBe(true);
        expect(Array.isArray(pd.cascadedShifts)).toBe(true);
        expect(Array.isArray(pd.newAssumptions)).toBe(true);
    });
});

// ===========================================================================
// (b) SURFACED — summarizeResult renders a Trade-offs section naming each
//     non-empty trade-off field. RED→GREEN.
// ===========================================================================

describe("D3.1 — trade-off diff is surfaced in summarizeResult", () => {
    it("renders petitions, newly-unmet requirements, cascaded shifts, and new assumptions", () => {
        // Build a REAL trade-off delta from two directly-constructed schedules:
        //   - R1 loses its only bound satisfier (CSCI-UA 1 dropped)  → newUnmetRequirements ["R1"]
        //   - CSCI-UA 2 now requires a petition                      → newRequiresPetition ["CSCI-UA 2"]
        //   - MATH-UA 5 shifts 2026-fall → 2027-spring               → cascadedShifts
        //   - a new IP_COURSE_COMPLETION assumption appears          → newAssumptions
        const before = forwardSchedule([
            semester("2026-fall", [
                specificSlot("CSCI-UA 1", { rules: ["R1"] }),
                specificSlot("CSCI-UA 2"),
                specificSlot("MATH-UA 5"),
            ]),
            semester("2027-spring", []),
        ]);
        const after = forwardSchedule(
            [
                semester("2026-fall", [specificSlot("CSCI-UA 2", { petition: true })]),
                semester("2027-spring", [specificSlot("MATH-UA 5")]),
            ],
            [IP_ASSUMPTION("CSCI-UA 2")],
        );

        const tradeOffs = diffPlanTradeOffs(before, after);
        // Sanity: the engine populated each field (else the surfacing test is vacuous).
        expect(tradeOffs.newUnmetRequirements).toContain("R1");
        expect(tradeOffs.newRequiresPetition).toContain("CSCI-UA 2");
        expect(tradeOffs.cascadedShifts.length).toBeGreaterThan(0);
        expect(tradeOffs.newAssumptions.length).toBeGreaterThan(0);

        const output = probeOutputWithTradeOffs(tradeOffs);
        const summary = probeCounterfactualTool.summarizeResult!(output);

        // The labeled section is present and names each computed trade-off.
        expect(summary).toMatch(/Trade-offs:/);
        // newly-unmet requirement id (headline for an Arm-B re-open).
        expect(summary).toContain("R1");
        // new petition course.
        expect(summary).toContain("CSCI-UA 2");
        // cascaded shift: course + the from→to terms.
        expect(summary).toContain("MATH-UA 5");
        expect(summary).toContain("2026-fall");
        expect(summary).toContain("2027-spring");
        // new assumptions count surfaced.
        expect(summary).toMatch(/new assumptions/i);
    });
});

// ===========================================================================
// (c) GUARDED CONTROL — no spurious Trade-offs section when fields are empty.
// ===========================================================================

describe("D3.1 — no spurious Trade-offs section on a benign probe", () => {
    it("a probe output with all-empty trade-off fields omits the Trade-offs section", () => {
        // Two identical schedules → diffPlanTradeOffs returns all-empty fields.
        const plan = forwardSchedule([
            semester("2026-fall", [specificSlot("CSCI-UA 7", { rules: ["R7"] })]),
        ]);
        const tradeOffs = diffPlanTradeOffs(plan, plan);
        expect(tradeOffs.newUnmetRequirements).toEqual([]);
        expect(tradeOffs.newRequiresPetition).toEqual([]);
        expect(tradeOffs.cascadedShifts).toEqual([]);
        expect(tradeOffs.newAssumptions).toEqual([]);

        const output = probeOutputWithTradeOffs(tradeOffs);
        const summary = probeCounterfactualTool.summarizeResult!(output);

        expect(summary).not.toMatch(/Trade-offs:/);
    });
});
