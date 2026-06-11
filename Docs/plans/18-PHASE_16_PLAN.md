# Phase 16 — Cross-Session Persistence + Update-DPR + Full-Degree Sidebar

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Architectural principle (read first)

**The student onboards once; everything they did persists across logins.** Phase 15 left the planner usable but session-scoped — every login wiped the schedule, the chat history, and any pinned preferences, forcing a re-upload of the DPR and a re-onboard. Phase 16 makes the in-memory `ToolSession` a *cache* of durable Postgres state. The student's profile, parsed DPR, forward schedule, schedule preferences, and chat history all round-trip through the database.

This phase introduces **no new planning logic**. Every planner / validator / tool behavior from Phase 13–15 is preserved. The change is purely persistence + the UX flows that consume it.

The DPR is re-parsed only when the student explicitly clicks **Update DPR** (a new sidebar affordance). Phase 16's `dprFingerprint` helper exists *for that flow only* — it lets the Update-DPR route detect whether the new upload meaningfully differs from the stored DPR and decide whether to discard the existing schedule. Login does **not** invoke the fingerprint check; it just restores whatever's in the DB.

A test-affordance **Clear** button (gated on `NEXT_PUBLIC_ENABLE_TEST_CLEAR=1`) wipes every per-student row across all Phase 16 tables so we can re-run the onboarding flow during development without manually truncating the database.

**Before implementing:** read `docs/PHASE_PLANS_README.md` for the cross-phase decision list + pre-flight checks. The pre-flight checks must pass before the first code change in this phase.

---

**Goal:** Make NYU Path durable across logins. The student uploads their DPR once, walks the onboarding flow once, and every subsequent login lands them in the same state — same chat transcript, same schedule sidebar, same preferences. The sidebar is upgraded to show the entire degree (historical + in-progress + future + transfer credits) with grade/status on every row, edit gating that locks completed terms, and a more polished visual treatment.

**Architecture:** Three new persistence stores (`ScheduleStore`, `ChatHistoryStore`, plus a new column on the existing `students` table for the parsed DPR), one new restore route (`/api/session/restore`), one new wipe route (`/api/session/clear`), one new Update-DPR route (`/api/onboard/refresh-dpr`), and a sidebar render that joins persisted history with the live forward schedule. Mirrors the existing `ProfileStore` pattern from Phase 7-B Step 10 — no new architectural concepts.

---

## Decisions referenced in this phase

| # | Decision | Source |
|---|---|---|
| 32 | 4-state `PlanState` union (valid-clean / valid-with-trade-offs / infeasible-draft / student-preferred-invalid-draft) — drives which slot the persisted schedule lands in. | Phase 13 |
| 40 | `ValidationResult` 4-state union — preserved verbatim through persistence. | Phase 13 |
| 43 | `SchedulingPreferences` (time/day filters) — persisted as part of `SchedulePreferences` row so they survive across sessions. | Phase 14/15 |

No new decisions in Phase 16.

---

## Locked design choices (confirmed before implementation)

1. **Update-DPR pin pruning:** when the student uploads a new DPR and the fingerprint differs from the stored one, the schedule is dropped entirely and the schedule preferences have only their `pins` array filtered to drop entries whose `courseId` is now in the completed-course set per the new DPR. `loadStyle`, `loadStylePerTerm`, `creditTargetPerTerm`, `exclusions`, `includeSummer`, `includeJTerm`, `allowBelowF1Floor`, and `schedulingPreferences` all survive the wipe.
2. **DPR fingerprint algorithm:** SHA256 of a canonical JSON of `{ courseHistory (sorted), cumulative, programs }`. Course-history rows are flattened to `${term}|${subject}|${catalogNbr}|${units}|${grade ?? ""}|${type}` and lexicographically sorted before hashing so a re-parse with shuffled order yields the same hash. The helper lives in `packages/engine/src/dpr/fingerprint.ts` and is invoked **only** by the Update-DPR route — login does not need it.
3. **Prior Credits card content:** every `type=TE` row from the DPR's course history renders as one card entry: `${subject} ${catalogNbr} — ${units} cr`. No grade column for transfer credits (the DPR doesn't carry one).
4. **Edit-permission rule:** a slot is editable iff `slot.kind !== "completed"`. In-progress courses, specific-planned future courses, and placeholder slots are all editable. Completed courses are locked (lock icon, popover suppressed).
5. **Chat-history persistence:** every chat turn (user message + assistant message + tool invocations + validator violations) appends to a `chat_messages` table. Login restores the most-recent-N messages (default `N = 50`, configurable via `NYUPATH_CHAT_HISTORY_RESTORE_LIMIT`). Older messages remain in the DB for audit but aren't restored to the UI.
6. **Test-clear affordance:** a **Clear** button at the bottom of the sidebar, hidden behind `NEXT_PUBLIC_ENABLE_TEST_CLEAR=1`, wipes every per-student row across `students`, `forward_schedules`, `schedule_preferences`, `chat_messages`, `audit_log`, and `session_summaries`. Confirms via dialog before firing.

---

## Schema additions (one Drizzle migration: `0001_phase16_persistence.sql`)

```sql
ALTER TABLE students
    ADD COLUMN parsed_dpr jsonb;

CREATE TABLE forward_schedules (
    id              SERIAL PRIMARY KEY,
    student_id      TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
    schedule        JSONB NOT NULL,
    state           TEXT NOT NULL,
    dpr_fingerprint TEXT NOT NULL,
    computed_at     TIMESTAMP WITH TIME ZONE NOT NULL,
    superseded_at   TIMESTAMP WITH TIME ZONE
);
CREATE INDEX forward_schedules_student_active_idx
    ON forward_schedules(student_id, computed_at);

CREATE TABLE schedule_preferences (
    student_id  TEXT PRIMARY KEY REFERENCES students(student_id) ON DELETE CASCADE,
    preferences JSONB NOT NULL,
    updated_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE chat_messages (
    id            SERIAL PRIMARY KEY,
    student_id    TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
    role          TEXT NOT NULL,             -- "user" | "assistant" | "system"
    content       TEXT NOT NULL,
    thinking_text TEXT,                      -- assistant's chain-of-thought (if any)
    tool_invocations    JSONB,               -- ToolInvocation[] for this turn
    validator_violations JSONB,              -- Violation[] for this turn
    pending_mutation_id  TEXT,               -- pendingMutationId surfaced this turn (if any)
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX chat_messages_student_idx
    ON chat_messages(student_id, id);
```

**Rationale per table:**
- `students.parsed_dpr` — single most-recent parsed DPR per student. Updated by `confirm_profile_update` (initial upload) and `/api/onboard/refresh-dpr` (Update-DPR). Stored alongside the existing `students.profile` JSONB so login restore reads from one row.
- `forward_schedules` — soft-delete (supersede) pattern, mirrors the audit philosophy used by `audit_log`. The latest non-superseded row is the live plan; older rows remain for analytics + cohort eval.
- `schedule_preferences` — single row per student, upsert. Preferences are *intent*, not history; the latest write replaces the prior version. (Audit trail of pref changes goes into the existing `audit_log` separately.)
- `chat_messages` — append-only, monotonically-increasing `id` orders the timeline. JSONB columns carry the structured side-effects (tool invocations, validator violations) so the rendered transcript matches what the student saw last session, including the click-to-confirm UI for any still-pending profile mutations.

---

## Tasks

### Task 16.A — Persistence layer (write side + tool wiring)

**Files (create):**
- `packages/engine/src/persistence/scheduleStore.ts` — `ScheduleStore` interface + `InMemoryScheduleStore` + `pruneCompletedPins` helper.
- `packages/engine/src/persistence/chatHistoryStore.ts` — `ChatHistoryStore` interface + `InMemoryChatHistoryStore`.
- `packages/engine/src/dpr/fingerprint.ts` — `computeDprFingerprint(report)` SHA256 helper.
- `apps/web/lib/db/scheduleStorePostgres.ts` — Drizzle impl.
- `apps/web/lib/db/chatHistoryStorePostgres.ts` — Drizzle impl.
- `apps/web/drizzle/0001_phase16_persistence.sql` — migration.
- `packages/engine/tests/persistence/scheduleStore.test.ts` — InMemory store tests.
- `packages/engine/tests/persistence/chatHistoryStore.test.ts` — InMemory store tests.
- `packages/engine/tests/dpr/fingerprint.test.ts` — determinism + change-detection tests.
- `apps/web/tests/scheduleStorePostgres.test.ts` — Postgres impl tests using a stub `Database`.
- `apps/web/tests/chatHistoryStorePostgres.test.ts` — Postgres impl tests using a stub `Database`.

**Files (modify):**
- `apps/web/lib/db/schema.ts` — add three table definitions + `parsed_dpr` column on `students`.
- `packages/engine/src/persistence/index.ts` (or whatever the existing barrel is) — export new types.
- `packages/engine/src/index.ts` — re-export from public engine barrel.
- `packages/engine/src/dpr/index.ts` — re-export `computeDprFingerprint`.
- `packages/engine/src/agent/tool.ts` — add `scheduleStore?: ScheduleStore` and `chatHistoryStore?: ChatHistoryStore` to `ToolSession`.
- `packages/engine/src/agent/tools/planForwardDegree.ts` — after `session.forwardSchedule = ...`, call `await session.scheduleStore?.persistSchedule(student.id, schedule, computeDprFingerprint(session.degreeProgressReport!))`. Wrap in try/catch matching the no-throw pattern in `confirmProfileUpdate.ts:254-267`.
- `packages/engine/src/agent/tools/confirmPlanChange.ts` — same persistSchedule call after the schedule mutation; ALSO `persistPreferences` if the mutation touched `session.schedulePreferences`.
- `packages/engine/src/agent/tools/confirmProfileUpdate.ts` — when the mutated field is the initial onboarding (`homeSchool` / `catalogYear` / `declaredPrograms` / `visaStatus` confirmed AND `session.degreeProgressReport` is set), persist the parsed DPR onto the `students.parsed_dpr` column via the existing `profileStore.persistMutation` path (extend the persist signature to accept the DPR optionally).
- `apps/web/lib/db/store.ts` — add `scheduleStore` + `chatHistoryStore` to `StoreBundle`; wire Postgres + InMemory variants.
- `apps/web/app/api/chat/v2/route.ts` — pass `scheduleStore` + `chatHistoryStore` into the session bootstrap (next to the existing `profileStore: stores.profileStore` line near line 263). After each chat turn finishes, append the user message + assistant response + tool invocations + validator violations to `chatHistoryStore`.

#### Behavior

The agent's `plan_forward_degree` and `confirm_plan_change` tools currently write `session.forwardSchedule` (or `session.studentDraftPlan`) but the schedule is lost when the session ends. After this task:

1. Both tools persist the schedule + preferences through `ScheduleStore`.
2. `confirm_profile_update` persists the parsed DPR onto `students.parsed_dpr` so future logins can restore without re-parsing.
3. The v2 chat route appends every turn (user + assistant + tool invocations + validator violations + thinking text) to `chat_messages` via `ChatHistoryStore`.
4. The fingerprint helper exists but is invoked only by Task 16.B's Update-DPR route.

#### `ScheduleStore` interface

```typescript
import type { ForwardSchedule, SchedulePreferences } from "@nyupath/shared";

export interface ScheduleStore {
    /** Persist the latest schedule. Implementations soft-delete prior
     *  rows (supersededAt = now()) so the audit trail is preserved
     *  but loadLatestSchedule only sees the live row. */
    persistSchedule(studentId: string, schedule: ForwardSchedule, dprFingerprint: string): Promise<void>;

    /** Read the latest non-superseded schedule. Returns null when none. */
    loadLatestSchedule(studentId: string): Promise<{ schedule: ForwardSchedule; dprFingerprint: string } | null>;

    /** Persist preferences. Upsert on (studentId). */
    persistPreferences(studentId: string, prefs: SchedulePreferences): Promise<void>;

    /** Read preferences. Returns null when none. */
    loadPreferences(studentId: string): Promise<SchedulePreferences | null>;

    /** Wipe the stored schedule for a student (Update-DPR fingerprint mismatch).
     *  Preferences are NOT cleared by this call — caller decides via prunePins. */
    clearScheduleForStudent(studentId: string): Promise<void>;
}

/** Pure helper: drop pins whose courseId is in the completed-course set,
 *  keep everything else (loadStyle / exclusions / schedulingPreferences / etc). */
export function pruneCompletedPins(
    prefs: SchedulePreferences,
    completedCourseIds: Set<string>,
): SchedulePreferences;
```

#### `ChatHistoryStore` interface

```typescript
export interface ChatMessageRecord {
    role: "user" | "assistant" | "system";
    content: string;
    thinkingText?: string;
    toolInvocations?: ToolInvocation[];
    validatorViolations?: Array<{ kind: string; detail: string; caveatId?: string }>;
    pendingMutationId?: string;
    createdAt: string; // ISO
}

export interface ChatHistoryStore {
    /** Append one message to the student's chat history. */
    appendMessage(studentId: string, message: ChatMessageRecord): Promise<void>;
    /** Load the most-recent N messages for a student in chronological order. */
    loadRecentMessages(studentId: string, limit?: number): Promise<ChatMessageRecord[]>;
    /** Wipe every message for a student (test-affordance). */
    clearForStudent(studentId: string): Promise<void>;
}
```

#### Fingerprint helper

```typescript
import { createHash } from "node:crypto";
import type { DegreeProgressReport } from "./schema.js";

export function computeDprFingerprint(report: DegreeProgressReport): string {
    const canonical = JSON.stringify({
        courseHistory: [...report.courseHistory]
            .map((r) => `${r.term}|${r.subject}|${r.catalogNbr}|${r.units}|${r.grade ?? ""}|${r.type}`)
            .sort(),
        cumulative: report.cumulative,
        programs: report.programs ?? [],
    });
    return createHash("sha256").update(canonical).digest("hex");
}
```

#### Step-by-step

- [ ] Pre-flight read: `apps/web/lib/db/{schema.ts, profileStorePostgres.ts, store.ts}`, `packages/engine/src/persistence/profileStore.ts`, `packages/engine/src/agent/tool.ts`, `packages/engine/src/agent/tools/{planForwardDegree.ts, confirmPlanChange.ts, confirmProfileUpdate.ts}`, `packages/shared/src/types.ts:1024-1080` (ForwardSchedule + SchedulePreferences shapes).
- [ ] Add Drizzle table definitions to `schema.ts` matching the SQL above. Run `pnpm --filter web exec drizzle-kit generate` to autogenerate the SQL migration; verify the generated file matches the `0001_phase16_persistence.sql` shape above. If drizzle-kit isn't reachable, hand-write the migration in the same style as `0000_strong_riptide.sql`.
- [ ] Implement `computeDprFingerprint` + tests (determinism, change-detection on course-history mutation, change-detection on cumulative-stats mutation, no-change on row reorder).
- [ ] Implement `ScheduleStore` + `InMemoryScheduleStore` + `pruneCompletedPins` + tests.
- [ ] Implement `ChatHistoryStore` + `InMemoryChatHistoryStore` + tests.
- [ ] Implement `PostgresScheduleStore` + `PostgresChatHistoryStore` against a stub `Database` mirroring `profileStorePostgres.test.ts` style (transaction patterns, column names, soft-supersede semantics).
- [ ] Wire `ToolSession.scheduleStore` + `ToolSession.chatHistoryStore`; thread through `apps/web/lib/db/store.ts` factory; pass into the v2 route session bootstrap.
- [ ] Modify `plan_forward_degree.call()` and `confirm_plan_change.call()` to persist after success. Wrap in try/catch — failures log a warning, never throw.
- [ ] Modify `confirm_profile_update.call()` to persist the parsed DPR alongside the profile mutation when the DPR is loaded for the first time.
- [ ] Modify the v2 route to append each chat turn to `chatHistoryStore` after it completes (after the SSE `done` event is written, before `writer.close()`).
- [ ] Run the full engine + apps/web test suite. Confirm the 4 pre-existing failures (`phase3.test.ts × 3` + `semesterPlanner.test.ts × 1`) are unchanged. Confirm TS errors stay at engine 8 / web 9.

#### Verification

```bash
cd "/Users/edoardomongardi/Desktop/Ideas/NYU Path"
node_modules/.bin/vitest run \
    packages/engine/tests/persistence/scheduleStore.test.ts \
    packages/engine/tests/persistence/chatHistoryStore.test.ts \
    packages/engine/tests/dpr/fingerprint.test.ts \
    apps/web/tests/scheduleStorePostgres.test.ts \
    apps/web/tests/chatHistoryStorePostgres.test.ts \
    apps/web/tests/buildSessionFromDpr.test.ts \
    packages/engine/tests/eval/phase5.test.ts
npx tsc --noEmit -p packages/engine 2>&1 | grep "error TS" | wc -l   # expect 8
npx tsc --noEmit -p apps/web 2>&1 | grep "error TS" | wc -l          # expect 9
```

#### Commit

```bash
git add -A packages/engine/src/persistence/ \
       packages/engine/src/dpr/fingerprint.ts \
       packages/engine/src/dpr/index.ts \
       packages/engine/src/index.ts \
       packages/engine/src/agent/tool.ts \
       packages/engine/src/agent/tools/planForwardDegree.ts \
       packages/engine/src/agent/tools/confirmPlanChange.ts \
       packages/engine/src/agent/tools/updateProfile.ts \
       packages/engine/tests/persistence/ \
       packages/engine/tests/dpr/fingerprint.test.ts \
       apps/web/lib/db/schema.ts \
       apps/web/lib/db/scheduleStorePostgres.ts \
       apps/web/lib/db/chatHistoryStorePostgres.ts \
       apps/web/lib/db/store.ts \
       apps/web/app/api/chat/v2/route.ts \
       apps/web/drizzle/ \
       apps/web/tests/scheduleStorePostgres.test.ts \
       apps/web/tests/chatHistoryStorePostgres.test.ts

git commit -m "feat(engine+web): persistence layer for schedule + chat history + parsed DPR (Phase 16 Task A)

Adds three new stores so a student's planning state survives across
logins. Mirrors the existing ProfileStore pattern.

Schema (apps/web/drizzle/0001_phase16_persistence.sql):
- ALTER students ADD COLUMN parsed_dpr jsonb (stored alongside the
  existing profile JSONB so login restore reads from one row)
- forward_schedules (soft-delete via superseded_at; latest wins on read)
- schedule_preferences (one row per student; upsert)
- chat_messages (append-only timeline)

Engine:
- ScheduleStore + InMemoryScheduleStore + pruneCompletedPins helper
- ChatHistoryStore + InMemoryChatHistoryStore
- computeDprFingerprint(report) SHA256 helper (used by Phase 16 Task B's
  Update-DPR route to detect meaningful DPR changes; not invoked at login)
- ToolSession.scheduleStore + .chatHistoryStore optional fields
- plan_forward_degree, confirm_plan_change persist after success
- confirm_profile_update persists the parsed DPR alongside the profile

Web:
- PostgresScheduleStore + PostgresChatHistoryStore Drizzle impls
- store.ts factory wires Postgres / InMemory variants
- v2 route appends every chat turn to chat_messages

Phase 16 Task B (login restore + Update-DPR + Clear) reads from this
layer; Task C (full-degree sidebar) renders the restored state.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 16.B — Login restore + Update-DPR + Clear

**Files (create):**
- `apps/web/app/api/session/restore/route.ts` — GET; returns `{ profile, dpr, forwardSchedule, schedulePreferences, chatMessages }` for the authenticated student.
- `apps/web/app/api/session/clear/route.ts` — DELETE; wipes every per-student row across all tables. Gated on `NEXT_PUBLIC_ENABLE_TEST_CLEAR=1` server-side AND a confirm dialog client-side.
- `apps/web/app/api/onboard/refresh-dpr/route.ts` — POST; accepts a new DPR PDF, parses, fingerprint-compares with stored, drops schedule + prunes pins on mismatch, kicks off `plan_forward_degree` automatically, returns the new schedule via the existing SSE pattern.
- `apps/web/tests/sessionRestoreRoute.test.ts` — restore route tests.
- `apps/web/tests/sessionClearRoute.test.ts` — clear route tests (incl. env-flag gating).
- `apps/web/tests/refreshDprRoute.test.ts` — Update-DPR route tests (fingerprint match → no-op; mismatch → schedule cleared + replan triggered).

**Files (modify):**
- `apps/web/app/chat/page.tsx` — on mount, fetch `/api/session/restore`. If `dpr` is non-null, skip the onboarding flow (no DPR upload prompt, no F-1 question, no graduation-term question), hydrate `forwardSchedule` + `forwardMaterialization` (no — materialization stays ephemeral) state from the response, render the chat history into `messages[]`, and idle waiting for input.
- `apps/web/app/chat/scheduleSidebar.tsx` — add **Update DPR** button at the top of the sidebar (file-input-as-button); add **Clear** button at the bottom (visible only when `process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR === "1"`).
- `apps/web/app/chat/chat.module.css` — styles for the two new buttons, matching the existing `loadStylePill` aesthetic.

#### Behavior

##### Login restore

`/api/session/restore` (GET):
1. Identify the student via the existing auth session.
2. Read `students.profile` + `students.parsed_dpr` from `ProfileStore`.
3. Read latest `forward_schedules` row from `ScheduleStore`.
4. Read `schedule_preferences` row from `ScheduleStore`.
5. Read most-recent N `chat_messages` rows from `ChatHistoryStore` (default `N = 50`).
6. Return:
   ```json
   {
       "profile": StudentProfile | null,
       "dpr": DegreeProgressReport | null,
       "forwardSchedule": ForwardSchedule | null,
       "studentDraftPlan": ForwardSchedule | null,
       "schedulePreferences": SchedulePreferences | null,
       "chatMessages": ChatMessageRecord[]
   }
   ```

If `profile === null`, the student is new — page falls through to the existing onboarding flow.

If `profile` is present but `dpr === null`, something went wrong (profile saved without DPR — pre-Phase-16 data); page treats as a re-onboard.

If both are present, page hydrates everything and renders the chat at the most-recent message.

##### Update-DPR

Sidebar's **Update DPR** button opens a file picker. On selection, page POSTs the PDF to `/api/onboard/refresh-dpr`. Route:
1. Parse the PDF via the existing onboard parser path.
2. Compute the new DPR fingerprint.
3. Compare with the stored `forward_schedules.dprFingerprint` (if any).
4. **If match** → respond `{ changed: false }`. UI shows "No changes detected" toast; nothing else happens.
5. **If mismatch (or no stored schedule)** →
   - Persist the new parsed DPR onto `students.parsed_dpr`.
   - Clear the stored schedule (`scheduleStore.clearScheduleForStudent`).
   - Load the existing `schedulePreferences`; apply `pruneCompletedPins(prefs, newCompletedIds)`; persist back.
   - Run `plan_forward_degree` programmatically using the new DPR + pruned preferences.
   - Persist the new schedule via `scheduleStore.persistSchedule`.
   - Stream the result back via the existing `forward_schedule_update` SSE event so the sidebar updates without a reload.
   - Respond `{ changed: true, schedule: ForwardSchedule | studentDraftPlan }`.

##### Clear

Sidebar's **Clear** button (visible only when env flag is set) opens a confirm dialog: "Wipe ALL data for this student? This cannot be undone." On confirm, page DELETEs `/api/session/clear`. Route:
1. Verify `NEXT_PUBLIC_ENABLE_TEST_CLEAR=1` server-side (fail with 403 otherwise).
2. Identify the student via auth.
3. In a single transaction, DELETE every row across `students`, `forward_schedules`, `schedule_preferences`, `chat_messages`, `audit_log`, `session_summaries`, `cohort_assignments` for that student.
4. Respond `{ ok: true }`. Page reloads to the onboarding state.

#### Step-by-step

- [ ] Pre-flight read: `apps/web/app/chat/page.tsx` (the existing onboarding flow + state shapes), `apps/web/app/api/onboard/route.ts` (existing DPR upload path), `apps/web/lib/auth/*` (whatever exposes the authenticated student id).
- [ ] Implement `/api/session/restore` route + tests.
- [ ] Implement `/api/session/clear` route + tests (incl. env-flag gating + confirm-on-the-server).
- [ ] Implement `/api/onboard/refresh-dpr` route + tests (fingerprint match no-op; mismatch full path; pin pruning).
- [ ] Modify `page.tsx` to hit `/api/session/restore` on mount; conditionally skip onboarding; hydrate state.
- [ ] Modify `scheduleSidebar.tsx` to add Update-DPR + Clear buttons.
- [ ] Add CSS for the two buttons.
- [ ] Manual smoke-check the full flow in the dev server (Update-DPR with same file → no-op; Update-DPR with a modified file → schedule replans).

#### Verification

```bash
cd "/Users/edoardomongardi/Desktop/Ideas/NYU Path"
node_modules/.bin/vitest run \
    apps/web/tests/sessionRestoreRoute.test.ts \
    apps/web/tests/sessionClearRoute.test.ts \
    apps/web/tests/refreshDprRoute.test.ts \
    apps/web/tests/buildSessionFromDpr.test.ts
npx tsc --noEmit -p apps/web 2>&1 | grep "error TS" | wc -l   # expect 9
```

#### Commit

```bash
git add -A apps/web/app/api/session/ apps/web/app/api/onboard/refresh-dpr/ \
       apps/web/app/chat/page.tsx apps/web/app/chat/scheduleSidebar.tsx \
       apps/web/app/chat/chat.module.css \
       apps/web/tests/sessionRestoreRoute.test.ts \
       apps/web/tests/sessionClearRoute.test.ts \
       apps/web/tests/refreshDprRoute.test.ts

git commit -m "feat(web): login restore + Update-DPR + Clear (Phase 16 Task B)

Routes:
- GET /api/session/restore — profile + parsed DPR + latest schedule +
  preferences + last 50 chat messages for the authenticated student
- POST /api/onboard/refresh-dpr — fingerprint compare; on mismatch,
  clear schedule, prune pins on now-completed courses, replan, stream
  via the existing forward_schedule_update SSE event
- DELETE /api/session/clear — wipes every per-student row (gated on
  NEXT_PUBLIC_ENABLE_TEST_CLEAR=1; confirm-on-server)

Page bootstrap: page.tsx hits /api/session/restore on mount; hydrates
profile + dpr + schedule + preferences + chat history; skips onboarding
when state is non-null. Returning students drop straight back into the
last conversation.

Sidebar: Update DPR button (file-input) at top; Clear button at bottom
(test-affordance, env-flag gated, confirm dialog).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 16.C — Full-degree sidebar render

**Files (modify):**
- `apps/web/app/chat/scheduleSidebar.tsx` — render historical terms (from `student.coursesTaken` grouped by term) + current term IP rows + future terms (from `forwardSchedule.semesters`); separate **Prior Credits** card for AP/IB/transfer (`type=TE` rows); every row shows a grade/status cell; lock icon + suppressed popover on `kind: "completed"` slots.
- `apps/web/app/chat/chat.module.css` — styles for the new card layouts (Prior Credits card, locked-slot icon, grade column).

**Files (create — optional helpers):**
- `apps/web/lib/groupCoursesByTerm.ts` — pure helper that takes a `StudentProfile` + `ForwardSchedule` and returns a chronologically-ordered list of `{ term, slots, locked }` entries spanning history → current → future, with TE rows extracted separately as the Prior Credits payload.
- `apps/web/tests/groupCoursesByTerm.test.ts` — unit tests.

#### Behavior

The sidebar currently renders only `forwardSchedule.semesters` (future terms). After this task it renders:

1. **Prior Credits card** at the top — every `type=TE` row from the DPR's course history. One line per credit: `${subject} ${catalogNbr} — ${units} cr`. No grade column.
2. **Historical term cards** — one card per past term (`student.coursesTaken` grouped by `semester`). All slots are `kind: "completed"`. Lock icon, popover suppressed on click. Grade column shows the letter grade.
3. **Current term card** (if `student.currentSemester` is non-empty) — slots are `kind: "in_progress"`. **Editable** — click opens the existing popover. Grade column shows "IP".
4. **Future term cards** — `forwardSchedule.semesters` excluding any term that already appeared in #2 or #3. Slots are `kind: "specific_planned"` or `kind: "placeholder"`. Editable. Grade column shows "—".

Edit gating per Decision #16.4: a slot is editable iff `slot.kind !== "completed"`. The lock icon appears on completed slots; the popover is not opened on click.

The grade/status column is always present. Implemented as a fixed-width final column in the slot row layout for visual alignment across cards.

#### Step-by-step

- [ ] Pre-flight read: current `scheduleSidebar.tsx` render structure + `chat.module.css` slot layout.
- [ ] Implement `groupCoursesByTerm` pure helper + tests.
- [ ] Modify `scheduleSidebar.tsx`: replace the `schedule.semesters.map` with the grouped output. Render Prior Credits card first; then term cards in chronological order.
- [ ] Add edit gating: `if (slot.kind === "completed") return null;` inside the popover-open handler.
- [ ] Add lock-icon SVG (or unicode 🔒 to match existing emoji vocabulary) to the completed-slot row.
- [ ] Add the grade/status cell to every slot's row layout.
- [ ] CSS: Prior Credits card styling, lock icon positioning, grade column width.

#### Verification

```bash
cd "/Users/edoardomongardi/Desktop/Ideas/NYU Path"
node_modules/.bin/vitest run apps/web/tests/groupCoursesByTerm.test.ts
npx tsc --noEmit -p apps/web 2>&1 | grep "error TS" | wc -l   # expect 9
```

#### Commit

```bash
git add -A apps/web/app/chat/scheduleSidebar.tsx \
       apps/web/app/chat/chat.module.css \
       apps/web/lib/groupCoursesByTerm.ts \
       apps/web/tests/groupCoursesByTerm.test.ts

git commit -m "feat(web): sidebar shows full degree (history + current + future + transfer credits) (Phase 16 Task C)

Sidebar now renders the complete degree timeline, not just the
future-only forward plan:

- Prior Credits card lists every type=TE row from the DPR.
- Historical term cards (one per past term) show completed slots with
  letter grades; locked (no popover, lock icon).
- Current term card shows IP slots; editable (drop / withdraw / add).
- Future term cards (from forwardSchedule) show planned slots; editable.

Edit gating: slot.kind === \"completed\" → locked. Everything else
(in_progress, specific_planned, placeholder) is editable.

Every row has a grade/status column: completed → letter grade; IP → IP;
specific_planned/placeholder → \"—\". Visually aligned across cards.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 16.D — UI polish + manual verification + push

**Files (modify):**
- `apps/web/app/chat/scheduleSidebar.tsx` — add summary card at top (GPA + credits earned/required + expected graduation); per-slot tier color tint; sticky term headers when sidebar scrolls.
- `apps/web/app/chat/chat.module.css` — color palette tokens for workload tiers; sticky-header styles; tabular-numerals + monospace tweaks.

#### Behavior

##### Summary card

A new card at the very top of the sidebar (above Prior Credits):
```
Edoardo Mongardi
Computer Science / Math (BA)  •  CAS  •  F-1
GPA 3.402   •   138 / 128 credits
Graduating Spring 2027
[progress bar: 138/128]
```

Data sources: `student.id` (or stored display name from DPR), `student.declaredPrograms`, `student.homeSchool`, `student.visaStatus`, `dpr.cumulative.cumulativeGpa`, `dpr.cumulative.creditsUsed`, `dpr.cumulative.creditsRequired`, `forwardSchedule.graduationTerm`.

##### Tier color tint

Per-slot tint based on `slot.workloadTier`:
- `major-required` → indigo (`--tier-major-required: #4f46e5`)
- `major-elective` → violet (`--tier-major-elective: #7c3aed`)
- `school-core` → teal (`--tier-school-core: #0d9488`)
- `free-elective` → slate (`--tier-free-elective: #64748b`)
- `general-elective` → zinc (`--tier-general-elective: #71717a`)

Subtle: a 4px left border in the tier color, NOT a full background fill.

##### Sticky term headers

When the sidebar scrolls, the current term card's header pins to the top of the viewport (CSS `position: sticky; top: 0;` on `.semesterCardHeader`).

##### Typography

- Course IDs in monospace (`font-family: var(--font-mono)`).
- Credit counts use `font-variant-numeric: tabular-nums` so columns align.
- Numbers in the summary card use the same tabular treatment.

#### Manual verification (operator-driven)

After implementation, the operator runs the dev server and verifies the following scenarios. **No commit / push happens until all green.**

1. **Fresh start (Clear flow):** Click Clear → confirm dialog → reload → onboarding flow appears (DPR upload prompt). ✓
2. **Onboarding persistence:** Upload SAA_STD_DS.pdf → "yes" → "yes" → "spring 2027". Reload the page. Sidebar + chat history should be intact; no re-onboarding prompt. ✓
3. **Schedule persistence:** Send "Plan my full degree." Wait for the schedule to render. Reload. The 📅 Schedule button is present and the sidebar shows the same plan. ✓
4. **Preference persistence:** Send "Pin CSCI-UA 421 to Spring 2027." Confirm via the click flow. Reload. Send "What's pinned?" — agent reads the persisted pin. ✓
5. **Chat history restore:** Reload the page and confirm the last 50 messages render in order, including tool-trace pills + thinking text + any pending profile-update confirmations. ✓
6. **Update DPR (no change):** Click Update DPR → re-upload SAA_STD_DS.pdf → toast says "No changes detected". Schedule unchanged. ✓
7. **Update DPR (changed):** Edit the DPR fixture so a course flips from IP to A grade → upload via Update DPR → schedule re-plans automatically; the now-completed course moves into the historical card; pins on that course (if any) are dropped; other prefs survive. ✓
8. **Edit gating:** Click a completed-term slot → popover does NOT open. Click an IP slot → popover opens. Click a future planned slot → popover opens. ✓
9. **Prior Credits card:** AP/IB/transfer rows from the DPR appear as a card above the term cards, no grade column. ✓
10. **Tier colors + sticky headers:** Slots have a colored left border per their `workloadTier`. Scrolling the sidebar pins the current term's header to the top. ✓

#### Commit + push

After operator sign-off:

```bash
git add -A apps/web/app/chat/scheduleSidebar.tsx apps/web/app/chat/chat.module.css

git commit -m "feat(web): sidebar polish — summary card + tier colors + sticky headers (Phase 16 Task D)

Summary card at top: name + program(s) + school + visa + GPA + credits
earned/required + graduation term + progress bar.

Per-slot left border tint by workload tier (indigo/violet/teal/slate/
zinc for major-required/major-elective/school-core/free-elective/
general-elective). Subtle — a 4px left border, not a background fill.

Sticky term headers when the sidebar scrolls.

Typography: monospace course IDs, tabular numerals for credits and
GPA, tighter spacing across cards.

Manual verification (10 scenarios) signed off by the operator.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"

# After verification:
git push origin main
```

---

## Test inventory (across all 4 tasks)

| Layer | New tests | Coverage |
|---|---|---|
| `computeDprFingerprint` | determinism, change-detection on history, change-detection on cumulative, no-change on row reorder | 4 |
| `InMemoryScheduleStore` + `pruneCompletedPins` | round-trip, supersede, load-latest, prune semantics | ~6 |
| `InMemoryChatHistoryStore` | append, load-recent ordering, limit, clear-for-student | ~4 |
| `PostgresScheduleStore` | SQL pattern (transaction + supersede) via stub Database | ~4 |
| `PostgresChatHistoryStore` | append + load-recent SQL pattern | ~3 |
| `/api/session/restore` | hydrate from DB, null-on-new-student, auth gating | ~3 |
| `/api/session/clear` | wipe semantics, env-flag gating, auth gating | ~3 |
| `/api/onboard/refresh-dpr` | fingerprint match (no-op), mismatch (clear+replan), pin-prune semantics | ~4 |
| `groupCoursesByTerm` | history+current+future ordering, TE extraction, deduplication | ~5 |

**Total new tests:** ~36. Pre-existing baselines unchanged.

---

## Pre-existing baselines (must not regress)

- Engine TS errors: `8` (all in `runFullAudit.ts`, `searchCourses.ts`, `searchPolicy.ts` — unrelated).
- Web TS errors: `9` (mostly pre-existing `route.ts(711) 'stores'`).
- Engine test failures: `4` (`phase3.test.ts × 3` + `semesterPlanner.test.ts × 1`).

---

## Out of scope for Phase 16 (defer)

- **Cross-device sync.** Phase 16 persists per `studentId`; if a student opens NYU Path on two browsers simultaneously, edits race. Real-time sync is its own phase.
- **Versioned plan history exposed to the student.** The DB keeps superseded `forward_schedules` rows for audit, but the UI only shows the latest. A "show me my plan from last week" view is a future feature.
- **Plan diff on Update-DPR.** When the schedule is dropped + replanned after a DPR change, the user sees the new plan but no diff against the old one. Could surface a "what changed?" summary in a follow-up phase.
- **Concurrency / optimistic locking.** Two simultaneous `confirm_plan_change` calls could last-writer-win. Acceptable for V1; revisit if multi-tab races become an issue.
