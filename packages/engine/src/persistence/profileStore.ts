// ============================================================
// ProfileStore — confirmed-mutation persistence (Phase 7-B Step 10)
// ============================================================
// Architecture §7.2 specifies a two-step write contract for profile
// mutations: `update_profile` stages, `confirm_profile_update` applies.
// Phase 5 wired the in-memory side; this module is the persistence
// hook the apply step calls when a real store is configured.
//
// Engine ships with `InMemoryProfileStore` (default) and the type
// `ProfileStore` interface. The web layer can drop in a Postgres-
// backed implementation behind the same interface.
// ============================================================

import type { StudentProfile } from "@nyupath/shared";
import type { PendingProfileMutation } from "../agent/tool.js";

export interface ProfileMutationAuditEntry {
    /** Stable id from the original `PendingProfileMutation`. */
    pendingMutationId: string;
    /** Which `StudentProfile` field changed. */
    field: PendingProfileMutation["field"];
    /** Previous value (canonical JSON). */
    before: unknown;
    /** New value (canonical JSON). */
    after: unknown;
    /** ISO timestamp the apply landed at. */
    confirmedAt: string;
}

export interface ProfileStore {
    /**
     * Read the canonical profile for a student. Returns `null` when no
     * persisted profile exists yet — the caller should fall back to the
     * in-memory profile (e.g., the one parsed from the transcript).
     */
    get(studentId: string): Promise<StudentProfile | null>;
    /**
     * Persist the post-mutation profile and append an immutable audit
     * row in one operation. Implementations are expected to be
     * transactional where possible. Failures should NOT throw — the
     * agent loop's session is the source of truth for the live turn.
     */
    persistMutation(
        profile: StudentProfile,
        audit: ProfileMutationAuditEntry,
    ): Promise<void>;
}

/** In-memory implementation. Tests + dev only — clears on process exit. */
export class InMemoryProfileStore implements ProfileStore {
    private readonly profiles = new Map<string, StudentProfile>();
    /** Test-only: read the audit log (chronological). */
    public readonly auditLog: ProfileMutationAuditEntry[] = [];

    async get(studentId: string): Promise<StudentProfile | null> {
        return this.profiles.get(studentId) ?? null;
    }

    async persistMutation(
        profile: StudentProfile,
        audit: ProfileMutationAuditEntry,
    ): Promise<void> {
        this.profiles.set(profile.id, profile);
        this.auditLog.push(audit);
    }

    clear(): void {
        this.profiles.clear();
        this.auditLog.length = 0;
    }
}
