// ============================================================
// /api/plan/whatif (Plan 35 G3.1) — route round-trip tests
// ============================================================
// Validates the propose→confirm HTTP plumbing for a current-term
// IP-course WHAT-IF ASSUMPTION:
//   - missing auth → 401
//   - malformed body (bad outcome) → 400
//   - happy path → 200 with { pendingMutationId, whatIfAssumption, forwardSchedule }
//   - confirm via the SHARED /api/plan/confirm route persists the schedule
//     AND leaves parsed_dpr byte-identical (the R1 guardrail at the HTTP edge)
//
// Offline only (DATABASE_URL deleted → in-memory store bundle).
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    InMemoryProfileStore,
    InMemoryScheduleStore,
    type DegreeProgressReport,
} from "@nyupath/engine";
import type { ForwardSchedule, StudentProfile } from "@nyupath/shared";
import { fakeRequest, issueTestToken, TEST_SECRET } from "./_planRouteTestUtils";
import { resetStoresForTests, getStores } from "../lib/db/store";
import { _resetPendingMutationsForTests } from "../lib/planActionOrchestrator";
import { _clearBuckets } from "../lib/rateLimit";

// ---------------------------------------------------------------------------
// Fixtures shared by the guard-bypass tests (route-level validateInput).
// ---------------------------------------------------------------------------

/** A Tandon student (homeSchool:"tandon", canElect:false) with one IP course. */
async function seedTandonStudent(studentId: string): Promise<void> {
    const stores = getStores({});
    const profileStore = stores.profileStore as InMemoryProfileStore;
    const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
    const profile: StudentProfile = {
        id: studentId,
        catalogYear: "2024-2025",
        homeSchool: "tandon",
        declaredPrograms: [{ programId: "computer_science", programType: "major" }],
        coursesTaken: [],
        genericTransferCredits: 0,
        flags: [],
        visaStatus: "domestic",
    };
    const dpr: DegreeProgressReport = {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:tandon-route-test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        reportKind: "dpr",
        header: { studentName: "Tandon Route Fixture", preparedDate: "10/01/2026" },
        programs: [
            { programType: "Undergraduate Career", label: "UA-Tandon Sch of Engineering", requirementTerm: "Fall 2024", requirementStatus: "satisfied" },
        ],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 128,
            cumulativeGpa: 3.5,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 0,
            passFailCapUnits: 0,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [],
        courseHistory: [
            { term: "2026 Fall", subject: "CS", catalogNbr: "1114", courseTitle: "Intro to CS", grade: "IP", units: 4, type: "IP" },
        ],
    };
    const schedule: ForwardSchedule = {
        studentId,
        homeSchoolId: "tandon",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "tandon-seed-hash",
        computedAt: 1_700_000_000_000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
    await profileStore.persistMutation(
        profile,
        { pendingMutationId: "seed", field: "homeSchool", before: null, after: "tandon", confirmedAt: new Date().toISOString() },
        dpr,
    );
    await scheduleStore.persistSchedule(studentId, schedule, "fp-tandon-seed");
}

/** A CAS student with a COMPLETED (non-IP) course — used to test E1 (D-7
 *  IP-membership) rejection on the route. */
async function seedCompletedCourseStudent(studentId: string): Promise<void> {
    const stores = getStores({});
    const profileStore = stores.profileStore as InMemoryProfileStore;
    const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
    const profile: StudentProfile = {
        id: studentId,
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "computer_science", programType: "major" }],
        coursesTaken: [],
        genericTransferCredits: 0,
        flags: [],
        visaStatus: "domestic",
    };
    const dpr: DegreeProgressReport = {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:completed-route-test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        reportKind: "dpr",
        header: { studentName: "Completed Course Fixture", preparedDate: "10/01/2026" },
        programs: [
            { programType: "Undergraduate Career", label: "UA-Coll of Arts & Sci", requirementTerm: "Fall 2024", requirementStatus: "satisfied" },
        ],
        advisorNotations: [],
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
        requirementGroups: [],
        // The course is COMPLETED (type:"completed", grade:"A"), NOT in progress.
        courseHistory: [
            { term: "2025 Fall", subject: "CSCI-UA", catalogNbr: "101", courseTitle: "Intro to CS", grade: "A", units: 4, type: "completed" },
        ],
    };
    const schedule: ForwardSchedule = {
        studentId,
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        semesters: [],
        dprCourseHistoryHash: "completed-seed-hash",
        computedAt: 1_700_000_000_000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
    await profileStore.persistMutation(
        profile,
        { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
        dpr,
    );
    await scheduleStore.persistSchedule(studentId, schedule, "fp-completed-seed");
}

const STUDENT_ID = "whatif-route-fixture";
const IP_COURSE_TERM = "2026 Fall";
const IP_COURSE = "ELEC-UA 200";

// A FEASIBLE-on-re-solve fixture: the current-term IP course is a FREE ELECTIVE
// (in courseHistory only — NOT tied to any named requirement leaf) and the
// degree is already credit-complete. Withdrawing it re-opens NO requirement, so
// the re-solve stays valid (feasible:true) and the confirm DOES persist — which
// is what the R1 byte-identity-on-a-successful-persist test below exercises.
// (The M1 C1 fix refuses an INFEASIBLE what-if confirm with 422; the orchestrator
// suite `whatIfAssumptionOrchestrator.test.ts` covers that refusal directly.)
function makeIpMajorDpr(): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:whatif-route",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        reportKind: "dpr",
        header: { studentName: "WhatIf Route Fixture", preparedDate: "10/01/2026" },
        programs: [
            { programType: "Undergraduate Career", label: "UA-Coll of Arts & Sci", requirementTerm: "Fall 2024", requirementStatus: "satisfied" },
        ],
        advisorNotations: [],
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
        // No unsatisfied requirement leaves — nothing for the W to re-open.
        requirementGroups: [],
        courseHistory: [
            { term: IP_COURSE_TERM, subject: "ELEC-UA", catalogNbr: "200", courseTitle: "Free Elective", grade: "IP", units: 4, type: "IP" },
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

describe("/api/plan/whatif (G3.1)", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    const ORIGINAL_DB_URL = process.env.DATABASE_URL;

    beforeEach(async () => {
        delete process.env.DATABASE_URL;
        process.env.SECRET_KEY = TEST_SECRET;
        resetStoresForTests();
        _resetPendingMutationsForTests();
        _clearBuckets();
        await seedStudent();
    });
    afterEach(() => {
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
        if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL_DB_URL;
        resetStoresForTests();
        _resetPendingMutationsForTests();
        _clearBuckets();
    });

    it("returns 401 with no session cookie", async () => {
        const { POST } = await import("../app/api/plan/whatif/route");
        const res = await POST(fakeRequest(undefined, { courseId: IP_COURSE, outcome: "withdraw" }) as never);
        expect(res.status).toBe(401);
    });

    it("returns 400 on an invalid outcome", async () => {
        const token = await issueTestToken(STUDENT_ID);
        const { POST } = await import("../app/api/plan/whatif/route");
        const res = await POST(fakeRequest(token, { courseId: IP_COURSE, outcome: "drop" }) as never);
        expect(res.status).toBe(400);
    });

    it("propose → 200 with pendingMutationId + whatIfAssumption marker + proposed plan", async () => {
        const token = await issueTestToken(STUDENT_ID);
        const { POST } = await import("../app/api/plan/whatif/route");
        const res = await POST(fakeRequest(token, { courseId: IP_COURSE, outcome: "withdraw" }) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(json.whatIfAssumption).toBeDefined();
        expect(json.whatIfAssumption.courseId).toBe(IP_COURSE);
        expect(json.whatIfAssumption.outcome).toBe("withdraw");
        expect(typeof json.whatIfAssumption.label).toBe("string");
        expect(json.forwardSchedule).toBeDefined();
    });

    it("propose is read-only — the persisted schedule is unchanged", async () => {
        const token = await issueTestToken(STUDENT_ID);
        const stores = getStores({});
        const before = await stores.scheduleStore.loadLatestSchedule(STUDENT_ID);
        const { POST } = await import("../app/api/plan/whatif/route");
        await POST(fakeRequest(token, { courseId: IP_COURSE, outcome: "withdraw" }) as never);
        const after = await stores.scheduleStore.loadLatestSchedule(STUDENT_ID);
        expect(after?.schedule.computedAt).toBe(before?.schedule.computedAt);
        expect(after?.schedule.dprCourseHistoryHash).toBe("seed-hash");
    });

    it("propose → confirm (shared /api/plan/confirm) persists the schedule + leaves parsed_dpr BYTE-IDENTICAL (R1)", async () => {
        const token = await issueTestToken(STUDENT_ID);
        const profileStore = getStores({}).profileStore as InMemoryProfileStore;
        const dprBefore = JSON.stringify(await profileStore.getParsedDpr(STUDENT_ID));

        const { POST: whatifPOST } = await import("../app/api/plan/whatif/route");
        const proposeRes = await whatifPOST(
            fakeRequest(token, { courseId: IP_COURSE, outcome: "withdraw" }) as never,
        );
        expect(proposeRes.status).toBe(200);
        const pendingMutationId = (await proposeRes.json()).pendingMutationId;

        const { POST: confirmPOST } = await import("../app/api/plan/confirm/route");
        const confirmRes = await confirmPOST(fakeRequest(token, { pendingMutationId }) as never);
        expect(confirmRes.status).toBe(200);
        const confirmJson = await confirmRes.json();
        expect(confirmJson.consumedMutationId).toBe(pendingMutationId);
        expect(confirmJson.whatIfAssumption).toBeDefined();
        expect(confirmJson.whatIfAssumption.outcome).toBe("withdraw");

        // R1: parsed_dpr byte-identical after the confirmed what-if.
        const dprAfter = JSON.stringify(await profileStore.getParsedDpr(STUDENT_ID));
        expect(dprAfter).toBe(dprBefore);
        expect((await profileStore.getParsedDpr(STUDENT_ID))?.reportKind).toBe("dpr");

        // The schedule WAS persisted (live row changed from the seed).
        const live = await getStores({}).scheduleStore.loadLatestSchedule(STUDENT_ID);
        expect(live!.schedule.dprCourseHistoryHash).not.toBe("seed-hash");
    });

    // ── Guard-bypass tests (D-4 P/F-eligibility + D-7 IP-membership) ────────
    // Before the fix, the ROUTE called proposeWhatIfAssumptionTool.call()
    // DIRECTLY, skipping validateInput entirely. The agent path was protected;
    // the route path (editor + direct API callers) was not.
    // After the fix, runProposeWhatIfStage calls validateInput before .call.

    describe("D-4 P/F-eligibility guard enforced on route (Tandon canElect:false)", () => {
        const TANDON_STUDENT_ID = "tandon-route-guard-test";
        const TANDON_IP_COURSE = "CS 1114";

        beforeEach(async () => {
            resetStoresForTests();
            _resetPendingMutationsForTests();
            _clearBuckets();
            await seedTandonStudent(TANDON_STUDENT_ID);
        });

        it("pass what-if at Tandon (canElect:false) → 400 with P/F-eligibility message", async () => {
            const token = await issueTestToken(TANDON_STUDENT_ID);
            const { POST } = await import("../app/api/plan/whatif/route");
            const res = await POST(
                fakeRequest(token, { courseId: TANDON_IP_COURSE, outcome: "pass" }) as never,
            );
            expect(res.status).toBe(400);
            const json = await res.json();
            expect(json.kind).toBe("bad_input");
            // The validateInput D-4 message mentions pass/fail and the school.
            expect(json.error).toMatch(/pass.fail|elect/i);
        });

        it("fail what-if at Tandon (canElect:false) → 400 with P/F-eligibility message", async () => {
            const token = await issueTestToken(TANDON_STUDENT_ID);
            const { POST } = await import("../app/api/plan/whatif/route");
            const res = await POST(
                fakeRequest(token, { courseId: TANDON_IP_COURSE, outcome: "fail" }) as never,
            );
            expect(res.status).toBe(400);
            const json = await res.json();
            expect(json.kind).toBe("bad_input");
            expect(json.error).toMatch(/pass.fail|elect/i);
        });

        it("withdraw what-if at Tandon (canElect:false) → still allowed (withdraw is universal)", async () => {
            // D-4 only blocks pass/fail outcomes; withdraw is never gated by canElect.
            const token = await issueTestToken(TANDON_STUDENT_ID);
            const { POST } = await import("../app/api/plan/whatif/route");
            const res = await POST(
                fakeRequest(token, { courseId: TANDON_IP_COURSE, outcome: "withdraw" }) as never,
            );
            // validateInput passes for withdraw; the re-solve may or may not be
            // feasible — the important thing is validateInput itself does NOT reject.
            expect([200, 500]).toContain(res.status);
            if (res.status === 200) {
                const json = await res.json();
                expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
            }
        });
    });

    describe("D-7 IP-membership guard enforced on route (E1)", () => {
        const COMPLETED_STUDENT_ID = "completed-course-route-guard-test";
        const COMPLETED_COURSE = "CSCI-UA 101";

        beforeEach(async () => {
            resetStoresForTests();
            _resetPendingMutationsForTests();
            _clearBuckets();
            await seedCompletedCourseStudent(COMPLETED_STUDENT_ID);
        });

        it("withdraw targeting a completed (non-IP) course → 400 (E1: not in progress)", async () => {
            const token = await issueTestToken(COMPLETED_STUDENT_ID);
            const { POST } = await import("../app/api/plan/whatif/route");
            const res = await POST(
                fakeRequest(token, { courseId: COMPLETED_COURSE, outcome: "withdraw" }) as never,
            );
            expect(res.status).toBe(400);
            const json = await res.json();
            expect(json.kind).toBe("bad_input");
            // The validateInput D-7 message mentions "in progress" / "completed".
            expect(json.error).toMatch(/in.progress|already completed/i);
        });

        it("pass targeting a completed (non-IP) course → 400 (E1: not in progress)", async () => {
            const token = await issueTestToken(COMPLETED_STUDENT_ID);
            const { POST } = await import("../app/api/plan/whatif/route");
            const res = await POST(
                fakeRequest(token, { courseId: COMPLETED_COURSE, outcome: "pass" }) as never,
            );
            expect(res.status).toBe(400);
            const json = await res.json();
            expect(json.kind).toBe("bad_input");
            expect(json.error).toMatch(/in.progress|already completed/i);
        });

        it("what-if targeting a course NOT on the DPR at all → 400 (E1: not on DPR / planned)", async () => {
            const token = await issueTestToken(COMPLETED_STUDENT_ID);
            const { POST } = await import("../app/api/plan/whatif/route");
            const res = await POST(
                fakeRequest(token, { courseId: "UNKNOWN-UA 9999", outcome: "withdraw" }) as never,
            );
            expect(res.status).toBe(400);
            const json = await res.json();
            expect(json.kind).toBe("bad_input");
            // D-7 message for absent course mentions "planned" / "not … currently taking".
            expect(json.error).toMatch(/planned|currently taking/i);
        });
    });

    describe("valid what-if via route still succeeds (regression guard after fix)", () => {
        it("valid withdraw (IP course, CAS school) → 200", async () => {
            const token = await issueTestToken(STUDENT_ID);
            const { POST } = await import("../app/api/plan/whatif/route");
            const res = await POST(
                fakeRequest(token, { courseId: IP_COURSE, outcome: "withdraw" }) as never,
            );
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
            expect(json.whatIfAssumption?.outcome).toBe("withdraw");
        });

        it("valid pass (IP course, CAS school — canElect:true) → 200", async () => {
            const token = await issueTestToken(STUDENT_ID);
            const { POST } = await import("../app/api/plan/whatif/route");
            const res = await POST(
                fakeRequest(token, { courseId: IP_COURSE, outcome: "pass" }) as never,
            );
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
            expect(json.whatIfAssumption?.outcome).toBe("pass");
        });
    });
});
