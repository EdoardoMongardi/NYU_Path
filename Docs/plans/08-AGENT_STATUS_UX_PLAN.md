# Agent Status UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a ChatGPT-style "what is the agent doing right now" indicator to the v2 chat UI — gently pulsing natural-language status (e.g. "Looking up policy…", "Planning your semester…"), then a collapsed `Thought for X seconds` chip that expands to show the full tool timeline.

**Architecture:** Pure frontend wiring on top of the existing v2 SSE stream — no engine changes, no model changes, no new server events, no extended thinking. The route already emits `tool_invocation_start` / `tool_invocation_done` and the `Message` state already carries `toolStatuses[]`. We add: (1) a tool→verb dictionary, (2) a duration formatter, (3) `startedAt` / `completedAt` fields on `Message`, (4) a new `<AgentStatusPill>` rendered while in-flight, (5) a new `<AgentStatusChip>` with expandable trace rendered after `done`. Total scope: ~2 new lib modules + 1 chat-page edit + 1 CSS edit.

**Tech Stack:** Next.js 14 App Router, React client component, vitest for unit tests, CSS Modules for styling. Existing v2 SSE infrastructure: `apps/web/lib/chatV2Client.ts`, `apps/web/app/api/chat/v2/route.ts`, `apps/web/app/chat/page.tsx`.

**Out of scope (intentionally deferred):**
- Anthropic extended thinking (`thinking` API param) — costs latency + tokens, separate decision
- Surfacing Phase 11 verifier reasoning as intermediate events — requires server-side refactor
- Streaming model "chain of thought" text into the trace — requires extended thinking
- Playwright integration tests — codebase has none today; manual browser verification matches existing convention

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/web/lib/agentStatusVerbs.ts` | **Create** | Tool name → user-facing active/past verb dictionary + idle verb fallback |
| `apps/web/lib/formatDuration.ts` | **Create** | `(ms: number) => string` — "1.2s" / "12s" / "1m 4s" |
| `apps/web/tests/agentStatusVerbs.test.ts` | **Create** | Unit tests for verb mapping + fallback |
| `apps/web/tests/formatDuration.test.ts` | **Create** | Unit tests for boundary cases |
| `apps/web/app/chat/page.tsx` | **Modify** | Add timing fields, replace inline `toolLog` block with status pill + completion chip |
| `apps/web/app/chat/chat.module.css` | **Modify** | Add `.statusPill`, `.statusChip`, `.statusTrace`, `@keyframes pulseStatus` |

---

## Task 1: Tool-verb mapping module

**Files:**
- Create: `apps/web/lib/agentStatusVerbs.ts`
- Test: `apps/web/tests/agentStatusVerbs.test.ts`

The 12 tools registered in `packages/engine/src/agent/registry.ts` are: `run_full_audit`, `plan_semester`, `check_transfer_eligibility`, `what_if_audit`, `search_policy`, `update_profile`, `confirm_profile_update`, `get_credit_caps`, `search_availability`, `get_academic_standing`, `check_overlap`, `search_courses`. Each maps to a natural-language active form (shown while running) and past form (shown in the trace after completion). A registered-but-unmapped tool falls back to `Working` / `Used a tool` so a future tool registration never crashes the UI.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/tests/agentStatusVerbs.test.ts
import { describe, it, expect } from "vitest";
import { getActiveVerb, getPastVerb, IDLE_VERB, TOOL_VERBS } from "../lib/agentStatusVerbs";

describe("agentStatusVerbs", () => {
    it("maps every tool name registered in the engine to an active verb", () => {
        const registered = [
            "run_full_audit", "plan_semester", "check_transfer_eligibility",
            "what_if_audit", "search_policy", "update_profile",
            "confirm_profile_update", "get_credit_caps", "search_availability",
            "get_academic_standing", "check_overlap", "search_courses",
        ];
        for (const t of registered) {
            expect(TOOL_VERBS[t], `missing verb for ${t}`).toBeDefined();
            expect(TOOL_VERBS[t].active.endsWith("…")).toBe(false);
            expect(TOOL_VERBS[t].past).toMatch(/.+/);
        }
    });

    it("getActiveVerb returns the mapped active form", () => {
        expect(getActiveVerb("search_policy")).toBe("Looking up policy");
        expect(getActiveVerb("plan_semester")).toBe("Planning your semester");
        expect(getActiveVerb("run_full_audit")).toBe("Running your degree audit");
    });

    it("getPastVerb returns the mapped past form", () => {
        expect(getPastVerb("search_policy")).toBe("Looked up policy");
        expect(getPastVerb("plan_semester")).toBe("Planned a semester");
    });

    it("falls back gracefully for unknown tool names", () => {
        expect(getActiveVerb("future_tool_xyz")).toBe("Working");
        expect(getPastVerb("future_tool_xyz")).toBe("Used a tool");
    });

    it("template_match pseudo-tools are passed through with a sensible verb", () => {
        expect(getActiveVerb("template:f1_credit_floor")).toBe("Checking a known answer");
        expect(getPastVerb("template:f1_credit_floor")).toBe("Matched a known answer");
    });

    it("exposes IDLE_VERB constant for the no-tool 'Thinking' state", () => {
        expect(IDLE_VERB).toBe("Thinking");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/web/`: `pnpm vitest run tests/agentStatusVerbs.test.ts`
Expected: FAIL with `Cannot find module '../lib/agentStatusVerbs'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/lib/agentStatusVerbs.ts

/**
 * User-facing verbs for the 12 tools in the engine registry.
 * The active form is shown while the tool is running (the chat UI
 * appends "…" at render time). The past form is shown in the
 * post-completion expandable trace.
 *
 * If a tool name is not in this map (e.g. a newly-added tool the
 * UI has not been updated for, or a `template:*` pseudo-tool that
 * surfaces template-match events), getActiveVerb / getPastVerb
 * fall back to a generic verb so the UI never crashes.
 */
export type ToolVerb = { active: string; past: string };

export const TOOL_VERBS: Record<string, ToolVerb> = {
    run_full_audit:             { active: "Running your degree audit",        past: "Ran your degree audit" },
    plan_semester:              { active: "Planning your semester",           past: "Planned a semester" },
    check_transfer_eligibility: { active: "Checking transfer eligibility",    past: "Checked transfer eligibility" },
    what_if_audit:              { active: "Running a what-if audit",          past: "Ran a what-if audit" },
    search_policy:              { active: "Looking up policy",                past: "Looked up policy" },
    update_profile:             { active: "Preparing a profile update",       past: "Prepared a profile update" },
    confirm_profile_update:     { active: "Updating your profile",            past: "Updated your profile" },
    get_credit_caps:            { active: "Checking credit caps",             past: "Checked credit caps" },
    search_availability:        { active: "Checking course offerings",        past: "Checked course offerings" },
    get_academic_standing:      { active: "Reading your academic standing",   past: "Read your academic standing" },
    check_overlap:              { active: "Checking course overlap",          past: "Checked course overlap" },
    search_courses:             { active: "Searching the course catalog",     past: "Searched the course catalog" },
};

const TEMPLATE_VERB: ToolVerb = { active: "Checking a known answer", past: "Matched a known answer" };
const FALLBACK_VERB: ToolVerb = { active: "Working", past: "Used a tool" };

export const IDLE_VERB = "Thinking";

export function getActiveVerb(toolName: string): string {
    if (toolName.startsWith("template:")) return TEMPLATE_VERB.active;
    return TOOL_VERBS[toolName]?.active ?? FALLBACK_VERB.active;
}

export function getPastVerb(toolName: string): string {
    if (toolName.startsWith("template:")) return TEMPLATE_VERB.past;
    return TOOL_VERBS[toolName]?.past ?? FALLBACK_VERB.past;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `apps/web/`: `pnpm vitest run tests/agentStatusVerbs.test.ts`
Expected: PASS, 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/agentStatusVerbs.ts apps/web/tests/agentStatusVerbs.test.ts
git commit -m "feat(web): tool-name → user-facing verb dictionary for agent status UX"
```

---

## Task 2: Duration formatter

**Files:**
- Create: `apps/web/lib/formatDuration.ts`
- Test: `apps/web/tests/formatDuration.test.ts`

A pure function that turns elapsed milliseconds into a compact human string. Used twice: in the live status pill if a tool drags past 5s ("Looking up policy… (6s)"), and in the post-completion chip ("Thought for 4.7s").

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/tests/formatDuration.test.ts
import { describe, it, expect } from "vitest";
import { formatDuration } from "../lib/formatDuration";

describe("formatDuration", () => {
    it("returns sub-second values in ms", () => {
        expect(formatDuration(0)).toBe("0ms");
        expect(formatDuration(450)).toBe("450ms");
        expect(formatDuration(999)).toBe("999ms");
    });

    it("returns 1 decimal place between 1s and 9.9s", () => {
        expect(formatDuration(1000)).toBe("1.0s");
        expect(formatDuration(1234)).toBe("1.2s");
        expect(formatDuration(4670)).toBe("4.7s");
        expect(formatDuration(9900)).toBe("9.9s");
    });

    it("returns whole seconds between 10s and 59s", () => {
        expect(formatDuration(10000)).toBe("10s");
        expect(formatDuration(45499)).toBe("45s");
        expect(formatDuration(59999)).toBe("60s");
    });

    it("returns minutes + seconds beyond 60s", () => {
        expect(formatDuration(60000)).toBe("1m 0s");
        expect(formatDuration(64500)).toBe("1m 5s");
        expect(formatDuration(125000)).toBe("2m 5s");
    });

    it("clamps negative input to 0ms", () => {
        expect(formatDuration(-50)).toBe("0ms");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `apps/web/`: `pnpm vitest run tests/formatDuration.test.ts`
Expected: FAIL with `Cannot find module '../lib/formatDuration'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/web/lib/formatDuration.ts

/**
 * Human-friendly elapsed-time formatter for the agent status UI.
 *   < 1s   → "450ms"
 *   1-10s  → "4.7s"   (1 decimal)
 *   10-60s → "45s"    (rounded to whole second)
 *   ≥ 60s  → "1m 5s"
 */
export function formatDuration(ms: number): string {
    const clamped = Math.max(0, ms);
    if (clamped < 1000) return `${Math.round(clamped)}ms`;
    const s = clamped / 1000;
    if (s < 10) return `${s.toFixed(1)}s`;
    if (s < 60) return `${Math.round(s)}s`;
    const mins = Math.floor(s / 60);
    const remaining = Math.round(s - mins * 60);
    return `${mins}m ${remaining}s`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `apps/web/`: `pnpm vitest run tests/formatDuration.test.ts`
Expected: PASS, 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/formatDuration.ts apps/web/tests/formatDuration.test.ts
git commit -m "feat(web): formatDuration helper for agent status chip"
```

---

## Task 3: Extend `Message` with timing + completion fields

**Files:**
- Modify: `apps/web/app/chat/page.tsx:35-47, 101-121, 123-193`

Add `startedAt`, `completedAt`, and `failedAt` (epoch ms) to `Message`, and a `traceExpanded` boolean for the expand toggle. Capture the timestamps in `handleSendV2` and `applyEvent`. No rendering change yet — this task is purely state.

- [ ] **Step 1: Update the `Message` interface**

Change `apps/web/app/chat/page.tsx:35-47` from:

```typescript
interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
    /** Per-message tool-invocation log (rendered inline above the bubble) */
    toolStatuses?: ToolStatus[];
    /** Per-message validator violations (rendered as a warning chip below the bubble) */
    validatorViolations?: Array<{ kind: string; detail: string; caveatId?: string }>;
    /** Phase 5 §7.2 two-step profile-update affordance — present when
     *  this message reports a `pendingMutationId` from `update_profile`. */
    pendingMutationId?: string;
}
```

to:

```typescript
interface Message {
    id: string;
    role: "user" | "assistant";
    content: string;
    timestamp: Date;
    /** Per-message tool-invocation log (rendered inline above the bubble) */
    toolStatuses?: ToolStatus[];
    /** Per-message validator violations (rendered as a warning chip below the bubble) */
    validatorViolations?: Array<{ kind: string; detail: string; caveatId?: string }>;
    /** Phase 5 §7.2 two-step profile-update affordance — present when
     *  this message reports a `pendingMutationId` from `update_profile`. */
    pendingMutationId?: string;
    /** Agent-status UX: epoch ms when the v2 stream was opened. Set
     *  on assistant messages only; absent on welcome / v1 / user. */
    startedAt?: number;
    /** Agent-status UX: epoch ms when the `done` SSE event arrived. */
    completedAt?: number;
    /** Agent-status UX: epoch ms when an `error` event arrived. Used
     *  to render "Failed after Xs" instead of "Thought for Xs". */
    failedAt?: number;
    /** Agent-status UX: whether the user has expanded the trace. */
    traceExpanded?: boolean;
}
```

- [ ] **Step 2: Set `startedAt` when the assistant bubble is created**

Change `apps/web/app/chat/page.tsx:107-110` from:

```typescript
        // Pre-create the assistant bubble so tokens stream INTO it.
        const assistant = addMessage("assistant", "");
        const toolStatuses: ToolStatus[] = [];
```

to:

```typescript
        // Pre-create the assistant bubble so tokens stream INTO it.
        const assistant = addMessage("assistant", "");
        updateMessage(assistant.id, { startedAt: Date.now() });
        const toolStatuses: ToolStatus[] = [];
```

- [ ] **Step 3: Set `completedAt` on `done` and `failedAt` on `error`**

In `apps/web/app/chat/page.tsx:172-178`, change the `done` case from:

```typescript
            case "done":
                // Final reconciliation — the server's `finalText` is
                // authoritative. For block-streaming this matches the
                // accumulated tokens; for future intra-token streaming
                // this guards against partial-chunk artifacts.
                updateMessage(assistantId, { content: ev.finalText });
                break;
```

to:

```typescript
            case "done":
                // Final reconciliation — the server's `finalText` is
                // authoritative. For block-streaming this matches the
                // accumulated tokens; for future intra-token streaming
                // this guards against partial-chunk artifacts.
                updateMessage(assistantId, { content: ev.finalText, completedAt: Date.now() });
                break;
```

In the `error` case (`apps/web/app/chat/page.tsx:179-191`), change the `updateMessage` call from:

```typescript
                updateMessage(assistantId, { content: existing && existing.length > 0 ? existing : friendly });
```

to:

```typescript
                updateMessage(assistantId, {
                    content: existing && existing.length > 0 ? existing : friendly,
                    failedAt: Date.now(),
                });
```

- [ ] **Step 4: Run the existing test suite to confirm no regression**

Run from repo root: `pnpm test`
Expected: all existing suites still pass (815+ tests). Timing fields are additive and should not affect any existing assertion.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/chat/page.tsx
git commit -m "feat(web): track per-message agent-turn timing for status UX"
```

---

## Task 4: Render the live status pill (in-flight)

**Files:**
- Modify: `apps/web/app/chat/page.tsx:391-401`
- Modify: `apps/web/app/chat/chat.module.css` — append new classes at the end

Replace the existing `.toolLog` block with a single status pill that shows the current verb (latest running tool's active verb, else `Thinking`) with a gentle pulse. The pill is visible while `startedAt` is set and `completedAt` / `failedAt` are not — i.e. while the turn is in flight.

- [ ] **Step 1: Add a helper that derives the current verb**

At the top of `apps/web/app/chat/page.tsx` (just after the existing imports — line 5), add:

```typescript
import { getActiveVerb, getPastVerb, IDLE_VERB } from "../../lib/agentStatusVerbs";
import { formatDuration } from "../../lib/formatDuration";
```

Then, just before the `export default function ChatPage()` declaration (around line 60), add:

```typescript
function currentVerbFor(toolStatuses: ToolStatus[] | undefined): string {
    if (!toolStatuses || toolStatuses.length === 0) return IDLE_VERB;
    // Latest tool wins. If nothing is currently running (between
    // tool calls), the most-recent done tool's *active* form is a
    // worse fit than IDLE_VERB, so we fall back to "Thinking".
    const lastRunning = [...toolStatuses].reverse().find(t => t.state === "running");
    if (lastRunning) return getActiveVerb(lastRunning.toolName);
    return IDLE_VERB;
}
```

- [ ] **Step 2: Replace the inline `toolLog` block with the new status pill**

Change `apps/web/app/chat/page.tsx:390-401` from:

```typescript
                            {/* Tool-invocation log (Phase 6.5 P-1) */}
                            {msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                <div className={styles.toolLog ?? ""} style={{ fontSize: "0.85em", opacity: 0.7, marginBottom: 6 }}>
                                    {msg.toolStatuses.map((t, idx) => (
                                        <div key={idx}>
                                            {t.state === "running" && <>⏳ running <code>{t.toolName}</code>…</>}
                                            {t.state === "done" && <>✓ <code>{t.toolName}</code></>}
                                            {t.state === "error" && <>⚠ <code>{t.toolName}</code> — {t.error}</>}
                                        </div>
                                    ))}
                                </div>
                            )}
```

to:

```typescript
                            {/* Live status pill — shown while the turn is in flight. */}
                            {msg.role === "assistant" && msg.startedAt && !msg.completedAt && !msg.failedAt && (
                                <div className={styles.statusPill}>
                                    <span className={styles.statusDot} />
                                    <span className={styles.statusVerb}>
                                        {currentVerbFor(msg.toolStatuses)}…
                                    </span>
                                </div>
                            )}
                            {/* Post-completion chip — shown after `done` arrives. */}
                            {msg.role === "assistant" && msg.startedAt && (msg.completedAt || msg.failedAt) && (
                                <div className={styles.statusChip}>
                                    <button
                                        type="button"
                                        className={styles.statusChipButton}
                                        onClick={() => updateMessage(msg.id, { traceExpanded: !msg.traceExpanded })}
                                        aria-expanded={!!msg.traceExpanded}
                                        disabled={!msg.toolStatuses || msg.toolStatuses.length === 0}
                                    >
                                        <span className={styles.statusChipLabel}>
                                            {msg.failedAt
                                                ? `Failed after ${formatDuration(msg.failedAt - msg.startedAt)}`
                                                : `Thought for ${formatDuration((msg.completedAt ?? Date.now()) - msg.startedAt)}`}
                                        </span>
                                        {msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                            <span className={styles.statusChipChevron}>
                                                {msg.traceExpanded ? "▾" : "▸"}
                                            </span>
                                        )}
                                    </button>
                                    {msg.traceExpanded && msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                        <ul className={styles.statusTrace}>
                                            {msg.toolStatuses.map((t, idx) => (
                                                <li key={idx} className={styles.statusTraceItem}>
                                                    <span className={styles.statusTraceIcon}>
                                                        {t.state === "running" ? "•" : t.state === "error" ? "⚠" : "✓"}
                                                    </span>
                                                    <span className={styles.statusTraceText}>
                                                        {getPastVerb(t.toolName)}
                                                        {t.error ? ` — ${t.error}` : ""}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}
```

- [ ] **Step 3: Append the new styles to `chat.module.css`**

Append to the end of `apps/web/app/chat/chat.module.css`:

```css
/* ---------- Agent status pill (live, while turn is in flight) ---------- */
.statusPill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    margin-bottom: 8px;
    background: rgba(13, 110, 253, 0.08);
    border: 1px solid rgba(13, 110, 253, 0.18);
    border-radius: 999px;
    font-size: 0.85em;
    color: #0d6efd;
    animation: pulseStatus 1.6s ease-in-out infinite;
}

.statusDot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    animation: pulseDot 1.6s ease-in-out infinite;
}

.statusVerb {
    font-weight: 500;
    letter-spacing: 0.01em;
}

@keyframes pulseStatus {
    0%, 100% { opacity: 0.65; }
    50%      { opacity: 1.0; }
}

@keyframes pulseDot {
    0%, 100% { transform: scale(0.85); opacity: 0.7; }
    50%      { transform: scale(1.05); opacity: 1.0; }
}

@media (prefers-reduced-motion: reduce) {
    .statusPill, .statusDot { animation: none; }
}

/* ---------- Agent status chip (collapsed, after completion) ---------- */
.statusChip {
    margin-bottom: 8px;
    font-size: 0.85em;
    color: #6c757d;
}

.statusChipButton {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: transparent;
    border: 1px solid rgba(108, 117, 125, 0.25);
    border-radius: 999px;
    color: inherit;
    font: inherit;
    cursor: pointer;
}

.statusChipButton:hover:not(:disabled) {
    background: rgba(108, 117, 125, 0.06);
    border-color: rgba(108, 117, 125, 0.45);
}

.statusChipButton:disabled {
    cursor: default;
    opacity: 0.7;
}

.statusChipLabel {
    font-weight: 500;
}

.statusChipChevron {
    font-size: 0.9em;
    line-height: 1;
}

.statusTrace {
    list-style: none;
    margin: 8px 0 0 0;
    padding: 8px 12px;
    background: rgba(108, 117, 125, 0.06);
    border-radius: 8px;
}

.statusTraceItem {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    line-height: 1.45;
}

.statusTraceIcon {
    flex: 0 0 auto;
    font-size: 0.9em;
    opacity: 0.7;
    width: 14px;
    text-align: center;
}

.statusTraceText {
    flex: 1 1 auto;
    color: #495057;
}
```

- [ ] **Step 4: Type-check the web app**

Run from repo root: `pnpm --filter @nyupath/web typecheck` (or `pnpm tsc --noEmit` from `apps/web/` if no script alias).
Expected: clean exit, no type errors. If `currentVerbFor` complains about `ToolStatus` not being in scope, ensure the existing `ToolStatus` interface (line 28) is referenced (it is — `currentVerbFor` is defined in the same file).

- [ ] **Step 5: Run all unit tests to confirm no regression**

Run from repo root: `pnpm test`
Expected: all existing suites pass; the two new suites (`agentStatusVerbs.test.ts`, `formatDuration.test.ts`) pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/chat/page.tsx apps/web/app/chat/chat.module.css
git commit -m "feat(web): natural-language agent status pill + 'Thought for Xs' chip"
```

---

## Task 5: Manual browser verification

**Files:** none (verification step)

Three real-world flows must visibly work. The plan is complete only when all three look right in a real browser. There are no automated UI tests for this page (the codebase uses vitest for libs + routes, not Playwright), so this manual pass is load-bearing.

- [ ] **Step 1: Start the dev server**

```bash
pnpm --filter @nyupath/web dev
```

Open `http://localhost:3001`. Complete onboarding (DPR upload → confirm → visa → graduation target) so `onboardingStep === "complete"` and v2 SSE turns are active.

- [ ] **Step 2: Verify the live pill (single tool)**

Send: **"What's NYU's F-1 credit floor for international students?"**

Expected during the turn:
- A blue pill appears immediately under the assistant avatar reading **"Thinking…"** with a gently pulsing dot.
- The pill text changes to **"Looking up policy…"** (or similar, depending on which tool the agent picks first) within ~500ms-2s.
- When tokens start streaming, the pill disappears and the answer text appears.
- After the response finishes, a grey chip reads **"Thought for X.Ys"** with a `▸` chevron.
- Clicking the chevron expands a single-line trace: `✓  Looked up policy`.

- [ ] **Step 3: Verify the live pill (multi-tool plan)**

Send: **"What should I take next semester?"**

Expected:
- Pill cycles through verbs as tools fire — likely **"Running your degree audit…"** → **"Thinking…"** → **"Planning your semester…"** → **"Checking course offerings…"**.
- Final chip shows **"Thought for X.Ys"**.
- Expanded trace lists 3-4 past-tense entries in order, each with a ✓ icon.

- [ ] **Step 4: Verify the failure path**

Force an error (e.g. stop the dev server mid-turn, or temporarily throw inside `runV2Turn`). The chip should read **"Failed after X.Ys"** with no chevron when no tools fired, or with the trace if any tools completed before the failure.

- [ ] **Step 5: Verify reduced-motion**

In macOS System Settings → Accessibility → Display, enable **Reduce motion**. Reload the chat page and send any tool-using question. The pill should be visible but **not pulsing**. (Verifies the `@media (prefers-reduced-motion: reduce)` rule.)

- [ ] **Step 6: Verify tool-coverage breadth (smoke)**

Send each of the following one at a time and confirm the pill verb is sensible English (not the raw tool name):

| Question | Expected verb |
|---|---|
| "What's my major GPA?" | "Reading your academic standing…" or "Running your degree audit…" |
| "Can I transfer into Stern from CAS?" | "Checking transfer eligibility…" |
| "Search for HIST-UA courses" | "Searching the course catalog…" |
| "What if I switched my major to Math?" | "Running a what-if audit…" |
| "Update my expected graduation to Spring 2027" | "Preparing a profile update…" then on confirm "Updating your profile…" |

A verb falling back to **"Working…"** for any of these means a tool name is missing from `TOOL_VERBS`. Add it to the dictionary and re-test.

- [ ] **Step 7: Document the verification result**

If any expected behavior failed, write it down — do not commit Task 5 as passing. Open a fix sub-task before proceeding.

---

## Task 6: Final commit + summary

**Files:** none

- [ ] **Step 1: Confirm clean working tree on the feature work**

```bash
git status
```

Expected: only the files listed in the **File Structure** table are modified or created. If anything else is staged or modified, investigate before committing.

- [ ] **Step 2: Confirm the test suite is green**

```bash
pnpm test
```

Expected: all existing suites + the two new suites pass.

- [ ] **Step 3: (If all five Task 5 verifications passed) Push**

```bash
git push
```

- [ ] **Step 4: Tear-off note (paste into the operator log)**

```
Agent status UX shipped. Frontend-only — no engine, model, or SSE changes.
- 12 tools mapped to natural-language verbs (apps/web/lib/agentStatusVerbs.ts)
- Live pulsing pill while in flight, "Thought for Xs" chip after done
- Expandable trace shows past-tense tool sequence
- Respects prefers-reduced-motion
- 0 model tokens / 0 latency added
```

---

## Self-review notes

**Spec coverage:**
- "Show what the agent is doing in natural language" → Task 4 step 2 (status pill with `currentVerbFor`)
- "ChatGPT-style flashing thinking words" → Task 4 step 3 (`@keyframes pulseStatus`)
- "Thought for X seconds" → Task 4 step 2 (`statusChipLabel`)
- "Tab for users to expand to see the thinking logic" → Task 4 step 2 (`statusChipButton` toggling `traceExpanded`, `statusTrace` ul)

**No new server work** — confirmed against the investigation: stream opens immediately on POST (`apps/web/app/api/chat/v2/route.ts:387`), `tool_invocation_start` / `tool_invocation_done` already carry `toolName`, no events need to be added.

**No model cost** — `claude-haiku-4-5-20251001` is unchanged; no `thinking` parameter is set; no extra round-trips.

**Test coverage** — pure modules are unit-tested; UI state machine is verified manually (Task 5) because the existing codebase has no Playwright setup and adding one is out of scope.

**Edge cases handled** — unknown tool name (fallback verb), `template:*` pseudo-tools (template verb), error path ("Failed after Xs"), no-tool turns (chip with disabled chevron), reduced-motion preference (animation off).
