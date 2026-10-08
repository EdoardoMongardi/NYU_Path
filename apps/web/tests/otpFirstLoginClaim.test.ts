// ============================================================
// First-login claim — never inherit a row nobody ever logged in to
// ============================================================
// Before PR #58 the chat v2 route took `body.userId` from cookie-less
// callers, so anyone could create a `students` row (profile, parsed_dpr,
// chat, summaries, schedules) under a NetID that had never logged in. The
// first real OTP login then ADOPTED it via `onConflictDoUpdate({ email })`.
//
// verifyOtp now claims the row through `claimStudentRow`:
//   - no row                                     → create
//   - row already claimed (email set)            → adopt (returning student)
//   - email-less row + the id HAS logged in       → adopt (self-serve delete /
//     test-clear keeps the cookie, so re-onboarding re-creates the row
//     without an email — that data is the student's own)
//   - email-less row + the id NEVER logged in     → reset: delete the row
//     (children cascade) and insert a fresh one
//
// No live DB in CI, so the I/O cases use a call-recording stub (the
// scheduleStorePostgres.test.ts pattern). The live cascade semantics are
// covered by the DATABASE_URL-gated case in otpLoginSmoke.test.ts.
// ============================================================

import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { students, emailOtps } from "../lib/db/schema";
import type { Database } from "../lib/db/client";
import { decideLoginClaim, claimStudentRow } from "../lib/auth/claimStudentRow";
import { TEST_SECRET } from "./_planRouteTestUtils";

// ---- call-recording stub ----
// Every builder method returns `this`; awaiting a chain resolves to the
// next queued result when the chain began with `select`, else undefined.
interface Call { op: string; args: unknown[] }

class StubDb {
    readonly calls: Call[] = [];
    private readonly selectResults: unknown[][] = [];
    private chainIsSelect = false;

    queueSelect(...results: unknown[][]): this {
        this.selectResults.push(...results);
        return this;
    }
    private rec(op: string, args: unknown[]): this {
        this.calls.push({ op, args });
        return this;
    }
    select(...a: unknown[]): this { this.chainIsSelect = true; return this.rec("select", a); }
    insert(...a: unknown[]): this { this.chainIsSelect = false; return this.rec("insert", a); }
    update(...a: unknown[]): this { this.chainIsSelect = false; return this.rec("update", a); }
    delete(...a: unknown[]): this { this.chainIsSelect = false; return this.rec("delete", a); }
    from(...a: unknown[]): this { return this.rec("from", a); }
    where(...a: unknown[]): this { return this.rec("where", a); }
    orderBy(...a: unknown[]): this { return this.rec("orderBy", a); }
    limit(...a: unknown[]): this { return this.rec("limit", a); }
    for(...a: unknown[]): this { return this.rec("for", a); }
    values(...a: unknown[]): this { return this.rec("values", a); }
    set(...a: unknown[]): this { return this.rec("set", a); }
    onConflictDoUpdate(...a: unknown[]): this { return this.rec("onConflictDoUpdate", a); }
    then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown): Promise<unknown> {
        const result = this.chainIsSelect ? (this.selectResults.shift() ?? []) : undefined;
        this.chainIsSelect = false;
        return Promise.resolve(result).then(onFulfilled, onRejected);
    }
    async transaction<T>(cb: (tx: this) => Promise<T>): Promise<T> {
        this.calls.push({ op: "transaction-begin", args: [] });
        const out = await cb(this);
        this.calls.push({ op: "transaction-commit", args: [] });
        return out;
    }
    asDb(): Database { return this as unknown as Database; }

    /** Ops recorded between transaction-begin and transaction-commit. */
    txOps(): string[] {
        const b = this.calls.findIndex((c) => c.op === "transaction-begin");
        const e = this.calls.findIndex((c) => c.op === "transaction-commit");
        return b < 0 || e < 0 ? [] : this.calls.slice(b + 1, e).map((c) => c.op);
    }
    deletedTables(): unknown[] {
        return this.calls.filter((c) => c.op === "delete").map((c) => c.args[0]);
    }
}

const STUDENT_ID = "ab1234";
const EMAIL = "ab1234@nyu.edu";
const CURRENT_OTP = { email: EMAIL, issuedAt: new Date("2026-10-06T12:00:00Z") };

describe("decideLoginClaim", () => {
    it("creates a row when none exists", () => {
        expect(decideLoginClaim(null, false)).toBe("create");
    });

    it("adopts a row that a login already claimed", () => {
        expect(decideLoginClaim({ email: EMAIL }, true)).toBe("adopt");
    });

    it("adopts an email-less row when the id has logged in before (re-created after self-delete)", () => {
        expect(decideLoginClaim({ email: null }, true)).toBe("adopt");
    });

    it("resets an email-less row when the id has never logged in (planted)", () => {
        expect(decideLoginClaim({ email: null }, false)).toBe("reset");
    });
});

describe("claimStudentRow", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        warn.mockRestore();
    });

    it("resets a never-claimed row: deletes it (children cascade) and inserts a fresh claimed row, in one transaction", async () => {
        const db = new StubDb().queueSelect([{ email: null }], []);

        const outcome = await claimStudentRow(db.asDb(), { studentId: STUDENT_ID, email: EMAIL, currentOtp: CURRENT_OTP });

        expect(outcome).toBe("reset");
        expect(db.deletedTables()).toEqual([students]);
        const ops = db.txOps();
        expect(ops.indexOf("delete")).toBeGreaterThan(-1);
        expect(ops.indexOf("insert")).toBeGreaterThan(ops.indexOf("delete"));
        const inserted = db.calls.find((c) => c.op === "values")?.args[0];
        expect(inserted).toEqual({ studentId: STUDENT_ID, email: EMAIL });
        // a fresh row, not an upsert onto the old one
        expect(ops).not.toContain("onConflictDoUpdate");
        // the operator can see it happened
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(STUDENT_ID));
    });

    it("locks the students row before deciding", async () => {
        const db = new StubDb().queueSelect([{ email: null }], []);
        await claimStudentRow(db.asDb(), { studentId: STUDENT_ID, email: EMAIL, currentOtp: CURRENT_OTP });
        expect(db.calls.find((c) => c.op === "for")?.args[0]).toBe("update");
    });

    it("keeps an email-less row whose id has a prior verified login", async () => {
        const db = new StubDb().queueSelect([{ email: null }], [{ one: 1 }]);

        const outcome = await claimStudentRow(db.asDb(), { studentId: STUDENT_ID, email: EMAIL, currentOtp: CURRENT_OTP });

        expect(outcome).toBe("adopt");
        expect(db.deletedTables()).toEqual([]);
        expect(db.txOps()).toContain("onConflictDoUpdate");
        expect(warn).not.toHaveBeenCalled();
    });

    it("adopts an already-claimed row without checking login history or deleting", async () => {
        const db = new StubDb().queueSelect([{ email: EMAIL }]);

        const outcome = await claimStudentRow(db.asDb(), { studentId: STUDENT_ID, email: EMAIL, currentOtp: CURRENT_OTP });

        expect(outcome).toBe("adopt");
        expect(db.deletedTables()).toEqual([]);
        expect(db.calls.filter((c) => c.op === "select")).toHaveLength(1);
    });

    it("creates a row when none exists", async () => {
        const db = new StubDb().queueSelect([]);

        const outcome = await claimStudentRow(db.asDb(), { studentId: STUDENT_ID, email: EMAIL, currentOtp: CURRENT_OTP });

        expect(outcome).toBe("create");
        expect(db.deletedTables()).toEqual([]);
        expect(db.calls.find((c) => c.op === "values")?.args[0]).toMatchObject({ studentId: STUDENT_ID, email: EMAIL });
    });
});

// ---- verifyOtp wiring ----
const dbRef: { current: StubDb | null } = { current: null };
vi.mock("../lib/db/client", () => ({
    getDb: () => dbRef.current,
}));

describe("verifyOtp — first-login claim wiring", () => {
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        process.env.SECRET_KEY = TEST_SECRET;
        warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
        warn.mockRestore();
        dbRef.current = null;
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
    });

    function otpRow(code: string) {
        return {
            email: EMAIL,
            codeHash: createHash("sha256").update(code).digest("hex"),
            issuedAt: CURRENT_OTP.issuedAt,
            expiresAt: new Date(Date.now() + 60_000),
            consumedAt: null,
        };
    }

    it("resets a planted never-claimed row on the NetID's first login instead of adopting it", async () => {
        const { verifyOtp } = await import("../lib/auth/otp");
        // 1) the pending OTP row  2) the planted email-less students row
        // 3) no prior verified login for the id
        dbRef.current = new StubDb().queueSelect([otpRow("123456")], [{ email: null }], []);

        const res = await verifyOtp(EMAIL, "123456", process.env);

        expect(res.ok).toBe(true);
        expect(res.studentId).toBe(STUDENT_ID);
        expect(dbRef.current.deletedTables()).toEqual([students]);
        // the OTP is still consumed exactly as before
        expect(dbRef.current.calls.find((c) => c.op === "update")?.args[0]).toBe(emailOtps);
    });

    it("adopts the row for a returning student", async () => {
        const { verifyOtp } = await import("../lib/auth/otp");
        dbRef.current = new StubDb().queueSelect([otpRow("654321")], [{ email: EMAIL }]);

        const res = await verifyOtp(EMAIL, "654321", process.env);

        expect(res.ok).toBe(true);
        expect(dbRef.current.deletedTables()).toEqual([]);
    });
});
