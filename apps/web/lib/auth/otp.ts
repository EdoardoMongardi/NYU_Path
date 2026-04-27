// ============================================================
// Email-OTP auth helpers (Phase 7-B Step 11)
// ============================================================
// Two surfaces:
//   - issueOtp(email)  → generates a 6-digit code, persists hash, sends via Resend
//   - verifyOtp(email, code) → consumes the row, returns a signed JWT
//
// Codes are 6 digits, expire 10 minutes after issuance, and are
// hashed at rest (sha256). Double-redemption is rejected via the
// `consumedAt` column. Resend free tier (100 emails/day) covers
// cohort A; a `RESEND_API_KEY=__test__` sentinel skips the network
// call so test environments don't need a real key.
// ============================================================

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, desc } from "drizzle-orm";
import { SignJWT } from "jose";
import { Resend } from "resend";
import { getDb } from "../db/client.js";
import { emailOtps, students } from "../db/schema.js";

const NYU_EMAIL_RE = /^[a-z0-9._%+-]+@nyu\.edu$/i;
const OTP_TTL_MS = 10 * 60 * 1000;
const FROM_ADDRESS = "NYU Path <noreply@nyupath.app>";

export interface IssueResult {
    ok: boolean;
    /** Reason a deny was returned. Set only when ok=false. */
    reason?: "invalid_email" | "db_unavailable" | "send_failed";
    /** Surfaces back when running with `RESEND_API_KEY=__test__` so tests can grab the code. */
    debugCode?: string;
}

export interface VerifyResult {
    ok: boolean;
    reason?: "invalid_email" | "db_unavailable" | "no_pending_otp" | "expired" | "code_mismatch" | "already_consumed";
    /** Signed JWT with `sub: <studentId>` when ok=true. */
    token?: string;
    studentId?: string;
}

function sha256(s: string): string {
    return createHash("sha256").update(s).digest("hex");
}

function emailToStudentId(email: string): string {
    // NetID prefix as the canonical studentId. Stable even if the
    // email changes (NYU treats the prefix as the immutable identity).
    return email.toLowerCase().split("@")[0]!;
}

export async function issueOtp(
    email: string,
    env: Record<string, string | undefined> = process.env,
): Promise<IssueResult> {
    if (!NYU_EMAIL_RE.test(email)) return { ok: false, reason: "invalid_email" };
    const db = getDb(env);
    if (!db) return { ok: false, reason: "db_unavailable" };

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + OTP_TTL_MS);
    await db.insert(emailOtps).values({
        email: email.toLowerCase(),
        codeHash: sha256(code),
        issuedAt,
        expiresAt,
    });

    const apiKey = env.RESEND_API_KEY;
    if (!apiKey) return { ok: false, reason: "send_failed" };
    if (apiKey === "__test__") {
        // Test sentinel: don't hit the network, but surface the code
        // so tests can complete the round-trip end-to-end.
        return { ok: true, debugCode: code };
    }

    try {
        const resend = new Resend(apiKey);
        await resend.emails.send({
            from: FROM_ADDRESS,
            to: email,
            subject: "Your NYU Path login code",
            text: `Your one-time login code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
        });
    } catch {
        return { ok: false, reason: "send_failed" };
    }
    return { ok: true };
}

export async function verifyOtp(
    email: string,
    code: string,
    env: Record<string, string | undefined> = process.env,
): Promise<VerifyResult> {
    if (!NYU_EMAIL_RE.test(email)) return { ok: false, reason: "invalid_email" };
    const db = getDb(env);
    if (!db) return { ok: false, reason: "db_unavailable" };

    const lowerEmail = email.toLowerCase();
    const now = new Date();

    const rows = await db
        .select()
        .from(emailOtps)
        .where(
            and(
                eq(emailOtps.email, lowerEmail),
                isNull(emailOtps.consumedAt),
                gt(emailOtps.expiresAt, now),
            ),
        )
        .orderBy(desc(emailOtps.issuedAt))
        .limit(1);

    const row = rows[0];
    if (!row) return { ok: false, reason: "no_pending_otp" };

    const expectedHash = Buffer.from(row.codeHash, "hex");
    const providedHash = Buffer.from(sha256(code), "hex");
    if (expectedHash.length !== providedHash.length || !timingSafeEqual(expectedHash, providedHash)) {
        return { ok: false, reason: "code_mismatch" };
    }

    await db
        .update(emailOtps)
        .set({ consumedAt: now })
        .where(and(eq(emailOtps.email, lowerEmail), eq(emailOtps.issuedAt, row.issuedAt)));

    const studentId = emailToStudentId(lowerEmail);
    await db
        .insert(students)
        .values({ studentId, email: lowerEmail })
        .onConflictDoUpdate({
            target: students.studentId,
            set: { email: lowerEmail, updatedAt: new Date() },
        });

    const secret = env.SECRET_KEY;
    if (!secret) return { ok: false, reason: "db_unavailable" };
    const token = await new SignJWT({ email: lowerEmail })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(studentId)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(new TextEncoder().encode(secret));

    return { ok: true, token, studentId };
}
