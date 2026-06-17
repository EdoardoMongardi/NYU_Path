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
import type { DegreeProgressReport } from "../dpr/schema.js";

// ── Snapshot-integrity guard (G0.2) ──────────────────────────
// Inline here so the engine package has no web dependency.
// The web layer has its own importable wrapper in
// apps/web/lib/db/assertAuthoritativeDpr.ts that re-exports
// from @nyupath/engine once this is published, but for now
// both call the same logic independently.
function assertAuthoritativeDpr(dpr: DegreeProgressReport): void {
    if (dpr.reportKind !== "dpr") {
        throw new Error(
            `[snapshot-integrity] refusing to persist a non-authoritative (${dpr.reportKind}) DPR as the student snapshot. ` +
            `Only reportKind === "dpr" may be written to students.parsed_dpr. ` +
            `Use a what-if session context instead — never overwrite the authoritative DPR column.`,
        );
    }
}

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
     *
     * Phase 16 Task A — the optional `parsedDpr` argument lets the
     * caller co-persist the parsed DPR onto `students.parsed_dpr` in
     * the same transaction as the profile mutation. Used by
     * `confirm_profile_update` when the DPR is loaded for the first
     * time (the onboarding flow). When omitted, the existing column
     * is left untouched.
     */
    persistMutation(
        profile: StudentProfile,
        audit: ProfileMutationAuditEntry,
        parsedDpr?: DegreeProgressReport,
    ): Promise<void>;
    /**
     * Phase 16 Task A — read the parsed DPR persisted by a prior
     * `persistMutation` call. Returns `null` when none. Used by the
     * Phase 16 login-restore route (Task 16.B).
     */
    getParsedDpr?(studentId: string): Promise<DegreeProgressReport | null>;
}

/** In-memory implementation. Tests + dev only — clears on process exit. */
export class InMemoryProfileStore implements ProfileStore {
    private readonly profiles = new Map<string, StudentProfile>();
    private readonly parsedDprs = new Map<string, DegreeProgressReport>();
    /** Test-only: read the audit log (chronological). */
    public readonly auditLog: ProfileMutationAuditEntry[] = [];

    async get(studentId: string): Promise<StudentProfile | null> {
        return this.profiles.get(studentId) ?? null;
    }

    async persistMutation(
        profile: StudentProfile,
        audit: ProfileMutationAuditEntry,
        parsedDpr?: DegreeProgressReport,
    ): Promise<void> {
        if (parsedDpr !== undefined) {
            assertAuthoritativeDpr(parsedDpr);
        }
        this.profiles.set(profile.id, profile);
        this.auditLog.push(audit);
        if (parsedDpr !== undefined) {
            this.parsedDprs.set(profile.id, parsedDpr);
        }
    }

    async getParsedDpr(studentId: string): Promise<DegreeProgressReport | null> {
        return this.parsedDprs.get(studentId) ?? null;
    }

    clear(): void {
        this.profiles.clear();
        this.parsedDprs.clear();
        this.auditLog.length = 0;
    }
}
