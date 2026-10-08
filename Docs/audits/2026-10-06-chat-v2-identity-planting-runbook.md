# Chat-v2 identity planting — forensic audit + remediation runbook (2026-10-06)

**Status:** the audit query is written and has been **validated on a disposable local Postgres 17 against the synthetic fixture**: all 10 classes match the expected output, and a write inside the audit's transaction mode is rejected (`cannot execute DELETE in a read-only transaction`). It has **not** been run against production. Every destructive step below needs the owner's (Edoardo's) explicit go-ahead, **per step**.

| File | What it is |
|---|---|
| [`apps/web/scripts/audit-identity-planting.sql`](../../apps/web/scripts/audit-identity-planting.sql) | The audit. READ ONLY transaction, ends in ROLLBACK. Returns counts + ids only; selects no email, DPR, profile or message text. |
| [`apps/web/scripts/audit-identity-planting.fixture.sql`](../../apps/web/scripts/audit-identity-planting.fixture.sql) | Synthetic self-test seed with the expected output in its header. **Inserts rows — disposable DB only.** |

The hole itself is fixed by PR #58 (`fix/chat-v2-session-only-identity`). This runbook covers cleaning up what the hole may already have written.

## 1. What happened

From ~2026-04-26 (`60b239d`) until PR #58, `apps/web/app/api/chat/v2/route.ts` used `userId = authClaims?.sub ?? body.userId ?? "anonymous"`. A cookie-less caller could name any id and write under it, both before and after its owner's first login:

| Table | Writer under the forged id | Identifying mark |
|---|---|---|
| `students.profile` + `parsed_dpr` | route bootstrap `persistMutation` (only when no profile yet), since ~2026-05-04 (`6941ce4`) | audit `bootstrap-%` |
| `students.profile` + `parsed_dpr` | **`confirm_profile_update` tool** (ToolSession `profileStore`) re-persists the session DPR. **No "no profile yet" gate**, so it can overwrite an onboarded student's DPR *after* their login. | audit row with a tool-generated id |
| `students` profile fields | homeSchool / visa change-persist (profile exists + value differs) | audit `homeschool-%` / `visa-%` |
| `chat_messages`, `session_summaries` | end-of-turn writes | timing only |
| `forward_schedules`, `schedule_preferences` | `plan_forward_degree` / `confirm_plan_change` (ToolSession stores) | timing; the DPR fingerprint |
| `pending_mutations` | `runProposeStage(userId, …)` | 10-min TTL |

On first real login, `verifyOtp` (`apps/web/lib/auth/otp.ts` ~L151) upserts `students` with `onConflictDoUpdate({ set: { email, updatedAt } })`, which **adopts** a planted row. `/api/session/restore` then returns the planted profile + DPR, and `chat/page.tsx` (~L330-350) skips onboarding.

**Impact if planted** (why it matters under the core philosophy: never invent a fact, never ship an invalid plan):
- The victim is advised from someone else's or a fabricated DPR. The DPR is meant to be the single source of truth.
- A planted `visaStatus` or `homeSchool` changes F-1 credit floors and school rules.
- **Stored prompt injection:** each summary is `Asked: "<caller text>"` and is re-injected as a prior **system** message (`summariesAsPriorMessage`, last 3). Restored `chat_messages` also return to the model as history.

## 2. How to run (owner only)

1. **Optional self-test (disposable DB):**
   ```bash
   createdb identity_audit_selftest
   ```
   Then apply `apps/web/drizzle/000*.sql`, run the fixture, run the audit, and compare against the fixture header. Commands are in the fixture's header comment.
2. **Snapshot production:** create a Neon **branch** (e.g. `forensics-2026-10-06`). It is the forensic copy and the pre-purge backup. Point the audit at the branch, not the primary.
3. Run the audit:
   ```bash
   psql "$AUDIT_DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/scripts/audit-identity-planting.sql
   ```
   A read-only role is also recommended. The transaction is READ ONLY either way.
4. The output is one row per class: `n`, `n_with_parsed_dpr`, `n_with_profile`, `n_dpr_refreshed_since_login`, and `ids` as `id[signals]`.

**Signal codes.** The pre-login codes mean the earliest row of that kind predates the id's **first verified login** (earliest *consumed* OTP, minus 5 s of clock-skew tolerance):

| Code | Meaning |
|---|---|
| `C` | `students` row created before first login |
| `A` | **any** `audit_log` row before first login |
| `M` | `chat_messages` row before first login |
| `S` | `session_summaries` row before first login |
| `F` | `forward_schedules` row before first login |
| `P` | `schedule_preferences` last updated before first login |
| `Q` | `pending_mutations` row before first login |
| `X` | more than one distinct `dpr_fingerprint` among the student's schedules (any time) |
| `+dpr` | `parsed_dpr` is present |
| `+refreshed` | a cookie-authenticated `dpr_refresh_` happened after login |

Why `X` works: `refresh-dpr` hard-deletes the student's schedules. Every legitimate writer fingerprints the **stored** DPR: chat turns re-send the restored DPR, and the plan routes and what-if confirm read it from the DB (`planActionOrchestrator` fingerprints `state.dpr`, never the hypothetical). So a second fingerprint means a second DPR was planned under the id.

> Deviations from the original ask, on purpose:
> 1. The cutoff is the first **consumed** OTP, not `min(email_otps.issued_at)`. Anyone can make an OTP be *issued* for any NetID, so `issued_at` doesn't prove the owner logged in. The fixture's `fx_issue_race` would read as clean under `issued_at`.
> 2. `A` counts **all** audit rows, not only `bootstrap-`/`homeschool-`/`visa-`. `confirm_profile_update` also ran under the forged id, with its own ids, and every other audit writer is cookie-authenticated.

## 3. Interpreting the classes

| Class | Meaning | Risk | Proposed action (owner approves each) |
|---|---|---|---|
| `1_UNCLAIMED_NETID` | Lower-case id, `email IS NULL`, never a verified login. Only the body-id path creates these. The row will be **adopted** when that NetID first logs in. | **Highest** | Purge (§4). No legitimate data can live here. |
| `2_ADOPTED_SUSPECT` | Claimed row with ≥1 pre-login signal: data written before the owner's first login was inherited. | **High** | Purge → fresh onboarding (§4/§5). Consider telling the student. |
| `3_MULTI_DPR_SUSPECT` | No pre-login signal, but `X`: a second DPR was planned under the id. This is the post-login pattern; see the benign case in §6. | **Medium-high** (moderate confidence) | Review, then purge or force a fresh DPR (§5). |
| `recreated_after_login` | `email IS NULL`, id has a verified login, nothing predates it. **Expected:** `/api/session/delete` and `/clear` keep the cookie, so the next onboarding turn re-creates the row without an email. | Low | None (subject to §6). |
| `browser_uuid` | Per-browser `nyupath:client-id` from cookie-less visitors (`/chat` is not gated). Can't be adopted by a login. Holds a real DPR. | Privacy retention | Retention decision. Likely purge: PR #58 orphans these. |
| `anonymous_literal` | The shared `"anonymous"` row (tool writes before #58). Mixes data from many visitors. | Privacy retention | Purge. |
| `unadoptable_case_variant` | Mixed-case id. Login ids are lower-case and the PK is case-sensitive, so it can't be adopted. | Low | Purge as junk. |
| `anomaly_*` | Should be impossible: email set with no OTP record, or an unclaimed row with pre-login data despite a login. Causes: manual DB edits, the `otpLoginSmoke` test pointed at prod, deleted OTP rows. | Investigate | Look case by case before acting. |
| `clean` | No signal. Ids are not listed. | — | — |

Rule out benign explanations first:
- The operator's own ids, which may predate OTP auth (deployed `75c8fce`, 2026-04-27).
- Rows from before the OTP tables existed.

## 4. Purge / quarantine (destructive — ask first)

- **Quarantine = the Neon branch from §2.** It keeps the full pre-purge state for forensics without copying PII into a new table in prod.
- **Purge:** delete the `students` row. All child tables (`forward_schedules`, `schedule_preferences`, `chat_messages`, `audit_log`, `session_summaries`, `pending_mutations`) are `ON DELETE CASCADE`, the same as `/api/session/delete`. Template, run by the owner only, ids pasted from the audit:
  ```sql
  BEGIN;
  DELETE FROM students WHERE student_id = ANY (ARRAY['<id1>','<id2>']);
  -- confirm the reported row count equals the number of ids, then COMMIT (else ROLLBACK)
  ```
- For a claimed student (`2_`/`3_`), the purge also removes their **legitimate** data (their own chat, plans, preferences). That is the trade-off for a guaranteed clean slate. A narrower reset (drop only pre-login child rows, NULL `profile`/`parsed_dpr`) is possible, but planted values also leak into later rows, so the full purge is recommended.
- `email_otps` is not keyed on `students` and is **not** removed by the purge, which keeps the login history needed to re-run the audit afterwards. The re-run should show the purged ids gone.

## 5. Force a fresh DPR upload?

**Yes, for every purged `2_ADOPTED_SUSPECT` and `3_MULTI_DPR_SUSPECT`.** After the purge, `/api/session/restore` returns `profile = null`, and the page falls through to the onboarding wizard (DPR upload). The student only has to log in again.

`+refreshed` is **not** enough to skip this. `/api/onboard/refresh-dpr` replaces `parsed_dpr` but **keeps the persisted profile**, so a planted `homeSchool`, `visaStatus`, `declaredPrograms` or `catalogYear` survives a refresh. Planted summaries, chat and preferences survive it too.

## 6. Blind spots (confidence: moderate — "no rows" ≠ proof of clean)

- **Post-login writes that never planned a schedule are invisible.** A forged post-login `homeschool-`/`visa-` change, chat, summary or `confirm_profile_update` leaves only rows that look like the owner's own. `X` catches a post-login foreign DPR only if a schedule was planned under it **and** another DPR's schedule still exists. `refresh-dpr` wipes schedules, which also wipes that evidence.
- **Benign `X`:** a student whose browser still held an older DPR in memory while their stored DPR changed (e.g. a refresh in another tab) could plan under two fingerprints. This is rare; review before purging.
- **A stronger, TS-only check (not built):** compare `computeDprFingerprint(parsed_dpr)` with the live schedule's fingerprint and the `dpr_refresh` audit `after.dprFingerprint`. It needs the DPR JSON read into the runner, so it was left out of the PII-free SQL.
- **Summary trimming:** `session_summaries` keeps the last 5 per student, so an early planted summary may already be gone. Harmless now, but `S` can under-report.
- The 5 s skew tolerance can miss a planting made within seconds of the real login.

## 7. Related findings (not fixed here)

- **Privacy gap:** self-serve `/api/session/delete` does not delete `email_otps` rows, so email + login timestamps outlive "delete all my data".
- **Id collision:** `AUTH_TEST_EMAILS` lets non-NYU addresses log in as their local part. `abc@gmail.com` would log in as NetID `abc`. Keep that allowlist empty in production.
- **Hardening (separate TDD PR):** when `verifyOtp` adopts a row with `email IS NULL`, reset it instead of inheriting it. This closes the adoption path for anything planted before #58, or by any future bug.
