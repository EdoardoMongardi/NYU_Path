// ============================================================
// /api/session/clear — Phase 16 Task B (test affordance)
// ============================================================
// Wipes every per-student row across the Phase-16 tables so a
// developer can re-run the onboarding flow without manually
// truncating the database. Hidden behind
// `NEXT_PUBLIC_ENABLE_TEST_CLEAR=1` server-side AND a confirm
// dialog client-side.
//
// The cascade FKs added in 16.A (`forward_schedules`,
// `schedule_preferences`, `chat_messages`, `audit_log`,
// `session_summaries`) all `ON DELETE CASCADE` on `students`,
// so deleting the `students` row alone is sufficient for those.
// `cohort_assignments` keys on `userId` (not `studentId`) and
// has no cascade, so we delete it explicitly.
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
    cohortAssignments,
} from "../../../../lib/db/schema";

export const runtime = "nodejs";

export async function DELETE(req: NextRequest): Promise<NextResponse> {
    // Server-side env gate. NEXT_PUBLIC_* is exposed to the client
    // bundle by Next.js, but client visibility doesn't make it safe —
    // re-check on the server so a malicious client can't fire this in
    // production by hand-crafting the request.
    if (process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR !== "1") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
    // in an inconsistent half-deleted state. Order matters only for
    // tables that don't have cascade FKs (cohort_assignments keys on
    // userId, not studentId — separate path).
    try {
        await db.transaction(async (tx) => {
            // Explicit deletes mirror the docstring's contract — even
            // though the cascade FKs would handle these via the
            // `students` delete below, listing them keeps the wipe
            // semantics legible AND robust if the FK constraints
            // ever drift.
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
            // cohort_assignments keys on userId; same value as
            // studentId in our auth model (JWT sub IS the studentId).
            await tx
                .delete(cohortAssignments)
                .where(eq(cohortAssignments.userId, studentId));
            // Delete the parent row last so the cascade-target rows
            // are explicitly gone before the parent disappears.
            await tx
                .delete(students)
                .where(eq(students.studentId, studentId));
        });
    } catch (err) {
        console.error("[session/clear] transaction failed:", err);
        return NextResponse.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
        );
    }

    return NextResponse.json({ ok: true });
}
