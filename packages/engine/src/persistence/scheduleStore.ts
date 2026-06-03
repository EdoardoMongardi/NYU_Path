// ============================================================
// ScheduleStore — forward-schedule + preferences persistence
// (Phase 16 Task A)
// ============================================================
// The Phase 13 forward planner currently writes its result to
// `session.forwardSchedule` (or `session.studentDraftPlan` per
// Decision #32). Pre-Phase-16 those were lost when the SSE session
// ended; Phase 16 makes the in-memory slot a *cache* of the latest
// row in `forward_schedules`.
//
// `persistSchedule` follows a soft-delete pattern: each call inserts
// a new row and stamps `superseded_at = now()` on every prior row for
// the same student. `loadLatestSchedule` returns only the live (non-
// superseded) row. Older rows stay in the DB for analytics + cohort
// eval — the audit trail is preserved.
//
// `SchedulePreferences` are *intent*, not history; the latest write
// replaces the prior version (upsert on student_id). Audit of pref
// changes goes through the existing `audit_log` table separately.
//
// The `pruneCompletedPins` helper is a pure function used by the
// Update-DPR route (Task 16.B): when the new DPR fingerprint differs
// from the stored one we drop the schedule entirely, but the
// preferences row only loses pins whose courseId is now in the
// completed-course set. Every other field (loadStyle, exclusions,
// schedulingPreferences, etc.) survives.
// ============================================================

import type { ForwardSchedule, SchedulePreferences } from "@nyupath/shared";

export interface ScheduleStore {
    /**
     * Persist the latest schedule. Implementations soft-delete prior
     * rows (`supersededAt = now()`) so the audit trail is preserved
     * but `loadLatestSchedule` only sees the live row.
     */
    persistSchedule(
        studentId: string,
        schedule: ForwardSchedule,
        dprFingerprint: string,
    ): Promise<void>;

    /** Read the latest non-superseded schedule. Returns `null` when none. */
    loadLatestSchedule(
        studentId: string,
    ): Promise<{ schedule: ForwardSchedule; dprFingerprint: string } | null>;

    /** Persist preferences. Upsert on (studentId). */
    persistPreferences(studentId: string, prefs: SchedulePreferences): Promise<void>;

    /** Read preferences. Returns `null` when none. */
    loadPreferences(studentId: string): Promise<SchedulePreferences | null>;

    /**
     * Wipe the stored schedule for a student (Update-DPR fingerprint
     * mismatch). Preferences are NOT cleared by this call — caller
     * decides via `pruneCompletedPins` + `persistPreferences`.
     */
    clearScheduleForStudent(studentId: string): Promise<void>;
}

// ============================================================
// pruneCompletedPins — pure helper
// ============================================================
// Drops pins whose courseId is in `completedCourseIds`. Keeps every
// other field of `SchedulePreferences` (loadStyle, loadStylePerTerm,
// creditTargetPerTerm, exclusions, includeSummer, includeJTerm,
// allowBelowF1Floor, schedulingPreferences) verbatim.
//
// Used by the Update-DPR route after a fingerprint mismatch: the new
// DPR may move courses from in-progress to completed, in which case
// pinning them to a future term is no longer meaningful.
// ============================================================

export function pruneCompletedPins(
    prefs: SchedulePreferences,
    completedCourseIds: Set<string>,
): SchedulePreferences {
    if (!prefs.pins || prefs.pins.length === 0) return prefs;
    const remaining = prefs.pins.filter((p) => !completedCourseIds.has(p.courseId));
    if (remaining.length === prefs.pins.length) return prefs;
    if (remaining.length === 0) {
        const { pins: _pins, ...rest } = prefs;
        return rest;
    }
    return { ...prefs, pins: remaining };
}

// ============================================================
// InMemoryScheduleStore — dev + test default
// ============================================================
// Soft-delete supersede pattern mirrors the Postgres impl so the
// engine-side tests exercise the same load/clear semantics the
// route tests rely on.
// ============================================================

interface ScheduleRecord {
    schedule: ForwardSchedule;
    dprFingerprint: string;
    /** Wall-clock ms — the latest row by computedAt is the "live" row. */
    storedAt: number;
    supersededAt: number | null;
}

export class InMemoryScheduleStore implements ScheduleStore {
    private readonly schedules = new Map<string, ScheduleRecord[]>();
    private readonly preferences = new Map<string, SchedulePreferences>();

    async persistSchedule(
        studentId: string,
        schedule: ForwardSchedule,
        dprFingerprint: string,
    ): Promise<void> {
        const now = Date.now();
        const list = this.schedules.get(studentId) ?? [];
        // Supersede every previously-live row.
        for (const r of list) {
            if (r.supersededAt === null) r.supersededAt = now;
        }
        list.push({
            schedule,
            dprFingerprint,
            storedAt: now,
            supersededAt: null,
        });
        this.schedules.set(studentId, list);
    }

    async loadLatestSchedule(
        studentId: string,
    ): Promise<{ schedule: ForwardSchedule; dprFingerprint: string } | null> {
        const list = this.schedules.get(studentId);
        if (!list) return null;
        const live = list.filter((r) => r.supersededAt === null);
        if (live.length === 0) return null;
        // Latest by storedAt wins (concurrent writes are last-writer-win).
        live.sort((a, b) => b.storedAt - a.storedAt);
        const top = live[0]!;
        return { schedule: top.schedule, dprFingerprint: top.dprFingerprint };
    }

    async persistPreferences(studentId: string, prefs: SchedulePreferences): Promise<void> {
        this.preferences.set(studentId, prefs);
    }

    async loadPreferences(studentId: string): Promise<SchedulePreferences | null> {
        return this.preferences.get(studentId) ?? null;
    }

    async clearScheduleForStudent(studentId: string): Promise<void> {
        this.schedules.delete(studentId);
    }

    /** Test-only: wipe everything across every student. */
    clear(): void {
        this.schedules.clear();
        this.preferences.clear();
    }
}
