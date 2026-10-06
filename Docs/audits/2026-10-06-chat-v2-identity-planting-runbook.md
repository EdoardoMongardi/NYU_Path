# Chat-v2 identity planting — forensic audit + remediation runbook (2026-10-06)

**Status:** DRAFT. The audit query is written but has **not** been run against a database yet. Destructive steps need the owner's (Edoardo's) explicit go-ahead **per step**. Nothing in this runbook has been executed.
**Audit query:** [`apps/web/scripts/audit-identity-planting.sql`](../../apps/web/scripts/audit-identity-planting.sql). It is read-only, returns counts + ids only, and contains no PII.
**Fix for the hole itself:** PR #58 (`fix/chat-v2-session-only-identity`). This runbook covers cleaning up what the hole may already have written.

## 1. What happened

From ~2026-04-26 (`60b239d`) until PR #58, `apps/web/app/api/chat/v2/route.ts` used `userId = authClaims?.sub ?? body.userId ?? "anonymous"`. A cookie-less caller could name any NetID and write under it:

| Table | Writer | Identifying mark |
|---|---|---|
| `students` (profile + `parsed_dpr`) | bootstrap `persistMutation`, since ~2026-05-04 (`6941ce4`) | `audit_log.pending_mutation_id LIKE 'bootstrap-%'` |
| `students` profile fields | homeSchool / visa change-persist | audit `homeschool-%` / `visa-%` |
| `chat_messages`, `session_summaries` | end-of-turn writes | none (timing only) |
| `forward_schedules`, `schedule_preferences` | `plan_forward_degree` / `confirm_plan_change` via ToolSession stores | none (timing only) |
| `pending_mutations` | `runProposeStage(userId, …)` | 10-min TTL |

On first real login, `verifyOtp` (`apps/web/lib/auth/otp.ts` ~L151) upserts `students` with `onConflictDoUpdate({ set: { email, updatedAt } })`, which **adopts** the planted row. `/api/session/restore` then returns the planted profile + DPR, and `chat/page.tsx` (~L330-350) skips onboarding.

**Impact if planted** (this is why it matters under the core philosophy: an invalid plan or invented fact):
- The victim is advised from someone else's or a fabricated DPR. The DPR is meant to be the single source of truth, so this corrupts the student's own record and violates R1 in effect.
- A planted `visaStatus` or `homeSchool` changes F-1 credit floors and school rules.
- **Stored prompt injection:** each summary is `Asked: "<caller text>"` and is re-injected as a prior **system** message (`summariesAsPriorMessage`, last 3). Restored `chat_messages` also return to the model as history.

## 2. How to run (owner only)

1. **Snapshot first:** create a Neon **branch** of production (e.g. `forensics-2026-10-06`). It is the forensic copy and the pre-purge backup. Run the audit against the branch, not the primary.
2. `psql "$AUDIT_DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/scripts/audit-identity-planting.sql`. The query runs in `BEGIN TRANSACTION READ ONLY … ROLLBACK`, so Postgres rejects any write. A read-only role is also recommended.
3. The output is one row per class: `n`, `n_with_parsed_dpr`, `n_with_profile`, `n_dpr_refreshed_since_login`, and `ids` as `id[signals]`.

**Signal codes:** each means the earliest row of that kind predates the id's **first verified login** (earliest *consumed* OTP, minus 5 s of skew).
- `C`: students row created.
- `A`: bootstrap / homeschool / visa audit row.
- `M`: chat message.
- `S`: session summary.
- `F`: forward schedule.
- `P`: preferences (last-updated time).
- `Q`: pending mutation.

Suffixes: `+dpr` means `parsed_dpr` is present; `+refreshed` means a cookie-authenticated `dpr_refresh_` happened after login.

> Deviation from the original ask: the cutoff is the first **consumed** OTP, not `min(email_otps.issued_at)`. Anyone can make an OTP be *issued* for any NetID, so `issued_at` does not prove the owner logged in. Using it would hide plantings made between an attacker-triggered issue and the real login.

## 3. Interpreting the classes

| Class | Meaning | Risk | Proposed action (owner approves each) |
|---|---|---|---|
| `1_UNCLAIMED_NETID` | Lower-case id, `email IS NULL`, no verified login ever. Only the cookie-less body-id path creates these. The row will be **adopted** when that NetID first logs in. | **Highest** | Purge (§4). No legitimate data can live here. |
| `2_ADOPTED_SUSPECT` | Claimed row with ≥1 signal: data written before the owner's first login was inherited. | **High** | Purge + force fresh onboarding (§4/§5). Consider notifying the student. |
| `recreated_after_login` | `email IS NULL`, but the id has a verified login and nothing predates it. **Expected:** `/api/session/delete` and `/clear` keep the cookie, so the next onboarding turn re-creates the row without an email. | Low | None, except the post-login blind spot (§6). |
| `browser_uuid` | Per-browser `nyupath:client-id` from cookie-less visitors (`/chat` is not gated). Cannot be adopted by a login. Holds a real DPR. | Privacy retention | Retention decision. Purge is likely, since PR #58 orphans these. |
| `anonymous_literal` | The shared `"anonymous"` row (tool writes before #58). Mixes data from many visitors. | Privacy retention | Purge. |
| `unadoptable_case_variant` | Mixed-case id. Login ids are lower-case and the PK is case-sensitive, so it can't be adopted. | Low | Purge as junk. |
| `anomaly_*` | Should be impossible (email set with no OTP record, or an unclaimed row with pre-login data despite a login). Causes: manual DB edits, the `otpLoginSmoke` test pointed at prod, deleted OTP rows. | Investigate | Look case by case before acting. |

Known benign explanations to rule out first:
- The operator's own ids, which may predate OTP auth (deployed `75c8fce`, 2026-04-27).
- Rows created before the OTP tables existed.

## 4. Purge / quarantine (destructive — ask first)

- **Quarantine = the Neon branch from §2.** It keeps the full pre-purge state for forensics, without copying PII into a new table in prod.
- **Purge:** delete the `students` row. All child tables (`forward_schedules`, `schedule_preferences`, `chat_messages`, `audit_log`, `session_summaries`, `pending_mutations`) are `ON DELETE CASCADE`. This is the same as `/api/session/delete`. Template, to be run by the owner only, inside a transaction, ids pasted from the audit:
  ```sql
  BEGIN;
  DELETE FROM students WHERE student_id = ANY (ARRAY['<id1>','<id2>']);
  -- check the row count matches the audit, then COMMIT (or ROLLBACK)
  ```
- For a claimed student (`2_ADOPTED_SUSPECT`), the purge also removes their **legitimate** post-login data (their own chat, plans). That is the trade-off for a guaranteed clean slate. A narrower reset is possible: delete only child rows older than the first login, and NULL `profile` / `parsed_dpr`. But a planted profile also survives in later rows, so the full purge is recommended.
- `email_otps` is not keyed on `students` and is **not** removed by the purge, which keeps the login history needed to re-audit.

## 5. Force a fresh DPR upload?

**Yes, for every purged `2_ADOPTED_SUSPECT`.** After the purge, `/api/session/restore` returns `profile = null`, and the page falls through to the onboarding wizard (DPR upload). The student only has to log in.

`+refreshed` is **not** enough to skip this. `/api/onboard/refresh-dpr` replaces `parsed_dpr` but **keeps the persisted profile**, so a planted `homeSchool`, `visaStatus`, `declaredPrograms` or `catalogYear` survives a refresh. Planted summaries, chat and preferences survive it too.

## 6. Blind spots (confidence: moderate — verify before concluding "clean")

- **Post-login injection is not detectable by timing.** Before #58, a cookie-less caller could also write under an **already-claimed** id: `homeschool-`/`visa-` audit rows, chat, summaries, schedules. Those rows postdate the login and look legitimate. One partial signal is a live `forward_schedules.dpr_fingerprint` that differs from the fingerprint of the stored `parsed_dpr` (`computeDprFingerprint`). That check needs a TS pass and is not in the SQL.
- `session_summaries` are trimmed to the last 5 per student, so an earlier planted summary may already be gone. That is harmless now, but `S` can under-report.
- The 5-second skew tolerance can miss a planting made within seconds of the real login.

## 7. Related findings (not fixed here)

- **Privacy gap:** self-serve `/api/session/delete` does not delete `email_otps` rows, so email + login timestamps outlive "delete all my data".
- **Id collision:** `AUTH_TEST_EMAILS` lets non-NYU addresses log in as their local part. `abc@gmail.com` would log in as the NetID `abc`. Keep that allowlist empty in production.
- **Hardening (proposed, separate TDD PR):** when `verifyOtp` adopts a row whose `email IS NULL`, reset `profile` / `parsed_dpr` and delete the child rows instead of inheriting them. This closes the adoption path even for rows planted by any future bug.
