// ============================================================
// PostgresProfileStore (Phase 7-B Step 10)
// ============================================================
// Drizzle-backed implementation of the engine's `ProfileStore`
// interface. confirm_profile_update writes through this when a
// DATABASE_URL is wired; the audit row is appended in the same
// transaction so the apply is atomic.
// ============================================================

import type { ProfileStore, ProfileMutationAuditEntry } from "@nyupath/engine";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { StudentProfile } from "@nyupath/shared";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { auditLog, students } from "./schema.js";

export class PostgresProfileStore implements ProfileStore {
    constructor(private readonly db: Database) {}

    async get(studentId: string): Promise<StudentProfile | null> {
        const rows = await this.db
            .select({ profile: students.profile })
            .from(students)
            .where(eq(students.studentId, studentId))
            .limit(1);
        const row = rows[0];
        if (!row || !row.profile) return null;
        return row.profile as StudentProfile;
    }

    async persistMutation(
        profile: StudentProfile,
        audit: ProfileMutationAuditEntry,
        parsedDpr?: DegreeProgressReport,
    ): Promise<void> {
        await this.db.transaction(async (tx) => {
            // Phase 16 Task A — when `parsedDpr` is supplied, it is
            // co-persisted onto students.parsed_dpr via the same upsert.
            // When omitted, the column is intentionally left untouched
            // (a profile-only mutation should not wipe a previously
            // stored DPR).
            const dprPatch = parsedDpr !== undefined
                ? { parsedDpr }
                : ({} as Record<string, never>);
            await tx
                .insert(students)
                .values({
                    studentId: profile.id,
                    declaredPrograms: profile.declaredPrograms,
                    visaStatus: profile.visaStatus ?? null,
                    catalogYear: profile.catalogYear,
                    homeSchool: profile.homeSchool,
                    flags: profile.flags,
                    profile: profile,
                    updatedAt: new Date(),
                    ...dprPatch,
                })
                .onConflictDoUpdate({
                    target: students.studentId,
                    set: {
                        declaredPrograms: profile.declaredPrograms,
                        visaStatus: profile.visaStatus ?? null,
                        catalogYear: profile.catalogYear,
                        homeSchool: profile.homeSchool,
                        flags: profile.flags,
                        profile: profile,
                        updatedAt: new Date(),
                        ...dprPatch,
                    },
                });

            await tx.insert(auditLog).values({
                studentId: profile.id,
                pendingMutationId: audit.pendingMutationId,
                field: audit.field,
                before: audit.before as object,
                after: audit.after as object,
                confirmedAt: new Date(audit.confirmedAt),
            });
        });
    }

    async getParsedDpr(studentId: string): Promise<DegreeProgressReport | null> {
        const rows = await this.db
            .select({ parsedDpr: students.parsedDpr })
            .from(students)
            .where(eq(students.studentId, studentId))
            .limit(1);
        const row = rows[0];
        if (!row || !row.parsedDpr) return null;
        return row.parsedDpr as DegreeProgressReport;
    }
}
