// ============================================================
// PostgresSessionStore (Phase 7-B Step 8a)
// ============================================================
// Drizzle-backed implementation of the engine's `SessionStore`
// interface. Mirrors `FileBackedSessionStore`'s rolling-window
// behavior (MAX_SESSION_SUMMARIES = 5) by trimming on append.
// ============================================================

import {
    MAX_SESSION_SUMMARIES,
    type SessionStore,
    type SessionSummary,
    type StudentSessionRecord,
} from "@nyupath/engine";
import { sql, eq, asc, desc } from "drizzle-orm";
import type { Database } from "./client.js";
import { sessionSummaries, students } from "./schema.js";

export class PostgresSessionStore implements SessionStore {
    constructor(private readonly db: Database) {}

    async get(studentId: string): Promise<StudentSessionRecord> {
        const rows = await this.db
            .select({
                date: sessionSummaries.date,
                summary: sessionSummaries.summary,
            })
            .from(sessionSummaries)
            .where(eq(sessionSummaries.studentId, studentId))
            .orderBy(asc(sessionSummaries.id))
            .limit(MAX_SESSION_SUMMARIES * 4); // Defensive cap; we trim below.

        const trimmed = rows.slice(-MAX_SESSION_SUMMARIES);
        const lastSessionDate = trimmed.length > 0 ? trimmed[trimmed.length - 1]!.date : undefined;
        const record: StudentSessionRecord = {
            studentId,
            sessionSummaries: trimmed,
        };
        if (lastSessionDate !== undefined) record.lastSessionDate = lastSessionDate;
        return record;
    }

    async appendSummary(studentId: string, summary: SessionSummary): Promise<StudentSessionRecord> {
        await this.ensureStudentRow(studentId);
        await this.db.insert(sessionSummaries).values({
            studentId,
            date: summary.date,
            summary: summary.summary,
        });
        await this.db
            .update(students)
            .set({ lastSessionDate: new Date(summary.date), updatedAt: new Date() })
            .where(eq(students.studentId, studentId));
        await this.trim(studentId);
        return this.get(studentId);
    }

    async replace(record: StudentSessionRecord): Promise<void> {
        await this.ensureStudentRow(record.studentId);
        await this.db
            .delete(sessionSummaries)
            .where(eq(sessionSummaries.studentId, record.studentId));
        if (record.sessionSummaries.length > 0) {
            await this.db.insert(sessionSummaries).values(
                record.sessionSummaries.map((s) => ({
                    studentId: record.studentId,
                    date: s.date,
                    summary: s.summary,
                })),
            );
        }
    }

    private async ensureStudentRow(studentId: string): Promise<void> {
        await this.db
            .insert(students)
            .values({ studentId })
            .onConflictDoNothing({ target: students.studentId });
    }

    /**
     * Keep only the last MAX_SESSION_SUMMARIES rows for this student.
     * Implemented as a single `DELETE WHERE id NOT IN (latest N)` so
     * the trim survives concurrent inserts without coordination.
     */
    private async trim(studentId: string): Promise<void> {
        const keepIds = await this.db
            .select({ id: sessionSummaries.id })
            .from(sessionSummaries)
            .where(eq(sessionSummaries.studentId, studentId))
            .orderBy(desc(sessionSummaries.id))
            .limit(MAX_SESSION_SUMMARIES);
        if (keepIds.length === 0) return;
        const ids = keepIds.map((r) => r.id);
        await this.db.execute(sql`
            DELETE FROM ${sessionSummaries}
            WHERE ${sessionSummaries.studentId} = ${studentId}
              AND ${sessionSummaries.id} NOT IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        `);
    }
}
