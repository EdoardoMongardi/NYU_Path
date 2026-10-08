// ============================================================
// verifyOtp — per-code attempt budget + single-use (offline)
// ============================================================
// The OTP flow is the only way to mint a `nyupath_session` cookie, so a
// 6-digit code must not be guessable for its whole 10-minute TTL. These
// tests pin the durable (DB-side) guard:
//   - every verify reserves one attempt on the pending row BEFORE the
//     code is compared, and the row is dead after 5 attempts,
//   - burning the newest code does not re-open an older pending one,
//   - two concurrent correct submissions mint only one session.
//
// `getDb` is replaced by a fake `email_otps` table. The fake does not
// trust the code under test: it renders each WHERE clause with drizzle's
// PgDialect and evaluates the resulting `"email_otps"."col" <op> $n`
// conditions itself, and throws on any condition it cannot evaluate. So
// a missing `consumed_at is null` or `attempts < 5` makes a test fail
// rather than pass silently. Real Postgres semantics are covered by the
// live-Neon smoke test (otpLoginSmoke.test.ts).
// ============================================================

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { emailOtps } from "../lib/db/schema";
import { TEST_SECRET } from "./_planRouteTestUtils";

interface FakeOtpRow {
    email: string;
    codeHash: string;
    issuedAt: Date;
    expiresAt: Date;
    consumedAt: Date | null;
    attempts: number;
}

const COLUMN: Record<string, keyof FakeOtpRow> = {
    email: "email",
    code_hash: "codeHash",
    issued_at: "issuedAt",
    expires_at: "expiresAt",
    consumed_at: "consumedAt",
    attempts: "attempts",
};

const dialect = new PgDialect();
const CONDITION_RE = /"email_otps"\."(\w+)" (=|<|>|is null)(?: \$(\d+))?/g;

function comparable(v: unknown): number | string | null {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return Date.parse(v);
    return v as number | string;
}

/** Compile a drizzle WHERE into a row predicate, refusing anything it can't evaluate. */
function compileWhere(where: unknown): (row: FakeOtpRow) => boolean {
    const { sql, params } = dialect.sqlToQuery(where as SQL);
    const leftover = sql.replace(CONDITION_RE, "").replace(/\band\b|[()\s]/g, "");
    if (leftover !== "") throw new Error(`fake email_otps: unsupported WHERE: ${sql}`);
    const preds = [...sql.matchAll(CONDITION_RE)].map(([, col, op, idx]) => {
        const key = COLUMN[col!];
        if (!key) throw new Error(`fake email_otps: unknown column ${col}`);
        const param = idx ? comparable(params[Number(idx) - 1]) : null;
        return (row: FakeOtpRow) => {
            const v = comparable(row[key]);
            if (op === "is null") return v === null;
            if (v === null || param === null) return false;
            if (op === "=") return v === param;
            if (op === "<") return v < param;
            return v > param;
        };
    });
    return (row) => preds.every((p) => p(row));
}

class FakeOtpDb {
    rows: FakeOtpRow[] = [];

    select() {
        return {
            from: () => ({
                where: (where: unknown) => ({
                    orderBy: () => ({
                        limit: async (n: number) => {
                            const match = compileWhere(where);
                            return this.rows
                                .filter(match)
                                .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())
                                .slice(0, n)
                                .map((r) => ({ ...r }));
                        },
                    }),
                }),
            }),
        };
    }

    update(table: unknown) {
        if (table !== emailOtps) throw new Error("fake db: only email_otps updates are modeled");
        return {
            set: (patch: Record<string, unknown>) => ({
                where: (where: unknown) => ({
                    returning: async () => {
                        const match = compileWhere(where);
                        const hit = this.rows.filter(match);
                        for (const row of hit) this.applyPatch(row, patch);
                        return hit.map((r) => ({ ...r }));
                    },
                }),
            }),
        };
    }

    private applyPatch(row: FakeOtpRow, patch: Record<string, unknown>): void {
        for (const [key, value] of Object.entries(patch)) {
            if (value instanceof SQL) {
                const rendered = dialect.sqlToQuery(value).sql;
                if (key !== "attempts" || !/"attempts" \+ 1$/.test(rendered)) {
                    throw new Error(`fake email_otps: unsupported SET ${key} = ${rendered}`);
                }
                row.attempts += 1;
            } else {
                (row as unknown as Record<string, unknown>)[key] = value;
            }
        }
    }

    insert(table: unknown) {
        return {
            values: (v: Partial<FakeOtpRow>) => {
                if (table === emailOtps) {
                    this.rows.push({
                        email: v.email!,
                        codeHash: v.codeHash!,
                        issuedAt: v.issuedAt!,
                        expiresAt: v.expiresAt!,
                        consumedAt: null,
                        attempts: 0,
                    });
                }
                // `students` upsert chains `.onConflictDoUpdate(...)`; the
                // email_otps insert is awaited directly.
                return Object.assign(Promise.resolve(), { onConflictDoUpdate: async () => undefined });
            },
        };
    }
}

let fakeDb: FakeOtpDb;
vi.mock("../lib/db/client", () => ({ getDb: () => fakeDb }));

const { issueOtp, verifyOtp } = await import("../lib/auth/otp");

const EMAIL = "otp-attempts@nyu.edu";
const ENV = { RESEND_API_KEY: "__test__", SECRET_KEY: TEST_SECRET };

function wrongCodeFor(code: string): string {
    return code === "000000" ? "000001" : "000000";
}

async function issueCode(): Promise<string> {
    const issued = await issueOtp(EMAIL, ENV);
    expect(issued.ok).toBe(true);
    return issued.debugCode!;
}

beforeEach(() => {
    fakeDb = new FakeOtpDb();
});

describe("verifyOtp attempt budget", () => {
    it("still accepts the right code after 4 wrong guesses", async () => {
        const code = await issueCode();
        for (let i = 0; i < 4; i++) {
            expect((await verifyOtp(EMAIL, wrongCodeFor(code), ENV)).reason).toBe("code_mismatch");
        }
        const ok = await verifyOtp(EMAIL, code, ENV);
        expect(ok.ok).toBe(true);
        expect(ok.token).toBeTruthy();
    });

    it("burns the code after 5 wrong guesses — the right code is then rejected", async () => {
        const code = await issueCode();
        for (let i = 0; i < 5; i++) {
            expect((await verifyOtp(EMAIL, wrongCodeFor(code), ENV)).reason).toBe("code_mismatch");
        }
        const late = await verifyOtp(EMAIL, code, ENV);
        expect(late.ok).toBe(false);
        expect(late.token).toBeUndefined();
        expect(late.reason).toBe("too_many_attempts");
    });

    it("records each attempt on the pending row", async () => {
        const code = await issueCode();
        await verifyOtp(EMAIL, wrongCodeFor(code), ENV);
        await verifyOtp(EMAIL, wrongCodeFor(code), ENV);
        expect(fakeDb.rows[0]!.attempts).toBe(2);
        expect(fakeDb.rows[0]!.consumedAt).toBeNull();
    });

    it("does not fall back to an older pending code once the newest is burned", async () => {
        const olderCode = "111111";
        const now = Date.now();
        fakeDb.rows.push({
            email: EMAIL,
            codeHash: createHash("sha256").update(olderCode).digest("hex"),
            issuedAt: new Date(now - 60_000),
            expiresAt: new Date(now + 9 * 60_000),
            consumedAt: null,
            attempts: 0,
        });
        const newest = await issueCode();
        const wrong = [newest, olderCode].includes("000000") ? "999999" : "000000";
        for (let i = 0; i < 5; i++) await verifyOtp(EMAIL, wrong, ENV);

        const viaOlder = await verifyOtp(EMAIL, olderCode, ENV);
        expect(viaOlder.ok).toBe(false);
        expect(viaOlder.reason).toBe("too_many_attempts");
    });

    it("mints only one session when the right code is submitted twice concurrently", async () => {
        const code = await issueCode();
        const results = await Promise.all([verifyOtp(EMAIL, code, ENV), verifyOtp(EMAIL, code, ENV)]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => r.token)).toHaveLength(1);
    });
});
