// ============================================================
// OTP login subject namespacing (PR #58 review finding 4)
// ============================================================
// The JWT `sub` is the studentId every durable row keys on. It used to
// be the email's local-part for EVERY allowed email, so an operator-
// allowlisted non-NYU address (AUTH_TEST_EMAILS, e.g. abc123@gmail.com)
// signed in as "abc123" — the same subject as the NYU student
// abc123@nyu.edu — and read/wrote that student's rows.
//
// Now only an @nyu.edu address yields a bare NetID subject; any other
// allowlisted address is namespaced as "test:<full lower-cased email>",
// which can never equal a NetID. verifyOtp also releases the email from
// any other `students` row before its upsert, so the unique `email`
// column can't lock out an account whose subject changed.
// ============================================================

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeJwt } from "jose";
import { emailToStudentId } from "../lib/auth/otp";

const TEST_SECRET = "test-secret-for-otp-namespace-tests-32+++++++";

describe("emailToStudentId", () => {
    it("maps an @nyu.edu address to its bare NetID", () => {
        expect(emailToStudentId("abc123@nyu.edu")).toBe("abc123");
        expect(emailToStudentId("ABC123@NYU.EDU")).toBe("abc123");
    });

    it("namespaces a non-NYU allowlisted address with the full email", () => {
        expect(emailToStudentId("abc123@gmail.com")).toBe("test:abc123@gmail.com");
        expect(emailToStudentId("Abc123@Gmail.com")).toBe("test:abc123@gmail.com");
    });

    it("treats an NYU subdomain as non-NYU (only exactly @nyu.edu is a NetID)", () => {
        expect(emailToStudentId("abc123@stern.nyu.edu")).toBe("test:abc123@stern.nyu.edu");
    });

    it("never gives an allowlisted address the subject of the same-named NYU student", () => {
        expect(emailToStudentId("abc123@gmail.com")).not.toBe(emailToStudentId("abc123@nyu.edu"));
    });
});

// ---- verifyOtp against a recording stub DB ----

type Op =
    | { op: "update"; table: unknown; set?: Record<string, unknown> }
    | { op: "insert"; table: unknown; values?: Record<string, unknown>; conflictSet?: Record<string, unknown> };

class StubDb {
    readonly ops: Op[] = [];
    constructor(private readonly pendingOtpRows: unknown[]) {}
    select() {
        const rows = this.pendingOtpRows;
        const chain = {
            from: () => chain,
            where: () => chain,
            orderBy: () => chain,
            limit: async () => rows,
        };
        return chain;
    }
    update(table: unknown) {
        const rec: Op = { op: "update", table };
        this.ops.push(rec);
        const chain = {
            set: (v: Record<string, unknown>) => {
                (rec as { set?: Record<string, unknown> }).set = v;
                return chain;
            },
            where: async () => undefined,
        };
        return chain;
    }
    insert(table: unknown) {
        const rec: Op = { op: "insert", table };
        this.ops.push(rec);
        const chain = {
            values: (v: Record<string, unknown>) => {
                (rec as { values?: Record<string, unknown> }).values = v;
                return chain;
            },
            onConflictDoUpdate: async (c: { set: Record<string, unknown> }) => {
                (rec as { conflictSet?: Record<string, unknown> }).conflictSet = c.set;
            },
        };
        return chain;
    }
    async transaction<T>(cb: (tx: this) => Promise<T>): Promise<T> {
        return cb(this);
    }
}

function pendingOtpRow(email: string, code: string): Record<string, unknown> {
    const now = Date.now();
    return {
        email,
        codeHash: createHash("sha256").update(code).digest("hex"),
        issuedAt: new Date(now - 1000),
        expiresAt: new Date(now + 5 * 60 * 1000),
        consumedAt: null,
    };
}

async function loadWithStub(stub: StubDb) {
    vi.resetModules();
    vi.doMock("../lib/db/client", () => ({ getDb: () => stub }));
    const otp = await import("../lib/auth/otp");
    const schema = await import("../lib/db/schema");
    return { verifyOtp: otp.verifyOtp, schema };
}

describe("verifyOtp subject + students upsert", () => {
    afterEach(() => {
        vi.doUnmock("../lib/db/client");
        vi.resetModules();
    });

    it("signs an allowlisted non-NYU login as test:<email>, never the colliding NetID", async () => {
        const email = "abc123@gmail.com";
        const stub = new StubDb([pendingOtpRow(email, "123456")]);
        const { verifyOtp, schema } = await loadWithStub(stub);

        const res = await verifyOtp(email, "123456", {
            AUTH_TEST_EMAILS: email,
            SECRET_KEY: TEST_SECRET,
        });

        expect(res.ok).toBe(true);
        expect(res.studentId).toBe("test:abc123@gmail.com");
        expect(decodeJwt(res.token!).sub).toBe("test:abc123@gmail.com");

        const studentInsert = stub.ops.find(
            (o): o is Extract<Op, { op: "insert" }> => o.op === "insert" && o.table === schema.students,
        );
        expect(studentInsert?.values?.studentId).toBe("test:abc123@gmail.com");
        expect(studentInsert?.values?.email).toBe(email);
    });

    it("releases the email from any other students row before the upsert (unique email can't lock the login out)", async () => {
        const email = "abc123@gmail.com";
        const stub = new StubDb([pendingOtpRow(email, "123456")]);
        const { verifyOtp, schema } = await loadWithStub(stub);

        await verifyOtp(email, "123456", { AUTH_TEST_EMAILS: email, SECRET_KEY: TEST_SECRET });

        const releaseIdx = stub.ops.findIndex(
            (o) => o.op === "update" && o.table === schema.students && o.set?.email === null,
        );
        const insertIdx = stub.ops.findIndex((o) => o.op === "insert" && o.table === schema.students);
        expect(releaseIdx).toBeGreaterThanOrEqual(0);
        expect(insertIdx).toBeGreaterThan(releaseIdx);
    });

    it("still signs an @nyu.edu login as the bare NetID", async () => {
        const email = "abc123@nyu.edu";
        const stub = new StubDb([pendingOtpRow(email, "654321")]);
        const { verifyOtp } = await loadWithStub(stub);

        const res = await verifyOtp(email, "654321", { SECRET_KEY: TEST_SECRET });

        expect(res.ok).toBe(true);
        expect(res.studentId).toBe("abc123");
        expect(decodeJwt(res.token!).sub).toBe("abc123");
    });
});
