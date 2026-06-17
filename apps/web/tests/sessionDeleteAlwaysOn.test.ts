// ============================================================
// Phase 4 Task E6.4 — /api/session/delete route tests
// ============================================================
// The STANDING, always-on authenticated self-serve deletion
// right (vs the env-gated /api/session/clear test affordance).
//
// Behaviors exercised:
//   - no auth → 401 (regardless of env flags)
//   - auth + in-memory mode → 200 OK *with the test-clear flag
//     UNSET* (the key assertion — this route is NOT gated)
//   - auth + DB mode → cascade DELETE across every per-student
//     row (incl. pending_mutations), `students` LAST, all in one
//     transaction — again with the gate flag UNSET. We use a stub
//     Database to verify the SQL pattern offline.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import { SESSION_COOKIE } from "../lib/auth/session";
import { resetStoresForTests } from "../lib/db/store";

const TEST_SECRET = "test-secret-for-session-delete-route-tests-32+++";

async function issueTestToken(sub: string): Promise<string> {
    return new SignJWT({ email: `${sub}@nyu.edu` })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(new TextEncoder().encode(TEST_SECRET));
}

interface FakeRequest {
    cookies?: { get: (name: string) => { value: string } | undefined };
    headers: { get: (name: string) => string | null };
}

function fakeRequest(cookieValue?: string): FakeRequest {
    return {
        cookies: cookieValue
            ? { get: (n: string) => (n === SESSION_COOKIE ? { value: cookieValue } : undefined) }
            : { get: () => undefined },
        headers: { get: () => null },
    };
}

describe("/api/session/delete (Phase 4 Task E6.4 — always-on self-serve deletion)", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    const ORIGINAL_DB_URL = process.env.DATABASE_URL;
    const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR;

    beforeEach(() => {
        delete process.env.DATABASE_URL;
        // Key invariant for this route: the test-clear gate is NOT set.
        // The standing deletion right must work without it.
        delete process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR;
        process.env.SECRET_KEY = TEST_SECRET;
        resetStoresForTests();
        vi.resetModules();
    });
    afterEach(() => {
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
        if (ORIGINAL_DB_URL === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = ORIGINAL_DB_URL;
        if (ORIGINAL_FLAG === undefined) delete process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR;
        else process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR = ORIGINAL_FLAG;
        resetStoresForTests();
    });

    it("returns 401 when no auth cookie is supplied (no env flag needed)", async () => {
        const { DELETE } = await import("../app/api/session/delete/route");
        const res = await DELETE(fakeRequest() as never);
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error).toMatch(/Unauthorized/i);
    });

    it("succeeds (200 OK) in in-memory mode for an authenticated user WITHOUT NEXT_PUBLIC_ENABLE_TEST_CLEAR set", async () => {
        // Explicitly assert the gate is unset — this is the standing right,
        // not the test affordance.
        expect(process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR).toBeUndefined();
        const { DELETE } = await import("../app/api/session/delete/route");
        const token = await issueTestToken("student_delete_y");
        const res = await DELETE(fakeRequest(token) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.ok).toBe(true);
    });

    it("opens a transaction and deletes from every per-student table (incl. pending_mutations) for the authenticated student, students LAST — with NO env gate", async () => {
        // Gate stays unset — proves the route is always-on.
        expect(process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR).toBeUndefined();

        const recordedDeletes: unknown[] = [];
        let txOpened = false;
        let txCommitted = false;

        class StubDb {
            delete(table: unknown) {
                recordedDeletes.push({ op: "delete", table });
                return this;
            }
            where(_clause: unknown) {
                return this;
            }
            then(onFulfilled?: (v: unknown) => unknown) {
                return Promise.resolve(undefined).then(onFulfilled);
            }
            async transaction<T>(cb: (tx: this) => Promise<T>): Promise<T> {
                txOpened = true;
                const r = await cb(this);
                txCommitted = true;
                return r;
            }
        }

        // Force DB mode by stubbing getDb to return the stub regardless of
        // DATABASE_URL, then re-import schema + route under the same module
        // registry so table identities compare equal.
        vi.doMock("../lib/db/client", () => ({
            getDb: () => new StubDb(),
        }));
        vi.resetModules();
        const schemaFresh = await import("../lib/db/schema");

        const { DELETE } = await import("../app/api/session/delete/route");
        const token = await issueTestToken("student_delete_z");
        const res = await DELETE(fakeRequest(token) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.ok).toBe(true);

        expect(txOpened).toBe(true);
        expect(txCommitted).toBe(true);

        const deletedTables = recordedDeletes.map((r) => (r as { table: unknown }).table);
        // Every per-student table must be hit, including pending_mutations.
        expect(deletedTables).toContain(schemaFresh.chatMessages);
        expect(deletedTables).toContain(schemaFresh.forwardSchedules);
        expect(deletedTables).toContain(schemaFresh.schedulePreferences);
        expect(deletedTables).toContain(schemaFresh.auditLog);
        expect(deletedTables).toContain(schemaFresh.sessionSummaries);
        expect(deletedTables).toContain(schemaFresh.pendingMutations);
        expect(deletedTables).toContain(schemaFresh.students);
        // students is the parent row — deleted last.
        expect(deletedTables[deletedTables.length - 1]).toBe(schemaFresh.students);

        vi.doUnmock("../lib/db/client");
    });
});
