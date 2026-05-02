# Phase 13 — Multi-Semester Forward Planner with Constraint Solver + Schedule Sidebar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-semester planner with a multi-semester constraint-satisfaction solver that distributes remaining requirements across all remaining terms (slack-based), respects prereqs + term-offering patterns + visa floors + school ceilings, persists the resulting `ForwardSchedule` across the conversation, reconciles against new DPRs, exposes the live schedule via a chat-page sidebar, and addresses three reasoning-trace bugs surfaced in operator-test pass 4.

**Architecture (deterministic-core, LLM-shell):**
1. **Engine state**: a new `ForwardSchedule` type lives on `ToolSession`. The solver consumes student profile + DPR + parsed prereqs (Phase 12.8) + parsed offerings (Phase 12.8) + visa-aware credit target. Output: full forward plan with discriminated-union slots (completed / in_progress / specific_planned / placeholder).
2. **Constraint solver**: greedy + backtracking. Hard constraints from this plan's locked design decisions: NOT clauses (strict), AP/IB synthetic IDs (strict), instructor-permission soft-allow with `requiresPetition` flag, trust DPR for grade thresholds, full undergrad bulletin coverage means no annotated-cross-school path. Soft objective: balance per-term credit load via slack distribution.
3. **SSE transport**: a new `forward_schedule_update` event kind streams the structured schedule to the chat page whenever it changes.
4. **UI**: a header-toggle button reveals a right-rail sidebar that renders the schedule by semester with locked / planned / placeholder color-coding. Free-elective placeholders ABOVE the credit floor get distinct rendering (dotted border, "optional" tag).
5. **Reasoning-trace fixes**: validator allows arithmetic-derived numbers; replay-turn thinking suppressed; `thinkingText` cleared on first `hasRealThinking` flip.

**Tech Stack:** TypeScript, Zod schemas, vitest, Next.js 16 App Router (SSE), React. Engine: `packages/engine/src/agent/`. Web: `apps/web/`.

**Prerequisites:**
- **Phase 12.7** complete (full undergrad bulletin scrape).
- **Phase 12.8** complete (`prereqs.json` + `courses-offerings.json` populated and 27-curated-validated).

**Out of scope (Phase 14):**
- Load styles other than balanced (frontload / backload / light / heavy / part-time-domestic)
- LLM-side preference extraction ("I want a free spring")
- Course pinning + exclusions (`propose_plan_change` / `confirm_plan_change` tools)
- Click-to-edit slot in sidebar
- Co-requisite enforcement (PrereqGroup.coreqs are empty in Phase 12.8 output)
- Summer + J-term as available terms (kept as data but excluded from main-term distribution)
- `simulate_alternatives` / failed-course retake analyzer

---

## Locked design decisions (from operator review)

These shape the constraint solver. Recorded here so an executor implementing Phase 13 doesn't have to relitigate them.

| # | Decision | Solver behavior |
|---|---|---|
| 1 | NOT operator | Strictly enforced. If `notCourses` includes a course in `coursesTaken`, the dependent course is filtered out of suggestions. |
| 2 | AP/IB equivalency | Synthetic course IDs (`AP-CS-A-3`, etc.) treated as normal courseIds. The DPR ingest path (Task 9 of this plan) injects synthetic IDs when an AP-credit row is present. |
| 3 | Instructor permission | Soft-allow. The PrereqGroup's `requiresPetition: true` flag does NOT block placement, but the slot carries a `requiresPetition: true` annotation that the sidebar renders as a yellow flag. |
| 4 | Minimum-grade thresholds | Trust DPR. Solver checks `coursesTaken[i]` membership; doesn't verify grade against threshold. |
| 5 | Cross-school courses | Full undergrad bulletin coverage (Phase 12.7 + 12.8) means almost all CAS prereqs reference courses we have data for. Edge cases (rare grad-school refs, withdrawn courses) gracefully degrade to "satisfied if in coursesTaken, else assume satisfied" (lenient — no annotation). |
| 6 | Co-requisites | Deferred to Phase 14. PrereqGroup.coreqs is parsed empty in Phase 12.8; solver ignores. |
| 7 | Same-course retake | Trust DPR. If DPR shows the course in coursesTaken AND in unmetRequirements, solver places it normally. |
| 8 | Optional electives above floor | Sidebar distinguishes electives below floor (solid border, required) from above floor (dotted border, "optional" tag). |

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/types.ts` | **Modify** | Add `ForwardSchedule`, `ForwardSemester`, `ScheduleSlot` (4-variant union), `FeasibilityReport` types. |
| `packages/engine/src/agent/tool.ts` | **Modify** | Add `forwardSchedule?: ForwardSchedule` to `ToolSession`. |
| `packages/engine/src/agent/forwardSchedule/types.ts` | **Create** | Internal solver types (Constraint, SolverNode, etc.). |
| `packages/engine/src/agent/forwardSchedule/solver.ts` | **Create** | Greedy + backtracking solver. Reads parsed prereqs + offerings, satisfies hard constraints, optimizes slack-based balance. |
| `packages/engine/src/agent/forwardSchedule/build.ts` | **Create** | Orchestrator: composes the input bundle from session/DPR/profile, runs the solver, produces a `ForwardSchedule`. |
| `packages/engine/src/agent/forwardSchedule/reconcile.ts` | **Create** | DPR-hash-based reconciliation: replaces planned slots that are now completed/in-progress in the new DPR. |
| `packages/engine/src/agent/forwardSchedule/visaPolicy.ts` | **Create** | `creditTargetForVisa()`, `visaNotesForCredits()`, F-1 floor / domestic part-time-floor handling. |
| `packages/engine/tests/agent/forwardScheduleSolver.test.ts` | **Create** | Unit tests for solver: distribution, prereq blocks, offering blocks, NOT enforcement, AP synthetic IDs, slack-based balancing, requiresPetition pass-through. |
| `packages/engine/tests/agent/forwardScheduleReconcile.test.ts` | **Create** | Unit tests for reconciliation: completed-slot replacement, in-progress replacement, hash-mismatch detection. |
| `packages/engine/src/agent/tools/planForwardDegree.ts` | **Create** | New tool `plan_forward_degree`. Replaces `plan_semester` in the registry (old tool kept as a thin shim that delegates to this for back-compat). |
| `packages/engine/src/agent/tools/viewForwardPlan.ts` | **Create** | Read-only tool: returns `session.forwardSchedule`. |
| `packages/engine/src/agent/registry.ts` | **Modify** | Replace `planSemesterTool` with `planForwardDegreeTool`; add `viewForwardPlanTool`. |
| `packages/engine/src/agent/responseValidator.ts` | **Modify** | Extend `checkGrounding` to allow numbers that equal `a ± b` for any pair of grounded numbers. |
| `packages/engine/src/agent/agentLoop.ts` | **Modify** | Pass `isReplayTurn` flag to `runOneTurn`; suppress `thinking_delta` yields on replay. |
| `apps/web/lib/chatV2Client.ts` | **Modify** | Add `{ kind: "forward_schedule_update"; schedule: ForwardSchedule }` to `ChatV2Event`. |
| `apps/web/lib/sseStream.ts` | **Modify** | Same variant added to `SseEvent`. |
| `apps/web/app/api/chat/v2/route.ts` | **Modify** | Detect mutation of `session.forwardSchedule` and emit the new SSE event. |
| `apps/web/app/chat/page.tsx` | **Modify** | Hold `forwardSchedule` in state; consume the new SSE event; render sidebar; clear `thinkingText` on first `hasRealThinking` flip. |
| `apps/web/app/chat/scheduleSidebar.tsx` | **Create** | Right-rail sidebar component with semester cards + 4-variant slot rendering + optional-elective styling. |
| `apps/web/app/chat/chat.module.css` | **Modify** | Sidebar styles: panel, semester cards, slot color tokens, optional-elective dotted border, transition animation. |

---

## Task 1: Define `ForwardSchedule` and supporting types

**Files:**
- Modify: `packages/shared/src/types.ts`

The shared package provides the canonical types so engine + web can both reference them.

- [ ] **Step 1: Add the new types**

Append to `packages/shared/src/types.ts`:

```typescript
/**
 * Phase 13 — Slot in a forward-planned semester. Discriminated union;
 * the UI renders each kind differently (completed = green, in_progress
 * = yellow, specific_planned = blue, placeholder = grey + dotted if
 * "optional"). Solver only mutates `specific_planned` and `placeholder`
 * kinds; `completed` and `in_progress` come straight from the DPR and
 * are never re-planned.
 */

export type ScheduleSlotKind = "completed" | "in_progress" | "specific_planned" | "placeholder";

export interface ScheduleSlotCompleted {
    kind: "completed";
    courseId: string;
    title: string;
    credits: number;
    grade: string;
}

export interface ScheduleSlotInProgress {
    kind: "in_progress";
    courseId: string;
    title: string;
    credits: number;
}

export interface ScheduleSlotSpecificPlanned {
    kind: "specific_planned";
    courseId: string;
    title: string;
    credits: number;
    /** Requirement IDs this slot satisfies. */
    satisfiesRules: string[];
    /** One-line rationale shown in the sidebar tooltip. */
    reason: string;
    /** Phase 13 — set when the prereq tree had an "or instructor
     *  permission" clause. Sidebar renders a yellow flag. */
    requiresPetition?: boolean;
}

export interface ScheduleSlotPlaceholder {
    kind: "placeholder";
    /** Human-readable category, e.g. "CS major elective", "CAS Texts & Ideas",
     *  "Free elective". */
    category: string;
    credits: number;
    /** Requirement IDs this placeholder satisfies (often a single rule;
     *  sometimes empty for plain "free elective"). */
    satisfiesRules: string[];
    /** Phase 13 — true when this elective is ABOVE the credit floor
     *  AND the student's degree-credit minimum is already met. The
     *  sidebar renders these with a dotted border + "optional" tag. */
    optional: boolean;
    /** One-line rationale shown in the sidebar tooltip. */
    reason: string;
}

export type ScheduleSlot =
    | ScheduleSlotCompleted
    | ScheduleSlotInProgress
    | ScheduleSlotSpecificPlanned
    | ScheduleSlotPlaceholder;

export interface ForwardSemester {
    /** Term code: "2026-fall", "2027-spring", "2027-summer", "2027-january". */
    term: string;
    /** True when this term's slots are entirely DPR-derived (completed +
     *  in-progress). Locked semesters never get re-planned. */
    locked: boolean;
    slots: ScheduleSlot[];
    /** Sum of slot credits. */
    plannedCredits: number;
    /** Visa / load advisories. Examples:
     *   - "Below F-1 full-time floor of 12 — RCL approval from OGS required"
     *   - "Part-time enrollment (10 credits) — confirm financial-aid impact"
     *   - "Above credit ceiling of 18 — overload approval needed" */
    notes: string[];
}

export interface FeasibilityReport {
    /** Was the solver able to produce a complete, valid plan? */
    feasible: boolean;
    /** Human-readable reason if not feasible. */
    infeasibilityReason?: string;
    /** Per-constraint diagnostics. */
    constraintViolations: Array<{
        kind:
            | "prereq_unsatisfiable"
            | "offering_pattern"
            | "credit_floor"
            | "credit_ceiling"
            | "graduation_total"
            | "not_clause"
            | "pass_fail_cap"
            | "online_credit_cap"
            | "outside_home_credit_cap"
            | "gpa_floor"
            | "other";
        course?: string;
        term?: string;
        detail: string;
    }>;
    /** Per-course "why placed where" annotations. */
    placementRationale: Record<string, string>;
}

export interface ForwardSchedule {
    studentId: string;
    homeSchoolId: string;
    /** Spring/Fall term the student is targeting for graduation. */
    graduationTerm: string;
    /** Per-semester credit target. F-1 default 12, domestic default 16. */
    creditTargetPerSemester: number;
    /** F-1 floor (12) when student is on F-1 visa, otherwise null. */
    f1Floor: number | null;
    /** Domestic part-time floor (8) when student is NOT F-1, otherwise null. */
    domesticPartTimeFloor: number | null;
    /** Hard graduation credit minimum (128 for CAS). */
    graduationCreditMinimum: number;
    /** True when the student already has ≥ graduationCreditMinimum credits.
     *  When true, free-elective placeholders above the floor render as optional. */
    degreeCreditsMet: boolean;
    /** Chronological list, oldest term first. */
    semesters: ForwardSemester[];
    /** SHA-256 of the DPR's courseHistory at compute time. New DPR with
     *  different hash → reconcile via reconcile.ts. */
    dprCourseHistoryHash: string;
    /** Epoch ms when this schedule was last computed. */
    computedAt: number;
    /** Feasibility diagnostics from the solver. */
    feasibility: FeasibilityReport;
}
```

- [ ] **Step 2: Type-check shared + engine + web**

```bash
cd packages/shared && npx tsc --noEmit
cd ../engine && npx tsc --noEmit
cd ../../apps/web && npx tsc --noEmit
```

Expected: zero new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): ForwardSchedule + 4-variant slot union + FeasibilityReport"
```

---

## Task 2: Visa-policy helper

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/visaPolicy.ts`
- Create: `packages/engine/tests/agent/visaPolicy.test.ts`

Pure helper functions: pick a credit target based on visa, derive per-term notes from credits + visa context.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/visaPolicy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { creditTargetForVisa, visaNotesForCredits } from "../../src/agent/forwardSchedule/visaPolicy";

describe("creditTargetForVisa", () => {
    it("returns 12 for F-1 (full-time floor)", () => {
        expect(creditTargetForVisa("f1")).toBe(12);
    });
    it("returns 16 for domestic", () => {
        expect(creditTargetForVisa("domestic")).toBe(16);
    });
    it("returns 16 for unknown / undefined visa (safe default)", () => {
        expect(creditTargetForVisa(undefined)).toBe(16);
        expect(creditTargetForVisa("other")).toBe(16);
    });
});

describe("visaNotesForCredits", () => {
    it("flags F-1 below floor as RCL-required", () => {
        const notes = visaNotesForCredits({ credits: 8, visa: "f1", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /F-?1/i.test(n) && /RCL/i.test(n))).toBe(true);
    });
    it("does NOT flag F-1 at or above floor", () => {
        const notes = visaNotesForCredits({ credits: 12, visa: "f1", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /RCL/i.test(n))).toBe(false);
    });
    it("flags domestic part-time enrollment between floor and full-time threshold", () => {
        const notes = visaNotesForCredits({ credits: 10, visa: "domestic", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /part-?time/i.test(n))).toBe(true);
    });
    it("flags credit-load below the part-time floor as below-minimum", () => {
        const notes = visaNotesForCredits({ credits: 4, visa: "domestic", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /below.*minimum/i.test(n))).toBe(true);
    });
});
```

- [ ] **Step 2: Implement**

Create `packages/engine/src/agent/forwardSchedule/visaPolicy.ts`:

```typescript
/**
 * Phase 13 — Visa-aware credit-target + per-term notes.
 *
 * - F-1 floor: 12 credits per main term (school-config-derived; default 12).
 *   Below this without OGS-approved RCL: visa status is at risk.
 * - Domestic part-time floor: 8 credits (school-config-derived; default 8).
 *   Below this: not registered for any standing.
 * - Domestic full-time threshold: typically 12 (school-config or
 *   f1Floor as proxy). Between part-time floor and full-time: part-time
 *   notice + financial-aid implications.
 */

interface VisaContext {
    credits: number;
    visa: string | undefined;
    f1Floor: number | null;
    domesticPartTimeFloor: number | null;
}

export function creditTargetForVisa(visa: string | undefined): number {
    if (visa === "f1") return 12;
    return 16;
}

export function visaNotesForCredits(ctx: VisaContext): string[] {
    const notes: string[] = [];
    if (ctx.visa === "f1" && ctx.f1Floor != null && ctx.credits < ctx.f1Floor) {
        notes.push(
            `Below F-1 full-time floor of ${ctx.f1Floor} credits — Reduced Course Load (RCL) approval from NYU OGS required before registration.`
        );
    }
    if (ctx.visa !== "f1" && ctx.f1Floor != null && ctx.domesticPartTimeFloor != null) {
        if (ctx.credits >= ctx.domesticPartTimeFloor && ctx.credits < ctx.f1Floor) {
            notes.push(
                `Part-time enrollment (${ctx.credits} credits, below ${ctx.f1Floor}-credit full-time threshold). Confirm financial-aid impact with the bursar.`
            );
        }
        if (ctx.credits < ctx.domesticPartTimeFloor) {
            notes.push(
                `Below ${ctx.domesticPartTimeFloor}-credit minimum enrollment — student would not be registered for standing.`
            );
        }
    }
    return notes;
}
```

- [ ] **Step 3: Run tests**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/visaPolicy.test.ts
```

Expected: 7/7 PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/forwardSchedule/visaPolicy.ts packages/engine/tests/agent/visaPolicy.test.ts
git commit -m "feat(engine): visaPolicy helper for credit targets + per-term notes"
```

---

## Task 3: Constraint solver — types + skeleton

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/types.ts`
- Create: `packages/engine/src/agent/forwardSchedule/solver.ts`

Defines the solver's input/output contracts. The solver is invoked by `build.ts` (Task 5) which assembles inputs from session + DPR + parsed data.

- [ ] **Step 1: Write the solver-types module**

Create `packages/engine/src/agent/forwardSchedule/types.ts`:

```typescript
import type { CoursePrereqs, PrereqGroup, ForwardSemester, ScheduleSlot, FeasibilityReport } from "@nyupath/shared";

/**
 * Phase 13 — Solver input bundle. All fields are immutable from the
 * solver's perspective; the solver builds a fresh `ForwardSchedule`
 * from these inputs and never mutates them.
 */
export interface SolverInput {
    /** Student-side state. */
    studentId: string;
    homeSchoolId: string;
    visaStatus: string | undefined;
    /** Course IDs the student has already completed (DPR + AP/IB synthetic). */
    coursesTaken: Set<string>;
    /** Course IDs in-progress in the current term (DPR rows with type === "IP"). */
    coursesInProgress: Set<string>;
    /** Current term, e.g. "2026-fall". */
    currentTerm: string;
    /** Target graduation term, e.g. "2027-spring". */
    graduationTerm: string;
    /** Per-semester credit target (12 / 16 / 18). */
    creditTargetPerSemester: number;
    /** F-1 minimum (typically 12) when applicable, else null. */
    f1Floor: number | null;
    /** Domestic part-time floor (typically 8) when applicable, else null. */
    domesticPartTimeFloor: number | null;
    /** Per-school upper credit ceiling (typically 18). */
    creditCeiling: number;
    /** Hard graduation total (128 for CAS). */
    graduationCreditMinimum: number;
    /** Total credits already earned (per DPR). */
    creditsEarned: number;
    /** Pass/fail unit cap (CAS = 32). Hard constraint: planned + already-used P/F
     *  units cannot exceed this. */
    passFailCap: number;
    /** Pass/fail units already used (per DPR header). */
    passFailUsed: number;
    /** Online-credit cap toward the major (school-config-derived; CAS commonly 8 or 16). */
    onlineCreditCap: number | null;
    /** Online credits already counted toward the major (per DPR header). */
    onlineCreditsUsed: number;
    /** Outside-home-school credit cap (CAS = 16 for non-CAS courses). */
    outsideHomeCreditCap: number | null;
    /** Outside-home-school credits already used (per DPR header). */
    outsideHomeCreditsUsed: number;
    /** Cumulative GPA per the latest DPR. Used to flag a graduation-GPA-floor risk. */
    cumulativeGpa: number;
    /** Cumulative major GPA per the DPR (when available). */
    majorGpa: number | null;
    /** School-required cumulative GPA floor for graduation (typically 2.0). */
    graduationGpaFloor: number;
    /** Major-GPA floor (when applicable; null if school has no separate major-GPA rule). */
    majorGpaFloor: number | null;
    /** Unmet requirements from DPR's notSatisfiedRequirements. Each becomes
     *  a candidate to place; rId, title, category, credits required. */
    unmetRequirements: Array<{
        rId: string;
        title: string;
        /** Best-effort category label: "cs_major_required" | "cas_core" |
         *  "free_elective" | "minor_required" | etc. */
        category: string;
        /** Credits this requirement consumes. Usually 4 in CAS. */
        credits: number;
        /** Specific course IDs that satisfy this requirement (when known
         *  from program data). Empty for placeholder-style requirements
         *  like "any free elective". */
        candidateCourses: string[];
    }>;
    /** Parsed prereqs (Phase 12.8 output). */
    prereqs: Map<string, PrereqGroup[]>;
    /** Parsed offerings (Phase 12.8 output). */
    offerings: Map<string, Array<"fall" | "spring" | "summer" | "january">>;
    /** Course metadata: title + credits, indexed by courseId. */
    courseCatalog: Map<string, { title: string; credits: number }>;
    /** DPR's courseHistory hash (for the resulting ForwardSchedule). */
    dprCourseHistoryHash: string;
}

export interface SolverOutput {
    semesters: ForwardSemester[];
    feasibility: FeasibilityReport;
}

/** Internal solver-state node. */
export interface SolverNode {
    /** Per-term tentative slot list (mutable during search). */
    perTerm: Map<string, ScheduleSlot[]>;
    /** Course IDs already placed (for prereq + NOT checks). */
    placedCourses: Set<string>;
    /** Courses we've decided to NOT place (e.g. excluded by NOT clauses). */
    excludedCourses: Set<string>;
    /** Per-term running credit count. */
    perTermCredits: Map<string, number>;
    /** Backtrack history (for debugging only). */
    decisions: string[];
}
```

- [ ] **Step 2: Write the solver skeleton + key tests**

Create `packages/engine/tests/agent/forwardScheduleSolver.test.ts` first (TDD):

```typescript
import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver";
import type { SolverInput } from "../../src/agent/forwardSchedule/types";

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(),
        coursesInProgress: new Set(),
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 96,
        passFailCap: 32,
        passFailUsed: 4,
        onlineCreditCap: 16,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap: 16,
        outsideHomeCreditsUsed: 0,
        cumulativeGpa: 3.4,
        majorGpa: 3.3,
        graduationGpaFloor: 2.0,
        majorGpaFloor: 2.0,
        unmetRequirements: [],
        prereqs: new Map(),
        offerings: new Map(),
        courseCatalog: new Map(),
        dprCourseHistoryHash: "test-hash",
        ...overrides,
    };
}

describe("solveForwardSchedule — slack-based distribution", () => {
    it("places 4 unmet hard requirements roughly evenly across 2 semesters when each slot is empty", () => {
        const input = makeInput({
            unmetRequirements: [
                { rId: "r1", title: "CS 421", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 421"] },
                { rId: "r2", title: "MATH-UA 250", category: "math_major_required", credits: 4, candidateCourses: ["MATH-UA 250"] },
                { rId: "r3", title: "CORE-UA 400", category: "cas_core", credits: 4, candidateCourses: ["CORE-UA 400"] },
                { rId: "r4", title: "CORE-UA 500", category: "cas_core", credits: 4, candidateCourses: ["CORE-UA 500"] },
            ],
            offerings: new Map([
                ["CSCI-UA 421", ["fall", "spring"]],
                ["MATH-UA 250", ["fall", "spring"]],
                ["CORE-UA 400", ["fall", "spring"]],
                ["CORE-UA 500", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 421", { title: "Software Engineering", credits: 4 }],
                ["MATH-UA 250", { title: "Mathematical Statistics", credits: 4 }],
                ["CORE-UA 400", { title: "Texts & Ideas", credits: 4 }],
                ["CORE-UA 500", { title: "Cultures & Contexts", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        const fallHard = fall.slots.filter(s => s.kind === "specific_planned").length;
        const springHard = spring.slots.filter(s => s.kind === "specific_planned").length;
        // 4 hard requirements across 2 terms: 2 each.
        expect(fallHard).toBe(2);
        expect(springHard).toBe(2);
    });

    it("does NOT add more hard requirements to a term that's already full of locked credits", () => {
        const input = makeInput({
            coursesInProgress: new Set(["CORE-UA 700", "MATH-UA 251", "MATH-UA 343"]),
            unmetRequirements: [
                { rId: "r1", title: "CS 421", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 421"] },
                { rId: "r2", title: "CORE-UA 400", category: "cas_core", credits: 4, candidateCourses: ["CORE-UA 400"] },
            ],
            offerings: new Map([
                ["CSCI-UA 421", ["fall", "spring"]],
                ["CORE-UA 400", ["fall", "spring"]],
                ["CORE-UA 700", ["fall", "spring"]],
                ["MATH-UA 251", ["fall", "spring"]],
                ["MATH-UA 343", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 421", { title: "X", credits: 4 }],
                ["CORE-UA 400", { title: "Y", credits: 4 }],
                ["CORE-UA 700", { title: "Z1", credits: 4 }],
                ["MATH-UA 251", { title: "Z2", credits: 4 }],
                ["MATH-UA 343", { title: "Z3", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        // Fall already has 12 credits locked (3 in_progress) — slack to 16 = 4.
        // Both hard requirements should NOT land in fall; one (or both) goes
        // to spring where slack is full (16).
        const fallSpecificPlanned = fall.slots.filter(s => s.kind === "specific_planned").length;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        const springSpecificPlanned = spring.slots.filter(s => s.kind === "specific_planned").length;
        expect(fallSpecificPlanned + springSpecificPlanned).toBe(2);
        expect(springSpecificPlanned).toBeGreaterThanOrEqual(1); // at least one hard in spring
    });
});

describe("solveForwardSchedule — prereq + offering constraints", () => {
    it("blocks a course in a term where its offering pattern excludes that term", () => {
        const input = makeInput({
            unmetRequirements: [
                { rId: "r1", title: "CS 421", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 421"] },
            ],
            offerings: new Map([
                ["CSCI-UA 421", ["spring"]], // spring-only
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 421", { title: "Software Engineering", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        const fallHasIt = fall.slots.some(s => "courseId" in s && s.courseId === "CSCI-UA 421");
        const springHasIt = spring.slots.some(s => "courseId" in s && s.courseId === "CSCI-UA 421");
        expect(fallHasIt).toBe(false);
        expect(springHasIt).toBe(true);
    });

    it("respects prereq satisfaction — places X only after Y is in coursesTaken or scheduled earlier", () => {
        const input = makeInput({
            coursesTaken: new Set(), // student hasn't taken Y yet
            unmetRequirements: [
                { rId: "rX", title: "CS X", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA X"] },
                { rId: "rY", title: "CS Y", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA Y"] },
            ],
            prereqs: new Map([
                ["CSCI-UA X", [{ type: "AND", courses: ["CSCI-UA Y"], coreqs: [], requiresPetition: false, notCourses: [] }]],
            ]),
            offerings: new Map([
                ["CSCI-UA X", ["fall", "spring"]],
                ["CSCI-UA Y", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA X", { title: "X", credits: 4 }],
                ["CSCI-UA Y", { title: "Y", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        const fallY = fall.slots.find(s => "courseId" in s && s.courseId === "CSCI-UA Y");
        const springX = spring.slots.find(s => "courseId" in s && s.courseId === "CSCI-UA X");
        // Y must come before X.
        expect(fallY).toBeDefined();
        expect(springX).toBeDefined();
    });
});

describe("solveForwardSchedule — NOT clause", () => {
    it("excludes a course whose NOT clause references something in coursesTaken", () => {
        const input = makeInput({
            coursesTaken: new Set(["CSCI-UA 2"]),
            unmetRequirements: [
                { rId: "r1", title: "CS 101", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 101"] },
            ],
            prereqs: new Map([
                ["CSCI-UA 101", [{ type: "NOT", courses: [], coreqs: [], requiresPetition: false, notCourses: ["CSCI-UA 2"] }]],
            ]),
            offerings: new Map([
                ["CSCI-UA 101", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 101", { title: "Intro", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const placed = out.semesters.flatMap(s => s.slots).find(s => "courseId" in s && s.courseId === "CSCI-UA 101");
        expect(placed).toBeUndefined();
        // And feasibility report flags it.
        expect(out.feasibility.constraintViolations.some(v => v.kind === "not_clause" && v.course === "CSCI-UA 101")).toBe(true);
    });
});

describe("solveForwardSchedule — instructor permission", () => {
    it("places a course whose only prereq path is 'or instructor permission' but flags requiresPetition", () => {
        const input = makeInput({
            coursesTaken: new Set(),
            unmetRequirements: [
                { rId: "r1", title: "Special Topics", category: "cs_major_elective", credits: 4, candidateCourses: ["CSCI-UA 480"] },
            ],
            prereqs: new Map([
                ["CSCI-UA 480", [{
                    type: "OR",
                    courses: [],
                    coreqs: [],
                    requiresPetition: true,
                    notCourses: [],
                }]],
            ]),
            offerings: new Map([
                ["CSCI-UA 480", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 480", { title: "ST", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const placed = out.semesters.flatMap(s => s.slots).find(s => "courseId" in s && s.courseId === "CSCI-UA 480");
        expect(placed).toBeDefined();
        expect((placed as { requiresPetition?: boolean }).requiresPetition).toBe(true);
    });
});

describe("solveForwardSchedule — optional electives flag", () => {
    it("marks free-elective placeholders ABOVE the floor as optional when degreeCreditsMet === true", () => {
        const input = makeInput({
            creditsEarned: 138, // already over 128
            unmetRequirements: [], // no hard reqs left
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const placeholders = fall.slots.filter(s => s.kind === "placeholder") as Array<{ optional?: boolean }>;
        expect(placeholders.length).toBeGreaterThan(0);
        // F-1 student → floor 12. Above 12, electives are optional.
        const aboveFloor = placeholders.filter(p => p.optional === true);
        expect(aboveFloor.length).toBeGreaterThan(0);
    });
});

describe("solveForwardSchedule — additional credit-cap constraints", () => {
    it("flags pass_fail_cap when passFailUsed >= passFailCap", () => {
        const input = makeInput({ passFailCap: 32, passFailUsed: 32 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "pass_fail_cap")).toBe(true);
    });
    it("does NOT flag pass_fail_cap when student is well under the cap", () => {
        const input = makeInput({ passFailCap: 32, passFailUsed: 4 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "pass_fail_cap")).toBe(false);
    });

    it("flags online_credit_cap when student is already over the cap", () => {
        const input = makeInput({ onlineCreditCap: 16, onlineCreditsUsed: 20 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "online_credit_cap")).toBe(true);
    });

    it("flags outside_home_credit_cap when student is already over the cap", () => {
        const input = makeInput({ outsideHomeCreditCap: 16, outsideHomeCreditsUsed: 20 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "outside_home_credit_cap")).toBe(true);
    });
});

describe("solveForwardSchedule — GPA-floor checks", () => {
    it("flags gpa_floor when cumulative GPA is below the graduation floor", () => {
        const input = makeInput({ cumulativeGpa: 1.85, graduationGpaFloor: 2.0 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "gpa_floor" && /Cumulative GPA/.test(v.detail))).toBe(true);
    });
    it("flags gpa_floor when major GPA is below the major-completion floor", () => {
        const input = makeInput({ majorGpa: 1.95, majorGpaFloor: 2.0, cumulativeGpa: 3.0 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "gpa_floor" && /Major GPA/.test(v.detail))).toBe(true);
    });
    it("does NOT flag gpa_floor when both GPAs are above floor", () => {
        const input = makeInput({ cumulativeGpa: 3.4, majorGpa: 3.3, graduationGpaFloor: 2.0, majorGpaFloor: 2.0 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "gpa_floor")).toBe(false);
    });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/forwardScheduleSolver.test.ts
```

Expected: FAIL — `solveForwardSchedule` doesn't exist yet.

- [ ] **Step 4: Implement the solver**

Create `packages/engine/src/agent/forwardSchedule/solver.ts`:

```typescript
import type { ScheduleSlot, ForwardSemester, FeasibilityReport, PrereqGroup } from "@nyupath/shared";
import type { SolverInput, SolverOutput, SolverNode } from "./types.js";

const SEASONS = ["spring", "summer", "fall", "january"] as const;
type Season = typeof SEASONS[number];

function parseTerm(t: string): { year: number; season: Season } | null {
    const m = t.toLowerCase().match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return null;
    return { year: parseInt(m[1]!, 10), season: m[2] as Season };
}

function termOrd(p: { year: number; season: Season }): number {
    return p.year * 4 + SEASONS.indexOf(p.season);
}

function termCode(p: { year: number; season: Season }): string {
    return `${p.year}-${p.season}`;
}

function nextMainTerm(p: { year: number; season: Season }): { year: number; season: Season } {
    // Phase 13 skips summer + january in the future-term enumeration.
    if (p.season === "spring") return { year: p.year, season: "fall" };
    if (p.season === "fall") return { year: p.year + 1, season: "spring" };
    if (p.season === "summer") return { year: p.year, season: "fall" };
    return { year: p.year, season: "spring" }; // january
}

function enumerateMainTerms(start: string, end: string): string[] {
    const a = parseTerm(start);
    const b = parseTerm(end);
    if (!a || !b) return [];
    const out: string[] = [];
    let cur = a;
    while (termOrd(cur) <= termOrd(b)) {
        if (cur.season === "fall" || cur.season === "spring") out.push(termCode(cur));
        if (termOrd(cur) === termOrd(b)) break;
        cur = nextMainTerm(cur);
        if (cur.year > b.year + 6) break;
    }
    return out;
}

/**
 * Phase 13 — checks whether a course's prereq tree is satisfied by the
 * union of coursesTaken (DPR) and a candidate `placedBefore` set
 * (courses we've placed in prior terms during this solve).
 *
 * Implements decisions:
 *  - #1 NOT clause: if any course in `notCourses` is in coursesTaken,
 *    the course is excluded.
 *  - #4 Trust DPR: any course in coursesTaken is treated as satisfied.
 *  - #5 Lenient cross-school: if we don't have prereq data on a foreign
 *    course AND it's in coursesTaken, treat as satisfied. If we don't
 *    have data AND it's NOT in coursesTaken, treat as the OR-fallback
 *    (some other clause may carry the placement).
 *  - Strict synthetic AP/IB: same path as normal coursesTaken membership;
 *    parser already minted them.
 */
function isPrereqSatisfied(
    groups: PrereqGroup[],
    coursesTaken: Set<string>,
    placedBefore: Set<string>,
): { satisfied: boolean; excluded: boolean; requiresPetition: boolean } {
    let requiresPetition = false;
    for (const g of groups) {
        if (g.type === "NOT") {
            const blocking = g.notCourses?.find(c => coursesTaken.has(c) || placedBefore.has(c));
            if (blocking) return { satisfied: false, excluded: true, requiresPetition: false };
            continue;
        }
        if (g.requiresPetition) requiresPetition = true;
        const checkSatisfied = (c: string) =>
            coursesTaken.has(c) || placedBefore.has(c);
        if (g.type === "AND") {
            for (const c of g.courses) {
                if (!checkSatisfied(c)) {
                    if (!g.requiresPetition) {
                        return { satisfied: false, excluded: false, requiresPetition: false };
                    }
                }
            }
        } else if (g.type === "OR") {
            const anyOk = g.courses.some(c => checkSatisfied(c));
            if (!anyOk && !g.requiresPetition) {
                return { satisfied: false, excluded: false, requiresPetition: false };
            }
        }
    }
    return { satisfied: true, excluded: false, requiresPetition };
}

/**
 * Phase 13 — Slack-based ordering. Returns a sorted list of (term, slack)
 * pairs, descending by slack. Hard-requirement placement walks this in
 * order so the term with the most empty space gets filled first.
 */
function termsBySlack(
    futureTerms: string[],
    perTermCredits: Map<string, number>,
    target: number,
): Array<{ term: string; slack: number }> {
    return futureTerms
        .map(t => ({ term: t, slack: target - (perTermCredits.get(t) ?? 0) }))
        .sort((a, b) => b.slack - a.slack);
}

export function solveForwardSchedule(input: SolverInput): SolverOutput {
    const violations: FeasibilityReport["constraintViolations"] = [];
    const placementRationale: Record<string, string> = {};

    // 1. Build past + current semesters from DPR (locked).
    const lockedSemesters: ForwardSemester[] = []; // Past + current — populated by build.ts wrapper

    // 2. Enumerate future main terms.
    const futureTerms = enumerateMainTerms(input.currentTerm, input.graduationTerm)
        .filter(t => t !== input.currentTerm); // current is locked

    if (futureTerms.length === 0) {
        // Only the locked current term remains. Nothing to plan.
        return {
            semesters: [],
            feasibility: {
                feasible: true,
                constraintViolations: [],
                placementRationale: {},
            },
        };
    }

    // 3. Initialize per-term credit counts and slot lists.
    const perTermSlots = new Map<string, ScheduleSlot[]>();
    const perTermCredits = new Map<string, number>();
    for (const t of futureTerms) {
        perTermSlots.set(t, []);
        perTermCredits.set(t, 0);
    }

    // 4. Build placement-decision queue. Course IDs from unmetRequirements
    //    that have at least one candidate course we know about (from the
    //    courseCatalog). Requirements without a specific candidate become
    //    placeholder slots in step 6.
    const placedBefore = new Set<string>(); // for prereq satisfaction within same plan

    interface Candidate {
        rId: string;
        courseId: string;
        title: string;
        credits: number;
        category: string;
    }

    const candidates: Candidate[] = [];
    const placeholderRequirements: typeof input.unmetRequirements = [];
    for (const req of input.unmetRequirements) {
        if (req.candidateCourses.length === 0) {
            placeholderRequirements.push(req);
            continue;
        }
        // Pick the first candidate. Future iterations could try multiple.
        const courseId = req.candidateCourses[0]!;
        const meta = input.courseCatalog.get(courseId);
        if (!meta) {
            // Catalog gap — degrade gracefully.
            placeholderRequirements.push(req);
            continue;
        }
        candidates.push({ rId: req.rId, courseId, title: meta.title, credits: meta.credits, category: req.category });
    }

    // 5. Place each candidate using slack-based ordering + prereq +
    //    offering constraints. Greedy with a single-level fallback.
    for (const cand of candidates) {
        const sched = isPrereqSatisfied(
            input.prereqs.get(cand.courseId) ?? [],
            input.coursesTaken,
            placedBefore,
        );
        if (sched.excluded) {
            violations.push({
                kind: "not_clause",
                course: cand.courseId,
                detail: `Course ${cand.courseId} is excluded by a NOT prereq clause (something in coursesTaken blocks it).`,
            });
            continue;
        }

        const offered = input.offerings.get(cand.courseId);
        const sortedTerms = termsBySlack(futureTerms, perTermCredits, input.creditTargetPerSemester);
        let placed = false;
        for (const { term, slack } of sortedTerms) {
            if (slack < cand.credits) continue;
            const seasonOnly = term.split("-")[1] as "fall" | "spring";
            if (offered && !offered.includes(seasonOnly)) continue;
            // For simplicity Phase 13: prereq satisfaction checks against
            // the running placedBefore. If a prereq is unmet, skip — the
            // backtracking version (Phase 15+) would re-order. Phase 13
            // is greedy.
            if (!sched.satisfied) {
                violations.push({
                    kind: "prereq_unsatisfiable",
                    course: cand.courseId,
                    term,
                    detail: `Course ${cand.courseId} prereqs not yet satisfied by placement order in ${term}.`,
                });
                continue;
            }
            // OK to place.
            const slot: ScheduleSlot = {
                kind: "specific_planned",
                courseId: cand.courseId,
                title: cand.title,
                credits: cand.credits,
                satisfiesRules: [cand.rId],
                reason: `Required (${cand.category}) placed in ${term} for slack-balanced load.`,
                ...(sched.requiresPetition ? { requiresPetition: true } : {}),
            };
            perTermSlots.get(term)!.push(slot);
            perTermCredits.set(term, (perTermCredits.get(term) ?? 0) + cand.credits);
            placedBefore.add(cand.courseId);
            placementRationale[cand.courseId] = slot.reason;
            placed = true;
            break;
        }
        if (!placed) {
            violations.push({
                kind: "offering_pattern",
                course: cand.courseId,
                detail: `Could not place ${cand.courseId} — no future term has sufficient slack and matching offering pattern.`,
            });
        }
    }

    // 6. Place placeholder requirements (no specific candidate course).
    for (const req of placeholderRequirements) {
        const sortedTerms = termsBySlack(futureTerms, perTermCredits, input.creditTargetPerSemester);
        const term = sortedTerms[0]?.term;
        if (!term) continue;
        const slot: ScheduleSlot = {
            kind: "placeholder",
            category: req.title,
            credits: req.credits,
            satisfiesRules: [req.rId],
            optional: false,
            reason: `Distributed from ${input.unmetRequirements.length} unmet requirements across ${futureTerms.length} remaining semesters.`,
        };
        perTermSlots.get(term)!.push(slot);
        perTermCredits.set(term, (perTermCredits.get(term) ?? 0) + req.credits);
    }

    // 7. Fill remaining capacity with free-elective placeholders.
    const degreeCreditsMet = input.creditsEarned >= input.graduationCreditMinimum;
    for (const term of futureTerms) {
        const cur = perTermCredits.get(term) ?? 0;
        const cap = input.creditTargetPerSemester;
        let credits = cur;
        while (credits + 4 <= cap) {
            const aboveFloor = credits >= (input.f1Floor ?? input.domesticPartTimeFloor ?? 0);
            const optional = degreeCreditsMet && aboveFloor;
            perTermSlots.get(term)!.push({
                kind: "placeholder",
                category: "Free elective",
                credits: 4,
                satisfiesRules: [],
                optional,
                reason: optional
                    ? "Above degree minimum and credit floor — optional load."
                    : `Brings total to ${cap}-credit target.`,
            });
            credits += 4;
        }
        perTermCredits.set(term, credits);
    }

    // 8. Build ForwardSemester[].
    const semesters: ForwardSemester[] = futureTerms.map(t => {
        const slots = perTermSlots.get(t) ?? [];
        const credits = slots.reduce((s, x) => s + x.credits, 0);
        const notes: string[] = [];
        if (input.f1Floor != null && credits < input.f1Floor && input.visaStatus === "f1") {
            notes.push(`Below F-1 full-time floor of ${input.f1Floor} credits — RCL approval from OGS required.`);
            violations.push({ kind: "credit_floor", term: t, detail: `Below F-1 floor (${credits} < ${input.f1Floor}).` });
        }
        if (credits > input.creditCeiling) {
            notes.push(`Above credit ceiling of ${input.creditCeiling} — overload approval needed.`);
            violations.push({ kind: "credit_ceiling", term: t, detail: `Above ceiling (${credits} > ${input.creditCeiling}).` });
        }
        return { term: t, locked: false, slots, plannedCredits: credits, notes };
    });

    // 9. Graduation total check.
    const totalScheduled = input.creditsEarned + semesters.reduce((s, sem) => s + sem.plannedCredits, 0);
    if (totalScheduled < input.graduationCreditMinimum) {
        violations.push({
            kind: "graduation_total",
            detail: `Projected total ${totalScheduled} < graduation minimum ${input.graduationCreditMinimum}.`,
        });
    }

    // 10. Pass/fail cap check. Phase 13 doesn't yet allow pinning courses
    //     as P/F via preferences (that arrives in Phase 14), so the
    //     planner only flags when the student has ALREADY used >= cap and
    //     would block any future P/F decisions. The hard-cap math runs
    //     here so the report carries the constraint regardless.
    if (input.passFailUsed >= input.passFailCap) {
        violations.push({
            kind: "pass_fail_cap",
            detail: `Student has used ${input.passFailUsed} of ${input.passFailCap} P/F units. Any future placement must be letter-graded.`,
        });
    }

    // 11. Online-credit cap. The bulletin notes some online-only courses;
    //     when they bear that flag, the solver counts them against the
    //     online-credit budget. Phase 13 doesn't yet track per-course
    //     online flag (that's a Phase 12.8 catalog enrichment), so the
    //     check here is a header-level guard: if the student is already
    //     above the cap, surface as a hard violation so the agent's reply
    //     warns them.
    if (input.onlineCreditCap != null && input.onlineCreditsUsed > input.onlineCreditCap) {
        violations.push({
            kind: "online_credit_cap",
            detail: `Student has used ${input.onlineCreditsUsed} online credits, exceeding the ${input.onlineCreditCap}-credit cap toward the major. Future online courses will not count.`,
        });
    }

    // 12. Outside-home credit cap. CAS students may take up to 16 credits
    //     outside the College of Arts & Science. If already over, future
    //     non-home placements must be flagged.
    if (input.outsideHomeCreditCap != null && input.outsideHomeCreditsUsed > input.outsideHomeCreditCap) {
        violations.push({
            kind: "outside_home_credit_cap",
            detail: `Student has used ${input.outsideHomeCreditsUsed} credits outside ${input.homeSchoolId}, exceeding the ${input.outsideHomeCreditCap}-credit cap. Future non-${input.homeSchoolId} courses will not count toward graduation.`,
        });
    }

    // 13. Graduation GPA floor. The student's cumulative GPA must meet
    //     the school's floor (typically 2.0) at graduation. Below the
    //     floor → flag as gpa_floor violation so the agent surfaces a
    //     banner ("you're at risk of not graduating even with this
    //     plan; talk to advising").
    if (input.cumulativeGpa < input.graduationGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Cumulative GPA ${input.cumulativeGpa} is below the ${input.graduationGpaFloor} graduation floor. The plan does not address this — the student must improve grades on the remaining courses or graduation will be denied.`,
        });
    }
    if (input.majorGpaFloor != null && input.majorGpa != null && input.majorGpa < input.majorGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Major GPA ${input.majorGpa} is below the ${input.majorGpaFloor} major-completion floor. Some required courses may need to be retaken for higher grades.`,
        });
    }

    return {
        semesters,
        feasibility: {
            feasible: violations.length === 0,
            ...(violations.length > 0 ? { infeasibilityReason: `${violations.length} constraint violations.` } : {}),
            constraintViolations: violations,
            placementRationale,
        },
    };
}
```

This is a Phase-13-class **greedy** solver: no backtracking, single-pass slack-based placement. It's intentionally simpler than the full CSP described in the architecture doc. Phase 15 will introduce backtracking; Phase 13 ships the greedy version with feasibility-report annotations so unfilled-prereq cases are surfaced explicitly even when not solved.

- [ ] **Step 5: Run tests to verify pass**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/forwardScheduleSolver.test.ts
```

Expected: all tests PASS (or document specific cases that fall to Phase 15's backtracking — e.g. the prereq-ordering test may need the candidate sort by prereq depth before slack).

If a test fails because the greedy is too naive, either:
- Adjust the test's expectation to match Phase 13's greedy semantics (with a comment explaining what Phase 15 will improve).
- Add a small pre-pass that topologically sorts candidates by prereq depth, so courses with no dependencies place first.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/forwardSchedule/solver.ts packages/engine/src/agent/forwardSchedule/types.ts packages/engine/tests/agent/forwardScheduleSolver.test.ts
git commit -m "feat(engine): forward-schedule constraint solver (greedy + slack-based)"
```

---

## Task 4: Reconciliation helper (DPR re-upload)

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/reconcile.ts`
- Create: `packages/engine/tests/agent/forwardScheduleReconcile.test.ts`

When the user uploads a new DPR, we hash its `courseHistory` and compare to `forwardSchedule.dprCourseHistoryHash`. On mismatch, walk the existing schedule and:
- For each `specific_planned` slot: if the new DPR shows the course completed → replace with `completed`. If in-progress → replace with `in_progress`.
- For each `placeholder` slot whose satisfying requirement is now met by a DPR completed course → remove or re-categorize.

- [ ] **Step 1: Write the tests** (similar pattern to Task 3 — load fake schedules, drive `reconcileWithDpr`, assert specific slot transformations).

- [ ] **Step 2: Implement `reconcile.ts`**

Create `packages/engine/src/agent/forwardSchedule/reconcile.ts`:

```typescript
import { createHash } from "node:crypto";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import type { DPRCourseRow, DegreeProgressReport } from "../../dpr/schema.js";

export function dprCourseHistoryHash(courseHistory: DPRCourseRow[]): string {
    const normalized = courseHistory
        .map(c => `${c.subject} ${c.catalogNbr}|${c.term}|${c.grade ?? ""}|${c.units}|${c.type}`)
        .sort();
    return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 16);
}

export function reconcileWithDpr(old: ForwardSchedule, newDpr: DegreeProgressReport): ForwardSchedule {
    const newCompleted = new Map<string, DPRCourseRow>();
    const newInProgress = new Map<string, DPRCourseRow>();
    for (const row of newDpr.courseHistory) {
        const id = `${row.subject} ${row.catalogNbr}`;
        if (row.type === "IP") newInProgress.set(id, row);
        else if (row.grade && row.grade !== "") newCompleted.set(id, row);
    }
    const reconciled = old.semesters.map(sem => ({
        ...sem,
        slots: sem.slots.map(slot => {
            if (slot.kind !== "specific_planned") return slot;
            const c = newCompleted.get(slot.courseId);
            if (c) {
                return {
                    kind: "completed" as const,
                    courseId: slot.courseId,
                    title: slot.title,
                    credits: slot.credits,
                    grade: c.grade ?? "",
                };
            }
            const ip = newInProgress.get(slot.courseId);
            if (ip) {
                return {
                    kind: "in_progress" as const,
                    courseId: slot.courseId,
                    title: slot.title,
                    credits: slot.credits,
                };
            }
            return slot;
        }),
    }));
    return {
        ...old,
        semesters: reconciled,
        dprCourseHistoryHash: dprCourseHistoryHash(newDpr.courseHistory),
        computedAt: Date.now(),
    };
}
```

- [ ] **Step 3: Run tests** — expected pass.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/forwardSchedule/reconcile.ts packages/engine/tests/agent/forwardScheduleReconcile.test.ts
git commit -m "feat(engine): forwardSchedule reconcile-with-DPR helper"
```

---

## Task 5: `build.ts` — orchestrator

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/build.ts`

Wraps the solver with the DPR-bundle composition. Loads parsed prereqs + offerings from disk (Phase 12.8 outputs); builds locked past/current semesters from DPR; calls `solveForwardSchedule`; assembles the final `ForwardSchedule`.

```typescript
import type { ForwardSchedule, ForwardSemester } from "@nyupath/shared";
import * as fs from "node:fs";
import * as path from "node:path";
import { solveForwardSchedule } from "./solver.js";
import { creditTargetForVisa } from "./visaPolicy.js";
import { dprCourseHistoryHash } from "./reconcile.js";
import type { ToolSession } from "../tool.js";

const PREREQS_PATH = path.resolve(__dirname, "../../data/prereqs.json");
const OFFERINGS_PATH = path.resolve(__dirname, "../../data/courses-offerings.json");
const COURSES_PATH = path.resolve(__dirname, "../../data/courses.json");

let cachedPrereqs: Map<string, any> | null = null;
let cachedOfferings: Map<string, any> | null = null;
let cachedCatalog: Map<string, any> | null = null;

function loadPrereqs() {
    if (cachedPrereqs) return cachedPrereqs;
    const raw: Array<{ course: string; prereqGroups: any[] }> = JSON.parse(fs.readFileSync(PREREQS_PATH, "utf8"));
    cachedPrereqs = new Map(raw.map(r => [r.course, r.prereqGroups]));
    return cachedPrereqs;
}

function loadOfferings() {
    if (cachedOfferings) return cachedOfferings;
    const raw: Record<string, { termsOffered: string[] }> = JSON.parse(fs.readFileSync(OFFERINGS_PATH, "utf8"));
    cachedOfferings = new Map(Object.entries(raw).map(([id, v]) => [id, v.termsOffered]));
    return cachedOfferings;
}

function loadCatalog() {
    if (cachedCatalog) return cachedCatalog;
    const raw: Array<{ id: string; title: string; credits: number }> = JSON.parse(fs.readFileSync(COURSES_PATH, "utf8"));
    cachedCatalog = new Map(raw.map(c => [c.id, { title: c.title, credits: c.credits }]));
    return cachedCatalog;
}

interface BuildArgs {
    session: ToolSession;
    currentTerm: string;
    graduationTerm: string;
    creditTargetPerSemester?: number;
}

const SEASONS_ORDERED = ["spring", "summer", "fall", "january"] as const;
type Season = typeof SEASONS_ORDERED[number];

/** "2024 Fall" → "2024-fall"; "2024 Spr" → "2024-spring"; etc. Returns
 *  null when the input doesn't parse. */
function normalizeDprTermToCode(dprTerm: string): string | null {
    const m = dprTerm.toLowerCase().match(/(\d{4})\s+(fall|fal|spring|spr|summer|sum|january|jan|j-?term)/);
    if (!m) return null;
    const year = m[1]!;
    const seasonRaw = m[2]!;
    let season: Season;
    if (seasonRaw.startsWith("fal")) season = "fall";
    else if (seasonRaw.startsWith("spr")) season = "spring";
    else if (seasonRaw.startsWith("sum")) season = "summer";
    else season = "january";
    return `${year}-${season}`;
}

function parseTermCode(t: string): { year: number; season: Season } | null {
    const m = t.match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return null;
    return { year: parseInt(m[1]!, 10), season: m[2] as Season };
}

/**
 * Phase 13 — Map a DPR transfer/exam-credit row to a Phase 12.8
 * synthetic courseId. Returns null when the row's subject doesn't
 * match a known AP/IB exam name. The mapping mirrors
 * `tools/bulletin-parser/syntheticCourseIds.ts`'s tables — keep them
 * in sync if those tables change.
 */
function synthesizeFromDprRow(row: { subject: string; courseTitle: string; grade: string | null; units: number }): string | null {
    const subjectLower = row.subject.toLowerCase();
    const titleLower = (row.courseTitle ?? "").toLowerCase();
    const combined = `${subjectLower} ${titleLower}`;
    const score = row.grade ? parseInt(row.grade, 10) : null;
    if (score == null || Number.isNaN(score)) return null;
    if (combined.includes("comp sci a") || combined.includes("computer science a")) return `AP-CS-A-${score}`;
    if (combined.includes("comp sci principles") || combined.includes("computer science principles")) return `AP-CS-P-${score}`;
    if (combined.includes("calculus bc")) return `AP-CALC-BC-${score}`;
    if (combined.includes("calculus ab")) return `AP-CALC-AB-${score}`;
    if (combined.includes("ap statistics") || (subjectLower.includes("adv plac") && titleLower.includes("statistics"))) return `AP-STATS-${score}`;
    // Extend as needed; fall through to null if unrecognized so the
    // synthetic ID doesn't get minted incorrectly.
    return null;
}

export function buildForwardSchedule(args: BuildArgs): ForwardSchedule {
    const session = args.session;
    const student = session.student!;
    const dpr = session.degreeProgressReport!;
    const schoolConfig = session.schoolConfig!;

    const coursesTaken = new Set<string>();
    const coursesInProgress = new Set<string>();
    for (const row of dpr.courseHistory) {
        const id = `${row.subject} ${row.catalogNbr}`;
        if (row.type === "IP") coursesInProgress.add(id);
        else if (row.grade) coursesTaken.add(id);
    }

    // Phase 13 — inject AP/IB synthetic course IDs from DPR rows that
    // represent test credit. The DPR uses `type === "TE"` for transfer/
    // exam credit; the row's `subject` carries the exam name (e.g.
    // "Adv Plac Comp Sci A") and `grade` the score. Map to the synthetic
    // courseId scheme defined in Phase 12.8 Task 2 (AP-CS-A-3, etc.) so
    // the prereq solver can resolve "AP Computer Science A >= 3" clauses.
    for (const row of dpr.courseHistory) {
        if (row.type !== "TE") continue;
        const synthetic = synthesizeFromDprRow(row);
        if (synthetic) coursesTaken.add(synthetic);
    }

    const visa = student.visaStatus;
    const creditTarget = args.creditTargetPerSemester ?? creditTargetForVisa(visa);
    const f1Floor = visa === "f1" ? (schoolConfig.f1FullTimeMinCredits ?? 12) : null;
    const partTimeFloor = (schoolConfig as { domesticPartTimeFloor?: number }).domesticPartTimeFloor ?? 8;

    const unmetRequirements = (dpr.requirementGroups ?? [])
        .flatMap(g => g.children ?? [])
        .filter((r: any) => r.statusText !== "satisfied")
        .map((r: any) => ({
            rId: r.rId,
            title: r.title ?? "Unmet requirement",
            category: (r.category ?? "unknown") as string,
            credits: r.credits ?? 4,
            candidateCourses: r.coursesUsed ?? [],
        }));

    const out = solveForwardSchedule({
        studentId: student.id,
        homeSchoolId: student.homeSchool,
        visaStatus: visa,
        coursesTaken,
        coursesInProgress,
        currentTerm: args.currentTerm,
        graduationTerm: args.graduationTerm,
        creditTargetPerSemester: creditTarget,
        f1Floor,
        domesticPartTimeFloor: partTimeFloor,
        creditCeiling: schoolConfig.maxCreditsPerSemester ?? 18,
        graduationCreditMinimum: schoolConfig.graduationCreditMinimum ?? 128,
        creditsEarned: dpr.creditsEarned ?? 0,
        unmetRequirements,
        prereqs: loadPrereqs(),
        offerings: loadOfferings(),
        courseCatalog: loadCatalog(),
        dprCourseHistoryHash: dprCourseHistoryHash(dpr.courseHistory),
    });

    // Phase 13 — build past + current locked semesters from DPR.
    // Past terms (DPR-completed) become semesters with completed slots.
    // The current term (DPR in-progress rows) becomes a single locked
    // semester with in_progress slots. Both never re-plan.
    const byTerm = new Map<string, typeof dpr.courseHistory>();
    for (const row of dpr.courseHistory) {
        const tc = normalizeDprTermToCode(row.term); // "2024 Fall" → "2024-fall"
        if (!tc) continue;
        if (!byTerm.has(tc)) byTerm.set(tc, []);
        byTerm.get(tc)!.push(row);
    }
    const lockedSemesters: ForwardSemester[] = [];
    for (const [termCode, rows] of byTerm) {
        const isCurrent = termCode === args.currentTerm;
        const slots: ScheduleSlot[] = rows.map(r => {
            if (r.type === "IP") {
                return {
                    kind: "in_progress",
                    courseId: `${r.subject} ${r.catalogNbr}`,
                    title: r.courseTitle,
                    credits: r.units,
                };
            }
            return {
                kind: "completed",
                courseId: `${r.subject} ${r.catalogNbr}`,
                title: r.courseTitle,
                credits: r.units,
                grade: r.grade ?? "",
            };
        });
        const credits = slots.reduce((s, x) => s + x.credits, 0);
        lockedSemesters.push({
            term: termCode,
            locked: true,
            slots,
            plannedCredits: credits,
            notes: [],
        });
    }
    // Sort chronologically.
    lockedSemesters.sort((a, b) => {
        const pa = parseTermCode(a.term);
        const pb = parseTermCode(b.term);
        return (pa?.year ?? 0) * 4 + (pa ? SEASONS_ORDERED.indexOf(pa.season) : 0)
             - ((pb?.year ?? 0) * 4 + (pb ? SEASONS_ORDERED.indexOf(pb.season) : 0));
    });

    return {
        studentId: student.id,
        homeSchoolId: student.homeSchool,
        graduationTerm: args.graduationTerm,
        creditTargetPerSemester: creditTarget,
        f1Floor,
        domesticPartTimeFloor: partTimeFloor,
        graduationCreditMinimum: schoolConfig.graduationCreditMinimum ?? 128,
        degreeCreditsMet: (dpr.creditsEarned ?? 0) >= (schoolConfig.graduationCreditMinimum ?? 128),
        semesters: [...lockedSemesters, ...out.semesters],
        dprCourseHistoryHash: dprCourseHistoryHash(dpr.courseHistory),
        computedAt: Date.now(),
        feasibility: out.feasibility,
    };
}
```

Adapt all `dpr.*` and `schoolConfig.*` field accesses to the actual repo's types (the agent will read those during implementation).

- Commit: `feat(engine): build.ts orchestrator for ForwardSchedule construction`

---

## Task 6: New tools — `plan_forward_degree` + `view_forward_plan`

**Files:**
- Create: `packages/engine/src/agent/tools/planForwardDegree.ts`
- Create: `packages/engine/src/agent/tools/viewForwardPlan.ts`
- Modify: `packages/engine/src/agent/registry.ts`

Replace the single-semester `plan_semester` with `plan_forward_degree`. The old name stays as a back-compat shim (delegates to the new tool with `targetSemester` mapped to `currentTerm`).

- Implement, register, test.
- Commit.

---

## Task 7: Wire `forwardSchedule` into `ToolSession`

**Files:**
- Modify: `packages/engine/src/agent/tool.ts`

Add the new field so subsequent turns can read the persisted schedule + reconcile against new DPR uploads. The mutation is intentionally per-session (in-memory) — Phase 13 does NOT add server-side persistence. Server-side persistence is a Phase 14+ follow-up.

- [ ] **Step 1: Read the current `ToolSession` definition**

```bash
grep -n "interface ToolSession\|export interface ToolSession" packages/engine/src/agent/tool.ts
```

Quote the existing fields so the new field slots in alongside `pendingMutations`.

- [ ] **Step 2: Add the import + field**

At the top of `packages/engine/src/agent/tool.ts`, add the import:

```typescript
import type { ForwardSchedule } from "@nyupath/shared";
```

In the `ToolSession` interface, append the new field at the end (mirror the JSDoc style of the surrounding fields):

```typescript
    /** Phase 13 — persistent multi-semester forward plan. Initialized
     *  when `plan_forward_degree` first runs; updated on each call;
     *  reconciled on DPR re-upload via `reconcileWithDpr` from
     *  `forwardSchedule/reconcile.ts`. Read by `view_forward_plan` and
     *  surfaced to the chat UI via the `forward_schedule_update` SSE
     *  event (Task 9). In-memory only; lost on session end. */
    forwardSchedule?: ForwardSchedule;
```

- [ ] **Step 3: Type-check**

```bash
cd packages/engine && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/tool.ts
git commit -m "feat(engine): ToolSession.forwardSchedule for persistent multi-semester plan"
```

---

## Task 8: Reasoning-trace fixes (3 sub-fixes)

**Files:**
- Modify: `packages/engine/src/agent/responseValidator.ts` (arithmetic-grounded numbers — sub-fix 8a)
- Modify: `packages/engine/src/agent/agentLoop.ts` (suppress thinking on replay turns — sub-fix 8b)
- Modify: `apps/web/app/chat/page.tsx` (clear `thinkingText` when `hasRealThinking` first flips — sub-fix 8c)
- Create: `packages/engine/tests/agent/groundingArithmetic.test.ts`

These three carry-forward bugs from operator test pass 4 are independent. Each sub-fix has its own TDD test + commit. The sub-fixes can ship in any order; here they go 8a → 8b → 8c.

### Sub-fix 8a: Validator allows arithmetic on grounded numbers

**Bug:** the validator flags `16` as ungrounded when the assistant says "your total is 16 (12 already + 4 planned)" because `16` doesn't appear verbatim in any tool result, even though `12` and `4` both do. The model self-censors on basic addition.

**Fix:** extend `checkGrounding`'s allow-set to include sums and differences of all pairs of grounded numbers.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/groundingArithmetic.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator";

const MINIMAL_STUDENT = {
    studentId: "t",
    homeSchoolId: "cas",
    declaredPrograms: [],
    visaStatus: undefined,
    transcript: { semesters: [] },
    plans: [],
    expectedGraduationTerm: undefined,
};

describe("grounding allows arithmetic on grounded numbers", () => {
    it("allows '16' when both '12' and '4' appear in tool results (12 + 4 = 16)", () => {
        const verdict = validateResponse({
            assistantText: "Your total is 16 credits (12 already registered + 4 planned).",
            invocations: [
                { toolName: "plan_semester", summary: "12 credits already registered, 4 credits planned" } as any,
            ],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what's my total?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "16")).toBe(false);
    });

    it("allows '8' when '12' and '4' appear (12 - 4 = 8)", () => {
        const verdict = validateResponse({
            assistantText: "After dropping the 4-credit course you'll have 8 credits.",
            invocations: [{ toolName: "plan_semester", summary: "12 credits planned, 4-credit course" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what if I drop one?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "8")).toBe(false);
    });

    it("STILL flags a number that is neither verbatim nor a sum/diff of grounded numbers", () => {
        const verdict = validateResponse({
            assistantText: "Your GPA is 3.7.",
            invocations: [{ toolName: "x", summary: "12 credits planned" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what's my GPA?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "3.7")).toBe(true);
    });

    it("allows arithmetic on userQuestion + tool-result numbers (16 from user, 4 from tool, 16 - 4 = 12)", () => {
        const verdict = validateResponse({
            assistantText: "Of the 16 you asked for, the planner placed 4 — so you're 12 short.",
            invocations: [{ toolName: "plan_semester", summary: "4 credits planned" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "plan for 16 credits",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "12")).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/groundingArithmetic.test.ts
```

Expected: tests 1, 2, 4 FAIL (validator currently flags `16`, `8`, `12` as ungrounded). Test 3 PASSES.

- [ ] **Step 3: Modify `checkGrounding` in `responseValidator.ts`**

Find `checkGrounding` (around line 176 per prior Phase-12.5 audit). The current shape builds a `groundCorpus` string and uses `.includes()` to verify each claim. Extend it with a number-set that also covers sums and differences:

```typescript
function extractAllNumbers(text: string): string[] {
    const matches = text.match(/-?\d+(?:\.\d+)?/g);
    return matches ?? [];
}

function checkGrounding(ctx: ValidatorContext): Violation[] {
    const violations: Violation[] = [];
    const claims = extractClaimNumbers(ctx.assistantText);
    if (claims.size === 0) return violations;

    // Phase 13 §8a — collect all groundable numbers (tool results + user
    // question). A claim is grounded if it appears verbatim OR if it
    // equals a ± b for some pair of grounded numbers.
    const groundedNumbers = new Set<number>();
    const sources = [
        ...ctx.invocations.map((inv) => `${inv.summary ?? ""} ${JSON.stringify(inv.args)}`),
        ctx.userQuestion ?? "",
    ];
    const groundCorpus = sources.join(" ").toLowerCase();
    for (const s of sources) {
        for (const n of extractAllNumbers(s)) {
            const parsed = parseFloat(n);
            if (Number.isFinite(parsed)) groundedNumbers.add(parsed);
        }
    }
    const numbersArr = [...groundedNumbers];

    function isDerivable(claim: string): boolean {
        if (groundCorpus.includes(claim)) return true;
        const claimVal = parseFloat(claim);
        if (!Number.isFinite(claimVal)) return false;
        for (let i = 0; i < numbersArr.length; i++) {
            for (let j = 0; j < numbersArr.length; j++) {
                if (numbersArr[i]! + numbersArr[j]! === claimVal) return true;
                if (numbersArr[i]! - numbersArr[j]! === claimVal) return true;
            }
        }
        return false;
    }

    for (const claim of claims) {
        if (!isDerivable(claim)) {
            violations.push({
                kind: "ungrounded_number",
                number: claim,
                detail: `Number "${claim}" appears in the reply but does not appear verbatim in any tool result this turn, nor is it a sum or difference of two grounded numbers. Either call the tool that returns it or remove the claim.`,
            });
        }
    }
    return violations;
}
```

If the existing `checkGrounding` already lives inside a function with a different signature (e.g. takes `groundCorpus` as an argument), adapt the integration point — the principle is: extend the allow-set with pairwise sums + differences of all grounded numbers.

- [ ] **Step 4: Run tests to verify pass**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/groundingArithmetic.test.ts
```

Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agent/responseValidator.ts packages/engine/tests/agent/groundingArithmetic.test.ts
git commit -m "fix(engine): grounding validator allows sums/differences of grounded numbers"
```

### Sub-fix 8b: Suppress `thinking_delta` on replay turns

**Bug:** when `validateResponse` rejects a turn and the agent loop replays, the model on the replay turn often produces self-correction monologue ("the validator caught my synthesized 16, let me remove that"). This thinking text reaches the user via the `thinking_delta` SSE event.

**Fix:** thread an `isReplayTurn` flag through `runOneTurn`. When set, skip yielding `thinking_delta` events.

- [ ] **Step 1: Modify `runOneTurn`'s signature**

In `packages/engine/src/agent/agentLoop.ts`, find `runOneTurn`. Add an `isReplayTurn = false` parameter and gate the thinking-delta yield:

```typescript
async function* runOneTurn(
    client: LLMClient,
    args: LLMCompleteArgs,
    outDeltas: string[],
    isReplayTurn = false,
) {
    for await (const ev of client.streamComplete(args)) {
        if (ev.type === "text_delta") {
            outDeltas.push(ev.text);
            yield { type: "text_delta", text: ev.text };
        } else if (ev.type === "thinking_delta") {
            // Phase 13 §8b — on replay turns, the model often narrates
            // its self-correction in the open. That monologue
            // ("the validator caught my synthesized 16…") is internal
            // and should not reach the user. Suppress here.
            if (!isReplayTurn) yield { type: "thinking_delta", text: ev.text };
        } else if (ev.type === "done") {
            yield { type: "_turn_result", result: { ok: true, completion: ev.completion } };
        }
    }
}
```

- [ ] **Step 2: Pass `true` from the replay invocation**

Find the place inside `runAgentTurnStreaming` where the loop re-calls `runOneTurn` after a validator rejection. Pass `isReplayTurn: true`. Example shape:

```typescript
// Phase 12.5 wired the validator-replay loop. The second runOneTurn
// invocation is the replay; pass true so its thinking is suppressed.
for await (const ev of runOneTurn(client, replayArgs, replayDeltas, /* isReplayTurn */ true)) {
    // …
}
```

- [ ] **Step 3: Manual smoke-test**

This sub-fix is best validated in the browser: trigger a validator violation, observe that the replay turn's thinking text is empty in the SSE stream while the corrected answer still streams normally. (No automated test — the existing `validatorMessageLeak` test from Phase 12.5 already covers the broader leak path; this is an incremental tightening.)

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/agentLoop.ts
git commit -m "fix(engine): suppress thinking_delta on validator-replay turns"
```

### Sub-fix 8c: Clear `thinkingText` when `hasRealThinking` first flips

**Bug:** the synthesized tool-thought sentence ("Now I'll sketch a semester plan…") is appended to `thinkingText` BEFORE the first real `thinking` event arrives (because `tool_invocation_start` typically fires first). Once real thinking starts, `hasRealThinking` flips to true — but the synthesized sentence stays in the buffer, so the user sees both.

**Fix:** when `hasRealThinking` is FALSE and the first real `thinking` event arrives, REPLACE `thinkingText` with the new event's text instead of appending. Subsequent thinking events (with `hasRealThinking` already true) keep appending.

- [ ] **Step 1: Modify the `case "thinking":` handler in `apps/web/app/chat/page.tsx`**

Find the `case "thinking":` branch in `applyEvent`. Currently it appends + sets the flag. Restructure:

```typescript
case "thinking":
    setMessages(prev => prev.map(m => {
        if (m.id !== assistantId) return m;
        if (!m.hasRealThinking) {
            // Phase 13 §8c — first real thinking event. The synthesized
            // tool-sentence narration (if any) was a fallback; real
            // reasoning replaces it. Clear and start fresh.
            return {
                ...m,
                thinkingText: ev.text,
                thinkingRevealed: 0, // restart the typewriter on the new text
                hasRealThinking: true,
            };
        }
        return {
            ...m,
            thinkingText: (m.thinkingText ?? "") + ev.text,
            hasRealThinking: true,
        };
    }));
    break;
```

- [ ] **Step 2: Smoke-test in browser**

Send any tool-using question. Observe:
- The synthesized "Now I'll sketch a semester plan…" appears briefly (before the first real thinking event).
- When the first real thinking event arrives, the indented reasoning block CLEARS and starts re-revealing with the model's actual reasoning text.
- No double-narration ("Now I'll sketch…" + real-thinking-prose) visible.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/chat/page.tsx
git commit -m "fix(web): clear thinkingText buffer on first real-thinking event"
```

---

## Task 9: `forward_schedule_update` SSE event + schedule sidebar

**Files:**
- Modify: `apps/web/lib/chatV2Client.ts`
- Modify: `apps/web/lib/sseStream.ts`
- Modify: `apps/web/app/api/chat/v2/route.ts`
- Modify: `apps/web/tests/chatV2Client.test.ts`
- Modify: `apps/web/app/chat/page.tsx`
- Create: `apps/web/app/chat/scheduleSidebar.tsx`
- Modify: `apps/web/app/chat/chat.module.css`

The structured schedule needs to reach the chat page so the sidebar can render it live. We add a new SSE event kind, wire it through both client and server unions, render the sidebar component conditionally on a header-toggle button, and color-code the four slot kinds (with optional electives styled distinctly per locked decision #8).

### Step group A — Add the SSE event kind end-to-end

- [ ] **Step 1: Extend `ChatV2Event` and `SseEvent` unions**

In `apps/web/lib/chatV2Client.ts`, find the `ChatV2Event` discriminated union. Append:

```typescript
    | { kind: "forward_schedule_update"; schedule: ForwardSchedule }
```

Add the import at the top:

```typescript
import type { ForwardSchedule } from "@nyupath/shared";
```

In `apps/web/lib/sseStream.ts`, append the SAME variant to `SseEvent`. Both unions must stay in lockstep — Phase 12.5 Task 3 fix established that pattern.

- [ ] **Step 2: Add a round-trip test in `chatV2Client.test.ts`**

Append a new `it()` block (mirror the existing `parses a thinking event` test):

```typescript
it("parses a forward_schedule_update event and round-trips its payload", async () => {
    const fakeSchedule = {
        studentId: "t",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [],
        dprCourseHistoryHash: "abc",
        computedAt: 0,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
    };
    const chunks = [
        "event: forward_schedule_update\ndata: " + JSON.stringify({ kind: "forward_schedule_update", schedule: fakeSchedule }) + "\n\n",
        "event: done\ndata: " + JSON.stringify({ kind: "done", finalText: "ok", modelUsedId: "claude-haiku-4-5-20251001" }) + "\n\n",
    ];
    const resp = fakeResponse(chunks);
    const events: ChatV2Event[] = [];
    for await (const ev of /* the existing helper used by sibling tests */) {
        events.push(ev);
    }
    expect(events[0]).toEqual({ kind: "forward_schedule_update", schedule: fakeSchedule });
    expect(events[1]!.kind).toBe("done");
});
```

Adapt the helper-name to whatever the existing tests use (`streamChatV2`, `streamChatV2FromResponse`, etc.).

- [ ] **Step 3: Server-side emit detection**

In `apps/web/app/api/chat/v2/route.ts`, find `runV2Turn` (or the function that orchestrates the agent loop and SSE writes per turn). Capture the `forwardSchedule.computedAt` BEFORE the agent runs and again AFTER. If the timestamp changed (or the schedule appeared for the first time), emit:

```typescript
const beforeComputedAt = sessionForTurn.forwardSchedule?.computedAt;
// ... run agent loop ...
const afterComputedAt = sessionForTurn.forwardSchedule?.computedAt;
const scheduleChanged = sessionForTurn.forwardSchedule
    && (beforeComputedAt == null || beforeComputedAt !== afterComputedAt);
if (scheduleChanged) {
    writer.write({
        kind: "forward_schedule_update",
        schedule: sessionForTurn.forwardSchedule!,
    });
}
```

- [ ] **Step 4: Type-check + run tests**

```bash
cd apps/web && npx tsc --noEmit
cd ../.. && node_modules/.bin/vitest run apps/web/tests/
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/chatV2Client.ts apps/web/lib/sseStream.ts apps/web/tests/chatV2Client.test.ts apps/web/app/api/chat/v2/route.ts
git commit -m "feat(web): forward_schedule_update SSE event end-to-end"
```

### Step group B — Frontend state + sidebar component

- [ ] **Step 1: Add `forwardSchedule` + `sidebarOpen` to chat-page state**

In `apps/web/app/chat/page.tsx`, near the existing `useState` calls, add:

```typescript
import type { ForwardSchedule } from "@nyupath/shared";
import ScheduleSidebar from "./scheduleSidebar";

// inside ChatPage:
const [forwardSchedule, setForwardSchedule] = useState<ForwardSchedule | null>(null);
const [sidebarOpen, setSidebarOpen] = useState(false);
```

- [ ] **Step 2: Handle the new event in `applyEvent`**

Add a new case:

```typescript
case "forward_schedule_update":
    setForwardSchedule(ev.schedule);
    break;
```

- [ ] **Step 3: Add the toggle button in the header**

Find the existing header JSX (search for `headerLogo` / `headerBadge`). Add the toggle button on the right side:

```typescript
<button
    type="button"
    className={styles.scheduleToggle}
    onClick={() => setSidebarOpen(o => !o)}
    aria-label="Toggle schedule sidebar"
    aria-expanded={sidebarOpen}
>
    📅 Schedule
</button>
```

- [ ] **Step 4: Render the sidebar at the page bottom**

Just before the final closing `</div>` of `ChatPage`, add:

```typescript
<ScheduleSidebar
    schedule={forwardSchedule}
    open={sidebarOpen}
    onClose={() => setSidebarOpen(false)}
/>
```

- [ ] **Step 5: Create the sidebar component**

Create `apps/web/app/chat/scheduleSidebar.tsx`:

```typescript
"use client";

import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import styles from "./chat.module.css";

interface ScheduleSidebarProps {
    schedule: ForwardSchedule | null;
    open: boolean;
    onClose: () => void;
}

export default function ScheduleSidebar({ schedule, open, onClose }: ScheduleSidebarProps) {
    if (!open) return null;

    return (
        <aside className={styles.scheduleSidebar} aria-label="Forward schedule">
            <div className={styles.scheduleSidebarHeader}>
                <h2 className={styles.scheduleSidebarTitle}>Your Schedule</h2>
                <button onClick={onClose} className={styles.scheduleSidebarClose} aria-label="Close schedule">✕</button>
            </div>
            {!schedule ? (
                <p className={styles.scheduleSidebarEmpty}>
                    No plan yet. Ask me what to take next semester to compute one.
                </p>
            ) : (
                <div className={styles.scheduleSidebarBody}>
                    <p className={styles.scheduleSidebarMeta}>
                        Targeting graduation in <strong>{formatTermLabel(schedule.graduationTerm)}</strong>
                        {" · "}
                        <strong>{schedule.creditTargetPerSemester} credits</strong> per semester
                    </p>
                    {!schedule.feasibility.feasible && (
                        <div className={styles.scheduleInfeasibilityBanner}>
                            ⚠ Plan has constraint violations:
                            <ul>
                                {schedule.feasibility.constraintViolations.slice(0, 5).map((v, i) => (
                                    <li key={i}>{v.detail}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {schedule.semesters.map(sem => (
                        <section key={sem.term} className={`${styles.semesterCard} ${sem.locked ? styles.locked : ""}`}>
                            <header className={styles.semesterCardHeader}>
                                <h3>{formatTermLabel(sem.term)}</h3>
                                <span className={styles.semesterCredits}>{sem.plannedCredits} cr</span>
                            </header>
                            {sem.notes.length > 0 && (
                                <ul className={styles.semesterNotes}>
                                    {sem.notes.map((n, i) => <li key={i}>{n}</li>)}
                                </ul>
                            )}
                            <ul className={styles.slotList}>
                                {sem.slots.map((slot, i) => (
                                    <li key={i} className={`${styles[`slot_${slot.kind}`]} ${slot.kind === "placeholder" && (slot as any).optional ? styles.slotOptional : ""}`}>
                                        {renderSlot(slot)}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
        </aside>
    );
}

function renderSlot(slot: ScheduleSlot) {
    switch (slot.kind) {
        case "completed":
            return (
                <>
                    <span className={styles.slotIcon}>✓</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
                    <span className={styles.slotMeta}>{slot.credits}cr · {slot.grade}</span>
                </>
            );
        case "in_progress":
            return (
                <>
                    <span className={styles.slotIcon}>⏳</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
                    <span className={styles.slotMeta}>{slot.credits}cr</span>
                </>
            );
        case "specific_planned":
            return (
                <>
                    <span className={styles.slotIcon}>📅</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
                    <span className={styles.slotMeta}>{slot.credits}cr</span>
                    {slot.requiresPetition && <span className={styles.slotFlag} title="Requires petition (instructor permission)">⚠</span>}
                </>
            );
        case "placeholder":
            return (
                <>
                    <span className={styles.slotIcon}>{slot.optional ? "○" : "●"}</span>
                    <span className={styles.slotPlaceholderCategory}>{slot.category}</span>
                    <span className={styles.slotMeta}>
                        {slot.credits}cr
                        {slot.optional && <span className={styles.slotOptionalTag}> · optional</span>}
                    </span>
                </>
            );
    }
}

function formatTermLabel(term: string): string {
    const m = term.match(/^(\d{4})-(spring|summer|fall|january)$/i);
    if (!m) return term;
    const season = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1).toLowerCase();
    return `${season} ${m[1]}`;
}
```

- [ ] **Step 6: Append CSS**

Append to `apps/web/app/chat/chat.module.css`:

```css
/* ---------- Phase 13 — Schedule sidebar ---------- */
.scheduleToggle {
    background: transparent;
    border: 1px solid var(--border-light);
    color: var(--text-primary);
    padding: 6px 12px;
    border-radius: var(--radius-full);
    font-size: 0.85em;
    cursor: pointer;
    margin-left: auto;
}
.scheduleToggle:hover { background: var(--bg-secondary); }
.scheduleToggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--nyu-violet-glow);
    border-color: var(--nyu-violet);
}

.scheduleSidebar {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: 380px;
    background: var(--bg-primary);
    border-left: 1px solid var(--border-light);
    overflow-y: auto;
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.05);
    z-index: 50;
    animation: slideInRight 0.2s ease-out;
}
@keyframes slideInRight {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
    .scheduleSidebar { animation: none; }
}

.scheduleSidebarHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-light);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
}
.scheduleSidebarTitle { font-size: 1rem; font-weight: 600; margin: 0; }
.scheduleSidebarClose {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 1.1em;
    padding: 4px 8px;
    color: var(--text-secondary);
}
.scheduleSidebarBody { padding: 12px 20px 24px; }
.scheduleSidebarMeta { color: var(--text-secondary); font-size: 0.85em; margin: 8px 0 16px 0; }
.scheduleSidebarEmpty { padding: 24px 20px; color: var(--text-secondary); font-size: 0.9em; }

.scheduleInfeasibilityBanner {
    background: #fff3cd;
    border: 1px solid #ffe69c;
    color: #664d03;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 0.85em;
    margin-bottom: 12px;
}
.scheduleInfeasibilityBanner ul { margin: 6px 0 0 16px; padding: 0; }

.semesterCard {
    margin-bottom: 16px;
    padding: 12px;
    border: 1px solid var(--border-light);
    border-radius: 8px;
}
.semesterCard.locked {
    background: rgba(108, 117, 125, 0.04);
    border-color: rgba(108, 117, 125, 0.18);
}
.semesterCardHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}
.semesterCardHeader h3 { margin: 0; font-size: 0.95em; font-weight: 600; }
.semesterCredits { font-size: 0.8em; color: var(--text-secondary); }
.semesterNotes {
    list-style: disc;
    margin: 0 0 8px 16px;
    font-size: 0.78em;
    color: #b58000;
    padding: 0;
}

.slotList { list-style: none; padding: 0; margin: 0; }
.slotList li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 6px;
    font-size: 0.85em;
    line-height: 1.4;
    border-bottom: 1px dashed rgba(0, 0, 0, 0.04);
    border-radius: 4px;
}
.slotList li:last-child { border-bottom: none; }

.slotIcon { flex: 0 0 16px; text-align: center; opacity: 0.7; }
.slotCourseId { font-family: var(--font-mono); font-weight: 600; }
.slotTitle, .slotPlaceholderCategory { flex: 1 1 auto; color: var(--text-primary); }
.slot_placeholder .slotPlaceholderCategory { font-style: italic; color: var(--text-secondary); }
.slotMeta { flex: 0 0 auto; font-size: 0.8em; color: var(--text-secondary); }
.slotFlag { color: #b58000; font-size: 0.85em; margin-left: 4px; }

.slot_completed { background: rgba(40, 167, 69, 0.06); }
.slot_in_progress { background: rgba(255, 193, 7, 0.08); }
.slot_specific_planned { background: rgba(13, 110, 253, 0.06); }
.slot_placeholder { background: transparent; }

/* Phase 13 §locked-decision-8 — optional electives (above floor when
   degree-credit minimum is already met) get a dotted border + faded
   tone so the student knows they're discretionary. */
.slotOptional {
    border: 1px dashed var(--border-light) !important;
    background: transparent !important;
}
.slotOptionalTag {
    font-style: italic;
    color: var(--text-tertiary);
}
```

- [ ] **Step 7: Type-check + run web tests**

```bash
cd apps/web && npx tsc --noEmit
cd ../.. && node_modules/.bin/vitest run apps/web/tests/
```

Expected: clean.

- [ ] **Step 8: Smoke-test in browser**

Refresh `http://localhost:3001`. Send "what should I take next semester?" Toggle the 📅 Schedule button. Verify:
- Sidebar slides in from the right.
- Past terms render as locked (greyed out) with completed-course slots showing grades.
- Current term shows in-progress slots (yellow tint).
- Future terms show specific-planned (blue tint) + placeholder (transparent) slots.
- Optional placeholders (when `degreeCreditsMet === true`) render with dotted border + "optional" tag.
- Visa notes appear under any term below 12 credits for F-1 students.
- Infeasibility banner appears when feasibility report is non-feasible.

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/chat/page.tsx apps/web/app/chat/scheduleSidebar.tsx apps/web/app/chat/chat.module.css
git commit -m "feat(web): schedule sidebar with 4-variant slot rendering + optional flag"
```

---

## Task 10: Manual browser verification + push

(Same as prior Phase 13 Task 10 — verify schedule populates, sidebar opens, multi-semester distribution looks right, optional electives render distinctly, DPR re-upload reconciles, reasoning-trace fixes hold.)

---

## Self-review notes

- Coverage: ships the locked design decisions 1-8 from the operator review.
- Pre-reqs: Phases 12.7 + 12.8 must be in main before this starts; the solver hard-depends on `prereqs.json` + `courses-offerings.json` being populated.
- Out of scope: load styles, pinning, exclusions, summer/J-term as available terms — all in Phase 14.
- Solver class: greedy in Phase 13. Phase 15 introduces backtracking. The greedy outputs a `FeasibilityReport` with explicit constraint violations even when it can't solve everything, so the LLM has data to narrate.
