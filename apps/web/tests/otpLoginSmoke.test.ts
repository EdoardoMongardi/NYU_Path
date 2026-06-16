// ============================================================
// E6.6 — OTP-login smoke against a LIVE Neon
// ============================================================
// Verifies that email-OTP login round-trips end-to-end once a real
// DATABASE_URL is wired — confirming that "leaving the fallback" is
// sound for AUTH (the companion to E6.5's confirm→persist exit gate).
//
// It exercises the real `issueOtp`/`verifyOtp` seam (apps/web/lib/auth/
// otp.ts) against a REAL Postgres (a Neon branch), rather than any
// offline / in-memory fallback:
//   - issueOtp writes a sha256(code) hash row into the LIVE `email_otps`
//     table; with `RESEND_API_KEY=__test__` it SKIPS the Resend network
//     call and surfaces the code back as `debugCode` (otp.ts:92),
//   - verifyOtp reads the most-recent unconsumed/unexpired row, marks it
//     consumed (single-use), UPSERTS a `students` row, and mints a signed
//     HS256 JWT with `sub: <studentId>` (otp.ts:146-169).
//
// GATING — INVERTED from the offline DB tests, mirroring E6.5. The
// offline DB suites DELETE `process.env.DATABASE_URL` so they run on the
// in-memory / Stub path. This test is the OPPOSITE:
// `describe.skipIf(!process.env.DATABASE_URL)` so it RUNS ONLY when a
// real `DATABASE_URL` is wired and SKIPS in the default `npx vitest run`
// (keeping the offline suite green + at the same pass count, adding
// exactly one SKIPPED test).
//
// SELF-CLEANING — the test uses a FIXED, clearly-test-scoped @nyu.edu
// email (so it passes the NYU-only email validation WITHOUT needing
// AUTH_TEST_EMAILS) whose NetID-prefix studentId is deterministic. It
// wipes BOTH the `email_otps` rows (keyed by email — no FK to students)
// AND the `students` row (keyed by the derived studentId, cascades to
// its children) in BOTH `beforeAll` and `afterAll`. It is idempotent +
// leaves NO residue in the real DB across runs.
//
// HOW TO RUN IT LIVE (controller):
//   1. Provision a Neon branch and apply the Drizzle migrations
//      (`pnpm --filter @nyupath/web db:migrate` — needs 0000..0003 so
//      the `email_otps` + `students` tables exist).
//   2. Export `DATABASE_URL=<neon-branch-connection-string>` for the
//      vitest process. RESEND_API_KEY + SECRET_KEY are set INSIDE the
//      test (the `__test__` sentinel → no real email; a TEST_SECRET so
//      the minted JWT verifies) — no need to export either.
//   3. `cd /…/NYU_Path && DATABASE_URL=… npx vitest run apps/web/tests/otpLoginSmoke.test.ts`
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { issueOtp, verifyOtp } from "../lib/auth/otp";
import { verifySessionToken } from "../lib/auth/session";
import { getDb, closeDb } from "../lib/db/client";
import { resetStoresForTests } from "../lib/db/store";
import { emailOtps, students } from "../lib/db/schema";
import { TEST_SECRET } from "./_planRouteTestUtils";

// A fixed, obviously-test-scoped @nyu.edu address. The `@nyu.edu` domain
// passes `isAllowedEmail` (otp.ts:30) WITHOUT AUTH_TEST_EMAILS; the
// `e2e-otp-smoke` prefix is the deterministic studentId derived by
// `emailToStudentId` (otp.ts:66-70 → local-part before the `@`), kept
// impossible to collide with a real NetID.
const TEST_EMAIL = "e2e-otp-smoke@nyu.edu";
// emailToStudentId(TEST_EMAIL) → the local-part, lower-cased.
const TEST_STUDENT_ID = "e2e-otp-smoke";

/** Hard-delete every row this test could have written for the fixture,
 *  in FK-safe order. `email_otps` has NO FK to `students` (keyed by
 *  (email, issuedAt)) so it must be deleted by email separately; the
 *  `students` row delete cascades to any child rows. Idempotent: safe
 *  to run when nothing exists. */
async function wipeOtpFixture(): Promise<void> {
    const db = getDb(process.env);
    if (!db) return; // gate guarantees a DB, but be defensive.
    await db.transaction(async (tx) => {
        await tx.delete(emailOtps).where(eq(emailOtps.email, TEST_EMAIL));
        await tx.delete(students).where(eq(students.studentId, TEST_STUDENT_ID));
    });
}

// describe.skipIf — RUNS ONLY when a live DATABASE_URL is set; SKIPS in
// the default offline suite (keeping the green count unchanged save for
// one extra SKIPPED test).
describe.skipIf(!process.env.DATABASE_URL)("OTP login smoke (live Neon)", () => {
    const ORIGINAL_RESEND = process.env.RESEND_API_KEY;
    const ORIGINAL_SECRET = process.env.SECRET_KEY;
    const ORIGINAL_AUTH_TEST_EMAILS = process.env.AUTH_TEST_EMAILS;

    beforeAll(async () => {
        // `__test__` sentinel → issueOtp skips the Resend network call and
        // surfaces the generated code as `debugCode` (otp.ts:92).
        process.env.RESEND_API_KEY = "__test__";
        // verifyOtp needs SECRET_KEY to sign the JWT (otp.ts:160). Use the
        // live one if present; else a deterministic TEST_SECRET so
        // verifySessionToken (which reads the same SECRET_KEY) verifies it.
        if (!process.env.SECRET_KEY) process.env.SECRET_KEY = TEST_SECRET;
        // Build the DB handle FRESH against the live DATABASE_URL — drop any
        // in-memory bundle/handle cached by an earlier offline test.
        resetStoresForTests();
        await closeDb();
        // Clean slate before issuing so the test is idempotent even after a
        // previous (possibly crashed) run.
        await wipeOtpFixture();
    }, 120_000); // live Neon round-trips over WebSocket are slow — generous hook timeout.

    afterAll(async () => {
        // Leave NO residue in the real DB.
        await wipeOtpFixture();
        await closeDb();
        resetStoresForTests();
        if (ORIGINAL_RESEND === undefined) delete process.env.RESEND_API_KEY;
        else process.env.RESEND_API_KEY = ORIGINAL_RESEND;
        if (ORIGINAL_SECRET === undefined) delete process.env.SECRET_KEY;
        else process.env.SECRET_KEY = ORIGINAL_SECRET;
        if (ORIGINAL_AUTH_TEST_EMAILS === undefined) delete process.env.AUTH_TEST_EMAILS;
        else process.env.AUTH_TEST_EMAILS = ORIGINAL_AUTH_TEST_EMAILS;
    }, 120_000);

    it("issues an OTP to the live DB, verifies it → mints a JWT, and is single-use", async () => {
        const db = getDb(process.env);
        expect(db).not.toBeNull();
        if (!db) return;

        // ---- (1) issue: writes the OTP hash to the LIVE email_otps table
        //      and surfaces the code via the __test__ sentinel. ----
        const issued = await issueOtp(TEST_EMAIL, process.env);
        expect(issued.ok).toBe(true);
        expect(typeof issued.debugCode).toBe("string");
        // 6-digit zero-padded code (otp.ts:80).
        expect(issued.debugCode).toMatch(/^\d{6}$/);
        const code = issued.debugCode!;

        // ---- (2) the hash landed in the LIVE email_otps table (a direct
        //      getDb() read — proves it's the live DB, not in-memory). ----
        const rows = await db
            .select({ email: emailOtps.email, consumedAt: emailOtps.consumedAt })
            .from(emailOtps)
            .where(eq(emailOtps.email, TEST_EMAIL));
        expect(rows.length).toBe(1);
        expect(rows[0]!.email).toBe(TEST_EMAIL);
        // Not yet consumed — verify hasn't run.
        expect(rows[0]!.consumedAt).toBeNull();

        // ---- (3) verify: consumes the row, upserts a students row, and
        //      mints a signed JWT with sub: <studentId>. ----
        const verified = await verifyOtp(TEST_EMAIL, code, process.env);
        expect(verified.ok).toBe(true);
        expect(verified.studentId).toBe(TEST_STUDENT_ID);
        expect(typeof verified.token).toBe("string");
        expect(verified.token!.length).toBeGreaterThan(0);
        // A JWT is three base64url segments separated by dots.
        expect(verified.token!.split(".")).toHaveLength(3);

        // ---- (4) the minted JWT is valid + carries sub === studentId. ----
        const claims = await verifySessionToken(verified.token!, process.env);
        expect(claims).not.toBeNull();
        expect(claims!.sub).toBe(TEST_STUDENT_ID);
        expect(claims!.email).toBe(TEST_EMAIL);

        // ---- (5) the students row was upserted into the LIVE DB. ----
        const studentRows = await db
            .select({ studentId: students.studentId, email: students.email })
            .from(students)
            .where(eq(students.studentId, TEST_STUDENT_ID));
        expect(studentRows.length).toBe(1);
        expect(studentRows[0]!.email).toBe(TEST_EMAIL);

        // ---- (6) single-use: a SECOND verify with the same code is rejected
        //      (the row is now consumed → no pending OTP). ----
        const replay = await verifyOtp(TEST_EMAIL, code, process.env);
        expect(replay.ok).toBe(false);
        expect(replay.token).toBeUndefined();
        // The only live unconsumed/unexpired row was just consumed.
        expect(replay.reason).toBe("no_pending_otp");
    }, 120_000); // live Neon round-trips are slow (~20-30s) — bake the timeout in so a
    //              plain `npx vitest run` (no --testTimeout flag) still passes.
});
