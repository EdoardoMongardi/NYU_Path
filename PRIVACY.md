# NYU Path — Privacy & Data Handling

**Status**: cohort-A pilot version (Phase 7-E W10.1). FERPA-aware, conservative defaults. Updated whenever data-handling behavior changes.

This document describes exactly what data NYU Path receives from a student, what it does with that data, where the data lives, who can see it, and how the student gets it deleted. It is the single source of truth for the privacy posture and is reviewable by anyone (NYU IT, advisers, students themselves) before opting in.

## TL;DR

- **The student uploads two file types**: an Albert Degree Progress Report (DPR) PDF, optionally a transcript PDF.
- **The PDF is processed in memory and discarded.** The raw PDF bytes are never written to disk and never persisted in any database.
- **The parsed structured form (a `DegreeProgressReport` JSON) is held only for the duration of the active chat session.** Cohort A is fully ephemeral — the parsed DPR lives in React state and is cleared when the browser tab closes. (We considered an opt-in localStorage persistence affordance for cohort A; it didn't ship and is now scheduled for W12 alongside real auth.)
- **Conversation transcripts are NOT retained in cohort A.** A file-backed session-summary mechanism exists in the engine (Phase 7-A P-9) but is not yet wired into the v2 chat route — every cohort-A chat starts fresh with no cross-session memory. Cross-session continuity ships in W12.
- **Cardinal Rule §2.1**: every numerical claim in a reply traces to a tool result. The agent is forbidden from inventing or paraphrasing GPA, credits, or requirement counts.
- **No third-party sharing.** OpenAI / Anthropic / Cohere see only the chat content the LLM needs to answer the current turn. We never send the raw DPR PDF to a third party.

---

## §1. What data we receive

### 1.1 From the student (active upload)

| Artifact | When uploaded | Format |
|---|---|---|
| **Degree Progress Report (DPR) PDF** | At onboarding; re-uploaded whenever the student wants fresh state (after registering for new courses, declaring a new major, etc.) | PDF (Oracle Analytics Publisher, ~30–50KB, 6–12 pages) |
| **Unofficial transcript PDF** (fallback only) | Onboarding fallback when DPR is unavailable | PDF (~10–80KB) |

The student selects these files from their local filesystem; they're sent to NYU Path's `/api/onboard` endpoint as multipart form data. The student is in full control: NYU Path never accesses Albert directly, never holds the student's NYU SSO credentials, and never logs into Albert on the student's behalf.

### 1.2 From the student (passive — chat messages)

Free-form text the student types in the chat UI. Standard chat-app data.

### 1.3 What we do NOT receive

- NYU SSO credentials / Duo MFA tokens.
- Student's NYU email password.
- Any data from the Albert SIS the student didn't explicitly download and upload to us.
- Any data from FERPA-protected institutional records other than what's in the DPR/transcript the student themselves chose to share.
- Real-time class enrollment data (we read the FOSE public catalog endpoint, which is anonymous).

---

## §2. What the system does with that data

### 2.1 PDF ingestion (cohort-A default — ephemeral)

When the student uploads a DPR or transcript PDF:

1. The PDF bytes arrive at `/api/onboard` as an `ArrayBuffer` in the request handler.
2. `unpdf.extractText()` converts the bytes to plain text **in memory**. The bytes are never written to disk.
3. The text passes through the deterministic DPR parser (no LLM calls) which produces a typed `DegreeProgressReport` object.
4. The `ArrayBuffer` and the extracted raw text are **garbage-collected as soon as the request handler returns**. We do not persist them.
5. The parsed `DegreeProgressReport` JSON is returned to the browser as the response body.

The browser stores the parsed DPR in React state for the duration of the chat session. When the tab closes, the parsed DPR is gone.

### 2.2 Chat session

Each chat turn POSTs the parsed DPR + the user's message + recent prior messages to `/api/chat/v2`. The route:

1. Validates the DPR shape against the engine's Zod schema (rejects malformed payloads loudly).
2. Builds a `ToolSession` with the student profile derived from the DPR + the policy RAG corpus + the course catalog semantic search.
3. Runs the agent loop: the LLM decides which tools to call; tools fetch data from the DPR / RAG / catalog / FOSE; the LLM composes a reply.
4. The response validator gates the reply against the four §9.1 checks (grounding, invocation, completeness, verbatim drift). Cardinal Rule §2.1 holds: every numerical claim must trace to a tool result.

The chat route does NOT persist the DPR, the chat content, or any per-student state beyond the duration of the request in cohort A. Each turn is a fresh request; the only state that crosses turns within a single session is the in-browser React state (the parsed DPR + the message history shown on screen).

### 2.3 Session summaries (across-session continuity) — DEFERRED TO W12

The engine ships with a file-backed session store + summary-prepend helper (Phase 7-A P-9 / §7.3) that *would* persist a ≤600-token summary per chat session under `data/sessions/<userId>.jsonl` and replay it on the next visit. **This is not wired into the cohort-A v2 chat route.** Each cohort-A chat starts cold.

This was a deliberate scope cut for the pilot:
- Without real authentication (W12), there is no trustworthy student id to key summaries against — the per-browser client UUID we use for rate-limit bucketing is fine for cost-guarding but not for storing identifiable academic context.
- Cohort A is small (~10 students) and short (4 weeks). Cross-session memory adds little value over a 4-week window when each session naturally re-uploads a fresh DPR.
- Wiring summaries without a persistence layer the operator can audit + delete on request would create a privacy footprint we don't want before W12 lands the full data-retention story.

When W12 ships (Neon Postgres + Resend OTP auth), summaries become per-authenticated-student rows in a `session_summaries` table, and this section will be rewritten to describe the live behavior.

### 2.4 Third-party API calls

The agent loop makes API calls to:

| Provider | What we send | Why |
|---|---|---|
| OpenAI (`gpt-4.1-mini`) | The system prompt (with student's home school + program tags) + the conversation history + the user's latest message + tool-result summaries from this turn | Generate the reply |
| OpenAI (`text-embedding-3-small`) | One-off vector queries (e.g., "machine learning courses") for course-catalog search | Already-embedded course corpus stays local |
| Cohere (`rerank-v3.5`) | Per-query: the user's question + 20 candidate policy chunks | Rerank for relevance |
| FOSE (`m.albert.nyu.edu`) | Course code + term query (e.g., `CSCI-UA 480` for `2026-fall`) | Live class availability |

The full DPR PDF is **never** sent to any third party. The DPR-derived structured fields the agent quotes (GPA, credits, etc.) are sent to the LLM as part of tool-result summaries during the chat, but only as the specific values the conversation requires. We do not send the entire DPR JSON in every turn.

### 2.5 What we never do

- **Never store the raw DPR/transcript PDF.** Garbage-collected after parsing.
- **Never share student data with non-NYU advisers or external services** beyond the LLM/embedding/reranker providers listed above.
- **Never use student data to train models.** We rely on third-party APIs that have their own data-retention policies (OpenAI: 30 days then deletion; Anthropic: similar; Cohere: similar). Per their terms, API usage data is NOT used for training when you're on a paid API key (which we are).
- **Never log the student's full conversation to disk** outside the in-process observability sink, which records structured events (tool name, validator status, transition reason) but not the assistant's reply text.
- **Never share the student's identity with anyone**, including other cohort-A students. Each student's data is keyed off their `userId` (anonymous mode for cohort A; NYU email after W12 auth ships).

---

## §3. Where the data lives

| Data | Location | Lifetime | How to delete |
|---|---|---|---|
| Raw DPR/transcript PDF | In-memory ArrayBuffer in the API request handler | ~milliseconds (request lifetime) | Automatic — GC'd after handler returns |
| Parsed `DegreeProgressReport` JSON | Browser React state | Tab lifetime (cleared on close/refresh) | Close the browser tab |
| Per-browser client UUID (rate-limit bucket key) | Browser localStorage at key `nyupath:client-id` | Until manually cleared | DevTools → Application → Local Storage → delete `nyupath:client-id` (resets your daily message quota). |
| Chat session in flight | In-process memory of the v2 route's request handler | Request lifetime | Automatic |
| Session summaries | _Not produced in cohort A._ See §2.3 — deferred to W12. | n/a | n/a |
| Observability events | `data/fallback_log.jsonl` on the server | Until manual rotation | Operator-managed; carries event-kind + correlation id, NO student-identifying content |
| Cached just-in-time-extracted hypothetical-program rules | `data/programs/_cache/<programId>.json` | Until manual deletion | These are NYU bulletin rules, not student data; safe to share publicly |

### 3.1 No production database in cohort A

Cohort A runs without a production database. No Postgres connection is provisioned (W12 — pending). This means:

- The only cohort-A "server-side" state is the operator-only `data/fallback_log.jsonl` (event kinds + correlation ids only — no student-identifying content; see §3 row "Observability events").
- Session-summary persistence is deferred to W12 (see §2.3) — there is no per-student data file on the server in cohort A.
- Multi-server scale-out is not yet possible. Cohort B+ will require W12 (Postgres).

---

## §4. Who can see the data

### 4.1 The student

The student can see their own everything. They control:
- Whether to upload (no upload = no data).
- The parsed DPR is in their browser tab and gone the moment they close it.
- The per-browser client UUID under `nyupath:client-id` can be cleared at any time via DevTools (resets the rate-limit bucket; nothing else).

### 4.2 The operator (Edoardo Mongardi)

For cohort-A pilot, you have shell access to the NYU Path server and can read:
- The observability event log at `data/fallback_log.jsonl` (event kinds + correlation ids only — no student content).
- The browser-side DPR is NOT accessible to you — it never leaves the student's browser unless they're actively using the chat (in which case it's in the request handler's memory for the duration of one request).
- There are no server-side session-summary files in cohort A (see §2.3).

### 4.3 Third-party LLM/embedding providers

Per §2.4, OpenAI / Anthropic / Cohere see only the request payloads we send during chat. Their data-retention policies apply (typically 30-day rolling window then deletion; not used for training on paid keys).

### 4.4 NYU IT / faculty / advisers

**No automatic sharing.** NYU Path does not push any data back to NYU's systems. Students may individually choose to share their NYU Path conversations with their adviser via screenshot, but that's the student's decision.

---

## §5. FERPA posture

NYU Path is a student-built personal-project tool, not an official NYU service. FERPA applies to NYU as the institution holding the records (the DPR originates from the registrar). When a student voluntarily downloads their DPR and uploads it to NYU Path:

- **The student is exercising their FERPA right to access their own records.** They choose what to share with whom.
- **NYU Path is acting as a tool the student is using for personal academic planning.** Same posture as an Excel spreadsheet the student might paste their courses into, or a personal tutor they share their transcript with.
- **NYU Path is NOT a "school official with legitimate educational interest"** under §99.31(a)(1). We do NOT have an MOU with NYU; we are not a sanctioned vendor.

This means:
- We **must not** represent ourselves to NYU IT as a sanctioned tool.
- We **must not** retain student data longer than necessary for the active session.
- We **must** make it trivially easy for the student to delete their data.
- We **should** display a banner reminding the student that this is an unofficial tool and they're sharing their own data voluntarily (W10.3 — persistent disclaimer).

If NYU IT raises concerns at any point, the operator's first response is to (a) immediately purge `data/fallback_log.jsonl` and any operator-local notes, (b) explain the architecture above (including that no per-student data is retained server-side in cohort A), (c) discuss whether NYU wants to formalize the relationship under FERPA's school-official provisions or shut the project down. Cohort A is intentionally small enough (≤10 students) that a shutdown is a one-day operation.

---

## §6. Student rights

A cohort-A student can at any time:

- **Stop using the tool.** Close the browser tab. All in-memory state is gone (parsed DPR, message history).
- **Clear their per-browser client UUID.** Browser DevTools → Application → Local Storage → delete `nyupath:client-id`. The next message they send will get a fresh id with a fresh daily quota.
- **Request a copy of all server-side data we hold on them.** Email the operator (SLA 24 hours for cohort A). The honest answer in cohort A is "we hold no per-student data on the server" — only the operator-only fallback-event log, which contains no student-identifying content.
- **Re-upload a fresh DPR.** Triggers the parser; replaces the in-session DPR. (Cohort A has no cross-session memory to also clear — see §2.3.)

---

## §7. Cohort-A specific notes

For the duration of cohort A (≤ 10 students):

- All students will be onboarded directly by the operator (Edoardo).
- Students will be told this document exists and asked to read it before opting in.
- The chat UI will display a persistent footer banner (W10.3): *"AI advising assistant. Not a substitute for an academic adviser. Verify all decisions with NYU advising before acting."*
- Per-browser daily rate limit: 30 messages/UTC day (W10.5). The limit is keyed off a stable per-browser UUID stored at `localStorage["nyupath:client-id"]` so each student's browser has its own quota. Without real auth (W12), a student who clears localStorage or opens an incognito window will get a fresh quota — this is acceptable for a small pilot whose primary purpose is cost-guarding and abuse-signal surfacing.
- Operator will read the observability event log daily (cohort B precondition per ARCHITECTURE.md §12.6.5; we start the habit during cohort A). The dashboard at `/admin/observability` is gated by Basic Auth (`OBSERVABILITY_USER` / `OBSERVABILITY_PASS` env vars).

---

## §8. Changelog

- **2026-04-28 (W10.1)**: Initial version. Cohort A privacy posture documented.
- **2026-04-28 (W10 reviewer follow-up)**: Removed claims about server-side session-summary persistence and opt-in DPR localStorage — neither was wired in cohort A. Both deferred to W12. Per-browser client UUID added (drives real per-student rate-limit bucket). `/admin/observability` Basic-Auth gate documented.
