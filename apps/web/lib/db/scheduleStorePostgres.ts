// ============================================================
// PostgresScheduleStore (Phase 16 Task A)
// ============================================================
// Drizzle-backed implementation of the engine's `ScheduleStore`
// interface. Mirrors `PostgresProfileStore`'s transactional + upsert
// patterns. Soft-delete (supersede) is the source-of-truth pattern
// for `forward_schedules`; `schedule_preferences` is one row per
// student (upsert).
// ============================================================

import type {
    ScheduleStore,
} from "@nyupath/engine";
import type { ForwardSchedule, SchedulePreferences } from "@nyupath/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import {
    forwardSchedules,
    schedulePreferences,
    students,
} from "./schema.js";

export class PostgresScheduleStore implements ScheduleStore {
    constructor(private readonly db: Database) {}

    async persistSchedule(
        studentId: string,
        schedule: ForwardSchedule,
        dprFingerprint: string,
    ): Promise<void> {
        await this.db.transaction(async (tx) => {
            // Ensure the student row exists (FK target). Idempotent —
            // mirrors PostgresSessionStore.ensureStudentRow.
            await tx
                .insert(students)
                .values({ studentId })
                .onConflictDoNothing({ target: students.studentId });
            // Supersede every previously-live row for this student.
            const now = new Date();
            await tx
                .update(forwardSchedules)
                .set({ supersededAt: now })
                .where(
                    and(
                        eq(forwardSchedules.studentId, studentId),
                        isNull(forwardSchedules.supersededAt),
                    ),
                );
            // Insert the new live row. `computed_at` mirrors the
            // schedule's wall-clock stamp so the audit trail can be
            // reconstructed from the table alone.
            await tx.insert(forwardSchedules).values({
                studentId,
                schedule: schedule as unknown as object,
                state: schedule.state,
                dprFingerprint,
                computedAt: new Date(schedule.computedAt),
            });
        });
    }

    async loadLatestSchedule(
        studentId: string,
    ): Promise<{ schedule: ForwardSchedule; dprFingerprint: string } | null> {
        const rows = await this.db
            .select({
                schedule: forwardSchedules.schedule,
                dprFingerprint: forwardSchedules.dprFingerprint,
            })
            .from(forwardSchedules)
            .where(
                and(
                    eq(forwardSchedules.studentId, studentId),
                    isNull(forwardSchedules.supersededAt),
                ),
            )
            .orderBy(desc(forwardSchedules.computedAt))
            .limit(1);
        const row = rows[0];
        if (!row || !row.schedule) return null;
        return {
            schedule: row.schedule as ForwardSchedule,
            dprFingerprint: row.dprFingerprint,
        };
    }

    async persistPreferences(
        studentId: string,
        prefs: SchedulePreferences,
    ): Promise<void> {
        await this.db
            .insert(students)
            .values({ studentId })
            .onConflictDoNothing({ target: students.studentId });
        await this.db
            .insert(schedulePreferences)
            .values({
                studentId,
                preferences: prefs as unknown as object,
                updatedAt: new Date(),
            })
            .onConflictDoUpdate({
                target: schedulePreferences.studentId,
                set: {
                    preferences: prefs as unknown as object,
                    updatedAt: new Date(),
                },
            });
    }

    async loadPreferences(studentId: string): Promise<SchedulePreferences | null> {
        const rows = await this.db
            .select({ preferences: schedulePreferences.preferences })
            .from(schedulePreferences)
            .where(eq(schedulePreferences.studentId, studentId))
            .limit(1);
        const row = rows[0];
        if (!row || !row.preferences) return null;
        return row.preferences as SchedulePreferences;
    }

    async clearScheduleForStudent(studentId: string): Promise<void> {
        // Hard-delete every row (preserves audit elsewhere; the
        // `forward_schedules` rows ARE the audit, so a Update-DPR
        // wipe legitimately removes them).
        await this.db
            .delete(forwardSchedules)
            .where(eq(forwardSchedules.studentId, studentId));
    }
}
