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

const STUDENT_ID = "whatif-route-fixture";
const IP_COURSE_TERM = "2026 Fall";

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
            { programType: "Undergraduate Career", label: "UA-Coll of Arts & Sci", requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" },
            { programType: "Major", label: "Computer Science", requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" },
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
                            { term: IP_COURSE_TERM, subject: "CSCI-UA", catalogNbr: "102", courseTitle: "Data Structures", grade: "IP", units: 4, type: "IP" },
                        ],
                    },
                ],
            },
        ],
        courseHistory: [
            { term: IP_COURSE_TERM, subject: "CSCI-UA", catalogNbr: "102", courseTitle: "Data Structures", grade: "IP", units: 4, type: "IP" },
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
        const res = await POST(fakeRequest(undefined, { courseId: "CSCI-UA 102", outcome: "withdraw" }) as never);
        expect(res.status).toBe(401);
    });

    it("returns 400 on an invalid outcome", async () => {
        const token = await issueTestToken(STUDENT_ID);
        const { POST } = await import("../app/api/plan/whatif/route");
        const res = await POST(fakeRequest(token, { courseId: "CSCI-UA 102", outcome: "drop" }) as never);
        expect(res.status).toBe(400);
    });

    it("propose → 200 with pendingMutationId + whatIfAssumption marker + proposed plan", async () => {
        const token = await issueTestToken(STUDENT_ID);
        const { POST } = await import("../app/api/plan/whatif/route");
        const res = await POST(fakeRequest(token, { courseId: "CSCI-UA 102", outcome: "withdraw" }) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(json.whatIfAssumption).toBeDefined();
        expect(json.whatIfAssumption.courseId).toBe("CSCI-UA 102");
        expect(json.whatIfAssumption.outcome).toBe("withdraw");
        expect(typeof json.whatIfAssumption.label).toBe("string");
        expect(json.forwardSchedule).toBeDefined();
    });

    it("propose is read-only — the persisted schedule is unchanged", async () => {
        const token = await issueTestToken(STUDENT_ID);
        const stores = getStores({});
        const before = await stores.scheduleStore.loadLatestSchedule(STUDENT_ID);
        const { POST } = await import("../app/api/plan/whatif/route");
        await POST(fakeRequest(token, { courseId: "CSCI-UA 102", outcome: "withdraw" }) as never);
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
            fakeRequest(token, { courseId: "CSCI-UA 102", outcome: "withdraw" }) as never,
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
});
