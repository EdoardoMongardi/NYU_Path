# Plan Action Routes — Deterministic Plan Mutation API

## TL;DR

These are the endpoints behind the sidebar's clickable buttons — Add, Move, Swap, Drop, Lock, Confirm. When the student drags a course from one term to another, or clicks "Lock this course in place," the request lands here instead of going through the AI. That's intentional: a drag-and-drop should feel instant, and there's nothing for the AI to interpret about an unambiguous gesture. Each action runs in two steps: first the server checks if the change is valid and returns a preview (without saving anything), then the student clicks "Confirm" and a second call actually commits the change. Two extra endpoints sweeten the experience: one rewrites the dry preview into friendly prose using a small AI call, and another fetches available section times for upcoming terms. Skipping the AI keeps things fast, predictable, and free of token cost.

```mermaid
flowchart LR
    Gesture[Student drags / clicks] --> Verb[Add / Move / Swap / Drop / Lock]
    Verb --> Preview[Server previews the change]
    Preview --> Bubble[Show confirm bubble in chat]
    Bubble --> Polish[AI rewrites the preview text]
    Bubble --> Sections[Fetch section times for future terms]
    Bubble --> Confirm[Student clicks Confirm]
    Confirm --> Save[Server saves the change]
```

---

## 1. Overview

The plan-action routes form a deterministic, non-LLM HTTP layer under `/api/plan/*` that the chat UI calls when a student interacts with direct affordances (drag a course onto a term, click "Lock", select "Drop", etc.). These routes do **not** invoke the agent loop or any model — they are pure plumbing from a UI gesture, through input validation, into the engine's `proposePlanChangeTool` and `confirmPlanChangeTool`, and back as a typed JSON response.

The architecture splits each mutation into a strict two-stage handshake:

- **Stage 1 — Propose.** Five "verb" routes (`add`, `move`, `swap`, `drop`, `lock`) construct a canonical `PlanMutation[]` from the request body, run it through the engine's structural validator without persisting anything, and return a freshly minted `pendingMutationId`. The orchestrator stashes the staged mutations in an in-memory map keyed by that id.
- **Stage 2 — Confirm.** `/api/plan/confirm` looks up the staged mutations by `pendingMutationId` and applies them atomically via `confirmPlanChangeTool`.

Two auxiliary routes wrap the bubble UX: `/api/plan/explain-polish` streams an LLM rewrite of the deterministic explanation text, and `/api/plan/stage2` streams per-term FOSE section enrichments.

```mermaid
flowchart LR
    UI[Chat UI - drag/click] --> Add[/api/plan/add/]
    UI --> Move[/api/plan/move/]
    UI --> Swap[/api/plan/swap/]
    UI --> Drop[/api/plan/drop/]
    UI --> Lock[/api/plan/lock/]
    Add --> Helper[handleProposeRoute]
    Move --> Helper
    Swap --> Helper
    Drop --> Helper
    Lock --> Helper
    Helper --> Propose[runProposeStage -> proposePlanChangeTool]
    Propose --> Stage[in-memory pendingMutations map]
    Propose --> Resp[(JSON: pendingMutationId + diff + futureTerms)]
    Resp --> Bubble[Confirm bubble in UI]
    Bubble -->|click Confirm| Confirm[/api/plan/confirm/]
    Confirm --> ConfirmHelper[handleConfirmRoute]
    ConfirmHelper --> Apply[runConfirmStage -> confirmPlanChangeTool]
    Bubble -.->|fire-and-forget| Polish[/api/plan/explain-polish/]
    Bubble -.->|fire-and-forget| Stage2[/api/plan/stage2/]
```

All routes run on the Node.js runtime (each file declares `runtime = "nodejs"`). All routes share the same auth contract (cookie-based session) and the same daily rate-limit bucket — except `explain-polish` and `stage2`, which use dedicated buckets.

## 2. Per-Route Documentation

### 2.1 `/api/plan/add` — Pin a course to a term

**Source:** `apps/web/app/api/plan/add/route.ts:26-36`

**Request body:**
- `courseId` — string (required, min length 1)
- `term` — string (required, min length 1)

**What it does:** Constructs a single-element mutation array containing one `pin` mutation with `freeze: true`. This semantic encodes that the student is expressing an explicit preference: the placement stays sticky until they explicitly unlock it through `/api/plan/lock` with `locked: false`. Delegates to `handleProposeRoute` (`apps/web/lib/planActionRouteHelpers.ts:141`).

**Response shape (200):** `PlanActionResponse` — see Section 4.

**Error cases:**
- 401 — no session cookie
- 429 — daily plan-action quota exhausted (60/day per student)
- 400 — malformed JSON body or schema validation failure
- 409 — student has no persisted profile, no parsed DPR, or no plan to mutate
- 500 — engine threw inside the tool call

---

### 2.2 `/api/plan/move` — Atomic relocate between terms

**Source:** `apps/web/app/api/plan/move/route.ts:40-62`

**Request body:**
- `courseId` — string (required)
- `fromTerm` — string (required)
- `toTerm` — string (required)

**What it does:** When `fromTerm === toTerm`, returns an empty mutation list (which the shared helper rejects with 400 — see Section 3). For a genuine move, emits a two-mutation batch:

1. A `move` mutation describing the from→to relocation (writes the from-term exclusion).
2. A `pin` mutation on the destination term with `freeze: true` (writes the to-term placement).

The second mutation is load-bearing: the solver's exclusion set is term-agnostic, so without an explicit pin on `toTerm` the dragged course would simply vanish rather than land in the new term. Delegates to `handleProposeRoute`.

**Response shape (200):** `PlanActionResponse`.

**Error cases:** Same as `/api/plan/add` plus 400 for the no-op `fromTerm === toTerm` case (surfaced by the helper's "empty mutation list" check at `apps/web/lib/planActionRouteHelpers.ts:160-162`).

---

### 2.3 `/api/plan/swap` — Replace one course with another

**Source:** `apps/web/app/api/plan/swap/route.ts:49-61`

**Request body — discriminated union:**

*Single-term swap* (`apps/web/app/api/plan/swap/route.ts:31-35`):
- `drop` — string (required)
- `add` — string (required)
- `term` — string (required)

*Cross-term batch* (`apps/web/app/api/plan/swap/route.ts:37-44`):
- `exchanges` — non-empty array of `{ aCourseId, aTerm, bCourseId, bTerm }`

Both schemas are declared `.strict()` so a body that mixes both shapes fails the union match cleanly.

**What it does:**
- Single-term branch: emits one `swap` mutation with `{ drop, add, term }`.
- Exchange branch: for each exchange, emits two `swap` mutations — one placing `bCourseId` in `aTerm` (dropping `aCourseId`) and one placing `aCourseId` in `bTerm` (dropping `bCourseId`).

Delegates to `handleProposeRoute`.

**Response shape (200):** `PlanActionResponse`.

**Error cases:** Same shared set as `/api/plan/add`.

---

### 2.4 `/api/plan/drop` — Exclude a course

**Source:** `apps/web/app/api/plan/drop/route.ts:25-32`

**Request body:**
- `courseId` — string (required)
- `term` — string (optional)

**What it does:** Emits a single `exclude` mutation. When `term` is provided, the exclusion is scoped to that term only; when absent, the exclusion is global (the engine's `SchedulePreferences.exclusions[]` entry has `term: undefined`). Delegates to `handleProposeRoute`.

**Response shape (200):** `PlanActionResponse`.

**Error cases:** Same shared set as `/api/plan/add`.

---

### 2.5 `/api/plan/lock` — Toggle solver freeze on a slot

**Source:** `apps/web/app/api/plan/lock/route.ts:31-49`

**Request body:**
- `courseId` — string (required)
- `term` — string (required)
- `locked` — boolean (required)

**What it does:**
- `locked: true` → emits a `pin` mutation with `freeze: true`. The slot is written into `SchedulePreferences.pins[]`; the solver respects this on every subsequent re-plan.
- `locked: false` → emits an `unpin` mutation. The matching pin entry is removed; the slot becomes solver-eligible again.

Delegates to `handleProposeRoute`.

**Response shape (200):** `PlanActionResponse`.

**Error cases:** Same shared set as `/api/plan/add`.

---

### 2.6 `/api/plan/confirm` — Apply a staged mutation

**Source:** `apps/web/app/api/plan/confirm/route.ts:43-45`

**Request body:**
- `pendingMutationId` — UUID string (required)
- `force` — boolean (optional)

**What it does:** Delegates to `handleConfirmRoute` (`apps/web/lib/planActionRouteHelpers.ts:176`), which:

1. Runs preflight (auth + rate-limit + JSON parse).
2. Looks up the staged mutation via `runConfirmStage`.
3. Applies the mutation through `confirmPlanChangeTool`.
4. If `force === true` and the engine returns `feasible: false`, reclassifies the persisted schedule's `state` from `infeasible-draft` to `student-preferred-invalid-draft` and re-persists it.

A successful confirm removes the staging entry — confirming the same id twice returns 404.

**Response shape (200):** `PlanConfirmResponse` — see Section 4.

**Error cases:**
- 401 — no session
- 429 — quota exhausted
- 400 — malformed body / not a valid UUID
- 404 — `unknown_mutation_id` (staging entry expired after 10 minutes or already consumed)
- 403 — `studentId_mismatch` (the staging entry was minted for a different student)
- 409 — `no_profile` / `no_dpr` / `no_schedule`
- 500 — `engine_error`

---

### 2.7 `/api/plan/lock` (variant — see 2.5 above)

(No additional route; `lock` is documented in 2.5.)

---

### 2.8 `/api/plan/explain-polish` — Stream an LLM rewrite of the explanation

**Source:** `apps/web/app/api/plan/explain-polish/route.ts:79-204`

**Request body:**
- `slotKey` — string (required, 1-200 chars). The bubble's stable identifier; echoed verbatim into every SSE event so the client can route polish chunks to the correct bubble in a multi-bubble UI.
- `templateText` — string (required, 1-4000 chars). The deterministic explanation produced by the propose stage; passed verbatim into the model.
- `structuredDiff` — optional unknown JSON. When provided, serialized and trimmed to 2000 chars then included as disambiguation context for the model.

**What it does:**

1. Auth gate (`apps/web/app/api/plan/explain-polish/route.ts:81-87`).
2. Per-day rate limit on a dedicated bucket `plan-polish:<studentId>` with a cap of 200 (`apps/web/app/api/plan/explain-polish/route.ts:93-107`).
3. Feature gate: if neither `NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH` nor `PLAN_CHANGE_LLM_POLISH` equals `"1"`, returns 204 with empty body (`apps/web/app/api/plan/explain-polish/route.ts:112-116`).
4. Parses and validates the body.
5. Requires `ANTHROPIC_API_KEY`; returns 503 if missing (`apps/web/app/api/plan/explain-polish/route.ts:138-144`).
6. Calls Anthropic `messages.stream` with the locked polish system prompt (constants from `lib/llmPolishPrompt`).
7. Returns a streaming `Response` (Content-Type `text/event-stream`).

**Response (200) — Server-Sent Events.** Three event kinds, each carrying the original `slotKey`:

- `plan_action_explanation_polish_chunk` — payload `{ slotKey, deltaText }`, emitted per token delta from the model.
- `plan_action_explanation_polish_done` — payload `{ slotKey, polishedText }`, emitted once with the final accumulated text after the stream closes.
- `plan_action_explanation_polish_error` — payload `{ slotKey, message }`, emitted if the Anthropic call throws mid-stream.

**Error cases:**
- 401 — no session
- 429 — polish quota exhausted
- 204 — polish disabled by env
- 400 — invalid JSON or schema failure
- 503 — `ANTHROPIC_API_KEY` missing

---

### 2.9 `/api/plan/stage2` — Stream FOSE section enrichments per future term

**Source:** `apps/web/app/api/plan/stage2/route.ts:130-292`

**Request body:**
- `slotKey` — string (required, 1-200 chars). Bubble identifier.
- `futureTerms` — array of solver-format term strings (e.g. `"2026-fall"`), 1-8 entries, each 1-50 chars.

**What it does:**

1. Auth gate.
2. Rate-limit on dedicated bucket `plan-stage2:<studentId>`, cap 200/day.
3. Parses and validates body.
4. Loads the student's latest persisted schedule and scheduling preferences (best-effort — failures fall through to per-term unavailable signals).
5. For each term in `futureTerms`:
   - Extracts the `specific_planned` slot `courseId`s from the schedule.
   - If no schedule loaded → emits an `unavailable` enrichment event.
   - If no concrete courses in that term → emits a `warn` event.
   - Otherwise calls `materializeSections` (engine) with the term code, course ids, a no-op swap hook, and the loaded preferences. The result is classified by `classifyMaterialization` (`apps/web/app/api/plan/stage2/route.ts:80-108`) into `ok` / `warn` / `unavailable`.
6. After every term emits, sends a single `plan_action_stage2_done` event and closes the stream.

**Response (200) — Server-Sent Events.** Two event kinds:

- `plan_action_stage2_enrichment` — payload `{ slotKey, term, status, message }` where status is one of `pending` | `ok` | `warn` | `unavailable`. The message format starts with `[<term>]` so the bubble reducer can key per-term entries from the substring.
- `plan_action_stage2_done` — payload `{ slotKey }`, terminator.

Stage 2 is best-effort: a FOSE failure for one term produces an `unavailable` enrichment, never a 5xx that would block the bubble's Confirm button.

**Error cases:**
- 401 — no session
- 429 — stage2 quota exhausted
- 400 — invalid JSON or schema failure

---

## 3. The `planActionRouteHelpers` Utility Module

**Source:** `apps/web/lib/planActionRouteHelpers.ts`

The helper module centralizes the boilerplate that every per-verb route would otherwise duplicate. It exports two main entry points:

### 3.1 `preflight` (internal — `apps/web/lib/planActionRouteHelpers.ts:46-96`)

Runs the gates every plan-action route needs, in order:

1. **Auth.** `readSessionFromRequest(req)` resolves the session from cookies. Missing session → 401 `{ error: "Unauthorized" }`.
2. **Rate-limit.** `consumeRequest("plan-action:<studentId>", PLAN_ACTION_LIMIT_PER_DAY)` debits one unit from the per-student per-day bucket. The cap is 60 (`apps/web/lib/planActionRouteHelpers.ts:35`). On exhaustion, returns 429 with `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers.
3. **JSON parse.** Attempts `req.json()`. Malformed JSON → 400 with the underlying parse error in the body.

On success, returns `{ ok: true, studentId, body }`. The studentId is extracted from `auth.sub`.

### 3.2 `handleProposeRoute<T>` (`apps/web/lib/planActionRouteHelpers.ts:141-168`)

Each propose verb (`add`, `move`, `swap`, `drop`, `lock`) calls this with three arguments: the request, a Zod schema for the body, and a `buildMutations` callback that lifts the validated input to a `PlanMutation[]`.

Flow:
1. Run `preflight`. Early-return its response on any 4xx/5xx.
2. Validate the body via `schema.parse`. On failure, format Zod issues via `formatZodIssues` (`apps/web/lib/planActionRouteHelpers.ts:127-134`) and return 400.
3. Call `buildMutations(parsed)`. If the resulting array is empty, return 400 `"Empty mutation list — nothing to propose."` (this is how `/api/plan/move` surfaces the no-op same-term case).
4. Call `runProposeStage(studentId, mutations)` from the orchestrator.
5. On orchestrator failure, map the typed error to an HTTP status via `mapProposeError`.
6. On success, return 200 JSON with the orchestrator's response.

### 3.3 `handleConfirmRoute` (`apps/web/lib/planActionRouteHelpers.ts:176-201`)

Used only by `/api/plan/confirm`. Same preflight as propose, then:

1. Validate the body against the schema (expects `{ pendingMutationId, force? }`).
2. Call `runConfirmStage(studentId, pendingMutationId, { force })`.
3. On orchestrator failure, map via `mapConfirmError`.
4. On success, return 200 JSON.

### 3.4 Error mapping

| Error kind | HTTP | Meaning |
|---|---|---|
| `no_profile` | 409 | Student has no persisted profile row |
| `no_dpr` | 409 | No parsed DPR available |
| `no_schedule` | 409 | No forward plan exists yet |
| `engine_error` | 500 | The engine tool threw |
| `unknown_mutation_id` | 404 | Confirm-only: staging entry expired or missing |
| `studentId_mismatch` | 403 | Confirm-only: cross-tenant id attempt |

Source: `apps/web/lib/planActionRouteHelpers.ts:101-125`.

### 3.5 Test-only exports

`_PLAN_ACTION_LIMIT_PER_DAY_FOR_TESTS` and `_RATE_BUCKET_PREFIX_FOR_TESTS` are re-exported for the route test suites (`apps/web/lib/planActionRouteHelpers.ts:204-205`).

## 4. Common Patterns

All five propose routes follow the same six-step pattern:

```mermaid
sequenceDiagram
    participant Client
    participant Route as /api/plan/<verb>
    participant Helper as handleProposeRoute
    participant Orch as runProposeStage
    participant Engine as proposePlanChangeTool
    participant Stage as pendingMutations map

    Client->>Route: POST JSON body
    Route->>Helper: schema + buildMutations
    Helper->>Helper: auth gate (401)
    Helper->>Helper: rate-limit (429)
    Helper->>Helper: JSON parse (400)
    Helper->>Helper: Zod validation (400)
    Helper->>Helper: buildMutations -> PlanMutation[]
    Helper->>Orch: runProposeStage(studentId, mutations)
    Orch->>Orch: load profile + DPR + schedule + prefs
    Orch->>Engine: proposePlanChangeTool.call({ mutations })
    Engine-->>Orch: feasible, diff, consequences, conflicts, proposedSchedule
    Orch->>Stage: stash { studentId, mutations, createdAt }
    Orch-->>Helper: response with pendingMutationId
    Helper-->>Route: NextResponse.json(response)
    Route-->>Client: 200 JSON
```

### 4.1 The `PlanActionResponse` shape

Returned by every propose route (source: `apps/web/lib/planActionOrchestrator.ts:77-86`). Pseudo-shape:

- `feasible` — boolean from the engine.
- `diff` — engine's diff summary.
- `consequences` — engine-emitted list of side effects.
- `conflicts` — optional list of solver-tagged conflicts (present on infeasible outcomes).
- `planDiff` — optional structured `PlanDiff`.
- `explanation` — deterministic template explanation string.
- `pendingMutationId` — UUID for the staged mutation (to be passed back to `/api/plan/confirm`).
- `futureTerms` — chronologically-sorted array of solver-format term strings that fall within the FOSE data window (~6 months ahead). The client uses this to drive `/api/plan/stage2` fan-out.
- `forwardSchedule` — optional. The proposed (non-persisted, preview-only) `ForwardSchedule` the apply would produce.

### 4.2 The `PlanConfirmResponse` shape

Returned by `/api/plan/confirm` (source: `apps/web/lib/planActionOrchestrator.ts:89-98`):

- `feasible`, `diff`, `consequences`, `conflicts`, `planDiff` — same as above.
- `storedIn` — discriminated string: `"forwardSchedule"` or `"studentDraftPlan"`. Indicates which slot the engine wrote the resulting schedule into.
- `forwardSchedule` — the persisted schedule (in either slot).
- `consumedMutationId` — the UUID just consumed; no longer resolvable in the staging map.

### 4.3 Per-route concerns shared by the verbs

- **Runtime.** Each route declares `export const runtime = "nodejs"` — required because the engine relies on Node-only APIs (`crypto.randomUUID`, filesystem reads for the bundled catalog).
- **Auth.** Cookie-based session via `readSessionFromRequest`; the studentId is the JWT `sub`.
- **Rate-limit bucket.** Five propose verbs + confirm share `plan-action:<studentId>` (60/day). Polish uses `plan-polish:<studentId>` (200/day). Stage2 uses `plan-stage2:<studentId>` (200/day). Separation prevents a click flurry from draining the chat quota.
- **Body validation.** Zod schemas declared in the route file. `swap` uses `.strict()` on both arms of the union so a body containing fields from both arms fails.
- **Cross-tenant safety.** The confirm route checks that the staged mutation's stored `studentId` equals the requesting student's `sub` — a guessed UUID from another student returns 403, not 404.
- **Single-use.** A successful confirm deletes the staging entry; double-clicking returns 404.

### 4.4 Why these complement `/api/chat/v2`

`/api/chat/v2` is the LLM-driven path: free-text input, the agent loop runs, the model decides which tools to call. The agent can itself invoke `propose_plan_change` and `confirm_plan_change` mid-conversation.

The plan-action routes bypass the agent loop entirely. They are the deterministic counterpart, designed for student-initiated UI gestures where:

- **Latency matters.** A drag-to-move should feel instant. The agent loop adds at minimum one model round-trip; the plan-action routes hit the engine directly in ~180-600ms.
- **No ambiguity exists.** A drag from term A to term B has a single, unambiguous `PlanMutation[]` encoding. There is nothing for the LLM to interpret.
- **Token budget is precious.** Every drag should not cost Anthropic credits. The propose stage costs zero tokens. The polish call is optional, env-gated, and uses Haiku with a strict rewrite-only prompt; the engine output is the source of truth.
- **Side-by-side bubble UX.** The agent loop emits chat turns. The plan-action routes emit a structured `pendingMutationId` plus a deterministic template that the UI surfaces as a confirm-bubble — clearly distinct from a model reply.

The two paths share the engine's two tools (`proposePlanChangeTool`, `confirmPlanChangeTool`), so the validation semantics, the conflict-kind taxonomy, and the persisted state model are identical. The plan-action routes simply skip the agent shell and call the tools directly, in a fresh `ToolSession` rebuilt from the persistence stores.

```mermaid
flowchart TB
    subgraph LLM Path
        ChatIn[free-text input] --> ChatV2[/api/chat/v2/]
        ChatV2 --> Loop[agent loop]
        Loop --> Tools[propose_plan_change + confirm_plan_change]
    end
    subgraph Deterministic Path
        Gesture[drag/click] --> PlanRoutes[/api/plan/verb/]
        PlanRoutes --> Orch[runProposeStage / runConfirmStage]
        Orch --> Tools
    end
    Tools --> Engine[engine validators + solver]
    Engine --> Store[(scheduleStore + profileStore)]
```
