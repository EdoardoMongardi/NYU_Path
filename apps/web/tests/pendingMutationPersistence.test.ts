// ============================================================
// E6.3 — pendingMutationId staging persistence (multi-instance durability)
// ============================================================
// Phase 4 Task E6.3 moves the propose→confirm staging entry out of a
// per-process `Map` and into a durable `PendingMutationStore` (Postgres
// `pending_mutations` table when DATABASE_URL is wired; an in-memory
// singleton otherwise). The point is that a staged proposal survives a
// process restart / multi-instance deploy: the second route invocation
// (`/api/plan/confirm`) reads the entry from the STORE, never from an
// instance-local Map.
//
// "Restart" semantics under test:
//   - Postgres path (production): the row literally outlives the process.
//   - In-memory path (this offline test): the entry lives on the
//     `getStores()` store singleton, NOT inside `runProposeStage`'s
//     closure. We simulate a "process re-entry" by reading the entry
//     back through a FRESH `getStores().pendingMutationStore` handle
//     (and a fresh `runConfirmStage` call) WITHOUT clearing the
//     underlying store. The load-bearing assertion is that the staged
//     entry is still confirmable after that re-entry — i.e. it was read
//     from the store, not from a Map scoped to the propose invocation.
//
// What we deliberately do NOT simulate offline: a TRUE cold restart
// (which would clear the in-memory Map AND would have cleared the old
// per-process Map too). That regression is only meaningful against a
// real DB and is covered by the live E6.5 e2e gate. Here we assert the
// store IS the source of truth (no per-instance Map), plus that the
// cross-tenant + single-use + TTL guards now enforced inside the store
// still hold.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    runProposeStage,
    runConfirmStage,
    _resetPendingMutationsForTests,
    _pendingMutationsSizeForTests,
} from "../lib/planActionOrchestrator";
import { resetStoresForTests, getStores } from "../lib/db/store";
import {
    InMemoryPendingMutationStore,
    encodePendingPayload,
    decodePendingPayload,
} from "../lib/db/pendingMutationStore";
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
// Fixtures (mirror planActionOrchestrator.test.ts)
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

describe("pendingMutation staging persistence (E6.3)", () => {
    beforeEach(() => {
        delete process.env.DATABASE_URL;
        resetStoresForTests();
        _resetPendingMutationsForTests();
    });
    afterEach(() => {
        resetStoresForTests();
        _resetPendingMutationsForTests();
    });

    it("stages the proposal in the store (not a per-instance Map) so it survives a process re-entry", async () => {
        const studentId = "persist_student";
        await seedStudentState(studentId);

        const stage1 = await runProposeStage(studentId, PIN);
        expect(stage1.ok).toBe(true);
        if (!stage1.ok) return;
        const id = stage1.response.pendingMutationId;

        // PROOF the entry lives on the store singleton, not inside the
        // `runProposeStage` closure: read it directly off a FRESH
        // `getStores().pendingMutationStore` handle. A new handle from the
        // SAME singleton (the store cache is intact — we did NOT call
        // resetStoresForTests) sees the entry. This is the "process
        // re-entry" the Postgres path makes literal across a restart.
        const store = getStores({}).pendingMutationStore as InMemoryPendingMutationStore;
        expect(store.sizeForTests()).toBe(1);

        // Confirm via a fresh runConfirmStage invocation — it reads the
        // entry from the store, NOT a Map local to the earlier propose.
        const apply = await runConfirmStage(studentId, id);
        expect(apply.ok).toBe(true);
        if (!apply.ok) return;
        expect(apply.response.consumedMutationId).toBe(id);
    });

    it("cross-tenant guard: a different studentId confirming the same id is rejected (entry NOT applied)", async () => {
        const studentId = "persist_owner";
        await seedStudentState(studentId);

        const stage1 = await runProposeStage(studentId, PIN);
        expect(stage1.ok).toBe(true);
        if (!stage1.ok) return;
        const id = stage1.response.pendingMutationId;

        const attack = await runConfirmStage("attacker_id", id);
        expect(attack.ok).toBe(false);
        if (attack.ok) return;
        expect(attack.error.kind).toBe("studentId_mismatch");

        // The entry must still be intact for the rightful owner — a
        // rejected cross-tenant take must NOT consume it.
        const owner = await runConfirmStage(studentId, id);
        expect(owner.ok).toBe(true);
    });

    it("single-use: confirming the same id twice fails the second time (taken on first confirm)", async () => {
        const studentId = "persist_singleuse";
        await seedStudentState(studentId);

        const stage1 = await runProposeStage(studentId, PIN);
        expect(stage1.ok).toBe(true);
        if (!stage1.ok) return;
        const id = stage1.response.pendingMutationId;

        const first = await runConfirmStage(studentId, id);
        expect(first.ok).toBe(true);

        const second = await runConfirmStage(studentId, id);
        expect(second.ok).toBe(false);
        if (second.ok) return;
        expect(second.error.kind).toBe("unknown_mutation_id");
    });

    it("TTL: an expired staged entry is not confirmable", async () => {
        const studentId = "persist_ttl";
        await seedStudentState(studentId);

        const stage1 = await runProposeStage(studentId, PIN);
        expect(stage1.ok).toBe(true);
        if (!stage1.ok) return;
        const id = stage1.response.pendingMutationId;

        // Age the entry past the 10-min TTL by rewinding its createdAt
        // on the store, then sweep. The confirm must then 404.
        const store = getStores({}).pendingMutationStore as InMemoryPendingMutationStore;
        store.expireAllForTests();

        const out = await runConfirmStage(studentId, id);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.error.kind).toBe("unknown_mutation_id");
    });

    it("InMemoryPendingMutationStore.take enforces cross-tenant + single-use directly", async () => {
        const store = new InMemoryPendingMutationStore();
        await store.stage({
            pendingMutationId: "id-1",
            studentId: "owner",
            mutations: PIN,
            createdAt: Date.now(),
        });
        expect(store.sizeForTests()).toBe(1);

        // Wrong tenant → tenant_mismatch, entry preserved (NOT consumed).
        const wrong = await store.take("id-1", "intruder");
        expect(wrong.status).toBe("tenant_mismatch");
        expect(store.sizeForTests()).toBe(1);

        // Right tenant → ok + consumed.
        const got = await store.take("id-1", "owner");
        expect(got.status).toBe("ok");
        if (got.status === "ok") expect(got.entry.mutations).toEqual(PIN);
        expect(store.sizeForTests()).toBe(0);

        // Second take of the same id → not_found (single-use).
        const again = await store.take("id-1", "owner");
        expect(again.status).toBe("not_found");
    });

    it("_resetPendingMutationsForTests / _pendingMutationsSizeForTests delegate to the store", async () => {
        const studentId = "persist_reset";
        await seedStudentState(studentId);

        await runProposeStage(studentId, PIN);
        expect(_pendingMutationsSizeForTests()).toBeGreaterThan(0);

        _resetPendingMutationsForTests();
        expect(_pendingMutationsSizeForTests()).toBe(0);
    });

    // -- G3.1 — the shared `mutations` JSONB carries BOTH kinds (no migration) --

    it("encode/decode round-trips a plan-mutation batch as the bare array (back-compat)", () => {
        const entry = {
            pendingMutationId: "id-pm",
            studentId: "owner",
            mutations: PIN,
            createdAt: Date.now(),
        };
        const encoded = encodePendingPayload(entry);
        // A plan-mutation batch encodes as the BARE array — pre-G3.1 rows decode
        // identically, so the column is migration-free.
        expect(Array.isArray(encoded)).toBe(true);
        const decoded = decodePendingPayload(encoded);
        expect(decoded.mutations).toEqual(PIN);
        expect(decoded.assumption).toBeUndefined();
    });

    it("encode/decode round-trips a what-if assumption via the tagged wrapper", () => {
        const entry = {
            pendingMutationId: "id-wa",
            studentId: "owner",
            mutations: [],
            assumption: { courseId: "CSCI-UA 102", outcome: "withdraw" as const },
            createdAt: Date.now(),
        };
        const encoded = encodePendingPayload(entry);
        // A what-if assumption encodes as a tagged object — NOT an array — so the
        // decode disambiguates it from a plan-mutation batch.
        expect(Array.isArray(encoded)).toBe(false);
        const decoded = decodePendingPayload(encoded);
        expect(decoded.assumption).toEqual({ courseId: "CSCI-UA 102", outcome: "withdraw" });
        expect(decoded.mutations).toEqual([]);
    });

    it("InMemoryPendingMutationStore carries a staged assumption through take", async () => {
        const store = new InMemoryPendingMutationStore();
        await store.stage({
            pendingMutationId: "id-wa",
            studentId: "owner",
            mutations: [],
            assumption: { courseId: "CSCI-UA 102", outcome: "fail" },
            createdAt: Date.now(),
        });
        const got = await store.take("id-wa", "owner");
        expect(got.status).toBe("ok");
        if (got.status === "ok") {
            expect(got.entry.assumption).toEqual({ courseId: "CSCI-UA 102", outcome: "fail" });
        }
    });
});
