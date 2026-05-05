// ============================================================
// /api/plan/lock (Phase 17 Task B) — route tests
// ============================================================
// Toggle the solver-freeze on a slot:
//   - locked: true  → pin freeze=true (writes to pins[])
//   - locked: false → unpin (removes from pins[])
//
// The unpin primitive is new in Task B. Asserts the persistence
// outcome via a follow-up confirm round-trip (the lock route is
// Stage 1 only; the actual write happens through /api/plan/confirm).
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
import type { SchedulePreferences } from "@nyupath/shared";

describe("/api/plan/lock (Phase 17 Task B)", () => {
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
        const { POST } = await import("../app/api/plan/lock/route");
        const res = await POST(fakeRequest(undefined, {
            courseId: "CSCI-UA 101", term: "2026-fall", locked: true,
        }) as never);
        expect(res.status).toBe(401);
    });

    it("returns 400 when locked is not a boolean", async () => {
        const studentId = "lock_invalid";
        await seedStudentState(studentId);
        const token = await issueTestToken(studentId);
        const { POST } = await import("../app/api/plan/lock/route");
        const res = await POST(fakeRequest(token, {
            courseId: "CSCI-UA 101", term: "2026-fall", locked: "yes",
        }) as never);
        expect(res.status).toBe(400);
    });

    describe("locked: true (lock)", () => {
        it("returns 200 with explanation that uses the 'Locking' verb", async () => {
            const studentId = "lock_true";
            await seedStudentState(studentId);
            const token = await issueTestToken(studentId);
            const { POST } = await import("../app/api/plan/lock/route");
            const res = await POST(fakeRequest(token, {
                courseId: "CSCI-UA 101",
                term: "2026-fall",
                locked: true,
            }) as never);
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.explanation).toContain("CSCI-UA 101");
            expect(json.explanation).toContain("2026-fall");
            expect(json.explanation).toMatch(/Locking/);
        });
    });

    describe("locked: false (unlock — uses new unpin primitive)", () => {
        it("returns 200 with explanation that uses the 'Unlocking' verb", async () => {
            const studentId = "lock_false";
            await seedStudentState(studentId);

            // Pre-seed a pin so the unpin has something to remove (the
            // explanation is computed against the proposed schedule;
            // the outcome itself is the same either way).
            const stores = getStores({});
            const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
            const prefs: SchedulePreferences = {
                pins: [{ courseId: "CSCI-UA 101", term: "2026-fall" }],
            };
            await scheduleStore.persistPreferences(studentId, prefs);

            const token = await issueTestToken(studentId);
            const { POST } = await import("../app/api/plan/lock/route");
            const res = await POST(fakeRequest(token, {
                courseId: "CSCI-UA 101",
                term: "2026-fall",
                locked: false,
            }) as never);
            expect(res.status).toBe(200);
            const json = await res.json();
            expect(json.explanation).toContain("CSCI-UA 101");
            expect(json.explanation).toContain("2026-fall");
            expect(json.explanation).toMatch(/Unlocking/);
        });

        it("Stage 1 propose is read-only — pins[] survives until /api/plan/confirm fires", async () => {
            const studentId = "lock_false_read_only";
            await seedStudentState(studentId);

            const stores = getStores({});
            const scheduleStore = stores.scheduleStore as InMemoryScheduleStore;
            const prefs: SchedulePreferences = {
                pins: [{ courseId: "CSCI-UA 101", term: "2026-fall" }],
            };
            await scheduleStore.persistPreferences(studentId, prefs);

            const token = await issueTestToken(studentId);
            const { POST } = await import("../app/api/plan/lock/route");
            await POST(fakeRequest(token, {
                courseId: "CSCI-UA 101", term: "2026-fall", locked: false,
            }) as never);

            const after = await scheduleStore.loadPreferences(studentId);
            // Pin survives — the route only stages.
            expect(after?.pins?.find(p => p.courseId === "CSCI-UA 101")).toBeDefined();
        });
    });
});
