# Phase 14 — Preferences, Overrides, and Failure-Mode Fallbacks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Architectural principle (read first)

**Plan with available data + sensible defaults; ask the student only when input would change a trade-off.**

The planner ALWAYS ships a plan. Defaults are concrete answers, not "unknown" gaps. Validators distinguish verified-pass from assumed-pass from requires-approval (Decision #40 — `ValidationResult` 4-state union, defined in Phase 13). The plan ships in all three cases; the agent's surfacing language differs per axis.

For Phase 14 specifically: this phase introduces **student-driven overrides** (load styles, pins, exclusions, summer/J-term opt-in, free-elective binding). Each override flows through the two-step `propose_plan_change` → `confirm_plan_change` pattern so the student sees consequences (`PlanDiff` per Decision #23, including `balanceImpact` from #25 and `validationResultsChanges` from #40) before committing. **Student confirmation is the highest authority** (Decision #13) — confirmed plans are written even when they deviate from solver-optimal, but the agent surfaces consequences honestly using the validator metadata it already has. When the requested override produces an `infeasible-draft` plan (Decision #32), the plan is written to `session.studentDraftPlan` (NEVER `session.forwardSchedule`); the agent surfaces 2–3 alternatives via `simulate_alternatives` and lets the student pick.

**Workload-language convention:** when discussing per-term workload, the agent uses epistemically-honest phrasing — "this term appears lighter / heavier based on available course metadata" rather than absolute claims like "this semester is easy." Same convention for `slot.requiresPetition`, `slot.confidence`, and validator results: distinguish verified from assumed from requires-approval. (See Decision-flavor convention block below the locked-decisions table.)

**Unmodeled-factor fallback (Decision #42):** When the student states a preference, classify the constraint framing FIRST — hard (non-negotiable: work, childcare, religious, athletic, medical, financial) vs. soft. Then apply the 4-tier hierarchy: (A) deterministic extraction if the factor maps to a modeled field; (B) top-K alternative-plan comparison via `compare_plan_alternatives` (Decision #44) for soft factors with axis-aligned variation; (C) clarification dialogue for hard factors no candidate satisfies AND for any soft factor the agent isn't confident about; (D) `HEURISTIC_MAPPING` assumption as last resort, **HARD-FORBIDDEN for hard constraints** (TypeScript-enforced via the `studentConstraintFraming: "soft"` literal-type discriminator). Never silently translate.

**Before implementing:** read `docs/PHASE_PLANS_README.md` (full 46-decision canonical list + cross-phase execution order + pre-flight verification table). The pre-flight checks must pass before the first code change in this phase.

---

**Goal:** Take Phase 13's balanced multi-semester planner and turn it into a full-fidelity planner that lets the student steer: pick a load style ("I want a chill spring" / "compact things into fall"), pin specific courses to specific terms, exclude courses, and consider summer / J-term when the standard schedule can't reach graduation. The planner ALWAYS produces a graduation-feasible plan; when it can't with the requested constraints, it surfaces 2-3 alternatives ("add summer", "delay grad by 1 term") and the student picks. **Student confirmation is the highest authority** — confirmed plans are written even when they deviate from solver-optimal.

**Architecture:** Three additive layers on top of Phase 13's solver:

1. **Preferences layer** — A new `SchedulePreferences` object on `ToolSession` carries: `loadStyle`, `loadStylePerTerm`, `creditTargetPerTerm`, `pins`, `exclusions`, `includeSummer`, `includeJTerm`, `allowBelowF1Floor`. The solver reads it as additional constraints (load style → placement-order heuristic; pins → hard placement; exclusions → blocked candidates; summer/J-term → opt-in available terms).

2. **LLM-shell layer** — System-prompt rules extract preferences from natural language ("a free spring" → `{loadStylePerTerm: {"2027-spring": "light"}}`). Two new tools: `propose_plan_change` (read-only — runs the solver hypothetically and returns a diff + consequences), `confirm_plan_change` (applies). Plus `simulate_alternatives` for failure-mode rescue.

3. **Failure-mode layer** — When the solver returns `feasible: false`, `simulate_alternatives` generates 2-3 candidates (add summer; add J-term; extend graduation; lower credit target). The LLM presents them and the student picks.

**Tech Stack:** Same as Phase 13 — TypeScript, Zod, vitest, Next.js, React.

**Prerequisites:**
- **Phase 13** complete and in production. The solver, `ForwardSchedule`, sidebar, and SSE event are all live. **Specifically required from Phase 13:**
  - `ValidationResult` 4-state union (Decision #40) and `PlanState` 4-state union (Decision #32) defined in `packages/shared/src/types.ts`
  - `ScheduleSlot` discriminated union with `placeholder` variant carrying the `PlaceholderSlot` tagged-union shape (Decision #38) — `bind_free_elective` and `bind_pool_slot` (Task 6 here) dispatch on `slot.type`
  - `packages/engine/src/agent/forwardSchedule/balanceScore.ts` exporting `computeBalanceScore` + `classifyBalanceDelta` — `propose_plan_change`'s `PlanDiff.balanceImpact` (Decision #25) calls these
  - `packages/engine/src/agent/forwardSchedule/workloadTier.ts` exporting `classifyWorkloadTier` — `bind_free_elective` recomputes `workloadWeight` on bind (Decision #37)
  - `packages/engine/src/dpr/prereqSatisfaction.ts` exporting `isPrereqSatisfied` — binding tools validate prereqs at the slot's term
  - `packages/engine/src/agent/forwardSchedule/graduationPathValidator.ts` exporting `runGraduationPathValidator` — Stage-7 revalidation per Decision #36 after each binding

**Required by:**
- **Phase 15** (FOSE section materialization) — Phase 15's `materialize_sections` consumes the structural plan + preferences shaped by Phase 14. Phase 14's `propose_plan_change` `PlanDiff.validationResultsChanges` (per Decision #40) lets Phase 15 surface "your F-1 online-credit axis flipped from `assumed-pass` to verified `pass`" cleanly.

**Out of scope (Phase 15+):**
- Live FOSE section materialization for the immediate term (Phase 15)
- Time-conflict detection (Phase 15)
- Drag-to-reorder slots in the sidebar
- Server-side persistence of preferences to Postgres (in-session memory only)
- Honors thesis 2-term blocks
- Study-abroad term modeling
- CPT / internship credit adjustments

---

## Locked design decisions (Phase 14 additions)

These extend the Phase 13 set with Phase 14 specifics.

| # | Decision | Behavior |
|---|---|---|
| 9 | Load styles | 5 modes: `balanced` (default, slack-based), `frontload` (place hard reqs early), `backload` (defer hard reqs), `light` (per-term override; pulls credit target down to floor), `heavy` (per-term override; pushes up to ceiling). `part-time` mode is domestic-only and requires explicit student `allowBelowF1Floor: true`. **Extended by Decision #26** — per-term `light`/`heavy` overrides also bias Stage 5 candidate ranking by workload-tier so the override applies to BOTH credit count AND workload character (otherwise a `light` term ends up at credit-floor but still all hard courses). |
| 10 | Pinning | Two-step (`propose_plan_change` → `confirm_plan_change`). Hard constraint in solver. If pin is infeasible (offering pattern, prereq), propose returns the conflict + a no-pin fallback. |
| 11 | Exclusions | Same shape as pins, inverse: courseId is filtered out of candidates for the given term (or globally). |
| 12 | Summer / J-term | Off by default. When the standard schedule infeasible, `simulate_alternatives` proposes adding them. When student opts in (via preferences), they become available terms in the solver. |
| 13 | Confirmation = highest authority | Student-confirmed plan is written to `session.forwardSchedule` even when it deviates from the recommendation. The agent surfaces consequences but doesn't override. |
| 14 | Co-requisite enforcement | **Status updated 2026-05-03.** Phase 12.8 actually populated `coreqs` from bulletin where present (16 curated + extractor-pass entries). Phase 13's `prereqSatisfaction.ts` (per Decision #4) already treats coreqs identically to prereqs but with `≤ T` (same-term allowed). What Phase 14 adds: (a) the parser EXTENSION for unbracketed / non-standard coreq phrasings the Phase 12.8 regex missed, and (b) the explicit MUST-BE-SAME-TERM solver constraint (currently coreqs are *allowed* to land same-term; Phase 14 makes it *required*). |
| 15 | Failed-course retake | **Subsumed by Decision #4's optimistic-forward-projection** (see Phase 13 plan). DPR rows with type EN/TE that fail their satisfaction check appear in `unmetRequirements` automatically; solver places them normally and downstream courses chain off the new placement (because `prereqSatisfaction.ts` accepts the future-plan placement as overriding the past failure per NYU's "most recent grade counts" policy). No separate logic needed in Phase 14. |
| 23 | `propose_plan_change` accepts a mutation array + returns structured `PlanDiff` | Tool input: `{mutations: PlanMutation[]}` where `PlanMutation = {kind: "pin", courseId, term} \| {kind: "exclude", courseId, term?: Term} \| {kind: "swap", drop, add, term} \| {kind: "addTerm", term} \| {kind: "loadStyleOverride", term?, style} \| {kind: "bindFreeElective", slotId, courseId} \| {kind: "unbindFreeElective", slotId} \| {kind: "bindPoolSlot", slotId, courseId} \| {kind: "setSchedulingPreference", value} \| {kind: "clearSchedulingPreference"}`. Output: `{newSchedule?: ForwardSchedule, diff?: PlanDiff, infeasibility?: InfeasibilityReport}`. The `PlanDiff` shape: `{creditsByTermDelta, graduationTermShift, newRequiresPetition, removedRequiresPetition, newUnmetRequirements, cascadedShifts (per #22c), weightedCreditsByTermDelta (#24), workloadTierShifts (#24), balanceImpact (#25), newAssumptions: Assumption[] (#30), validationResultsChanges: Record<axis, {before: ValidationResult, after: ValidationResult}> (#40 — surfaces transitions like "F-1 onlineLimit: assumed-pass → requires-approval" so agent flags newly-introduced trade-offs), planStateChange?: { from: PlanState, to: PlanState } (#32, 4-state)}`. Cascade list from #22c. New mutation kinds for #28 + #37. **`setSchedulingPreference` / `clearSchedulingPreference` mutation kinds (per Decision #43) are defined-but-unused at Phase 14** — Phase 15's `materialize_sections` is the first reader of `SchedulingPreferences`. The shape lands here so the mutation array doesn't version-skew across phases. Multi-mutation enables compound counterfactuals in one call. |
| 26 | Per-term `light`/`heavy` overrides are workload-tier-aware at BOTH ranking and optimization stages | Decision #9 specifies the credit-target adjustment. Decision #26 extends the semantics so the override applies to BOTH credit count AND workload character — otherwise a `light` Spring 2027 lands at 12 credits but still 3 hard major-required courses, defeating the student intent. **For per-term `light`:** (a) credit target → floor (Decision #9 unchanged), (b) Stage 5 candidate ranking multiplies priority by `(1 − 0.3 × slot.workloadWeight)` for that term — soft preference for free/general electives, (c) Stage 7 redistribution naturally pulls hard courses out due to lower credit cap (Decision #24 emergent behavior, made explicit). **For per-term `heavy`:** (a) credit target → ceiling, (b) Stage 5 multiplies by `(1 + 0.3 × slot.workloadWeight)` — soft preference for hard courses landing here, (c) Stage 7 tolerates higher hardCount. **Hard constraints win:** if a course's `earliestPossibleTerm` is the constrained term (no other valid window per prereqs/offerings), the solver places it there regardless. Override influences ranking, not constraint validity. **Paired overrides** ("Fall heavy so Spring is light") flow as two `loadStyleOverride` entries in one `propose_plan_change` mutation array; solver applies both simultaneously and `PlanDiff.balanceImpact` (Decision #25) classifies whether the swap-style intent improved or degraded overall balance. |
| 37 (binding tools) | Free-elective placeholder binding workflow + tools | Phase 13 ships solver-side placeholder semantics (per #37 solver-side). Phase 14 ships the **student-facing binding workflow**: (a) after structural plan is approved, agent identifies `placeholder-pending` slots in IMMEDIATE-NEXT term only, (b) agent prompts student to pick courses (or asks for suggestions via `search_courses` filtered to easy electives), (c) student picks → agent calls new tool **`bind_free_elective(slotId, courseId)`** which validates (offered in T+1, prereqs satisfied, not duplicate) → computes new `workloadWeight` → runs Stage 6d invariants + Stage 7 revalidation (#36) → returns workload-recheck verdict (warning level depends on weight delta from placeholder's 0.3: ≤0.2 → no warning; 0.2-0.7 → mild warning; >0.7 OR balanceImpact `degraded-*` → strong warning). New `PlanMutation` variants: `{kind: "bindFreeElective", slotId, courseId}` and `{kind: "unbindFreeElective", slotId}` for re-binding through `propose_plan_change`. Boundary rules: only IMMEDIATE-next term prompts; future placeholders re-prompt as time advances; "skip" is valid. |
| 28 (binding tools) | `bindPoolSlot` mutation for choose_n pool late-binding | Phase 13 ships solver-side pool-slot semantics (per #28 solver-side). Phase 14 adds the student-facing tool. New `PlanMutation` variant: `{kind: "bindPoolSlot", slotId, courseId}` (must be in `slot.poolBinding.candidates`). Runs the same workload recheck + Stage-7 revalidation pattern as `bindFreeElective`, but additionally enforces the choose_n pool constraint (`Σ over pool members ≥ N` still satisfiable after binding). |
| 42 | 4-tier fallback hierarchy for unmodeled student factors | Layered fallback when student input doesn't map to a Tier-A modeled field. **Constraint framing classified FIRST** — hard (work, childcare, religious, athletic, medical, financial, legal/visa) vs. soft. Hard constraints route ONLY through Tier A or Tier C. **Tier A** — modeled extraction (Decisions #9–#15, #23, #26, #43). **Tier B** — `compare_plan_alternatives` tool reads `ForwardSchedule.alternativeCandidates` (Decision #44 emission), LLM picks among ≤5 candidates by structured comparison; emits `LLM_RANKED_ALTERNATIVE` Assumption; plan ships `valid-with-trade-offs`. **Tier C** — clarification dialogue when no candidate satisfies a hard constraint OR agent lacks confidence. **Tier D** — `HEURISTIC_MAPPING` Assumption, soft constraints ONLY, **HARD-FORBIDDEN for hard constraints** because asymmetric stakes — a wrong Tier-B pick is recoverable; a wrong Tier-D mapping of "I can't take Friday classes because of childcare" ships a plan that breaks the student's actual life. **3-layer enforcement: (Layer 1)** the renumbered Task 8 system-prompt rule states "Tier D is FORBIDDEN for hard constraints" explicitly. **(Layer 2)** schema discriminator: `HEURISTIC_MAPPING.studentConstraintFraming: "soft"` is a literal type — a hard-framed instance is a TypeScript compile-time error, not a prompt-rule violation. **(Layer 3)** the renumbered Task 8 eval suite includes a Tier-D-negative bucket (≥10 fixtures, ≥85% accuracy) that fails if the LLM emits Tier D for a hard-framed constraint. All three layers must land or the asymmetric-stakes principle is unenforced. |
| 44 (consumer) | `compare_plan_alternatives` consumes Decision #44's top-K emission | Phase 13's solver emits `ForwardSchedule.alternativeCandidates: AlternativePlanSummary[]` (≤5) as a free byproduct of Stage 7 distribution-selection. Phase 14 adds the **read-only** student-facing tool `compare_plan_alternatives(studentStatedFactor, dimensions?)` that returns `{plansSummarized: AlternativePlanSummary[], dimensionsConsidered: string[], decisionFraming: "Tier B per Decision #42"}`. When `alternativeCandidates` is absent or empty, the tool returns `{plansSummarized: [], decisionFraming: "no alternatives available; route to Tier C clarification or (soft-only) Tier D heuristic mapping"}` — the agent reads this and routes accordingly; the tool never makes the tier decision itself. The tool is **strictly read-only**: `isReadOnly: true`, MUST NOT mutate `session.forwardSchedule` under any branch (test asserts byte-identical session after call). Mutation only happens via the existing `confirm_plan_change` two-step pattern AFTER the student confirms. Default `dimensions` if none specified: `balanceScore`, `distinctSubjectsCount`, `totalPetitionCount`, `hardCount-evenness`. |

### Phase 14 agent-prompt convention (Decision-flavor; not numbered)

**Workload language:** When discussing per-term workload to the student, the agent must use epistemically-honest phrasing: prefer "this term appears lighter / heavier based on available course metadata" over absolute claims like "this semester is easy / hard." The workload-tier metric (Decision #24 + #35) captures program-rule + course-level + writing/lab/level/capstone signals, but does NOT have access to professor-specific workload, RMP-style ratings, or course-evaluation data (those were dropped per the Phase 16 decision). The agent's surfacing language must reflect this epistemic limit. Example correct phrasing: "Based on available course metadata, Spring 2027 appears heavier than your other terms — 4 hard courses + 0 free electives." Example incorrect phrasing: "Spring 2027 is objectively your hardest term." Same convention applies when explaining `slot.requiresPetition`, `slot.confidence`, and `Decision #40` validator results — distinguish "verified" from "assumed" / "requires approval" in the language. |

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/types.ts` | **Modify** | Add `SchedulePreferences`, `PlanChangeProposal`, `PlanChangeOutcome`, `AlternativeCandidate` types. |
| `packages/engine/src/agent/tool.ts` | **Modify** | Add `schedulePreferences?: SchedulePreferences` to `ToolSession`. |
| `packages/engine/src/agent/forwardSchedule/solver.ts` | **Modify** | Read preferences; apply load-style ordering; honor pins as hard placements; honor exclusions; opt-in summer / J-term in `enumerateMainTerms`. |
| `packages/engine/src/agent/forwardSchedule/alternatives.ts` | **Create** | `simulateAlternatives()` — generates 2-3 candidate `ForwardSchedule`s when solver is infeasible. |
| `packages/engine/src/agent/tools/proposePlanChange.ts` | **Create** | Read-only tool; validates a proposed change; returns `PlanChangeOutcome`. |
| `packages/engine/src/agent/tools/confirmPlanChange.ts` | **Create** | Apply tool; writes preferences; re-runs solver. |
| `packages/engine/src/agent/tools/simulateAlternatives.ts` | **Create** | Surface tool that wraps `simulateAlternatives()`. |
| `packages/engine/src/agent/registry.ts` | **Modify** | Register the three new tools. |
| `packages/engine/src/agent/systemPrompt.ts` | **Modify** | Add system-prompt section for natural-language → preference extraction. |
| `tools/bulletin-parser/extractCoreqs.ts` | **Create** | Phase-12.8-style parser specifically for co-requisite clauses. Output extends `prereqs.json` `coreqs` field. |
| `packages/engine/src/agent/tools/bindFreeElective.ts` | **Create** | Per Decision #37 binding workflow. Takes `{slotId, courseId}`. Validates (course offered in slot's term, prereqs satisfied per `prereqSatisfaction.ts`, not a duplicate of another slot, courseId is real). Computes new `workloadWeight` via `workloadTier.ts` (#24 + #35). Runs Stage 6d invariants + Stage 7 revalidation (#36). Returns workload-recheck verdict per the table in #37 (no warning / mild / strong) plus an updated `PlanDiff`. Tool is read-only at the proposal stage — pairs with `confirm_plan_change` for application. |
| `packages/engine/src/agent/tools/bindPoolSlot.ts` | **Create** | Per Decision #28 binding workflow. Takes `{slotId, courseId}`. courseId must be in `slot.poolBinding.candidates`. Same revalidation pattern as `bindFreeElective` plus enforces the choose_n pool constraint (Σ over pool members ≥ N still satisfiable). |
| `packages/engine/tests/agent/freeElectiveBinding.test.ts` | **Create** | Tests covering: easy course bind → no warning; medium course (W-suffix elective) → mild warning; advanced course (Quantum Field Theory as "free elective") → strong warning + `balanceImpact: degraded-mild` flag; invalid courseId → reject; course not offered in slot's term → reject; re-binding via unbind+bind sequence preserves placeholder-pending state. |
| `apps/web/app/chat/scheduleSidebar.tsx` | **Modify** | Add load-style pills + click-to-edit slot popover. |
| `apps/web/app/chat/page.tsx` | **Modify** | Wire click-to-edit interactions through `propose_plan_change` round-trips. |
| `packages/engine/tests/agent/preferenceExtraction.eval.ts` | **Create** | Eval suite for natural-language → preference mapping. |
| `packages/engine/tests/agent/solverPreferences.test.ts` | **Create** | Solver tests with preferences (load styles, pins, exclusions). |
| `packages/engine/tests/agent/alternatives.test.ts` | **Create** | `simulateAlternatives` tests. |
| `packages/engine/tests/agent/proposePlanChange.test.ts` | **Create** | `propose_plan_change` + `confirm_plan_change` integration. |

---

## Task 1: Define preferences + change-proposal types

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add the new types**

Append to `packages/shared/src/types.ts`:

```typescript
/**
 * Phase 14 — Per-student preferences governing how the solver
 * distributes credits and respects student-driven overrides. All
 * fields are optional; absent fields use Phase 13 defaults.
 */
export interface SchedulePreferences {
    /** Default load style for terms without a per-term override. */
    loadStyle?: "balanced" | "frontload" | "backload";
    /** Per-term overrides. "light" pulls credit target to the F-1 floor (12)
     *  or part-time (8); "heavy" pushes up to the ceiling. */
    loadStylePerTerm?: Record<string, "light" | "heavy" | "balanced">;
    /** Numeric per-term target (overrides `loadStylePerTerm` when both set). */
    creditTargetPerTerm?: Record<string, number>;
    /** Specific course → specific term (hard constraint). */
    pins?: Array<{ courseId: string; term: string }>;
    /** Course IDs (or term + courseId pairs) the planner must NOT place. */
    exclusions?: Array<{ courseId: string; term?: string }>;
    /** Opt-in extra terms. Off by default. */
    includeSummer?: boolean;
    includeJTerm?: boolean;
    /** When true, allow plans that drop below F-1 floor with explicit
     *  student acknowledgement. Default false. */
    allowBelowF1Floor?: boolean;
}

export interface PlanChangeProposal {
    kind: "pin" | "exclude" | "load_style" | "credit_target" | "include_summer" | "include_jterm" | "allow_below_floor";
    payload: Record<string, unknown>;
}

export interface PlanChangeOutcome {
    feasible: boolean;
    /** Diff against the current schedule. */
    diff: {
        added: Array<{ term: string; slot: ScheduleSlot }>;
        removed: Array<{ term: string; slot: ScheduleSlot }>;
    };
    /** Human-readable consequences ("Spring 2027 will be 18 credits"). */
    consequences: string[];
    /** When `feasible: false`, why. */
    conflicts?: Array<{ kind: string; detail: string }>;
}

/** A candidate alternative when the primary solve is infeasible. */
export interface AlternativeCandidate {
    /** One-sentence summary: "Add summer term to graduate by Aug 2026". */
    summary: string;
    /** What relaxation was applied to make it feasible. */
    relaxation: "include_summer" | "include_jterm" | "extend_grad_one_term" | "extend_grad_one_year" | "lower_credit_target";
    /** The resulting feasible schedule (if the relaxation worked). */
    schedule: ForwardSchedule | null;
    /** When `schedule === null`, why even this relaxation didn't help. */
    stillInfeasibleReason?: string;
}
```

- [ ] **Step 2: Type-check**

```bash
cd packages/shared && npx tsc --noEmit
cd ../engine && npx tsc --noEmit
cd ../../apps/web && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): SchedulePreferences + PlanChangeProposal + AlternativeCandidate types"
```

---

## Task 2: Wire `schedulePreferences` into `ToolSession`

**Files:**
- Modify: `packages/engine/src/agent/tool.ts`

- [ ] **Step 1: Add the field**

In `packages/engine/src/agent/tool.ts`, alongside the Phase 13 `forwardSchedule` field:

```typescript
import type { SchedulePreferences } from "@nyupath/shared";

// inside ToolSession:
    /** Phase 14 — student-driven preferences for the forward planner.
     *  Mutated by `confirm_plan_change`; read by `solveForwardSchedule`
     *  when computing the next plan. In-memory; lost on session end. */
    schedulePreferences?: SchedulePreferences;
```

- [ ] **Step 2: Type-check + commit**

```bash
cd packages/engine && npx tsc --noEmit
git add packages/engine/src/agent/tool.ts
git commit -m "feat(engine): ToolSession.schedulePreferences for Phase-14 planner steering"
```

---

## Task 3: Solver — load-style ordering + pins + exclusions

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/solver.ts`
- Create: `packages/engine/tests/agent/solverPreferences.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/tests/agent/solverPreferences.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver";
import type { SolverInput } from "../../src/agent/forwardSchedule/types";
import type { SchedulePreferences } from "@nyupath/shared";

function makeInput(prefs: SchedulePreferences = {}, overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        // ... reuse the makeInput helper from forwardScheduleSolver.test.ts
        // with `preferences: prefs` added.
    } as SolverInput;
}

describe("solveForwardSchedule — load styles", () => {
    it("frontload places hard requirements in the EARLIEST term first", () => {
        const input = makeInput({ loadStyle: "frontload" }, {
            unmetRequirements: [
                { rId: "r1", title: "X", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA X"] },
            ],
            offerings: new Map([["CSCI-UA X", ["fall", "spring"]]]),
            courseCatalog: new Map([["CSCI-UA X", { title: "X", credits: 4 }]]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        expect(fall.slots.some(s => s.kind === "specific_planned" && s.courseId === "CSCI-UA X")).toBe(true);
    });

    it("backload places hard requirements in the LATEST term", () => {
        const input = makeInput({ loadStyle: "backload" }, {
            unmetRequirements: [
                { rId: "r1", title: "X", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA X"] },
            ],
            offerings: new Map([["CSCI-UA X", ["fall", "spring"]]]),
            courseCatalog: new Map([["CSCI-UA X", { title: "X", credits: 4 }]]),
        });
        const out = solveForwardSchedule(input);
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        expect(spring.slots.some(s => s.kind === "specific_planned" && s.courseId === "CSCI-UA X")).toBe(true);
    });

    it("loadStylePerTerm 'light' pulls credit target down to F-1 floor", () => {
        const input = makeInput({ loadStylePerTerm: { "2027-spring": "light" } }, {
            unmetRequirements: [],
        });
        const out = solveForwardSchedule(input);
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        expect(spring.plannedCredits).toBe(12); // F-1 floor for light
    });

    it("loadStylePerTerm 'heavy' pushes credit target up to school ceiling", () => {
        const input = makeInput({ loadStylePerTerm: { "2027-spring": "heavy" } }, {
            unmetRequirements: [],
        });
        const out = solveForwardSchedule(input);
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        expect(spring.plannedCredits).toBe(18); // ceiling for heavy
    });
});

describe("solveForwardSchedule — pins", () => {
    it("places a pinned course in the pinned term as a hard placement", () => {
        const input = makeInput({ pins: [{ courseId: "CSCI-UA X", term: "2026-fall" }] }, {
            unmetRequirements: [
                { rId: "r1", title: "X", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA X"] },
            ],
            offerings: new Map([["CSCI-UA X", ["fall", "spring"]]]),
            courseCatalog: new Map([["CSCI-UA X", { title: "X", credits: 4 }]]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        expect(fall.slots.some(s => s.kind === "specific_planned" && s.courseId === "CSCI-UA X")).toBe(true);
    });

    it("flags a pin_conflict when the pinned term doesn't match the offering pattern", () => {
        const input = makeInput({ pins: [{ courseId: "CSCI-UA 421", term: "2026-fall" }] }, {
            unmetRequirements: [
                { rId: "r1", title: "421", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 421"] },
            ],
            offerings: new Map([["CSCI-UA 421", ["spring"]]]), // spring-only
            courseCatalog: new Map([["CSCI-UA 421", { title: "Software Engineering", credits: 4 }]]),
        });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => /offering_pattern|pin_conflict/.test(v.kind))).toBe(true);
    });
});

describe("solveForwardSchedule — exclusions", () => {
    it("does NOT place a course present in exclusions", () => {
        const input = makeInput({ exclusions: [{ courseId: "CSCI-UA 421" }] }, {
            unmetRequirements: [
                { rId: "r1", title: "421", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 421"] },
            ],
            offerings: new Map([["CSCI-UA 421", ["fall", "spring"]]]),
            courseCatalog: new Map([["CSCI-UA 421", { title: "Software Engineering", credits: 4 }]]),
        });
        const out = solveForwardSchedule(input);
        const placed = out.semesters.flatMap(s => s.slots).find(s => "courseId" in s && s.courseId === "CSCI-UA 421");
        expect(placed).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/solverPreferences.test.ts
```

Expected: all FAIL — preferences don't yet exist on `SolverInput`.

- [ ] **Step 3: Extend `SolverInput` and the solver**

In `packages/engine/src/agent/forwardSchedule/types.ts`, add `preferences?: SchedulePreferences` to `SolverInput`.

In `packages/engine/src/agent/forwardSchedule/solver.ts`:

(a) Add `termsForPlacement` helper that reads the load style:

```typescript
function termsForPlacement(
    futureTerms: string[],
    perTermCredits: Map<string, number>,
    target: number,
    preferences: SchedulePreferences | undefined,
): string[] {
    if (preferences?.loadStyle === "frontload") return [...futureTerms]; // earliest first
    if (preferences?.loadStyle === "backload") return [...futureTerms].reverse();
    return termsBySlack(futureTerms, perTermCredits, target).map(x => x.term);
}
```

(b) Replace the call to `termsBySlack(...)` inside the candidate loop with a call to `termsForPlacement(..., input.preferences)`.

(c) Add a per-term credit-target override BEFORE the candidate loop:

```typescript
function effectiveTermTarget(term: string, defaultTarget: number, preferences: SchedulePreferences | undefined, f1Floor: number | null, ceiling: number): number {
    const explicit = preferences?.creditTargetPerTerm?.[term];
    if (explicit != null) return explicit;
    const styleOverride = preferences?.loadStylePerTerm?.[term];
    if (styleOverride === "light") return f1Floor ?? defaultTarget;
    if (styleOverride === "heavy") return ceiling;
    return defaultTarget;
}
```

Replace `input.creditTargetPerSemester` references in the slack/fill paths with `effectiveTermTarget(term, input.creditTargetPerSemester, input.preferences, input.f1Floor, input.creditCeiling)`.

(d) BEFORE the candidate loop, walk `input.preferences?.pins ?? []`. For each pin:

```typescript
for (const pin of input.preferences?.pins ?? []) {
    if (!futureTerms.includes(pin.term)) {
        violations.push({ kind: "other", course: pin.courseId, detail: `Pinned to ${pin.term}, not a future term in the plan window.` });
        continue;
    }
    const offered = input.offerings.get(pin.courseId);
    const seasonOnly = pin.term.split("-")[1] as "fall" | "spring";
    if (offered && !offered.includes(seasonOnly)) {
        violations.push({ kind: "offering_pattern", course: pin.courseId, term: pin.term, detail: `${pin.courseId} pinned to ${pin.term}, but offering pattern is ${offered.join(", ")}.` });
        continue;
    }
    // Place directly.
    const meta = input.courseCatalog.get(pin.courseId);
    if (!meta) {
        violations.push({ kind: "other", course: pin.courseId, detail: `Pinned course not in catalog.` });
        continue;
    }
    const slot: ScheduleSlot = {
        kind: "specific_planned",
        courseId: pin.courseId,
        title: meta.title,
        credits: meta.credits,
        satisfiesRules: [],
        reason: `Pinned by student preference to ${pin.term}.`,
    };
    perTermSlots.get(pin.term)!.push(slot);
    perTermCredits.set(pin.term, (perTermCredits.get(pin.term) ?? 0) + meta.credits);
    placedBefore.add(pin.courseId);
}
```

(e) Filter `candidates` against exclusions BEFORE the candidate loop:

```typescript
const excludedSet = new Set((input.preferences?.exclusions ?? []).map(e => e.courseId));
const filteredCandidates = candidates.filter(c => !excludedSet.has(c.courseId));
```

Use `filteredCandidates` in place of `candidates` from then on.

- [ ] **Step 4: Run tests to verify pass**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/solverPreferences.test.ts
```

Expected: 7/7 PASS.

- [ ] **Step 5: Run full engine suite to confirm no regression**

```bash
node_modules/.bin/vitest run packages/engine/tests/
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/forwardSchedule/solver.ts packages/engine/src/agent/forwardSchedule/types.ts packages/engine/tests/agent/solverPreferences.test.ts
git commit -m "feat(engine): solver honors load styles + pins + exclusions"
```

---

## Task 4: Alternatives generator (failure-mode fallback)

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/alternatives.ts`
- Create: `packages/engine/tests/agent/alternatives.test.ts`

When the primary solve returns `feasible: false`, run the solver multiple times with progressively-relaxed inputs.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/alternatives.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { simulateAlternatives } from "../../src/agent/forwardSchedule/alternatives";
import type { SolverInput } from "../../src/agent/forwardSchedule/types";

function infeasibleInput(): SolverInput {
    // Build an input where the solver returns infeasible:
    // 8 unmet hard reqs, 1 future term (graduation in next semester),
    // credit ceiling 18 → can't fit them all.
    return {
        // ... fill in with 8 unmet reqs + 1 term
    } as SolverInput;
}

describe("simulateAlternatives", () => {
    it("returns at least one feasible alternative for an infeasible input", () => {
        const input = infeasibleInput();
        const candidates = simulateAlternatives(input);
        expect(candidates.length).toBeGreaterThan(0);
        const someFeasible = candidates.some(c => c.schedule !== null);
        expect(someFeasible).toBe(true);
    });

    it("includes 'add summer term' as the first option when graduation can be salvaged with summer", () => {
        const input = infeasibleInput();
        const candidates = simulateAlternatives(input);
        const summerCandidate = candidates.find(c => c.relaxation === "include_summer");
        expect(summerCandidate).toBeDefined();
    });

    it("returns an extend_grad candidate when even summer + J-term aren't enough", () => {
        const input = infeasibleInput();
        // Tighten further so even adding terms doesn't help.
        const candidates = simulateAlternatives({ ...input, unmetRequirements: [...input.unmetRequirements, /* 4 more */] });
        const extendCandidate = candidates.find(c => c.relaxation === "extend_grad_one_term" || c.relaxation === "extend_grad_one_year");
        expect(extendCandidate).toBeDefined();
    });
});
```

- [ ] **Step 2: Implement `alternatives.ts`**

Create `packages/engine/src/agent/forwardSchedule/alternatives.ts`:

```typescript
import { solveForwardSchedule } from "./solver.js";
import type { SolverInput } from "./types.js";
import type { AlternativeCandidate, ForwardSchedule } from "@nyupath/shared";

/**
 * Phase 14 — When the primary solve returns feasible: false, generate
 * up to 3 alternative inputs that progressively relax constraints.
 * Each returned candidate carries a 1-sentence summary, the relaxation
 * applied, and (if feasible) the resulting schedule.
 */
export function simulateAlternatives(input: SolverInput): AlternativeCandidate[] {
    const candidates: AlternativeCandidate[] = [];

    // Strategy 1: add summer.
    if (!input.preferences?.includeSummer) {
        const withSummer: SolverInput = {
            ...input,
            preferences: { ...input.preferences, includeSummer: true },
        };
        const out = solveForwardSchedule(withSummer);
        candidates.push({
            summary: "Add summer term to fit remaining requirements.",
            relaxation: "include_summer",
            schedule: out.feasibility.feasible ? buildScheduleFromSolverOutput(out, withSummer) : null,
            ...(out.feasibility.feasible ? {} : { stillInfeasibleReason: out.feasibility.infeasibilityReason ?? "Even with summer, no feasible plan." }),
        });
    }

    // Strategy 2: add J-term.
    if (!input.preferences?.includeJTerm) {
        const withJTerm: SolverInput = {
            ...input,
            preferences: { ...input.preferences, includeJTerm: true },
        };
        const out = solveForwardSchedule(withJTerm);
        candidates.push({
            summary: "Add J-term (January intersession) to fit remaining requirements.",
            relaxation: "include_jterm",
            schedule: out.feasibility.feasible ? buildScheduleFromSolverOutput(out, withJTerm) : null,
            ...(out.feasibility.feasible ? {} : { stillInfeasibleReason: out.feasibility.infeasibilityReason ?? "Even with J-term, no feasible plan." }),
        });
    }

    // Strategy 3: extend graduation by one term.
    const extendedTerm = computeNextMainTerm(input.graduationTerm);
    if (extendedTerm) {
        const extended: SolverInput = { ...input, graduationTerm: extendedTerm };
        const out = solveForwardSchedule(extended);
        candidates.push({
            summary: `Push graduation to ${extendedTerm} to fit remaining requirements.`,
            relaxation: "extend_grad_one_term",
            schedule: out.feasibility.feasible ? buildScheduleFromSolverOutput(out, extended) : null,
            ...(out.feasibility.feasible ? {} : { stillInfeasibleReason: out.feasibility.infeasibilityReason ?? "Even with grad+1 term, no feasible plan." }),
        });
    }

    return candidates.slice(0, 3);
}

function computeNextMainTerm(term: string): string | null {
    const m = term.match(/^(\d{4})-(spring|fall)$/);
    if (!m) return null;
    const year = parseInt(m[1]!, 10);
    if (m[2] === "spring") return `${year}-fall`;
    return `${year + 1}-spring`;
}

function buildScheduleFromSolverOutput(out: ReturnType<typeof solveForwardSchedule>, input: SolverInput): ForwardSchedule {
    return {
        studentId: input.studentId,
        homeSchoolId: input.homeSchoolId,
        graduationTerm: input.graduationTerm,
        creditTargetPerSemester: input.creditTargetPerSemester,
        f1Floor: input.f1Floor,
        domesticPartTimeFloor: input.domesticPartTimeFloor,
        graduationCreditMinimum: input.graduationCreditMinimum,
        degreeCreditsMet: input.creditsEarned >= input.graduationCreditMinimum,
        semesters: out.semesters,
        dprCourseHistoryHash: input.dprCourseHistoryHash,
        computedAt: Date.now(),
        feasibility: out.feasibility,
    };
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/alternatives.test.ts
git add packages/engine/src/agent/forwardSchedule/alternatives.ts packages/engine/tests/agent/alternatives.test.ts
git commit -m "feat(engine): simulateAlternatives() for failure-mode fallback"
```

---

## Task 5: New tools — `propose_plan_change`, `confirm_plan_change`, `simulate_alternatives`

**Files:**
- Create: `packages/engine/src/agent/tools/proposePlanChange.ts`
- Create: `packages/engine/src/agent/tools/confirmPlanChange.ts`
- Create: `packages/engine/src/agent/tools/simulateAlternatives.ts`
- Modify: `packages/engine/src/agent/registry.ts`
- Create: `packages/engine/tests/agent/proposePlanChange.test.ts`

The two-step pattern mirrors `update_profile` / `confirm_profile_update`. The agent calls `propose_plan_change` first to test feasibility + surface consequences; the student confirms; the agent calls `confirm_plan_change` to apply.

**Schema (per Decisions #23 + #24 + #25 + #26 — supersedes the single-mutation shape originally drafted in this section):** `propose_plan_change` accepts a MUTATION ARRAY so the agent can answer compound counterfactuals in one call ("drop my CS minor + swap Algorithms for Theory + add summer 2027" or "make Fall heavy so Spring is light"). Input: `{mutations: PlanMutation[]}` where `PlanMutation = {kind: "pin", courseId, term} | {kind: "exclude", courseId, term?: Term} | {kind: "swap", drop: courseId, add: courseId, term: Term} | {kind: "addTerm", term: Term} | {kind: "loadStyleOverride", term?: Term, style: LoadStyle}`. Per Decision #26, a `loadStyleOverride` with `style: light` or `style: heavy` and a specific `term` field triggers BOTH the credit-target adjustment (Decision #9) AND a Stage-5 candidate-ranking bias by `slot.workloadWeight` so the override applies to workload character not just credit count.

Output: `{newSchedule?: ForwardSchedule, diff?: PlanDiff, infeasibility?: InfeasibilityReport}` where:

```typescript
PlanDiff = {
    // Raw-credit deltas (Decision #23 baseline)
    creditsByTermDelta: Record<Term, number>;
    graduationTermShift: number;  // # terms; positive = delayed
    newRequiresPetition: CourseId[];
    removedRequiresPetition: CourseId[];
    newUnmetRequirements: CourseId[];
    cascadedShifts: Array<{ courseId, fromTerm, toTerm, becauseOf: CourseId }>;

    // Workload-tier deltas (Decision #24 extension — capture
    // imbalance that raw credits can't see, e.g. 16cr-but-all-hard vs
    // 16cr-with-3-electives)
    weightedCreditsByTermDelta: Record<Term, number>;  // Σ(credits × workloadWeight)
    workloadTierShifts: Array<{
        term: Term;
        before: { hardCount: number; easyCount: number; weightedCredits: number };
        after:  { hardCount: number; easyCount: number; weightedCredits: number };
    }>;

    // Aggregate balance verdict (Decision #25 extension — pre-computed
    // so the agent doesn't re-derive variance arithmetic in-prompt)
    balanceImpact: {
        before: number;       // currentPlan.balanceScore
        after: number;        // newPlan.balanceScore
        delta: number;        // after - before; positive = degraded
        classification: "improved" | "negligible" | "degraded-mild" | "degraded-significant";
    };
};
```

The `cascadedShifts` array consumes Decision #22c's `slot.downstreamImpact` from the original plan to explain WHY each shift happened (e.g. "Compilers shifted from Spring 2027 → Fall 2027 because Algorithms swap removed it from Spring 2027 and Compilers' prereq chain forced the next available term"). The `workloadTierShifts` array consumes Decision #24's per-slot `workloadTier` + `workloadWeight` so the agent can flag "Spring 2027 is now 1 hard + 3 free electives (light); Fall 2027 absorbed 4 major-required (heavy) — your 'balanced' preference is degraded." The `balanceImpact.classification` field (Decision #25) is the pre-computed plan-level verdict the agent reads directly to decide whether to flag the change to the student — no in-prompt variance arithmetic, no inconsistent thresholds across turns. Threshold table: delta ≤ 0 → improved; |delta| < 1.5 → negligible; 1.5 ≤ delta < 4 → degraded-mild; delta ≥ 4 → degraded-significant. Computed by `computeBalanceScore` + `classifyBalanceDelta` exported from `packages/engine/src/agent/forwardSchedule/balanceScore.ts` (Phase 13). Without the multi-mutation + cascade-aware diff + workload-tier deltas + aggregate balance verdict, the agent either runs the solver multiple times or produces vague consequence summaries that miss workload-character imbalance.

- [ ] **Step 1: Write the integration test**

Create `packages/engine/tests/agent/proposePlanChange.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { proposePlanChangeTool } from "../../src/agent/tools/proposePlanChange";
import { confirmPlanChangeTool } from "../../src/agent/tools/confirmPlanChange";

describe("propose_plan_change → confirm_plan_change flow", () => {
    it("propose returns feasibility + consequences without mutating state", async () => {
        const session = makeSessionWithSchedule();
        const before = JSON.stringify(session.forwardSchedule);
        const result = await proposePlanChangeTool.call!(
            { kind: "load_style", payload: { value: "frontload" } } as any,
            { session, signal: new AbortController().signal },
        );
        expect(result.feasible).toBeDefined();
        expect(JSON.stringify(session.forwardSchedule)).toBe(before); // unchanged
    });

    it("confirm applies the change and re-runs the solver", async () => {
        const session = makeSessionWithSchedule();
        await confirmPlanChangeTool.call!(
            { kind: "load_style", payload: { value: "frontload" } } as any,
            { session, signal: new AbortController().signal },
        );
        expect(session.schedulePreferences?.loadStyle).toBe("frontload");
        // Schedule should have been recomputed.
        expect(session.forwardSchedule).toBeDefined();
    });

    it("propose returns conflicts when the change is infeasible (e.g. pin to wrong-season term)", async () => {
        const session = makeSessionWithSchedule();
        const result = await proposePlanChangeTool.call!(
            { kind: "pin", payload: { courseId: "CSCI-UA 421", term: "2026-fall" } } as any,
            { session, signal: new AbortController().signal },
        );
        // CSCI-UA 421 is spring-only in our fixture
        expect(result.feasible).toBe(false);
        expect(result.conflicts?.length).toBeGreaterThan(0);
    });
});

function makeSessionWithSchedule() {
    // Build a session with a pre-computed forwardSchedule + course catalog
    // including a CSCI-UA 421 with spring-only offering.
    return { /* ... */ } as any;
}
```

- [ ] **Step 2: Implement `proposePlanChange.ts`**

**Schema note:** the input schema below uses the multi-mutation array shape per Decision #23. The single-`kind` shape was the original draft and is superseded; an executor reading this section MUST implement the array form so that compound counterfactuals ("drop CS minor + swap Algorithms for Theory + add summer 2027") flow through one call. The mutation kinds include `bindFreeElective` + `unbindFreeElective` + `bindPoolSlot`, but the dedicated tools `bind_free_elective` + `bind_pool_slot` (Task 6 below) provide a simpler entry point for single-slot binding flows.

```typescript
import { z } from "zod";
import type { Tool } from "../tool.js";
import type { PlanChangeOutcome } from "@nyupath/shared";
import { solveForwardSchedule } from "../forwardSchedule/solver.js";

// Per Decision #23 — multi-mutation array. Each mutation discriminated by `kind`.
const planMutationSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("pin"), courseId: z.string(), term: z.string() }),
    z.object({ kind: z.literal("exclude"), courseId: z.string(), term: z.string().optional() }),
    z.object({ kind: z.literal("swap"), drop: z.string(), add: z.string(), term: z.string() }),
    z.object({ kind: z.literal("addTerm"), term: z.string() }),
    z.object({ kind: z.literal("loadStyleOverride"), term: z.string().optional(), style: z.enum(["balanced","frontload","backload","light","heavy"]) }),
    z.object({ kind: z.literal("bindFreeElective"), slotId: z.string(), courseId: z.string() }),
    z.object({ kind: z.literal("unbindFreeElective"), slotId: z.string() }),
    z.object({ kind: z.literal("bindPoolSlot"), slotId: z.string(), courseId: z.string() }),
]);

const inputSchema = z.object({
    mutations: z.array(planMutationSchema).min(1),
});

export const proposePlanChangeTool: Tool<typeof inputSchema, PlanChangeOutcome> = {
    name: "propose_plan_change",
    description:
        "Test a hypothetical sequence of plan changes (pins, exclusions, swaps, term additions, load-style overrides, free-elective bindings, pool-slot bindings) WITHOUT applying them. " +
        "Returns the resulting feasibility + a structured PlanDiff (creditsByTermDelta, weightedCreditsByTermDelta, workloadTierShifts, balanceImpact, newAssumptions, validationResultsChanges, planStateChange, cascadedShifts) + InfeasibilityReport when applicable. " +
        "Call this BEFORE confirm_plan_change; surface the diff to the student and let them decide. Multiple mutations in one call enable compound counterfactuals.",
    inputSchema,
    isReadOnly: true,
    async call(input, { session }) {
        if (!session.forwardSchedule) {
            return {
                feasible: false,
                diff: { added: [], removed: [] },
                consequences: ["No forward plan exists yet. Run plan_forward_degree first."],
                conflicts: [{ kind: "no_plan", detail: "session.forwardSchedule is undefined" }],
            };
        }
        const hypothetical = applyMutationsToPreferences(session.schedulePreferences ?? {}, input.mutations);
        const solverInput = buildSolverInputFromSession(session, hypothetical);
        const out = solveForwardSchedule(solverInput);
        return {
            feasible: out.feasibility.feasible,
            diff: computeSlotDiff(session.forwardSchedule.semesters, out.semesters),
            consequences: deriveConsequences(out, input),
            ...(out.feasibility.feasible ? {} : { conflicts: out.feasibility.constraintViolations }),
        };
    },
};

// Helpers (applyMutationsToPreferences, buildSolverInputFromSession,
// computeSlotDiff, deriveConsequences) — implement to match shapes.
// applyMutationsToPreferences walks the mutation array left-to-right; later
// mutations override earlier ones for the same field. Bind/unbind mutations
// for the same slotId in one call cancel out (treated as no-op).
```

- [ ] **Step 3: Implement `confirmPlanChange.ts`**

Same shape but mutates `session.schedulePreferences` and replaces `session.forwardSchedule` with the new solver output. Mark `isReadOnly: false`.

- [ ] **Step 4: Implement `simulateAlternatives.ts` (the tool)**

Wraps `simulateAlternatives()` from Task 4. Read-only.

- [ ] **Step 5: Register in `registry.ts`**

Append all three tools to `ALL_NYUPATH_TOOLS`.

- [ ] **Step 6: Run tests + commit**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/proposePlanChange.test.ts
git add packages/engine/src/agent/tools/proposePlanChange.ts packages/engine/src/agent/tools/confirmPlanChange.ts packages/engine/src/agent/tools/simulateAlternatives.ts packages/engine/src/agent/registry.ts packages/engine/tests/agent/proposePlanChange.test.ts
git commit -m "feat(engine): propose_plan_change + confirm_plan_change + simulate_alternatives tools"
```

---

## Task 6: Binding tools — `bind_free_elective` + `bind_pool_slot`

**Files:**
- Create: `packages/engine/src/agent/tools/bindFreeElective.ts`
- Create: `packages/engine/src/agent/tools/bindPoolSlot.ts`
- Modify: `packages/engine/src/agent/registry.ts` (register both tools)
- Create: `packages/engine/tests/agent/freeElectiveBinding.test.ts`
- Create: `packages/engine/tests/agent/poolSlotBinding.test.ts`

These two tools are dedicated entry points for the binding workflow described in Decisions #37 (binding tools) + #28 (binding tools). Phase 13 ships solver-side placeholder semantics (free-elective `FreeCreditSlot` + choose_n `RequirementPoolSlot` per Decision #38's tagged union); Phase 14 ships the **student-facing binding workflow** so the agent can prompt the student in the immediate-next term to pick concrete courses for placeholder slots.

**Why dedicated tools (vs. just routing through `propose_plan_change`):** the binding workflow is a high-frequency, single-slot operation (the agent calls it once per placeholder it wants the student to bind). Routing through `propose_plan_change` works (and the `bindFreeElective` / `bindPoolSlot` `PlanMutation` kinds remain available for compound counterfactuals), but a dedicated tool's prompt is simpler — `{slotId, courseId}` vs. wrapping a single-element mutation array — which keeps token usage predictable and reduces LLM error rates on routine bindings.

**Boundary rules** (per Decision #37 binding-tools row):
- The agent only prompts for bindings in the **IMMEDIATE-NEXT term**. Future-term placeholders re-prompt as time advances. This avoids forcing the student to commit to free electives 4 terms out where the offering catalog will change.
- The student can always **skip** ("I'll decide closer to registration"). The placeholder remains `placeholder-pending` and rendering is unchanged.
- Re-binding via unbind+bind (or `propose_plan_change` with `unbindFreeElective` then `bindFreeElective` mutations in one call) preserves the slot's `placeholder-pending` state during the swap — the slot doesn't transit through any other binding state.

**Workload-recheck verdict** (per Decision #37): when binding, compute the new `workloadWeight` via `workloadTier.classifyWorkloadTier()` (Phase 13). Compare to the placeholder's default 0.3:
- delta ≤ 0.2 → no warning (typical: bound to a free elective with weight 0.5–0.6)
- 0.2 < delta ≤ 0.7 → mild warning ("This course is heavier than a typical free elective; your Spring 2027 weighted-credit balance shifts by 0.4")
- delta > 0.7 OR `balanceImpact.classification` ∈ {`degraded-mild`, `degraded-significant`} → strong warning ("Quantum Field Theory is a 1.1-weight capstone-class course — picking it as a 'free elective' will tip your Spring 2027 toward heavy")

The strong-warning case is the "student picks Quantum Field Theory as a free elective" scenario from Decision #35; the warning surfaces the workload-tier modifier (4000-level → +0.2; capstone → +0.2 if ≥3 prereq groups) so the student knows what they're committing to.

- [ ] **Step 1: Write the failing tests for `bindFreeElective`**

Create `packages/engine/tests/agent/freeElectiveBinding.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { bindFreeElectiveTool } from "../../src/agent/tools/bindFreeElective";

describe("bind_free_elective tool", () => {
    it("easy course bind → no warning, weight ~0.5, balanceImpact 'negligible'", async () => {
        const session = makeSessionWithFreeCreditSlot({ slotId: "slot-fall26-fe1", term: "2026-fall" });
        const result = await bindFreeElectiveTool.call!(
            { slotId: "slot-fall26-fe1", courseId: "ANTH-UA 1" },
            { session, signal: new AbortController().signal },
        );
        expect(result.feasible).toBe(true);
        expect(result.warningLevel).toBe("none");
        expect(result.diff?.balanceImpact?.classification).toBe("negligible");
    });

    it("medium course (W-suffix elective) → mild warning", async () => {
        const session = makeSessionWithFreeCreditSlot({ slotId: "slot-fall26-fe1", term: "2026-fall" });
        const result = await bindFreeElectiveTool.call!(
            { slotId: "slot-fall26-fe1", courseId: "ENGL-UA 200W" },
            { session, signal: new AbortController().signal },
        );
        expect(result.feasible).toBe(true);
        expect(result.warningLevel).toBe("mild");
    });

    it("advanced capstone-class course as 'free elective' → strong warning + degraded balance", async () => {
        const session = makeSessionWithFreeCreditSlot({ slotId: "slot-fall26-fe1", term: "2026-fall" });
        const result = await bindFreeElectiveTool.call!(
            { slotId: "slot-fall26-fe1", courseId: "PHYS-UA 350" }, // Quantum Field Theory, 4000-level capstone
            { session, signal: new AbortController().signal },
        );
        expect(result.feasible).toBe(true);
        expect(result.warningLevel).toBe("strong");
        expect(["degraded-mild", "degraded-significant"]).toContain(result.diff?.balanceImpact?.classification);
    });

    it("invalid courseId → reject with conflict", async () => {
        const session = makeSessionWithFreeCreditSlot({ slotId: "slot-fall26-fe1", term: "2026-fall" });
        const result = await bindFreeElectiveTool.call!(
            { slotId: "slot-fall26-fe1", courseId: "FAKE-UA 9999" },
            { session, signal: new AbortController().signal },
        );
        expect(result.feasible).toBe(false);
        expect(result.conflicts?.[0]?.kind).toBe("unknown_course");
    });

    it("course not offered in slot's term → reject", async () => {
        const session = makeSessionWithFreeCreditSlot({ slotId: "slot-fall26-fe1", term: "2026-fall" });
        // CSCI-UA 421 is spring-only in fixture
        const result = await bindFreeElectiveTool.call!(
            { slotId: "slot-fall26-fe1", courseId: "CSCI-UA 421" },
            { session, signal: new AbortController().signal },
        );
        expect(result.feasible).toBe(false);
        expect(result.conflicts?.[0]?.kind).toBe("offering_mismatch");
    });

    it("prereqs not satisfied for slot's term → reject", async () => {
        const session = makeSessionWithFreeCreditSlot({ slotId: "slot-fall26-fe1", term: "2026-fall" });
        // CSCI-UA 480 needs CSCI-UA 102 + CSCI-UA 201; not in coursesTaken
        const result = await bindFreeElectiveTool.call!(
            { slotId: "slot-fall26-fe1", courseId: "CSCI-UA 480" },
            { session, signal: new AbortController().signal },
        );
        expect(result.feasible).toBe(false);
        expect(result.conflicts?.[0]?.kind).toBe("prereq_unsatisfied");
    });

    it("duplicate (already bound elsewhere) → reject", async () => {
        const session = makeSessionWithFreeCreditSlot({ slotId: "slot-fall26-fe1", term: "2026-fall" });
        // Pretend another slot already binds ANTH-UA 1
        addBoundSlotElsewhere(session, "ANTH-UA 1", "2026-spring");
        const result = await bindFreeElectiveTool.call!(
            { slotId: "slot-fall26-fe1", courseId: "ANTH-UA 1" },
            { session, signal: new AbortController().signal },
        );
        expect(result.feasible).toBe(false);
        expect(result.conflicts?.[0]?.kind).toBe("duplicate_courseId");
    });

    it("isReadOnly is true — propose only", () => {
        expect(bindFreeElectiveTool.isReadOnly).toBe(true);
    });
});

function makeSessionWithFreeCreditSlot(opts: { slotId: string; term: string }): any {
    // Build a session with forwardSchedule containing one FreeCreditSlot at the requested term + slotId.
    return { /* fixture */ } as any;
}

function addBoundSlotElsewhere(session: any, courseId: string, term: string): void {
    /* fixture mutation */
}
```

- [ ] **Step 2: Implement `bindFreeElective.ts`**

Create `packages/engine/src/agent/tools/bindFreeElective.ts`:

```typescript
import { z } from "zod";
import type { Tool } from "../tool.js";
import type { PlanChangeOutcome, ScheduleSlot } from "@nyupath/shared";
import { classifyWorkloadTier } from "../forwardSchedule/workloadTier.js";
import { computeBalanceScore, classifyBalanceDelta } from "../forwardSchedule/balanceScore.js";
import { isPrereqSatisfied } from "../../dpr/prereqSatisfaction.js";
import { runGraduationPathValidator } from "../forwardSchedule/graduationPathValidator.js";

const inputSchema = z.object({
    slotId: z.string(),
    courseId: z.string(),
});

export const bindFreeElectiveTool: Tool<typeof inputSchema, PlanChangeOutcome> = {
    name: "bind_free_elective",
    description:
        "Bind a free-elective placeholder slot to a concrete courseId. Validates: course exists, course is offered in slot's term, " +
        "prereqs are satisfied (per Decision #4 optimistic-forward-projection), course isn't already bound elsewhere. " +
        "Returns workload-recheck verdict (warningLevel: none/mild/strong) + PlanDiff with balanceImpact (per Decision #25). " +
        "Read-only at the proposal stage — pair with confirm_plan_change to apply.",
    inputSchema,
    isReadOnly: true,
    async call(input, { session }) {
        const plan = session.forwardSchedule;
        if (!plan) {
            return { feasible: false, conflicts: [{ kind: "no_plan", detail: "no forward schedule" }] };
        }
        // 1. Locate slot.
        const slot = findSlotById(plan, input.slotId);
        if (!slot || slot.kind !== "placeholder" || (slot as any).type !== "FreeCreditSlot") {
            return { feasible: false, conflicts: [{ kind: "invalid_slot", detail: `slot ${input.slotId} is not a FreeCreditSlot` }] };
        }
        // 2. Validate course existence.
        const courseMeta = lookupCourseMeta(input.courseId);
        if (!courseMeta) {
            return { feasible: false, conflicts: [{ kind: "unknown_course", detail: input.courseId }] };
        }
        // 3. Validate offering in slot's term.
        const slotTerm = findSlotTerm(plan, slot);
        if (!isCourseOfferedInTerm(input.courseId, slotTerm)) {
            return { feasible: false, conflicts: [{ kind: "offering_mismatch", detail: `${input.courseId} not offered in ${slotTerm}` }] };
        }
        // 4. Validate prereqs (Decision #4 — optimistic-forward-projection).
        if (!isPrereqSatisfied(input.courseId, slotTerm, session.degreeProgressReport!, plan, getCourseMinGrades(input.courseId))) {
            return { feasible: false, conflicts: [{ kind: "prereq_unsatisfied", detail: `${input.courseId} prereqs not satisfied at ${slotTerm}` }] };
        }
        // 5. Validate not duplicate.
        if (isCourseBoundElsewhere(plan, input.courseId, input.slotId)) {
            return { feasible: false, conflicts: [{ kind: "duplicate_courseId", detail: `${input.courseId} already bound at another slot` }] };
        }
        // 6. Compute new workloadWeight + balanceImpact.
        const programRules = session.programRules!;
        const prereqsEntry = lookupPrereqsEntry(input.courseId);
        const { tier, weight: newWeight } = classifyWorkloadTier({ ...slot, courseId: input.courseId } as any, programRules, prereqsEntry);
        const oldWeight = (slot as any).workloadWeight ?? 0.3;
        const weightDelta = newWeight - oldWeight;
        // 7. Hypothetical plan with the binding applied + Stage 7 revalidation (Decision #36).
        const hypothetical = applyBindingHypothetically(plan, input.slotId, input.courseId, newWeight);
        const validation = runGraduationPathValidator(hypothetical, session.degreeProgressReport!, programRules);
        if (!validation.feasible) {
            return { feasible: false, conflicts: [{ kind: "binding_breaks_plan", detail: validation.infeasibilityReport! as any }] };
        }
        const beforeScore = plan.balanceScore;
        const afterScore = computeBalanceScore(hypothetical.semesters, session.schedulePreferences?.loadStyle ?? "balanced");
        const balanceDelta = afterScore - beforeScore;
        const balanceClassification = classifyBalanceDelta(beforeScore, afterScore);
        // 8. Determine warning level (per Decision #37 binding-tools row).
        let warningLevel: "none" | "mild" | "strong";
        if (balanceClassification === "degraded-mild" || balanceClassification === "degraded-significant" || weightDelta > 0.7) {
            warningLevel = "strong";
        } else if (weightDelta > 0.2) {
            warningLevel = "mild";
        } else {
            warningLevel = "none";
        }
        // 9. Return outcome.
        return {
            feasible: true,
            newSchedule: hypothetical,
            diff: {
                balanceImpact: { before: beforeScore, after: afterScore, delta: balanceDelta, classification: balanceClassification },
                workloadTierShifts: [/* compute from before/after */],
                weightedCreditsByTermDelta: { /* compute */ },
                creditsByTermDelta: {},
                graduationTermShift: 0,
                newRequiresPetition: [],
                removedRequiresPetition: [],
                newUnmetRequirements: [],
                cascadedShifts: [],
            },
            warningLevel,
            consequences: deriveBindingConsequences(slot, input.courseId, tier, newWeight, warningLevel),
        };
    },
};

// Helpers (findSlotById, findSlotTerm, lookupCourseMeta, isCourseOfferedInTerm,
// isCourseBoundElsewhere, applyBindingHypothetically, lookupPrereqsEntry,
// getCourseMinGrades, deriveBindingConsequences) — implement in the same file.
```

- [ ] **Step 3: Write the failing tests for `bindPoolSlot`**

Create `packages/engine/tests/agent/poolSlotBinding.test.ts`. Same structure as `freeElectiveBinding.test.ts`, but with these additional cases:

```typescript
it("courseId not in slot.poolBinding.candidates → reject", async () => {
    const session = makeSessionWithPoolSlot({ slotId: "slot-spring27-cs-elective", candidates: ["CSCI-UA 421", "CSCI-UA 433", "CSCI-UA 480"] });
    const result = await bindPoolSlotTool.call!(
        { slotId: "slot-spring27-cs-elective", courseId: "ANTH-UA 1" },
        { session, signal: new AbortController().signal },
    );
    expect(result.feasible).toBe(false);
    expect(result.conflicts?.[0]?.kind).toBe("not_in_pool_candidates");
});

it("binding violates choose_n pool constraint (Σ over pool members < N after binding) → reject", async () => {
    // Pool requires choose_3; only 4 candidates exist; if binding this slot consumes a candidate
    // that other slots in the pool also need to satisfy the choose_3 elsewhere, the constraint breaks.
    // ...
    expect(result.feasible).toBe(false);
    expect(result.conflicts?.[0]?.kind).toBe("pool_constraint_violation");
});
```

- [ ] **Step 4: Implement `bindPoolSlot.ts`**

Same structure as `bindFreeElective.ts`, with two differences:
1. After step 1's slot-lookup, check `slot.type === "RequirementPoolSlot"` (per Decision #38's tagged union).
2. Before step 6's workload computation, validate `slot.poolBinding.candidates.includes(input.courseId)` AND check the choose_n constraint still satisfiable: `Σ over remaining pool members ≥ slot.poolBinding.satisfiesRule.requiredCount`. If either fails, return appropriate conflict.

```typescript
// At the slot-validation step:
if (!slot || slot.kind !== "placeholder" || (slot as any).type !== "RequirementPoolSlot") {
    return { feasible: false, conflicts: [{ kind: "invalid_slot", detail: `slot ${input.slotId} is not a RequirementPoolSlot` }] };
}
const poolBinding = (slot as any).poolBinding;
if (!poolBinding.candidates.includes(input.courseId)) {
    return { feasible: false, conflicts: [{ kind: "not_in_pool_candidates", detail: `${input.courseId} not in pool ${poolBinding.poolId}` }] };
}
const remainingCandidates = poolBinding.candidates.filter((c: string) => c !== input.courseId);
if (countPlaceableInPool(remainingCandidates, plan) < poolBinding.satisfiesRule.requiredCount - 1) {
    return { feasible: false, conflicts: [{ kind: "pool_constraint_violation", detail: `binding would leave choose_${poolBinding.satisfiesRule.requiredCount} pool unsatisfiable` }] };
}
// ...rest matches bindFreeElective shape.
```

- [ ] **Step 5: Register both tools in `registry.ts`**

Append to `ALL_NYUPATH_TOOLS`:

```typescript
import { bindFreeElectiveTool } from "./tools/bindFreeElective.js";
import { bindPoolSlotTool } from "./tools/bindPoolSlot.js";

export const ALL_NYUPATH_TOOLS = [
    // ...existing tools
    bindFreeElectiveTool,
    bindPoolSlotTool,
];
```

- [ ] **Step 6: Run tests + commit**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/freeElectiveBinding.test.ts packages/engine/tests/agent/poolSlotBinding.test.ts
git add packages/engine/src/agent/tools/bindFreeElective.ts packages/engine/src/agent/tools/bindPoolSlot.ts packages/engine/src/agent/registry.ts packages/engine/tests/agent/freeElectiveBinding.test.ts packages/engine/tests/agent/poolSlotBinding.test.ts
git commit -m "feat(engine): bind_free_elective + bind_pool_slot tools (Decisions #37 + #28 binding workflow)"
```

---

## Task 7: `compare_plan_alternatives` tool (Decision #42 Tier B + Decision #44 consumption)

**Files:**
- Create: `packages/engine/src/agent/tools/comparePlanAlternatives.ts`
- Create: `packages/engine/tests/agent/comparePlanAlternatives.test.ts`
- Modify: `packages/engine/src/agent/registry.ts`

This tool implements **Tier B of the 4-tier fallback hierarchy** (Decision #42). Phase 13's solver emits up to 5 `AlternativePlanSummary` entries on `ForwardSchedule.alternativeCandidates` (Decision #44, free byproduct of Stage 7's distribution-selection). When the student states an unmodeled soft preference with axis-aligned variation among candidates, the agent calls this tool to read the candidate metadata, then reasons over it in-prompt and applies the selected mutation via the existing `confirm_plan_change` two-step pattern.

The tool itself is **strictly read-only**. It MUST set `isReadOnly: true` and MUST NOT mutate `session.forwardSchedule` under any branch. A regression test asserts this invariant by snapshotting the session bytes before and after the call.

The tool DOES NOT make the tier decision itself. It returns the candidates (or a "no alternatives" indicator) and lets the agent route. This separation is deliberate — the LLM does the comparative reasoning over structured plan metadata; the tool just formats input/output.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/tests/agent/comparePlanAlternatives.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { comparePlanAlternativesTool } from "../../src/agent/tools/comparePlanAlternatives";
// Test cases (sketch — implementer fills in fixtures):
//
// (a) Returns alternatives when present:
//     session.forwardSchedule.alternativeCandidates has 4 summaries
//     → tool returns { plansSummarized: [4 items], dimensionsConsidered, decisionFraming: "Tier B per Decision #42" }.
//
// (b) Returns "no alternatives" indicator when absent or empty:
//     session.forwardSchedule.alternativeCandidates undefined OR length 0
//     → tool returns { plansSummarized: [], decisionFraming: "no alternatives available; route to Tier C clarification or (soft-only) Tier D heuristic mapping" }.
//     Agent reads decisionFraming and routes accordingly. Tool never makes the tier decision itself.
//
// (c) Read-only invariant — session unchanged after call:
//     snapshot session bytes before; call tool; assert bytes byte-identical after.
//     Asserts isReadOnly === true on the tool definition.
//
// (d) Dimensions array threaded through:
//     call with { studentStatedFactor: "subject diversity", dimensions: ["distinctSubjectsCount"] }
//     → returned dimensionsConsidered === ["distinctSubjectsCount"].
//     call without dimensions → returned dimensionsConsidered === default set
//     ["balanceScore", "distinctSubjectsCount", "totalPetitionCount", "hardCount-evenness"].
//
// (e) Integration with simulated agent picking + confirming via confirm_plan_change:
//     after compare_plan_alternatives returns N candidates, agent picks index k,
//     emits a confirm_plan_change call with the implied mutation set;
//     verify the resulting session.forwardSchedule matches the candidate at index k.
```

- [ ] **Step 2: Implement `comparePlanAlternatives.ts`**

Tool input schema:
```typescript
inputSchema: z.object({
    studentStatedFactor: z.string(),
    dimensions: z.array(z.string()).optional(),
})
```

Body:
1. Read `session.forwardSchedule?.alternativeCandidates` (Decision #44 emission).
2. If absent OR `length === 0`, return:
   ```typescript
   { plansSummarized: [], dimensionsConsidered: [], decisionFraming: "no alternatives available; route to Tier C clarification or (soft-only) Tier D heuristic mapping" }
   ```
3. Default dimensions if `args.dimensions` is undefined: `["balanceScore", "distinctSubjectsCount", "totalPetitionCount", "hardCount-evenness"]`.
4. Return `{ plansSummarized: AlternativePlanSummary[], dimensionsConsidered: string[], decisionFraming: "Tier B per Decision #42" }`. The LLM reads, picks, and explains in the same turn.

Tool MUST be marked `isReadOnly: true`. Tool MUST NOT mutate session state under ANY branch. Mutation is the responsibility of `confirm_plan_change` after the student confirms.

- [ ] **Step 3: Register**

In `packages/engine/src/agent/registry.ts`, add `comparePlanAlternativesTool` to the registered tools array.

- [ ] **Step 4: Run tests + commit**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/comparePlanAlternatives.test.ts
git add packages/engine/src/agent/tools/comparePlanAlternatives.ts packages/engine/tests/agent/comparePlanAlternatives.test.ts packages/engine/src/agent/registry.ts
git commit -m "feat(engine): compare_plan_alternatives tool (Decision #42 Tier B + Decision #44 consumption)"
```

---

## Task 8: System-prompt extraction rules + 4-tier fallback hierarchy + eval suite

**Files:**
- Modify: `packages/engine/src/agent/systemPrompt.ts`
- Create: `packages/engine/tests/agent/preferenceExtraction.eval.ts`

The LLM must (1) understand natural language ("a free spring") and translate it into a `PlanChangeProposal` (Tier A modeled extraction), (2) apply the Decision #42 4-tier fallback hierarchy when the student's input doesn't map to a modeled field, and (3) **NEVER apply Tier D heuristic mapping to a hard-framed constraint** (asymmetric stakes — see Decision #42). This is the highest-uncertainty piece in Phase 14; an eval suite with 5 buckets (A / B / C / D-positive / D-negative) at ≥85% per-bucket accuracy locks the behavior.

- [ ] **Step 1: Add the system-prompt section (Tier-A mappings + 4-tier decision tree)**

In `packages/engine/src/agent/systemPrompt.ts`, append a new rule block alongside the existing 25 rules:

```typescript
// Phase 14 — preference extraction (Tier-A modeled mappings)
const PREFERENCE_EXTRACTION_RULES = `
When the student expresses a preference about how their schedule
should be shaped, do NOT directly mutate the plan. Instead:

1. Translate the natural-language preference into a PlanChangeProposal.
2. Call propose_plan_change with that proposal.
3. Surface the resulting feasibility + consequences ("Spring 2027
   would have 12 credits") to the student.
4. Wait for explicit confirmation ("yes, do that").
5. Only then call confirm_plan_change to apply.

Preference → proposal mappings:

- "I want a free / chill / light <term>"
  → kind: "load_style", payload: { term: "<term-code>", value: "light" }

- "Make <term> heavy / busy / packed"
  → kind: "load_style", payload: { term: "<term-code>", value: "heavy" }

- "Take <courseId> in <term>" / "I want to do <course> in <term>"
  → kind: "pin", payload: { courseId: "<id>", term: "<term-code>" }

- "Don't put <course> in <term>" / "Move <course> away from <term>"
  → kind: "exclude", payload: { courseId: "<id>", term: "<term-code>" }

- "I'll consider summer" / "I'm OK with summer term"
  → kind: "include_summer", payload: { value: true }

- "Use J-term"
  → kind: "include_jterm", payload: { value: true }

- "I want to be part-time / drop below 12 credits"
  → kind: "allow_below_floor", payload: { value: true }
  (For F-1 students, also surface the OGS RCL warning.)

- "No Tuesday classes" / "I'd prefer afternoon classes"
   → kind: "set_scheduling_preference", payload: { value: <SchedulingPreferences fragment> }
   (Decision #43; phase 15 consumer. The strict flag on each entry
    says whether the FILTER is hard, NOT whether the student framed
    the preference as non-negotiable for Decision #42 purposes — the
    two flags are usually correlated but not coupled at the schema
    level. Default strict=false unless the student supplies a
    non-negotiable reason that triggers Decision #42 hard-framing.)

Term-code resolution: use the temporal context provided in this
prompt (nextTerm, graduationTerm). If the student says a season
without a year (e.g. "spring"), default to the nearest future
spring relative to nextTerm.

If the student's intent is ambiguous (e.g. "I want it easier"
without specifying which term or what "easier" means),
ASK ONE clarifying question before calling propose_plan_change.
`;

// Phase 14 — Decision #42 4-tier fallback hierarchy
// (system-prompt rule — Layer 1 of 3-layer Tier-D enforcement;
// see Decision #42 in PHASE_PLANS_README.md for the full rationale).
const FOUR_TIER_FALLBACK_RULES = `
When the student states a preference, classify constraint framing
FIRST.

Constraint framing — hard vs. soft:
- HARD: the student cites a non-negotiable reason (work, childcare,
  religious observance, athletic/medical commitment, financial
  constraint, legal/visa requirement). Examples:
  "I can't take Friday classes due to childcare,"
  "I have to work Tu/Th mornings,"
  "religious observance Saturdays."
- SOFT: the student states a preference without a non-negotiable
  reason. Examples:
  "I'd prefer afternoon classes,"
  "I want diverse subjects,"
  "I like back-to-back classes."

Hard constraints route ONLY through Tier A or Tier C. Tier B is
permitted only when at least one candidate satisfies the constraint.
**Tier D is FORBIDDEN for hard constraints.** (The schema enforces
this at compile time — HEURISTIC_MAPPING.studentConstraintFraming is
the literal type "soft", so a hard-framed instance cannot be
constructed in TypeScript. This rule is the prompt-level mirror of
that compile-time guard. The eval suite's D-negative bucket is the
third layer.)

Tier hierarchy (apply in order):

- Tier A — If the factor maps to a modeled SchedulePreferences field
  or PlanMutation kind (see preference-extraction mappings above),
  extract deterministically.
- Tier B — Otherwise, call compare_plan_alternatives FIRST. The tool
  returns up to 5 ranked candidates with structured metadata
  (balanceScore, distinctSubjectsCount, totalPetitionCount,
  per-term hardCount, etc.). Reason over them, pick one, and
  EXPLAIN the choice to the student referencing specific dimensions
  ("plan #3 has 4 distinct subject areas vs. #1's 2"). Apply via
  confirm_plan_change. Emit a LLM_RANKED_ALTERNATIVE assumption
  recording your reasoning. For HARD constraints: only proceed if
  at least one candidate satisfies the constraint; otherwise skip
  to Tier C.
- Tier C — If no candidate satisfies a hard constraint OR you lack
  confidence in the soft-preference mapping, ASK THE STUDENT to
  drop / swap / relax. Do NOT pick a violating plan.
- Tier D — Only as last resort, only for SOFT constraints, apply a
  heuristic mapping with the HEURISTIC_MAPPING assumption flag
  (studentConstraintFraming MUST be "soft" — schema-enforced;
  emitting Tier D for a hard-framed constraint is a compile-time
  error, not a prompt-rule violation).

Never silently translate. Surface the chosen tier to the student
in plain language:
  - "I considered 5 plan variants and picked the one with..."
  - "Your constraint can't be satisfied by any current plan; want
     to drop X or swap Y?"
  - "I interpreted '...' as ... because ...; this is a guess —
     tell me if it's wrong."
`;
```

Splice the new sections into the assembled prompt at an appropriate point (between rules 20-25, since they cover tool-routing). Preference-extraction (Tier A) and the 4-tier fallback rules co-locate.

- [ ] **Step 2: Write the 5-bucket eval suite**

Create `packages/engine/tests/agent/preferenceExtraction.eval.ts`. The eval is **5-bucket per Decision #42**, with **≥85% accuracy per bucket individually** (NOT just overall). Per-bucket gating prevents the LLM from gaming the metric by always defaulting to one tier — without it, an LLM that emits Tier A for everything could land 60% overall while shipping 0% on the D-negative path. Author **≥10 fixture cases per bucket (50+ total).** Pattern: each fixture is `{userMessage, framing: "hard"|"soft", expectedTier: "A"|"B"|"C"|"D", expectedAction}`. Run a real `claude-haiku-4-5` (or comparable) call with an API key to verify routing; assert the tier + action match.

```typescript
const EVAL_BUCKETS = {
    // Bucket A — Tier A modeled extraction (≥10 fixtures, ≥85% accuracy)
    A: [
        { userMessage: "I want a chill spring 2027", framing: "soft",
          expectedTier: "A",
          expectedAction: { tool: "propose_plan_change",
                            mutation: { kind: "loadStyleOverride", term: "2027-spring", style: "light" } } },
        { userMessage: "Take CSCI-UA 421 in Fall 2026", framing: "soft",
          expectedTier: "A",
          expectedAction: { tool: "propose_plan_change",
                            mutation: { kind: "pin", courseId: "CSCI-UA 421", term: "2026-fall" } } },
        { userMessage: "No Tuesday classes", framing: "soft",
          expectedTier: "A",
          expectedAction: { tool: "propose_plan_change",
                            mutation: { kind: "setSchedulingPreference",
                                        value: { avoidDays: [{ day: "Tu", strict: false }] } } } },
        // ... extend to ≥10 cases covering the full Tier-A mapping table
    ],
    // Bucket B — Tier B top-K comparison, soft (≥10 fixtures, ≥85% accuracy)
    B: [
        { userMessage: "I want my courses to span more subject areas", framing: "soft",
          expectedTier: "B",
          expectedAction: { tool: "compare_plan_alternatives",
                            dimensions: ["distinctSubjectsCount"] } },
        { userMessage: "I'd prefer my hardest classes spread evenly", framing: "soft",
          expectedTier: "B",
          expectedAction: { tool: "compare_plan_alternatives",
                            dimensions: ["hardCount-evenness"] } },
        // ... extend to ≥10 cases
    ],
    // Bucket C — Tier C clarification, hard with no satisfier (≥10 fixtures, ≥85% accuracy)
    C: [
        { userMessage: "I cannot take Friday classes due to work",
          framing: "hard",
          fixtureNote: "no feasible Friday-free plan exists in alternativeCandidates",
          expectedTier: "C",
          expectedAction: { kind: "clarify",
                            phrasingHint: "ask student to drop / swap / relax;
                                           NOT Tier B with the least-Friday plan" } },
        // ... extend to ≥10 cases
    ],
    // Bucket D-positive — Tier D heuristic mapping, soft + no axis-aligned candidate (≥10 fixtures, ≥85% accuracy)
    Dpos: [
        { userMessage: "I'd prefer professors with East-Coast accents",
          framing: "soft",
          expectedTier: "D",
          expectedAction: { kind: "emit_assumption",
                            type: "HEURISTIC_MAPPING",
                            studentConstraintFraming: "soft",
                            confidenceFloor: "low" } },
        // ... extend to ≥10 cases (long-tail soft preferences with no axis-aligned candidate)
    ],
    // Bucket D-negative — Tier D MUST NOT fire (hard constraint) (≥10 fixtures, ≥85% accuracy)
    // CRITICAL: this bucket enforces the asymmetric-stakes principle behind
    // Tier D's hard-constraint exclusion. Failing it means Tier D fires for
    // hard constraints, which violates Decision #42's three-layer enforcement.
    Dneg: [
        { userMessage: "I can't take morning classes because of my night-shift job",
          framing: "hard",
          expectedTier: "C",  // expected Tier C, NOT Tier D mapping
          expectedAction: { kind: "clarify",
                            mustNotEmit: "HEURISTIC_MAPPING" } },
        // ... extend to ≥10 cases — each citing a non-negotiable reason
        // (work, childcare, religious, athletic/medical, financial, legal/visa)
    ],
};
```

The eval is too costly to run on every push; gate it behind an `evalSuite()` runner that the operator triggers manually (mirror Phase 7-A's surrogate-eval pattern). **Per-bucket bar: ≥85% accuracy on each of A / B / C / D-positive / D-negative individually.**

- [ ] **Step 3: Run the eval (operator-gated)**

```bash
ANTHROPIC_API_KEY=... pnpm tsx packages/engine/tests/agent/preferenceExtraction.eval.ts
```

Expected: ≥85% per-bucket on all 5 buckets. The D-negative bucket is the critical one — failure means Tier D fired for a hard-framed constraint, which violates Decision #42's asymmetric-stakes principle.

If accuracy is lower on any bucket, iterate on the system prompt (add more worked examples, clarify ambiguous mappings, sharpen the hard-vs-soft framing rule) and re-run.

- [ ] **Step 3.5: Layer-2 schema-discriminator type-level assertion**

The third layer of the Tier-D 3-layer enforcement (after the system-prompt rule in Step 1 and the eval suite in Step 2) is a TypeScript compile-time guard on the `HEURISTIC_MAPPING` `Assumption` variant. Verify it directly:

```typescript
// packages/engine/tests/agent/heuristicMappingGuard.compile.test.ts
//
// This test fails to COMPILE if the schema lets a hard-framed
// HEURISTIC_MAPPING Assumption be constructed. tsc is the assertion.
import type { Assumption } from "@nyupath/shared";

// Should compile — soft framing is permitted.
const okSoft: Assumption = {
    type: "HEURISTIC_MAPPING",
    studentStatedFactor: "I'd prefer professors with East-Coast accents",
    studentConstraintFraming: "soft",
    mappedToMutation: { kind: "loadStyleOverride", style: "balanced" },
    confidence: "low",
    reasoning: "...",
    consequenceIfWrong: "...",
};

// Should FAIL TO COMPILE — hard framing is the literal-type guard.
// Uncomment to verify the guard fires:
// const badHard: Assumption = {
//     type: "HEURISTIC_MAPPING",
//     studentStatedFactor: "I cannot take Friday classes due to childcare",
//     studentConstraintFraming: "hard",  // <-- TS2322: not assignable to "soft"
//     mappedToMutation: { kind: "loadStyleOverride", style: "balanced" },
//     confidence: "low",
//     reasoning: "...",
//     consequenceIfWrong: "...",
// };

// Active assertion: attempting the cast still fails at type-check time.
// @ts-expect-error -- studentConstraintFraming "hard" is not assignable to "soft"
const badHardCast: Assumption = {
    type: "HEURISTIC_MAPPING",
    studentStatedFactor: "x",
    studentConstraintFraming: "hard",
    mappedToMutation: { kind: "loadStyleOverride", style: "balanced" },
    confidence: "low",
    reasoning: "x",
    consequenceIfWrong: "x",
};
```

The `@ts-expect-error` directive in the cast block is the active assertion: if a future change broadens `studentConstraintFraming` to a `"hard" | "soft"` union, `tsc` will flag the directive as unused (TS2578) — Layer 2 enforcement is broken and the maintainer must restore the literal-type guard. Run `pnpm -F engine exec tsc --noEmit` and confirm 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/systemPrompt.ts packages/engine/tests/agent/preferenceExtraction.eval.ts
git commit -m "feat(engine): system-prompt rules for natural-language preference extraction + eval suite"
```

---

## Task 9: Co-requisite parser extension

**Files:**
- Create: `tools/bulletin-parser/extractCoreqs.ts`
- Create: `tools/bulletin-parser/extractCoreqs.test.ts`
- Modify: `packages/engine/src/data/prereqs.json` (extends `coreqs` field on existing entries)
- Modify: `packages/engine/src/agent/forwardSchedule/solver.ts` (enforce coreqs as same-term constraint)

Phase 12.8 left the `PrereqGroup.coreqs` field empty. Phase 14 fills it in for courses with co-requisites (e.g. `BIOL-UA 11` + `BIOL-UA 11L`), then teaches the solver to place coreq courses in the same term as their parent.

- [ ] **Step 1: Sample co-requisite formats in the bulletin**

```bash
grep -rln "Corequisites\|Concurrently with\|must be taken with" data/bulletin-raw/courses/ | head -10
```

Inspect 3-5 hits to learn the format.

- [ ] **Step 2: Write the extractor + test**

Create `tools/bulletin-parser/extractCoreqs.ts` mirroring the structure of `extractPrereqs.ts` (Phase 12.8 Task 4). LLM-assisted parse; 5 worked examples in the prompt.

- [ ] **Step 3: Solver — enforce coreqs**

In `solver.ts`'s candidate placement loop, when placing a course `C` with `coreqs: ["X", "Y"]`:
- Verify X and Y are also unmet requirements (in `candidates` list).
- Place X, Y, C all in the same term.
- If only one fits in a term and the others don't, the entire group must move together — backtrack to the next term.

Add tests: `BIOL-UA 11 + 11L` placement together; failure case where lab can't fit.

- [ ] **Step 4: Run tests + commit**

```bash
node_modules/.bin/vitest run tools/bulletin-parser/extractCoreqs.test.ts packages/engine/tests/agent/
pnpm tsx tools/bulletin-parser/extractCoreqs.ts
git add tools/bulletin-parser/extractCoreqs.ts tools/bulletin-parser/extractCoreqs.test.ts packages/engine/src/data/prereqs.json packages/engine/src/agent/forwardSchedule/solver.ts
git commit -m "feat(engine,parser): co-requisite extraction + solver same-term enforcement"
```

---

## Task 10: Sidebar — load-style pills + click-to-edit slots

**Files:**
- Modify: `apps/web/app/chat/scheduleSidebar.tsx`
- Modify: `apps/web/app/chat/page.tsx`
- Modify: `apps/web/app/chat/chat.module.css`

- [ ] **Step 1: Add load-style pills above semester cards**

In `scheduleSidebar.tsx`, after the `<scheduleSidebarMeta>` paragraph, render a row of pills:

```typescript
const LOAD_STYLES: Array<{ value: "balanced" | "frontload" | "backload"; label: string }> = [
    { value: "balanced", label: "Balanced" },
    { value: "frontload", label: "Frontload" },
    { value: "backload", label: "Backload" },
];

// inside the JSX:
<div className={styles.loadStylePills}>
    {LOAD_STYLES.map(s => (
        <button
            key={s.value}
            type="button"
            className={`${styles.loadStylePill} ${currentStyle === s.value ? styles.loadStylePillActive : ""}`}
            onClick={() => onProposeLoadStyle(s.value)}
        >
            {s.label}
        </button>
    ))}
</div>
```

`onProposeLoadStyle` comes from props (wired in `page.tsx` to call `propose_plan_change` via the chat API).

- [ ] **Step 2: Add click-to-edit slot popover**

Wrap each `<li>` slot in a `<button>` (or click handler). On click, open a small popover with options:

```
Lock as-is
Replace with a different course
Drop this slot
Pin to a different term
```

Each option calls `onProposeSlotChange(slot, action)` from props, which in turn calls `propose_plan_change` and surfaces the result.

The popover renders `PlanChangeOutcome.consequences` as a confirmation dialog before the student commits.

- [ ] **Step 3: Wire `propose_plan_change` round-trip in `page.tsx`**

Add a helper that sends a chat message asking the agent to call `propose_plan_change` with specific args, then waits for the agent's reply (which will include the resulting outcome via `validator_block` or a dedicated event). Simplest: just inject a chat message like "Let me propose: pin CSCI-UA 421 to Fall 2026" and rely on the agent's tool-using behavior.

- [ ] **Step 4: CSS for pills + popover**

Append to `chat.module.css`:

```css
.loadStylePills {
    display: flex;
    gap: 6px;
    margin-bottom: 16px;
}
.loadStylePill {
    background: var(--bg-secondary);
    border: 1px solid var(--border-light);
    color: var(--text-primary);
    padding: 4px 10px;
    border-radius: var(--radius-full);
    font-size: 0.85em;
    cursor: pointer;
}
.loadStylePillActive {
    background: var(--nyu-violet);
    color: #fff;
    border-color: var(--nyu-violet);
}
.slotPopover {
    position: absolute;
    background: var(--bg-primary);
    border: 1px solid var(--border-light);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    padding: 8px;
    border-radius: 6px;
    z-index: 100;
}
.slotPopover button {
    display: block;
    background: transparent;
    border: none;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 0.85em;
}
.slotPopover button:hover { background: var(--bg-secondary); }
```

- [ ] **Step 5: Smoke-test in browser + commit**

Verify: clicking a pill triggers a propose+confirm round-trip; clicking a slot opens the popover; selecting an option calls the agent.

```bash
git add apps/web/app/chat/scheduleSidebar.tsx apps/web/app/chat/page.tsx apps/web/app/chat/chat.module.css
git commit -m "feat(web): sidebar load-style pills + click-to-edit slot popover"
```

---

## Task 11: Manual browser verification + push

- [ ] **Step 1: Refresh dev server**

`http://localhost:3001` — HMR.

- [ ] **Step 2: Verification scenarios**

For each of these, send the user message and verify expected behavior:

1. "I want a free spring 2027" → agent calls `propose_plan_change` with `kind: "load_style", payload: { term: "2027-spring", value: "light" }`; surfaces consequences ("Spring 2027 would have 12 credits"); asks for confirmation.
2. "Yes, do it" → agent calls `confirm_plan_change`; sidebar updates with Spring 2027 at 12 credits.
3. "Pin CSCI-UA 421 to Fall 2026" → propose returns conflict (course is spring-only); agent surfaces the conflict + suggests Spring 2027 instead.
4. "Plan for graduation by Spring 2026" (impossibly tight) → solver returns infeasible; agent calls `simulate_alternatives`; presents 2-3 candidates; asks the student to pick.
5. Click 📅 Schedule → click "Backload" pill → propose+confirm; sidebar shows hard requirements pushed to the latest term.
6. Click a placeholder slot → popover with "Replace / Drop / Pin to different term" options.
7. Force a failed-course retake (manually edit DPR fixture to have a grade F on CSCI-UA 102, then plan) → solver places CSCI-UA 102 earlier than dependents.

- [ ] **Step 3: Push**

```bash
git push
```

- [ ] **Step 4: Tear-off note**

```
Phase 14 (preferences + overrides + failure-mode fallbacks) shipped:
- 5 load styles (balanced / frontload / backload / per-term light / per-term heavy)
  with system-prompt extraction from natural language
- pins + exclusions via propose_plan_change → confirm_plan_change two-step
- summer + J-term opt-in support
- simulate_alternatives for graduation-rescue scenarios
- co-requisite enforcement (parser extension + solver same-term constraint)
- sidebar UX: load-style pills + click-to-edit slot popover
- LLM-extraction eval suite at ≥85% accuracy

Phase 15 (live FOSE section materialization + time conflicts) is the
next step; gates the immediate-term register-ready output.
```

---

## Self-review notes

- **Risk:** the LLM-extraction Task 8 is the highest-uncertainty piece. The eval suite is the gating mechanism — **per-bucket ≥85% accuracy across A / B / C / D-positive / D-negative** (5 buckets, NOT just overall). The Tier-B `compare_plan_alternatives` path (Task 7) is medium-uncertainty because the LLM does free-form comparative reasoning over structured plan metadata; the eval-suite per-bucket bar gates it. **The Bucket-D-negative threshold is non-negotiable** — failing it means Tier D fires for hard constraints, which violates Decision #42's asymmetric-stakes principle.
- **Sub-phasing option (post-Task-7 insertion):**
  - **Phase 14a:** Tasks 1+2+3+5+6 (preferences + solver + tools + binding tools, no LLM).
  - **Phase 14b:** Task 7 (`compare_plan_alternatives`) + Task 10 (renumbered sidebar UX).
  - **Phase 14c:** Task 4 (alternatives) + Task 8 (renumbered LLM extraction + 5-bucket eval suite) + Task 9 (renumbered coreqs) + Task 11 (renumbered manual verification).
  Each ~2-3 days. Acceptable to ship in three commits if the operator wants smaller checkpoints.
- **Authority hierarchy:** confirmed-plan = student wins. The solver narrates consequences via `consequences: string[]`; the agent surfaces them; the student decides. Never override.
- **Solver-contract isolation (gates the future Phase 15.5 MIP migration; see README's "Phase 15.5 (DEFERRED)" stub):** Reviewer must verify that NO Phase 14 module — `proposePlanChange.ts`, `confirmPlanChange.ts`, `simulateAlternatives.ts`, `bindFreeElective.ts`, `bindPoolSlot.ts`, `comparePlanAlternatives.ts`, `alternatives.ts`, modified `solver.ts` preferences-reading code — imports stage-internal types from Phase 13's solver. Phase 14 tools depend ONLY on `SolverInput`, `SolverOutput`, `ForwardSchedule`, `PlanDiff`, `PlanMutation`, `AlternativePlanSummary`, `Assumption`, `ValidationResult`, and Phase-14-defined types in `@nyupath/shared`. Reviewer's check: `grep -rn "from .*solver/\(types\|stages\|internal\)" packages/engine/src/agent/tools/ packages/engine/src/agent/forwardSchedule/alternatives.ts` returns zero matches. Phase 14 is the highest-risk phase for contract leakage because it adds the most new tool consumers; this check is mandatory at every Task's code-quality reviewer pass.
