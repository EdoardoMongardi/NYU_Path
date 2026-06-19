// ============================================================
// G3.1 — propose_whatif_assumption → confirm (orchestrator) tests
// ============================================================
// The student claims "I withdrew / I'll take pass-fail for course X" (a
// current-term IP course). The orchestrator treats it as an ASSUMPTION:
//   - PROPOSE (`runProposeWhatIfStage`) builds the synthetic DPR
//     (applyWithdrawalToDpr / applyPassFailToDpr), re-solves READ-ONLY,
//     stages the assumption ({courseId, outcome}) via the SAME
//     pendingMutationStore the plan-mutation propose path uses, and
//     returns a `whatIfAssumption` marker + the proposed (un-persisted) plan.
//   - CONFIRM (`runConfirmStage`) detects the staged assumption, RE-APPLIES
//     the transform to the loaded session DPR, re-solves through the SAME
//     frozen pipeline, and persists ONLY the resulting forward_schedule
//     (reuse persistSchedule). It NEVER writes the synthetic DPR to
//     students.parsed_dpr (the R1 guardrail).
//
// THE R1 GUARD TEST (launch gate): confirming a what-if assumption persists
// a forward_schedule AND leaves the in-memory profile store's parsed_dpr
// BYTE-IDENTICAL before/after. A what-if confirm must never throw the
// assertAuthoritativeDpr guard (because it persists the SCHEDULE, not the
// synthetic DPR).
//
// Offline only — uses the in-memory store bundle (no DATABASE_URL).
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    runProposeWhatIfStage,
    runConfirmStage,
    _resetPendingMutationsForTests,
} from "../lib/planActionOrchestrator";
import { resetStoresForTests, getStores } from "../lib/db/store";
import {
    InMemoryProfileStore,
    InMemoryScheduleStore,
    type DegreeProgressReport,
} from "@nyupath/engine";
import type { ForwardSchedule, StudentProfile } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures — a DPR with a CURRENT-TERM IP course satisfying a MAJOR leaf, so
// the assumption produces a real re-plan. The student is CAS (P/F → elective
// only → the major leaf re-opens; withdraw always re-opens).
// ---------------------------------------------------------------------------

const STUDENT_ID = "whatif-assumption-fixture";
const IP_COURSE_TERM = "2026 Fall";
/** Late October — past fall add/drop, inside the fall withdraw/PF window. */
const NOW_IN_WITHDRAW_WINDOW = new Date(Date.UTC(2026, 9, 25));

function makeMeta() {
    return {
        parserVersion: "1.0.0",
        parsedAt: "2026-01-01T00:00:00Z",
        sourceFingerprint: "sha256:whatif-orch-test",
        sourcePdfPageCount: 1,
        parseDurationMs: 0,
        warnings: [],
    };
}

function makeIpMajorDpr(): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        reportKind: "dpr",
        header: { studentName: "WhatIf Fixture", preparedDate: "10/01/2026" },
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
            // 124 used + the single 4-credit Intro leaf = 128 → re-placing the
            // re-opened CSCI-UA 102 alone completes the degree, so a withdraw/
            // pass re-solve is FEASIBLE (the R1 persist tests + the C1 feasible
            // regression guard exercise the real persist path).
            creditsUsed: 124,
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
    };
}

function makeProfile(studentId: string): StudentProfile {
    return {
        id: studentId,
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "computer_science", programType: "major" }],
        coursesTaken: [],
        genericTransferCredits: 0,
        flags: [],
        visaStatus: "domestic",
    };
}

/** A real-ish prior valid forward schedule so the confirm has a baseline plan
 *  to diff/supersede. The slots are inert; the load-bearing fields are state
 *  (valid-clean) + a single placed slot. */
function makeSeedSchedule(studentId: string): ForwardSchedule {
    return {
        studentId,
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "seed-hash",
        computedAt: 1_700_000_000_000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

async function seedStudent(): Promise<void> {
    const stores = getStores({});
    const profileStore = stores.profileStore as InMemoryProfileStore;
    const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
    await profileStore.persistMutation(
        makeProfile(STUDENT_ID),
        { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
        makeIpMajorDpr(),
    );
    await scheduleStore.persistSchedule(STUDENT_ID, makeSeedSchedule(STUDENT_ID), "fp-seed");
}

// ---------------------------------------------------------------------------
// M1 C1 (plan 37) — an INFEASIBLE what-if assumption fixture.
//
// Built on `makeIpMajorDpr`: the current-term IP course CSCI-UA 102 is the sole
// satisfier of a NAMED major requirement leaf (SR/10). A W / P/F-FAIL — and a
// P/F-PASS too — RE-OPENS that leaf (the transform strips the course from
// coursesUsed + flips the leaf to not_satisfied). The solver re-places the
// course, but the re-placed slot is not re-credited to SR/10, so the authoritative
// Axis 1 (`requirementGroupsSatisfied`) reports SR/10 unsatisfied →
// `solveWhatIfAssumption` returns feasible:false. (We ALSO seed the student at
// the 32-unit CAS pass-fail cap so a P/F-PASS election is doubly infeasible — a
// 4-credit election pushes used→36 > 32, tripping Axis 8 — but the binding
// constraint for this fixture is the re-opened requirement.)
//
// This is exactly the C1 attack: a realistic infeasible re-solve whose confirm
// must be REFUSED, not committed over the prior valid plan.
// ---------------------------------------------------------------------------

const INFEAS_STUDENT_ID = "whatif-infeasible-fixture";

function makeAtCapPassFailDpr(): DegreeProgressReport {
    const base = makeIpMajorDpr();
    return {
        ...base,
        cumulative: {
            ...base.cumulative,
            // Already at the 32-unit CAS pass-fail cap (a secondary infeasibility
            // for a P/F-PASS election; the binding one is the re-opened SR/10).
            passFailUsedUnits: 32,
            passFailCapUnits: 32,
        },
    };
}

async function seedInfeasibleWhatIfStudent(): Promise<void> {
    const stores = getStores({});
    const profileStore = stores.profileStore as InMemoryProfileStore;
    const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
    await profileStore.persistMutation(
        makeProfile(INFEAS_STUDENT_ID),
        { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
        makeAtCapPassFailDpr(),
    );
    // A VALID committed schedule that the infeasible confirm must NOT supersede.
    await scheduleStore.persistSchedule(INFEAS_STUDENT_ID, makeSeedSchedule(INFEAS_STUDENT_ID), "fp-valid");
}

// ---------------------------------------------------------------------------
// A FEASIBLE what-if fixture — the IP course is a FREE ELECTIVE (in
// courseHistory only, NOT tied to any named requirement leaf) and the degree is
// already credit-complete. Withdrawing / P/F-ing it re-opens NO named leaf, so
// the re-solve stays VALID (feasible:true). Used by the R1 persist tests + the
// C1 feasible-confirm regression guard (which need a real persist to occur).
// ---------------------------------------------------------------------------

const FEAS_COURSE = "ELEC-UA 200";
const FEAS_STUDENT_ID = "whatif-feasible-fixture";

function makeFeasibleWhatIfDpr(): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        reportKind: "dpr",
        header: { studentName: "WhatIf Feasible", preparedDate: "10/01/2026" },
        programs: [
            {
                programType: "Undergraduate Career",
                label: "UA-Coll of Arts & Sci",
                requirementTerm: "Fall 2024",
                requirementStatus: "satisfied",
            },
        ],
        advisorNotations: [],
        cumulative: {
            // Degree credit floor already met; the free elective is surplus, so
            // dropping it via W / P/F re-opens no requirement and the re-solve
            // stays valid (feasible:true).
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
        // No unsatisfied requirement leaves — nothing to re-open.
        requirementGroups: [],
        courseHistory: [
            {
                term: IP_COURSE_TERM,
                subject: "ELEC-UA",
                catalogNbr: "200",
                courseTitle: "Free Elective",
                grade: "IP",
                units: 4,
                type: "IP",
            },
        ],
    };
}

async function seedFeasibleWhatIfStudent(): Promise<void> {
    const stores = getStores({});
    const profileStore = stores.profileStore as InMemoryProfileStore;
    const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
    await profileStore.persistMutation(
        makeProfile(FEAS_STUDENT_ID),
        { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
        makeFeasibleWhatIfDpr(),
    );
    await scheduleStore.persistSchedule(FEAS_STUDENT_ID, makeSeedSchedule(FEAS_STUDENT_ID), "fp-seed");
}

beforeEach(async () => {
    resetStoresForTests();
    _resetPendingMutationsForTests();
    await seedStudent();
});

afterEach(() => {
    resetStoresForTests();
});

// ---------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------

describe("runProposeWhatIfStage — stages an assumption + returns a marker", () => {
    it("returns a whatIfAssumption marker + the proposed (un-persisted) plan + a pendingMutationId", async () => {
        const result = await runProposeWhatIfStage(
            STUDENT_ID,
            { courseId: "CSCI-UA 102", outcome: "withdraw" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const resp = result.response;
        expect(resp.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(resp.whatIfAssumption).toBeDefined();
        expect(resp.whatIfAssumption!.courseId).toBe("CSCI-UA 102");
        expect(resp.whatIfAssumption!.outcome).toBe("withdraw");
        expect(typeof resp.whatIfAssumption!.label).toBe("string");
        // The proposed schedule is present (un-persisted preview).
        expect(resp.forwardSchedule).toBeDefined();

        // PROPOSE persisted NOTHING: the stored live schedule is still the seed.
        const scheduleStore = getStores({}).scheduleStore as InMemoryScheduleStore;
        const live = await scheduleStore.loadLatestSchedule(STUDENT_ID);
        expect(live?.schedule.dprCourseHistoryHash).toBe("seed-hash");
    });
});

// ---------------------------------------------------------------------------
// Confirm — persists forward_schedule, parsed_dpr BYTE-UNCHANGED (R1 guard)
// ---------------------------------------------------------------------------

describe("confirm of a staged whatif_assumption — R1 snapshot-integrity guard", () => {
    // These tests verify the PERSIST path (a feasible what-if confirm persists
    // the schedule, never parsed_dpr). They use the FEASIBLE fixture (a free
    // elective whose W / P/F re-opens no requirement) so the re-solve is valid
    // and a persist actually occurs — the M1 C1 fix refuses an INFEASIBLE
    // what-if confirm (covered by its own block below), so the persist path now
    // requires a feasible re-solve.
    beforeEach(async () => {
        resetStoresForTests();
        _resetPendingMutationsForTests();
        await seedFeasibleWhatIfStudent();
    });

    it("persists the resulting forward_schedule AND leaves parsed_dpr BYTE-IDENTICAL", async () => {
        const profileStore = getStores({}).profileStore as InMemoryProfileStore;
        const dprBefore = JSON.stringify(await profileStore.getParsedDpr(FEAS_STUDENT_ID));
        expect(dprBefore).not.toBe("null");

        // Propose → stage.
        const proposed = await runProposeWhatIfStage(
            FEAS_STUDENT_ID,
            { courseId: FEAS_COURSE, outcome: "withdraw" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(proposed.ok).toBe(true);
        if (!proposed.ok) return;
        expect(proposed.response.feasible).toBe(true);
        const pendingMutationId = proposed.response.pendingMutationId;

        // Confirm → re-apply transform + persist the schedule (NOT the DPR).
        const confirmed = await runConfirmStage(FEAS_STUDENT_ID, pendingMutationId);
        expect(confirmed.ok).toBe(true);
        if (!confirmed.ok) return;
        expect(confirmed.response.consumedMutationId).toBe(pendingMutationId);
        // A schedule was persisted/returned.
        expect(confirmed.response.forwardSchedule).toBeDefined();

        // ---- R1 GUARD: parsed_dpr is BYTE-IDENTICAL after the confirm. ----
        const dprAfter = JSON.stringify(await profileStore.getParsedDpr(FEAS_STUDENT_ID));
        expect(dprAfter).toBe(dprBefore);
        // And the persisted DPR is STILL the authoritative real DPR (reportKind dpr).
        const dprObj = await profileStore.getParsedDpr(FEAS_STUDENT_ID);
        expect(dprObj?.reportKind).toBe("dpr");

        // The confirmed plan WAS persisted to the schedule store (live row changed
        // from the seed — i.e. the supersede-then-insert landed a new row).
        const scheduleStore = getStores({}).scheduleStore as InMemoryScheduleStore;
        const live = await scheduleStore.loadLatestSchedule(FEAS_STUDENT_ID);
        expect(live).not.toBeNull();
        expect(live!.schedule.dprCourseHistoryHash).not.toBe("seed-hash");
    });

    it("a what-if confirm never throws the assertAuthoritativeDpr guard", async () => {
        const proposed = await runProposeWhatIfStage(
            FEAS_STUDENT_ID,
            { courseId: FEAS_COURSE, outcome: "fail" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(proposed.ok).toBe(true);
        if (!proposed.ok) return;
        expect(proposed.response.feasible).toBe(true);

        // Must not throw — the guard only fires on a parsed_dpr write with a
        // non-"dpr" reportKind; confirm persists the schedule, not the DPR.
        const confirmed = await runConfirmStage(FEAS_STUDENT_ID, proposed.response.pendingMutationId);
        expect(confirmed.ok).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// withdraw vs pass vs fail produce the expected re-open/keep (propose wiring)
// ---------------------------------------------------------------------------

describe("runProposeWhatIfStage — withdraw / pass / fail re-plan via the transforms", () => {
    it("withdraw re-opens the major leaf (proposed plan differs from baseline OR re-places the course)", async () => {
        const result = await runProposeWhatIfStage(
            STUDENT_ID,
            { courseId: "CSCI-UA 102", outcome: "withdraw" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const sched = result.response.forwardSchedule!;
        const rePlaced = sched.semesters.some((sem) =>
            sem.slots.some((s) => s.kind === "specific_planned" && s.courseId === "CSCI-UA 102"),
        );
        const diffNonEmpty =
            result.response.diff.added.length > 0 || result.response.diff.removed.length > 0;
        expect(rePlaced || diffNonEmpty).toBe(true);
    });

    it("pass at CAS (elective-only) re-opens the major leaf (course re-placed)", async () => {
        const result = await runProposeWhatIfStage(
            STUDENT_ID,
            { courseId: "CSCI-UA 102", outcome: "pass" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const sched = result.response.forwardSchedule!;
        const rePlaced = sched.semesters.some((sem) =>
            sem.slots.some((s) => s.kind === "specific_planned" && s.courseId === "CSCI-UA 102"),
        );
        const diffNonEmpty =
            result.response.diff.added.length > 0 || result.response.diff.removed.length > 0;
        expect(rePlaced || diffNonEmpty).toBe(true);
    });

    it("fail carries a GPA hedge on the whatIfAssumption marker", async () => {
        const result = await runProposeWhatIfStage(
            STUDENT_ID,
            { courseId: "CSCI-UA 102", outcome: "fail" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const hedges = result.response.whatIfAssumption?.hedges ?? [];
        expect(hedges.some((h) => /GPA/i.test(h))).toBe(true);
    });

});

// ---------------------------------------------------------------------------
// M1 C1 (plan 37) — the what-if-assumption confirm REFUSES an infeasible result.
//
// THE GAP this closes: `runConfirmStage` early-returned into
// `runConfirmWhatIfAssumption`, BYPASSING the M1 plan-change infeasible guard,
// and the what-if persist was UNCONDITIONAL — an infeasible re-solve would call
// `persistSchedule`, which supersedes every prior live row, DESTROYING the
// previously-committed VALID plan and replacing it with the invalid one (then
// returning ok:true → the client committed).
//
// THE INVARIANT (now complete): an infeasible what-if confirm behaves EXACTLY
// like an infeasible plan-change confirm — 422 (kind:"infeasible"), persist
// NOTHING, the prior valid committed row UNTOUCHED.
// ---------------------------------------------------------------------------

describe("M1 C1 — an infeasible what-if confirm is refused (never commit an invalid plan)", () => {
    beforeEach(async () => {
        // Override the default seed with the infeasible-on-re-solve student
        // (the IP course's W re-opens a named leaf that can't be re-credited).
        resetStoresForTests();
        _resetPendingMutationsForTests();
        await seedInfeasibleWhatIfStudent();
    });

    it("the propose half reports the re-solve is INFEASIBLE (fixture sanity)", async () => {
        // The W re-opens the named SR/10 leaf the IP course satisfied; the
        // re-placed course is not re-credited to it → Axis 1 fails. This is the
        // precondition the confirm refusal guards.
        const proposed = await runProposeWhatIfStage(
            INFEAS_STUDENT_ID,
            { courseId: "CSCI-UA 102", outcome: "withdraw" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(proposed.ok).toBe(true);
        if (!proposed.ok) return;
        expect(proposed.response.feasible).toBe(false);
    });

    it("confirm → { ok:false, kind:'infeasible' } + nothing persisted + the prior VALID row survives", async () => {
        const scheduleStore = getStores({}).scheduleStore as InMemoryScheduleStore;
        const before = await scheduleStore.loadLatestSchedule(INFEAS_STUDENT_ID);
        expect(before?.dprFingerprint).toBe("fp-valid");
        expect(before?.schedule.state).toBe("valid-clean");
        expect(before?.schedule.dprCourseHistoryHash).toBe("seed-hash");

        // Propose → stage the (infeasible) assumption.
        const proposed = await runProposeWhatIfStage(
            INFEAS_STUDENT_ID,
            { courseId: "CSCI-UA 102", outcome: "withdraw" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(proposed.ok).toBe(true);
        if (!proposed.ok) return;
        expect(proposed.response.feasible).toBe(false);

        // Confirm → REFUSED. No persist. The reason names the failing axis.
        const confirmed = await runConfirmStage(INFEAS_STUDENT_ID, proposed.response.pendingMutationId);
        expect(confirmed.ok).toBe(false);
        if (confirmed.ok) return;
        expect(confirmed.error.kind).toBe("infeasible");
        expect(confirmed.error.message).toMatch(/invalid|requirement|axis|graduation-path|not satisfied/i);

        // The previously-committed VALID plan is UNCHANGED — the infeasible
        // what-if never superseded the prior live row (the C1 bug).
        const after = await scheduleStore.loadLatestSchedule(INFEAS_STUDENT_ID);
        expect(after?.dprFingerprint).toBe("fp-valid");
        expect(after?.schedule.state).toBe("valid-clean");
        expect(after?.schedule.dprCourseHistoryHash).toBe("seed-hash");
        expect(after?.schedule.computedAt).toBe(before?.schedule.computedAt);
    });

    it("a FEASIBLE what-if confirm STILL commits (regression guard)", async () => {
        // Re-seed the FEASIBLE fixture (a free elective whose W re-opens no
        // requirement) so the re-solve is valid and the confirm DOES commit.
        resetStoresForTests();
        _resetPendingMutationsForTests();
        await seedFeasibleWhatIfStudent();

        const scheduleStore = getStores({}).scheduleStore as InMemoryScheduleStore;
        const before = await scheduleStore.loadLatestSchedule(FEAS_STUDENT_ID);
        expect(before?.schedule.dprCourseHistoryHash).toBe("seed-hash");

        const proposed = await runProposeWhatIfStage(
            FEAS_STUDENT_ID,
            { courseId: FEAS_COURSE, outcome: "withdraw" },
            { now: NOW_IN_WITHDRAW_WINDOW },
        );
        expect(proposed.ok).toBe(true);
        if (!proposed.ok) return;
        expect(proposed.response.feasible).toBe(true);

        const confirmed = await runConfirmStage(FEAS_STUDENT_ID, proposed.response.pendingMutationId);
        expect(confirmed.ok).toBe(true);
        if (!confirmed.ok) return;
        expect(confirmed.response.feasible).toBe(true);
        expect(confirmed.response.storedIn).toBe("forwardSchedule");

        // The committed plan WAS rewritten (the supersede-then-insert landed).
        const after = await scheduleStore.loadLatestSchedule(FEAS_STUDENT_ID);
        expect(after?.schedule.dprCourseHistoryHash).not.toBe("seed-hash");
    });
});
