// ============================================================
// PostgresCohortStore (Phase 7-B Step 8b)
// ============================================================
// Provides a Postgres-backed userId → Cohort lookup that overlays
// the engine's in-memory `setCohortAssignment` global. The v2
// route prefers the DB when available and falls back to the
// in-memory map (the existing behavior) when DATABASE_URL is unset.
//
// Writes via `assign(userId, cohort, assignedBy?)` upsert into
// `cohort_assignments`. Reads via `lookup(userId)` are cache-friendly
// (one row by primary key).
// ============================================================

import type { Cohort } from "@nyupath/engine";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { cohortAssignments } from "./schema.js";

export class PostgresCohortStore {
    constructor(private readonly db: Database) {}

    async lookup(userId: string): Promise<Cohort | null> {
        const rows = await this.db
            .select({ cohort: cohortAssignments.cohort })
            .from(cohortAssignments)
            .where(eq(cohortAssignments.userId, userId))
            .limit(1);
        return rows[0]?.cohort ?? null;
    }

    async assign(userId: string, cohort: Cohort, assignedBy?: string): Promise<void> {
        await this.db
            .insert(cohortAssignments)
            .values({
                userId,
                cohort,
                assignedAt: new Date(),
                assignedBy: assignedBy ?? null,
            })
            .onConflictDoUpdate({
                target: cohortAssignments.userId,
                set: {
                    cohort,
                    assignedAt: new Date(),
                    assignedBy: assignedBy ?? null,
                },
            });
    }
}
