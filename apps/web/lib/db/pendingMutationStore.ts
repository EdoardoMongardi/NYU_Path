// ============================================================
// PendingMutationStore (Phase 4 Task E6.3)
// ============================================================
// Durable staging for the propose→confirm round-trip. Stage 1
// (`/api/plan/<verb>`) mints a `pendingMutationId` and stashes the
// mutation array; Stage 2 (`/api/plan/confirm`) takes it back out and
// applies it. The two stages are SEPARATE route invocations, so the
// staging entry must outlive a single request.
//
// Pre-E6.3 this lived in a module-scope `Map` in
// `planActionOrchestrator.ts`: single-instance, 10-min TTL, lost on
// restart, and invisible to a sibling instance in a multi-instance
// deploy. E6.3 moves it behind this store so the entry is persisted
// (Postgres `pending_mutations` table) when a DB handle exists, and
// kept in an in-memory singleton otherwise (dev + offline tests).
//
// The cross-tenant guard + single-use delete now live INSIDE the
// store's `take`: a confirm hands its own studentId, and `take`
// returns the entry only if (a) the id exists, (b) it has not
// expired, and (c) the entry's studentId matches — then deletes it so
// a second take of the same id is a no-op. This keeps the security
// invariant atomic with the read instead of split across the
// orchestrator.
// ============================================================

import { and, eq, lte } from "drizzle-orm";
import type { PlanMutation } from "@nyupath/shared";
import type { WhatIfOutcome } from "@nyupath/engine";
import type { Database } from "./client.js";
import { pendingMutations as pendingMutationsTable } from "./schema.js";

/** Wall-clock TTL for a staged proposal (mirrors the pre-E6.3 Map). */
export const PENDING_MUTATION_TTL_MS = 10 * 60 * 1000;

/**
 * G3.1 — a staged WHAT-IF ASSUMPTION ("I withdrew / I'll take pass-fail for
 * course X"). Unlike a `PlanMutation` (which mutates PREFERENCES + re-solves
 * the session DPR), an assumption TRANSFORMS the DPR in-memory (withdraw /
 * pass / fail) and re-solves against the synthetic clone. The confirm path
 * re-applies the transform and persists ONLY the resulting forward_schedule —
 * never the synthetic DPR (the R1 snapshot-integrity guardrail).
 */
export interface WhatIfAssumptionStaged {
    courseId: string;
    outcome: WhatIfOutcome;
}

/**
 * The staged proposal a confirm needs to re-apply atomically. `studentId`
 * powers the cross-tenant guard; `createdAt` (epoch ms) powers the 10-min TTL.
 *
 * G3.1 — the payload is a DISCRIMINATED UNION carried in the SAME
 * `pending_mutations.mutations` JSONB column (no migration):
 *   - the existing plan-change payload: `mutations: PlanMutation[]`
 *     (`assumption` absent), OR
 *   - a what-if assumption: `assumption: { courseId, outcome }`
 *     (`mutations` is `[]`).
 * `take`/`stage` are agnostic to which kind; the orchestrator's confirm reads
 * `assumption` first and falls back to `mutations`.
 */
export interface PendingMutationEntry {
    pendingMutationId: string;
    studentId: string;
    mutations: PlanMutation[];
    /** G3.1 — present iff this is a staged what-if ASSUMPTION (not a
     *  PlanMutation batch). Mutually exclusive with a non-empty `mutations`. */
    assumption?: WhatIfAssumptionStaged;
    /** Epoch ms the entry was staged. */
    createdAt: number;
}

// ---------------------------------------------------------------------------
// JSONB (de)serialisation for the shared `mutations` column (G3.1)
// ---------------------------------------------------------------------------
//
// The `pending_mutations.mutations` JSONB column historically stored a bare
// `PlanMutation[]`. To carry a what-if assumption WITHOUT a schema migration we
// store it as a tagged WRAPPER OBJECT `{ __whatif: { courseId, outcome } }`
// only when an assumption is present; a plan-mutation entry still serialises as
// the bare array, so EXISTING rows decode unchanged (back-compat).

interface WhatIfWrapper {
    __whatif: WhatIfAssumptionStaged;
}

function isWhatIfWrapper(v: unknown): v is WhatIfWrapper {
    return (
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        "__whatif" in v &&
        typeof (v as { __whatif?: unknown }).__whatif === "object"
    );
}

/** Encode an entry's payload into the JSONB column value. A what-if assumption
 *  → the tagged wrapper; a plan-mutation batch → the bare array (back-compat). */
export function encodePendingPayload(entry: PendingMutationEntry): unknown {
    if (entry.assumption) return { __whatif: entry.assumption } satisfies WhatIfWrapper;
    return entry.mutations;
}

/** Decode a JSONB column value back into `{ mutations, assumption? }`. The
 *  bare-array form (every pre-G3.1 row + every plan-mutation entry) decodes to
 *  `mutations`; the tagged wrapper decodes to a what-if `assumption`. */
export function decodePendingPayload(
    raw: unknown,
): { mutations: PlanMutation[]; assumption?: WhatIfAssumptionStaged } {
    if (isWhatIfWrapper(raw)) {
        return { mutations: [], assumption: raw.__whatif };
    }
    return { mutations: (raw as PlanMutation[] | null) ?? [] };
}

/**
 * Discriminated outcome of `take`, so the caller can map the
 * "wrong tenant" case to its own error (the orchestrator surfaces
 * `studentId_mismatch`) distinctly from "no such id / expired"
 * (`unknown_mutation_id`) WITHOUT a separate non-atomic read.
 *
 *   - `{ status: "ok", entry }`     — matched + consumed (single-use).
 *   - `{ status: "not_found" }`     — unknown id, or expired.
 *   - `{ status: "tenant_mismatch" }` — id exists but belongs to
 *     another student; the entry is left INTACT for its owner.
 */
export type TakeResult =
    | { status: "ok"; entry: PendingMutationEntry }
    | { status: "not_found" }
    | { status: "tenant_mismatch" };

export interface PendingMutationStore {
    /** Stage a proposal for a later confirm. */
    stage(entry: PendingMutationEntry): Promise<void>;

    /**
     * Atomically read-validate-tenant-check-delete. Returns `ok` (and
     * deletes the entry — single-use) ONLY when the id exists, is
     * unexpired, AND its studentId matches. A tenant mismatch returns
     * `tenant_mismatch` and leaves the entry intact so the rightful
     * owner can still confirm. Unknown / expired ids return `not_found`.
     */
    take(pendingMutationId: string, studentId: string): Promise<TakeResult>;

    /** Drop entries older than the TTL. Best-effort housekeeping. */
    sweepExpired(now?: number): Promise<void>;
}

// ============================================================
// InMemoryPendingMutationStore — dev + offline-test default
// ============================================================
// Single-process Map. Preserves the exact semantics of the pre-E6.3
// orchestrator Map (TTL sweep + cross-tenant + single-use) but behind
// the store seam so the orchestrator no longer owns module-scope
// staging state. "Restart" for this path means re-reading through the
// `getStores()` singleton (the entry is on the singleton, not inside a
// route closure); a true cold restart drops it, matching the old Map's
// volatility — durable restart survival is the Postgres path, exercised
// live in E6.5.
// ============================================================

export class InMemoryPendingMutationStore implements PendingMutationStore {
    private readonly entries = new Map<string, PendingMutationEntry>();

    async stage(entry: PendingMutationEntry): Promise<void> {
        this.sweepExpiredSync(entry.createdAt);
        this.entries.set(entry.pendingMutationId, entry);
    }

    async take(pendingMutationId: string, studentId: string): Promise<TakeResult> {
        this.sweepExpiredSync(Date.now());
        const entry = this.entries.get(pendingMutationId);
        if (!entry) return { status: "not_found" };
        // Cross-tenant guard — a mismatch leaves the entry intact so the
        // rightful owner can still confirm.
        if (entry.studentId !== studentId) return { status: "tenant_mismatch" };
        // Single-use — delete on the matched take.
        this.entries.delete(pendingMutationId);
        return { status: "ok", entry };
    }

    async sweepExpired(now: number = Date.now()): Promise<void> {
        this.sweepExpiredSync(now);
    }

    private sweepExpiredSync(now: number): void {
        for (const [id, entry] of this.entries) {
            if (now - entry.createdAt > PENDING_MUTATION_TTL_MS) {
                this.entries.delete(id);
            }
        }
    }

    // -- Test-only affordances (mirror InMemoryScheduleStore.clear) -------

    /** Test-only: drop every staged entry. */
    clearForTests(): void {
        this.entries.clear();
    }

    /** Test-only: current staged-entry count. */
    sizeForTests(): number {
        return this.entries.size;
    }

    /** Test-only: is a given pendingMutationId currently staged? (the map is
     *  keyed by id, so this proves an emitted id matches a staged one). */
    hasForTests(id: string): boolean {
        return this.entries.has(id);
    }

    /** Test-only: force every entry past the TTL (rewinds createdAt). */
    expireAllForTests(): void {
        for (const entry of this.entries.values()) {
            entry.createdAt -= PENDING_MUTATION_TTL_MS + 1;
        }
    }
}

// ============================================================
// PostgresPendingMutationStore — durable (multi-instance) staging
// ============================================================
// One row per staged proposal in `pending_mutations`. The mutation
// array + studentId live in the row so a sibling instance (or the same
// instance after a restart) can confirm. `take` runs a tenant-scoped
// DELETE ... RETURNING so the read + single-use delete are one atomic
// statement; a tenant mismatch deletes nothing and returns null.
// ============================================================

export class PostgresPendingMutationStore implements PendingMutationStore {
    constructor(private readonly db: Database) {}

    async stage(entry: PendingMutationEntry): Promise<void> {
        await this.sweepExpired(entry.createdAt);
        const createdAt = new Date(entry.createdAt);
        const expiresAt = new Date(entry.createdAt + PENDING_MUTATION_TTL_MS);
        // G3.1 — `encodePendingPayload` writes a what-if assumption as a tagged
        // wrapper + a plan-mutation batch as the bare array, so the same JSONB
        // column carries both kinds with no schema migration + no break of
        // pre-G3.1 rows.
        const payload = encodePendingPayload(entry) as object;
        await this.db
            .insert(pendingMutationsTable)
            .values({
                pendingMutationId: entry.pendingMutationId,
                studentId: entry.studentId,
                mutations: payload,
                createdAt,
                expiresAt,
            })
            .onConflictDoUpdate({
                target: pendingMutationsTable.pendingMutationId,
                set: {
                    studentId: entry.studentId,
                    mutations: payload,
                    createdAt,
                    expiresAt,
                },
            });
    }

    async take(pendingMutationId: string, studentId: string): Promise<TakeResult> {
        const now = new Date();
        // Tenant-scoped DELETE ... RETURNING: the WHERE enforces BOTH the
        // id match AND the cross-tenant guard, and RETURNING hands the row
        // back atomically (read + single-use delete are one statement). A
        // row means "matched + consumed".
        const deleted = await this.db
            .delete(pendingMutationsTable)
            .where(
                and(
                    eq(pendingMutationsTable.pendingMutationId, pendingMutationId),
                    eq(pendingMutationsTable.studentId, studentId),
                ),
            )
            .returning({
                pendingMutationId: pendingMutationsTable.pendingMutationId,
                studentId: pendingMutationsTable.studentId,
                mutations: pendingMutationsTable.mutations,
                createdAt: pendingMutationsTable.createdAt,
                expiresAt: pendingMutationsTable.expiresAt,
            });
        const row = deleted[0];
        if (row) {
            // TTL: a matched-but-expired row was already consumed by the
            // delete above; treat it as not-found so confirm 404s exactly
            // as the in-memory path does.
            if (row.expiresAt instanceof Date && row.expiresAt.getTime() <= now.getTime()) {
                return { status: "not_found" };
            }
            // G3.1 — decode the shared JSONB column back into either a
            // plan-mutation batch or a what-if assumption.
            const { mutations, assumption } = decodePendingPayload(row.mutations);
            return {
                status: "ok",
                entry: {
                    pendingMutationId: row.pendingMutationId,
                    studentId: row.studentId,
                    mutations,
                    ...(assumption ? { assumption } : {}),
                    createdAt:
                        row.createdAt instanceof Date
                            ? row.createdAt.getTime()
                            : Number(row.createdAt),
                },
            };
        }
        // No tenant-scoped row deleted. Disambiguate "wrong tenant" (id
        // exists under another student — leave it INTACT for its owner)
        // from "unknown / expired" with a read-only existence probe on
        // the id alone. This neither consumes the entry nor leaks it.
        const exists = await this.db
            .select({ studentId: pendingMutationsTable.studentId })
            .from(pendingMutationsTable)
            .where(eq(pendingMutationsTable.pendingMutationId, pendingMutationId))
            .limit(1);
        if (exists[0]) return { status: "tenant_mismatch" };
        return { status: "not_found" };
    }

    async sweepExpired(now: number = Date.now()): Promise<void> {
        await this.db
            .delete(pendingMutationsTable)
            .where(lte(pendingMutationsTable.expiresAt, new Date(now)));
    }
}
