# Phase 17 — Deterministic Sidebar Actions + Two-Stage Validation + Confirm Bubbles

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Architectural principle (read first)

**Sidebar mutations are deterministic engine calls, not LLM round-trips.** Phase 14/15 shipped sidebar slot-popover affordances ("Lock as-is" / "Replace with a different course" / "Drop this slot" / "Pin to a different term") that worked by injecting a chat message → letting the LLM re-interpret the intent → maybe calling the right tool. That's slow (1–30s per click), non-deterministic (LLM can misread), expensive (burns API tokens), and brittle (fails on courses that are literally on-screen).

Phase 17 makes the sidebar a **first-class state-mutation surface**: each click hits a dedicated route, runs the same deterministic `propose_plan_change` engine logic the agent uses, and returns a structured diff. The chat thread only sees noise when there's something to confirm or refuse — clean applies stay silent.

The four UI verbs (**Add / Swap / Drop / Lock**) collapse the previous five-verb model (`pin` was conflating "place" with "freeze on re-plan"). Drag-to-move handles the spatial intent (move existing course to a different term); drag-to-exchange handles cross-term swap (drag pill A onto slot B → atomic 2-mutation batch). The engine's existing `PlanMutation` array support handles batch atomicity natively — no transient duplicate-state false-rejections.

Validation runs in two stages. Stage 1 (structural) blocks on prereqs / credit caps / F-1 floor / requirement fulfillment — fast (180–600ms typical). Stage 2 (FOSE section availability) streams in as enrichment for future terms within the FOSE data window — slower (500ms–2s), best-effort, never blocks the user's confirm decision. Stage 1 + Stage 2 are independent engine pipelines (Phase 13/14 + Phase 15 respectively); Phase 17 just orchestrates them at the route layer.

When a mutation has trade-offs or is refused, the chat surfaces an **inline confirm bubble** with deterministic template text the instant the engine returns (no LLM blocking the critical path). An LLM polish call streams a more natural rewrite into the bubble ~1–2s later, replacing the template — purely cosmetic, never gates the Confirm/Keep-as-is buttons.

**Before implementing:** read `docs/PHASE_PLANS_README.md` for the cross-phase decision list + pre-flight checks. Phase 17 introduces no new validation logic — it surfaces existing Phase 13/14/15 engine primitives through deterministic UI affordances.

---

**Goal:** Replace the chat-mediated sidebar slot affordances with deterministic engine-backed routes. Add an "+ Add course" entry-point per term card. Wire drag-to-move and drag-to-exchange. Inline confirm bubbles render template text immediately, then upgrade to LLM-polished prose in the background. Two-stage validation gives users fast structural verdicts followed by FOSE enrichment for terms within the section-data window.

**Architecture:** Four new routes (`/api/plan/add`, `/swap`, `/drop`, `/lock`), one engine extension (`pin` mutation gains a `freeze: boolean` flag; new `explainPlanDiff` template helper), one sidebar refactor (drag-and-drop + new picker submenus + inline Add affordance), one chat extension (new message kind for inline confirm bubbles), and one optional system-prompt update (auto-chain `plan_forward_degree` → `materialize_sections` for the immediate term so "plan my schedule" answers include section-level data without a second ask).

---

## Decisions referenced in this phase

| # | Decision | Source |
|---|---|---|
| 16 | FOSE per-call availability gating (full / partial / unavailable) | Phase 15 |
| 18 | Conflict-free combination enumeration | Phase 15 |
| 19 | Course-swap cascade on unavailable / pref-eliminated | Phase 15 |
| 22 | Slot rationale fields | Phase 13 |
| 23 | `PlanMutation` discriminated union (multi-mutation array support) | Phase 14 |
| 32 | 4-state `PlanState` union (valid-clean / valid-with-trade-offs / infeasible-draft / student-preferred-invalid-draft) | Phase 13 |
| 40 | `ValidationResult` 4-state union | Phase 13 |
| 42 | 4-tier preference-extraction fallback hierarchy | Phase 14 |
| 43 | `SchedulingPreferences` (time/day filters) | Phase 14/15 |

No new decisions in Phase 17.

---

## Locked design choices (confirmed before implementation)

1. **Four UI verbs** (Add / Swap / Drop / Lock). The legacy verb "Pin" is dropped — its two roles (place + freeze) are split between Add (place without freeze) and Lock (freeze without re-place). Drag-to-move covers same-course-different-term; drag-to-exchange covers cross-term swap.
2. **Engine extension**: the `pin` mutation kind gains an optional `freeze: boolean` flag (default `true` to preserve existing semantics). Add sends `freeze: false`; Lock sends `freeze: true`. ~10 LOC engine change with backwards-compatibility tests.
3. **Cross-term exchange = `PlanMutation[]` batch**. The drag-A-onto-B gesture sends `[{kind: "swap", drop: A, add: B, term: T_A}, {kind: "swap", drop: B, add: A, term: T_B}]` to `/api/plan/swap`. The Phase 14 multi-mutation atomic apply already handles this without flagging duplicates. No new mutation kind needed.
4. **Two-stage validation**: Stage 1 = structural (Phase 13/14 pipeline, always runs, 180–600ms typical, NEVER hits FOSE). Stage 2 = FOSE section materialization (Phase 15 pipeline, future terms only, within the FOSE data window, streams in as enrichment 500ms–2s after Stage 1 returns).
5. **Hybrid confirm bubble**: deterministic template renders the instant Stage 1 returns; LLM polish streams a natural-language rewrite ~1–2s later, REPLACING the template text. Buttons (Confirm / Keep-as-is / Override-anyway) stay live throughout — clicking before the polish lands still works.
6. **LLM polish prompt is constrained**: system prompt locks the model to "rephrase, do NOT add new facts or claims; preserve every course code and credit number verbatim." Same Cardinal-Rule §2.1 anchor that prevents hallucination across the rest of the agent surface.
7. **Refusal handling**: hard refusals (prereq violation, graduation infeasibility) show a refusal-bubble with no buttons. Soft refusals (credit-floor breach, F-1 cap exceeded, exclusion-set violation) show a refusal-bubble with an **"Override anyway"** link that flips the resulting plan into Decision #32's `student-preferred-invalid-draft` slot.
8. **Latency UX**:
    - 0–150ms: nothing visible (clean apply commits silently).
    - 150ms+: clicked slot shows an inline spinner; popover stays open with "Validating…".
    - 600ms+: sidebar-bottom toast as backup ("Validating plan change…").
    - On Stage 1 response: spinner removes, either silent commit (clean) OR template confirm/refusal bubble (trade-offs/refusal).
    - On Stage 2 response: enrichment signal streams into the same bubble ("✓ Open sections exist" / "⚠ No open sections — only waitlists" / "⚠ Time conflict with [other course in same term]" / "ℹ Section data unavailable for this term yet"). Never blocks Confirm.
9. **LLM-polish feature flag**: `NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH=1` gates the polish call. Ships dark; turns on after measuring real engine latency. Templates are good enough for V1 if the engine consistently returns in <300ms.
10. **Optional auto-chain**: when the agent calls `plan_forward_degree` and the resulting schedule has at least one non-locked future semester, it follows up automatically with `materialize_sections({targetTerm: <immediate term>})`. The system prompt's routing block adds an explicit instruction; no engine change. (Side-question fix from operator's review of the Phase 17 design.)

---

## Engine primitives already exist

The Phase 14 `PlanMutation` discriminated union ([packages/shared/src/types.ts:1117-1127](packages/shared/src/types.ts:1117)) already covers every operation Phase 17 needs:

| Phase 17 verb | Existing primitive | Phase 17 change |
|---|---|---|
| Add | `{kind: "pin", courseId, term}` | Add optional `freeze: false` |
| Swap (same term) | `{kind: "swap", drop, add, term}` | none |
| Drag-to-exchange (cross-term) | `[swap, swap]` batch | none — multi-mutation already supported |
| Drop | `{kind: "exclude", courseId, term?}` | none |
| Lock | `{kind: "pin", courseId, term, freeze: true}` | uses the new `freeze` flag |
| Drag-to-move | `[exclude, pin]` batch OR a new `{kind: "move", courseId, fromTerm, toTerm}` for clarity | TBD — see Task 17.A decision below |

---

## Tasks

### Task 17.A — Engine extensions

**Files (modify):**
- `packages/shared/src/types.ts` — extend `PlanMutation.pin` with `freeze?: boolean` (defaults to `true` for backwards-compat).
- `packages/engine/src/agent/forwardSchedule/planChangeHelpers.ts` — apply the `freeze` semantic: when `freeze === true`, write to `session.schedulePreferences.pins[]`; when `freeze === false`, skip the pin write.
- `packages/engine/src/agent/forwardSchedule/planChangeHelpers.ts` — add `explainPlanDiff(diff: PlanDiff, mutation: PlanMutation): string` helper. Pure function, deterministic, ~80 LOC. Renders the diff into a confirm-bubble template like:
  > "Pinning **MATH-UA 343** to **Spring 2027** would: (1) move it out of Fall 2026, dropping that semester from 28 → 24cr (still over the 18-cap — F-1 floor unaffected). (2) Bump Spring 2027 from 16 → 20cr (within cap). **No prereq or major-requirement issues.**"
- `packages/engine/src/agent/tools/proposePlanChange.ts` — return `explanation: string` (template-rendered) on the response payload so the route can stream it without re-deriving.
- `packages/engine/tests/agent/proposePlanChange.test.ts` — extend with: `freeze: false` write skips pins[]; `freeze: true` writes pins[]; `explainPlanDiff` for each mutation kind; backwards-compat (omitting `freeze` defaults to `true`).

**Files (create):**
- `packages/engine/src/agent/forwardSchedule/explainPlanDiff.ts` — the template renderer (extract from planChangeHelpers if it grows large).
- `packages/engine/tests/agent/explainPlanDiff.test.ts` — per-kind template tests.

**Decision in this task**: drag-to-move primitive. Two options:
- **Option A**: keep using `[exclude, pin]` batch — simple, no new primitive.
- **Option B**: add `{kind: "move", courseId, fromTerm, toTerm}` — clearer engine semantics, single mutation, easier to log/audit.

Default = Option B (one new mutation kind, ~30 LOC engine change, ~20 LOC tests). The audit row in `audit_log` reads cleaner ("move CSCI-UA 421 from 2026-fall to 2027-spring") than "exclude CSCI-UA 421 in 2026-fall + pin CSCI-UA 421 in 2027-spring".

**Verification:**
```bash
cd "/Users/edoardomongardi/Desktop/Ideas/NYU Path"
node_modules/.bin/vitest run packages/engine/tests/agent/proposePlanChange.test.ts packages/engine/tests/agent/explainPlanDiff.test.ts packages/engine/tests/agent/confirmPlanChange.test.ts
npx tsc --noEmit -p packages/engine 2>&1 | grep "error TS" | wc -l   # expect 8
```

**Commit:**
```bash
git commit -m "feat(engine): pin freeze flag + move primitive + explainPlanDiff template (Phase 17 Task A)

- PlanMutation.pin gains optional freeze: boolean (default true; backwards-compat). Add sends freeze=false (place without locking solver), Lock sends freeze=true (write to SchedulePreferences.pins[]).
- New PlanMutation.move primitive ({courseId, fromTerm, toTerm}) for clean drag-to-move audit semantics.
- explainPlanDiff(diff, mutation) deterministic template renderer (~80 LOC). Pure function. Used by Phase 17's confirm-bubble fast path before LLM polish streams in.

No semantic change to existing pin/swap/exclude paths. backwards-compat tests pin the default freeze=true behavior."
```

---

### Task 17.B — Plan-action routes + two-stage orchestrator

**Files (create):**
- `apps/web/app/api/plan/add/route.ts` — POST `{courseId, term}`. Constructs `{kind: "pin", courseId, term, freeze: false}` mutation. Routes through Stage-1 + Stage-2 orchestrator. Returns `{stage1: PlanDiff & {explanation: string}, stage2Promise: ...}`.
- `apps/web/app/api/plan/swap/route.ts` — POST `{drop: string, add: string, term: string}` for single-term swap, OR POST `{exchanges: Array<{a: SlotRef, b: SlotRef}>}` for cross-term exchange (constructs the 2-mutation batch).
- `apps/web/app/api/plan/drop/route.ts` — POST `{courseId, term?}`. Constructs `{kind: "exclude", courseId, term}`.
- `apps/web/app/api/plan/lock/route.ts` — POST `{courseId, term, locked: boolean}`. Constructs `{kind: "pin", courseId, term, freeze: locked}`. Toggle: `locked: true` to lock, `locked: false` to unlock (removes from pins[]).
- `apps/web/app/api/plan/move/route.ts` — POST `{courseId, fromTerm, toTerm}`. Uses new `move` mutation kind from Task A.
- `apps/web/lib/planActionOrchestrator.ts` — shared two-stage orchestrator helper. Stage 1 runs `proposePlanChange` synchronously; Stage 2 (if applicable) runs `materializeSections` for the affected future term and is yielded as an SSE-friendly async iterator.
- `apps/web/tests/planAddRoute.test.ts`, `planSwapRoute.test.ts`, `planDropRoute.test.ts`, `planLockRoute.test.ts`, `planMoveRoute.test.ts`, `planActionOrchestrator.test.ts` — route + orchestrator tests.

**Behavior**: each route follows the same shape:
1. Auth via `readSessionFromRequest`. 401 if absent.
2. Rate-limit via `consumeRequest` with `plan-action:${studentId}` bucket (separate from chat-rate bucket).
3. Validate input shape (Zod).
4. Load session state (profile, DPR, schedule, preferences) from stores.
5. Run Stage 1 via `proposePlanChange` engine logic — synchronous, returns the structured diff + explanation template.
6. If the mutation places a course into a future term within the FOSE data window, fork Stage 2 in a background task that calls `materializeSections` and posts the result via the v2 SSE stream (`forward_materialization_update` event already wired in Phase 15).
7. Persist the mutation via `confirmPlanChange` engine logic ONLY when the user confirms — Stage 1 + Stage 2 are validation only; the actual persist comes from a subsequent confirm action.
8. Return the Stage-1 payload immediately. Stage-2 enrichment streams via the existing SSE channel.

**Verification:**
```bash
cd "/Users/edoardomongardi/Desktop/Ideas/NYU Path"
node_modules/.bin/vitest run apps/web/tests/planAddRoute.test.ts apps/web/tests/planSwapRoute.test.ts apps/web/tests/planDropRoute.test.ts apps/web/tests/planLockRoute.test.ts apps/web/tests/planMoveRoute.test.ts apps/web/tests/planActionOrchestrator.test.ts
npx tsc --noEmit -p apps/web 2>&1 | grep "error TS" | wc -l   # expect 9
```

**Commit:**
```bash
git commit -m "feat(web): five deterministic plan-action routes + two-stage validation orchestrator (Phase 17 Task B)

Routes:
- POST /api/plan/add    — place a new course in a chosen term (pin freeze=false)
- POST /api/plan/swap   — replace X with Y in the same term, OR cross-term exchange via 2-mutation batch
- POST /api/plan/drop   — exclude a course from the plan
- POST /api/plan/lock   — toggle the solver freeze flag for a slot (pin freeze=true/false)
- POST /api/plan/move   — drag-to-move; uses new move mutation kind

Each route runs Stage 1 (structural validation via propose_plan_change, ~180-600ms) synchronously and returns the diff + template explanation. When the mutation places a course into a future term within the FOSE data window, Stage 2 (materialize_sections) forks in the background and streams the enrichment signal via the existing forward_materialization_update SSE event.

Persistence only fires on subsequent /api/plan/confirm — Stage 1 + Stage 2 are validation only."
```

---

### Task 17.C — Sidebar UI: 4 verbs + drag + Add affordance

**Files (modify):**
- `apps/web/app/chat/scheduleSidebar.tsx`:
  - Replace the existing 4-action popover (Lock / Replace / Drop / Pin) with the new 4-verb popover (**Add** is per-term-card, not per-slot, so it doesn't appear here; **Swap / Drop / Lock / Move** are per-slot).
  - **Lock**: single click → POST `/api/plan/lock` with `{locked: !slot.isLocked}`. Locked slots show 🔒 icon + muted styling (already exists from Phase 16 Task C completed-slot pattern).
  - **Drop**: single click → POST `/api/plan/drop`. On clean response, slot disappears from sidebar; on trade-offs, confirm bubble in chat.
  - **Swap (same term)**: click → submenu with TWO sections — top = engine-suggested alternatives (call new `/api/plan/swap-candidates` route OR derive client-side from `forwardSchedule.semesters[i].slots` filtered by the slot's `satisfiesRules`), bottom = free-search input (autocomplete via `searchCourses`).
  - **Move**: click → submenu shows eligible target terms as buttons. Eligibility = engine-side check (a course can move to term T iff prereqs are satisfiable by T, T isn't at credit cap, T isn't the source term).
  - Drag-to-move: each non-locked slot's pill is `draggable`. Drop targets are non-locked term cards. On drop → POST `/api/plan/move` with `{courseId, fromTerm, toTerm}`.
  - Drag-to-exchange: dropping pill A on slot B (instead of an empty term card) → POST `/api/plan/swap` with `{exchanges: [{a, b}]}` for the cross-term batch.
- `apps/web/app/chat/scheduleSidebar.tsx` (per-term-card additions):
  - **+ Add course** button at the bottom of each non-locked future term card. Click → inline input opens with autocomplete pulling from the catalog. Type → suggestions render. Select → POST `/api/plan/add` with `{courseId, term}`.
- `apps/web/app/chat/chat.module.css`:
  - `.slotDraggable` (cursor: grab; active: cursor: grabbing).
  - `.termCardDropTarget` (highlight ring when a draggable is hovering over).
  - `.swapSubmenu`, `.moveSubmenu`, `.addCourseInput`, `.addCourseSuggestion` — picker styles.
  - Spinner state for slots awaiting Stage 1 response.

**Files (create):**
- `apps/web/lib/planActionClient.ts` — typed client wrappers for each route. Mirrors the `chatV2Client.ts` pattern.
- `apps/web/tests/planActionClient.test.ts` — client wrapper tests.

**Step-by-step:**
- [ ] Pre-flight read: current `scheduleSidebar.tsx` (slot popover + drag affordances if any), current `chat.module.css` (spinner / popover patterns to match).
- [ ] Implement `planActionClient.ts` typed wrappers + tests.
- [ ] Modify `scheduleSidebar.tsx`:
  - Refactor `SLOT_ACTIONS` array to the 4-verb model.
  - Wire each action's `onClick` to call the corresponding planActionClient function.
  - Add the per-term-card "+ Add course" affordance with autocomplete.
  - Add `draggable` + `onDragStart` / `onDragOver` / `onDrop` handlers for drag-to-move and drag-to-exchange.
  - Add Stage-1 spinner state (per-slot loading flag).
- [ ] CSS for the new affordances + drag highlight.

**Verification:**
```bash
cd "/Users/edoardomongardi/Desktop/Ideas/NYU Path"
node_modules/.bin/vitest run apps/web/tests/planActionClient.test.ts apps/web/tests/groupCoursesByTerm.test.ts
npx tsc --noEmit -p apps/web 2>&1 | grep "error TS" | wc -l   # expect 9
```

**Commit:**
```bash
git commit -m "feat(web): 4-verb sidebar (Add/Swap/Drop/Lock) + drag-to-move + drag-to-exchange (Phase 17 Task C)

Replaces the chat-mediated slot popover with deterministic engine-backed actions. Each verb hits the corresponding /api/plan/<action> route, runs Stage 1 in 180-600ms, and either silently commits or surfaces a confirm bubble.

Per-slot popover: Swap, Drop, Lock, Move (all with submenus where a destination is needed).
Per-term-card: + Add course button with catalog autocomplete.
Drag-to-move: drop a slot pill onto a different term card → atomic move.
Drag-to-exchange: drop slot A onto slot B in another term → atomic 2-mutation swap batch.

The legacy 'Pin' verb is gone (its two roles split between Add for placement and Lock for solver-freeze). The chat thread no longer sees the synthesized 'Please lock the slot for X — call propose_plan_change' message — clicks go straight to the engine."
```

---

### Task 17.D — Inline confirm bubble + LLM polish stream + latency UX

**Files (modify):**
- `apps/web/lib/chatV2Client.ts` — add new SSE event `plan_action_result` with payload `{slotKey, stage1: {explanation: string, requiresConfirm: boolean, refusalKind?: string}, stage2?: {kind: "ok" | "warn" | "unavailable", message: string}}`. Add a second event `plan_action_explanation_polish` carrying `{slotKey, polishedText: string}` that streams the LLM rewrite.
- `apps/web/app/chat/page.tsx` — new message kind `plan_action_bubble` rendered inline in the chat thread. Carries the slot ref, the template explanation, optional polished text (replaces template when present), Confirm + Keep-as-is buttons (and Override-anyway for soft refusals). Click Confirm → POST `/api/plan/confirm` (existing engine path).
- `apps/web/app/chat/chat.module.css` — `.planActionBubble`, `.planActionBubble_confirm`, `.planActionBubble_refusal`, `.planActionBubbleButtons`, `.planActionBubbleStage2_warn`, etc.

**Files (create):**
- `apps/web/app/api/plan/explain-polish/route.ts` — POST `{slotKey, templateText, structuredDiff}`. Calls Anthropic Haiku with constrained system prompt ("rephrase, do NOT add new facts; preserve every course code and credit number verbatim"). Streams the polished text. Gated on `NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH=1`.
- `apps/web/lib/llmPolishPrompt.ts` — the system prompt + few-shot examples constraining the polish. Keep examples in `references/llmPolishPrompt.examples.md` if they grow large.
- `apps/web/tests/llmPolishPromptShape.test.ts` — verifies the prompt shape (no facts added, course codes preserved).

**Step-by-step:**
- [ ] Pre-flight read: `chatV2Client.ts` event-union shape + existing message kinds in `page.tsx`.
- [ ] Implement the new SSE event types + page-side handler that creates the inline bubble.
- [ ] Wire each plan-action route from Task B to emit `plan_action_result` after Stage 1.
- [ ] Wire the LLM-polish route + page-side handler that replaces the template text with the polish when it streams in.
- [ ] CSS for the bubble variants.
- [ ] Latency UX: spinner thresholds (150ms → slot spinner; 600ms → sidebar toast).

**Verification:**
```bash
cd "/Users/edoardomongardi/Desktop/Ideas/NYU Path"
node_modules/.bin/vitest run apps/web/tests/llmPolishPromptShape.test.ts apps/web/tests/chatV2Client.test.ts
npx tsc --noEmit -p apps/web 2>&1 | grep "error TS" | wc -l   # expect 9
```

**Commit:**
```bash
git commit -m "feat(web): inline confirm bubbles + LLM polish stream + latency UX (Phase 17 Task D)

Plan-action routes return Stage 1 in 180-600ms with a deterministic template explanation. The chat thread renders the explanation in a new plan_action_bubble message kind with Confirm / Keep-as-is buttons (and Override-anyway for soft refusals).

LLM polish (gated on NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH=1) streams a natural-language rewrite into the same bubble ~1-2s later, replacing the template text. Prompt locks the model to 'rephrase, do not add facts'. Buttons stay live throughout — clicking before polish lands works.

Latency UX: slot spinner at 150ms+, sidebar toast at 600ms+. Clean applies stay silent (no chat noise)."
```

---

### Task 17.E — Optional: agent auto-chain `plan_forward_degree → materialize_sections`

**Files (modify):**
- `packages/engine/src/agent/systemPrompt.ts` — extend the `plan_forward_degree` routing block to instruct the agent: "After `plan_forward_degree` returns successfully and the result has at least one non-locked future semester, call `materialize_sections({targetTerm: <first non-locked semester>})` to fill in section-level data for the immediate registration term. Other future terms are structural-only by design (FOSE has no data for them yet)."
- `packages/engine/tests/eval/phase5.test.ts` (or a new file) — assert the system prompt contains the chain instruction.

**Verification:**
```bash
cd "/Users/edoardomongardi/Desktop/Ideas/NYU Path"
node_modules/.bin/vitest run packages/engine/tests/eval/phase5.test.ts
```

**Commit:**
```bash
git commit -m "feat(engine): system-prompt nudge to chain plan_forward_degree → materialize_sections (Phase 17 Task E)

Closes the UX gap where 'plan my schedule' produced a structural plan with no section-level data for the immediate registration term, requiring the student to know to ask separately. The agent now auto-chains materialize_sections for the first non-locked semester after plan_forward_degree returns."
```

---

### Task 17.F — Manual verification + push (combined Phase 16 + 17)

After Phase 17 lands locally, the operator runs the dev server and verifies:

1. **Lock/unlock**: click a future-term slot → "Lock" → 🔒 icon appears. Click again → "Unlock" → icon removes. Solver re-plan keeps locked courses in place.
2. **Drop**: click a future-term slot → "Drop" → either silent removal OR confirm bubble (if drop has trade-offs).
3. **Swap (same term)**: click slot → "Swap" → submenu shows ~5 engine-suggested alternatives + free-search. Select one → confirm bubble appears with template, then upgrades to LLM polish.
4. **Move via drag**: drag a slot pill from term A to term B → atomic move. Confirm bubble appears with diff.
5. **Cross-term exchange via drag**: drag slot A in term T1 onto slot B in term T2 → atomic 2-mutation swap. Confirm bubble shows both impacts.
6. **Add new course**: click "+ Add course" on a future term card → autocomplete picker → type "CSCI-UA 480" → select → confirm bubble.
7. **Refusal**: try to drop a major-required course → refusal bubble (no buttons) explaining why.
8. **Soft refusal**: try to add a 5th course to a term already at the F-1 floor → refusal bubble with "Override anyway" link → click Override → plan lands as `student-preferred-invalid-draft`.
9. **LLM polish**: bubble starts with template text, after ~1-2s the wording shifts to polished prose. Course codes + credit numbers stay verbatim.
10. **Stage 2 enrichment**: after Stage 1 returns, watch the bubble for the FOSE-section signal ("✓ Open sections exist" or "⚠ No open sections" etc).
11. **Auto-chain**: ask "plan my schedule" → agent runs `plan_forward_degree` then `materialize_sections` for the immediate term automatically. Sidebar's IMMEDIATE term shows Sections view.
12. **Persistence**: refresh after each action → state survives.

**Push** after all 12 scenarios green:
```bash
git push origin main   # ships Phase 16 + Phase 17 commits together
```

---

## Test inventory (across all 5 tasks)

| Layer | New tests |
|---|---|
| `pin freeze` flag (engine) | ~4 |
| `move` mutation primitive | ~3 |
| `explainPlanDiff` template | ~10 (one per mutation kind + edge cases) |
| `/api/plan/add` route | ~4 |
| `/api/plan/swap` route (single + batch) | ~5 |
| `/api/plan/drop` route | ~3 |
| `/api/plan/lock` route | ~3 |
| `/api/plan/move` route | ~3 |
| `planActionOrchestrator` (Stage 1 + Stage 2) | ~5 |
| `planActionClient` typed wrappers | ~5 |
| LLM polish prompt shape | ~3 |
| System-prompt auto-chain assertion | ~1 |

**Total new tests:** ~49.

---

## Pre-existing baselines (must not regress)

- Engine TS errors: `8`.
- Web TS errors: `9`.
- Engine test failures: `4` (pre-existing phase3 / semesterPlanner baseline).

---

## Out of scope for Phase 17 (defer)

- **Drag-to-add**: dragging an autocomplete result from search into a term card. Cute but the click-input flow already covers this; drag adds complexity without UX win.
- **Bulk operations**: multi-select slots and drop/lock all at once. Real but rare; defer to a Phase 18+ if students ask.
- **Visual diff overlay on the sidebar**: when a confirm bubble appears, highlight the affected slots in the sidebar with before/after styling. Polish.
- **Plan version history**: the DB keeps superseded `forward_schedules` rows for audit (Phase 16 Task A); a "show me my plan from last week" UI is a future feature.
- **LLM-suggested alternatives in the Swap submenu**: today the alternatives come from "courses that satisfy the same requirement pool". An LLM could rank them by likely fit. Defer to Phase 18+.
