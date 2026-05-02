# Phase 12.5 — Validator Hardening + getCreditCaps Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address the structural issues that survived Phase 12 — validator gaps that let the agent punt on quantitative requests, validator output bleeding into user-visible chat, the `getCreditCaps` rejection-and-reroute pattern that confuses the reasoning trace, and the missing extension to grounding-validator that should accept user-supplied numbers as legitimate.

**Architecture:** Six tasks in two themes. **Theme A (validator hardening):** extend `responseValidator.ts` with three new rules — `quantitative_shortfall` (user asked for N, answer delivered M < N), `user_number_grounding` (numbers in `userQuestion` are groundable, not just tool-result numbers), and `validator_message_leak` (assistant text must not echo validator-internal phrasing). Wire `completenessReviewer.ts` into the v2 route (it already exists, never made it to prod). **Theme B (tool surface cleanup):** rewrite `getCreditCaps.validateInput` to RETURN data + `suggestedFollowUp` instead of rejecting, and stop streaming validator-replay system messages into the assistant `text_delta` stream so the user never sees internal monologue.

**Tech Stack:** TypeScript, Zod schemas, vitest, Next.js 16 App Router. Engine-side: `packages/engine/src/agent/`. Web-side: `apps/web/`. The verifier-subagent dispatch pattern (`verificationAgent.ts`-style) is intentionally NOT introduced — Phase 12.5 keeps the existing in-loop validator architecture and just extends its rule set. A separate verifier subagent could be Phase 13 if rule extension proves insufficient.

**Out of scope (deferred to Phase 13+):**
- Iteration-aware reasoning trace UI (group `thinking_delta` events by agent-loop iteration so Issue #1 from the audit is fully closed at the UI layer)
- Anthropic verifier subagent dispatch (`verificationAgent.ts` adoption)
- Per-tool postcondition assertions

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/engine/src/agent/responseValidator.ts` | **Modify** | Add 3 new `ViolationKind`s and `check*` helpers: `quantitative_shortfall`, `user_number_grounding` extension, `validator_message_leak`. Wire `userQuestion` numbers into the grounding-allow set. |
| `packages/engine/tests/agent/quantitativeShortfall.test.ts` | **Create** | Unit tests for "user asked for N, answer delivered M < N" detection. |
| `packages/engine/tests/agent/userNumberGrounding.test.ts` | **Create** | Unit tests asserting numbers from `userQuestion` count as grounded. |
| `packages/engine/tests/agent/validatorMessageLeak.test.ts` | **Create** | Unit tests catching assistant text that echoes validator-internal phrasing. |
| `packages/engine/src/agent/agentLoop.ts` | **Modify** | When the validator-replay loop fires, the system-message correction must be appended to the agent's NEXT-turn input, NOT included in the user-facing `text_delta` stream of the current turn. |
| `apps/web/app/api/chat/v2/route.ts` | **Modify** | After `validateResponse`, also call the existing `reviewCompleteness` from `completenessReviewer.ts`. On fail, replay with the same loop. |
| `packages/engine/src/agent/completenessReviewer.ts` | **Read-only reference** | Already implemented in `tools/cohort-eval/runPhase10MethodB.ts`. Wire its existing API into the v2 route — no new code in this file unless the API needs adjustment. |
| `packages/engine/src/agent/tools/getCreditCaps.ts` | **Modify** | Drop the `validateInput` rejection on DPR-loaded sessions. Always return data; attach a `suggestedFollowUp` envelope entry pointing at `search_policy` for F-1 / per-semester-ceiling questions. |
| `packages/engine/tests/agent/getCreditCapsRefactor.test.ts` | **Create** | Asserts `getCreditCaps` runs on DPR-loaded sessions (no rejection) and emits the `suggestedFollowUp`. |

---

## Task 1: `quantitative_shortfall` validator rule (Issue #7 / #8 from audit)

**Files:**
- Modify: `packages/engine/src/agent/responseValidator.ts`
- Create: `packages/engine/tests/agent/quantitativeShortfall.test.ts`

When the user explicitly requests a quantity ("16 credits", "3 courses", "5 electives"), the answer must EITHER deliver that quantity OR explicitly explain why it's impossible — never silently deliver M < N and punt with "what would you like to do?".

This rule fires when:
1. The `userQuestion` contains a number followed by a unit-keyword (`credits`, `courses`, `electives`, `units`, `classes`).
2. The `assistantText` contains a fulfilled quantity for the SAME unit-keyword.
3. The fulfilled quantity is strictly less than the requested quantity.
4. The `assistantText` does NOT contain a phrase indicating a deliberate shortfall ("could not fill", "below the requested", "short of the requested", "F-1 floor", "credit ceiling").

Generic structural rule, not a keyword blacklist — works for any unit + any quantity.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/quantitativeShortfall.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator";
import type { StudentProfile } from "@nyupath/shared";

const MINIMAL_STUDENT: StudentProfile = {
    studentId: "test",
    homeSchoolId: "cas",
    declaredPrograms: [],
    visaStatus: undefined,
    transcript: { semesters: [] },
    plans: [],
    expectedGraduationTerm: undefined,
};

describe("quantitative_shortfall validator rule", () => {
    it("flags 'asked for 16 credits, delivered 8 credits, no shortfall acknowledgement' as quantitative_shortfall", () => {
        const verdict = validateResponse({
            assistantText: "Here's your plan: CORE-UA 400 (4cr) and CSCI-UA 421 (4cr), totaling 8 credits. What would you like to do next?",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for courses of 16 credits in total",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(true);
    });

    it("does NOT flag when answer delivers exactly the requested quantity", () => {
        const verdict = validateResponse({
            assistantText: "Here's your plan: CORE-UA 400, CSCI-UA 421, and 2 free electives, totaling 16 credits.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for courses of 16 credits in total",
        });
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(false);
    });

    it("does NOT flag when shortfall is explicitly acknowledged", () => {
        const verdict = validateResponse({
            assistantText: "Could not fill the requested 16-credit plan; delivered 8 credits across 2 courses. The student should call search_courses to find additional electives.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for courses of 16 credits in total",
        });
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(false);
    });

    it("does NOT fire when the user's number isn't paired with a unit keyword", () => {
        // "I want option 16" — 16 isn't a quantity of credits/courses.
        const verdict = validateResponse({
            assistantText: "Here is option 16's content: ...",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "show me option 16",
        });
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(false);
    });

    it("works for the 'courses' unit, not just credits", () => {
        const verdict = validateResponse({
            assistantText: "Here are 3 elective options.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "give me 5 electives",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/quantitativeShortfall.test.ts`
Expected: FAIL — the new violation kind doesn't exist yet.

- [ ] **Step 3: Add the violation kind + check helper**

Open `packages/engine/src/agent/responseValidator.ts`. Find the `ViolationKind` union and append:

```typescript
    | "quantitative_shortfall"
```

Just before `validateResponse`, add the helper:

```typescript
const UNIT_KEYWORDS = ["credit", "credits", "course", "courses", "elective", "electives", "unit", "units", "class", "classes"];

const SHORTFALL_ACKNOWLEDGEMENTS = [
    /could not fill/i,
    /below the requested/i,
    /short of the requested/i,
    /f-?1 floor/i,
    /credit ceiling/i,
    /less than (?:the )?requested/i,
    /unable to (?:fill|reach) the (?:requested )?(?:target|amount)/i,
];

/**
 * Catches "asked for N, delivered M < N, punted to user" patterns.
 * Generic structural rule: extracts (number, unit) pairs from
 * userQuestion, finds the same unit in assistantText, compares
 * quantities. If assistantText already acknowledges the shortfall
 * (via one of the SHORTFALL_ACKNOWLEDGEMENTS phrases), the rule
 * passes — the agent did its job by being explicit about the gap.
 */
function checkQuantitativeShortfall(userQuestion: string | undefined, assistantText: string): Violation[] {
    if (!userQuestion) return [];

    // Extract (number, unit) pairs from the user's question.
    // Pattern: "<number> <unit-keyword>" allowing for "in total" /
    // "of <something>" interstitials.
    const requested: Array<{ count: number; unit: string }> = [];
    const REQ_RE = /\b(\d+)\s+(?:[a-z]+\s+)?(credits?|courses?|electives?|units?|classes)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = REQ_RE.exec(userQuestion)) !== null) {
        requested.push({ count: parseInt(m[1]!, 10), unit: m[2]!.toLowerCase().replace(/s$/, "") });
    }
    if (requested.length === 0) return [];

    // Did the assistant acknowledge a shortfall?
    const acknowledged = SHORTFALL_ACKNOWLEDGEMENTS.some(re => re.test(assistantText));
    if (acknowledged) return [];

    // For each requested (count, unit), find the highest delivered
    // count for the same unit in the assistant text.
    const violations: Violation[] = [];
    for (const req of requested) {
        const DELIV_RE = new RegExp(`\\b(\\d+)\\s+${req.unit}s?\\b`, "gi");
        let highest = 0;
        let mm: RegExpExecArray | null;
        while ((mm = DELIV_RE.exec(assistantText)) !== null) {
            const delivered = parseInt(mm[1]!, 10);
            if (delivered > highest) highest = delivered;
        }
        if (highest > 0 && highest < req.count) {
            violations.push({
                kind: "quantitative_shortfall",
                detail:
                    `User requested ${req.count} ${req.unit}${req.count === 1 ? "" : "s"}; ` +
                    `assistant delivered ${highest}. Either deliver the full request, or explicitly ` +
                    `acknowledge the shortfall ("could not fill", "below the requested ${req.count}", etc.) ` +
                    `and explain why. Do not punt with a clarifying question after a partial delivery.`,
            });
        }
    }
    return violations;
}
```

In `validateResponse`, find where existing checks aggregate and add:

```typescript
    violations.push(...checkQuantitativeShortfall(ctx.userQuestion, ctx.assistantText));
```

- [ ] **Step 4: Run tests to verify pass**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/quantitativeShortfall.test.ts`
Expected: 5/5 PASS.

- [ ] **Step 5: Run full engine suite**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: 725 + 5 = 730 pass. Watch for fixtures whose `assistantText` hits a shortfall pattern — adapt assertions if needed.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/responseValidator.ts packages/engine/tests/agent/quantitativeShortfall.test.ts
git commit -m "fix(engine): quantitative_shortfall rule catches 'asked N, delivered M' punts"
```

---

## Task 2: User-supplied numbers count as grounded (Issue #9)

**Files:**
- Modify: `packages/engine/src/agent/responseValidator.ts` (extend `checkGrounding`)
- Create: `packages/engine/tests/agent/userNumberGrounding.test.ts`

When the user says "plan for 16 credits" and the agent quotes "16" back in a clarifying or confirming reply, the grounding validator currently flags `ungrounded_number` because 16 doesn't appear in any tool-result text from this turn. That's a false positive — numbers from `userQuestion` are legitimately grounded by virtue of being what the user said. Generic fix: extend the allow-set in `checkGrounding`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/userNumberGrounding.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator";
import type { StudentProfile } from "@nyupath/shared";

const MINIMAL_STUDENT: StudentProfile = {
    studentId: "test",
    homeSchoolId: "cas",
    declaredPrograms: [],
    visaStatus: undefined,
    transcript: { semesters: [] },
    plans: [],
    expectedGraduationTerm: undefined,
};

describe("user-supplied numbers count as grounded", () => {
    it("does NOT flag a number that originated in the user's question", () => {
        const verdict = validateResponse({
            assistantText: "Just to confirm — you'd like a 16-credit plan?",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for courses of 16 credits in total",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number")).toBe(false);
    });

    it("does NOT flag user numbers even when no tool was called", () => {
        const verdict = validateResponse({
            assistantText: "I see you want 5 electives. Which semester are we planning?",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "give me 5 electives",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number")).toBe(false);
    });

    it("STILL flags a number that's neither in the user's question nor a tool result", () => {
        const verdict = validateResponse({
            assistantText: "Your GPA is 3.7.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "what's my GPA?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number")).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify failures**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/userNumberGrounding.test.ts`
Expected: tests 1 and 2 FAIL (the validator currently flags user-numbers as ungrounded). Test 3 should PASS (the existing rule correctly catches the fabricated GPA).

- [ ] **Step 3: Extend `checkGrounding` to include `userQuestion` numbers**

Open `packages/engine/src/agent/responseValidator.ts`. Find `checkGrounding` (it's where `extractNumbers` is called against tool results). The current shape gathers numbers from `invocations[*].summary` (or similar) into an allow-set, then checks every number in `assistantText` against it.

Extend the allow-set to also include numbers extracted from `ctx.userQuestion`. The minimal change:

Find where the allow-set is built — looks something like:

```typescript
function checkGrounding(ctx: ValidatorContext): Violation[] {
    const allowedNumbers = new Set<string>();
    for (const inv of ctx.invocations) {
        for (const n of extractNumbers(inv.summary ?? "")) {
            allowedNumbers.add(n);
        }
    }
    // ...
}
```

Add user-question numbers to the same allow-set:

```typescript
function checkGrounding(ctx: ValidatorContext): Violation[] {
    const allowedNumbers = new Set<string>();
    for (const inv of ctx.invocations) {
        for (const n of extractNumbers(inv.summary ?? "")) {
            allowedNumbers.add(n);
        }
    }
    // Phase 12.5 Task 2 — numbers the user typed in their question are
    // legitimately groundable by the agent's reply (e.g. "16 credits"
    // echoed back in a clarifying question). Without this, the
    // grounding rule false-positives on every quote-back of a user
    // quantity.
    if (ctx.userQuestion) {
        for (const n of extractNumbers(ctx.userQuestion)) {
            allowedNumbers.add(n);
        }
    }
    // ...rest of the function unchanged
}
```

The `extractNumbers` helper already exists (search the file for `function extractNumbers`). It returns numbers as strings — same shape used for tool-result numbers.

- [ ] **Step 4: Run tests to verify pass**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/userNumberGrounding.test.ts`
Expected: 3/3 PASS.

- [ ] **Step 5: Run full engine suite**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: 730 + 3 = 733 pass.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/responseValidator.ts packages/engine/tests/agent/userNumberGrounding.test.ts
git commit -m "fix(engine): grounding validator accepts numbers from userQuestion"
```

---

## Task 3: Validator-replay messages must not leak into user-facing text (Issue #10)

**Files:**
- Modify: `packages/engine/src/agent/agentLoop.ts` (replay-loop wiring)
- Create: `packages/engine/tests/agent/validatorMessageLeak.test.ts`

When the validator fails and the agent loop replays with a correction, the correction is supposed to be a SYSTEM message to the model. But during the operator test, the user saw the model's INTERNAL self-correction monologue ("The validator is catching several issues: 1. The number '8' for free electives — I need to trace this back…") rendered as assistant content.

Two possible root causes:
- (a) The replay-loop injects the correction as an assistant message instead of a system/user message; the model echoes it back.
- (b) The model's thinking text on the replay turn references the validator's complaint, and our streaming `thinking_delta` UI shows it.

The fix depends on which is happening. Diagnosis step in Step 1 below.

- [ ] **Step 1: Diagnose the leak source**

Read `packages/engine/src/agent/agentLoop.ts`. Find the validator-replay logic — the loop that fires when `validateResponse` returns `ok: false`. Confirm:
- HOW does the replay re-prompt the model? (System message addition? User message addition? Modified assistant draft?)
- Is the validator's `detail` text (which contains phrases like "Number '8' appears in the reply but does not appear verbatim…") passed verbatim to the model in any form that the model could echo?

Then read `apps/web/app/chat/page.tsx` to confirm the `case "thinking"` and `case "token"` handlers only render data the engine emits — not synthetic content.

If (a): replay correction is being injected as assistant text. Fix in `agentLoop.ts`: switch to system-message injection so the model treats it as a directive, not content to echo.

If (b): the model's thinking on replay genuinely contains validator phrasing. Fix is harder — either (i) suppress replay-turn `thinking_delta` events from reaching the SSE writer, or (ii) accept that thinking-text on replay will reference the correction (it's actually useful debugging info) and let the user see it. Recommend (i) — the user shouldn't have to see internal validator monologue.

Document which case applies in your report, then proceed with the appropriate fix below.

- [ ] **Step 2: Write the failing test**

Create `packages/engine/tests/agent/validatorMessageLeak.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
// Mock the LLM client so we can drive a validator-replay scenario
// deterministically. The test asserts that on a replay, the user-
// facing text/thinking deltas do NOT contain phrases like
// "the validator is catching" / "ungrounded_number" / "the
// validator is right".

import { runAgentTurnStreaming } from "../../src/agent/agentLoop";

describe("validator-replay messages do not leak into user-facing content", () => {
    it("on replay, no text_delta / thinking_delta event contains 'the validator is' phrasing", async () => {
        // ... build a minimal session + a fake LLM client that
        // emits a "bad" first answer (triggers a validator violation)
        // followed by a "good" replay answer whose thinking text
        // contains "The validator is catching..." monologue.
        //
        // Drive runAgentTurnStreaming and collect every text_delta
        // and thinking_delta event. Assert NONE of them contain
        // substrings like:
        //   /the validator is catching/i
        //   /ungrounded_number/
        //   /the validator (is|caught|flagged)/i
        //
        // The expected behavior depends on the diagnosis from Step 1:
        // - If we suppress replay thinking events: assert no
        //   thinking_delta events fire on replay turns.
        // - If we re-prompt via system message and the model
        //   stops echoing: assert the validator phrasing simply
        //   doesn't appear in the deltas.

        // Test scaffold — adapt to actual LLM client mock signature
        // and runAgentTurnStreaming arguments. The principle is:
        // simulate a replay scenario, collect deltas, assert no
        // validator-internal phrasing leaks.
        expect(true).toBe(true); // placeholder; implementer replaces
    });
});
```

The test scaffold above is intentionally a stub because the exact mock-shape for `runAgentTurnStreaming` depends on the existing test patterns (look at `packages/engine/tests/eval/agentLoopStreaming.test.ts` for an example). The implementer fills in the scaffold with a working mock.

- [ ] **Step 3: Implement the fix per Step 1's diagnosis**

If diagnosis is (a) — assistant-message injection:
Find the replay-loop's re-prompt construction in `agentLoop.ts`. Switch from injecting the correction as a `role: "assistant"` message to a `role: "user"` message with prefix `[validator]:` OR — better — pass the correction as part of the `system` field on the next `streamComplete` call. The model treats system-text as instructions, not content to echo.

If diagnosis is (b) — thinking text references validator:
In `agentLoop.ts`'s `runOneTurn`, track an `isReplayTurn: boolean` flag. When set, suppress `thinking_delta` yields:

```typescript
} else if (ev.type === "thinking_delta" && !isReplayTurn) {
    yield { type: "thinking_delta", text: ev.text };
}
```

The user still sees the corrected answer, just without the noisy self-correction monologue.

- [ ] **Step 4: Run the test + engine suite**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/validatorMessageLeak.test.ts`
Expected: PASS.

Then: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: 733 + N (test count for this file) pass.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agent/agentLoop.ts packages/engine/tests/agent/validatorMessageLeak.test.ts
git commit -m "fix(engine): validator-replay messages stay system-side, never user-visible"
```

---

## Task 4: Wire `completenessReviewer.ts` into the v2 route (Issues #7, #8 from audit)

**Files:**
- Modify: `apps/web/app/api/chat/v2/route.ts`
- Read-only reference: `packages/engine/src/agent/completenessReviewer.ts`, `tools/cohort-eval/runPhase10MethodB.ts` (for usage pattern)

`completenessReviewer.ts` is already implemented and tested — it just never reached the production v2 route. Wire it in alongside `validateResponse`. On fail, replay using the same loop the validator uses.

- [ ] **Step 1: Read the existing implementation**

Read:
- `packages/engine/src/agent/completenessReviewer.ts` — note the export name (`reviewCompleteness` or similar), the input shape, and the verdict shape.
- `tools/cohort-eval/runPhase10MethodB.ts` — see how it's currently called. What context does it expect?

Confirm the function signature is something like:

```typescript
export function reviewCompleteness(ctx: {
    assistantText: string;
    invocations: ToolInvocation[];
    userQuestion: string;
}): { ok: boolean; missingPieces: string[] } | similar
```

If the function REQUIRES inputs the v2 route doesn't currently provide, decide whether to add them at the call site or to extend `completenessReviewer.ts` with a simpler-input variant.

- [ ] **Step 2: Wire the call into `route.ts`**

Find where `validateResponse` is called (around line ~573 in `route.ts`). Immediately AFTER it, add a `reviewCompleteness` call:

```typescript
const verdict = validateResponse({ ... });
const completenessVerdict = reviewCompleteness({
    assistantText: finalResult.finalText,
    invocations: finalResult.invocations,
    userQuestion: userMessage,
});

// Combined fail-out logic: if either fails, replay.
if (!verdict.ok || !completenessVerdict.ok) {
    // Existing replay logic, extended with completeness violations.
    const allViolations = [
        ...verdict.violations,
        ...(completenessVerdict.ok ? [] : completenessVerdict.missingPieces.map(p => ({
            kind: "incompleteness" as const,
            detail: p,
        }))),
    ];
    // ... pass allViolations to the replay path
}
```

The exact integration depends on how `validateResponse`'s replay works today. If the v2 route simply emits `validator_block` events on fail and doesn't replay, then `reviewCompleteness` should plug into the same surface — emit a `validator_block` with the missing-pieces detail.

- [ ] **Step 3: Add an `incompleteness` `ViolationKind` if needed**

If `completenessReviewer`'s verdict shape doesn't already use the `Violation` type, either:
- Adapt its output shape to match `Violation[]` (add a `incompleteness` kind to `ViolationKind`).
- OR keep it separate and emit a distinct SSE event kind.

Recommend the first — single rule-violation surface is easier for the chat page to render.

- [ ] **Step 4: Test the wiring**

The unit tests for `completenessReviewer` already exist. The new integration test should assert that the v2 route emits `validator_block` for completeness failures. Add a test in `apps/web/tests/chatV2Route.test.ts`:

```typescript
it("emits validator_block when completenessReviewer flags a missing piece", async () => {
    // Mock the engine to return an answer that fails completeness
    // (e.g. user asked "plan for 16 credits", agent delivered 8).
    // Assert the SSE stream contains a `validator_block` event with
    // an "incompleteness" violation kind.
    // ... fill in scaffold to match existing test patterns
});
```

- [ ] **Step 5: Run tests**

From repo root: `node_modules/.bin/vitest run`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/api/chat/v2/route.ts packages/engine/src/agent/responseValidator.ts apps/web/tests/chatV2Route.test.ts
git commit -m "feat(web): wire completenessReviewer into v2 route"
```

---

## Task 5: `getCreditCaps` — drop validateInput rejection, return data + suggestedFollowUp (Issues #1, #11)

**Files:**
- Modify: `packages/engine/src/agent/tools/getCreditCaps.ts`
- Create: `packages/engine/tests/agent/getCreditCapsRefactor.test.ts`

Currently `getCreditCaps.validateInput` rejects when DPR is loaded with the message "DPR is loaded — credit budgets come from run_full_audit's dprCumulative output. For F-1 minimum-credit-load... ALSO call search_policy." This causes:
1. The agent's first reasoning iteration plans `get_credit_caps`; the tool refuses; the model retries with `search_policy`. Two iterations, conflicting reasoning shown to user.
2. The rejection text leaks to the user as a tool-trace entry (`⚠ Checked credit caps — validation failed: DPR is loaded…`).

Fix: drop the rejection. `getCreditCaps` always runs. When DPR is loaded, the result envelope includes a `suggestedFollowUp: { tool: "search_policy", args: {...}, why: "F-1 / per-semester-ceiling questions live in the bulletin" }` so the agent knows to chain. The system prompt rule #6 already mandates surfacing `suggestedFollowUps`.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/getCreditCapsRefactor.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { getCreditCapsTool } from "../../src/agent/tools/getCreditCaps";

function fakeSession(opts: { dprLoaded: boolean }) {
    return {
        student: { studentId: "t", homeSchoolId: "cas", declaredPrograms: [], visaStatus: "f1", transcript: { semesters: [] }, plans: [], expectedGraduationTerm: undefined },
        schoolConfig: { schoolId: "cas", maxCreditsPerSemester: 18, f1FullTimeMinCredits: 12 },
        programs: new Map(),
        dpr: opts.dprLoaded ? { /* minimal DPR */ } : undefined,
    };
}

describe("getCreditCaps refactor", () => {
    it("validateInput accepts the call even when DPR is loaded (no rejection)", () => {
        const session = fakeSession({ dprLoaded: true });
        const result = getCreditCapsTool.validateInput!({} as any, session as any);
        expect(result.ok).toBe(true);
    });

    it("emits a suggestedFollowUp pointing at search_policy when DPR is loaded", async () => {
        const session = fakeSession({ dprLoaded: true });
        const result = await getCreditCapsTool.call!({} as any, session as any);
        // Result envelope must carry a suggestedFollowUp pointing at search_policy.
        expect(result.suggestedFollowUps).toBeDefined();
        const policyFollowUp = result.suggestedFollowUps?.find((f: any) => f.tool === "search_policy");
        expect(policyFollowUp).toBeDefined();
        expect(policyFollowUp.why?.toLowerCase()).toContain("policy");
    });

    it("returns the actual school + visa caps in the data payload", async () => {
        const session = fakeSession({ dprLoaded: true });
        const result = await getCreditCapsTool.call!({} as any, session as any);
        expect(result.maxCreditsPerSemester).toBe(18);
        expect(result.f1FullTimeMinCredits).toBe(12);
    });
});
```

Adapt the test to the actual `getCreditCaps` API (envelope shape, `suggestedFollowUps` field name, etc.). Read the file first.

- [ ] **Step 2: Run test to verify failure**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/getCreditCapsRefactor.test.ts`
Expected: FAIL on test 1 (current rejection); FAIL on test 2 (no suggestedFollowUp).

- [ ] **Step 3: Refactor `getCreditCaps.ts`**

Open `packages/engine/src/agent/tools/getCreditCaps.ts`. Find the `validateInput` block:

```typescript
validateInput(input, session) {
    if (session.dpr) {
        return {
            ok: false,
            userMessage: "DPR is loaded — credit budgets come from run_full_audit's dprCumulative output. For F-1 minimum-credit-load, per-semester ceiling, or overload questions: ALSO call search_policy with the user's question (the bulletin + curated F-1/credit-load templates are there). Do NOT respond with only this refusal — the student needs an actual answer; this tool just isn't the right source.",
        };
    }
    return { ok: true };
},
```

Replace with `return { ok: true };` always. Drop the rejection entirely.

Then in the `call` (or `run`) function — where the tool actually executes — append a `suggestedFollowUps` entry to the result envelope:

```typescript
async call(input, session) {
    const cfg = session.schoolConfig;
    const result: GetCreditCapsResult = {
        schoolId: cfg.schoolId,
        maxCreditsPerSemester: cfg.maxCreditsPerSemester,
        f1FullTimeMinCredits: cfg.f1FullTimeMinCredits,
        // ... other fields
    };

    // Phase 12.5 Task 5 — when DPR is loaded, the bulletin / OGS
    // policy text is the authoritative source for F-1 floor and
    // credit-cap *explanations* (this tool returns the numbers,
    // but bulletin language carries the policy detail). Suggest
    // a follow-up so the agent chains automatically.
    if (session.dpr) {
        result.suggestedFollowUps = [
            ...(result.suggestedFollowUps ?? []),
            {
                tool: "search_policy",
                args: { query: "F-1 full-time minimum credit-load policy" },
                why: "Bulletin + OGS policy text covers F-1 minimum, RCL, and per-semester ceiling questions in detail. This tool returned the numeric caps; search_policy provides the policy reasoning.",
            },
        ];
    }

    return result;
},
```

Adapt to the actual result-envelope type (`GetCreditCapsResult` may be named differently, `suggestedFollowUps` may be `suggestedFollowups` or `followUps`, etc.). Read the existing `Tool` interface and result types in `packages/engine/src/agent/tool.ts` to confirm field naming.

- [ ] **Step 4: Run tests**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/getCreditCapsRefactor.test.ts`
Expected: 3/3 PASS.

Then full suite: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: all pass. If existing fixtures asserted on the rejection behavior, update them.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agent/tools/getCreditCaps.ts packages/engine/tests/agent/getCreditCapsRefactor.test.ts
git commit -m "fix(engine): getCreditCaps returns data + suggestedFollowUp instead of rejecting"
```

---

## Task 6: Manual browser verification + final push

**Files:** none (verification step)

- [ ] **Step 1: Refresh the dev server**

`http://localhost:3001` — HMR picks up the new bundle.

- [ ] **Step 2: Verify quantitative_shortfall + completeness rules (Tasks 1, 4)**

Send: **"plan for courses of 16 credits in total"** in a context where the planner can only deliver fewer (e.g. forcefully constrain `maxCourses: 1` somehow if you can; OR rely on the existing plan delivering 16 credits if Task 5 of Phase 12 worked).

Expected:
- If the planner can deliver 16 → answer delivers 16, no shortfall warning fires.
- If the planner can't fill → answer EITHER delivers what it can with explicit "could not fill" acknowledgement, OR the validator-replay loop re-prompts the agent to do another iteration (e.g. call `search_courses` for electives) before answering.
- The agent NEVER ends with "what would you like to do?" after a partial delivery.

- [ ] **Step 3: Verify user-number grounding (Task 2)**

Send: **"plan for 5 electives next semester"** in a context where the agent might ask a clarifying question that quotes "5" back.

Expected:
- The agent's clarifying response (if any) freely uses "5" without triggering an `ungrounded_number` violation.
- No `validator_block` appears in the SSE stream for this number.

- [ ] **Step 4: Verify validator-message-leak fix (Task 3)**

Send a question deliberately constructed to trigger a validator violation (e.g. ask something that requires a tool call but produce a reply that refers to a number not in any tool result). Watch for replay behavior.

Expected:
- The user-facing text never contains "The validator is catching", "ungrounded_number", "validator is right", or similar internal phrasing.
- The corrected answer reads as a clean assistant reply.

- [ ] **Step 5: Verify getCreditCaps refactor (Task 5)**

Send: **"What's NYU's F-1 credit floor?"**

Expected:
- The agent's reasoning trace shows ONE coherent flow: `Looking up policy…` directly (not "Checked credit caps — validation failed: DPR is loaded…" then re-routing).
- If the agent calls `getCreditCaps` first, the tool succeeds (no rejection in the trace), AND the agent sees the `suggestedFollowUp` and chains to `search_policy`.
- The `⚠ Checked credit caps — validation failed: …` red entry from prior runs is GONE.

- [ ] **Step 6: Verify all Phase 12 wins still pass**

Re-run the same 3 questions from Phase 12's Task 6 verification:
- "What's NYU's F-1 credit floor for international students?"
- "plan for courses of 16 credits in total" with `graduationTerm: 2027-spring`
- Citation labels still show "NYU CAS F-1 Full-Time Minimum Credit Policy", not the JSON pointer.

Expected: all Phase 12 behaviors preserved.

- [ ] **Step 7: Push**

```bash
git push
```

- [ ] **Step 8: Tear-off note**

```
Phase 12.5 (validator hardening + getCreditCaps refactor) shipped:
- quantitative_shortfall validator rule catches "asked N, delivered
  M < N" patterns generically (any unit, any quantity).
- Grounding validator now accepts numbers from userQuestion as
  legitimately grounded — no more false-positives on user-quote-back.
- Validator-replay messages stay system-side; user-facing chat no
  longer leaks the model's self-correction monologue.
- completenessReviewer.ts wired into the v2 route — incompleteness
  triggers replay alongside validator violations.
- getCreditCaps no longer rejects when DPR is loaded. Returns the
  numeric caps + a suggestedFollowUp pointing at search_policy.
  Reasoning trace is now ONE coherent flow per turn.

Open issues from Phase 11.2 / Phase 12 / Phase 12.5 audits all closed
except #1's UI half (iteration-aware reasoning trace UI deferred to
Phase 13). Production-ready.
```

---

## Self-review notes

**Spec coverage:**
- Issue #1 (audit) — `getCreditCaps` reject-and-reroute → Task 5 closes the engine-layer half. UI iteration-aware trace is Phase 13.
- Issue #7 (audit) — validator gaps for reasoning-vs-action → Tasks 1, 4 (quantitative + completeness).
- Issue #8 (audit) — punt instead of complete → Tasks 1, 4 close generically.
- Issue #9 (Phase 12 verification) — user-supplied numbers → Task 2.
- Issue #10 (Phase 12 verification) — validator messages leaking → Task 3.
- Issue #11 (Phase 12 verification) — same as #1 → closed by Task 5.

**Generality:**
- `quantitative_shortfall` matches `\b\d+\s+(credits?|courses?|electives?|...)\b` — generic across all unit-quantity asks; not a per-case keyword rule.
- User-number grounding is a structural change (extending the allow-set) — applies to ALL future numbers the user types.
- Validator-message-leak fix is a system-vs-user-message channel discipline; works for ANY future validator rule.
- `getCreditCaps` refactor is a tool-design improvement — applies regardless of which question triggers the call.

**Tradeoffs accepted:**
- `quantitative_shortfall` is regex-based pattern matching, but the regex matches GENERAL structure (number + unit-keyword), not a specific phrase. Adding a unit (e.g. "modules") is one-line.
- The `SHORTFALL_ACKNOWLEDGEMENTS` list IS slightly per-phrase, but each entry captures a distinct semantic acknowledgment — and these are all phrases the AGENT writes (not user-input), so the agent's own training/prompt determines the surface area.
- Task 3's diagnosis-then-fix shape is unusual for a plan; we don't know which leak path is at fault until the implementer reads the code. Both paths have a clear fix.

**No placeholders:**
- Every test has a real body or a clearly-marked scaffold with an explicit fill-in instruction.
- Every code change shows the full before/after.
- The Task 4 "missing pieces" wiring depends on the existing `completenessReviewer` API — implementer reads it first.
