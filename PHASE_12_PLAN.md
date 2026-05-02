# Phase 12 — Cheap Wins from Operator Test Pass 3

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship five low-risk, high-leverage fixes surfaced by the third operator test pass: citation-formatter for source labels, restored tool-call timeline UI, fixed planner credit-fill regression + `targetCredits` semantics, required `programId` in `plan_semester`, and an `identity_drift` validator rule. The verifier-subagent architectural fix (`completenessReviewer` wiring + iteration-aware reasoning trace) is deferred to Phase 12.5.

**Architecture:** Five orthogonal fixes across the engine and web layers. None depend on a new subagent or new SSE events. Each task ships as one commit. The fixes are landed in dependency order: citation labels (no deps) → identity-drift rule (no deps) → tool-timeline UI (no deps) → `programId` required (planSemester.ts) → credit-fill regression fix (same file). The plan respects the user's `feedback_general_fixes_only.md` memory — every fix generalizes; no per-case prompt rules or keyword blacklists.

**Tech Stack:** TypeScript, Zod schemas, vitest, Next.js 16 App Router, React. Engine-side: `packages/engine/src/agent/`. Web-side: `apps/web/app/chat/`.

**Out of scope (Phase 12.5):**
- Verifier subagent dispatch (claude-code-leak's `verificationAgent.ts` clone)
- Wiring `completenessReviewer.ts` into the v2 route
- `quantitative_shortfall` validator rule (counts user-quantity vs. answer-quantity)
- Iteration-aware reasoning trace UI (group `thinking_delta` events by agent-loop iteration)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/engine/src/agent/citationLabels.ts` | **Create** | Map internal pointers (`data/schools/cas.json#f1FullTimeMinCredits`) to user-facing labels ("NYU CAS F-1 Full-Time Minimum Policy"). Single `formatCitation(pointer): string` export. |
| `packages/engine/src/agent/verifiers/planFeasibility.ts` | **Modify** | Replace inlined `Source: data/schools/...json#...` strings with `formatCitation()` calls. |
| `packages/engine/tests/agent/citationLabels.test.ts` | **Create** | Unit tests: known mappings, unknown-pointer fallback, all currently-leaked pointers covered. |
| `packages/engine/src/agent/responseValidator.ts` | **Modify** | Add `identity_drift` to `ViolationKind` union. Add a structural check that fires when assistant text contains first-person-third-party patterns (`call me`, `email me`, etc., where the agent IS the assistant). |
| `packages/engine/tests/agent/identityDrift.test.ts` | **Create** | Unit tests: catches "Call me and I'll suggest electives", "Email me with your decision", but does NOT fire on legitimate first-person ("I'll suggest", "I can help"). |
| `apps/web/app/chat/page.tsx` | **Modify** | Inside the post-completion expanded reasoning panel, render `msg.toolStatuses[]` as a `<ul>` ALONGSIDE the thinking prose (not instead of). |
| `packages/engine/src/agent/tools/planSemester.ts` | **Modify** | (a) Mark `programId` required in the Zod schema; default in `validateInput` when student has exactly one declared program. (b) Make the DPR primary path consume `programId` (filter requirements to the requested program). (c) Drop the `semestersUntilGrad > 1` gate in the free-elective fill block. (d) Add `targetCredits` semantics: when `maxCredits` is set as a target, fill remaining capacity with free electives until reached; emit `couldNotFillCredits` envelope warning when target unreachable. |
| `packages/engine/tests/agent/planSemesterCreditFill.test.ts` | **Create** | Unit tests: final-semester elective fill works, programId is required + auto-defaults, targetCredits delivers requested credits or warns. |

---

## Task 1: Citation formatter — stop leaking JSON pointers to students

**Files:**
- Create: `packages/engine/src/agent/citationLabels.ts`
- Create: `packages/engine/tests/agent/citationLabels.test.ts`
- Modify: `packages/engine/src/agent/verifiers/planFeasibility.ts:78,94`

The `planFeasibility` verifier currently builds `Source: data/schools/cas.json#f1FullTimeMinCredits` strings that flow verbatim into `disclaimers[].text`, which the system prompt's rule #6 instructs the agent to surface. The student sees a filesystem path. The fix is a pure-data label table, mapped at render time.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/citationLabels.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { formatCitation } from "../../src/agent/citationLabels";

describe("formatCitation", () => {
    it("maps the F-1 floor pointer to a user-facing label", () => {
        expect(formatCitation("data/schools/cas.json#f1FullTimeMinCredits"))
            .toBe("NYU CAS F-1 Full-Time Minimum Credit Policy");
        expect(formatCitation("data/schools/stern.json#f1FullTimeMinCredits"))
            .toBe("NYU Stern F-1 Full-Time Minimum Credit Policy");
    });

    it("maps the per-semester ceiling pointer to a user-facing label", () => {
        expect(formatCitation("data/schools/cas.json#maxCreditsPerSemester"))
            .toBe("NYU CAS Per-Semester Credit Ceiling");
        expect(formatCitation("data/schools/stern.json#maxCreditsPerSemester"))
            .toBe("NYU Stern Per-Semester Credit Ceiling");
    });

    it("falls back to a generic label for unknown pointers", () => {
        expect(formatCitation("data/schools/unknown.json#mysteryField"))
            .toBe("NYU policy reference");
        expect(formatCitation("totally/unrelated/path.json"))
            .toBe("NYU policy reference");
    });

    it("never returns a string containing a filesystem path", () => {
        const labels = [
            formatCitation("data/schools/cas.json#f1FullTimeMinCredits"),
            formatCitation("data/schools/cas.json#maxCreditsPerSemester"),
            formatCitation("data/schools/stern.json#f1FullTimeMinCredits"),
            formatCitation("data/schools/unknown.json#mysteryField"),
        ];
        for (const label of labels) {
            expect(label, `leaked path in: ${label}`).not.toMatch(/\.json/);
            expect(label, `leaked path in: ${label}`).not.toMatch(/\//);
            expect(label, `leaked path in: ${label}`).not.toMatch(/#/);
        }
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/citationLabels.test.ts`
Expected: FAIL with `Cannot find module '../../src/agent/citationLabels'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/engine/src/agent/citationLabels.ts`:

```typescript
/**
 * Maps internal JSON-pointer-style references (e.g.
 * `data/schools/cas.json#f1FullTimeMinCredits`) to user-facing
 * labels. Used by verifiers and tools to keep filesystem paths and
 * config-key names out of student-facing output.
 *
 * The mapping is pattern-based (not a literal table) so a new
 * school config picks up labels automatically: `cas` → "NYU CAS",
 * `stern` → "NYU Stern", `tisch` → "NYU Tisch", etc.
 */

const SCHOOL_DISPLAY_NAMES: Record<string, string> = {
    cas: "NYU CAS",
    stern: "NYU Stern",
    tisch: "NYU Tisch",
    tandon: "NYU Tandon",
    steinhardt: "NYU Steinhardt",
    silver: "NYU Silver",
    gallatin: "NYU Gallatin",
};

const FIELD_DISPLAY_NAMES: Record<string, string> = {
    f1FullTimeMinCredits: "F-1 Full-Time Minimum Credit Policy",
    maxCreditsPerSemester: "Per-Semester Credit Ceiling",
    minGraduationCredits: "Minimum Credits for Graduation",
};

const FALLBACK_LABEL = "NYU policy reference";

const POINTER_RE = /^data\/schools\/([a-z]+)\.json#(\w+)$/;

export function formatCitation(pointer: string): string {
    const match = pointer.match(POINTER_RE);
    if (!match) return FALLBACK_LABEL;
    const [, schoolKey, fieldKey] = match;
    const schoolLabel = SCHOOL_DISPLAY_NAMES[schoolKey];
    const fieldLabel = FIELD_DISPLAY_NAMES[fieldKey];
    if (!schoolLabel || !fieldLabel) return FALLBACK_LABEL;
    return `${schoolLabel} ${fieldLabel}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/citationLabels.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Wire `formatCitation` into `planFeasibility.ts`**

Open `packages/engine/src/agent/verifiers/planFeasibility.ts`. Add the import at the top with the other engine imports:

```typescript
import { formatCitation } from "../citationLabels.js";
```

Find line ~78 (the `maxCreditsPerSemester` violation message). Replace the segment that reads:

```typescript
                    `Source: data/schools/${input.schoolConfig.schoolId}.json#maxCreditsPerSemester. ` +
```

with:

```typescript
                    `Source: ${formatCitation(`data/schools/${input.schoolConfig.schoolId}.json#maxCreditsPerSemester`)}. ` +
```

Find line ~94 (the `f1FullTimeMinCredits` violation message). Replace:

```typescript
                    `Source: data/schools/${input.schoolConfig.schoolId}.json#f1FullTimeMinCredits. ` +
```

with:

```typescript
                    `Source: ${formatCitation(`data/schools/${input.schoolConfig.schoolId}.json#f1FullTimeMinCredits`)}. ` +
```

- [ ] **Step 6: Type-check + run engine tests**

From repo root:

```bash
cd packages/engine && npx tsc --noEmit
node_modules/.bin/vitest run packages/engine/tests/
```

(Run vitest from repo root.) Expected: type-check passes; engine tests pass (709/709 plus 4 new).

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/agent/citationLabels.ts packages/engine/tests/agent/citationLabels.test.ts packages/engine/src/agent/verifiers/planFeasibility.ts
git commit -m "fix(engine): formatCitation maps internal JSON pointers to user-facing labels"
```

---

## Task 2: `identity_drift` validator rule — catch "Call me and I'll suggest"

**Files:**
- Modify: `packages/engine/src/agent/responseValidator.ts`
- Create: `packages/engine/tests/agent/identityDrift.test.ts`

The agent IS the assistant. Phrasing like "Call me and I'll suggest electives", "Email me with your decision", "Reply to me when you've decided" is a structural identity-drift bug. We add a `ViolationKind` of `identity_drift` and a regex-based check. Per the user's `feedback_general_fixes_only.md` memory, this is NOT a per-case keyword blacklist — it's a structural property check (agent must not refer to itself in the third person as a contactable entity).

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/identityDrift.test.ts`:

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

describe("identity_drift validator rule", () => {
    it("flags 'Call me and I'll suggest' as identity drift", () => {
        const verdict = validateResponse({
            assistantText: "Sure! Call me and I'll suggest electives that fit.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "what electives should I take?",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(true);
    });

    it("flags 'Email me with your decision' as identity drift", () => {
        const verdict = validateResponse({
            assistantText: "Email me with your decision and we'll move forward.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "what should I do?",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(true);
    });

    it("flags 'Reply back to me' as identity drift", () => {
        const verdict = validateResponse({
            assistantText: "Reply back to me when you've thought it over.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "anything else?",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(true);
    });

    it("does NOT flag legitimate first-person assistant phrasing", () => {
        const verdict = validateResponse({
            assistantText: "I'll suggest some electives. Let me know which sound interesting and I can pull more details.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "what electives should I take?",
        });
        // No identity_drift violation. (Other violations may fire from other
        // rules — we only assert this specific kind is absent.)
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(false);
    });

    it("does NOT flag a student-directed 'call' that has nothing to do with the agent", () => {
        // E.g. NYU's own help-desk number. The phrase doesn't put the agent
        // in the third-party-contactable role.
        const verdict = validateResponse({
            assistantText: "If you need a Reduced Course Load, call OGS at 212-998-4720.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "can I take fewer credits?",
        });
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/identityDrift.test.ts`
Expected: FAIL — the new `identity_drift` violation doesn't exist yet, so the first three tests fail.

- [ ] **Step 3: Add the violation kind + check to `responseValidator.ts`**

Open `packages/engine/src/agent/responseValidator.ts`. Find the `ViolationKind` union (line ~30). Append `| "identity_drift"`:

```typescript
export type ViolationKind =
    | "ungrounded_number"
    | "missing_invocation"
    | "missing_caveat"
    | "verbatim_drift"
    | "fabricated_attribution"
    | "identity_drift";
```

Just before the existing `validateResponse` function definition (line ~497), add a helper function:

```typescript
/**
 * Catches identity-drift output bugs where the agent refers to
 * itself in the third person as a contactable entity. The agent
 * IS the assistant — phrasings like "call me", "email me", "reply
 * to me" mistakenly cast it as a separate person the user should
 * contact. Phase 12 §6 — generic structural-coherence check, not
 * a keyword blacklist (matches first-person-imperative + third-
 * party-contact-verb structural pattern).
 */
function checkIdentityDrift(assistantText: string): Violation[] {
    const violations: Violation[] = [];
    // The agent should never instruct the user to "call me" /
    // "email me" / "reply to me" / "message me" / "contact me".
    // The trailing word must be "me" or "us" — NOT a third party
    // (so "call OGS" / "email your adviser" pass through).
    const PATTERN = /\b(?:call|email|message|reply\s+(?:back\s+)?(?:to\s+)?|contact|text|reach)\s+(?:back\s+)?(?:to\s+)?(?:me|us)\b/i;
    const match = PATTERN.exec(assistantText);
    if (match) {
        violations.push({
            kind: "identity_drift",
            detail:
                `Identity drift: assistant referred to itself as a contactable third party ` +
                `with the phrase "${match[0]}". The agent is the assistant — there is nothing ` +
                `for the user to "contact". Rephrase as a direct first-person commitment ` +
                `("I'll suggest electives in the next message") or as a concrete tool the ` +
                `user can take action on.`,
        });
    }
    return violations;
}
```

In the body of `validateResponse` (line ~497), find the section that aggregates violations from each check. After the existing checks complete (e.g., `violations.push(...checkGrounding(...))`), add:

```typescript
    violations.push(...checkIdentityDrift(ctx.assistantText));
```

Verify by grep that the call is in place:

```bash
grep -n "checkIdentityDrift" packages/engine/src/agent/responseValidator.ts
```

Expected: two hits — one definition, one call.

- [ ] **Step 4: Run test to verify it passes**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/identityDrift.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Run the full validator + engine suite**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: 709 + 4 (Task 1) + 5 (Task 2) = 718 pass. If any existing test fixtures contain phrases like "call me" in their `assistantText`, they may need updating — note if any do.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/responseValidator.ts packages/engine/tests/agent/identityDrift.test.ts
git commit -m "fix(engine): identity_drift validator rule catches third-party contactable phrasing"
```

---

## Task 3: Restore tool-call timeline UI in the post-completion expanded panel

**Files:**
- Modify: `apps/web/app/chat/page.tsx` (rendering of the reasoning body)

The post-completion expanded "Reasoned for Xs ▾" panel currently renders only `thinkingText.split("\n\n")` paragraphs. The `toolStatuses[]` data is still in state but no JSX consumes it. Restore a `<ul>` rendering of the tool list as a sibling of the thinking prose — both signals always visible together.

- [ ] **Step 1: Locate the reasoning body JSX**

Open `apps/web/app/chat/page.tsx`. Search for the existing reasoning-body block (it renders the `thinkingText` paragraphs and lives inside the `expanded && hasAnyThought` conditional). Find the block that begins with something like:

```typescript
{expanded && hasAnyThought && (
    <div
        id={`reasoning-${msg.id}`}
        className={styles.reasoningBody}
    >
        {visibleThought.split("\n\n").map((para, idx) => (
            <p key={idx} className={styles.reasoningParagraph}>
                {para}
                ...
            </p>
        ))}
    </div>
)}
```

Use grep to anchor:

```bash
grep -n "reasoningBody\|visibleThought" apps/web/app/chat/page.tsx
```

- [ ] **Step 2: Add the tool-list rendering**

Inside the `<div className={styles.reasoningBody}>` block, AFTER the existing `<p>` paragraphs map, append a tool-status list. The list renders only when `msg.toolStatuses && msg.toolStatuses.length > 0` (welcome message and v1 turns won't have any).

Replace the existing `<div className={styles.reasoningBody}>` block with:

```typescript
                                            <div
                                                id={`reasoning-${msg.id}`}
                                                className={styles.reasoningBody}
                                            >
                                                {visibleThought.split("\n\n").map((para, idx) => (
                                                    <p key={idx} className={styles.reasoningParagraph}>
                                                        {para}
                                                        {inFlight && idx === visibleThought.split("\n\n").length - 1 && (
                                                            <span className={styles.reasoningCaret} aria-hidden="true" />
                                                        )}
                                                    </p>
                                                ))}
                                                {msg.toolStatuses && msg.toolStatuses.length > 0 && (
                                                    <ul className={styles.reasoningToolList}>
                                                        {msg.toolStatuses.map((t, idx) => (
                                                            <li key={idx} className={styles.reasoningToolItem}>
                                                                <span className={styles.reasoningToolIcon}>
                                                                    {t.state === "running" ? "•" : t.state === "error" ? "⚠" : "✓"}
                                                                </span>
                                                                <span className={styles.reasoningToolText}>
                                                                    {getPastVerb(t.toolName)}
                                                                    {t.error ? ` — ${t.error}` : ""}
                                                                </span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
```

The `getPastVerb` import already exists at the top of the file from Task 4 of the prior plan.

- [ ] **Step 3: Add the matching CSS**

Open `apps/web/app/chat/chat.module.css`. At the end of the file, append:

```css
/* ---------- Reasoning panel — tool-list (Phase 12 Task 3) ---------- */
.reasoningToolList {
    list-style: none;
    margin: 12px 0 0 0;
    padding: 8px 12px 4px 12px;
    border-top: 1px dashed var(--border-light);
}

.reasoningToolItem {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
    line-height: 1.45;
    font-size: 0.85em;
    color: var(--text-secondary);
}

.reasoningToolIcon {
    flex: 0 0 auto;
    width: 14px;
    text-align: center;
    opacity: 0.7;
}

.reasoningToolText {
    flex: 1 1 auto;
}
```

- [ ] **Step 4: Type-check the web app**

From `apps/web/`:

```bash
npx tsc --noEmit 2>&1 | grep "page\.tsx\|chat\.module" | head -10
```

Expected: zero new errors in those files. (Pre-existing errors in unrelated files are acceptable.)

- [ ] **Step 5: Run web tests**

From repo root: `node_modules/.bin/vitest run apps/web/tests/`
Expected: 65/65 pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/chat/page.tsx apps/web/app/chat/chat.module.css
git commit -m "feat(web): restore tool-call timeline in the post-completion reasoning panel"
```

---

## Task 4: `programId` required + DPR path consumes it

**Files:**
- Modify: `packages/engine/src/agent/tools/planSemester.ts`

Today `programId: z.string().optional()` (line 182) and the DPR primary path (lines 227-498) NEVER reads `input.programId` — only the rare authored-rules fallback uses it. So even when the agent passes the program, the planner ignores it on the DPR path. Fix: tighten the schema to require `programId`, default in `validateInput` when there's exactly one declared program, and have the DPR path filter requirements to that program.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/planSemesterCreditFill.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { planSemesterTool } from "../../src/agent/tools/planSemester";

// We'll add fixtures inline. The test focuses on (a) programId
// required-or-defaulted, (b) DPR-path scope restriction. Task 5
// will extend this file with the credit-fill test.

function fakeSession(opts: { declaredPrograms: string[] }) {
    // Minimal session shape — only the fields planSemester reads.
    // The exact shape is whatever planSemester's `session` arg
    // expects. Adapt below if the type errors point to missing fields.
    return {
        student: {
            studentId: "test",
            homeSchoolId: "cas",
            declaredPrograms: opts.declaredPrograms.map(programId => ({ programId })),
            visaStatus: undefined,
            transcript: { semesters: [] },
            plans: [],
            expectedGraduationTerm: "2027-spring",
        },
        schoolConfig: { schoolId: "cas", maxCreditsPerSemester: 18, f1FullTimeMinCredits: 12 },
        programs: new Map(),
        dpr: undefined,
    };
}

describe("plan_semester programId handling", () => {
    it("validateInput auto-defaults programId when student has exactly one declared program", () => {
        const session = fakeSession({ declaredPrograms: ["computer_science_math"] });
        const result = planSemesterTool.validateInput!(
            { targetSemester: "2027-spring" } as any,
            session as any,
        );
        // validateInput should NOT reject — it should fill programId
        // from the single declared program.
        expect(result.ok).toBe(true);
    });

    it("validateInput rejects when student has multiple declared programs and no programId is passed", () => {
        const session = fakeSession({ declaredPrograms: ["computer_science_math", "music_minor"] });
        const result = planSemesterTool.validateInput!(
            { targetSemester: "2027-spring" } as any,
            session as any,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.message).toMatch(/programId/i);
        }
    });
});
```

If `planSemesterTool.validateInput` returns a different shape (e.g., `{result: false, message}` instead of `{ok, message}`), adapt the test assertions to match the existing convention. Read `packages/engine/src/agent/tool.ts` (or wherever `Tool.validateInput` is typed) to confirm.

- [ ] **Step 2: Run test to verify it fails**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/planSemesterCreditFill.test.ts`
Expected: FAIL — currently `validateInput` doesn't auto-default `programId`, so the second test (multi-program) might pass spuriously while the first (auto-default) fails.

- [ ] **Step 3: Modify `planSemester.ts` schema + validateInput**

Open `packages/engine/src/agent/tools/planSemester.ts`. Find line ~182 (the schema):

```typescript
        programId: z.string().optional()
```

Keep it `.optional()` for backward compatibility with the agent's existing call sites — but defaults it inside `validateInput` (the agent will see the schema description now nudge it to pass).

Find the schema's `programId` line and update its `.describe()` if present, or add one:

```typescript
        programId: z.string().describe("The student's program ID (e.g. 'computer_science_math'). If the student has exactly one declared program, omit this and validateInput will fill it in. If the student has multiple programs, this is REQUIRED — the planner will refuse without it.").optional()
```

Find `validateInput` (around line 200):

```typescript
        if (declared.length === 0 && !input.programId) {
```

Replace the whole `validateInput` block with one that auto-defaults when there's exactly one declared program AND rejects when there are multiple but none passed:

```typescript
    validateInput(input, session) {
        const student = session.student;
        const declared = student?.declaredPrograms ?? [];
        if (!input.programId) {
            if (declared.length === 0) {
                return {
                    ok: false,
                    message:
                        "You haven't declared a program. Either declare one first or pass an explicit programId.",
                };
            }
            if (declared.length === 1) {
                // Auto-default to the single declared program.
                input.programId = declared[0]!.programId;
                return { ok: true };
            }
            return {
                ok: false,
                message:
                    `Student has ${declared.length} declared programs (${declared.map(p => p.programId).join(", ")}) — ` +
                    `pass programId explicitly to scope the plan.`,
            };
        }
        return { ok: true };
    },
```

If the existing `validateInput` shape returns `{result: boolean, message?: string}` instead of `{ok, message}`, mirror the existing convention. The principle: auto-default on single declared, reject on multi-declared-without-programId.

- [ ] **Step 4: Make the DPR primary path consume `programId`**

In `planSemester.ts` find the DPR primary path (starts around line 227, where it walks `notSatisfiedRequirements`). Currently it iterates ALL unsatisfied requirements regardless of which program they belong to. Add a filter step.

Look for the requirement-iteration loop. Just before the loop begins, filter the requirements to those scoped to `input.programId`:

```typescript
            // Phase 12 Task 4 — scope the DPR walk to the requested
            // program so multi-program students get plans for the
            // program they asked about, not the union of all their
            // programs.
            const scopedRequirements = notSatisfiedRequirements.filter(req => {
                // Requirements carry a programId or programReference;
                // the exact field name depends on the DPR shape. Read
                // the data and pick the right key. If the requirement
                // shape lacks any program scope, INCLUDE it (it's
                // school-level, applies to everyone).
                const reqProgramId = (req as { programId?: string }).programId;
                if (!reqProgramId) return true; // school-level requirement
                return reqProgramId === input.programId;
            });
```

Then change the loop to iterate `scopedRequirements` instead of `notSatisfiedRequirements`. The exact field name (`programId` / `programReference` / `programKey`) should be confirmed by reading the DPR-data shape in `data/dpr/*.json` or whichever schema describes it.

If the DPR requirement shape has NO program-scope field, this filter step is a no-op — log a TODO to add scope to the DPR schema and proceed.

- [ ] **Step 5: Run test to verify it passes**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/planSemesterCreditFill.test.ts`
Expected: PASS, both tests.

- [ ] **Step 6: Run full engine suite**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: 718 + 2 (Task 4) = 720 pass. If existing fixtures relied on `programId` being optional and unfilled, they may now break — investigate.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/agent/tools/planSemester.ts packages/engine/tests/agent/planSemesterCreditFill.test.ts
git commit -m "fix(engine): plan_semester auto-defaults programId + DPR path scopes to it"
```

---

## Task 5: Drop `semestersUntilGrad > 1` gate + add `targetCredits` semantics

**Files:**
- Modify: `packages/engine/src/agent/tools/planSemester.ts:387` (and surrounding fill logic)
- Modify: `packages/engine/tests/agent/planSemesterCreditFill.test.ts` (extend with credit-fill tests)

The current free-elective fill block has a `semestersUntilGrad > 1` gate (line 387) that PREVENTS filling on the final semester — exactly the user's case. The comment says "to keep room for free electives" but the gate blocks free electives. This is the Phase 11.2 regression: `f534fcfe` shipped the algorithm but introduced this off-by-one. Plus: when the user asks for "16 credits", `maxCredits` is currently treated as a CEILING, not a TARGET — the planner returns whatever requirements it found and stops. Fix: treat `maxCredits` as a target when explicitly passed; emit a `couldNotFillCredits` warning if unreachable.

- [ ] **Step 1: Extend the test file**

Append two new `it()` blocks to `packages/engine/tests/agent/planSemesterCreditFill.test.ts` (inside the existing `describe`):

```typescript
describe("plan_semester credit-fill semantics", () => {
    it("fills free electives on the final semester (no semestersUntilGrad > 1 gate)", async () => {
        // Set up: student with 2 unmet requirements totaling 8 credits,
        // graduating in the same semester they're planning, asks for 16.
        // Expected: plan delivers 8 credits of required + ~8 credits of
        // free electives = 16 total.
        const session = fakeSession({ declaredPrograms: ["computer_science_math"] });
        // Force semestersUntilGrad === 1 by aligning targetSemester with grad.
        session.student.expectedGraduationTerm = "2027-spring";

        // Stub a DPR with exactly 2 unmet 4-credit requirements.
        // (Adapt to the real fixture-loading pattern in the test file.)
        const result = await planSemesterTool.run!(
            { targetSemester: "2027-spring", maxCredits: 16 } as any,
            session as any,
        );

        const totalPlanned = (result.suggestions ?? []).reduce(
            (sum: number, s: { credits?: number }) => sum + (s.credits ?? 0),
            0
        );

        expect(totalPlanned, `expected 16 credits planned, got ${totalPlanned}`).toBe(16);
    });

    it("emits a couldNotFillCredits envelope warning when maxCredits is unreachable", async () => {
        // Set up: student with no available electives + only 4 credits of
        // unmet requirements, asks for 16. Planner can deliver 4, not 16.
        // Expected: result includes a disclaimer or envelope-warning that
        // the target wasn't reachable.
        const session = fakeSession({ declaredPrograms: ["computer_science_math"] });
        session.student.expectedGraduationTerm = "2027-spring";

        const result = await planSemesterTool.run!(
            { targetSemester: "2027-spring", maxCredits: 16 } as any,
            session as any,
        );

        // Either result.disclaimers, result.envelope.warnings, or some
        // structured-warning field carries a "could not fill" signal.
        const allText = JSON.stringify(result);
        expect(allText.toLowerCase()).toMatch(/could not fill|target.*unreachable|short of/);
    });
});
```

If the test file's existing `fakeSession` doesn't supply enough plumbing for `planSemesterTool.run!(...)` to execute end-to-end, adapt by either (a) reading an existing test that does call `run` and copying its setup, or (b) restructuring the test as a unit test for the fill-helper if one exists. Aim: assert that on the final semester, `maxCredits=16` produces a 16-credit plan when electives are available.

- [ ] **Step 2: Run tests to verify failures**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/planSemesterCreditFill.test.ts`
Expected: the two new tests FAIL — first because the gate skips fill on the final semester; second because no `couldNotFillCredits` signal exists.

- [ ] **Step 3: Drop the `semestersUntilGrad > 1` gate**

In `packages/engine/src/agent/tools/planSemester.ts`, find line 387:

```typescript
            if (remainingBudget >= 4 && hardSuggested >= hardQuotaForThisTerm && semestersUntilGrad > 1) {
```

Replace with:

```typescript
            // Phase 12 Task 5 — drop the `semestersUntilGrad > 1` gate.
            // The original Phase 11.2 fix added it to "keep room for free
            // electives" but the gate did the opposite at the final term:
            // it skipped the fill entirely. The user-facing intent is
            // "fill remaining capacity with free electives" REGARDLESS of
            // how many semesters remain.
            if (remainingBudget >= 4 && hardSuggested >= hardQuotaForThisTerm) {
```

- [ ] **Step 4: Add `couldNotFillCredits` envelope warning**

After the elective-fill loop completes, check whether the total planned credits reached `maxCredits` (when it was explicitly passed). The exact location depends on how `planSemester` builds its return envelope. Look for the place where `result.suggestions` is finalized.

Add a check immediately before returning the result:

```typescript
            // Phase 12 Task 5 — emit a structured warning when the user
            // explicitly requested a credit target we couldn't fill.
            // Generic across all reasons the fill might fall short:
            // unmet requirements + no eligible electives, schedule
            // constraints, etc.
            const totalPlanned = suggestions.reduce(
                (sum, s) => sum + (s.credits ?? 0),
                0
            );
            if (input.maxCredits !== undefined && totalPlanned < input.maxCredits) {
                disclaimers.push({
                    severity: "warning",
                    text:
                        `Could not fill the requested ${input.maxCredits}-credit plan; ` +
                        `delivered ${totalPlanned} credits across ${suggestions.length} ` +
                        `course${suggestions.length === 1 ? "" : "s"}. The student should ` +
                        `either accept the shorter plan or call search_courses to find ` +
                        `additional electives.`,
                    bulletinSource: undefined,
                });
            }
```

If `disclaimers` doesn't already exist as a local accumulator, look for the field on the result envelope (likely `result.disclaimers` or `result.warnings`) and append there. The principle: emit a structured signal that downstream code (validators, agent, UI) can consume.

- [ ] **Step 5: Run tests to verify passes**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/agent/planSemesterCreditFill.test.ts`
Expected: 4/4 PASS.

- [ ] **Step 6: Run full engine suite**

From repo root: `node_modules/.bin/vitest run packages/engine/tests/`
Expected: 720 + 2 (Task 5) = 722 pass. Existing fixtures may have asserted on the old behavior — if any fail, investigate whether they should be updated or kept.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/agent/tools/planSemester.ts packages/engine/tests/agent/planSemesterCreditFill.test.ts
git commit -m "fix(engine): plan_semester fills electives on final semester + warns on unmet target"
```

---

## Task 6: Manual browser verification + final commit

**Files:** none (verification step)

The dev server has HMR — refresh `http://localhost:3001` once after the Task-5 commit so the new bundle hot-reloads.

- [ ] **Step 1: Verify citation labels (Task 1)**

Send a question that triggers the `f1FullTimeMinCredits` violation. Easiest path: ask for a Spring 2027 plan with `graduationTerm: 2027-spring` (your own profile if you've onboarded) and request fewer than 12 credits.

Expected:
- The visa warning still appears.
- The `Source: ...` line reads `Source: NYU CAS F-1 Full-Time Minimum Credit Policy` (or similar).
- NO filesystem path / `.json` / `#field` substring visible to the user.

- [ ] **Step 2: Verify identity-drift validator (Task 2)**

This one's harder to trigger naturally — the validator catches the agent if it produces drift, but the model rarely does. Two options:
- **Option A:** unit-test confidence is enough; check that the agent's recent answers don't contain "call me" / "email me" patterns. If they do, the validator fires and the agent's replay loop self-corrects.
- **Option B:** force a drift by editing a fixture in `packages/engine/tests/agent/identityDrift.test.ts` to confirm the suite passes.

Either way: confirm the test suite passes (Task 2 already does).

- [ ] **Step 3: Verify tool-call timeline UI (Task 3)**

Send any question that triggers tool calls (e.g. "what should I take next semester?"). After the answer arrives, click "Reasoned for Xs ▾".

Expected:
- The thinking prose paragraphs are visible (as before).
- BELOW the prose, separated by a dashed top border, a list of tool calls: `✓ Ran your degree audit`, `✓ Planned a semester`, etc.
- Each tool entry has the past-tense verb from `getPastVerb()`.

- [ ] **Step 4: Verify `programId` defaulting (Task 4)**

Send: **"plan for courses of 16 credits in total"** (the same question that failed in the previous test pass).

Expected:
- The agent's tool call in the engine logs (or DevTools Network EventStream `tool_invocation_start` event) shows `programId: "computer_science_math"` (or whatever the user's primary program is) — the auto-default kicked in.
- If you have multiple declared programs, the agent should ask which one rather than failing silently.

- [ ] **Step 5: Verify credit-fill on final semester (Task 5)**

Send the same question: **"plan for courses of 16 credits in total"** with `graduationTerm: 2027-spring`.

Expected:
- The plan delivers ~16 credits, not 8. (Specifically: 2 unmet requirements + 2 free electives ≈ 16 credits.)
- If electives can't fully fill, the disclaimer reads "Could not fill the requested 16-credit plan; delivered N credits…" — a clear structured warning instead of "What would you like to do?"

- [ ] **Step 6: Document the result**

If all 5 verifications pass, mark Task 6 complete. If any fail, write down what you saw and dispatch a fix subagent for the specific gap before declaring Phase 12 shipped.

- [ ] **Step 7: (If all verifications passed) Push**

```bash
git push
```

- [ ] **Step 8: Tear-off note**

```
Phase 12 (cheap wins) shipped:
- citationLabels.ts maps internal pointers to user-facing labels — no
  more `data/schools/cas.json#...` leaks.
- identity_drift validator rule catches "call me" / "email me" /
  "reply to me" structural patterns.
- Reasoning panel restored: thinking prose + tool-call list both
  visible.
- plan_semester auto-defaults programId from single declared program;
  DPR path scopes requirement walk to it.
- plan_semester fills free electives on the final semester; emits
  a couldNotFillCredits disclaimer when target unreachable.

Phase 12.5 (verifier subagent) not yet shipped — open issues #1, #7,
#8 from the operator audit deferred. Wire completenessReviewer.ts +
add quantitative_shortfall validator + iteration-aware reasoning
trace UI when ready.
```

---

## Self-review notes

**Spec coverage:**
- Issue #2 (tool-call timeline) → Task 3
- Issue #3 (citation leak) → Task 1
- Issue #4 (planner credit fill) → Task 5
- Issue #5 (programId required) → Task 4
- Issue #6 (identity drift) → Task 2
- Issues #1, #7, #8 → DEFERRED to Phase 12.5 (out of scope per the recommendation)

**Generality check:**
- Citation formatter: pattern-based (regex on `data/schools/*.json#field`), not a per-pointer hardcoded list. New schools and fields pick up labels via the small `SCHOOL_DISPLAY_NAMES` / `FIELD_DISPLAY_NAMES` tables.
- Identity-drift rule: structural property check (first-person + third-party-contact-verb), not a keyword blacklist of specific phrases. Catches "call me", "email me", "text me", "reply to me", "contact me" via one regex.
- Tool-call timeline UI: renders for ALL turns with `toolStatuses[]`, not gated on a specific message ID.
- programId auto-default: applies to ALL students with exactly one declared program, not just the test user.
- Credit-fill regression fix: removes a gate that was specifically wrong on the final semester, fix benefits any student in their final term.
- `couldNotFillCredits` warning: applies to ANY case where `maxCredits` is unreachable, not just the operator's specific test.

**Type-consistency:**
- `formatCitation(pointer: string): string` — used identically in tests and `planFeasibility.ts`.
- `ViolationKind` union extension and `checkIdentityDrift` follow the existing pattern (each violation kind has its own `check*` helper that returns `Violation[]`).
- `validateInput` return shape (`{ ok, message }` vs `{ result, message }`) — adapt to whatever the codebase uses; the principle (auto-default on single declared, reject on multi) is invariant.

**No placeholders:**
- Every step has actual code or a concrete command.
- Tests have full bodies.
- Imports are explicit.

**Tradeoffs accepted:**
- The DPR-path filter uses `(req as { programId?: string }).programId` — a runtime cast. Cleaner would be to read the DPR schema and use the typed field, but the cast is the safest minimal change for Phase 12. Phase 12.5 can clean up.
- `programId` schema stays `.optional()` (with auto-default in `validateInput`) rather than required. This keeps the agent's existing call-pattern working — the agent can omit it for single-program students. Stricter schema could break existing reactive-compact paths.
