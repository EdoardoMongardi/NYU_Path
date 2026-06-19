/**
 * Plan 37 — Task C2 fix-loop integration test.
 *
 * Proves the 8th validator axis (`passFailLimitsRespected`) actually ENGAGES
 * in the REAL P/F-election flow: a student claims a Pass/Fail election on a
 * current-term IP course, the synthetic-DPR transform (B1) increments
 * `cumulative.passFailUsedUnits`, and `solveWhatIfAssumption` → `solveAndDiff`
 * threads the per-school P/F config into BOTH validator calls so an over-cap
 * election surfaces `passFailLimitsRespected.status === "fail"` (and
 * `feasible === false`).
 *
 * This is the test that proves B1 → C1 → C2 connect for the P/F feature — the
 * config-less `solveAndDiff` previously ran the axis PASS-BY-DEFAULT on the
 * election DPR, so an over-cap election went unflagged (feasible:true).
 *
 * Two cases:
 *   (over-cap)  passFailUsedUnits already near a 32-credit cap; a 4-credit
 *               PASS election pushes used over 32 → axis "fail" + feasible:false.
 *   (under-cap) the same election while comfortably under the cap → axis "pass"
 *               + feasible:true (control — proves the axis is not a blanket fail).
 *
 * Uses the REAL `solveWhatIfAssumption` signature + a session fixture mirroring
 * proposeWhatIfAssumption.test.ts.
 */

import { describe, it, expect } from "vitest";
import { solveWhatIfAssumption } from "../../src/agent/forwardSchedule/whatIfAssumption.js";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import type { ToolSession } from "../../src/agent/tool.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
} from "../../src/dpr/schema.js";
import type { Course, PassFailConfig } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures — a DPR with a CURRENT-TERM IP course satisfying a MAJOR leaf,
// parameterised by the cumulative P/F units already used.
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:SYNTHETIC-pf-cap-whatif-fixture",
        sourcePdfPageCount: 0,
        parseDurationMs: 0,
        warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
    };
}

const IP_COURSE_TERM = "2026 Fall";
/** Late October — past fall add/drop, inside the fall withdraw/PF window. */
const NOW_IN_WITHDRAW_WINDOW = new Date(Date.UTC(2026, 9, 25));

/** The 4-credit IP course the student claims to take pass/fail. */
const PF_COURSE = "CSCI-UA 102";
const PF_COURSE_UNITS = 4;

function makePfDpr(passFailUsedUnits: number): DegreeProgressReport {
    const dpr: DegreeProgressReport = {
        _meta: makeMeta(),
        reportKind: "dpr",
        header: { studentName: "Synthetic Student (fabricated)", preparedDate: "10/01/2026" },
        programs: [
            {
                programType: "Undergraduate Career",
                label: "UA-Coll of Arts & Sci",
                requirementTerm: "Fall 2024",
                requirementStatus: "not_satisfied",
            },
            {
                programType: "Major",
                label: "Computer Science",
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
            passFailUsedUnits,
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
                        statusText: "Satisfied: Intro completed (in progress).",
                        counter: { kind: "courses", required: 1, used: 1, needed: 0 },
                        coursesUsed: [
                            {
                                term: IP_COURSE_TERM,
                                subject: "CSCI-UA",
                                catalogNbr: "102",
                                courseTitle: "Data Structures",
                                grade: "IP",
                                units: PF_COURSE_UNITS,
                                type: "IP",
                            },
                        ],
                    },
                ],
            },
        ],
        courseHistory: [
            {
                term: IP_COURSE_TERM,
                subject: "CSCI-UA",
                catalogNbr: "102",
                courseTitle: "Data Structures",
                grade: "IP",
                units: PF_COURSE_UNITS,
                type: "IP",
            },
        ],
    };
    return degreeProgressReportSchema.parse(dpr);
}

function makeIpCourses(): Course[] {
    return [
        { id: PF_COURSE, title: "Data Structures", credits: PF_COURSE_UNITS, termsOffered: ["fall", "spring"] },
    ];
}

/**
 * A 32-credit career P/F cap. `pfEligibility=counts` (countsForMajor:true) so
 * the elected major course STAYS satisfied — the election therefore does NOT
 * re-open the major leaf, isolating the cap axis as the only thing that can
 * flip feasibility (so over-cap → fail is attributable to the 8th axis alone).
 */
const PASS_FAIL_32_CREDITS: PassFailConfig = {
    careerLimitType: "credits",
    careerLimitValue: 32,
    countsForMajor: true,
    canElect: true,
};

function pfStudentSession(passFailUsedUnits: number): ToolSession {
    const base: ToolSession = {
        student: {
            id: "test-student",
            catalogYear: "2024",
            // "stern" so pfEligibility(category="major") === "counts" (the
            // elected major course stays satisfied → leaf NOT re-opened).
            homeSchool: "stern",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
            visaStatus: "f1",
        },
        schoolConfig: {
            schoolId: "stern",
            name: "Stern School of Business",
            degreeType: "BS",
            courseSuffix: ["-UB"],
            totalCreditsRequired: 128,
            overallGpaMin: 2.0,
            acceptsTransferCredit: true,
            maxCreditsPerSemester: 18,
            f1FullTimeMinCredits: 12,
            residency: { minCredits: 64, note: null },
            passFail: PASS_FAIL_32_CREDITS,
        },
        degreeProgressReport: makePfDpr(passFailUsedUnits),
        courses: makeIpCourses(),
    };
    const forwardSchedule = buildForwardSchedule({
        session: base,
        dpr: base.degreeProgressReport!,
        graduationTermOverride: "2027-spring",
    });
    return { ...base, forwardSchedule };
}

// ---------------------------------------------------------------------------
// The integration assertions — the chain B1 → C1 → C2 engages.
// ---------------------------------------------------------------------------

/** The axis under test, named once. */
const PF_AXIS = "passFailLimitsRespected";

describe("solveWhatIfAssumption — 8th P/F axis engages in the election path (C2 fix)", () => {
    it("OVER-CAP: a PASS election that pushes used-units over the 32-credit cap → axis 'fail' + feasible:false", () => {
        // 30 used + a 4-credit PASS election → 34 > 32 cap.
        const session = pfStudentSession(30);
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: PF_COURSE,
            outcome: "pass",
            now: NOW_IN_WITHDRAW_WINDOW,
        });

        // The 8th axis FAILS on the AFTER (election) world → overall infeasible.
        // (Asserted directly on the recorded transition's `after` below.)
        expect(result.feasible).toBe(false);

        // The binding constraint surfaced is the P/F axis specifically (not some
        // other axis coincidentally failing the over-credit fixture).
        const pfConflict = (result.conflicts ?? []).some((c) => c.detail.includes(PF_AXIS));
        expect(pfConflict).toBe(true);

        // The AFTER axis status is "fail" (read from the recorded transition,
        // which exists because before:pass → after:fail).
        const change = result.planDiff?.validationResultsChanges?.[PF_AXIS];
        expect(change).toBeDefined();
        expect(change!.after.status).toBe("fail");
    });

    it("UNDER-CAP control: the same PASS election while comfortably under cap → feasible:true, no P/F conflict", () => {
        // 0 used + a 4-credit PASS election → 4 ≤ 32 cap.
        const session = pfStudentSession(0);
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: PF_COURSE,
            outcome: "pass",
            now: NOW_IN_WITHDRAW_WINDOW,
        });

        // Under cap → the 8th axis cannot flip feasibility. (Proves the axis is
        // not a blanket fail — it discriminates on the cap.)
        expect(result.feasible).toBe(true);
        const pfConflict = (result.conflicts ?? []).some((c) => c.detail.includes(PF_AXIS));
        expect(pfConflict).toBe(false);
        // No P/F axis transition (before:pass === after:pass → not recorded).
        expect(result.planDiff?.validationResultsChanges?.[PF_AXIS]).toBeUndefined();
    });

    it("BEFORE/AFTER honesty: a newly-crossing election shows a pass→fail axis transition (beforeAxes reads the ORIGINAL DPR)", () => {
        // 30 used (BEFORE: under cap, ORIGINAL DPR, no election) + a 4-credit
        // PASS election (AFTER: 34 > 32). The before world is validated against
        // the original DPR so its axis is "pass"; the after world fails → a
        // genuine NEW transition (proves beforeAxes is NOT reading the synthetic
        // election DPR — else before would already be "fail").
        const session = pfStudentSession(30);
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: PF_COURSE,
            outcome: "pass",
            now: NOW_IN_WITHDRAW_WINDOW,
        });

        const change = result.planDiff?.validationResultsChanges?.[PF_AXIS];
        expect(change).toBeDefined();
        expect(change!.before.status).toBe("pass");
        expect(change!.after.status).toBe("fail");
    });
});
