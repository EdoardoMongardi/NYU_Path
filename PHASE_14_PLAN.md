# Phase 14 — Preferences, Overrides, and Failure-Mode Fallbacks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take Phase 13's balanced multi-semester planner and turn it into a full-fidelity planner that lets the student steer: pick a load style ("I want a chill spring" / "compact things into fall"), pin specific courses to specific terms, exclude courses, and consider summer / J-term when the standard schedule can't reach graduation. The planner ALWAYS produces a graduation-feasible plan; when it can't with the requested constraints, it surfaces 2-3 alternatives ("add summer", "delay grad by 1 term") and the student picks. **Student confirmation is the highest authority** — confirmed plans are written even when they deviate from solver-optimal.

**Architecture:** Three additive layers on top of Phase 13's solver:

1. **Preferences layer** — A new `SchedulePreferences` object on `ToolSession` carries: `loadStyle`, `loadStylePerTerm`, `creditTargetPerTerm`, `pins`, `exclusions`, `includeSummer`, `includeJTerm`, `allowBelowF1Floor`. The solver reads it as additional constraints (load style → placement-order heuristic; pins → hard placement; exclusions → blocked candidates; summer/J-term → opt-in available terms).

2. **LLM-shell layer** — System-prompt rules extract preferences from natural language ("a free spring" → `{loadStylePerTerm: {"2027-spring": "light"}}`). Two new tools: `propose_plan_change` (read-only — runs the solver hypothetically and returns a diff + consequences), `confirm_plan_change` (applies). Plus `simulate_alternatives` for failure-mode rescue.

3. **Failure-mode layer** — When the solver returns `feasible: false`, `simulate_alternatives` generates 2-3 candidates (add summer; add J-term; extend graduation; lower credit target). The LLM presents them and the student picks.

**Tech Stack:** Same as Phase 13 — TypeScript, Zod, vitest, Next.js, React.

**Prerequisites:**
- **Phase 13** complete and in production. The solver, `ForwardSchedule`, sidebar, SSE event are all live.

**Out of scope (Phase 15+):**
- Live FOSE section materialization for the immediate term (Phase 15)
- Time-of-day preferences ("no Friday classes")
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
| 9 | Load styles | 5 modes: `balanced` (default, slack-based), `frontload` (place hard reqs early), `backload` (defer hard reqs), `light` (per-term override; pulls credit target down to floor), `heavy` (per-term override; pushes up to ceiling). `part-time` mode is domestic-only and requires explicit student `allowBelowF1Floor: true`. |
| 10 | Pinning | Two-step (`propose_plan_change` → `confirm_plan_change`). Hard constraint in solver. If pin is infeasible (offering pattern, prereq), propose returns the conflict + a no-pin fallback. |
| 11 | Exclusions | Same shape as pins, inverse: courseId is filtered out of candidates for the given term (or globally). |
| 12 | Summer / J-term | Off by default. When the standard schedule infeasible, `simulate_alternatives` proposes adding them. When student opts in (via preferences), they become available terms in the solver. |
| 13 | Confirmation = highest authority | Student-confirmed plan is written to `session.forwardSchedule` even when it deviates from the recommendation. The agent surfaces consequences but doesn't override. |
| 14 | Co-requisite enforcement | Phase 12.8 left coreqs unparsed. Phase 14 adds a parser-extension step + solver enforcement (must-be-same-term constraint). |
| 15 | Failed-course retake | If DPR shows a course as failed (grade F or W), it appears in `unmetRequirements`. The solver places it normally; if a downstream course depends on it, prereq check forces the failed course earlier in the schedule. |

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

```typescript
import { z } from "zod";
import type { Tool } from "../tool.js";
import type { PlanChangeProposal, PlanChangeOutcome } from "@nyupath/shared";
import { solveForwardSchedule } from "../forwardSchedule/solver.js";

const inputSchema = z.object({
    kind: z.enum(["pin", "exclude", "load_style", "credit_target", "include_summer", "include_jterm", "allow_below_floor"]),
    payload: z.record(z.unknown()),
});

export const proposePlanChangeTool: Tool<typeof inputSchema, PlanChangeOutcome> = {
    name: "propose_plan_change",
    description:
        "Test a hypothetical change (pin a course to a term, exclude a course, change load style, etc.) WITHOUT applying it. " +
        "Returns the resulting feasibility + a diff against the current schedule + human-readable consequences. " +
        "Call this BEFORE confirm_plan_change; surface the consequences to the student and let them decide.",
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
        const hypothetical = applyChangeToPreferences(session.schedulePreferences ?? {}, input);
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

// Helpers (applyChangeToPreferences, buildSolverInputFromSession,
// computeSlotDiff, deriveConsequences) — implement to match shapes.
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

## Task 6: System-prompt extraction rules + eval suite

**Files:**
- Modify: `packages/engine/src/agent/systemPrompt.ts`
- Create: `packages/engine/tests/agent/preferenceExtraction.eval.ts`

The LLM must understand natural language ("a free spring") and translate it into a `PlanChangeProposal`. This is the highest-uncertainty piece in Phase 14; an eval suite locks the behavior.

- [ ] **Step 1: Add the system-prompt section**

In `packages/engine/src/agent/systemPrompt.ts`, append a new rule block alongside the existing 25 rules:

```typescript
// Phase 14 — preference extraction
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

Term-code resolution: use the temporal context provided in this
prompt (nextTerm, graduationTerm). If the student says a season
without a year (e.g. "spring"), default to the nearest future
spring relative to nextTerm.

If the student's intent is ambiguous (e.g. "I want it easier"
without specifying which term or what "easier" means),
ASK ONE clarifying question before calling propose_plan_change.
`;
```

Splice the new section into the assembled prompt at an appropriate point (between rules 20-25, since they cover tool-routing).

- [ ] **Step 2: Write the eval suite**

Create `packages/engine/tests/agent/preferenceExtraction.eval.ts`. Pattern: 15-25 (user-message, expected-proposal) pairs. Run a real `claude-haiku-4-5` call (with API key) to verify the extraction. Assert the resulting `propose_plan_change` invocation has the expected `kind` + `payload.term` + `payload.value`.

```typescript
const EXTRACTION_CASES = [
    {
        userMessage: "I want a chill spring 2027",
        expected: { kind: "load_style", payload: { term: "2027-spring", value: "light" } },
    },
    {
        userMessage: "Take CSCI-UA 421 in Fall 2026",
        expected: { kind: "pin", payload: { courseId: "CSCI-UA 421", term: "2026-fall" } },
    },
    {
        userMessage: "Don't put HIST-UA 1 in spring",
        expected: { kind: "exclude", payload: { courseId: "HIST-UA 1", term: "2027-spring" } },
    },
    {
        userMessage: "I'm willing to take summer term",
        expected: { kind: "include_summer", payload: { value: true } },
    },
    // ... extend to 15-25 cases covering the full mapping table
];
```

The eval may be too costly to run in CI on every push; gate it behind an `evalSuite()` runner that the operator triggers manually (mirror Phase 7-A's surrogate-eval pattern). Bar: ≥85% extraction accuracy.

- [ ] **Step 3: Run the eval (operator-gated)**

```bash
ANTHROPIC_API_KEY=... pnpm tsx packages/engine/tests/agent/preferenceExtraction.eval.ts
```

Expected: ≥85% pass.

If accuracy is lower, iterate on the system prompt (add more worked examples, clarify ambiguous mappings) and re-run.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/systemPrompt.ts packages/engine/tests/agent/preferenceExtraction.eval.ts
git commit -m "feat(engine): system-prompt rules for natural-language preference extraction + eval suite"
```

---

## Task 7: Co-requisite parser extension

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

## Task 8: Sidebar — load-style pills + click-to-edit slots

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

## Task 9: Manual browser verification + push

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

- **Risk:** the LLM-extraction Task 6 is the highest-uncertainty piece. The eval suite is the gating mechanism — bar at 85% accuracy.
- **Sub-phasing option:** Tasks 1+2+3+5 (preferences + solver + tools, no LLM) can ship as Phase 14a; Tasks 6+8 (LLM extraction + sidebar UX) as 14b; Tasks 4+7 (alternatives + coreqs) as 14c. Each ~2-3 days. Acceptable to ship in three commits if the operator wants smaller checkpoints.
- **Authority hierarchy:** confirmed-plan = student wins. The solver narrates consequences via `consequences: string[]`; the agent surfaces them; the student decides. Never override.
