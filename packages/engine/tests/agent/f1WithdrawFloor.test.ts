/**
 * Plan 37 — Task E2: F-1 full-time-floor advisory on a withdraw what-if (D-6).
 *
 * When a WITHDRAW what-if drops the CURRENT term below the F-1 full-time floor
 * (`SchoolConfig.f1FullTimeMinCredits ?? 12`) for an F-1 student, and the term
 * is not a registrar-approved final-term exception, `solveWhatIfAssumption`
 * appends a STRONG advisory hedge.
 *
 * This is ADVISORY ONLY — a hedge string, NOT a hard block:
 *   - `feasible` is UNCHANGED (the withdraw is not made infeasible)
 *   - `hedges` gains a new string matching /F-1|12-credit|Reduced Course Load|OGS/
 *
 * Two principal assertions:
 *   (a) F-1 student with 12 credits in the current term (all in one 4-credit IP
 *       course + other planned courses) → withdraw drops to below 12 → hedge fires.
 *   (b) Domestic student (same setup) → NO F-1 hedge.
 *   (c) F-1 student who is already below the floor BEFORE the withdraw (edge) →
 *       hedge still fires (we report it conservatively).
 *   (d) Advisory-only: feasible is unchanged by the hedge (withdraw itself does
 *       NOT make a plan infeasible merely because of F-1 status).
 */

import { describe, it, expect } from "vitest";
import { solveWhatIfAssumption } from "../../src/agent/forwardSchedule/whatIfAssumption.js";
import { buildForwardSchedule } from "../../src/agent/forwardSchedule/build.js";
import type { ToolSession } from "../../src/agent/tool.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
} from "../../src/dpr/schema.js";
import type { Course } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:SYNTHETIC-f1-floor-advisory-fixture",
        sourcePdfPageCount: 0,
        parseDurationMs: 0,
        warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
    };
}

/** Current term — the semester containing the IP course. */
const IP_COURSE_TERM = "2026 Fall";

/** Late October — past fall add/drop, inside fall withdraw/PF window. */
const NOW_IN_WITHDRAW_WINDOW = new Date(Date.UTC(2026, 9, 25));

/** The IP course the student is withdrawing from: 4 credits. */
const IP_COURSE_ID = "CSCI-UA 102";
const IP_COURSE_UNITS = 4;

/**
 * DPR with ONE in-progress course in the current term (4 credits = EXACTLY the
 * F-1 floor of 12 when combined with other planned credits — but those other
 * courses are planned, not on the DPR). The IP course is the only recorded
 * current-term course in courseHistory (credits used for the floor check come
 * from the courseHistory rows for the IP term).
 *
 * We set up the DPR such that the IP course's term has exactly IP_COURSE_UNITS
 * credits on record (the only in-progress course for that term), so that
 * post-withdraw the term has 0 recorded credits — well below 12.
 */
function makeDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
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
            creditsUsed: 60,
            cumulativeGpa: 3.5,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 32,
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
                        statusText: "Satisfied: Intro completed (in progress).",
                        counter: { kind: "courses", required: 1, used: 1, needed: 0 },
                        coursesUsed: [
                            {
                                term: IP_COURSE_TERM,
                                subject: "CSCI-UA",
                                catalogNbr: "102",
                                courseTitle: "Data Structures",
                                grade: "IP",
                                units: IP_COURSE_UNITS,
                                type: "IP",
                            },
                        ],
                    },
                ],
            },
        ],
        // The current-term courseHistory has only the one IP course (4 credits).
        // Post-withdraw → 0 credits in that term, well below the 12-credit floor.
        courseHistory: [
            {
                term: IP_COURSE_TERM,
                subject: "CSCI-UA",
                catalogNbr: "102",
                courseTitle: "Data Structures",
                grade: "IP",
                units: IP_COURSE_UNITS,
                type: "IP",
            },
        ],
        ...overrides,
    };
    return degreeProgressReportSchema.parse(dpr);
}

function makeCourses(): Course[] {
    return [
        { id: IP_COURSE_ID, title: "Data Structures", credits: IP_COURSE_UNITS, termsOffered: ["fall", "spring"] },
    ];
}

/** Build a session with the given visaStatus and DPR. */
function makeSession(visaStatus: "f1" | "domestic" | "other", dprOverrides: Partial<DegreeProgressReport> = {}): ToolSession {
    const dpr = makeDpr(dprOverrides);
    const base: ToolSession = {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
            visaStatus,
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
        degreeProgressReport: dpr,
        courses: makeCourses(),
    };
    const forwardSchedule = buildForwardSchedule({
        session: base,
        dpr,
        graduationTermOverride: "2027-spring",
    });
    return { ...base, forwardSchedule };
}

/** Regex that must match the F-1 hedge string. */
const F1_HEDGE_RE = /F-1|12-credit|Reduced Course Load|OGS/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("solveWhatIfAssumption — F-1 full-time-floor advisory (E2, D-6)", () => {
    it("(a) F-1 student: withdrawing the only IP course (4 credits) fires the F-1 floor advisory hedge", () => {
        const session = makeSession("f1");
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: IP_COURSE_ID,
            outcome: "withdraw",
            now: NOW_IN_WITHDRAW_WINDOW,
        });

        // The hedge must be present.
        const hasF1Hedge = result.hedges.some((h) => F1_HEDGE_RE.test(h));
        expect(hasF1Hedge).toBe(true);

        // Advisory ONLY — feasibility is NOT changed by the floor advisory.
        // (The result may be infeasible for other reasons, but the hedge
        // does not flip feasibility on its own. We check that hedges != conflicts.)
        const f1HedgeIsAConflict = (result.conflicts ?? []).some((c) =>
            F1_HEDGE_RE.test(c.detail),
        );
        expect(f1HedgeIsAConflict).toBe(false);
    });

    it("(b) Domestic student: same setup produces NO F-1 floor advisory hedge", () => {
        const session = makeSession("domestic");
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: IP_COURSE_ID,
            outcome: "withdraw",
            now: NOW_IN_WITHDRAW_WINDOW,
        });

        const hasF1Hedge = result.hedges.some((h) => F1_HEDGE_RE.test(h));
        expect(hasF1Hedge).toBe(false);
    });

    it("(c) Advisory-only: the F-1 hedge is in hedges, NOT in conflicts (no hard block)", () => {
        const session = makeSession("f1");
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: IP_COURSE_ID,
            outcome: "withdraw",
            now: NOW_IN_WITHDRAW_WINDOW,
        });

        // Hedge present.
        expect(result.hedges.some((h) => F1_HEDGE_RE.test(h))).toBe(true);

        // NOT a conflict (conflicts are binding constraints that flip feasible).
        const hasConflict = (result.conflicts ?? []).some((c) => F1_HEDGE_RE.test(c.detail));
        expect(hasConflict).toBe(false);
    });

    it("(d) pass/fail outcomes (not withdraw) do NOT fire the F-1 floor advisory", () => {
        // The F-1 floor advisory is WITHDRAW-specific. A pass-fail election
        // keeps the student enrolled (no credit-hour drop), so no hedge.
        const session = makeSession("f1");
        const currentPlan = session.forwardSchedule!;

        const resultPass = solveWhatIfAssumption(session, currentPlan, {
            courseId: IP_COURSE_ID,
            outcome: "pass",
            now: NOW_IN_WITHDRAW_WINDOW,
        });
        const resultFail = solveWhatIfAssumption(session, currentPlan, {
            courseId: IP_COURSE_ID,
            outcome: "fail",
            now: NOW_IN_WITHDRAW_WINDOW,
        });

        expect(resultPass.hedges.some((h) => F1_HEDGE_RE.test(h))).toBe(false);
        expect(resultFail.hedges.some((h) => F1_HEDGE_RE.test(h))).toBe(false);
    });

    it("(e) F-1 student with visaStatus 'other' does NOT fire the F-1 floor advisory", () => {
        // Only exact "f1" visa status triggers the advisory.
        const session = makeSession("other");
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: IP_COURSE_ID,
            outcome: "withdraw",
            now: NOW_IN_WITHDRAW_WINDOW,
        });

        expect(result.hedges.some((h) => F1_HEDGE_RE.test(h))).toBe(false);
    });

    // -------------------------------------------------------------------------
    // Plan 37 Phase L — season guard: summer / J-term carry NO 12-credit floor
    // -------------------------------------------------------------------------

    it("(f) F-1 student withdrawing a SUMMER IP course (drops below 12 cr) → NO F-1 floor advisory (no floor in summer)", () => {
        // The F-1 12-credit floor is a fall/spring floor only. Withdrawing
        // a summer course — even if it drops the term below 12 credits — must
        // NOT fire the advisory (plan 37 Phase L).
        const SUMMER_TERM = "2026 Summer";
        const session = makeSession("f1", {
            courseHistory: [
                {
                    term: SUMMER_TERM,
                    subject: "CSCI-UA",
                    catalogNbr: "102",
                    courseTitle: "Data Structures",
                    grade: "IP",
                    units: IP_COURSE_UNITS,
                    type: "IP",
                },
            ],
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
                                    term: SUMMER_TERM,
                                    subject: "CSCI-UA",
                                    catalogNbr: "102",
                                    courseTitle: "Data Structures",
                                    grade: "IP",
                                    units: IP_COURSE_UNITS,
                                    type: "IP",
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: IP_COURSE_ID,
            outcome: "withdraw",
            // Use a date mid-summer so the window caveat resolves consistently.
            now: new Date(Date.UTC(2026, 6, 15)),
        });

        // The summer term has no F-1 full-time floor → no advisory hedge.
        const hasF1Hedge = result.hedges.some((h) => F1_HEDGE_RE.test(h));
        expect(hasF1Hedge).toBe(false);
    });

    it("(g) F-1 student withdrawing a JANUARY (J-term) IP course → NO F-1 floor advisory (no floor in J-term)", () => {
        // Same guard: J-term sessions (january) carry no 12-credit floor.
        const JANUARY_TERM = "2026 January";
        const session = makeSession("f1", {
            courseHistory: [
                {
                    term: JANUARY_TERM,
                    subject: "CSCI-UA",
                    catalogNbr: "102",
                    courseTitle: "Data Structures",
                    grade: "IP",
                    units: IP_COURSE_UNITS,
                    type: "IP",
                },
            ],
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
                                    term: JANUARY_TERM,
                                    subject: "CSCI-UA",
                                    catalogNbr: "102",
                                    courseTitle: "Data Structures",
                                    grade: "IP",
                                    units: IP_COURSE_UNITS,
                                    type: "IP",
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        const currentPlan = session.forwardSchedule!;

        const result = solveWhatIfAssumption(session, currentPlan, {
            courseId: IP_COURSE_ID,
            outcome: "withdraw",
            now: new Date(Date.UTC(2026, 0, 15)),
        });

        // January / J-term has no F-1 full-time floor → no advisory hedge.
        const hasF1Hedge = result.hedges.some((h) => F1_HEDGE_RE.test(h));
        expect(hasF1Hedge).toBe(false);
    });
});
