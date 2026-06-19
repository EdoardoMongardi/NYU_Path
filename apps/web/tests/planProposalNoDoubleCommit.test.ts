// ============================================================
// I3 — No-double-commit: a confirmed pendingMutationId is consumed
//      on the first confirm; a second confirm of the same id is a
//      no-op that returns "already applied" (unknown_mutation_id),
//      NOT a second persist.
// ============================================================
//
// The canvas Confirm button is the single confirm chokepoint
// (Task I3). `take()` in the pending store is already consume-once
// (both in-memory and Postgres DELETE ... RETURNING paths delete on
// the matched take), so the second `runConfirmStage` call will find
// no entry and return `unknown_mutation_id`. This file exists to
// lock that guarantee with a named regression test.
//
// We exercise the full `runProposeStage` → first `runConfirmStage`
// → second `runConfirmStage` pipeline so that any future refactor
// of the store's take / confirm path immediately shows up here.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    runProposeStage,
    runConfirmStage,
    _resetPendingMutationsForTests,
} from "../lib/planActionOrchestrator";
import { resetStoresForTests, getStores } from "../lib/db/store";
import { InMemoryPendingMutationStore } from "../lib/db/pendingMutationStore";
import { InMemoryProfileStore, InMemoryScheduleStore, type DegreeProgressReport } from "@nyupath/engine";
import type { ForwardSchedule, PlanMutation, StudentProfile } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Fixtures (mirror pendingMutationPersistence.test.ts)
// ---------------------------------------------------------------------------

function makeDpr(): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:test",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        reportKind: "dpr",
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
    await scheduleStore.persistSchedule(studentId, makeFeasibleSchedule(studentId), "fp-test");
}

const PIN: PlanMutation[] = [
    { kind: "pin", courseId: "CSCI-UA 480", term: "2026-fall", freeze: true },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("I3 — no-double-commit: pending-mutation confirm is consume-once", () => {
    beforeEach(() => {
        delete process.env.DATABASE_URL;
        resetStoresForTests();
        _resetPendingMutationsForTests();
    });
    afterEach(() => {
        resetStoresForTests();
        _resetPendingMutationsForTests();
    });

    it("propose once → confirm twice: first confirm succeeds; second returns unknown_mutation_id (already applied)", async () => {
        const studentId = "double_commit_student";
        await seedStudentState(studentId);

        // Stage a proposal (simulates canvas Confirm button appearing).
        const stage1 = await runProposeStage(studentId, PIN);
        expect(stage1.ok).toBe(true);
        if (!stage1.ok) return;
        const id = stage1.response.pendingMutationId;

        // First confirm — the canvas Confirm button is clicked.
        const firstConfirm = await runConfirmStage(studentId, id);
        expect(firstConfirm.ok).toBe(true);
        if (!firstConfirm.ok) return;
        expect(firstConfirm.response.consumedMutationId).toBe(id);

        // Verify the entry is gone from the store (consumed).
        const store = getStores({}).pendingMutationStore as InMemoryPendingMutationStore;
        expect(store.sizeForTests()).toBe(0);

        // Second confirm — agent or double-click tries to confirm the same id.
        // Must return "already applied" (unknown_mutation_id), NOT a second persist.
        const secondConfirm = await runConfirmStage(studentId, id);
        expect(secondConfirm.ok).toBe(false);
        if (secondConfirm.ok) return;
        expect(secondConfirm.error.kind).toBe("unknown_mutation_id");
        // The error message must mention that the id may already have been confirmed.
        expect(secondConfirm.error.message).toMatch(/already been confirmed|expired/i);
    });

    it("the store is still empty after the second (no-op) confirm — no second persist side effect", async () => {
        const studentId = "double_commit_idempotent";
        await seedStudentState(studentId);

        const stage1 = await runProposeStage(studentId, PIN);
        expect(stage1.ok).toBe(true);
        if (!stage1.ok) return;
        const id = stage1.response.pendingMutationId;

        await runConfirmStage(studentId, id); // first — OK
        await runConfirmStage(studentId, id); // second — no-op, should not throw or restage

        // The store must remain empty — no phantom re-stage from the second call.
        const store = getStores({}).pendingMutationStore as InMemoryPendingMutationStore;
        expect(store.sizeForTests()).toBe(0);
    });

    it("InMemoryPendingMutationStore.take is consume-once: second take of the same id returns not_found", async () => {
        const store = new InMemoryPendingMutationStore();
        await store.stage({
            pendingMutationId: "id-once",
            studentId: "owner",
            mutations: PIN,
            createdAt: Date.now(),
        });

        const first = await store.take("id-once", "owner");
        expect(first.status).toBe("ok");
        expect(store.sizeForTests()).toBe(0); // consumed

        const second = await store.take("id-once", "owner");
        expect(second.status).toBe("not_found"); // already applied — no entry
    });
});
