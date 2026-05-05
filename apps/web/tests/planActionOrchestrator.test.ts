// ============================================================
// planActionOrchestrator (Phase 17 Task B) — orchestrator-level tests
// ============================================================
// Validates the shared two-stage helper that all 5 plan-action
// routes (add/swap/drop/lock/move) and the confirm route delegate
// to. We bypass the HTTP layer here and call `runProposeStage` /
// `runConfirmStage` directly so the contract is exercised without
// the auth + rate-limit plumbing that planActionRouteHelpers wraps
// (those are covered in the per-route tests).
//
// Coverage:
//   - propose succeeds with a clean pin and returns
//     { explanation, pendingMutationId, futureTerms[], forwardSchedule }
//   - propose stages the mutation in the in-memory map and confirm
//     consumes it (single-use semantics)
//   - confirm with an unknown id returns { kind: "unknown_mutation_id" }
//   - confirm with a different studentId on an existing id returns
//     { kind: "studentId_mismatch" }
//   - propose with no profile / no DPR / no schedule returns the
//     corresponding typed error
//   - computeFutureTerms returns only terms within the FOSE window
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    runProposeStage,
    runConfirmStage,
    computeFutureTerms,
    _resetPendingMutationsForTests,
    _pendingMutationsSizeForTests,
} from "../lib/planActionOrchestrator";
import { resetStoresForTests, getStores } from "../lib/db/store";
import {
    InMemoryProfileStore,
    InMemoryScheduleStore,
    type DegreeProgressReport,
} from "@nyupath/engine";
import type {
    ForwardSchedule,
    PlanMutation,
    StudentProfile,
} from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures (mirror proposePlanChangeMoveAndFreeze.test.ts shape)
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

function makeDpr(): DegreeProgressReport {
    return {
        _meta: makeMeta(),
        header: { studentName: "Test Student", preparedDate: "01/01/2026" },
        programs: [],
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
        },
        requirementGroups: [],
        courseHistory: [],
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

function makeFeasibleSchedule(studentId: string): ForwardSchedule {
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
        dprCourseHistoryHash: "test-hash",
        computedAt: 1700000000000,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

async function seedStudentState(studentId: string): Promise<void> {
    const stores = getStores({});
    const profileStore = stores.profileStore as InMemoryProfileStore;
    const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;

    // Profile + parsed DPR (needed for orchestrator's loadSessionState).
    await profileStore.persistMutation(
        makeProfile(studentId),
        {
            pendingMutationId: "seed",
            field: "homeSchool",
            before: null,
            after: "cas",
            confirmedAt: new Date().toISOString(),
        },
        makeDpr(),
    );

    // Schedule (orchestrator refuses to propose without one).
    await scheduleStore.persistSchedule(studentId, makeFeasibleSchedule(studentId), "fp-test");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("planActionOrchestrator (Phase 17 Task B)", () => {
    beforeEach(() => {
        delete process.env.DATABASE_URL;
        resetStoresForTests();
        _resetPendingMutationsForTests();
    });
    afterEach(() => {
        resetStoresForTests();
        _resetPendingMutationsForTests();
    });

    describe("computeFutureTerms (Stage 2 hint)", () => {
        // Pinning the wall-clock to a known date makes the term bucketing
        // deterministic across CI runs.
        const MAY_2026 = new Date("2026-05-15T12:00:00Z");

        it("includes terms within the ~6-month FOSE window (current term + next two seasons)", () => {
            const mutations: PlanMutation[] = [
                { kind: "pin", courseId: "X", term: "2026-spring" }, // current — included
                { kind: "pin", courseId: "X", term: "2026-fall"   }, // next   — included
                { kind: "pin", courseId: "X", term: "2027-spring" }, // beyond window — excluded
            ];
            const out = computeFutureTerms(mutations, MAY_2026);
            expect(out).toContain("2026-spring");
            expect(out).toContain("2026-fall");
            expect(out).not.toContain("2027-spring");
        });

        it("ignores past terms and unparseable strings", () => {
            const mutations: PlanMutation[] = [
                { kind: "pin", courseId: "X", term: "2024-fall"     }, // past — excluded
                { kind: "pin", courseId: "X", term: "not-a-term"    }, // junk — excluded
                { kind: "pin", courseId: "X", term: "2026-summer"   }, // future — included
            ];
            const out = computeFutureTerms(mutations, MAY_2026);
            expect(out).toEqual(["2026-summer"]);
        });

        it("collapses duplicates and sorts deterministically", () => {
            const mutations: PlanMutation[] = [
                { kind: "move", courseId: "X", fromTerm: "2026-fall", toTerm: "2026-summer" },
                { kind: "pin",  courseId: "Y", term: "2026-fall" },
            ];
            const out = computeFutureTerms(mutations, MAY_2026);
            expect(out).toEqual(["2026-fall", "2026-summer"]);
        });
    });

    describe("runProposeStage", () => {
        const studentId = "orch_propose_student";

        it("returns 'no_profile' when the student has no persisted profile", async () => {
            // No seed.
            const out = await runProposeStage(studentId, [
                { kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true },
            ]);
            expect(out.ok).toBe(false);
            if (out.ok) return;
            expect(out.error.kind).toBe("no_profile");
        });

        it("returns 'no_dpr' when only a profile exists (no parsed DPR)", async () => {
            const stores = getStores({});
            const profileStore = stores.profileStore as InMemoryProfileStore;
            await profileStore.persistMutation(
                makeProfile(studentId),
                { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
                // No DPR.
            );
            const out = await runProposeStage(studentId, [
                { kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true },
            ]);
            expect(out.ok).toBe(false);
            if (out.ok) return;
            expect(out.error.kind).toBe("no_dpr");
        });

        it("returns 'no_schedule' when profile + DPR are present but no schedule has been planned", async () => {
            const stores = getStores({});
            const profileStore = stores.profileStore as InMemoryProfileStore;
            await profileStore.persistMutation(
                makeProfile(studentId),
                { pendingMutationId: "seed", field: "homeSchool", before: null, after: "cas", confirmedAt: new Date().toISOString() },
                makeDpr(),
            );
            const out = await runProposeStage(studentId, [
                { kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true },
            ]);
            expect(out.ok).toBe(false);
            if (out.ok) return;
            expect(out.error.kind).toBe("no_schedule");
        });

        it("returns explanation + pendingMutationId + futureTerms on a successful pin propose", async () => {
            await seedStudentState(studentId);

            const out = await runProposeStage(
                studentId,
                [{ kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true }],
                { now: new Date("2026-05-15T12:00:00Z") },
            );

            expect(out.ok).toBe(true);
            if (!out.ok) return;
            expect(out.response.explanation).toBeTruthy();
            expect(out.response.explanation).toContain("CSCI-UA 480");
            expect(out.response.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);
            expect(out.response.futureTerms).toContain("2026-fall");
        });

        it("does NOT mutate the persisted schedule (read-only Stage 1)", async () => {
            await seedStudentState(studentId);
            const stores = getStores({});
            const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
            const before = await scheduleStore.loadLatestSchedule(studentId);

            await runProposeStage(studentId, [
                { kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true },
            ]);

            const after = await scheduleStore.loadLatestSchedule(studentId);
            // computedAt is the canonical "schedule was rewritten" marker —
            // it must not change after a propose-only call.
            expect(after?.schedule.computedAt).toBe(before?.schedule.computedAt);
            expect(after?.dprFingerprint).toBe(before?.dprFingerprint);
        });
    });

    describe("runConfirmStage", () => {
        const studentId = "orch_confirm_student";

        it("returns 'unknown_mutation_id' when the id was never staged", async () => {
            await seedStudentState(studentId);
            const out = await runConfirmStage(studentId, "00000000-0000-4000-8000-000000000000");
            expect(out.ok).toBe(false);
            if (out.ok) return;
            expect(out.error.kind).toBe("unknown_mutation_id");
        });

        it("returns 'studentId_mismatch' when the id belongs to a different student", async () => {
            await seedStudentState(studentId);
            const stage1 = await runProposeStage(studentId, [
                { kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true },
            ]);
            expect(stage1.ok).toBe(true);
            if (!stage1.ok) return;

            // Try to confirm under a different studentId.
            const out = await runConfirmStage("attacker_id", stage1.response.pendingMutationId);
            expect(out.ok).toBe(false);
            if (out.ok) return;
            expect(out.error.kind).toBe("studentId_mismatch");
        });

        it("consumes the staged id on a successful apply (second confirm returns 'unknown_mutation_id')", async () => {
            await seedStudentState(studentId);
            const stage1 = await runProposeStage(studentId, [
                { kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true },
            ]);
            expect(stage1.ok).toBe(true);
            if (!stage1.ok) return;
            expect(_pendingMutationsSizeForTests()).toBeGreaterThan(0);

            const apply = await runConfirmStage(studentId, stage1.response.pendingMutationId);
            expect(apply.ok).toBe(true);
            if (!apply.ok) return;
            expect(apply.response.consumedMutationId).toBe(stage1.response.pendingMutationId);

            // Second confirm of the same id is a no-op (404-equivalent).
            const second = await runConfirmStage(studentId, stage1.response.pendingMutationId);
            expect(second.ok).toBe(false);
            if (second.ok) return;
            expect(second.error.kind).toBe("unknown_mutation_id");
        });

        it("persists the new schedule fingerprint after confirm (write contract)", async () => {
            await seedStudentState(studentId);
            const stores = getStores({});
            const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;

            const stage1 = await runProposeStage(studentId, [
                { kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true },
            ]);
            expect(stage1.ok).toBe(true);
            if (!stage1.ok) return;

            const before = await scheduleStore.loadLatestSchedule(studentId);
            await runConfirmStage(studentId, stage1.response.pendingMutationId);
            const after = await scheduleStore.loadLatestSchedule(studentId);

            // The schedule was re-persisted (new computedAt).
            expect(after).not.toBeNull();
            expect(after!.schedule.computedAt).not.toBe(before?.schedule.computedAt);
        });
    });
});
