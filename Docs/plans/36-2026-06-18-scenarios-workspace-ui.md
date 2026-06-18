# Scenarios Workspace UI — Implementation Plan (plan 36)

> **For agentic workers:** REQUIRED SUB-SKILL — execute task-by-task via `superpowers:subagent-driven-development` (fresh implementer per task + spec review + code-quality review), the same flow that built plans 34–35. Steps use checkbox (`- [ ]`) tracking. Verify per the gates in §11.
>
> **Status: PLAN — approved design (mockup confirmed 2026-06-18: `Docs/mockups/scenarios-ui-mockup.html`), ready to implement.** Branch off `main` (after plan 35 merges) → `feat/plan36-scenarios-ui`.

---

> ## ✅ COMPLETE — 2026-06-18 (on `feat/plan36-scenarios-ui`, not yet merged)
>
> All tasks **H0–H7 are DONE + self-verified** on branch `feat/plan36-scenarios-ui`. Commit range `614656a` (plan + mockup) … `b946cc7` (HEAD); 22 commits. **Full suite: 2453 passed / 15 skipped** (`npx vitest run` at repo root); engine + web `tsc --noEmit` clean.
>
> **What shipped (verified against the live code):**
> - **H0** `lib/scenarios/scenarioModel.ts` (pure `Scenario` + reducers; `confirmProposed` = the commit chokepoint) + `planState.ts` refactored onto it via a **compat facade** (legacy `PlanState` snapshot derived + cached, object-identity preserved via a `previewObjects` side-table; new scenario API added; existing consumers/tests untouched + green).
> - **H1** `lib/scenarios/scheduleDiff.ts` — pure two-column `diffSchedules` (`same|added|removed|moved|retake`; J-term ordinal matches engine `SEASON_ORD`).
> - **H2** `workspace/ThreeZoneShell.tsx` (chat · `ScheduleWorkspace` · right-zone) mounted in `page.tsx`; `workspace/ScheduleView.tsx` (read-only diff-aware grid); `workspace/ScheduleWorkspace.tsx` (pinned 📌 committed tab + scenario tabs, NO +new, per-kind action bodies, ARIA tabs pattern).
> - **H3** `workspace/CompareView.tsx` — pick ANY two scenarios (incl. committed) → two `ScheduleView` columns via `diffSchedules` + a diff legend; wired into the workspace's compare mode.
> - **H4** chat `ScheduleCard.tsx` + `buildScheduleCardMessage.ts` (`schedule_card` Message → Open/Compare); `handlePlanActionResult` / `handleWhatIfResult` emit a card; Confirm → `applyReviewConfirm` (`/api/plan/confirm`) + `confirmProposed`. **3-branch what-if:** Branch-A = the `what_if_audit` engine tool emits an `offerAuditUpload` marker + `AUDIT_UPLOAD_OFFER:` summary line → the v2 route emits a `whatif_audit_request` SSE event → the client renders `WhatIfUploadCard.tsx` → `/api/whatif-audit` → `buildWhatIfScenarioFromAudit.ts` builds a READ-ONLY `kind:"whatif"` scenario (no `pendingMutationId` ⇒ never confirmable). Branch-B = `propose_whatif_assumption` → `/api/plan/whatif` → a confirmable proposed scenario.
> - **H5** `ProfileRail.tsx` — the RIGHT zone (profile-only): reuses `SummaryCard` (fed the COMMITTED schedule), the ↻ Update-DPR refresh (on success updates BOTH committed schedule + parsed DPR), the scenarios list (committed pinned + per-row Compare), the privacy note, and the delete-account / env-gated clear-all actions. **`scheduleSidebar.tsx` is now UNMOUNTED** (slated for deletion).
> - **H6** professional visual pass (§9) + the M3 tab/close nested-button restructure + the ARIA tabs polish.
> - **H7** this doc + the two `Docs/current-system/web/` docs (`ui-components.md` + `chat-ui-client.md`) revised.
>
> **Record / notable findings:**
> - **H4.2b probe→Branch-A finding + agent-tool decision:** a read-only `probe_counterfactual` PROGRAM-change exploration cannot produce an exact schedule without the Albert What-If audit, so the agent tool (`what_if_audit`) emits a structured `offerAuditUpload` marker that routes the student to the Branch-A audit **upload** (a labeled non-committed exploration), rather than guessing a synthetic program plan. The marker rides through as an `AUDIT_UPLOAD_OFFER:` summary line + a `whatif_audit_request` SSE event.
> - **node: client-bundle fix (`next.config.ts`):** a pre-existing `/chat` 500 (the `@nyupath/engine` barrel dragged `node:crypto`/`node:fs` into the CLIENT bundle via `scheduleDiff.ts → canonicalizeCourseId`) is fixed by stubbing `node:` core modules out of the CLIENT bundle only (`isServer` guard); the server bundle is untouched.
> - **Engine / R1 / frozen contract — UNTOUCHED.** Plan 36 is web-only. The ONLY engine touch was the `what_if_audit` tool's added `offerAuditUpload` marker + summary line (`packages/engine/src/agent/tools/whatIfAudit.ts` + its test) — the solver, the 7-axis validator, `finalizeForwardSchedule`, the DPR transforms, and `assertAuthoritativeDpr` were NOT modified. **R1 holds:** a what-if / synthetic DPR is never written to `students.parsed_dpr`; confirming a proposed scenario persists only the `forward_schedule`.
>
> ⚑ **Next:** owner review + merge `feat/plan36-scenarios-ui` → `main`, then push. Follow-on: delete the unmounted `scheduleSidebar.tsx`; persist computed what-ifs server-side (§12 deferred).

**Goal:** Replace the single-slot sidebar (one committed plan + one transient preview) with a **scenarios workspace**: a 3-zone shell (chat · schedule workspace · profile) where the committed plan is always anchored, every derived schedule is a clearly-labeled scenario you can open and **compare any two side-by-side**, and what-ifs are spawned only from the conversation.

**Architecture:** Web-only (Next.js/React). The engine, the frozen contract, the R1 guardrail, and DB persistence are **unchanged** — this is a state-store + presentation refactor. The current `planState` store (`{forwardSchedule, pendingPreview, invalidProposal}`) becomes a **scenarios store** (`committed` plan + a list of `Scenario` artifacts + an `activeId` + a `compare` pair). The committed plan still persists to `forward_schedules`; what-ifs are session-state re-derivable from their persistent chat card; confirming a proposed scenario promotes it to committed via the existing `/api/plan/confirm`.

**Tech Stack:** Next.js 16 / React 19, `useSyncExternalStore` (existing store pattern), CSS modules (`chat.module.css` + a new `workspace.module.css`), vitest (node for pure helpers; jsdom per-file for `*.render.test.tsx`, the F1 convention). Engine types via `@nyupath/engine` / `@nyupath/shared`.

---

## 1. North-star (binding — `Docs/core_philosophy.md`)
Professional academic-adviser UX for ALL NYU undergrad. The committed plan is the one authoritative thing; a what-if must be **unmistakably** distinct from it and never masquerade as a fact. Surface risk/trade-offs. The DPR stays authoritative (R1): a what-if never overwrites `students.parsed_dpr`, and only a confirmed proposed scenario (or a new DPR) changes the committed plan.

## 2. Why (the problem this fixes — verified against the code)
Today `planState.ts` holds exactly one committed schedule + one transient `pendingPreview` + one `invalidProposal` (all mutually exclusive). Consequences (all verified): no plan **history**, no **comparison**, and a staged preview **renders in place of** the committed plan (you can't see your real plan beside an exploration). Read-only explorations (`probe_counterfactual`) surface only as chat prose, not as viewable schedules. This plan lifts that ceiling.

## 3. Owner decisions (confirmed 2026-06-18)
1. **Layout shell:** three zones — **Chat** (left) · **Schedule workspace** (center) · **Profile** (right).
2. **Compare:** the user picks **any two** scenarios (incl. two what-ifs, not just vs-committed) → **side-by-side** columns with a diff highlight.
3. **What-if creation is chat-only** — there is **no "+ New what-if" UI control**. A what-if exists because the conversation produced it.
4. **Professional, bespoke visual design** (§9) — explicitly NOT a generic "AI chat" look.
5. **No mobile/responsive behavior** in this pass (desktop ≥ 1100px; degrade gracefully but don't design for narrow).

## 4. Status taxonomy (the three scenario kinds)
| Kind | Badge | Source | Confirmable? | Persists? |
|---|---|---|---|---|
| **committed** | ✓ green | the real DB plan; a confirmed proposed | n/a (it IS the plan) | yes (`forward_schedules`) |
| **proposed** | ⏳ amber | `propose_plan_change` (add/drop/swap/move) · `propose_whatif_assumption` (withdraw/PF — a trusted **action**) | **yes** → promotes to committed | no (until confirmed) |
| **whatif** | 🔍 blue | `probe_counterfactual` (read-only) · Branch-A `/api/whatif-audit` upload | **no** (read-only exploration) | session-only; re-derivable from its chat card |

## 5. File structure (web only — engine untouched)
- **Refactor** `apps/web/app/chat/planState.ts` → the scenarios store (the foundation, H0). Keep `useSyncExternalStore`, the commit chokepoint, and `createPlanStore({...})` for tests.
- **Create** `apps/web/lib/scenarios/scenarioModel.ts` — the `Scenario` type + pure reducers (`addScenario`, `confirmProposed`, `discardScenario`, `setActive`, `openCompare`) so the store is a thin `useSyncExternalStore` shell over pure, node-testable functions (repo idiom).
- **Create** `apps/web/lib/scenarios/scheduleDiff.ts` — pure `diffSchedules(a, b)` for the compare view (per-term, per-course `added | removed | moved | retake | same`). Built on the engine's `computeSlotDiff` where possible (imported from `@nyupath/engine`).
- **Modify** `apps/web/app/chat/page.tsx` — the 3-zone shell; wire `handlePlanActionResult` / `handleWhatIfResult` / probe results → `addScenario` + a chat `ScheduleCard`.
- **Create** `apps/web/app/chat/workspace/ScheduleWorkspace.tsx` — tab bar (pinned committed + scenario tabs, **no +new**) + the schedule viewer + the compare entry. Thin; logic in helpers.
- **Create** `apps/web/app/chat/workspace/CompareView.tsx` — the two-scenario picker + side-by-side diff render.
- **Create** `apps/web/app/chat/workspace/ScheduleView.tsx` — the term-grid renderer for ONE schedule (reused by the workspace + each compare column). Likely extracted from the existing sidebar term/slot rendering.
- **Create** `apps/web/app/chat/ScheduleCard.tsx` — the chat-thread card (badge + label + summary + "open"/"compare").
- **Repurpose** `apps/web/app/chat/scheduleSidebar.tsx` → `ProfileRail.tsx` (DPR info read-only + the scenarios list). Keep the existing slot/term sub-components (`sidebar/SlotRow.tsx`, `slotState.ts`, `slotPopover.tsx`) for `ScheduleView`.
- **CSS:** extend `apps/web/app/chat/chat.module.css`; add `apps/web/app/chat/workspace/workspace.module.css` for the workspace/compare. Design tokens in `apps/web/app/globals.css`.
- **Tests:** `apps/web/tests/scenarioModel.test.ts`, `scheduleDiff.test.ts` (node); `scheduleWorkspace.render.test.tsx`, `compareView.render.test.tsx`, `scheduleCard.render.test.tsx`, `profileRail.render.test.tsx` (jsdom).

## 6. The scenario state model (concrete — no placeholders)
`apps/web/lib/scenarios/scenarioModel.ts`:
```ts
import type { ForwardSchedule } from "@nyupath/shared";
import type { WhatIfAssumptionMarker, WhatIfOutcome } from "@nyupath/engine";

export type ScenarioKind = "committed" | "proposed" | "whatif";

/** Params that let a session-only what-if be RE-DERIVED after a reload by
 *  re-calling its origin endpoint (the chat card is the durable handle). */
export type RederiveSpec =
  | { via: "whatif_assumption"; courseId: string; outcome: WhatIfOutcome }
  | { via: "probe"; payload: unknown }
  | { via: "audit_upload" };       // re-upload required; card shows a re-run affordance

export interface Scenario {
  id: string;                      // "committed" for the anchor; a uuid otherwise
  kind: ScenarioKind;
  label: string;                   // "My Plan" | "Withdraw MATH-UA 325" | "+ Economics minor"
  schedule: ForwardSchedule;
  verdict: "valid" | "trade-offs" | "invalid";
  hedges?: string[];               // proposed/whatif caveats (verify rail, F3 window, P/F school-specific)
  pendingMutationId?: string;      // proposed only — the /api/plan/confirm handle
  whatIfAssumption?: WhatIfAssumptionMarker; // proposed withdraw/PF
  rederive?: RederiveSpec;         // whatif only
  createdAt: number;               // pass in (Date.now is unavailable in some contexts; inject)
}

export interface ScenarioState {
  committed: ForwardSchedule | null;
  scenarios: Scenario[];           // proposed + whatif ONLY (committed is its own slot)
  activeId: string;                // "committed" or a scenario id
  compare: { leftId: string; rightId: string } | null;
  invalidProposal: import("../reviewCard").InvalidProposalCard | null;
}
```
Pure reducers (each returns a new `ScenarioState`, never mutates): `initialState(committed)`, `addScenario(s, scenario)` (de-dupes by id, sets `activeId` to the new one, clears compare), `setActive(s, id)`, `openCompare(s, leftId, rightId)`, `closeCompare(s)`, `discardScenario(s, id)` (falls back `activeId`→"committed"), `confirmProposed(s, id)` (the **commit chokepoint**: sets `committed = scenario.schedule`, removes that scenario, `activeId`→"committed", clears compare + invalidProposal), `setInvalidProposal(s, card)`. The store (`planState.ts`) wraps these with `useSyncExternalStore` and persists on `confirmProposed` (calls the existing confirm round-trip — never persists a what-if/synthetic DPR; R1 holds because confirm goes through `/api/plan/confirm` → the orchestrator, which already only writes `forward_schedules`).

---

## 7. Tasks

### H0 — Scenario state model (foundation; pure + node-tested)
- *Goal:* the store can hold a committed plan + N scenarios, switch active, open a compare pair, confirm a proposed (→ committed), discard a what-if — all pure + tested.
- **H0.1** Create `scenarioModel.ts` (the type + all reducers in §6). RED: `apps/web/tests/scenarioModel.test.ts` asserting each reducer (add sets active + clears compare; confirmProposed promotes to committed + removes the scenario + active→committed; discard falls back; openCompare needs two distinct ids; committed is never in `scenarios[]`). GREEN. Commit.
- **H0.2** Refactor `planState.ts` to wrap `scenarioModel` via `useSyncExternalStore`; keep `createPlanStore(initial)` for tests; map the old `setForwardSchedule` → `setCommitted`/`confirmProposed`, `setPendingPreview` → `addScenario({kind:"proposed"})`, `setInvalidProposal` unchanged. Update the existing `sharedPlanState.test.ts` / `chatSidebarParity.test.ts` to the new API (they pin the store contract — adjust intentionally, keeping parity semantics). Verify the full suite. Commit.

### H1 — Schedule diff (compare engine; pure + node-tested)
- *Goal:* a pure `diffSchedules(base, other)` the compare view renders.
- **H1.1** Create `scheduleDiff.ts`: `diffSchedules(base, other) → { terms: Array<{ term, rows: Array<{ courseId, label, state, diff: "added"|"removed"|"moved"|"retake"|"same" }> }> }`. Reuse the engine's `computeSlotDiff` (import from `@nyupath/engine`) for the added/removed set; map a course present in both but a different term → `moved`; a removed-then-re-added (withdraw→retake) → `retake`. RED `scheduleDiff.test.ts` (added/removed/moved/retake/same across a withdraw fixture + an add-minor fixture, reusing `_planRouteTestUtils` builders). GREEN. Commit.

### H2 — Shell + workspace
- **H2.1** The 3-zone shell in `page.tsx`: `grid-template-columns: 340px 1fr 300px` (chat | workspace | profile), ≥1100px; the existing chat thread moves to the left zone, the new `ScheduleWorkspace` to center, `ProfileRail` to right. Render test (`scheduleWorkspace.render.test.tsx` mounts the page shell with a committed plan + one scenario → asserts all three zones present). Commit.
- **H2.2** `ScheduleView.tsx` — render ONE schedule's term grid (extract from the current sidebar term/slot render; reuse `SlotRow`/`slotState`/`slotPopover`). Accepts `{ schedule, diff?, readOnly? }` (diff classes drive the compare highlight). Render test. Commit.
- **H2.3** `ScheduleWorkspace.tsx` — the tab bar: a pinned 📌 committed tab first (always present, visually distinct) + a tab per scenario (badge-colored), each with a close ✕ except committed; a `⇄ Compare` toggle. **No "+ New" tab.** Body shows the active scenario via `ScheduleView` + a header (label + status badge + verdict + the proposed `Confirm/Cancel/Ask-why` actions OR the whatif `Keep/Discard` + read-only note + hedges). Render test (committed pinned + no +new control + proposed shows Confirm + whatif shows read-only note). Commit.

### H3 — Compare any two
- **H3.1** `CompareView.tsx` — two dropdown pickers (each lists all scenarios incl. committed; default left=committed, right=active), rendering two `ScheduleView` columns with `diffSchedules(left, right)` highlights + a diff legend (added/removed/retake/moved). Picking the same scenario twice is prevented. Render test (pick two what-ifs → both columns + diff legend; the diff classes appear). Commit.
- **H3.2** Wire `⇄ Compare` in the workspace → mounts `CompareView`; toggling off returns to the active tab. Render test. Commit.

### H4 — Chat cards + wiring derived results into scenarios
- **H4.1** `ScheduleCard.tsx` — a chat-thread card: status badge + label + 1-line summary + `Open` (→ `setActive`) + `Compare` (→ `openCompare` vs committed). Render test (proposed vs whatif variants). Commit.
- **H4.2** In `page.tsx`, replace the preview-staging in `handlePlanActionResult` + `handleWhatIfResult` with `addScenario(...)` (kind from the source: plan-change/whatif-assumption → `proposed`; build the `whatIfAssumption`/`pendingMutationId`/`hedges` onto the scenario) AND append a `plan_action_bubble`-style **schedule card** message to the chat thread. Wire `probe_counterfactual` results (read-only) → `addScenario({kind:"whatif", rederive})` + a card. Confirm (the card/workspace Confirm) → `confirmProposed` (promotes + persists via `/api/plan/confirm`). Tests: a proposed result adds a proposed scenario + a card; confirming promotes it to committed + persists; a probe result adds a whatif scenario; `students.parsed_dpr` byte-unchanged after a what-if confirm (the R1 guard test, ported). Commit.
- **H4.3** What-if creation is **chat-only**: ensure no UI affordance spawns a what-if (the IP-slot control from plan 35 G3.2 routes through chat/agent, not a direct sidebar spawn — reconcile it to emit a chat card + scenario, not a bare sidebar preview). Render test asserts the workspace has no scenario-creation control. Commit.

### H5 — Profile rail
- **H5.1** `ProfileRail.tsx` (repurpose `scheduleSidebar.tsx`): DPR-derived info read-only (home school w/ "from DPR" tag, major, catalog year, GPA, credits, grad target — reuse `SummaryCard`) + the **scenarios list** (committed pinned + each scenario, badge-colored, click → `setActive`/`openCompare`) + the "only My Plan is saved" note. Render test. Commit.

### H6 — Professional visual pass (§9)
- **H6.1** Apply the §9 visual system: design tokens (type scale, spacing, the restrained palette, status colors), the schedule-grid-as-hero treatment, refined chat (supporting rail, not bubble-fest), tabular numerals, subtle borders/shadows, zero "AI-sparkle" tropes. Update `globals.css` + `chat.module.css` + `workspace.module.css`. This is a styling task (no new behavior); verify via the existing render tests + a manual screenshot check. Commit.

### H7 — Docs + finalize (philosophy #6)
- **H7.1** Revise `Docs/current-system/web/chat-ui-client.md` + `ui-components.md` for the scenarios store + 3-zone shell + compare; note the engine/R1 untouched. Mark this plan COMPLETE; update the project memory. Commit.

---

## 8. Persistence & reload semantics (v1 — explicit)
- The **committed plan** persists to `forward_schedules` exactly as today; on load it populates `committed` + `activeId="committed"`.
- **Scenarios are session-state.** The **chat thread persists** (`chat_messages`, Phase 4), so the schedule **cards persist**. On reload the workspace shows the committed plan + the chat history; clicking a stale card **re-derives** the scenario via its `rederive` spec (re-calls `/api/plan/whatif` / the probe). A Branch-A audit card shows a "re-run / re-upload" affordance (the synthetic DPR is never stored — R1). Deferred (NOT v1): persisting computed what-if schedules server-side.

## 9. Professional visual design (binding direction — "not a standard AI website")
- **Aesthetic:** a focused academic-planning instrument (reference points: Linear / Notion / a modern registrar dashboard) — the **schedule grid is the hero**, the chat is a clean supporting rail. Avoid: full-width chat bubbles as the centerpiece, gradient blobs, emoji-as-UI, "sparkle"/AI motifs, oversized rounded cartoony cards.
- **Type:** one refined sans (the system stack already in use); a real type scale (e.g. 12/13/14/16/20/24) with strong weight hierarchy; **tabular numerals** for credits/terms/GPA.
- **Color:** mostly neutral surfaces (warm-white/very-light-violet tints); **NYU violet `#57068C` as a precise accent**, not a flood; status colors (committed-green / proposed-amber / whatif-blue) used **only** on badges + diff highlights, never as large fills.
- **Density & chrome:** organized, information-dense term grids (real planners are dense, not airy); 1px hairline borders + soft low-opacity shadows; generous-but-disciplined spacing; consistent 8/12/16 spacing rhythm.
- **Acceptance:** a reviewer should read it as "a serious degree-planning tool a registrar would ship," not "a chatbot demo." The mockup `Docs/mockups/scenarios-ui-mockup.html` is the structural baseline; H6 elevates its polish to this bar (and applies the two refinements: compare-any-two, no +new-whatif tab).

## 10. What is NOT touched (frozen)
`packages/engine` entirely (the solver, validator, `finalizeForwardSchedule`, the transforms, `assertAuthoritativeDpr`, the tools); the DB schema + persistence; the agent prompt. This plan only reshapes the web state store + presentation. The R1 guardrail is preserved structurally (confirm still routes through `/api/plan/confirm`; what-ifs never persist a DPR).

## 11. Verification gates (per task)
Subagent-driven TDD; RED-before-GREEN; full `npx vitest run` green at repo root; `cd apps/web && npx tsc --noEmit` (+ `packages/engine` only if an engine import surface changes — it shouldn't) 3×; jsdom render tests use `// @vitest-environment jsdom`; 0 `.js` shadows; scoped commits (never `git add -A`; never `*.pdf`/`.env.local`/`pnpm-lock.yaml`) ending with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; branch `feat/plan36-scenarios-ui`; engine diff stays empty (assert).

## 12. Deferred (own follow-ons, NOT this plan)
Server-side persistence of computed what-ifs; comparing 3+ at once; mobile/responsive; a "pin a what-if to keep it across sessions" durable store; richer diff (prereq-chain impact visualization).

---

## Appendix — task dependency order
H0 → H1 → H2 → H3 → H4 → H5 → H6 → H7. H0 (state model) is the hard dependency for everything; H1 (diff) gates H3 (compare); H2 (shell+view) gates H3/H4/H5; H6 (visual) after the structure works; H7 last.
