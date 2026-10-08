// ============================================================
// claimStudentRow — the `students` write on a verified OTP login
// ============================================================
// A login used to upsert `{ email }` onto whatever row already sat under
// the NetID, ADOPTING it. Before PR #58 the chat v2 route accepted a
// cookie-less `body.userId`, so anyone could plant a row — profile,
// parsed_dpr, chat, summaries, schedules — under a NetID that had never
// logged in, and the owner's first login inherited all of it.
//
// The claim now distinguishes:
//   - no row                                  → create
//   - row already claimed (email set)         → adopt (returning student)
//   - email-less row, id HAS logged in before → adopt. Self-serve delete and
//     test-clear keep the session cookie, so re-onboarding re-creates the
//     row without an email; that data is the student's own.
//   - email-less row, id NEVER logged in      → reset: delete the row (every
//     child table cascades) and insert a fresh claimed row. Nobody could
//     have written it legitimately: since PR #58 only a session cookie may
//     write under a NetID, and a NetID has none before its first login.
//
// Forensics for rows already adopted: Docs/audits/2026-10-06-chat-v2-identity-planting-runbook.md
// ============================================================

import { and, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { emailOtps, students } from "../db/schema.js";

export type LoginClaim = "create" | "adopt" | "reset";

export function decideLoginClaim(
    existing: { email: string | null } | null,
    hasPriorVerifiedLogin: boolean,
): LoginClaim {
    if (!existing) return "create";
    if (existing.email !== null || hasPriorVerifiedLogin) return "adopt";
    return "reset";
}

export async function claimStudentRow(
    db: Database,
    args: {
        studentId: string;
        email: string;
        /** The OTP this login just consumed — excluded from "has logged in before". */
        currentOtp: { email: string; issuedAt: Date };
    },
): Promise<LoginClaim> {
    const { studentId, email, currentOtp } = args;
    return db.transaction(async (tx) => {
        // Lock the row so a concurrent claim can't interleave a reset.
        const rows = await tx
            .select({ email: students.email })
            .from(students)
            .where(eq(students.studentId, studentId))
            .limit(1)
            .for("update");
        const existing = rows[0] ?? null;

        let hasPriorVerifiedLogin = false;
        if (existing && existing.email === null) {
            // Login ids are the email local part (otp.ts emailToStudentId),
            // so any verified login of any address mapping to this id counts.
            const prior = await tx
                .select({ one: sql<number>`1` })
                .from(emailOtps)
                .where(
                    and(
                        sql`split_part(${emailOtps.email}, '@', 1) = ${studentId}`,
                        isNotNull(emailOtps.consumedAt),
                        or(
                            ne(emailOtps.email, currentOtp.email),
                            ne(emailOtps.issuedAt, currentOtp.issuedAt),
                        ),
                    ),
                )
                .limit(1);
            hasPriorVerifiedLogin = prior.length > 0;
        }

        const claim = decideLoginClaim(existing, hasPriorVerifiedLogin);
        if (claim === "reset") {
            console.warn(
                `[otp] first login for ${studentId} found a never-claimed students row; reset it instead of adopting`,
            );
            await tx.delete(students).where(eq(students.studentId, studentId));
            await tx.insert(students).values({ studentId, email });
        } else {
            await tx
                .insert(students)
                .values({ studentId, email })
                .onConflictDoUpdate({
                    target: students.studentId,
                    set: { email, updatedAt: new Date() },
                });
        }
        return claim;
    });
}
