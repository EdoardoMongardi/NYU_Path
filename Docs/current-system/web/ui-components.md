# UI Components

> Last verified against code: 2026-06-16 (Phase 4 follow-up F3: in-progress slot-state is now WINDOW-AWARE — IP editable/label/hedge from `classifyIpChangeability`, the prior "deferred open question" resolved). Prior 2026-06-16: Phase 4 E3 (never-instant preview/review card; drag removed). Prior: 2026-06-15 (Phase 4 E2: badge row + slot-state glyphs + violet light/dark); 2026-06-10 (post planning-engine rebuild, PRs #35-#41).

## TL;DR

This is everything the student sees on screen — the landing page, the chat thread, and especially the sidebar that lives next to the conversation. The sidebar is the dense, interactive part: it shows a card per academic term, each with the courses planned for it, the credit total, and a row of little pill-shaped buttons for actions like swap, drop, lock, or move. The student opens a slot's ⋯ menu to pick a verb, or types a new course id into a free-form "+ Add course" input (Phase 4 E3 removed drag-and-drop — the ⋯ menu is now the only edit input). Every edit is *previewed* before it applies: the sidebar shows a read-only "◷ Preview" of the proposed plan with the credit delta and a review card (✓/⚠ verdict + Confirm / Cancel / Ask-why), and the committed plan stays untouched until Confirm; an invalid change shows a red card instead. For the very next term, if section times have been loaded, the sidebar swaps the basic course list for a richer "Sections" view showing meeting patterns, instructors, and CRNs. The whole sidebar is a pure reflection of state piped in from the chat page — it never fetches its own data, just renders what's handed to it.

```mermaid
flowchart LR
    Page[Chat page] -->|schedule + materialization + profile| Sidebar[Schedule sidebar]
    Sidebar --> Summary[Student summary card]
    Sidebar --> Terms[One card per term]
    Terms --> Slots[Course slot rows]
    Terms --> Sections[Sections view for next term]
    Slots --> Popover[⋯ verb popover: swap / drop / lock / move]
    Terms --> AddCourse[+ Add course input]
    Popover --> Action[Fires plan-action request → stages a proposal]
    AddCourse --> Action
    Action --> Preview[◷ Preview overlay + review card / red card]
```

---

## Overview

The chat UI is a Next.js app with three layers:

1. The Next.js root layout (`app/layout.tsx`) — `<html>` and `<body>` plus global metadata.
2. The marketing landing page (`app/page.tsx`) — static hero, features, footer, with a link to `/chat`.
3. The chat experience, which is split into a page-level orchestrator and a live sidebar that mirrors the student's forward schedule as the conversation drives changes.

This doc focuses on the sidebar tree, which is the densest and most stateful part of the UI. The sidebar receives schedule snapshots from the chat page (which streams them out of the chat v2 SSE channel) and renders per-term cards. Each card lists slots with verbs (Swap / Drop / Lock / Move) reachable through a per-slot ⋯ menu — the **sole edit input** since Phase 4 E3 removed drag-and-drop — plus an inline `+ Add course` affordance. When the IMMEDIATE term has materialized section data, the structural slot list is swapped for a Sections view. As of Phase 4 E3 the sidebar also renders three **canvas edit-model surfaces** derived from a staged proposal: the "◷ Preview" overlay, the review card, and the RED invalid-proposal card (see "Canvas edit-model surfaces" below).

## The chat sidebar — `app/chat/scheduleSidebar.tsx`

The single live component that owns sidebar state. It is rendered by the chat page when the user opens the sidebar.

### Props received (`scheduleSidebar.tsx:133`)

| Prop | Source | Purpose |
|---|---|---|
| `schedule: ForwardSchedule \| null` | chat page's `forward_schedule_update` SSE handler | The committed plan to render |
| `pendingPreview: PendingPreview \| null` (E3.1) | chat page's `pendingPreview` store slot | A staged (not-yet-committed) proposal; when set, the sidebar renders the "◷ Preview" overlay + review card over the proposed plan, committed plan untouched |
| `invalidProposal: InvalidProposalCard \| null` (E3.3) | chat page's `invalidProposal` store slot | An engine-rejected (`feasible:false`) proposal; renders the RED card naming the binding constraint(s). Mutually exclusive with `pendingPreview` |
| `student: StudentProfile \| null` | chat page's session restore | Drives the SummaryCard |
| `dpr: DegreeProgressReport \| null` | chat page (loaded via login restore) | Drives the SummaryCard credit/GPA fields |
| `materialization: ForwardMaterializationPayload \| null` | chat page's `forward_materialization_update` SSE handler | Drives the IMMEDIATE-term Sections view |
| `schedulePreferences: SchedulePreferences \| null` | chat page (loaded via `/api/session/restore`) | Walked to compute frozen slot keys |
| `open: boolean` | chat page | Sidebar visibility |
| `onClose` | chat page | Close button handler |
| `onProposeLoadStyle` | chat page | Balanced / Frontload / Backload pill clicks |
| `onProposeSlotChange` | chat page (legacy) | No-op shim from the older slot-action verb set |
| `onPlanActionResult` | chat page | Fires after every deterministic plan-action route — the page runs `planActionSurfaces` to stage the preview / red card and (only on `feasible:false`) render an inline `plan_action_bubble` message in the chat thread |
| `onReviewConfirm` (E3.2) | chat page | Review-card Confirm — applies the staged mutation via the shared `/api/plan/confirm` path |
| `onReviewCancel` (E3.2) | chat page | Review-card Cancel — drops the staged preview without a confirm round-trip |
| `onReviewAskWhy` (E3.2) | chat page | Review-card Ask-why — routes a scoped "why" question into the grounded chat agent |
| `onDismissInvalid` (E3.3) | chat page | Dismiss the RED invalid-proposal card (nothing staged/committed, just clears the slot) |
| `onConfirmCombination` | chat page | Apply-combination button inside the Sections view |
| `onRefreshDpr` | chat page | Update-DPR file picker handler |
| `onClearAll` | chat page | Test-only Clear button handler |

### Event subscription model

The sidebar itself does not subscribe to any event source — it is a pure render of its props. The chat page subscribes to the v2 SSE stream and forwards two relevant payload kinds into the sidebar:

- `forward_schedule_update` → updates the `schedule` prop.
- `forward_materialization_update` → updates the `materialization` prop.

The schedule preferences arrive separately via the per-mount restore call.

### Local state held inside the sidebar

- `openPopover: string \| null` — which slot's verb popover is open.
- `openSubmenu: { key, verb } \| null` — which submenu inside that popover (Swap candidates or Move targets) is open.
- `pendingSlots: Set<string>` — keys of slots with an in-flight plan-action round-trip. Drives per-row spinners.
- `pendingSince: number \| null` — first-spinner-on timestamp. Used to gate a sidebar-bottom "Validating plan change..." toast.
- `showToast: boolean` — whether the sidebar-bottom toast is currently rendered. Becomes true 600ms after `pendingSince` is set (constant `SIDEBAR_TOAST_THRESHOLD_MS = 600` at `scheduleSidebar.tsx:56`); becomes false the instant `pendingSlots` drains.
- `addCourseDraft: Map<term, string>` — the open Add-course inputs per term and their current draft text.
- `selectedComboIdx: number` — which proposal index is selected in the Sections view. Reset to 0 on every `materialization.computedAt` change.

(Phase 4 E3 removed the former `dragSourceRef` / `dropTargetTerm` drag state along with the drag gesture; the sidebar holds no drag state now.)
- `refreshing: boolean` — Update-DPR in flight.

### Slot key derivation

A slot's stable identity key is `${term}::${courseId}` for concrete slots; placeholders use `${term}::placeholder(${category})` so a swap on a placeholder still surfaces a spinner (`scheduleSidebar.tsx:280`).

### Frozen keys

A `frozenKeys` set is derived via `useMemo` from `schedulePreferences.pins[]` — each pin contributes `${pin.term}::${pin.courseId}` (`scheduleSidebar.tsx:251`). This set is passed to every TermCard and is what makes the Lock/Unlock label inside a popover bidirectional.

### Plan-action handlers

Every verb is wired to a deterministic POST endpoint via the `planActionClient`, reachable through the per-slot ⋯ menu (Phase 4 E3 removed drag-and-drop, so the ⋯ menu + the `+ Add course` input are the only ways to fire these):

- `handleLockToggle` → `planLock` with `locked: !wasFrozen` (`scheduleSidebar.tsx:387`).
- `handleDrop` → `planDrop` (`scheduleSidebar.tsx:407`).
- `handleSwap` → `planSwap` with `{ drop, add, term }` (`scheduleSidebar.tsx:426`).
- `handleMove` → `planMove` with `{ courseId, fromTerm, toTerm }` (`scheduleSidebar.tsx:451`).
- `handleAddCourseSubmit` → `planAdd` with `{ courseId, term }` (`scheduleSidebar.tsx:474`).

Each handler does the same shape of work: derive a slot key, mark it pending (which lights up the spinner and may start the toast timer), call the deterministic route, then announce the result via `announceResult` (`scheduleSidebar.tsx:364`). The helper logs by category (clean / trade-offs / refusal / error) and bubbles up through `onPlanActionResult`; the chat page then runs `planActionSurfaces` to stage the canvas preview / red card (and, only on `feasible:false`, an inline chat bubble). Always clears the pending flag and closes the popover in `finally`.

### Drag-and-drop — REMOVED (Phase 4 E3.4)

Drag-to-move/exchange was removed entirely in E3.4 (commit `b209559`). The per-course ⋯ menu (Swap / Drop / Lock / Move) is now the **sole edit input**, the literal §8 "no drag" reading; this supersedes the Phase-17 drag-grid. The sidebar tree (`scheduleSidebar.tsx`, `SlotRow.tsx`, `TermCard.tsx`) carries **no** `onDragStart` / `onDragOver` / `onDrop` / `draggable` handlers and no `application/x-nyupath-slot` dataTransfer; the former drag refs were deleted with the gesture.

### Top-level chrome

- Header with title and close button (`scheduleSidebar.tsx:600`).
- Optional toolbar with an "Update DPR" file picker that triggers `onRefreshDpr` (`scheduleSidebar.tsx:604`).
- Empty state ("No plan yet...") when neither a student nor a schedule is loaded (`scheduleSidebar.tsx:629`).
- Otherwise the body: `SummaryCard`, schedule meta line ("Targeting graduation in ... · N credits per semester"), load-style pills (Balanced / Frontload / Backload), state banners (trade-offs / infeasibility / student-preferred-invalid), the **plan-level badge row** (`<PlanBadges>`, mounted directly above the term cards — `scheduleSidebar.tsx:687`; see "Plan-level badge row" below), `PriorCreditsCard`, and one `TermCard` per term bucket.
- The body invokes `groupCoursesByTerm` (from `lib/groupCoursesByTerm`) to produce `{ priorCredits, terms }` from the student + schedule + DPR.
- Sidebar-bottom toast (`scheduleSidebar.tsx:752`) — renders only when `showToast && pendingSlots.size > 0`. Includes a spinner and "Validating plan change…" copy.
- Test-only Clear button at the bottom when `NEXT_PUBLIC_ENABLE_TEST_CLEAR === "1"` (`scheduleSidebar.tsx:761`).

### Load-style pills

Three constants at `scheduleSidebar.tsx:42`:
- Balanced — propose a balanced credit load across all semesters.
- Frontload — heavier early, lighter later.
- Backload — lighter early, heavier later.

Clicking a pill calls `onProposeLoadStyle` with the value.

### State banners

Three banners stack above the term cards (and above the plan-level badge row) depending on `schedule.state`:
- `valid-with-trade-offs` + at least one assumption → trade-offs banner, listing the first five assumptions via `assumptionLabel` (`scheduleSidebar.tsx:660`).
- `infeasible-draft` → infeasibility banner, listing the first five constraint violations from `feasibility.constraintViolations` (`scheduleSidebar.tsx:670`).
- `student-preferred-invalid-draft` → student-preferred banner (`scheduleSidebar.tsx:680`).

### Env flags

Two helpers (`scheduleSidebar.tsx:29`, `scheduleSidebar.tsx:37`):
- `isTestClearEnabled()` reads `NEXT_PUBLIC_ENABLE_TEST_CLEAR === "1"` — surfaces the bottom Clear-all-data button.
- `isLlmPolishEnabled()` reads `NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH === "1"` — kept here as the single source of the env-flag check, even though the page is the actual consumer. The sidebar references it via `void` so the import isn't pruned.

### Plan-level badge row — `lib/planBadges.ts` + `PlanBadges` (Phase 4 E2.1)

A four-badge summary row mounted directly above the term-card list (after the state banners) — `<PlanBadges>` at `scheduleSidebar.tsx:687`, defined inline at `scheduleSidebar.tsx:93`. The component is a **thin consumer**: it holds no decision logic and renders whatever the pure helper returns.

All derivation lives in `apps/web/lib/planBadges.ts` — `computePlanBadges(schedule, consequences?)` (`planBadges.ts:61`) — a pure, framework-agnostic function unit-tested directly in node (`apps/web/tests/planBadges.test.ts`), since `apps/web` ships no DOM render harness. It returns four badges:

| Badge | Source | Detail |
|---|---|---|
| **Validity** | `schedule.state` | ✓ for `valid-clean` / `valid-with-trade-offs`; a clearly-marked "✗ Invalid draft" for the two draft states (`infeasible-draft`, `student-preferred-invalid-draft`). |
| **Confidence** | derived (see below) | "✓ Grounded" when not hedged; otherwise "Confidence: hedged — verify with your adviser". |
| **Graduation term** | `schedule.graduationTerm` | Formatted via the sidebar's deterministic `formatTermLabel` (e.g. `2027-spring` → "Spring 2027"); unrecognized shapes pass through verbatim — no invention. Rendered with a 🎓 prefix. |
| **Trade-off count** | `consequences?.length ?? 0` | The latest plan-action diff's `consequences[]`, threaded down as a param. At rest (no pending diff) it is absent → count 0. (Live consequences wiring is E3's job; the component currently mounts `<PlanBadges>` without it.) |

**Confidence hedge — no-invention derivation (binding §11 / philosophy #3).** There is **no** structured "CAS-approximated" / confidence field on `ForwardSchedule` (the D4.4 hedge lives in the agent's narration, not on the plan object). So the confidence badge **derives** its hedge only from real engine-produced fields (`planBadges.ts:80-86`): it is hedged when `schedule.optimality` is `"best-effort"` or `"feasibility-unconfirmed"`, OR `schedule.assumptions[]` is non-empty, OR the state is an invalid draft. It computes **no new number** and fabricates **no CAS-coupling claim** — when any of those markers holds, the label carries a "verify with your adviser" hedge.

### Slot-state glyphs — `sidebar/slotState.ts` (Phase 4 E2.2; IP window-aware F3)

Each slot pill renders a design-§8 state glyph (🔒 / ◐ / none) sourced from a pure helper. `computeSlotState(slot, { isFrozen, semesterLocked, ipChangeability? })` (`apps/web/app/chat/sidebar/slotState.ts`) is the **single source of truth** for the glyph + human label + aria-label + an `editable` flag (+ an optional `title` tooltip for the F3 hedge); `SlotRow` consumes it and holds no slot-state decision logic of its own. It is unit-tested directly in node (`apps/web/tests/slotStates.test.ts` + `ipSlotChangeability.test.ts`).

The helper resolves by precedence (highest first — `slotState.ts:98-152`):

| Glyph | State | Label | Editable |
|---|---|---|---|
| 🔒 | `kind === "completed"` (checked **kind-first**) | "Taken (final)" | false |
| 🔒 | `semesterLocked` (the bucket's `ForwardSemester.locked` — DPR history / in-progress term) | "Locked — past or in-progress term" | false |
| 🔒 | `isFrozen` (student-pinned via `SchedulePreferences.pins[]`) | "Locked by you" | true (unlock / move via the ⋯ menu; the lock travels with it) |
| ◐ | `kind === "in_progress"` (window-aware — see F3 below) | window-honest label (e.g. "within add/drop", "withdraw/pass-fail only", "change windows closed") | from `ipChangeability.editable` (closed → false; else true) |
| _(none)_ | `specific_planned` / `placeholder` | "Planned (movable)" | true |

Notes worth flagging:
- **The ◐ in-progress glyph is NEW** — before E2.2 an in-progress slot showed no state glyph. This makes the `core_philosophy.md` IP rule visible on the canvas.
- **`completed` is checked kind-first**, BEFORE the generic `semesterLocked` branch, so a completed course shows the design-§8 "Taken (final)" label even though it always renders inside a `locked: true` history bucket — otherwise the generic term-lock label would mask it.
- **IP movability is now WINDOW-AWARE (Phase 4 follow-up F3) — the prior "deferred open question" is RESOLVED.** When an `in_progress` slot carries an `ipChangeability` classification (threaded from `TermBucket.ipChangeability`, computed once per IP bucket in `groupCoursesByTerm` from the engine's `classifyIpChangeability` + `deriveTemporalContext` + `campusForHomeSchool` + the academic-calendar config — see `Docs/current-system/engine/dpr.md`), the ◐ slot's `editable` + label come from the real NYU registration window: a **future** (pre-registered) IP term is freely changeable; a **current** term inside add/drop is changeable; inside the withdraw/pass-fail window it surfaces those options (editable, hedged — a W doesn't fulfill the requirement, P/F may not satisfy a letter-grade major rule); **past the withdraw window it is NOT editable** (effectively locked); when the calendar lacks that term/campus's dates it stays editable with a generic "verify with your adviser" hedge (we never falsely lock for lack of data). The full hedge rides through as the slot `title` tooltip; the agent surfaces it in chat (`systemPrompt.ts` CORE RULE 15). Any *claimed* current-term change (drop/withdraw/pass-fail) is an UNVERIFIED assumption, planned as a draft/what-if, never recorded as fact (only a new DPR confirms it). When `ipChangeability` is absent (e.g. the no-DPR transcript fallback), the slot keeps the back-compat ◐ "fixed in its term" / editable behavior.

### NYU-violet light/dark theme — `globals.css` + `chat.module.css` (Phase 4 E2.3)

E2.3 was a CSS-only pass: it lifted E2.1's hardcoded badge hex into semantic tokens and added a token-override dark theme. **There is no toggle UI** — the dark variant resolves from an explicit `data-theme="dark"` opt-in or the OS-level preference.

- **New tokens in `globals.css :root`** (`globals.css:40-61`, light values): `--badge-valid-*`, `--badge-invalid-*`, `--badge-hedged-*`, `--badge-neutral-*`, `--badge-grounded-*` (the validity-positive "grounded" badge folds in the NYU-violet brand — `--badge-grounded-bg/-border/-text` resolve to `--nyu-violet-faint`/`--nyu-violet`), and `--slot-glyph-color` (the 🔒/◐ glyph accent, `--nyu-violet`). They live in `globals.css` rather than `chat.module.css` because Next 16's CSS-Modules loader rejects a bare `:root` block inside `*.module.css`.
- **`chat.module.css` references the vars** (no hardcoded hex remains in the `.planBadge*` / `.slotLockIcon` rules — `chat.module.css:606-651`, `:1019`): the badge row gets an on-brand NYU-violet left accent (`border-left: 3px solid var(--nyu-violet)`), the grounded badge folds in the violet brand, and the slot glyph reads in `var(--slot-glyph-color)`.
- **Dark layer** (`globals.css:111-148`): a `[data-theme="dark"]` block re-points the neutral (`--bg-*`/`--text-*`/`--border-*`) and `--badge-*` tokens to dark values while keeping the NYU-violet brand. A mirrored `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` gate (`globals.css:152-181`) applies the same overrides for an OS-level dark preference, while an explicit `data-theme="light"` opt-out wins. The light `:root` values are untouched, so light mode does not regress. Because every component already styles through these tokens, flipping `data-theme="dark"` re-themes the shell app-wide with no markup change.

### Canvas edit-model surfaces — the never-instant preview / review / invalid card (Phase 4 E3)

E3 made "edits are never instant" *visible* on the canvas. Every ⋯-menu verb PROPOSES (the routes are unchanged — see [plan-action-orchestrator.md](./plan-action-orchestrator.md)); the page stages the result into the shared store and the sidebar renders one of two mutually-exclusive surfaces at the **top of the sidebar body** (above `SummaryCard`), while the committed plan below stays byte-identical until Confirm. The decision logic is pure and node-tested (`apps/web` ships no DOM render harness); the sidebar is a thin consumer.

**The pure helpers (no React import):**
- `apps/web/app/chat/planState.ts` — the shared store gained two slots: `pendingPreview: PendingPreview | null` (E3.1) and `invalidProposal: InvalidProposalCard | null` (E3.3). They are **mutually exclusive**, and `setForwardSchedule` is the single commit chokepoint that clears BOTH (`planState.ts:149-161`) — so any commit (clean apply, bubble confirm, override-anyway, SSE `forward_schedule_update`, DPR refresh) drops a stale card with no per-call-site enumeration.
- `apps/web/lib/planPreview.ts` — `computePreviewView(committed, preview)` (`planPreview.ts:72`) computes the credit delta (`total` + per-`byTerm`) of the proposed plan vs the committed plan, over the union of all terms in either. Pure; tested in `apps/web/tests/canvasPreview.test.ts`.
- `apps/web/lib/reviewCard.ts` — `computeReviewCard(response)` (`reviewCard.ts:82`) derives the verdict (✓ valid / ⚠ valid-with-trade-offs / ✗ invalid) + trade-off lines **strictly** from the engine's `feasible` + `consequences` (+ an optional deterministic `planDiff` graduation-shift summary) — it NEVER fabricates a delta. `computeInvalidCard(response, verb)` (`reviewCard.ts:163`) builds the red card's binding constraints from `response.conflicts ∪ response.forwardSchedule.feasibility.constraintViolations`, mapped to `{kind, detail}` and deduped by `detail` — both sources empty → `[]` (no invented field; there is NO `infeasibilityReport`). `applyReviewConfirm` / `applyReviewCancel` (`reviewCard.ts:223`/`247`) are the store-mutating, injectable-confirm actions (node-tested in `apps/web/tests/reviewCard.test.ts` / `invalidProposal.test.ts`).
- `apps/web/lib/planActionSurfaces.ts` — `planActionSurfaces(response, verb)` (`planActionSurfaces.ts:64`) is the single decision of which surfaces a response drives: `{ preview, invalidCard, showBubble }`. Feasible (clean OR trade-offs) with a proposed schedule → a `preview`, `showBubble:false` (the review card is the sole surface — no chat bubble); `feasible:false` → an `invalidCard` + `showBubble:true` (the chat bubble carries Override-anyway / hard-refusal copy the red card lacks, so it renders alongside the red card).

**The three rendered surfaces (`scheduleSidebar.tsx`):**

| Surface | When | What renders | Cite |
|---|---|---|---|
| **"◷ Preview" overlay** (E3.1) | `pendingPreview` set (feasible proposal) | A read-only overlay above the committed cards: a "◷ Preview" badge + "not applied yet" banner, the credit-delta line + per-term list, the first five `consequences`, and the proposed term cards rendered with **no slot handlers** (read-only) | `scheduleSidebar.tsx:583-669` (overlay), `:307` (`computePreviewView` call) |
| **Review card** (E3.2) | inside the overlay | The verdict glyph + label (only ✓/⚠ here — a staged preview is always feasible) + up to six trade-off lines + three buttons: **Confirm** (disabled if `!canConfirm`) / **Cancel** / **Ask why** | `scheduleSidebar.tsx:681-756` |
| **RED invalid card** (E3.3) | `invalidProposal` set (`feasible:false`) | `role="alert"` red card: a "✗ Can't `<verb>` — invalid change" heading, the first five binding-constraint `detail` lines (or a generic "could not validate — verify with your adviser" fallback when the list is empty), a "Your plan was not changed" line, and a **Dismiss** button. NO proposed-plan overlay — committed cards stay as they are | `scheduleSidebar.tsx:776-812` |

CSS for the three surfaces lives in `chat.module.css` (`.schedulePreviewOverlay`/`.schedulePreviewBadge` `:606`, `.reviewCard`/`.reviewBtn*` `:671`, `.invalidProposalCard`/`.invalidProposalDismiss` `:753`). The page-side wiring (`handlePlanActionResult` → `planActionSurfaces`, the `onReviewConfirm`/`onReviewCancel`/`onReviewAskWhy`/`onDismissInvalid` handlers) is documented in [chat-ui-client.md](./chat-ui-client.md) §4 / §7.

## TermCard — `app/chat/sidebar/TermCard.tsx`

Renders one term bucket. Owns the drop-target plumbing at term-card level, the assumption/notes list, the structural slot list (or the Sections-view swap-in), and the per-term `+ Add course` affordance.

### What it decides

- `matApplies` — true when this card is the IMMEDIATE term AND a materialization payload exists AND its target term matches this card's term (`TermCard.tsx:79`).
- `showSectionsView` — true when `matApplies && materialization.state === "full" && materialization.semester` is set. When true, the slot list is replaced by the Sections view (`TermCard.tsx:84`).
- `showBanner` — true when `matApplies` but the materializer state is `partial` or `unavailable`. The card shows a status message instead of section data (`TermCard.tsx:87`).
- `headerCredits` — taken from `forwardSemester.plannedCredits` when a forward semester exists, otherwise summed from the bucket's slots via `slotCredits` (`TermCard.tsx:90`).
- `isDropEligible` — true when the bucket is not locked. Locked buckets (history / completed) stay read-only (`TermCard.tsx:97`).
- `showAddCourse` — true when the term is non-locked AND a forward semester exists. IP terms don't get an Add-course button (`TermCard.tsx:103`).

### Structure rendered

1. A `<section>` with class names derived from locked / drop-target state (`TermCard.tsx:106`).
2. Header row: term label (via `formatTermLabel`) and the credit total.
3. Optional notes list pulled from `forwardSemester.notes`.
4. Optional materialization banner if `showBanner`.
5. Either the Sections view (`renderSectionsView`) or the slot list (one `SlotRow` per slot in the bucket). Slot keys are derived as `${semIdx}-${slotIdx}` for the local popover key and `slotKeyOf(slot, bucket.term)` for the global pending/frozen sets.
6. Optional `AddCourseAffordance` if `showAddCourse`.

(Phase 4 E3.4 removed drag-and-drop, so `TermCard` no longer passes any `draggable` / drag-handler props to `SlotRow`; edits flow exclusively through the slot's ⋯ menu.)

## SectionsView — `app/chat/sidebar/SectionsView.tsx`

Exports `renderSectionsView(materialization, selectedIdx, setSelectedIdx, onConfirmCombination)`. Not a component class — just a renderer function so TermCard can call it inline.

### When it runs

Only when TermCard has decided `showSectionsView` is true: the materialization payload's state is `full` and there is a `semester` block.

### What it renders

1. `<h4>` heading "Sections" (`SectionsView.tsx:36`).
2. Combination picker: a row of tab buttons, one per proposal. Each button is labeled with its index (1-based) and has a tooltip `Combination N (weeklyHours h/wk)`. The active tab gets an extra CSS class (`SectionsView.tsx:37`).
3. For each section in the selected proposal: a card with the course id, course title (from the semester's courses, falling back to the section's own title), section meta line (`CRN ${crn} · ${schd} · §${section}`), meeting patterns (formatted by `formatPatterns` from `formatMeetingPatterns.ts`, or the literal `"Asynchronous"` when `section.isAsynchronous` is true), and instructor (defaulting to "Staff" when missing) (`SectionsView.tsx:54`).
4. Optional "Apply combination" button — only when `onConfirmCombination` is passed (`SectionsView.tsx:82`).
5. Optional truncated-note line when `semester.combinationsTruncated` is true, telling the user there are more conflict-free combinations than what's shown (`SectionsView.tsx:91`).

If `proposals` is empty, the renderer instead shows the materializer's `message` inside a banner.

## AddCourseAffordance — `app/chat/sidebar/AddCourseAffordance.tsx`

Per-term `+ Add course` UX. Receives the term's current draft from the parent (`undefined` = closed, string = open with current contents).

### Closed state

Renders a single pill-style `+ Add course` button. Clicking calls `onOpen(term)` (`AddCourseAffordance.tsx:44`).

### Open state

Renders:
1. An auto-focused text input with placeholder `e.g. CSCI-UA 480`. `onChange` calls `onChange(term, value)`. `onKeyDown` handles Enter (calls `onSubmit`) and Escape (calls `onClose`) (`AddCourseAffordance.tsx:54`).
2. When the trimmed draft is at least 2 characters, a suggestions list. The suggestions come from `gatherSuggestions(schedule, draft)` — the parent injects this. The current implementation is a client-side prefix match over the courses already in the schedule (V1 stub; the eventual `/api/v2/search-courses`-backed version slots in here). Each suggestion is clickable and replaces the draft (`AddCourseAffordance.tsx:66`).
3. An "Add" submit button (disabled when the trimmed draft is empty) and a "Cancel" button (closes the input).

## SlotRow — `app/chat/sidebar/SlotRow.tsx`

Renders one slot pill inside a term card's slot list.

### CSS classes

The `<li>` accumulates classes for: the slot kind, the optional flag (placeholder + optional), locked vs clickable, tier tint (via `slotTierClassName`), frozen (`SlotRow.tsx:76-83`). (Phase 4 E3.4 removed the former `draggable` class along with the drag gesture.)

### Title text

- Locked → "Completed — locked".
- Frozen → "Locked — click to open verbs (unlock / move via the ⋯ menu)".
- In progress → the slot-state label ("In progress (fixed in its term)") from `computeSlotState`.
- Otherwise → "Click to open verbs" (`SlotRow.tsx:85-93`).

(Phase 4 E3.4 dropped the old "drag to move" copy — the ⋯ menu is the only edit input now.)

### Inner content

`renderSlotInner(slot)` from `slotRenderHelpers.tsx` does the rendering — see below. Then either a spinner (when `isPending`) or the grade cell (via `slotGradeText(slot)`). Then the **slot-state glyph span** (`SlotRow.tsx:107-114`): the glyph + label + aria-label come straight from the pure `computeSlotState` helper (🔒 for taken/final, locked-by-you, or a term-locked slot; ◐ for an in-progress slot; empty for a planned/movable slot, whose `aria-hidden` is set when the glyph is empty). See "Slot-state glyphs" under the scheduleSidebar section above for the full state table and the precedence rules.

### Popover trigger

When `isOpen && !isLocked`, the row appends `renderSlotPopover(...)` with the slot, term, frozen flag, submenu state, the parent's submenu toggle, the schedule, and the handler bundle. (Phase 4 E3.4: with drag gone, this ⋯ popover is the sole edit affordance on a slot — `SlotRow` carries no drag handlers.)

## slotPopover — `app/chat/sidebar/slotPopover.tsx`

The 4-verb popover. `SLOT_VERBS` constant at `slotPopover.tsx:23`:

| Verb | Label | Submenu? |
|---|---|---|
| swap | "Swap with…" | yes |
| drop | "Drop" | no |
| lock | "Lock / Unlock" | no (but the label flips to "Unlock" when the slot is frozen) |
| move | "Move to…" | yes |

The popover renders one button per verb. Clicking Swap or Move toggles the matching submenu; clicking Drop fires `handlers.onDrop`; clicking Lock fires `handlers.onLock` (the parent decides direction from `isFrozen`).

### Swap submenu

`renderSwapSubmenu` (`slotPopover.tsx:76`) shows:
- An "Alternatives" header and a list of buttons, one per candidate course id from `gatherSwapAlternatives` (described below).
- An "Or search…" header followed by `SwapFreeSearch` — a small inline text input with an Enter handler and a Swap button.

### Move submenu

`renderMoveSubmenu` (`slotPopover.tsx:139`) shows either:
- "No eligible terms" header when there are no targets.
- A list of buttons labeled with each target term (via the local `formatTermLabel` helper at `slotPopover.tsx:248`).

### `gatherSwapAlternatives`

Walks the entire forward schedule. For a slot that has `satisfiesRules` (specific_planned or placeholder), collects course IDs from other slots that share at least one rule. For slots without rules (completed / in-progress), falls back to "other concrete slots in the same term". Skips the slot's own course id, dedupes, and caps at five (`slotPopover.tsx:175`).

### `gatherMoveTargets`

Walks the schedule's semesters, returns the terms of all non-locked semesters except the source term (`slotPopover.tsx:211`).

### `gatherAddCourseSuggestions`

Exported and consumed by AddCourseAffordance. Walks the schedule and returns concrete course IDs that start with the uppercase-trimmed draft. Requires 2+ characters; dedupes; caps at five (`slotPopover.tsx:228`).

## slotRenderHelpers — `app/chat/sidebar/slotRenderHelpers.tsx`

Two pure helpers consumed by SlotRow.

### `slotGradeText(slot)` — `slotRenderHelpers.tsx:16`

- `completed` → the letter grade (`slot.grade`).
- `in_progress` → `"IP"`.
- `specific_planned` and `placeholder` → em-dash (`"—"`).

### `renderSlotInner(slot)` — `slotRenderHelpers.tsx:33`

Returns the icon + identifier + optional title + credits for each slot kind:

- `completed` → `✓ ${courseId} ${optional title} ${credits}cr`.
- `in_progress` → `⏳ ${courseId} ${optional title} ${credits}cr`.
- `specific_planned` → `📅 ${courseId} ${optional title} ${credits}cr ${optional ⚠ for petition}`.
- `placeholder` → `○` (optional) or `●` (required), then the category name, then `${credits}cr` with an inline ` · optional` tag when the placeholder is optional.

The title span is rendered only when `title` is present and differs from the course id.

## SummaryCard — `app/chat/sidebar/SummaryCard.tsx`

Top-of-sidebar identity + degree progress widget.

### What it pulls from where

- **Name** — prefers `dpr.header.studentName` if present; otherwise falls back to the trimmed `student.id`; otherwise the literal `"Student"` (`SummaryCard.tsx:28`).
- **Programs** — formatted from `student.declaredPrograms` as `${programType} ${programId}` joined by commas (`SummaryCard.tsx:32`).
- **School** — `student.homeSchool` upper-cased.
- **Visa** — formatted via `formatVisa(student.visaStatus)`.
- **GPA** — `dpr.cumulative.cumulativeGpa` if available, rendered to three decimals.
- **Credits earned vs required** — `dpr.cumulative.creditsUsed` and `creditsRequired`.
- **Progress percentage** — `creditsUsed / creditsRequired * 100`, clamped to [0, 100].
- **Graduation label** — `formatTermLabel(schedule.graduationTerm)` if a schedule exists, else `"TBD"`.

### Structure rendered

1. `<h3>` with the name.
2. Meta row joining programs / school / visa with ` · `. Skipped if all are empty.
3. GPA + credits row. Each half renders only when its source is non-null; the ` · ` separator only appears when both halves render.
4. Graduation row.
5. A progress bar (`role="progressbar"` with proper ARIA attributes) that renders only when both credit numbers were available.

Each field gracefully degrades when its source is unavailable — missing values drop their row entirely instead of showing "null" or "0".

> Known limitation: the `student` prop is reconstructed **client-side from the raw DPR** by the chat page (`buildStudentProfileFromDpr`, with `visaStatus` forced to `"domestic"` unless the page captured `"f1"`). It does not carry the server's authenticated `studentId` or any home-school / program overrides, so these identity fields can disagree with the server-side profile. See [chat-ui-client.md](./chat-ui-client.md) "Known limitations".

## PriorCreditsCard — `app/chat/sidebar/PriorCreditsCard.tsx`

Renders the AP/IB/transfer (TE) credits as a single card above all term cards.

### Behavior

- Renders nothing when `entries` is empty (`PriorCreditsCard.tsx:19`).
- Otherwise: a card with header "Prior Credits" and the total credit count, then a list with one row per entry.
- Each row has a ★ icon, the course id, an optional source label (rendered only when the source differs from the course id), and the credit count. The `<li>`'s `title` attribute is set to the source string.

There is no grade column — TE rows in PeopleSoft don't carry a letter grade.

## Layout structure

### `app/layout.tsx`

Tiny root layout. Exports a `metadata` object with `title: "NYU Path — AI Course Planner"`, a description, and an inline SVG `🎓` data-URI favicon. The default export is a `RootLayout` component that wraps its `children` in `<html lang="en">` and `<body>`. Imports `./globals.css` so all routes inherit the global stylesheet.

### `app/page.tsx`

The marketing landing page. Pure server component, no state. Layout:

1. Top nav with `🎓 NYU Path` logo and a "Get Started" link to `/chat`.
2. Hero section with a "AI-Powered Course Planning" badge, a two-line title ("Plan your NYU degree" / "with AI"), a paragraph subtitle, and a primary CTA link to `/chat`.
3. Features section with three cards: "Degree Progress Report Upload" (drop your Albert DPR PDF), "Smart Course Search" (mentions 13,000+ NYU courses), "Degree Tracking".
4. Footer paragraph: "Built for NYU students. Not affiliated with New York University."

Styling comes from `./page.module.css`.

## State flow

```mermaid
flowchart TD
    Chat[/api/chat/v2 SSE/] -->|forward_schedule_update| Page[Chat page state]
    Chat -->|forward_materialization_update| Page
    Restore[/api/session/restore/] -->|StudentProfile, DPR, SchedulePreferences| Page
    Page -->|schedule, materialization, student, dpr, prefs| Sidebar[ScheduleSidebar]
    Sidebar -->|frozenKeys, pendingSlots| TermCards[TermCard per term]
    TermCards -->|slot pills| SlotRow
    SlotRow -->|popover| Popover[slotPopover]
    Popover -->|verb click| Handlers[scheduleSidebar handlers]
    TermCards -->|+ Add course| AddAff[AddCourseAffordance]
    AddAff -->|onSubmit| Handlers
    Handlers -->|HTTP POST| PlanAPI[/api/plan/<verb>/]
    PlanAPI -->|deterministic result| Handlers
    Handlers -->|onPlanActionResult| Page
    Page -->|planActionSurfaces: stage preview / red card| Sidebar
    Page -->|feasible:false only → bubble| ChatThread[Chat thread]
    Page -->|fire-and-forget| Polish[/api/plan/explain-polish/]
    Polish -->|SSE polish chunks| ChatThread
    TermCards -->|IMMEDIATE term| SectionsView
    SectionsView -->|Apply combination| Page
```

The sidebar is a pure renderer of its props plus its local interaction state. Every meaningful schedule change comes in via `schedule` and `materialization` props from the chat page, which in turn derives them from the v2 SSE stream and the session-restore call.

## Known limitations

- **Render-state is shared in-session; AGENT visibility is still next-turn.** Since Phase 4 E1.1 the chat page and the sidebar read ONE shared `createPlanStore` snapshot, so a sidebar-driven edit and a chat-driven update write the same state and every consumer re-renders with no server round-trip. What is still next-turn (by design) is the AGENT *seeing* a sidebar edit: a slot the student swapped, locked, or moved (via the ⋯ menu — drag is gone) is only visible to the agent on the next chat turn, once the persisted `forwardSchedule` is reloaded into the request body. There is no mid-turn back-channel from the sidebar into the live agent loop. (See [chat-ui-client.md](./chat-ui-client.md) "Known limitations" for the full framing.)
- **The `plan_action_bubble` text the sidebar's verbs produce is rendered by the chat page via `dangerouslySetInnerHTML`** (the markup transform lives in `apps/web/lib/renderMarkdown.ts`, not in the sidebar tree). `renderMarkdown` HTML-escapes `&`/`<`/`>` before applying its markdown transforms, so raw HTML in the bubble text is neutralized rather than rendered as live markup.
- **`gatherAddCourseSuggestions` / `gatherSwapAlternatives` are V1 client-side stubs.** Both only match against course IDs already present in the loaded `forwardSchedule` — they do NOT hit the catalog. The eventual catalog-backed autocomplete (`/api/v2/search-courses`, see [course-catalog-search.md](./course-catalog-search.md)) is not wired in yet.
