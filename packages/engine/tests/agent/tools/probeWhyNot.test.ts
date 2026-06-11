/**
 * D2.2 — "why-not" framing on probe_counterfactual output.
 *
 * This test PINS the why-not contract as a single coherent surface:
 *   • A probe the validator REJECTS renders
 *     `PROBE (<arm>) — INFEASIBLE — [<conflictSource>] <conflictDetail>` where
 *     `conflictDetail` is the validator's failing-AXIS + reason string.
 *   • A probe that PASSES renders `PROBE (<arm>) — VALID …`; and when the
 *     re-solve introduces a trade-off (a non-empty `planDiff` trade-off field),
 *     the summary BOTH announces it in the header (`VALID (with trade-offs)`)
 *     and renders the D3.1 "Trade-offs:" section from `planDiff`.
 *
 * HONEST SCOPE (the point of D2.2 — see Docs/current-system/tools/probe_counterfactual.md):
 *   `graduationPathValidator.ts` ALWAYS emits `conflictSource: "other"` and
 *   `conflictDetail: \`Axes failed: <axis>: <reason>\``, with
 *   `relaxationSuggestions: []`. The why-not binding constraint is therefore
 *   AXIS-LEVEL (which graduation axis failed + the axis's own reason), NOT a
 *   course-causal sentence ("failing 101 breaks the prereq chain for 102").
 *   The course-causal phrasing is an explicitly-OPTIONAL future engine task and
 *   is NOT part of D2.2. This test pins `conflictSource === "other"` so a future
 *   reader knows the why-not is axis-level by design, not by accident.
 *
 * NOTE on the trade-off rendering: with the synthetic fixtures here, a FEASIBLE
 * Arm-A mutation does not populate the labeled trade-off fields
 * (newUnmet/cascaded/petition/assumptions stay empty) — those only become
 * non-empty when a requirement actually breaks, which the validator then marks
 * INFEASIBLE. So the "valid-with-trade-offs" rendering branch is pinned as a
 * PURE-FUNCTION contract on `summarizeResult` (a synthesized feasible output
 * carrying a non-empty trade-off field), which is exactly what D3.1 emits when
 * the engine ever produces that combination. The end-to-end infeasible probe
 * (reached through the real solver) pins the live INFEASIBLE half.
 */

import { describe, it, expect } from "vitest";
import {
    probeCounterfactualTool,
    type ProbeCounterfactualOutput,
} from "../../../src/agent/tools/probeCounterfactual.js";
import { buildForwardSchedule } from "../../../src/agent/forwardSchedule/build.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
} from "../../../src/dpr/schema.js";
import type { Course } from "@nyupath/shared";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";

// ---------------------------------------------------------------------------
// Fixtures (mirrors probeCounterfactual.test.ts — synthetic, fabricated)
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:SYNTHETIC-probe-whynot-fixture",
        sourcePdfPageCount: 0,
        parseDurationMs: 0,
        warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
    };
}

function makePlannableDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
    const dpr: DegreeProgressReport = {
        _meta: makeMeta(),
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
    return { signal: new AbortController().signal, session };
}

// ---------------------------------------------------------------------------
// (1) INFEASIBLE half — reached through the REAL solver + validator.
// ---------------------------------------------------------------------------

describe("probe why-not — INFEASIBLE renders the failing-axis + reason", () => {
    /**
     * Arm A: move the only candidate for SR/20 (CSCI-UA 201) out to a term it
     * cannot be placed in → SR/20 reopens → Axis 1
     * (requirementGroupsSatisfied) fails → the validator's infeasibilityReport
     * is the binding constraint. (Same infeasible mechanism the existing
     * probeCounterfactual.test.ts exercises via fail_completed; here driven via
     * an Arm-A mutation so a single fixture yields both halves.)
     */
    async function runInfeasibleProbe(): Promise<ProbeCounterfactualOutput> {
        const session = makeSession();
        const forwardSchedule = buildForwardSchedule({
            session,
            dpr: session.degreeProgressReport!,
            graduationTermOverride: "2027-spring",
        });
        const ctx = makeCtx({ ...session, forwardSchedule });
        return probeCounterfactualTool.call(
            { kind: "future_course", mutations: [{ kind: "exclude", courseId: "CSCI-UA 201" }] },
            ctx,
        );
    }

    it("output.feasible === false and conflicts[0].detail is the axis-and-reason string", async () => {
        const out = await runInfeasibleProbe();

        expect(out.feasible).toBe(false);
        expect(out.conflicts).toBeDefined();
        expect(out.conflicts!.length).toBeGreaterThan(0);

        const detail = out.conflicts![0]!.detail;
        // Sourced verbatim from infeasibilityReport.conflictDetail — a
        // human-readable failing-axis + reason string, NOT a bare boolean.
        expect(typeof detail).toBe("string");
        expect(detail).toMatch(/Axes failed|requirementGroupsSatisfied|graduationTargetMet/);
    });

    it("HONEST SCOPE — conflictSource is always 'other' (axis-level, NOT course-causal)", async () => {
        const out = await runInfeasibleProbe();
        // graduationPathValidator.ts hard-codes conflictSource: "other" and
        // conflictDetail: `Axes failed: <axis>: <reason>` with no course-causal
        // mapping. Pinning this documents that the why-not framing is axis-level
        // by design — a future course-causal binding-constraint sentence is an
        // OPTIONAL engine enhancement, out of scope for D2.2.
        expect(out.conflicts![0]!.kind).toBe("other");
    });

    it("summarizeResult renders 'INFEASIBLE — …<that axis reason>…'", async () => {
        const out = await runInfeasibleProbe();
        const summary = probeCounterfactualTool.summarizeResult!(out);

        expect(summary).toMatch(/PROBE \(future_course\) — INFEASIBLE —/);
        // The binding constraint (the axis reason) is carried into the summary,
        // not flattened to a bare "infeasible".
        expect(summary).toContain(out.conflicts![0]!.detail);
        expect(summary).toMatch(/Axes failed|requirementGroupsSatisfied|graduationTargetMet/);
    });
});

// ---------------------------------------------------------------------------
// (2) VALID half — a feasible probe renders VALID and surfaces the planDiff.
// ---------------------------------------------------------------------------

describe("probe why-not — VALID renders the trade-off-aware framing", () => {
    it("a feasible probe renders 'VALID' and surfaces the planDiff delta in the summary", async () => {
        const session = makeSession();
        const forwardSchedule = buildForwardSchedule({
            session,
            dpr: session.degreeProgressReport!,
            graduationTermOverride: "2027-spring",
        });
        const ctx = makeCtx({ ...session, forwardSchedule });

        // Pin CSCI-UA 201 to a valid future term — re-solves to a VALID plan and
        // produces a non-empty planDiff (Balance / graduation-term delta).
        const out = await probeCounterfactualTool.call(
            { kind: "future_course", mutations: [{ kind: "pin", courseId: "CSCI-UA 201", term: "2027-spring" }] },
            ctx,
        );

        expect(out.feasible).toBe(true);
        const summary = probeCounterfactualTool.summarizeResult!(out);
        expect(summary).toMatch(/PROBE \(future_course\) — VALID/);
        // The planDiff delta is surfaced (D3.1 made planDiff agent-reachable).
        expect(out.planDiff).toBeDefined();
        expect(summary).toContain("Balance:");
    });

    it("VALID-with-trade-offs — summarizeResult announces trade-offs in the header AND renders the D3.1 'Trade-offs:' section (pure-function contract)", () => {
        // PURE-FUNCTION pin. With the synthetic fixtures a feasible re-solve does
        // not populate the labeled trade-off fields (see file header), so the
        // valid-with-trade-offs RENDERING BRANCH is pinned directly on
        // summarizeResult with a synthesized feasible output carrying a
        // non-empty trade-off field — exactly the shape D3.1's buildPlanDiff
        // emits whenever the engine produces that combination.
        const feasibleWithTradeOff = {
            arm: "future_course",
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: ["Counterfactual re-solves to a VALID plan."],
            conflicts: undefined,
            schedule: undefined,
            state: "valid-with-trade-offs",
            planDiff: {
                creditsByTermDelta: {},
                weightedCreditsByTermDelta: {},
                workloadTierShifts: [],
                graduationTermShift: 0,
                balanceImpact: { before: 10, after: 12, delta: 2, classification: "degraded-mild" },
                planStateChange: undefined,
                newRequiresPetition: ["CSCI-UA 310"],
                removedRequiresPetition: [],
                newUnmetRequirements: [],
                cascadedShifts: [
                    { courseId: "CSCI-UA 201", fromTerm: "2026-fall", toTerm: "2027-spring", becauseOf: "pin" },
                ],
                newAssumptions: [],
                validationResultsChanges: {},
            },
        } as unknown as ProbeCounterfactualOutput;

        const summary = probeCounterfactualTool.summarizeResult!(feasibleWithTradeOff);

        // Header explicitly announces a VALID-but-with-trade-offs verdict — the
        // symmetric counterpart to INFEASIBLE-because-<axis>. (RED before the
        // D2.2 summary tweak: previously the header was a bare "— VALID —".)
        expect(summary).toMatch(/PROBE \(future_course\) — VALID \(with trade-offs\)/);
        // The D3.1 "Trade-offs:" section is rendered from planDiff.
        expect(summary).toContain("Trade-offs:");
        expect(summary).toContain("now requires petition: CSCI-UA 310");
        expect(summary).toContain("cascaded shifts:");
    });

    it("VALID with NO trade-offs — header stays a bare 'VALID' (no spurious trade-off claim)", () => {
        const benign = {
            arm: "future_course",
            feasible: true,
            diff: { added: [], removed: [] },
            consequences: [],
            conflicts: undefined,
            schedule: undefined,
            state: "valid",
            planDiff: {
                creditsByTermDelta: {},
                weightedCreditsByTermDelta: {},
                workloadTierShifts: [],
                graduationTermShift: 0,
                balanceImpact: { before: 10, after: 10, delta: 0, classification: "negligible" },
                planStateChange: undefined,
                newRequiresPetition: [],
                removedRequiresPetition: [],
                newUnmetRequirements: [],
                cascadedShifts: [],
                newAssumptions: [],
                validationResultsChanges: {},
            },
        } as unknown as ProbeCounterfactualOutput;

        const summary = probeCounterfactualTool.summarizeResult!(benign);
        expect(summary).toMatch(/PROBE \(future_course\) — VALID —/);
        expect(summary).not.toContain("(with trade-offs)");
        expect(summary).not.toContain("Trade-offs:");
    });
});
