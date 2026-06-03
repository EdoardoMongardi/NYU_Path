// ============================================================
// /api/plan/confirm (Phase 17 Task B) — route tests
// ============================================================
// Applies a previously-staged plan mutation by `pendingMutationId`.
// Single-use: a confirmed id is dropped from the staging map; a
// second confirm of the same id returns 404. Cross-tenant ids
// return 403.
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    fakeRequest,
    issueTestToken,
    seedStudentState,
    TEST_SECRET,
} from "./_planRouteTestUtils";
import { resetStoresForTests, getStores } from "../lib/db/store";
import { _resetPendingMutationsForTests } from "../lib/planActionOrchestrator";
import { _clearBuckets } from "../lib/rateLimit";
import { InMemoryScheduleStore } from "@nyupath/engine";

describe("/api/plan/confirm (Phase 17 Task B)", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    const ORIGINAL_DB_URL = process.env.DATABASE_URL;

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        process.env.SECRET_KEY = TEST_SECRET;
        resetStoresForTests();
        _resetPendingMutationsForTests();
        _clearBuckets();
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

    it("returns 401 when the request has no session cookie", async () => {
        const { POST } = await import("../app/api/plan/confirm/route");
        const res = await POST(fakeRequest(undefined, {
            pendingMutationId: "00000000-0000-4000-8000-000000000000",
        }) as never);
        expect(res.status).toBe(401);
    });

    it("returns 400 when pendingMutationId is not a uuid", async () => {
        const studentId = "confirm_bad_uuid";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/confirm/route");
        const res = await POST(fakeRequest(token, { pendingMutationId: "not-a-uuid" }) as never);
        expect(res.status).toBe(400);
    });

    it("returns 404 when the id was never staged", async () => {
        const studentId = "confirm_unknown_id";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/confirm/route");
        const res = await POST(fakeRequest(token, {
            pendingMutationId: "11111111-1111-4111-8111-111111111111",
        }) as never);
        expect(res.status).toBe(404);
    });

    it("returns 403 when the staged id belongs to a different student", async () => {
        const ownerId = "confirm_owner";
        await seedStudentState(ownerId);

        // Owner stages a mutation via /api/plan/add.
        const ownerToken = await issueTestToken(ownerId);
        const { POST: addPOST } = await import("../app/api/plan/add/route");
        const addRes = await addPOST(fakeRequest(ownerToken, {
            courseId: "CSCI-UA 101", term: "2026-fall",
        }) as never);
        const addJson = await addRes.json();

        // Attacker tries to confirm under their own session.
        await seedStudentState("attacker_id");
        const attackerToken = await issueTestToken("attacker_id");
        const { POST: confirmPOST } = await import("../app/api/plan/confirm/route");
        const res = await confirmPOST(fakeRequest(attackerToken, {
            pendingMutationId: addJson.pendingMutationId,
        }) as never);
        expect(res.status).toBe(403);
    });

    it("applies the staged mutation and updates the persisted schedule on a clean confirm", async () => {
        const studentId = "confirm_happy_path";
        await seedStudentState(studentId);
        const stores = getStores({});
        const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
        const before = await scheduleStore.loadLatestSchedule(studentId);

        // Stage via /api/plan/add.
        const token = await issueTestToken(studentId);
        const { POST: addPOST } = await import("../app/api/plan/add/route");
        const addRes = await addPOST(fakeRequest(token, {
            courseId: "CSCI-UA 101", term: "2026-fall",
        }) as never);
        const addJson = await addRes.json();
        expect(addJson.pendingMutationId).toMatch(/^[0-9a-f-]{36}$/);

        // Confirm.
        const { POST: confirmPOST } = await import("../app/api/plan/confirm/route");
        const res = await confirmPOST(fakeRequest(token, {
            pendingMutationId: addJson.pendingMutationId,
        }) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.consumedMutationId).toBe(addJson.pendingMutationId);
        expect(json.storedIn).toMatch(/forwardSchedule|studentDraftPlan/);

        // The persisted schedule was rewritten (computedAt advanced).
        const after = await scheduleStore.loadLatestSchedule(studentId);
        expect(after?.schedule.computedAt).not.toBe(before?.schedule.computedAt);
    });

    it("a second confirm of the same id returns 404 (single-use semantics)", async () => {
        const studentId = "confirm_single_use";
        await seedStudentState(studentId);

        const token = await issueTestToken(studentId);
        const { POST: addPOST } = await import("../app/api/plan/add/route");
        const addRes = await addPOST(fakeRequest(token, {
            courseId: "CSCI-UA 101", term: "2026-fall",
        }) as never);
        const addJson = await addRes.json();

        const { POST: confirmPOST } = await import("../app/api/plan/confirm/route");
        const first = await confirmPOST(fakeRequest(token, { pendingMutationId: addJson.pendingMutationId }) as never);
        expect(first.status).toBe(200);

        const second = await confirmPOST(fakeRequest(token, { pendingMutationId: addJson.pendingMutationId }) as never);
        expect(second.status).toBe(404);
    });
});
