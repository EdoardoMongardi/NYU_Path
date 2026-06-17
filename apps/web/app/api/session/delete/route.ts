// ============================================================
// /api/session/delete — Phase 4 Task E6.4
// The STANDING, always-on self-serve user-deletion right
// ============================================================
// This is the permanent user-deletion endpoint: any authenticated
// student may DELETE here to remove ALL of their data in one
// transaction. Unlike the sibling `/api/session/clear` route — which
// is the env-gated developer/operator TEST AFFORDANCE behind
// `NEXT_PUBLIC_ENABLE_TEST_CLEAR=1` — this route has **NO env gate**.
// It is always available so self-serve deletion is a guaranteed
// standing right, not a per-deployment opt-in.
//
// Auth is still required: the caller must present a valid session
// (401 otherwise), and may only delete their OWN data (`auth.sub`).
//
// The cascade FKs on the child tables (`forward_schedules`,
// `schedule_preferences`, `chat_messages`, `audit_log`,
// `session_summaries`, `pending_mutations`) all `ON DELETE CASCADE`
// on `students`, so deleting the `students` row alone is sufficient.
// We still issue explicit child deletes for legibility + robustness
// if a constraint ever drifts (mirrors `/api/session/clear`).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { readSessionFromRequest } from "../../../../lib/auth/session";
import { getDb } from "../../../../lib/db/client";
import { resetStoresForTests } from "../../../../lib/db/store";
import {
    students,
    forwardSchedules,
    schedulePreferences,
    chatMessages,
    auditLog,
    sessionSummaries,
    pendingMutations,
} from "../../../../lib/db/schema";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest): Promise<NextResponse> {
    // NO env gate here — this is the standing, always-on deletion right.
    // Auth is the only guard: a caller may only delete their own data.
    const auth = await readSessionFromRequest(req);
    if (!auth) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const studentId = auth.sub;

    const db = getDb(process.env);
    if (!db) {
        // No DB wired (in-memory mode). Reset the cached store bundle
        // so the next request re-initializes; the student's in-memory
        // state will already be cleared by that.
        resetStoresForTests();
        return NextResponse.json({ ok: true });
    }

    // Single transaction so a partial wipe never leaves the student
    // in an inconsistent half-deleted state. The `students` parent row
    // is deleted LAST.
    try {
        await db.transaction(async (tx) => {
            // Explicit child deletes mirror the docstring's contract —
            // even though the cascade FKs would handle these via the
            // `students` delete below, listing them keeps the wipe
            // semantics legible AND robust if the FK constraints ever
            // drift.
            await tx
                .delete(chatMessages)
                .where(eq(chatMessages.studentId, studentId));
            await tx
                .delete(forwardSchedules)
                .where(eq(forwardSchedules.studentId, studentId));
            await tx
                .delete(schedulePreferences)
                .where(eq(schedulePreferences.studentId, studentId));
            await tx
                .delete(auditLog)
                .where(eq(auditLog.studentId, studentId));
            await tx
                .delete(sessionSummaries)
                .where(eq(sessionSummaries.studentId, studentId));
            await tx
                .delete(pendingMutations)
                .where(eq(pendingMutations.studentId, studentId));
            // Delete the parent row last so the cascade-target rows
            // are explicitly gone before the parent disappears.
            await tx
                .delete(students)
                .where(eq(students.studentId, studentId));
        });
    } catch (err) {
        console.error("[session/delete] transaction failed:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
        );
    }

    return NextResponse.json({ ok: true });
}
