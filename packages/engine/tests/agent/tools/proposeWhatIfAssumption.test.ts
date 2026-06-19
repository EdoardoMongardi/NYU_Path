/**
 * G3.1 — propose_whatif_assumption tool (read-only).
 *
 * RED-before-GREEN test for the NEW read-only what-if ASSUMPTION proposer.
 *
 * The student claims "I withdrew / I'll take pass-fail for course X" (a
 * current-term IP course). We treat it as an ASSUMPTION, build the synthetic
 * DPR (applyWithdrawalToDpr / applyPassFailToDpr), re-solve through the SAME
 * frozen pipeline the build path uses, and return the proposed (un-persisted)
 * plan + a `whatIfAssumption` marker (courseId + outcome + hedges + label) so
 * the web review card can label it. STRICTLY READ-ONLY at propose time.
 *
 * Unlike `probe_counterfactual` (a pure introspection probe), this tool is the
 * PROPOSE half of a propose→confirm round-trip — the confirm half (the
 * orchestrator) re-applies the transform + persists ONLY the resulting
 * forward_schedule (never parsed_dpr). This file tests the propose tool's
 * output shape + read-only invariant; the confirm/persist wiring is tested at
 * the web orchestrator layer.
 *
 * Assertions:
 *   (contract) name + isReadOnly:true + registered in buildDefaultRegistry().
 *   (a) withdraw → reopens the major leaf (diff/cascade/new-unmet/re-place) +
 *       carries the verify rail + a `whatIfAssumption` marker {courseId, outcome}.
 *   (b) pass (CAS major) → reopens the major leaf (P only earns elective credit).
 *   (c) pass (Stern major, pfEligibility=counts) → KEEPS satisfied, not re-placed.
 *   (d) fail → reopens + a GPA hedge.
 *   (e) read-only: session.forwardSchedule / DPR byte-identical after the call.
 */

import { describe, it, expect } from "vitest";
import { proposeWhatIfAssumptionTool } from "../../../src/agent/tools/proposeWhatIfAssumption.js";
import { buildDefaultRegistry } from "../../../src/agent/registry.js";
import { buildForwardSchedule } from "../../../src/agent/forwardSchedule/build.js";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
} from "../../../src/dpr/schema.js";
import type { Course } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures — a DPR with a CURRENT-TERM IP course satisfying a MAJOR leaf.
// ---------------------------------------------------------------------------

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:SYNTHETIC-whatif-propose-fixture",
        sourcePdfPageCount: 0,
        parseDurationMs: 0,
        warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
    };
}

const IP_COURSE_TERM = "2026 Fall";
/** Late October — past fall add/drop, inside fall withdraw/PF window. */
const NOW_IN_WITHDRAW_WINDOW = new Date(Date.UTC(2026, 9, 25));

function makeIpMajorDpr(overrides: Partial<DegreeProgressReport> = {}): DegreeProgressReport {
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
                                units: 4,
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
                units: 4,
                type: "IP",
            },
        ],
        ...overrides,
    };
    return degreeProgressReportSchema.parse(dpr);
}

function makeIpCourses(): Course[] {
    return [
        { id: "CSCI-UA 102", title: "Data Structures", credits: 4, termsOffered: ["fall", "spring"] },
    ];
}

function casStudentSession(overrides: Partial<ToolSession> = {}): ToolSession {
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
        degreeProgressReport: makeIpMajorDpr(),
        courses: makeIpCourses(),
        ...overrides,
    };
}

function makeIpSession(overrides: Partial<ToolSession> = {}): ToolSession {
    const base = casStudentSession(overrides);
    const forwardSchedule = buildForwardSchedule({
        session: base,
        dpr: base.degreeProgressReport!,
        graduationTermOverride: "2027-spring",
    });
    return { ...base, forwardSchedule };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

const VERIFY_RAIL_RE = /unverified assumption|verify with your adviser|not.*official.*until.*DPR/i;

function carriesVerifyRail(output: {
    consequences: string[];
    whatIfAssumption?: { hedges?: string[] };
    windowCaveat?: string;
}): boolean {
    const lines = [
        ...output.consequences,
        ...(output.whatIfAssumption?.hedges ?? []),
        ...(output.windowCaveat ? [output.windowCaveat] : []),
    ];
    return lines.some((l) => VERIFY_RAIL_RE.test(l));
}

function reopened(output: { schedule?: { semesters: Array<{ slots: Array<{ kind: string; courseId?: string }> }> }; diff: { added: unknown[]; removed: unknown[] }; planDiff?: { newUnmetRequirements?: unknown[]; cascadedShifts?: unknown[] } }): boolean {
    const rePlaced =
        output.schedule?.semesters.some((sem) =>
            sem.slots.some((s) => s.kind === "specific_planned" && s.courseId === "CSCI-UA 102"),
        ) ?? false;
    const diffNonEmpty = output.diff.added.length > 0 || output.diff.removed.length > 0;
    const newUnmet = (output.planDiff?.newUnmetRequirements?.length ?? 0) > 0;
    const cascaded = (output.planDiff?.cascadedShifts?.length ?? 0) > 0;
    return rePlaced || diffNonEmpty || newUnmet || cascaded;
}

// ---------------------------------------------------------------------------
// Tool contract
// ---------------------------------------------------------------------------

describe("propose_whatif_assumption — tool contract", () => {
    it("has name 'propose_whatif_assumption'", () => {
        expect(proposeWhatIfAssumptionTool.name).toBe("propose_whatif_assumption");
    });

    it("is isReadOnly: true (stages only; nothing persisted at propose time)", () => {
        expect(proposeWhatIfAssumptionTool.isReadOnly).toBe(true);
    });

    it("is registered in buildDefaultRegistry()", () => {
        const reg = buildDefaultRegistry();
        const names = reg.list().map((t) => t.name);
        expect(names).toContain("propose_whatif_assumption");
    });
});

// ---------------------------------------------------------------------------
// (a) withdraw
// ---------------------------------------------------------------------------

describe("propose_whatif_assumption — withdraw", () => {
    it("returns a whatIfAssumption marker {courseId, outcome:withdraw}, reopens the leaf, carries the verify rail", async () => {
        const session = makeIpSession();
        const ctx = makeCtx(session);

        const output = await proposeWhatIfAssumptionTool.call(
            { courseId: "CSCI-UA 102", outcome: "withdraw", now: NOW_IN_WITHDRAW_WINDOW.toISOString() } as never,
            ctx,
        );

        // The marker the web review card / canvas badge reads.
        expect(output.whatIfAssumption).toBeDefined();
        expect(output.whatIfAssumption!.courseId).toBe("CSCI-UA 102");
        expect(output.whatIfAssumption!.outcome).toBe("withdraw");
        // A human-readable label exists ("assumes you withdraw CSCI-UA 102").
        expect(typeof output.whatIfAssumption!.label).toBe("string");
        expect(output.whatIfAssumption!.label.length).toBeGreaterThan(0);
        expect(output.whatIfAssumption!.label).toMatch(/withdraw/i);

        // The proposed (un-persisted) plan is present.
        expect(output.proposedSchedule).toBeDefined();

        // The major leaf re-opens.
        expect(reopened({ ...output, schedule: output.proposedSchedule })).toBe(true);

        // The universal verify rail is present.
        expect(carriesVerifyRail(output)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// (b) pass (CAS major) → reopens
// ---------------------------------------------------------------------------

describe("propose_whatif_assumption — pass (CAS major)", () => {
    it("pass on a CAS major course re-opens the requirement (P only earns elective credit)", async () => {
        const session = makeIpSession();
        const ctx = makeCtx(session);

        const output = await proposeWhatIfAssumptionTool.call(
            { courseId: "CSCI-UA 102", outcome: "pass", now: NOW_IN_WITHDRAW_WINDOW.toISOString() } as never,
            ctx,
        );

        expect(output.whatIfAssumption!.outcome).toBe("pass");
        expect(reopened({ ...output, schedule: output.proposedSchedule })).toBe(true);
        expect(carriesVerifyRail(output)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// (c) pass (Stern major, counts) → KEEPS satisfied
// ---------------------------------------------------------------------------

describe("propose_whatif_assumption — pass (Stern major, pfEligibility=counts)", () => {
    it("KEEPS the major leaf satisfied → CSCI-UA 102 NOT re-placed", async () => {
        const session = makeIpSession({
            student: {
                id: "test-student",
                catalogYear: "2024",
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
            },
        });
        const ctx = makeCtx(session);

        const output = await proposeWhatIfAssumptionTool.call(
            { courseId: "CSCI-UA 102", outcome: "pass", now: NOW_IN_WITHDRAW_WINDOW.toISOString() } as never,
            ctx,
        );

        const rePlaced = output.proposedSchedule!.semesters.some((sem) =>
            sem.slots.some((s) => s.kind === "specific_planned" && s.courseId === "CSCI-UA 102"),
        );
        expect(rePlaced).toBe(false);
        expect(output.planDiff?.newUnmetRequirements ?? []).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// (d) fail → reopens + GPA hedge
// ---------------------------------------------------------------------------

describe("propose_whatif_assumption — fail", () => {
    it("fail re-opens the requirement and carries a GPA hedge", async () => {
        const session = makeIpSession();
        const ctx = makeCtx(session);

        const output = await proposeWhatIfAssumptionTool.call(
            { courseId: "CSCI-UA 102", outcome: "fail", now: NOW_IN_WITHDRAW_WINDOW.toISOString() } as never,
            ctx,
        );

        expect(output.whatIfAssumption!.outcome).toBe("fail");
        expect(reopened({ ...output, schedule: output.proposedSchedule })).toBe(true);
        const hedges = output.whatIfAssumption?.hedges ?? [];
        expect(hedges.some((h) => /GPA/i.test(h))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// (e) read-only invariant
// ---------------------------------------------------------------------------

describe("propose_whatif_assumption — READ-ONLY", () => {
    it("withdraw leaves session.forwardSchedule / DPR byte-identical (stages only)", async () => {
        const session = makeIpSession();
        const ctx = makeCtx(session);

        const beforeFs = JSON.parse(JSON.stringify(session.forwardSchedule));
        const beforeDpr = JSON.parse(JSON.stringify(session.degreeProgressReport));

        await proposeWhatIfAssumptionTool.call(
            { courseId: "CSCI-UA 102", outcome: "withdraw", now: NOW_IN_WITHDRAW_WINDOW.toISOString() } as never,
            ctx,
        );

        expect(JSON.parse(JSON.stringify(session.forwardSchedule))).toEqual(beforeFs);
        expect(JSON.parse(JSON.stringify(session.degreeProgressReport))).toEqual(beforeDpr);
    });
});

// ---------------------------------------------------------------------------
// (f) D-7 IP-membership guard (E1) — validateInput rejects non-IP targets
// ---------------------------------------------------------------------------

/**
 * A DPR where CSCI-UA 101 is COMPLETED (type:"EN", graded) — not in-progress.
 * The student would try to withdraw/pass-fail it, which the guard must reject.
 */
function makeCompletedDpr(): DegreeProgressReport {
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
        requirementGroups: [],
        // CSCI-UA 101 is COMPLETED (type "EN", graded "A") — not in-progress.
        courseHistory: [
            {
                term: "2025 Fall",
                subject: "CSCI-UA",
                catalogNbr: "101",
                courseTitle: "Intro to CS",
                grade: "A",
                units: 4,
                type: "EN",
            },
        ],
    };
    return degreeProgressReportSchema.parse(dpr);
}

/**
 * A DPR with no mention of CSCI-UA 999 at all — the course is planned (or
 * just unknown) but NOT on the DPR.  The guard must distinguish "not on DPR
 * at all" from "on DPR but completed".
 */
function makeNoCourseOnDprDpr(): DegreeProgressReport {
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
        requirementGroups: [],
        courseHistory: [], // empty — CSCI-UA 999 is simply not on the DPR
    };
    return degreeProgressReportSchema.parse(dpr);
}

/** Session whose DPR has CSCI-UA 101 as COMPLETED (graded "A", type "EN"). */
function makeCompletedSession(): ToolSession {
    const base = casStudentSession({
        degreeProgressReport: makeCompletedDpr(),
    });
    const forwardSchedule = buildForwardSchedule({
        session: base,
        dpr: base.degreeProgressReport!,
        graduationTermOverride: "2027-spring",
    });
    return { ...base, forwardSchedule };
}

/** Session whose DPR does NOT contain CSCI-UA 999 at all (planned course). */
function makePlannedSession(): ToolSession {
    const base = casStudentSession({
        degreeProgressReport: makeNoCourseOnDprDpr(),
    });
    const forwardSchedule = buildForwardSchedule({
        session: base,
        dpr: base.degreeProgressReport!,
        graduationTermOverride: "2027-spring",
    });
    return { ...base, forwardSchedule };
}

// ---------------------------------------------------------------------------
// (g) D-4 P/F-eligibility guard — canElect:false school must reject pass/fail
//     but allow withdraw (W is universal)
// ---------------------------------------------------------------------------

/** A schoolConfig where passFail.canElect is explicitly false (Tandon-style). */
function tandonSchoolConfig() {
    return {
        schoolId: "tandon",
        name: "NYU Tandon School of Engineering",
        degreeType: "BS" as const,
        courseSuffix: ["-UE"],
        totalCreditsRequired: 128,
        overallGpaMin: 2.0,
        acceptsTransferCredit: true,
        maxCreditsPerSemester: 18,
        f1FullTimeMinCredits: 12,
        residency: { minCredits: 64, note: null },
        passFail: {
            careerLimitType: "credits" as const,
            canElect: false,
        },
    };
}

/** Session for a Tandon student with an IP course (CSCI-UA 102). */
function makeTandonIpSession(): ToolSession {
    const base: ToolSession = {
        student: {
            id: "test-student",
            catalogYear: "2024",
            homeSchool: "tandon",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
            visaStatus: "f1",
        },
        schoolConfig: tandonSchoolConfig(),
        degreeProgressReport: makeIpMajorDpr(),
        courses: makeIpCourses(),
    };
    const forwardSchedule = buildForwardSchedule({
        session: base,
        dpr: base.degreeProgressReport!,
        graduationTermOverride: "2027-spring",
    });
    return { ...base, forwardSchedule };
}

describe("propose_whatif_assumption — D-4 P/F-eligibility guard (canElect:false)", () => {
    it("(a) outcome:'pass' at canElect:false school → validateInput returns { ok:false } with message matching /pass\\/fail|elect/i", async () => {
        const session = makeTandonIpSession();
        const ctx = makeCtx(session);

        const result = await proposeWhatIfAssumptionTool.validateInput!(
            { courseId: "CSCI-UA 102", outcome: "pass" } as never,
            ctx,
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/pass\/?fail|elect/i);
    });

    it("(b) outcome:'fail' at canElect:false school → validateInput returns { ok:false } with message matching /pass\\/fail|elect/i", async () => {
        const session = makeTandonIpSession();
        const ctx = makeCtx(session);

        const result = await proposeWhatIfAssumptionTool.validateInput!(
            { courseId: "CSCI-UA 102", outcome: "fail" } as never,
            ctx,
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/pass\/?fail|elect/i);
    });

    it("(c) outcome:'pass' at canElect:true (CAS) school → validateInput returns { ok:true }", async () => {
        // CAS schoolConfig has no passFail block → canElect treated as true (can elect)
        const session = makeIpSession();
        const ctx = makeCtx(session);

        const result = await proposeWhatIfAssumptionTool.validateInput!(
            { courseId: "CSCI-UA 102", outcome: "pass" } as never,
            ctx,
        );

        expect(result.ok).toBe(true);
    });

    it("(d) outcome:'withdraw' at canElect:false school → validateInput returns { ok:true } (W is universal, not gated)", async () => {
        const session = makeTandonIpSession();
        const ctx = makeCtx(session);

        const result = await proposeWhatIfAssumptionTool.validateInput!(
            { courseId: "CSCI-UA 102", outcome: "withdraw" } as never,
            ctx,
        );

        expect(result.ok).toBe(true);
    });
});

describe("propose_whatif_assumption — D-7 IP-membership guard (E1)", () => {
    it("(a) COMPLETED course → validateInput returns { ok:false } with message about in-progress / completed", async () => {
        // CSCI-UA 101 is completed (type:"EN", grade:"A") — withdraw/PF do not apply
        const session = makeCompletedSession();
        const ctx = makeCtx(session);

        const result = await proposeWhatIfAssumptionTool.validateInput!(
            { courseId: "CSCI-UA 101", outcome: "withdraw" } as never,
            ctx,
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/in progress|currently taking|completed/i);
    });

    it("(b) IN-PROGRESS course → validateInput returns { ok:true }", async () => {
        // CSCI-UA 102 is in the DPR with type:"IP" — the guard should pass
        const session = makeIpSession();
        const ctx = makeCtx(session);

        const result = await proposeWhatIfAssumptionTool.validateInput!(
            { courseId: "CSCI-UA 102", outcome: "withdraw" } as never,
            ctx,
        );

        expect(result.ok).toBe(true);
    });

    it("(c) NOT-ON-DPR course (planned/unknown) → validateInput returns { ok:false } with message about planned / drop it instead", async () => {
        // CSCI-UA 999 is not on the DPR at all — student likely means a planned course
        const session = makePlannedSession();
        const ctx = makeCtx(session);

        const result = await proposeWhatIfAssumptionTool.validateInput!(
            { courseId: "CSCI-UA 999", outcome: "withdraw" } as never,
            ctx,
        );

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.userMessage).toMatch(/planned|drop it instead/i);
    });
});
