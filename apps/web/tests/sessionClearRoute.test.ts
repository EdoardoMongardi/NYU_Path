// ============================================================
// Phase 16 Task B — /api/session/clear route tests
// ============================================================
// Three behaviors exercised:
//   - env-flag NOT set → 403 regardless of auth
//   - env-flag set + no auth → 401
//   - env-flag set + auth → cascade DELETE across the
//     per-student rows. We use a stub Database to verify the SQL
//     pattern; the in-memory mode short-circuits with a 200 OK.
// ============================================================

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import {
    students,
    forwardSchedules,
    schedulePreferences,
    chatMessages,
    auditLog,
    sessionSummaries,
} from "../lib/db/schema";
import { SESSION_COOKIE } from "../lib/auth/session";
import { resetStoresForTests } from "../lib/db/store";

const TEST_SECRET = "test-secret-for-session-clear-route-tests-32+++";

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

describe("/api/session/clear (Phase 16 Task B)", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    const ORIGINAL_DB_URL = process.env.DATABASE_URL;
    const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR;

    beforeEach(() => {
        delete process.env.DATABASE_URL;
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

    it("returns 403 when NEXT_PUBLIC_ENABLE_TEST_CLEAR is not set, regardless of auth", async () => {
        delete process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR;
        const { DELETE } = await import("../app/api/session/clear/route");
        const token = await issueTestToken("student_x");
        const res = await DELETE(fakeRequest(token) as never);
        expect(res.status).toBe(403);
        const json = await res.json();
        expect(json.error).toMatch(/Forbidden/i);
    });

    it("returns 401 when the env flag IS set but no auth cookie is supplied", async () => {
        process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR = "1";
        const { DELETE } = await import("../app/api/session/clear/route");
        const res = await DELETE(fakeRequest() as never);
        expect(res.status).toBe(401);
        const json = await res.json();
        expect(json.error).toMatch(/Unauthorized/i);
    });

    it("returns 200 OK in in-memory mode (no DB) when both flag + auth are present", async () => {
        process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR = "1";
        const { DELETE } = await import("../app/api/session/clear/route");
        const token = await issueTestToken("student_y");
        const res = await DELETE(fakeRequest(token) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.ok).toBe(true);
    });

    it("opens a transaction and deletes from every per-student table for the authenticated student (DB mode)", async () => {
        process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR = "1";

        // ---- Stub the DB module so DELETE can reach Postgres-mode
        //      without needing a live connection. ----
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

        // Mock the client.ts module so getDb returns the stub.
        vi.doMock("../lib/db/client", () => ({
            getDb: () => new StubDb(),
        }));
        // The route also imports getStores → which itself imports client.
        // Re-import via vi.resetModules so our mock is picked up. Also
        // re-import the schema so the table identity comparisons in the
        // assertions below match what the route's freshly-imported schema
        // returns (otherwise top-level schema imports vs. route schema
        // imports are different module instances after resetModules).
        vi.resetModules();
        const schemaFresh = await import("../lib/db/schema");

        const { DELETE } = await import("../app/api/session/clear/route");
        const token = await issueTestToken("student_z");
        const res = await DELETE(fakeRequest(token) as never);
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json.ok).toBe(true);

        expect(txOpened).toBe(true);
        expect(txCommitted).toBe(true);

        const deletedTables = recordedDeletes.map((r) => (r as { table: unknown }).table);
        // Every per-student table must be hit AND students must be last.
        expect(deletedTables).toContain(schemaFresh.chatMessages);
        expect(deletedTables).toContain(schemaFresh.forwardSchedules);
        expect(deletedTables).toContain(schemaFresh.schedulePreferences);
        expect(deletedTables).toContain(schemaFresh.auditLog);
        expect(deletedTables).toContain(schemaFresh.sessionSummaries);
        expect(deletedTables).toContain(schemaFresh.students);
        expect(deletedTables[deletedTables.length - 1]).toBe(schemaFresh.students);

        vi.doUnmock("../lib/db/client");
    });
});
