# NYU Path — Privacy & data handling (developer reference)

> Last verified against code: 2026-06-16.
>
> This is the **developer-facing** data-handling reference. The **user-facing**
> privacy notice is served at **`/privacy`** ([`apps/web/app/privacy/page.tsx`](../../apps/web/app/privacy/page.tsx)) and the `/login` page links to it. Keep the two in sync when data handling changes.
>
> Supersedes the retired cohort-A pilot doc (now at [`Docs/deprecated/PRIVACY.md`](../deprecated/PRIVACY.md)), which described an ephemeral, no-DB pilot that no longer matches the code.

## Posture: persistent + accounts

NYU Path runs as a **signed-in, persistent** app. The store factory ([`apps/web/lib/db/store.ts`](../../apps/web/lib/db/store.ts)) returns Postgres-backed adapters when `DATABASE_URL` is set; without it, stores fall back to in-memory / file-backed (dev/test). **Persistence is gated on authentication** — the v2 chat route only writes durable rows when `userId !== "anonymous"` ([`route.ts`](../../apps/web/app/api/chat/v2/route.ts)). Anonymous sessions store nothing server-side.

## Authentication

- NYU-email **OTP**: `issueOtp` / `verifyOtp` in [`apps/web/lib/auth/otp.ts`](../../apps/web/lib/auth/otp.ts). 6-digit code, sha256-hashed at rest, 10-minute expiry, single-use (`consumedAt`), delivered via **Resend**. NYU-only by default (`@nyu.edu`); `AUTH_TEST_EMAILS` allowlists operator self-test.
- On verify → signed **JWT** (HS256, 30-day) in the `nyupath_session` cookie ([`apps/web/lib/auth/session.ts`](../../apps/web/lib/auth/session.ts)). The JWT `sub` is the canonical `studentId` everything keys off (profile rows, rate-limit bucket, all per-student tables).

## What is stored (Postgres, per `studentId` — [`schema.ts`](../../apps/web/lib/db/schema.ts))

All child tables `ON DELETE CASCADE` from `students`.

| Table | Holds |
|---|---|
| `students` | email, declared programs, visa status, catalog year, home school, flags, full profile snapshot, **`parsed_dpr`** (parsed DPR JSON), last-session date |
| `forward_schedules` | degree-plan history (soft-delete via `superseded_at`) |
| `schedule_preferences` | latest `SchedulePreferences` (one row, upsert) |
| `chat_messages` | append-only transcript: role, content, thinking text, tool invocations, validator violations |
| `session_summaries` | rolling ~600-token NL summaries of past sessions |
| `audit_log` | immutable record of confirmed profile mutations (before/after) |
| `email_otps` | transient OTP hashes (expire 10 min, deleted on consume) |

**DPR handling:** the uploaded PDF is parsed with `unpdf` `extractText` in [`apps/web/app/api/onboard/route.ts`](../../apps/web/app/api/onboard/route.ts); only the **parsed JSON** is persisted (`students.parsed_dpr`). The raw PDF is **not** stored. The **Albert DPR is the only document the system accepts** — there is **no unofficial-transcript intake anywhere** (the legacy transcript-upload path was removed; see the headers of `onboard/route.ts` and [`apps/web/lib/buildSession.ts`](../../apps/web/lib/buildSession.ts)).

## Third-party processing

- **LLM providers** — chat content + relevant academic context are sent to the model to generate replies: **Anthropic `claude-sonnet-4-6`** (primary) and **OpenAI `gpt-4.1-mini`** (fallback), per [`clients/index.ts`](../../packages/engine/src/agent/clients/index.ts) (`DEFAULT_PRIMARY_MODEL` / `DEFAULT_FALLBACK_MODEL`; overridable via `NYUPATH_PRIMARY_MODEL` etc.).
- **Resend** — OTP email delivery.

## Retention & deletion

- Account data is retained until deleted (that is the point — cross-session resume).
- **Standing self-serve deletion (always-on):** `DELETE /api/session/delete` ([route](../../apps/web/app/api/session/delete/route.ts)) is the permanent user-deletion right. It requires auth (401 otherwise) and is **NOT env-gated** — any signed-in student may delete all of their own data at any time, in every deployment. It deletes every per-student table in one transaction (`chat_messages`, `forward_schedules`, `schedule_preferences`, `audit_log`, `session_summaries`, `pending_mutations`), with the `students` parent row **last**; on failure it rolls back and returns 500.
- **Operator/test affordance (gated):** `DELETE /api/session/clear` ([route](../../apps/web/app/api/session/clear/route.ts)) performs the same per-student wipe but is **gated server-side on `NEXT_PUBLIC_ENABLE_TEST_CLEAR=1`** (returns 403 otherwise) and requires auth (401 otherwise). It exists so the operator can re-run onboarding during testing; the chat UI's "clear my data" control is wired to it. This is intentionally distinct from the standing `/api/session/delete` right above.
- ✅ **Status (2026-06-16):** self-serve deletion is now a **standing user right** via the always-on `DELETE /api/session/delete` route, so it is **guaranteed available in every deployment** and the user-facing notice no longer hedges with conditional "where the operator has enabled it" wording. The env-gated `/api/session/clear` remains only as the operator/test affordance described above.

## Caveats for whoever owns the deployment

- Whether data is actually persisted depends on `DATABASE_URL` being set; the `/privacy` notice and this doc assume the **intended persistent** deployment.
- A few code comments / strings still carry historical "cohort A" framing (e.g. `rateLimit.ts`, observability dashboard) — harmless, not the deleted cohort gate.
