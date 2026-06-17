/**
 * D2.1b — probe_counterfactual tool (two arms).
 *
 * RED-before-GREEN test for the read-only what-if probe.
 *
 * The probe applies a hypothetical → re-solves → runs the authoritative
 * 7-axis validator → reports the diff (valid) or the binding constraint
 * (infeasible). It NEVER writes to session (isReadOnly: true).
 *
 * Two arms:
 *   - Arm A `future_course`: apply PlanMutation[] to a hypothetical copy of
 *     schedulePreferences, then re-solve (exactly proposePlanChange minus the
 *     session write).
 *   - Arm B `fail_completed`: apply the pure `applyFailedCourseToDpr` transform
 *     to build a synthetic DPR (the failed course's grade → "F", removed from
 *     coursesUsed, its requirement re-opened), then re-solve against the
 *     SYNTHETIC dpr. session.degreeProgressReport is never touched.
 *
 * Assertions:
 *   (a)  Arm B reopens CSCI-UA 101's requirement (surfaces as a new unmet
 *        requirement / cascaded shift / diff); the tool returns coherently.
 *   (a2) Arm A excludes a placed future course → placement shifts (diff
 *        non-empty).
 *   (b)  byte-identical session after EITHER call (read-only).
 *   (c)  an infeasible probe → conflicts populated from the validator's
 *        infeasibilityReport.conflictDetail (a failing-axis+reason string).
 */

import { describe, it, expect } from "vitest";
import { probeCounterfactualTool } from "../../../src/agent/tools/probeCounterfactual.js";
import { buildDefaultRegistry } from "../../../src/agent/registry.js";
import { buildForwardSchedule } from "../../../src/agent/forwardSchedule/build.js";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
} from "../../../src/dpr/schema.js";
import type { Course } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:SYNTHETIC-probe-fixture",
        sourcePdfPageCount: 0,
        parseDurationMs: 0,
        warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
    };
}

/**
 * A DPR where:
 *   - CSCI-UA 101 is PASSED (grade A) and used by leaf SR/10 (satisfied).
 *   - leaf SR/20 is NOT satisfied; its statusText names candidate CSCI-UA 201,
 *     so the solver places CSCI-UA 201 as a FUTURE specific_planned course.
 *   - Cumulative credits leave room for exactly the placed future course(s).
 */
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

/** Candidate courses the solver can place. CSCI-UA 201 satisfies SR/20. */
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

/**
 * Build a session whose forwardSchedule is a REAL solve (so probes produce
 * meaningful diffs), using a generous graduation horizon so CSCI-UA 201 gets
 * placed as a future course.
 */
function makeSessionWithRealPlan(overrides: Partial<ToolSession> = {}): ToolSession {
    const session = makeSession(overrides);
    const forwardSchedule = buildForwardSchedule({
        session,
        dpr: session.degreeProgressReport!,
        graduationTermOverride: "2027-spring",
    });
    return { ...session, forwardSchedule };
}

/** Find the id of a future (specific_planned) course in the plan. */
function firstPlannedCourseId(session: ToolSession): string | undefined {
    const plan = session.forwardSchedule;
    if (!plan) return undefined;
    for (const sem of plan.semesters) {
        for (const slot of sem.slots) {
            if (slot.kind === "specific_planned") return slot.courseId;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

describe("probe_counterfactual — tool contract", () => {
    it("has name 'probe_counterfactual'", () => {
        expect(probeCounterfactualTool.name).toBe("probe_counterfactual");
    });

    it("is isReadOnly: true", () => {
        expect(probeCounterfactualTool.isReadOnly).toBe(true);
    });

    it("is registered in buildDefaultRegistry()", () => {
        const reg = buildDefaultRegistry();
        const names = reg.list().map((t) => t.name);
        expect(names).toContain("probe_counterfactual");
    });
});

// ---------------------------------------------------------------------------
// (a) Arm B — fail_completed reopens the failed course's requirement
// ---------------------------------------------------------------------------

describe("probe_counterfactual — Arm B (fail_completed)", () => {
    it("reopens CSCI-UA 101's requirement and returns coherently (no crash)", async () => {
        const session = makeSessionWithRealPlan();
        const ctx = makeCtx(session);

        const output = await probeCounterfactualTool.call(
            { kind: "fail_completed", courseId: "CSCI-UA 101" },
            ctx,
        );

        // Coherent result shape.
        expect(typeof output.feasible).toBe("boolean");
        expect(output.schedule).toBeDefined();
        expect(output.diff).toBeDefined();

        // Failing CSCI-UA 101 reopens SR/10 → the re-solve must reflect that
        // reopened requirement somewhere: a new unmet requirement, a cascaded
        // shift, a newly-placed CSCI-UA 101 future slot, OR a non-empty diff.
        const reopened101 = firstPlannedCourseId(session) === undefined
            ? false
            : output.schedule.semesters.some((sem) =>
                  sem.slots.some(
                      (s) => s.kind === "specific_planned" && s.courseId === "CSCI-UA 101",
                  ),
              );
        const diffNonEmpty =
            output.diff.added.length > 0 || output.diff.removed.length > 0;
        const newUnmet =
            (output.planDiff?.newUnmetRequirements?.length ?? 0) > 0;
        const cascaded = (output.planDiff?.cascadedShifts?.length ?? 0) > 0;

        expect(reopened101 || diffNonEmpty || newUnmet || cascaded).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// (a2) Arm A — future_course mutation shifts placement (diff non-empty)
// ---------------------------------------------------------------------------

describe("probe_counterfactual — Arm A (future_course)", () => {
    it("excluding a placed future course shifts the placement (diff non-empty)", async () => {
        const session = makeSessionWithRealPlan();
        const placed = firstPlannedCourseId(session);
        expect(placed).toBeDefined(); // sanity: the plan placed a future course

        const ctx = makeCtx(session);
        const output = await probeCounterfactualTool.call(
            { kind: "future_course", mutations: [{ kind: "exclude", courseId: placed! }] },
            ctx,
        );

        const diffNonEmpty =
            output.diff.added.length > 0 || output.diff.removed.length > 0;
        expect(diffNonEmpty).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// (b) read-only: byte-identical session after EITHER call
// ---------------------------------------------------------------------------

describe("probe_counterfactual — read-only invariant", () => {
    it("Arm B leaves session.forwardSchedule / schedulePreferences / DPR byte-identical", async () => {
        const session = makeSessionWithRealPlan({
            schedulePreferences: { pins: [{ courseId: "CSCI-UA 201", term: "2026-fall" }] },
        });
        const ctx = makeCtx(session);

        const beforeFs = JSON.parse(JSON.stringify(session.forwardSchedule));
        const beforePrefs = JSON.parse(JSON.stringify(session.schedulePreferences));
        const beforeDpr = JSON.parse(JSON.stringify(session.degreeProgressReport));

        await probeCounterfactualTool.call(
            { kind: "fail_completed", courseId: "CSCI-UA 101" },
            ctx,
        );

        expect(JSON.parse(JSON.stringify(session.forwardSchedule))).toEqual(beforeFs);
        expect(JSON.parse(JSON.stringify(session.schedulePreferences))).toEqual(beforePrefs);
        expect(JSON.parse(JSON.stringify(session.degreeProgressReport))).toEqual(beforeDpr);
    });

    it("Arm A leaves session.forwardSchedule / schedulePreferences / DPR byte-identical", async () => {
        const session = makeSessionWithRealPlan({
            schedulePreferences: { pins: [{ courseId: "CSCI-UA 201", term: "2026-fall" }] },
        });
        const placed = firstPlannedCourseId(session)!;
        const ctx = makeCtx(session);

        const beforeFs = JSON.parse(JSON.stringify(session.forwardSchedule));
        const beforePrefs = JSON.parse(JSON.stringify(session.schedulePreferences));
        const beforeDpr = JSON.parse(JSON.stringify(session.degreeProgressReport));

        await probeCounterfactualTool.call(
            { kind: "future_course", mutations: [{ kind: "exclude", courseId: placed }] },
            ctx,
        );

        expect(JSON.parse(JSON.stringify(session.forwardSchedule))).toEqual(beforeFs);
        expect(JSON.parse(JSON.stringify(session.schedulePreferences))).toEqual(beforePrefs);
        expect(JSON.parse(JSON.stringify(session.degreeProgressReport))).toEqual(beforeDpr);
    });
});

// ---------------------------------------------------------------------------
// (c) infeasible probe → conflicts from infeasibilityReport.conflictDetail
// ---------------------------------------------------------------------------

describe("probe_counterfactual — infeasible probe surfaces the binding constraint", () => {
    it("fail_completed on a course whose requirement cannot be re-satisfied in the horizon → conflicts populated", async () => {
        // FORCING INFEASIBILITY: the DPR's only unmet requirement is satisfied
        // by the now-graduated student's last term, with the graduation horizon
        // pinned to a SINGLE past-ish term and NO candidate course / offering
        // for the reopened requirement. Failing CSCI-UA 101 reopens SR/10, but
        // SR/10's candidate (CSCI-UA 101) cannot be re-placed because the
        // graduation horizon has no remaining term that offers it — Axis 1
        // (requirementGroupsSatisfied) / graduationTargetMet fails.
        const dpr = makePlannableDpr({
            // Already at the credit minimum: the ONLY thing the plan needs is to
            // keep SR/10 satisfied. Failing CSCI-UA 101 makes that impossible in
            // a zero-future-term horizon.
            cumulative: {
                creditsRequired: 128,
                creditsUsed: 128,
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
                    ],
                },
            ],
        });
        // No candidate course / no offering for the reopened requirement, and a
        // horizon with no future term that can place CSCI-UA 101 again.
        const session = makeSession({
            degreeProgressReport: dpr,
            courses: [], // no placeable candidate for the reopened SR/10
        });
        const forwardSchedule = buildForwardSchedule({
            session,
            dpr,
            graduationTermOverride: "2026-fall",
        });
        const withPlan: ToolSession = { ...session, forwardSchedule };
        const ctx = makeCtx(withPlan);

        const output = await probeCounterfactualTool.call(
            { kind: "fail_completed", courseId: "CSCI-UA 101" },
            ctx,
        );

        expect(output.feasible).toBe(false);
        expect(output.conflicts).toBeDefined();
        expect(output.conflicts!.length).toBeGreaterThan(0);
        // The conflict detail is a human-readable failing-axis+reason string
        // from the validator's infeasibilityReport — NOT a bare boolean.
        const detail = output.conflicts![0]!.detail;
        expect(typeof detail).toBe("string");
        expect(detail.length).toBeGreaterThan(0);
        expect(detail).toMatch(/Axes failed|requirementGroupsSatisfied|graduationTargetMet/);
    });
});
