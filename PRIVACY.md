# NYU Path — Privacy & Data Handling

**Status**: cohort-A pilot version (Phase 7-E W10.1). FERPA-aware, conservative defaults. Updated whenever data-handling behavior changes.

This document describes exactly what data NYU Path receives from a student, what it does with that data, where the data lives, who can see it, and how the student gets it deleted. It is the single source of truth for the privacy posture and is reviewable by anyone (NYU IT, advisers, students themselves) before opting in.

## TL;DR

- **The student uploads two file types**: an Albert Degree Progress Report (DPR) PDF, optionally a transcript PDF.
- **The PDF is processed in memory and discarded.** The raw PDF bytes are never written to disk and never persisted in any database.
- **The parsed structured form (a `DegreeProgressReport` JSON) is held only for the duration of the active chat session.** Cohort A defaults to *ephemeral* (cleared when the browser tab closes); opt-in localStorage persistence is available but off by default.
- **Conversation transcripts are summarized to ≤600 tokens at session end and stored against the student's account** so the next chat has context. The full transcripts are NOT retained.
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

The chat route does NOT persist the DPR or the chat content beyond the duration of the request, EXCEPT for the session-summary mechanism described in §2.3.

### 2.3 Session summaries (across-session continuity)

At the end of a chat session, a 600-token-or-less summary of the conversation is written to the student's profile record. The next time the student opens the chat, this summary is prepended as a `system` message so the agent has context. The full transcript is NOT retained.

For cohort A:
- **In-memory or file-backed session store** (no Postgres yet — that's W12).
- The file-backed store writes to `data/sessions/<userId>.jsonl` on the server.
- File contents: an array of `{date, summary}` objects. Maximum 5 entries kept; oldest evicted (Phase 7-A P-9 / §7.3).

When W12 lands and we provision Neon, the same data moves to the `session_summaries` Postgres table.

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
| Parsed JSON (opt-in persistence) | Browser localStorage at key `nyupath:dpr` | Until manually cleared | Open browser DevTools → Application → Local Storage → delete `nyupath:dpr`; OR click "Forget my DPR" in the chat UI (W10.1.b) |
| Chat session in flight | In-process memory of the v2 route's request handler | Request lifetime | Automatic |
| Session summaries (cohort A) | `data/sessions/<userId>.jsonl` on the NYU Path server | Until W12 (when moved to Postgres) or manual deletion | Email the operator (you, edoardo.mongardi18@gmail.com) and request deletion. Will be self-service via the chat UI in W12. |
| Observability events | `data/fallback_log.jsonl` on the server | Until manual rotation | Operator-managed; carries event-kind + correlation id, NO student-identifying content |
| Cached just-in-time-extracted hypothetical-program rules | `data/programs/_cache/<programId>.json` | Until manual deletion | These are NYU bulletin rules, not student data; safe to share publicly |

### 3.1 No production database in cohort A

Cohort A runs against the file-backed session store. No Postgres connection is provisioned (W12 — pending). This means:

- All cohort-A student data lives on the single NYU Path server's filesystem.
- A server crash + lost-disk recovery would lose session summaries (but not anything else — DPRs are in browser-only storage).
- Multi-server scale-out is not yet possible. Cohort B+ will require W12 (Postgres).

---

## §4. Who can see the data

### 4.1 The student

The student can see their own everything. They control:
- Whether to upload (no upload = no data).
- Whether to opt into persistent storage (default: ephemeral).
- Their session summaries are visible in their profile (W10.1.c — UI carry).

### 4.2 The operator (Edoardo Mongardi)

For cohort-A pilot, you have shell access to the NYU Path server and can read:
- Server-side session summary files.
- Observability event log (no student content; only event kinds + correlation ids).
- The browser-side DPR is NOT accessible to you — it never leaves the student's browser unless they're actively using the chat (in which case it's in the request handler's memory for the duration of one request).

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

If NYU IT raises concerns at any point, the operator's first response is to (a) immediately offer to delete all server-side session-summary files, (b) explain the architecture above, (c) discuss whether NYU wants to formalize the relationship under FERPA's school-official provisions or shut the project down. Cohort A is intentionally small enough (≤10 students) that a shutdown is a one-day operation.

---

## §6. Student rights

A cohort-A student can at any time:

- **Stop using the tool.** Close the browser tab. All in-memory state is gone.
- **Clear their browser-side DPR.** Browser DevTools → Application → Local Storage → delete `nyupath:dpr`. Or use the "Forget my DPR" affordance in the chat UI (W10.1.b).
- **Request deletion of their server-side session summaries.** Email the operator. SLA: 24 hours for cohort A.
- **Request a copy of all server-side data we hold on them.** Same channel; SLA 24 hours.
- **Re-upload a fresh DPR.** Triggers the parser; replaces the in-session DPR; doesn't delete prior session summaries unless the student also requests deletion.

---

## §7. Cohort-A specific notes

For the duration of cohort A (≤ 10 students):

- All students will be onboarded directly by the operator (Edoardo).
- Students will be told this document exists and asked to read it before opting in.
- The chat UI will display a persistent footer banner (W10.3): *"AI advising assistant. Not a substitute for an academic adviser. Verify all decisions with NYU advising before acting."*
- Per-student rate limit: 30 messages/day (W10.5). Mostly a cost guard; also surfaces unusual usage patterns.
- Operator will read the observability event log daily (cohort B precondition per ARCHITECTURE.md §12.6.5; we start the habit during cohort A).

---

## §8. Changelog

- **2026-04-28 (W10.1)**: Initial version. Cohort A privacy posture documented.
