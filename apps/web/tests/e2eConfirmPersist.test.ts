// ============================================================
// E6.5 — e2e confirm→persist against a LIVE Neon (EXIT GATE #2)
// ============================================================
// This is the ONE test in the suite that exercises the propose →
// confirm → persist round-trip against a REAL Postgres (a Neon branch),
// rather than the offline StubDatabase / in-memory fallbacks every
// other DB test uses. It is the FIRST live exercise of:
//   - the E6.3 PostgresPendingMutationStore (durable propose→confirm
//     staging in the `pending_mutations` table), AND
//   - the supersede-then-insert PostgresScheduleStore.persistSchedule,
//   - the Decision-#32 restore routing (valid → forwardSchedule;
//     draft → studentDraftPlan),
//   - the schedule_preferences upsert + the audit_log append.
//
// GATING — INVERTED from the offline DB tests. The offline DB suites
// (planConfirmRoute.test.ts, scheduleStorePostgres.test.ts) DELETE
// `process.env.DATABASE_URL` so they run on the in-memory / Stub path.
// This test is the OPPOSITE: `describe.skipIf(!process.env.DATABASE_URL)`
// so it RUNS ONLY when a real `DATABASE_URL` is wired and SKIPS in the
// default `npx vitest run` (keeping the offline suite green + at the
// same pass count, adding exactly one SKIPPED test).
//
// SELF-CLEANING — the test uses a FIXED, clearly-test-scoped studentId
// and wipes that student's rows (every child table + the parent
// `students` row) in BOTH `beforeAll` and `afterAll` via a direct
// `getDb()` transaction. It is idempotent + leaves NO residue in the
// real DB across runs.
//
// HOW TO RUN IT LIVE (controller):
//   1. Provision a Neon branch and apply the Drizzle migrations
//      (`pnpm --filter @nyupath/web db:migrate` — needs ALL of
//      0000..0003 so `pending_mutations` exists).
//   2. Export `DATABASE_URL=<neon-branch-connection-string>` for the
//      vitest process. (SECRET_KEY is set inside the test so the JWT
//      verifies — no need to export it.)
//   3. `cd /…/NYU_Path && DATABASE_URL=… npx vitest run apps/web/tests/e2eConfirmPersist.test.ts`
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import {
    InMemoryProfileStore,
    computeDprFingerprint,
    type DegreeProgressReport,
} from "@nyupath/engine";
import type { ForwardSchedule, StudentProfile } from "@nyupath/shared";
import {
    fakeRequest,
    issueTestToken,
    makeFeasibleScheduleWithSemesters,
    specificSlot,
    TEST_SECRET,
} from "./_planRouteTestUtils";
import { getDb, closeDb } from "../lib/db/client";
import { getStores, resetStoresForTests } from "../lib/db/store";
import {
    students,
    forwardSchedules,
    schedulePreferences,
    auditLog,
    chatMessages,
    sessionSummaries,
    pendingMutations,
} from "../lib/db/schema";

// A fixed, obviously-test-scoped student id so the wipe is targeted and
// the test is idempotent. The leading `e2e-` prefix keeps it impossible
// to collide with a real studentId (which are auth `sub` uuids).
const STUDENT_ID = "e2e-confirm-persist-fixture";

// The prior live schedule's wall-clock stamp. persistSchedule mirrors
// schedule.computedAt onto the row's `computed_at`; `loadLatestSchedule`
// orders by it DESC. A fixed PAST value guarantees the engine's confirm
// (stamped at ~now) sorts AFTER the seed row.
const SEED_COMPUTED_AT = 1_700_000_000_000; // 2023-11-14

function makeDpr(): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:e2e",
            sourcePdfPageCount: 1,
            parseDurationMs: 0,
            warnings: [],
        },
        header: { studentName: "E2E Fixture", preparedDate: "01/01/2026" },
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

/** The "prior" valid forward schedule seeded before the confirm so the
 *  supersede-then-insert has a live row to supersede. Carries a fixed
 *  PAST computedAt + a single placed slot so it is a real, non-empty
 *  plan. */
function makeSeedSchedule(studentId: string): ForwardSchedule {
    return {
        ...makeFeasibleScheduleWithSemesters(studentId, [
            { term: "2026-fall", slots: [specificSlot("CSCI-UA 102", 4)] },
        ]),
        computedAt: SEED_COMPUTED_AT,
    };
}

/** Hard-delete every row this test could have written for the fixture
 *  student, in FK-safe order (children → parent). Idempotent: safe to
 *  run when nothing exists. Drives a single getDb() transaction so a
 *  partial wipe never leaves a half-deleted student behind. */
async function wipeStudent(studentId: string): Promise<void> {
    const db = getDb(process.env);
    if (!db) return; // gate guarantees a DB, but be defensive.
    await db.transaction(async (tx) => {
        await tx.delete(chatMessages).where(eq(chatMessages.studentId, studentId));
        await tx.delete(forwardSchedules).where(eq(forwardSchedules.studentId, studentId));
        await tx.delete(schedulePreferences).where(eq(schedulePreferences.studentId, studentId));
        await tx.delete(auditLog).where(eq(auditLog.studentId, studentId));
        await tx.delete(sessionSummaries).where(eq(sessionSummaries.studentId, studentId));
        await tx.delete(pendingMutations).where(eq(pendingMutations.studentId, studentId));
        await tx.delete(students).where(eq(students.studentId, studentId));
    });
}

// describe.skipIf — RUNS ONLY when a live DATABASE_URL is set; SKIPS in
// the default offline suite (keeping the green count unchanged save for
// one extra SKIPPED test).
describe.skipIf(!process.env.DATABASE_URL)("e2e confirm→persist (live Neon) — EXIT GATE #2", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;

    beforeAll(async () => {
        // The route JWT is signed with TEST_SECRET; SECRET_KEY must match
        // for readSessionFromRequest to verify it.
        process.env.SECRET_KEY = TEST_SECRET;
        // Build the store bundle FRESH against the live DATABASE_URL so the
        // routes (which read process.env) and this test share the SAME
        // Postgres-backed stores. Any prior in-memory bundle cached by an
        // earlier offline test must be dropped first.
        resetStoresForTests();
        await closeDb();
        // Clean slate: remove any residue from a previous (possibly crashed)
        // run BEFORE seeding so the test is idempotent.
        await wipeStudent(STUDENT_ID);
    }, 120_000); // live Neon round-trips over WebSocket are slow — generous hook timeout.

    afterAll(async () => {
        // Leave NO residue in the real DB.
        await wipeStudent(STUDENT_ID);
        await closeDb();
        resetStoresForTests();
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
    }, 120_000);

    it("propose→confirm persists supersede-then-insert, routes restore, round-trips prefs + audit_log", async () => {
        const db = getDb(process.env);
        expect(db).not.toBeNull();
        if (!db) return;

        const stores = getStores(process.env);
        // Sanity: we are NOT on the in-memory fallback. If this fails the
        // env/cache wiring is wrong and every assertion below is moot.
        expect(stores.profileStore).not.toBeInstanceOf(InMemoryProfileStore);

        // ---- Seed: profile (+ parsed DPR + audit_log row) then a prior
        //      valid forward_schedule (the "prior live" row to supersede). ----
        const dpr = makeDpr();
        const seedConfirmedAt = new Date().toISOString();
        await stores.profileStore.persistMutation(
            makeProfile(STUDENT_ID),
            {
                pendingMutationId: "e2e-seed-mutation",
                field: "homeSchool",
                before: null,
                after: "cas",
                confirmedAt: seedConfirmedAt,
            },
            dpr,
        );
        await stores.scheduleStore.persistSchedule(
            STUDENT_ID,
            makeSeedSchedule(STUDENT_ID),
            computeDprFingerprint(dpr),
        );

        // The seed wrote an audit_log row — assert it round-trips (5, part a).
        const seedAudit = await db
            .select({ field: auditLog.field, after: auditLog.after })
            .from(auditLog)
            .where(eq(auditLog.studentId, STUDENT_ID));
        expect(seedAudit.length).toBe(1);
        expect(seedAudit[0]!.field).toBe("homeSchool");

        // Capture the prior live forward_schedules row id so we can assert it
        // gets superseded by the confirm below.
        const priorLive = await db
            .select({ id: forwardSchedules.id })
            .from(forwardSchedules)
            .where(
                and(
                    eq(forwardSchedules.studentId, STUDENT_ID),
                    isNull(forwardSchedules.supersededAt),
                ),
            );
        expect(priorLive.length).toBe(1);
        const priorRowId = priorLive[0]!.id;

        const token = await issueTestToken(STUDENT_ID);

        // ---- Stage 1: propose via /api/plan/add (mints a pendingMutationId,
        //      stages it into the LIVE `pending_mutations` table — the first
        //      live exercise of PostgresPendingMutationStore). ----
        const { POST: addPOST } = await import("../app/api/plan/add/route");
        const addRes = await addPOST(
            fakeRequest(token, { courseId: "CSCI-UA 480", term: "2026-fall" }) as never,
        );
        expect(addRes.status).toBe(200);
        const addJson = await addRes.json();
        const pendingMutationId: string = addJson.pendingMutationId;
        expect(pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);

        // The staged proposal is a REAL row in the live pending_mutations table.
        const staged = await db
            .select({ id: pendingMutations.pendingMutationId, studentId: pendingMutations.studentId })
            .from(pendingMutations)
            .where(eq(pendingMutations.pendingMutationId, pendingMutationId));
        expect(staged.length).toBe(1);
        expect(staged[0]!.studentId).toBe(STUDENT_ID);

        // ---- Stage 2: confirm via /api/plan/confirm → applies through
        //      finalizeForwardSchedule + runGraduationPathValidator and
        //      persists (supersede-then-insert). ----
        const { POST: confirmPOST } = await import("../app/api/plan/confirm/route");
        const confirmRes = await confirmPOST(
            fakeRequest(token, { pendingMutationId }) as never,
        );
        expect(confirmRes.status).toBe(200);
        const confirmJson = await confirmRes.json();
        expect(confirmJson.consumedMutationId).toBe(pendingMutationId);
        // Decision #32 — a valid plan lands in forwardSchedule, an
        // infeasible/draft one in studentDraftPlan. The seed DPR is minimal,
        // so accept EITHER slot — the load-bearing assertion is that restore
        // routes the persisted plan to the SAME slot the confirm reported.
        const storedIn: "forwardSchedule" | "studentDraftPlan" = confirmJson.storedIn;
        expect(storedIn).toMatch(/^(forwardSchedule|studentDraftPlan)$/);

        // (single-use) the staged pending_mutations row was CONSUMED on confirm.
        const afterTake = await db
            .select({ id: pendingMutations.pendingMutationId })
            .from(pendingMutations)
            .where(eq(pendingMutations.pendingMutationId, pendingMutationId));
        expect(afterTake.length).toBe(0);

        // ---- (3) supersede-then-insert: exactly ONE live row (the new one),
        //      and the prior row is now superseded. ----
        const liveRows = await db
            .select({ id: forwardSchedules.id, state: forwardSchedules.state })
            .from(forwardSchedules)
            .where(
                and(
                    eq(forwardSchedules.studentId, STUDENT_ID),
                    isNull(forwardSchedules.supersededAt),
                ),
            );
        expect(liveRows.length).toBe(1);
        const newLiveRowId = liveRows[0]!.id;
        expect(newLiveRowId).not.toBe(priorRowId);

        const priorRowAfter = await db
            .select({ supersededAt: forwardSchedules.supersededAt })
            .from(forwardSchedules)
            .where(eq(forwardSchedules.id, priorRowId));
        expect(priorRowAfter.length).toBe(1);
        expect(priorRowAfter[0]!.supersededAt).not.toBeNull();

        // ---- (4) restore routes the confirmed plan to the correct Decision-#32
        //      slot (valid → forwardSchedule, draft → studentDraftPlan). ----
        const { GET: restoreGET } = await import("../app/api/session/restore/route");
        const restoreRes = await restoreGET(fakeRequest(token, undefined) as never);
        expect(restoreRes.status).toBe(200);
        const restoreJson = await restoreRes.json();
        expect(restoreJson.profile).not.toBeNull();
        if (storedIn === "forwardSchedule") {
            expect(restoreJson.forwardSchedule).not.toBeNull();
            expect(restoreJson.studentDraftPlan).toBeNull();
        } else {
            expect(restoreJson.studentDraftPlan).not.toBeNull();
            // The seed's valid forwardSchedule was superseded by the draft
            // apply, so the live slot resolves to the draft only.
            expect(restoreJson.forwardSchedule).toBeNull();
        }

        // ---- (5) schedule_preferences round-trips. confirm_plan_change wrote
        //      a prefs row (the `add` becomes a pin in schedulePreferences);
        //      restore reads it back. Also assert a direct read returns a row. ----
        const prefsRows = await db
            .select({ studentId: schedulePreferences.studentId })
            .from(schedulePreferences)
            .where(eq(schedulePreferences.studentId, STUDENT_ID));
        expect(prefsRows.length).toBe(1);
        expect(restoreJson.schedulePreferences).not.toBeNull();

        // Explicit prefs persist → read-back round-trip through the store
        // (independent of what confirm wrote) to pin the contract.
        await stores.scheduleStore.persistPreferences(STUDENT_ID, { loadStyle: "frontload" });
        const reread = await stores.scheduleStore.loadPreferences(STUDENT_ID);
        expect(reread).toEqual({ loadStyle: "frontload" });

        // ---- audit_log still has exactly the seed row (the plan confirm does
        //      NOT write audit_log — that table records PROFILE mutations). ----
        const auditAfter = await db
            .select({ id: auditLog.id })
            .from(auditLog)
            .where(eq(auditLog.studentId, STUDENT_ID));
        expect(auditAfter.length).toBe(1);
    }, 120_000); // live Neon round-trips are slow (~20s) — bake the timeout in so a
    //              plain `npx vitest run` (no --testTimeout flag) still passes.
});
