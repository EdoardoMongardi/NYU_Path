# Database and Stores

> Last verified against code: 2026-06-16 (Phase 4 E6 — DB wiring + live exit gates). Prior: 2026-06-15 (cohort gate subsystem removed).

## Purpose

This is the long-term memory of the app — the Postgres database where everything that needs to survive a refresh lives. When a student logs in for the first time, a row is created for them; from then on, every plan they generate, every preference they set, every chat message they send, and every confirmed change to their profile gets stored under their NetID. The code is organized into four "store" classes, each owning one slice (profile, schedule, chat history, session summaries) and each speaking a clean interface so the rest of the app doesn't have to know about SQL. If no database is configured (local dev without setup), everything quietly falls back to in-memory storage that disappears on restart. Migrations are managed separately and applied during deploys.

```mermaid
flowchart LR
    App[App code] --> Stores[Four store classes]
    Stores --> Profile[Profile + audit]
    Stores --> Schedule[Plans + preferences]
    Stores --> Chat[Chat history]
    Stores --> Sessions[Session summaries]
    Profile --> Postgres[(Postgres database)]
    Schedule --> Postgres
    Chat --> Postgres
    Sessions --> Postgres
    Stores -.no DB configured.-> Memory[(In-memory fallback)]
```

---

## Overview

The web app persists everything to a Postgres database accessed through Drizzle ORM. Four concrete store classes — ProfileStore, ScheduleStore, ChatHistoryStore, and SessionStore — sit on top of the same Drizzle client. Each implements a persistence interface that the engine package (`@nyupath/engine`) defines.

When no `DATABASE_URL` is configured, every store falls back to an in-memory implementation that the engine package already exports (`SessionStore` may instead be the engine's `FileBackedSessionStore` if `NYUPATH_SESSION_STORE_PATH` is set). This means the data-access layer still works locally without Postgres — only durability is lost.

> **The memory fallback is effectively dev/test-only**, not a usable production mode. The email-OTP login flow (`apps/web/lib/auth/otp.ts:77-78` and `118-119`) hard-fails with `db_unavailable` when `getDb` returns null, so a real user cannot authenticate without a configured database. Memory-backed runs only make sense behind a pre-authenticated test harness or a session-store path.

A single factory (`getStores`) wires the bundle together and caches it at module scope, so warm serverless containers reuse the same Neon connection pool across requests. The deterministic plan-action layer is a heavy consumer of `scheduleStore` and `profileStore` — see [plan-action-orchestrator.md](./plan-action-orchestrator.md) and [plan-action-routes.md](./plan-action-routes.md).

## Drizzle schema

All tables are declared in `apps/web/lib/db/schema.ts`. They are intentionally narrow — only what the engine actively reads and writes.

### Table: students

The canonical row per student. One row per `studentId`. Defined at `schema.ts:28`.

| Column | Type | Purpose |
|---|---|---|
| student_id | text, primary key | Stable identifier issued at onboarding |
| email | text, unique | Optional email; used by the email-OTP login flow |
| declared_programs | jsonb, not null, default `[]` | Array of declared programs the engine plans against |
| visa_status | text | Optional visa string (e.g. F-1) |
| catalog_year | text | The student's catalog year in `"YYYY-YYYY"` range form (e.g. `2024-2025`), as emitted by `deriveCatalogYear` in `buildSession.ts` |
| home_school | text | NYU school code (CAS, Tandon, etc.) |
| flags | jsonb, not null, default `[]` | Free-form profile flags the engine cares about |
| profile | jsonb | Full `StudentProfile` snapshot, written by every `confirm_profile_update` |
| parsed_dpr | jsonb | Most-recent parsed Degree Progress Report; written by onboarding and Update-DPR |
| last_session_date | timestamptz | Wall-clock of the latest session summary append |
| created_at | timestamptz, not null, default now | First insert |
| updated_at | timestamptz, not null, default now | Updated on every upsert |

### Table: session_summaries

A rolling window of natural-language summaries per student. Defined at `schema.ts:51`.

| Column | Type | Purpose |
|---|---|---|
| id | serial, primary key | Monotonic ordering key |
| student_id | text, FK to students.student_id, cascade delete | Owner |
| date | text, not null | ISO date string of the session |
| summary | text, not null | A short heuristic session marker (intent + tools called) written by the v2 chat route at end of turn — `Asked: "…". Tools called: ….`. NOT an LLM-generated summary (the `~600-token` wording in the `schema.ts:55` comment is stale). |
| created_at | timestamptz, not null, default now | Insert time |

Index `session_summaries_student_idx` on `(student_id, id)` lets the loader pull the last N rows for one student cheaply.

### Table: audit_log

An immutable append-only history of confirmed profile mutations. Defined at `schema.ts:63`.

| Column | Type | Purpose |
|---|---|---|
| id | serial, primary key | Monotonic ordering key |
| student_id | text, FK to students, cascade delete | Owner |
| pending_mutation_id | text, not null | Echo of the `PendingProfileMutation.id` the agent surfaced |
| field | text, not null | Which `StudentProfile` field changed |
| before | jsonb | Prior value |
| after | jsonb | New value |
| confirmed_at | timestamptz, not null, default now | When the confirm happened |

Index `audit_log_student_idx` on `(student_id, confirmed_at)`.

### Table: email_otps

One row per outstanding one-time password. Defined at `schema.ts:89`.

| Column | Type | Purpose |
|---|---|---|
| email | text, not null | Recipient |
| code_hash | text, not null | Hashed OTP — the plaintext is never stored |
| issued_at | timestamptz, not null, default now | When the code was sent |
| expires_at | timestamptz, not null | When the code stops being valid |
| consumed_at | timestamptz | Marker that the OTP was redeemed (prevents double-redemption) |

Composite primary key over `(email, issued_at)`. Index `email_otps_email_idx` on `email` for cheap lookup of the live row.

### Table: forward_schedules

Durable plan history. Soft-delete via `superseded_at`. Defined at `schema.ts:106`.

| Column | Type | Purpose |
|---|---|---|
| id | serial, primary key | Monotonic ordering |
| student_id | text, FK to students, cascade delete | Owner |
| schedule | jsonb, not null | Full `ForwardSchedule` snapshot |
| state | text, not null | The schedule's state string (e.g. `valid`, `valid-with-trade-offs`, `infeasible-draft`) |
| dpr_fingerprint | text, not null | Hash of the DPR that produced this plan |
| computed_at | timestamptz, not null | Wall-clock the planner stamped on the schedule |
| superseded_at | timestamptz | Null while the row is the live plan; set when a newer plan supersedes it |

Index `forward_schedules_student_active_idx` on `(student_id, computed_at)`.

### Table: schedule_preferences

One row per student — preferences are intent, not history. Defined at `schema.ts:124`.

| Column | Type | Purpose |
|---|---|---|
| student_id | text, primary key, FK to students, cascade delete | Owner |
| preferences | jsonb, not null | The current `SchedulePreferences` object (includes `pins[]`) |
| updated_at | timestamptz, not null, default now | Last write |

### Table: chat_messages

Append-only chat transcript. Defined at `schema.ts:139`.

| Column | Type | Purpose |
|---|---|---|
| id | serial, primary key | Monotonic ordering key for the timeline |
| student_id | text, FK to students, cascade delete | Owner |
| role | text, not null | `user`, `assistant`, or `system` |
| content | text, not null | The rendered message text |
| thinking_text | text | Optional extended-thinking content for assistant messages |
| tool_invocations | jsonb | Structured tool-call payloads attached to the message |
| validator_violations | jsonb | Structured validator violations attached to the message |
| pending_mutation_id | text | Optional reference to a still-pending `PendingProfileMutation` |
| created_at | timestamptz, not null, default now | Insert time |

Index `chat_messages_student_idx` on `(student_id, id)`.

### Table: pending_mutations (Phase 4 E6.3)

Durable staging for the deterministic plan-action propose→confirm round-trip. Defined at `schema.ts:151`; migration `0003_phase4_pending_mutations.sql`.

| Column | Type | Purpose |
|---|---|---|
| pending_mutation_id | text, primary key | The opaque UUID `runProposeStage` mints and the UI hands back to `/api/plan/confirm` |
| student_id | text, FK to students, **cascade delete** | Owner — powers the cross-tenant guard inside `take` |
| mutations | jsonb, not null | The exact `PlanMutation[]` the confirm re-applies atomically |
| created_at | timestamptz, not null | When the proposal was staged |
| expires_at | timestamptz, not null | `created_at + 10 min` (the TTL); a crashed mid-confirm flow ages out instead of leaking rows |

Indexes `pending_mutations_student_idx` on `student_id` and `pending_mutations_expires_idx` on `expires_at`.

This table **replaces the in-process `Map`** the plan-action orchestrator used pre-E6.3 (`planActionOrchestrator.ts`), so a staged proposal survives a process restart and is visible to a sibling instance in a multi-instance deploy. The single-use delete, the cross-tenant guard, and the TTL all live **inside** the store's `take` (see `PendingMutationStore` below and [plan-action-orchestrator.md](./plan-action-orchestrator.md) §6.6/§6.7). The `ON DELETE cascade` to `students` means a self-serve deletion / test-clear (`/api/session/delete`, `/api/session/clear`) also wipes any staged proposals.

## Per-store documentation

### ProfileStore — `profileStorePostgres.ts`

Implements the engine's `ProfileStore` interface. Owns the `students` row and the `audit_log` rows.

**get(studentId)** — Selects `profile` from `students` where the row matches. Returns the JSONB column cast to `StudentProfile` or null if no row exists or the column is null. (`profileStorePostgres.ts:20`)

**persistMutation(profile, audit, parsedDpr?)** — Runs as a single Drizzle transaction. Upserts the `students` row keyed on `studentId`: inserts when missing, updates the canonical columns (`declaredPrograms`, `visaStatus`, `catalogYear`, `homeSchool`, `flags`, `profile`, `updatedAt`) when present. When `parsedDpr` is supplied, the `parsed_dpr` column is co-written in the same upsert; when omitted, the column is left untouched so a profile-only mutation does not wipe a previously stored DPR. The same transaction inserts an `audit_log` row with `pendingMutationId`, `field`, `before`, `after`, and `confirmedAt`. (`profileStorePostgres.ts:31`)

**getParsedDpr(studentId)** — Selects `parsed_dpr` from `students`. Returns the JSONB cast to `DegreeProgressReport` or null. (`profileStorePostgres.ts:83`)

### ScheduleStore — `scheduleStorePostgres.ts`

Implements the engine's `ScheduleStore` interface. Owns `forward_schedules` and `schedule_preferences`.

**persistSchedule(studentId, schedule, dprFingerprint)** — Inside a transaction: (1) idempotently ensures the `students` row exists via insert-on-conflict-do-nothing; (2) updates every previously-live `forward_schedules` row for this student (i.e. those with null `superseded_at`) to set `superseded_at = now`; (3) inserts a fresh row with `schedule`, `state`, `dprFingerprint`, and the schedule's own `computedAt`. (`scheduleStorePostgres.ts:26`)

**loadLatestSchedule(studentId)** — Selects the single live row (`superseded_at IS NULL`) ordered by `computed_at DESC` and limit 1. Returns the schedule plus its `dprFingerprint` or null. (`scheduleStorePostgres.ts:62`)

**persistPreferences(studentId, prefs)** — Idempotently ensures the `students` row exists, then upserts `schedule_preferences` keyed on `studentId`. The full preferences object replaces whatever was there. (`scheduleStorePostgres.ts:87`)

**loadPreferences(studentId)** — Selects `preferences` from `schedule_preferences`. Returns the JSONB cast to `SchedulePreferences` or null. (`scheduleStorePostgres.ts:111`)

**clearScheduleForStudent(studentId)** — Hard-deletes every `forward_schedules` row for the student. Used by the Update-DPR flow when the new DPR invalidates all prior plans. (`scheduleStorePostgres.ts:122`)

### ChatHistoryStore — `chatHistoryStorePostgres.ts`

Implements the engine's `ChatHistoryStore` interface. Owns `chat_messages`.

**appendMessage(studentId, message)** — Ensures the `students` FK target exists (insert-on-conflict-do-nothing), then inserts a single `chat_messages` row. All optional fields (`thinkingText`, `toolInvocations`, `validatorViolations`, `pendingMutationId`) are explicitly nulled when absent on the input record. (`chatHistoryStorePostgres.ts:22`)

**loadRecentMessages(studentId, limit = 50)** — Selects the last N rows for the student ordered by `id DESC`, then reverses the array in JS so the caller sees chronological order (oldest first). Optional columns are filtered out of the output if they came back null. (`chatHistoryStorePostgres.ts:46`)

**clearForStudent(studentId)** — Hard-deletes every `chat_messages` row for the student. (`chatHistoryStorePostgres.ts:91`)

**loadAllForTest(studentId)** — Test-only helper. Loads every row ordered by `id ASC` with no limit. (`chatHistoryStorePostgres.ts:102`)

### SessionStore — `sessionStorePostgres.ts`

Implements the engine's `SessionStore` interface. Owns `session_summaries` and also bumps `students.last_session_date`. Mirrors the rolling-window behavior of the engine's `FileBackedSessionStore` (`MAX_SESSION_SUMMARIES` = 5).

**get(studentId)** — Selects up to `MAX_SESSION_SUMMARIES * 4` rows ordered by `id ASC` (defensive cap; the trim below normally keeps the count at 5). Slices the tail to keep only the last 5 and returns a `StudentSessionRecord` with `lastSessionDate` set from the most-recent date. (`sessionStorePostgres.ts:22`)

**appendSummary(studentId, summary)** — Ensures the `students` row exists, inserts the new `session_summaries` row, updates `students.last_session_date` and `students.updated_at`, then trims the window. Returns the freshly loaded record. (`sessionStorePostgres.ts:43`)

**replace(record)** — Replaces the entire window. Ensures the `students` row, deletes all existing summaries for the student, then bulk-inserts the new array (if non-empty). (`sessionStorePostgres.ts:58`)

**trim(studentId)** (private) — Selects the IDs of the latest `MAX_SESSION_SUMMARIES` rows for the student, then issues `DELETE FROM session_summaries WHERE student_id = X AND id NOT IN (those IDs)`. Survives concurrent inserts because the delete is a single statement. (`sessionStorePostgres.ts:86`)

### PendingMutationStore — `pendingMutationStore.ts` (Phase 4 E6.3)

Durable staging for the plan-action propose→confirm round-trip. Two implementations behind one interface, selected by `getStores`: `PostgresPendingMutationStore` (one row per staged proposal in `pending_mutations`) when a DB handle exists, `InMemoryPendingMutationStore` (a single-process `Map`, dev + offline tests) otherwise. `PENDING_MUTATION_TTL_MS` = 10 min mirrors the pre-E6.3 orchestrator Map.

**stage(entry)** — Runs a best-effort TTL sweep, then writes/upserts a row (`pendingMutationId`, `studentId`, the `PlanMutation[]`, `createdAt`, `expiresAt = createdAt + TTL`). (`pendingMutationStore.ts:96`/`:158`)

**take(pendingMutationId, studentId)** — The single security-critical seam. **Atomically** read-validates-tenant-checks-deletes, returning a discriminated `TakeResult`:
- `{ status: "ok", entry }` — the id exists, is unexpired, AND its `studentId` matches → the row is deleted (**single-use**) and the entry returned. The Postgres path does this as one tenant-scoped `DELETE … RETURNING` so the read and the single-use delete are one statement; a matched-but-expired row is treated as `not_found`.
- `{ status: "tenant_mismatch" }` — the id exists under a different student → the entry is left **intact** for its rightful owner (the orchestrator maps this to `studentId_mismatch` → 403). The Postgres path disambiguates this from `not_found` with a read-only existence probe after the tenant-scoped delete deletes nothing.
- `{ status: "not_found" }` — unknown or expired id (orchestrator → `unknown_mutation_id` → 404).

This pulls the cross-tenant guard + single-use delete + TTL out of the orchestrator and makes them atomic with the read (`pendingMutationStore.ts:101`/`:182`).

**sweepExpired(now?)** — Drops entries older than the TTL. Best-effort housekeeping; also runs implicitly on every `stage`. (`pendingMutationStore.ts:113`/`:237`)

The in-memory variant also exposes test-only affordances (`clearForTests`, `sizeForTests`, `expireAllForTests`) used by the orchestrator's `_resetPendingMutationsForTests` / `_pendingMutationsSizeForTests` helpers.

## The DB client — `client.ts`

A lazy module-level singleton over Neon's serverless driver.

The first call to `getDb(env)` reads `DATABASE_URL` from the supplied env (defaulting to `process.env`). If the URL is missing, returns null and callers are expected to use the in-memory fallback. Otherwise constructs a Neon `Pool` over the URL, wraps it with the `drizzle-orm/neon-serverless` adapter, caches both, and returns the Drizzle instance. (`client.ts:40`)

Because the Neon serverless driver opens WebSocket connections under the hood, the file boots by wiring a WebSocket constructor into `neonConfig`. Node 22+ has a built-in global `WebSocket`; on older runtimes it falls back to `require("ws")`. (`client.ts:26`)

`closeDb()` is a test-only helper that ends the pool and resets the cache. `getDbStatus()` returns `{ connected, cachedAt }` for ops introspection.

## Migration story

Migrations are managed by `drizzle-kit`. The config lives at `apps/web/drizzle.config.ts`:

- Schema source: `./lib/db/schema.ts`
- Output directory for generated migrations: `./drizzle`
- Dialect: `postgresql`
- Connection: `DATABASE_URL` from the environment, defaulting to an empty string when missing
- `strict: true` — drizzle-kit will fail closed on schema diffs that look risky

This is the standard drizzle-kit setup: editing `schema.ts` and running the kit's generate command produces a new SQL file under `apps/web/drizzle/`. The runtime app itself doesn't apply migrations — that's an out-of-band deploy step.

### Applying migrations — the `db:migrate` deploy step (E6.2)

`apps/web/package.json` exposes a single migration script:

```json
"db:migrate": "drizzle-kit migrate"
```

`drizzle-kit migrate` is the **apply** command (not `generate`, which only writes a new SQL file, nor `push`, which diffs the schema straight onto the DB without going through the journal). It reads the `DATABASE_URL` from `drizzle.config.ts`, walks the journal at `apps/web/drizzle/meta/_journal.json`, and applies any not-yet-applied SQL files (`0000_strong_riptide.sql` → `0001_phase16_persistence.sql` → `0002_drop_cohort.sql` → `0003_phase4_pending_mutations.sql`) **in journal order**, tracking what it has applied in drizzle's bookkeeping table.

`0003_phase4_pending_mutations.sql` (journal idx 3, Phase 4 E6.3) is **additive** — it creates the `pending_mutations` table + its two indexes and adds the `ON DELETE cascade` FK to `students`. Unlike `0002` it drops nothing.

**How an operator runs it** (the live run is gated by E6.1 — provisioning the Neon `DATABASE_URL`):

```sh
# from the repo root
DATABASE_URL='postgres://…neon…' pnpm --filter web db:migrate
# or, from apps/web:
DATABASE_URL='postgres://…neon…' npm run db:migrate
```

> ⚠️ **DESTRUCTIVE — `0002_drop_cohort.sql` drops a data column.** Migration `0002` is not additive. It runs three statements:
> 1. `DROP TABLE "cohort_assignments" CASCADE;`
> 2. `ALTER TABLE "students" DROP COLUMN "parsed_transcript";`
> 3. `DROP TYPE "public"."cohort";`
>
> Statement 2 **permanently deletes the `students.parsed_transcript` column and all of its data.** This is **expected and intended** — `parsed_transcript` is a dead column (the engine reads `parsed_dpr`, not `parsed_transcript`) and the `cohort` subsystem was removed. But an operator applying `0002` to a **pre-existing 0001-era database** WILL lose whatever was in `parsed_transcript`. There is no rollback. Confirm this is acceptable before running `db:migrate` against a populated DB.

**Fresh Neon baseline vs. running the `0000→0001→0002` sequence — pick the right path.** These two paths diverge and must not be mixed:

- **A brand-new / empty Neon branch (the supported path):** run the **full journaled sequence** with `db:migrate`. It applies `0000 → 0001 → 0002 → 0003` in order, leaving the journal and drizzle's applied-migrations table internally consistent. Because `0002` drops a table/column/type that `0000`+`0001` created, the net end-state on a fresh DB is identical to the current `schema.ts`, just reached by build-then-drop. **Do this** — it keeps every environment on the same migration history.
- **Do NOT hand-apply a squashed baseline.** If you instead let drizzle-kit `generate` a single fresh baseline from the current `schema.ts` and apply only that, the resulting journal will have **one** entry (`0000_*`) rather than four. That database can never again receive the real `0001`/`0002`/`0003` files (their tags aren't in its journal), so it permanently diverges from every other environment and from the repo's `drizzle/` history. Squashing the migration history is a deliberate, repo-wide decision — not something an operator does ad hoc while provisioning one Neon branch.

In short: **one history, applied in full via `db:migrate`.**

> ⚠️ **Observed: a DB set up via `push` has an INCONSISTENT drizzle journal.** During the Phase-4 E6 live exit-gate runs (E6.5/E6.6), the provisioned test Neon had been initialized with `drizzle-kit push` (schema diffed straight onto the DB, bypassing the journal). Its `__drizzle_migrations` bookkeeping table held **only 1 row**, not one per applied tag — so `drizzle-kit migrate` tried to **re-run `0000`** and conflicted on already-existing objects. This is exactly the "fresh-baseline vs. sequence divergence" warned about above: a `push`-initialized DB is NOT on the journaled history. To recover, an operator must either **reconcile the journal** (mark `0000`–`0002` as already-applied in `__drizzle_migrations`) before running `db:migrate`, or — as was done for the additive `0003` on the test branch — **apply the additive migration's SQL directly** and record its tag. Provision live environments from an **empty branch via `db:migrate`** (never `push`) so this divergence never arises.

## Live-Neon tests (Phase 4 E6.5 / E6.6 — the EXIT-GATE-#2 pair)

Until Phase 4, **every** DB test ran offline (the offline suites `delete process.env.DATABASE_URL` so they exercise the in-memory / Stub path). Phase 4 added the first two tests that run against a **real Postgres** (a Neon branch), both in `apps/web/tests/`:

- **`e2eConfirmPersist.test.ts` (E6.5 — EXIT GATE #2).** The end-to-end propose→confirm→persist round-trip against live Neon. It is the **first live exercise** of the E6.3 `PostgresPendingMutationStore` (durable `pending_mutations` staging), the supersede-then-insert `PostgresScheduleStore.persistSchedule`, the Decision-#32 restore routing (valid → `forwardSchedule`; draft → `studentDraftPlan`), the `schedule_preferences` upsert, and the `audit_log` append. **PASSED live** against the provisioned Neon branch.
- **`otpLoginSmoke.test.ts` (E6.6).** The email-OTP login round-trip against live Neon — `issueOtp` writes a `sha256(code)` row into `email_otps` (with `RESEND_API_KEY=__test__` it skips the Resend network and surfaces the code as `debugCode`), `verifyOtp` consumes it single-use, upserts a `students` row, and mints a signed HS256 JWT. **PASSED live**, confirming "leaving the memory fallback" is sound for auth (the companion to E6.5).

Both are **gated INVERTED from the offline suites** — `describe.skipIf(!process.env.DATABASE_URL)` — so they **RUN ONLY when a real `DATABASE_URL` is wired** and **SKIP in the default `npx vitest run`** (the offline suite stays green at the same pass count, adding exactly one SKIPPED test each). Both are **self-cleaning** (fixed, clearly-test-scoped ids; wipe their own rows in `beforeAll` + `afterAll` via a direct `getDb()` transaction — idempotent, no residue) and bake in a **120-second** per-hook/per-test timeout because live Neon round-trips over WebSocket are slow (~20–30 s).

To run them live: provision a Neon branch, apply all of `0000..0003` (so `pending_mutations` + `email_otps` exist — see the runbook caveat above), then `DATABASE_URL=… npx vitest run apps/web/tests/e2eConfirmPersist.test.ts apps/web/tests/otpLoginSmoke.test.ts` from the repo root.

## The store factory — `store.ts`

`getStores(env)` returns a `StoreBundle` containing the four engine-required stores. It is memoized at module scope so subsequent calls reuse the same bundle (and the same connection pool).

The branching logic is:

1. Call `getDb(env)`. If a Drizzle handle comes back:
   - Build the bundle with `PostgresSessionStore`, `PostgresProfileStore`, `PostgresScheduleStore`, `PostgresChatHistoryStore`, and `PostgresPendingMutationStore` (E6.3).
2. Otherwise, build an in-memory bundle:
   - `sessionStore` is either `FileBackedSessionStore` (if `NYUPATH_SESSION_STORE_PATH` is set) or `InMemorySessionStore`.
   - The others are the engine's `InMemoryProfileStore`, `InMemoryScheduleStore`, `InMemoryChatHistoryStore`, plus the web-layer `InMemoryPendingMutationStore`.

`resetStoresForTests()` clears the cache so the next call rebuilds. (`store.ts:79`)

## Diagram

```mermaid
flowchart TD
    Route[Chat / Plan API route] --> Factory[getStores]
    Factory --> Client[getDb]
    Client -- DATABASE_URL set --> Pool[Neon Pool + Drizzle]
    Client -- no URL --> Null[null]
    Factory -- Pool present --> PG[Postgres bundle]
    Factory -- null --> InMem[In-memory / file-backed bundle]
    PG --> Profile[PostgresProfileStore]
    PG --> Schedule[PostgresScheduleStore]
    PG --> Chat[PostgresChatHistoryStore]
    PG --> Session[PostgresSessionStore]
    Profile --> Tables[(students + audit_log)]
    Schedule --> SchedT[(forward_schedules + schedule_preferences)]
    Chat --> ChatT[(chat_messages)]
    Session --> SessT[(session_summaries + students.last_session_date)]
```
