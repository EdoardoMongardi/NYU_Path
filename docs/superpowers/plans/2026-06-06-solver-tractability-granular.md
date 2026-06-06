# Solver Tractability — Granular TDD Implementation Plan (T1–T9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh implementer per task + spec-compliance review + code-quality review + fix loop). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the forward-schedule solver tractable at realistic full-degree scale (10–20 unmet requirements, ~8 terms): always find a valid plan fast when one exists, return a strongly-preferred one, never falsely refuse, keep validity-as-contract — by switching from optimize-while-searching to **feasibility-first, then locally optimize**, with feasibility-aware pool placeholders and corrected F-1 edges.

**Architecture:** The frozen entry `solveForwardSchedule(input): SolverOutput` ([solver.ts:167]) keeps its body's three-stage shape (buildConstraintContext → search → materializePlan) but the **search stage** changes from "enumerate every valid leaf to prove the optimum" to "find the FIRST valid leaf (fast), then `localImprove` it toward preference, then collect a few diverse valid plans for top-K." Constrained course pools become **sound placeholders** carrying a pool descriptor instead of being enumerated. F-1 final-term and pool/range edges are corrected. See the companion **cut-map** `docs/superpowers/plans/2026-06-06-solver-tractability-cutmap.md` (exact seams) and **plan** `…-solver-tractability.md` (rationale, Preserve list, locked decisions).

**Tech Stack:** TypeScript pnpm monorepo · Vitest · Zod. Engine `packages/engine`, shared types `packages/shared`, web `apps/web`.

---

## Conventions (read once — every task obeys these)

- **Run a test:** `pnpm exec vitest run "<relative-path-substring>"` (optionally `-t "<name substring>"`) from repo root.
- **Typecheck (NEVER `tsc -b`):** `pnpm exec tsc -p packages/shared/tsconfig.json --noEmit && pnpm exec tsc -p packages/engine/tsconfig.json --noEmit && pnpm exec tsc -p apps/web/tsconfig.json --noEmit`. (`tsc -b` re-emits `.js` shadow artifacts vitest runs *instead of* `.ts` — forbidden.)
- **Shadow check after each task:** `find packages/engine/src packages/shared/src apps/web/lib apps/web/app -name '*.js' | while read js; do { [ -f "${js%.js}.ts" ] || [ -f "${js%.js}.tsx" ]; } && echo "$js"; done` → MUST be empty; `rm` any it prints.
- **Scoped commits only:** `git add <explicit files>` — **NEVER `git add -A`**. Leave the pre-existing working-tree leftovers untouched (`D .agent/rules/00-implementation-guardrails.md`, `M pnpm-lock.yaml`, `D validation_spec.md`, untracked `docs/review/`, `packages/engine/scripts/diagnoseInfeasible.ts`, `tools/bulletin-parser/validateCurated.ts`). Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Do NOT push/merge.
- **Full suite green at every task end:** `pnpm exec vitest run` ≥ **1565 passed / 9 skipped** (the baseline). A test the task *intentionally* changes must be justified (behavior genuinely changed, contract not weakened).
- **Test factories (reuse — do NOT reinvent):** `packages/engine/tests/forwardSchedule/search.test.ts` defines `makeMinimalDpr(overrides)`, `makeInput(overrides): SolverInput`, and `placed(p): PlacedCourse`. New `forwardSchedule/*.test.ts` files **copy these three factories verbatim** (the existing files copy them between each other — match that convention) or import from a shared test util if one is introduced. Build a context with `buildConstraintContext(input)` and assert against the exported hard predicates (`checkRequirementCoverage`, `checkPerTermCeiling`, …).
- **PRESERVE (must not regress, re-run after every task):** validity-as-contract + PLAN-3 (propose/confirm gated on `runGraduationPathValidator`); constraint↔validator 7-axis parity; trade-off engine real PlanDiff fields; balance-as-objective; real rationale recorder; opt-in summer/J-term. Phase-2 tests: `forwardScheduleSolver`, `constraintModel`, `search`, `materializePlan`, `objectiveBalance`, `infeasibility`, `truncation`, `summerJterm`, `tradeOffEngine`, `rationaleRecorder`, `coreqs`, `proposePlanChange`, `solverPreferences`, `alternatives`.

---

## Shared type changes (preamble — referenced by several tasks)

Two additive type changes are introduced by their owning tasks; later tasks consume them. Listed here so signatures stay consistent across tasks:

1. **Pool descriptor** (introduced in **T5**, consumed in **T4**): `SolverInput.unmetRequirements[]` ([types.ts:98-108]) gains an optional field
   ```ts
   /** When the requirement is a "choose-N from a range/pool" (e.g. "CSCI-UA 400-499"),
    *  this carries the pool's dept + inclusive catalog-number range instead of (or
    *  alongside) enumerated candidateCourses. Absent for a requirement satisfied by an
    *  explicit course list. Sound: a placeholder for this pool is placeable only where a
    *  REAL catalog member in [levelMin, levelMax] is offered + prereq/coreq-satisfiable. */
   pool?: { dept: string; levelMin: number; levelMax: number };
   ```
2. **Optimality signal** (introduced in **T7**): `SolverOutput` ([types.ts:181]) and `ForwardSchedule` ([packages/shared/src/types.ts:1055]) gain
   ```ts
   /** Structured optimality of the returned plan (companion to `warnings`):
    *  "optimal" — search ran to exhaustion; the winner is the proven optimum.
    *  "best-effort" — a VALID plan was found (feasibility-first / truncated) but it
    *    may not be the most preferred.
    *  "feasibility-unconfirmed" — no valid plan was found within budget (NOT proven
    *    infeasible). Omitted is treated as "optimal" by consumers for back-compat. */
   optimality?: "optimal" | "best-effort" | "feasibility-unconfirmed";
   ```

---

## Task sequencing (subagent dispatch order)

`T1a → T1b → T2 → T3a → T3b` (tractability critical path) · `T5 → T4a → T4b` (pools) · `T6`, `T7`, `T8` (independent after T1) · `T9` last (depends on all).

---

# T1 — Feasibility-first architecture (PLAN-6)

The core fix. Split into **T1a** (new `findFirstValidPlan` in `search.ts`) and **T1b** (wire feasibility-first into `solveForwardSchedule`). T3 adds `localImprove`/diverse top-K on top.

---

## Task T1a — `findFirstValidPlan`: stop at the first valid leaf

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/search.ts` (add a stop-at-first traversal mode + a `findFirstValidPlan` entry point; reuse `runSearch`'s ordering/prune/leaf checks)
- Test: `packages/engine/tests/forwardSchedule/feasibilityFirst.test.ts` (new)

**Seam:** `runSearch` [search.ts:267-403] (the `truncated` early-return at :331-334 and post-`recurse` check at :396 are the pattern to mirror for a `found` early-exit). New export beside `searchBestPlan` [:564] / `searchTopKPlans` [:631].

**Goal:** A search that returns the **first** valid complete leaf and stops — sound + complete for *feasibility* (finds a valid plan iff one exists, when run to exhaustion), but stops at first success so it does NOT enumerate the whole space. Because per-variable values are ordered best-first by `scorePlan` ([search.ts:371-382]), the first leaf is already a good plan. On no valid leaf within budget → `exhaustive` reports whether the (empty) result is proven-infeasible (ran out) vs truncated (hit `maxNodes`), and `blockers`/`unsatisfiable` are populated exactly as `searchBestPlan` does via `computeBlockers` [:505].

- [ ] **Step 1: Write the failing test.** Create `packages/engine/tests/forwardSchedule/feasibilityFirst.test.ts`. Copy `makeMinimalDpr`, `makeInput`, `placed` verbatim from `search.test.ts` (lines 42-129). Then:

```ts
import { describe, it, expect } from "vitest";
import {
    buildConstraintContext,
    checkOfferingSeasonMatch,
    checkPrereqsSatisfied,
    checkNotClauseClear,
    checkCoreqsSameTerm,
    checkPerTermCeiling,
    checkRequirementCoverage,
    checkMajorCreditFloor,
    checkResidencyFloor,
} from "../../src/agent/forwardSchedule/constraintModel.js";
import { findFirstValidPlan, searchBestPlan } from "../../src/agent/forwardSchedule/search.js";
import { compareSolverTerms } from "../../src/agent/forwardSchedule/solverHelpers.js";
// ... (makeMinimalDpr / makeInput / placed copied here) ...

describe("findFirstValidPlan — returns a valid plan fast (feasibility-first)", () => {
    it("the collide case greedy fails: returns a valid plan covering both requirements with distinct courses", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            creditCeiling: 6,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "C-UA 3"] },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }],
                ["B-UA 2", { title: "B", credits: 4 }],
                ["C-UA 3", { title: "C", credits: 4 }],
            ]),
            offerings: new Map([["A-UA 1", ["fall"]], ["B-UA 2", ["spring"]], ["C-UA 3", ["spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);

        expect(res.plan).not.toBeNull();
        const plan = res.plan!;
        // Valid by every sound predicate (the leaf was accepted only if these hold).
        expect(checkOfferingSeasonMatch(plan, ctx).ok).toBe(true);
        expect(checkPrereqsSatisfied(plan, ctx).ok).toBe(true);
        expect(checkNotClauseClear(plan, ctx).ok).toBe(true);
        expect(checkCoreqsSameTerm(plan, ctx).ok).toBe(true);
        expect(checkPerTermCeiling(plan, ctx).ok).toBe(true);
        expect(checkRequirementCoverage(plan, ctx).ok).toBe(true);
        expect(checkMajorCreditFloor(plan, ctx).ok).toBe(true);
        expect(checkResidencyFloor(plan, ctx).ok).toBe(true);
        const r1 = plan.placed.find(p => p.satisfiesRId === "r1")?.courseId;
        const r2 = plan.placed.find(p => p.satisfiesRId === "r2")?.courseId;
        expect(r1).not.toBe(r2);
    });

    it("places a prereq before its dependent (leaf-checked prereqs)", () => {
        const input = makeInput({
            currentTerm: "2026-fall",
            graduationTerm: "2027-spring",
            prereqs: new Map([["ADV-UA 2", [{ type: "AND", courses: ["BASE-UA 1"] }]]]),
            unmetRequirements: [
                { rId: "rAdv", title: "Adv", category: "major_required", credits: 4, candidateCourses: ["ADV-UA 2"] },
                { rId: "rBase", title: "Base", category: "major_required", credits: 4, candidateCourses: ["BASE-UA 1"] },
            ],
            courseCatalog: new Map([["ADV-UA 2", { title: "Adv", credits: 4 }], ["BASE-UA 1", { title: "Base", credits: 4 }]]),
            offerings: new Map([["BASE-UA 1", ["fall"]], ["ADV-UA 2", ["spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        const baseTerm = res.plan!.placed.find(p => p.courseId === "BASE-UA 1")!.term;
        const advTerm = res.plan!.placed.find(p => p.courseId === "ADV-UA 2")!.term;
        expect(compareSolverTerms(baseTerm, advTerm)).toBeLessThan(0);
    });

    it("infeasible (summer-only candidate in fall/spring window): null plan, exhaustive, blocker lists the rId", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            unmetRequirements: [{ rId: "rSum", title: "Summer Only", category: "major_required", credits: 4, candidateCourses: ["SUM-UA 1"] }],
            courseCatalog: new Map([["SUM-UA 1", { title: "Summer Only", credits: 4 }]]),
            offerings: new Map([["SUM-UA 1", ["summer"]]]),
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).toBeNull();
        expect(res.exhaustive).toBe(true); // proven infeasible (ran out, not truncated)
        expect(res.unsatisfiable).toContain("rSum");
        expect(res.blockers.some(b => b.rId === "rSum")).toBe(true);
    });

    it("determinism: two calls on identical input return the identical plan", () => {
        const make = () => makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 8,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }], ["B-UA 2", { title: "B", credits: 4 }],
                ["C-UA 3", { title: "C", credits: 4 }], ["D-UA 4", { title: "D", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]], ["B-UA 2", ["fall", "spring"]],
                ["C-UA 3", ["fall", "spring"]], ["D-UA 4", ["fall", "spring"]],
            ]),
        });
        const a = findFirstValidPlan(buildConstraintContext(make()));
        const b = findFirstValidPlan(buildConstraintContext(make()));
        expect(a.plan!.placed).toEqual(b.plan!.placed);
    });

    it("first valid leaf matches the best-first walk's first acceptance (returned plan is a valid leaf searchBestPlan would also accept)", () => {
        // Single requirement, single candidate, fall+spring offered, no fixed load:
        // the first valid leaf and the optimum coincide; assert findFirst's plan is
        // valid AND equals searchBestPlan's plan on this unambiguous case.
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            unmetRequirements: [{ rId: "r1", title: "Only", category: "major_required", credits: 4, candidateCourses: ["ONE-UA 1"] }],
            courseCatalog: new Map([["ONE-UA 1", { title: "Only", credits: 4 }]]),
            offerings: new Map([["ONE-UA 1", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const first = findFirstValidPlan(ctx);
        const best = searchBestPlan(ctx);
        expect(first.plan).not.toBeNull();
        expect(checkRequirementCoverage(first.plan!, ctx).ok).toBe(true);
        expect(first.plan!.placed.find(p => p.satisfiesRId === "r1")!.courseId).toBe("ONE-UA 1");
        // Both are valid; on a single-leaf-optimal case they coincide.
        expect(first.plan!.placed.find(p => p.satisfiesRId === "r1")!.term)
            .toBe(best.plan!.placed.find(p => p.satisfiesRId === "r1")!.term);
    });
});
```

- [ ] **Step 2: Run it — expect FAIL.** `pnpm exec vitest run "feasibilityFirst"` → fails (`findFirstValidPlan` not exported).

- [ ] **Step 3: Implement `findFirstValidPlan`.** In `search.ts`, refactor `runSearch` to accept an early-stop signal, then add the entry point. Two sound options — implement **A** (a `stopOnFirstValidLeaf` flag) as it reuses the existing traversal exactly:

  In `runSearch` ([:267]) add a parameter and an early-stop flag that mirrors `truncated`:
  ```ts
  function runSearch(
      ctx: ConstraintContext,
      options: SearchOptions | undefined,
      onValidLeaf: (plan: PartialPlan, score: number) => boolean | void,  // return true ⇒ stop
  ): SearchRun {
      // ...unchanged setup (weights, fixed, maxNodes, variables, ordering)...
      let nodes = 0;
      let truncated = false;
      let stopped = false;                                    // NEW
      function recurse(assigned: PlacedCourse[], i: number): void {
          nodes++;
          if (nodes > maxNodes) { truncated = true; return; }
          if (i === variables.length) {
              const plan: PartialPlan = { placed: [...fixed, ...assigned] };
              if (
                  checkPrereqsSatisfied(plan, ctx).ok &&
                  checkRequirementCoverage(plan, ctx).ok &&
                  checkMajorCreditFloor(plan, ctx).ok &&
                  checkResidencyFloor(plan, ctx).ok
              ) {
                  const stop = onValidLeaf(plan, scorePlan(plan, ctx, weights));   // capture signal
                  if (stop === true) stopped = true;                              // NEW
              }
              return;
          }
          // ...unchanged value gen + sort...
          for (const { value } of candidateValues) {
              recurse([...assigned, value], i + 1);
              if (truncated || stopped) return;               // NEW: also bail on stop
          }
      }
      recurse([], 0);
      return { variables, fixed, nodes, truncated };
  }
  ```
  `searchBestPlan` / `searchTopKPlans` callbacks keep returning `undefined` (never stop) — their behavior is byte-identical (the callback's return was previously ignored; widening to `boolean | void` and ignoring `undefined` is back-compatible). Then add:
  ```ts
  /** Feasibility-first: return the FIRST valid complete leaf and stop. Because per-
   *  variable values are ordered best-first by scorePlan, the first leaf is a good
   *  (not provably optimal) plan; T3's localImprove refines it. On no valid leaf:
   *  `plan: null`, with exhaustive/blockers/unsatisfiable exactly as searchBestPlan
   *  (proven-infeasible when it ran out within budget; truncated when maxNodes hit). */
  export function findFirstValidPlan(ctx: ConstraintContext, options?: SearchOptions): SearchResult {
      let found: PartialPlan | null = null;
      let foundScore = Infinity;
      const run = runSearch(ctx, options, (plan, score) => {
          found = plan;
          foundScore = score;
          return true; // stop at the first valid leaf
      });
      const blockers: Blocker[] = found === null ? computeBlockers(run, ctx) : [];
      return {
          plan: found,
          score: foundScore,
          exhaustive: !run.truncated,
          nodesExplored: run.nodes,
          unsatisfiable: blockers.map(b => b.rId),
          blockers,
      };
  }
  ```

- [ ] **Step 4: Run it — expect PASS + clean.** `pnpm exec vitest run "feasibilityFirst"` → PASS. Then re-run `search.test.ts` (`pnpm exec vitest run "forwardSchedule/search"`) to confirm `searchBestPlan`/`searchTopKPlans` are unchanged. Typecheck (`--noEmit`, all three projects). Shadow check → empty.

- [ ] **Step 5: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/search.ts packages/engine/tests/forwardSchedule/feasibilityFirst.test.ts
git commit -m "feat(planner): findFirstValidPlan — feasibility-first search (first valid leaf, T1a)"
```

---

## Task T1b — Wire feasibility-first into `solveForwardSchedule`

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/solver.ts` (swap the primary search path)
- Test: `packages/engine/tests/forwardSchedule/feasibilityFirst.test.ts` (extend — end-to-end through the entry point)

**Seam:** `solveForwardSchedule` [solver.ts:167] — the `searchTopKPlans(ctx, {fixed, k:5, …})` call at [:306] and the winner/alternatives/truncation handling [:307-351].

**Goal:** The production entry point uses `findFirstValidPlan` as the **primary** path (fast, no whole-space enumeration). The winner becomes the first valid plan; top-K alternatives are deferred to T3 (until then, keep `alternativeCandidates` undefined OR fall back to a *budgeted* `searchTopKPlans` — see Step 3). The truncation/infeasibility/blocker handling and the frozen signature are preserved. **No regression** to `forwardScheduleSolver.test.ts` / `infeasibility.test.ts` / `truncation.test.ts` (the feasibility-first plan is still valid; only optimality-of-winner claims relax — those are asserted at the *search-unit* level, not the solver-entry level, per the existing tests).

- [ ] **Step 1: Write the failing test.** Append to `feasibilityFirst.test.ts` an end-to-end case through the entry point proving a many-requirement input completes (no truncation) and is valid:

```ts
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";

describe("solveForwardSchedule — feasibility-first completes a wide input without truncation", () => {
    it("8 independent 2-candidate requirements over 4 terms: valid, feasible, no truncation warning", () => {
        // 8 requirements × 2 candidates each, all fall+spring, 4-term horizon, ceiling 18.
        // The OLD whole-space search would explore an enormous leaf set; feasibility-first
        // returns the first valid leaf immediately.
        const reqs = [];
        const catalog = new Map<string, { title: string; credits: number }>();
        const offerings = new Map<string, Array<"fall" | "spring" | "summer" | "january">>();
        for (let i = 1; i <= 8; i++) {
            const a = `AA${i}-UA ${i}`, b = `BB${i}-UA ${i}`;
            reqs.push({ rId: `r${i}`, title: `Req ${i}`, category: "major_elective", credits: 4, candidateCourses: [a, b] });
            catalog.set(a, { title: a, credits: 4 }); catalog.set(b, { title: b, credits: 4 });
            offerings.set(a, ["fall", "spring"]); offerings.set(b, ["fall", "spring"]);
        }
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-fall", creditCeiling: 18,
            creditsEarned: 96, graduationCreditMinimum: 128,
            unmetRequirements: reqs, courseCatalog: catalog, offerings,
        });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(true);
        // No truncation advisory (feasibility-first found a leaf fast).
        const warns = out.warnings ?? [];
        expect(warns.some(w => w.includes("truncated"))).toBe(false);
        // Every requirement is covered by a bound specific_planned slot.
        const coveredRIds = new Set(
            out.semesters.flatMap(s => s.slots).flatMap(sl => sl.kind === "specific_planned" ? sl.satisfiesRules : []),
        );
        for (let i = 1; i <= 8; i++) expect(coveredRIds.has(`r${i}`)).toBe(true);
    });
});
```

- [ ] **Step 2: Run it — expect FAIL or SLOW.** `pnpm exec vitest run "feasibilityFirst" -t "without truncation"`. (Before the swap, the entry point uses `searchTopKPlans`; with 8×2 over 4 terms it may either truncate — emitting the warning — or be slow. The assertion `warns…truncated === false` fails when it truncates.)

- [ ] **Step 3: Implement the swap.** In `solveForwardSchedule` [solver.ts:306], replace the primary `searchTopKPlans` call with `findFirstValidPlan` for the **winner**, preserving the truncation + infeasibility + blocker logic (which already reads `exhaustive`, `nodesExplored`, `blockers`):
  ```ts
  import { findFirstValidPlan, searchTopKPlans } from "./search.js";
  // ...
  const winner = findFirstValidPlan(ctx, { fixed, ...(maxNodes !== undefined ? { maxNodes } : {}) });
  const winnerPlan = winner.plan ?? { placed: fixed };

  const truncMsg = truncationWarning(winner.exhaustive, winner.plan !== null, winner.nodesExplored);
  if (truncMsg !== null) warningsList.push(truncMsg);

  if (winner.plan === null) {
      for (const b of winner.blockers) extraViolations.push({ kind: b.kind, detail: b.detail });
      if (winner.exhaustive) {
          const cap = computeCapacityDiagnostic(input, ctx, fixed);
          if (cap !== null) extraViolations.push(cap);
      }
  }
  ```
  For `alternativeCandidates`: **defer to T3** — leave undefined for now (the search-unit `searchTopKPlans` still exists and its tests still pass; the solver simply doesn't call it on the primary path). Delete the `top.plans.slice(1)` alternatives block [solver.ts:349-351] and set `const alternativeCandidates = undefined;` with a `// TODO(T3): diverse top-K` comment. (T3b restores real alternatives via `findDiverseValidPlans`.)

  > **Note for the implementer:** the variable previously named `top` is now `winner`; update every reference in the [:307-351] block. `winner.plan !== null` is the `hasValidPlan` argument to `truncationWarning`.

- [ ] **Step 4: Run it — expect PASS + clean.** `pnpm exec vitest run "feasibilityFirst"` → PASS. Then **re-run the full Phase-2 solver suite** to catch regressions: `pnpm exec vitest run "forwardScheduleSolver" "forwardSchedule/infeasibility" "forwardSchedule/truncation" "forwardSchedule/materializePlan" "forwardSchedule/objectiveBalance" "agent/alternatives" "agent/coreqs" "agent/solverPreferences" "agent/proposePlanChange"`. Investigate any failure: a *valid-plan* assertion must still hold; an *optimality-of-winner* assertion at the solver-entry level (if any) legitimately relaxes to "valid" — but verify it's not a real regression before changing a test. Then full suite `pnpm exec vitest run` ≥ 1565/9. Typecheck (3×). Shadow check → empty.

- [ ] **Step 5: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/solver.ts packages/engine/tests/forwardSchedule/feasibilityFirst.test.ts
git commit -m "feat(planner): solveForwardSchedule uses feasibility-first as the primary search path (T1b)"
```

---

# T2 — 16-credit/term default grid + relax fallback

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/search.ts` (a *soft* 16-credit per-term target in the find-valid value ordering/first-fit) and/or `constraintModel.ts` (a per-term soft-target read from `creditTargetPerSemester`)
- Modify: `packages/engine/src/agent/forwardSchedule/solver.ts` (the relax ladder: retry find-valid with a widened per-term target / extended horizon when the 16-grid yields no plan — only when the horizon is *derived*, not a stated hard target)
- Test: `packages/engine/tests/forwardSchedule/relaxGrid.test.ts` (new)

**Seam:** find-valid per-term target — today the only per-term cap is the hard `checkPerTermCeiling` (=`creditCeiling`=18) [constraintModel.ts:307]; there is no 16 grid. Horizon `futureTerms` derives from `deriveGraduationTerm(..., creditTargetPerSemester=16)` [buildSolverInput.ts:554, 159]. Relax ladder wraps the `findFirstValidPlan` call in `solveForwardSchedule` [solver.ts:306]. Capacity diagnostic that distinguishes "genuinely infeasible" already exists [solver.ts:126].

**Goal:** The 90% case is a near-instant 16-credit/term first-fit. When the 16-grid can't satisfy validity, **relax automatically** (allow up to `creditCeiling`/18 per term → add a term to a *derived* horizon → widen) — never false-infeasible. Think in **credits**, not 4-course counts. The final term takes the remainder (≤ target; F-1 edge handled in T6). A student-stated *hard* `graduationTarget` is NOT silently extended — genuine infeasibility still returns binding constraints (PLAN-13).

**Design decision (locked):** Implement the 16-grid as a **soft per-term target in the value-ordering / first-fit** of the feasibility-first search, NOT as a new hard constraint. The hard cap stays `creditCeiling`. Concretely: in `findFirstValidPlan`'s value generation, order/prefer terms whose post-placement credits stay ≤ the soft target (`creditTargetPerSemester`), falling back to terms up to `creditCeiling` when no soft-fitting term exists. This keeps completeness (any ≤ceiling placement is still reachable) while making the *first* leaf a clean 16-grid plan. The relax-by-extra-term is a solver-level retry.

- [ ] **Step 1: Write the failing test.** Create `relaxGrid.test.ts` (copy the three factories). Cases:

```ts
describe("16-credit grid + relax fallback", () => {
    it("90% case: independent requirements first-fit at ≤16 credits/term (no term exceeds the soft target)", () => {
        // 6 requirements (4 cr each = 24 cr) over a 2-term horizon ⇒ 12 cr/term, all ≤16.
        // Assert no NON-final term exceeds 16 in the materialized plan's bound+IP credits.
        const reqs = [], catalog = new Map(), offerings = new Map();
        for (let i = 1; i <= 6; i++) {
            const c = `C${i}-UA ${i}`;
            reqs.push({ rId: `r${i}`, title: `R${i}`, category: "major_elective", credits: 4, candidateCourses: [c] });
            catalog.set(c, { title: c, credits: 4 }); offerings.set(c, ["fall", "spring"]);
        }
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            creditsEarned: 104, graduationCreditMinimum: 128,
            unmetRequirements: reqs, courseCatalog: catalog, offerings,
        });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(true);
        // Sum of BOUND (specific_planned, non-free) credits per term ≤ 16.
        for (const sem of out.semesters) {
            const boundCredits = sem.slots
                .filter(s => s.kind === "specific_planned")
                .reduce((n, s) => n + s.credits, 0);
            expect(boundCredits).toBeLessThanOrEqual(16);
        }
    });

    it("accelerator: requirements that only fit at 18/term still produce a valid plan (relax to ceiling)", () => {
        // 9 requirements (36 cr) over 2 terms ⇒ 18 cr/term needed; 16-grid can't hold all,
        // relax to ceiling 18 ⇒ still valid, no false-infeasible.
        const reqs = [], catalog = new Map(), offerings = new Map();
        for (let i = 1; i <= 9; i++) {
            const c = `C${i}-UA ${i}`;
            reqs.push({ rId: `r${i}`, title: `R${i}`, category: "major_elective", credits: 4, candidateCourses: [c] });
            catalog.set(c, { title: c, credits: 4 }); offerings.set(c, ["fall", "spring"]);
        }
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            creditsEarned: 92, graduationCreditMinimum: 128,
            unmetRequirements: reqs, courseCatalog: catalog, offerings,
        });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(true);
        const warns = out.warnings ?? [];
        expect(warns.some(w => w.includes("truncated"))).toBe(false);
    });

    it("genuinely infeasible (more credits than fit ≤ ceiling in a hard-target window): binding constraint, not silent", () => {
        // 11 requirements (44 cr) over 2 terms; even at ceiling 18 only 36 cr fit ⇒ infeasible.
        const reqs = [], catalog = new Map(), offerings = new Map();
        for (let i = 1; i <= 11; i++) {
            const c = `C${i}-UA ${i}`;
            reqs.push({ rId: `r${i}`, title: `R${i}`, category: "major_required", credits: 4, candidateCourses: [c] });
            catalog.set(c, { title: c, credits: 4 }); offerings.set(c, ["fall", "spring"]);
        }
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            creditsEarned: 84, graduationCreditMinimum: 128,
            unmetRequirements: reqs, courseCatalog: catalog, offerings,
        });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(false);
        // PLAN-13: a real binding constraint (capacity), not a bare count.
        expect(out.feasibility.constraintViolations.some(v => v.kind === "graduation_total")).toBe(true);
    });
});
```

- [ ] **Step 2: Run it — expect FAIL.** `pnpm exec vitest run "relaxGrid"`. The first case (≤16) fails (the search may place 3 courses = 12 in one term and 3 = 12 in the other — that actually passes; but a 6/2 split where one term gets 4 courses = 16 and other gets 2 = 8 also passes ≤16. To make this a meaningful FAIL, the implementer should first confirm whether the soft-target ordering is needed; if the existing best-first ordering already yields ≤16 here, strengthen the fixture to one where the *unconstrained* first-fit would pile >16 into one term — e.g. give all 6 courses `["fall"]`-only so a naive first-fit stacks 24 cr into fall, exceeding 16). **Adjust the fixture so the test genuinely fails before the soft-target ordering is added.**

  > Concrete failing fixture for case 1: make all 6 courses `offerings: ["fall", "spring"]` but with the OLD value-ordering the best-first-by-score already balances; so instead test the *relax* path directly via case 2/3 and make case 1 assert the soft-target via a fixture where a single fall-only-heavy cluster forces the grid. The implementer picks the minimal fixture that fails pre-implementation and passes post-implementation; the **contract** is: non-final bound credits ≤ `creditTargetPerSemester` whenever a ≤-target assignment exists.

- [ ] **Step 3: Implement.** Two parts:
  1. **Soft 16-grid in find-valid value ordering** (`search.ts`): when generating/sorting candidate `(course, term)` values for a variable, add a primary sort key that prefers a term whose running credits (fixed + assigned so far in that term) + this course's credits ≤ `ctx.input.creditTargetPerSemester`, before the existing `scorePlan` tie-break. This makes the first valid leaf respect the 16 grid when possible, while leaving all ≤`creditCeiling` placements reachable (completeness preserved — the soft target only reorders, never prunes).
  2. **Relax ladder** (`solver.ts`): wrap the `findFirstValidPlan` call. If it returns `plan === null` AND `exhaustive` (proven no plan at the current horizon) AND the horizon was **derived** (no explicit student `graduationTarget` — detectable because `buildSolverInput` set `graduationTerm` from the credit-derived default; thread a boolean `graduationTermWasDerived` onto `SolverInput`, set in `buildSolverInput` [:215-218] when neither override nor `session.graduationTarget` supplied), retry once with the horizon extended by one main term (rebuild `ctx` via `buildConstraintContext` on an input whose `graduationTerm = computeNextMainTerm(input.graduationTerm)` — reuse `alternatives.ts`'s `computeNextMainTerm` logic, extract it to `solverHelpers.ts` to avoid duplication). Cap the extension (e.g. ≤2 extra terms) to guarantee termination. If still null → keep the existing binding-constraint/capacity path (PLAN-13 intact).

  > **Stop-and-ask guard:** if, after T1+T2, realistic worst-case inputs still truncate or can't be handled by this hand-rolled relax ladder, escalate to the owner (the pluggable external CP-SAT/MILP backend is a deliberate owner decision, not an automatic step — see plan §6 / cut-map).

- [ ] **Step 4: Run + clean.** `pnpm exec vitest run "relaxGrid"` → PASS. Re-run `feasibilityFirst`, `forwardScheduleSolver`, `infeasibility`, `materializePlan`, `summerJterm`. Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 5: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/search.ts packages/engine/src/agent/forwardSchedule/solver.ts packages/engine/src/agent/forwardSchedule/solverHelpers.ts packages/engine/src/agent/forwardSchedule/buildSolverInput.ts packages/engine/src/agent/forwardSchedule/types.ts packages/engine/tests/forwardSchedule/relaxGrid.test.ts
git commit -m "feat(planner): 16-credit/term soft grid + automatic relax fallback (never false-infeasible) (T2)"
```

# T3 — Local preference optimization + top-K (PLAN-7)

Restore preference quality on top of the (fast, feasibility-first) found plan, without re-enumerating the space. **T3a** = `localImprove`; **T3b** = `findDiverseValidPlans` → real `alternativeCandidates`.

---

## Task T3a — `localImprove`: validity-preserving descent toward the objective

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/localImprove.ts` (new module — keep `search.ts` focused)
- Modify: `packages/engine/src/agent/forwardSchedule/solver.ts` (apply `localImprove` to the found plan before materialize)
- Test: `packages/engine/tests/forwardSchedule/localImprove.test.ts` (new)

**Seam:** between `findFirstValidPlan` (T1b) and `materializePlan` in `solveForwardSchedule` [solver.ts:341]. Reuses `scorePlan` [constraintModel.ts:589], `checkHardConstraints` [constraintModel.ts:542], `computeBalanceScore` [balanceScore.ts:45].

**Goal:** Given the first valid plan, apply validity-preserving improving moves (re-place a requirement course in a different legal term; swap to another candidate of the same requirement) that strictly lower `scorePlan`, re-validating each move against the full hard-constraint set, until no improving move remains or a small iteration cap is hit. Pins (`source:"pin"`) and IP (`source:"ip"`) are never moved. Deterministic (fixed move order + strict-improvement-only). Result is still valid and ≥ as preferred as the input.

- [ ] **Step 1: Write the failing test.**
```ts
import { describe, it, expect } from "vitest";
import { buildConstraintContext, scorePlan, checkHardConstraints, type PartialPlan, type PlacedCourse } from "../../src/agent/forwardSchedule/constraintModel.js";
import { findFirstValidPlan } from "../../src/agent/forwardSchedule/search.js";
import { localImprove } from "../../src/agent/forwardSchedule/localImprove.js";
// ... factories copied ...

describe("localImprove — validity-preserving descent", () => {
    it("improves (or keeps) the objective and never returns an invalid plan", () => {
        // A found plan that piles two heavy courses into one term while another is
        // empty; a balancing move (re-place one in the empty term) lowers scorePlan.
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] },
                { rId: "r2", title: "Two", category: "major_required", credits: 4, candidateCourses: ["B-UA 2"] },
            ],
            courseCatalog: new Map([["A-UA 1", { title: "A", credits: 4 }], ["B-UA 2", { title: "B", credits: 4 }]]),
            offerings: new Map([["A-UA 1", ["fall", "spring"]], ["B-UA 2", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const found = findFirstValidPlan(ctx).plan!;
        const beforeScore = scorePlan(found, ctx);
        const improved = localImprove(found, ctx);

        // Still valid by the full hard-constraint set.
        expect(checkHardConstraints(improved, ctx).ok).toBe(true);
        // Never worse.
        expect(scorePlan(improved, ctx)).toBeLessThanOrEqual(beforeScore);
    });

    it("never moves a pin or an IP placement", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            unmetRequirements: [{ rId: "r1", title: "One", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] }],
            courseCatalog: new Map([["A-UA 1", { title: "A", credits: 4 }], ["PIN-UA 9", { title: "Pin", credits: 4 }]]),
            offerings: new Map([["A-UA 1", ["fall", "spring"]], ["PIN-UA 9", ["fall", "spring"]]]),
        });
        const ctx = buildConstraintContext(input);
        const fixed: PlacedCourse[] = [placed({ courseId: "PIN-UA 9", term: "2026-fall", source: "pin", satisfiesRId: null })];
        const found = findFirstValidPlan(ctx, { fixed }).plan!;
        const improved = localImprove(found, ctx);
        const pin = improved.placed.find(p => p.courseId === "PIN-UA 9")!;
        expect(pin.term).toBe("2026-fall"); // unchanged
        expect(pin.source).toBe("pin");
    });

    it("is deterministic and idempotent (improving an already-optimal plan is a no-op)", () => {
        const make = () => buildConstraintContext(makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            unmetRequirements: [{ rId: "r1", title: "One", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] }],
            courseCatalog: new Map([["A-UA 1", { title: "A", credits: 4 }]]),
            offerings: new Map([["A-UA 1", ["fall", "spring"]]]),
        }));
        const ctxA = make(), ctxB = make();
        const a = localImprove(findFirstValidPlan(ctxA).plan!, ctxA);
        const b = localImprove(findFirstValidPlan(ctxB).plan!, ctxB);
        expect(a.placed).toEqual(b.placed);
        expect(localImprove(a, ctxA).placed).toEqual(a.placed); // idempotent
    });
});
```

- [ ] **Step 2: Run → FAIL** (`localImprove` missing). `pnpm exec vitest run "localImprove"`.

- [ ] **Step 3: Implement `localImprove.ts`.** A bounded steepest-descent over validity-preserving moves:
```ts
import { scorePlan, checkHardConstraints, type ConstraintContext, type PartialPlan, type PlacedCourse } from "./constraintModel.js";
import { classifyWorkloadTier } from "./workloadTier.js";
import { parseTerm } from "./solverHelpers.js";

const MAX_PASSES = 20;
type Season = "fall" | "spring" | "summer" | "january";

/** Validity-preserving local search: repeatedly apply the single best strictly-improving
 *  move (re-term or swap-candidate of a requirement placement) until none remains or
 *  MAX_PASSES. Pins/IP are never moved. Deterministic; result is valid + ≤ input score. */
export function localImprove(plan: PartialPlan, ctx: ConstraintContext, weights?: Parameters<typeof scorePlan>[2]): PartialPlan {
    let current = plan;
    let currentScore = scorePlan(current, ctx, weights);
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        let bestPlan: PartialPlan | null = null;
        let bestScore = currentScore;
        // Candidate moves: for each requirement-source placement, try every other legal
        // term (re-term) and every other candidate course of its requirement (swap).
        for (const p of current.placed) {
            if (p.source !== "requirement") continue;            // never move pin/ip/free
            for (const move of enumerateMoves(p, current, ctx)) {
                if (!checkHardConstraints(move, ctx).ok) continue; // re-validate fully
                const s = scorePlan(move, ctx, weights);
                if (s < bestScore) { bestScore = s; bestPlan = move; }
            }
        }
        if (bestPlan === null) break;                            // local optimum
        current = bestPlan; currentScore = bestScore;
    }
    return current;
}
```
Implement `enumerateMoves(p, plan, ctx)` deterministically: (a) **re-term** — for each `term` in `ctx.futureTerms` (chronological) other than `p.term` that is offering-legal for `p.courseId`, yield the plan with `p` moved to `term`; (b) **swap** — for each other candidate `c` of `p`'s requirement (`ctx.input.unmetRequirements.find(r => r.rId === p.satisfiesRId)?.candidateCourses`) that is catalog-present and not excluded, yield the plan with `p` replaced by a `buildValue`-equivalent `PlacedCourse` for `c` in `p.term` (classify tier/weight via `classifyWorkloadTier` with `satisfiesRules:[p.satisfiesRId]`, credits from catalog). Ties broken by a stable key so descent is deterministic. (Hard re-validation via `checkHardConstraints` is the safety net — no move escapes validity.)

- [ ] **Step 4: Wire into solver** [solver.ts:341]: `const improved = localImprove(winnerPlan, ctx); const out = materializePlan(improved, ctx);`. (Only when `winner.plan !== null`; the fixed-only fallback `{ placed: fixed }` is not improved.)

- [ ] **Step 5: Run + clean.** `pnpm exec vitest run "localImprove"` → PASS; re-run `objectiveBalance`, `feasibilityFirst`, `forwardScheduleSolver`, `materializePlan`. Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 6: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/localImprove.ts packages/engine/src/agent/forwardSchedule/solver.ts packages/engine/tests/forwardSchedule/localImprove.test.ts
git commit -m "feat(planner): localImprove — validity-preserving preference descent on the found plan (T3a/PLAN-7)"
```

---

## Task T3b — `findDiverseValidPlans`: real top-K distinct alternatives (cheap)

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/search.ts` (add `findDiverseValidPlans`)
- Modify: `packages/engine/src/agent/forwardSchedule/solver.ts` (restore `alternativeCandidates` from diverse plans, not space exhaustion)
- Test: `packages/engine/tests/forwardSchedule/diversePlans.test.ts` (new)

**Seam:** `solver.ts` alternatives block (deferred in T1b). Reuses `findFirstValidPlan`, `planKey` [search.ts:409], `localImprove`, `materializePlan` + `buildAlternativeSummaries` [materializePlan.ts:964].

**Goal:** Produce up to K (default 4) **distinct valid** plans cheaply — by re-running feasibility-first while **forbidding** each prior winner's requirement-assignment signature (not by exhausting the space). Each is `localImprove`d. Feeds `alternativeCandidates`. On a single-solution input, returns just the one.

- [ ] **Step 1: Write the failing test.**
```ts
import { findDiverseValidPlans } from "../../src/agent/forwardSchedule/search.js";
// ...
describe("findDiverseValidPlans — cheap distinct valid plans", () => {
    it("returns up to k distinct valid plans, each passing the hard-constraint set", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring", creditCeiling: 18,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
            ],
            courseCatalog: new Map([
                ["A-UA 1", { title: "A", credits: 4 }], ["B-UA 2", { title: "B", credits: 4 }],
                ["C-UA 3", { title: "C", credits: 4 }], ["D-UA 4", { title: "D", credits: 4 }],
            ]),
            offerings: new Map([
                ["A-UA 1", ["fall", "spring"]], ["B-UA 2", ["fall", "spring"]],
                ["C-UA 3", ["fall", "spring"]], ["D-UA 4", ["fall", "spring"]],
            ]),
        });
        const ctx = buildConstraintContext(input);
        const plans = findDiverseValidPlans(ctx, { k: 4 });
        expect(plans.length).toBeGreaterThan(1);
        expect(plans.length).toBeLessThanOrEqual(4);
        for (const p of plans) expect(checkHardConstraints(p, ctx).ok).toBe(true);
        // Distinct requirement assignments.
        const sig = (p: PartialPlan) => p.placed.filter(x => x.satisfiesRId).map(x => `${x.satisfiesRId}=${x.courseId}@${x.term}`).sort().join(",");
        const sigs = plans.map(sig);
        expect(new Set(sigs).size).toBe(sigs.length);
    });

    it("single-solution input returns exactly one plan", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2026-fall",
            unmetRequirements: [{ rId: "r1", title: "Only", category: "major_required", credits: 4, candidateCourses: ["ONE-UA 1"] }],
            courseCatalog: new Map([["ONE-UA 1", { title: "Only", credits: 4 }]]),
            offerings: new Map([["ONE-UA 1", ["fall"]]]),
        });
        const ctx = buildConstraintContext(input);
        expect(findDiverseValidPlans(ctx, { k: 4 })).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm exec vitest run "diversePlans"`.

- [ ] **Step 3: Implement `findDiverseValidPlans`.** In `search.ts`:
```ts
/** Up to k distinct valid plans, cheaply: feasibility-first, then re-run forbidding each
 *  prior plan's requirement signature, until k found or no new plan. Each is localImprove-d
 *  by the caller (solver) — search returns raw distinct valid leaves here. Deterministic. */
export function findDiverseValidPlans(ctx: ConstraintContext, options?: TopKOptions): PartialPlan[] {
    const k = Math.max(1, options?.k ?? 4);
    const out: PartialPlan[] = [];
    const forbidden = new Set<string>();           // requirement-signature strings
    for (let i = 0; i < k; i++) {
        const res = findFirstValidPlan(ctx, { ...options, forbiddenSignatures: forbidden });
        if (res.plan === null) break;
        out.push(res.plan);
        forbidden.add(reqSignature(res.plan));
    }
    return out;
}
```
Add an optional `forbiddenSignatures?: Set<string>` to `SearchOptions`; in `runSearch`'s leaf acceptance, reject a leaf whose `reqSignature` ∈ `forbiddenSignatures` (treat as not-valid for *this* run, so the search continues to the next leaf). Add a private `reqSignature(plan)` (sorted `rId=courseId@term`, requirement-source only) — mirror the test helper in `search.test.ts:682`.

- [ ] **Step 4: Wire into solver** [solver.ts:341-351]: after `localImprove`, build alternatives:
```ts
const diverse = winner.plan !== null ? findDiverseValidPlans(ctx, { fixed, k: 5 }) : [];
const improvedAll = diverse.map(p => localImprove(p, ctx));
const winnerMaterialized = out;                                  // === materializePlan(improved)
const altOuts = improvedAll.slice(1).map(p => materializePlan(p, ctx));
const alternativeCandidates = altOuts.length > 0 ? buildAlternativeSummaries(winnerMaterialized, altOuts) : undefined;
```
(Ensure `improvedAll[0]` equals the winner used for `out`; simplest is to derive the winner from `diverse[0]` so winner + alternatives come from one diverse call. Keep the existing `buildAlternativeSummaries` shape.)

- [ ] **Step 5: Run + clean.** `pnpm exec vitest run "diversePlans"` → PASS; re-run `agent/alternatives`, `agent/comparePlanAlternatives`, `forwardScheduleSolver`, `feasibilityFirst`. Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 6: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/search.ts packages/engine/src/agent/forwardSchedule/solver.ts packages/engine/tests/forwardSchedule/diversePlans.test.ts
git commit -m "feat(planner): findDiverseValidPlans — real top-K distinct via forbid-signature restart (T3b)"
```

---

# T5 — Range-parsing correctness fix (no-invention) · do before T4

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/buildSolverInput.ts` (`extractCandidateCourseIds` + `COURSE_ID_RE`; emit a pool descriptor for a range)
- Modify: `packages/engine/src/agent/forwardSchedule/types.ts` (add `pool?` to `unmetRequirements[]` — the shared preamble type)
- Test: `packages/engine/tests/forwardSchedule/rangeParsing.test.ts` (new) + a real-DPR assertion

**Seam:** `COURSE_ID_RE` [buildSolverInput.ts:585], `extractCandidateCourseIds` [:587], the `unmetRequirements.map` [:228-234].

**Goal:** A requirement whose text contains a **range** like `"CSCI-UA 400-499"` emits a **pool descriptor** `{dept:"CSCI-UA", levelMin:400, levelMax:499}` (and NOT a fabricated single `CSCI-UA 400`). A list/explicit course still emits that course id. No planned course is ever absent from the catalog.

- [ ] **Step 1: Write the failing unit test.** `rangeParsing.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractCandidatesAndPool } from "../../src/agent/forwardSchedule/buildSolverInput.js";

describe("extractCandidatesAndPool — ranges become pool descriptors, never phantom courses", () => {
    it("a CSCI-UA 400-499 range yields a pool descriptor and NO phantom CSCI-UA 400", () => {
        const r = extractCandidatesAndPool({
            title: "Computer Science: Elective Courses",
            statusText: "",
            description: "Complete 3 courses from CSCI-UA 400-499.",
        });
        expect(r.pool).toEqual({ dept: "CSCI-UA", levelMin: 400, levelMax: 499 });
        expect(r.candidateCourses).not.toContain("CSCI-UA 400");
    });
    it("an explicit course list still enumerates individual ids and no pool", () => {
        const r = extractCandidatesAndPool({
            title: "Math Core",
            statusText: "",
            description: "Take MATH-UA 120 and MATH-UA 121.",
        });
        expect(r.candidateCourses).toEqual(expect.arrayContaining(["MATH-UA 120", "MATH-UA 121"]));
        expect(r.pool).toBeUndefined();
    });
    it("a single course (no range) is unchanged", () => {
        const r = extractCandidatesAndPool({ title: "X", statusText: "", description: "CSCI-UA 101" });
        expect(r.candidateCourses).toEqual(["CSCI-UA 101"]);
        expect(r.pool).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run → FAIL** (`extractCandidatesAndPool` missing). `pnpm exec vitest run "rangeParsing"`.

- [ ] **Step 3: Implement.** Replace `extractCandidateCourseIds` with `extractCandidatesAndPool` returning `{ candidateCourses: string[]; pool?: { dept; levelMin; levelMax } }`. Add a range regex that runs **before** the single-course regex and consumes the matched span so the tail isn't re-matched as a phantom:
```ts
const COURSE_ID_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{1,4}[A-Z]?)\b/g;
// Range: "CSCI-UA 400-499" or "CSCI-UA 400–499" (en-dash) or "CSCI-UA 400 to 499".
const COURSE_RANGE_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{2,4})\s*(?:-|–|to)\s*(\d{2,4})\b/g;

export function extractCandidatesAndPool(req: { description?: string; statusText: string; title: string }): {
    candidateCourses: string[];
    pool?: { dept: string; levelMin: number; levelMax: number };
} {
    const sources = [req.description ?? "", req.statusText, req.title].join(" ");
    // 1. Detect a range first; if present, emit a pool descriptor and BLANK the matched span
    //    so the single-course regex below does not turn "400" / "499" into phantom courses.
    let pool: { dept: string; levelMin: number; levelMax: number } | undefined;
    let masked = sources;
    const rangeMatch = COURSE_RANGE_RE.exec(sources);
    if (rangeMatch) {
        const dept = rangeMatch[1]!;
        const levelMin = parseInt(rangeMatch[2]!, 10);
        const levelMax = parseInt(rangeMatch[3]!, 10);
        if (levelMax >= levelMin) {
            pool = { dept, levelMin, levelMax };
            masked = sources.replace(COURSE_RANGE_RE, " "); // remove the range span(s)
        }
    }
    // 2. Enumerate explicit single course ids from the (range-masked) text.
    const out = new Set<string>();
    for (const m of masked.matchAll(COURSE_ID_RE)) out.add(`${m[1]} ${m[2]}`);
    return { candidateCourses: Array.from(out), ...(pool ? { pool } : {}) };
}
```
Update the call site [:228-234] to spread both fields:
```ts
const unmetRequirements: SolverInput["unmetRequirements"] = unmetReqs.map(req => {
    const { candidateCourses, pool } = extractCandidatesAndPool(req);
    return {
        rId: req.rId,
        title: req.title,
        category: kindByRId.get(req.rId) ?? "unknown",
        credits: inferRequirementCredits(req),
        candidateCourses,
        ...(pool ? { pool } : {}),
    };
});
```
Add the `pool?` field to `SolverInput.unmetRequirements[]` in `types.ts` (the preamble type). Keep `extractCandidateCourseIds` exported as a thin wrapper if any other caller imports it (grep first; if none, replace outright).

- [ ] **Step 4: Real-DPR assertion.** Add a test using the real fixture (mirror the DPR fixture pattern; `tests/fixtures/dpr_sample.redacted.txt`) that builds the SolverInput and asserts: no `unmetRequirements[].candidateCourses` entry is absent from `courseCatalog` for a range requirement — i.e. ranges produced a `pool`, not phantom ids. (If the sample has `R1142/30` "CSCI-UA 400-499", assert it carries a `pool` and not `"CSCI-UA 400"`.)
```ts
// rangeParsing.realdpr.test.ts — uses parseDpr + buildSolverInput against the sample.
```

- [ ] **Step 5: Run + clean.** `pnpm exec vitest run "rangeParsing"` → PASS. Re-run `forwardScheduleBuild`, `forwardScheduleSolver`, `materializePlan` (phantom courses previously became placeholders — confirm placeholder behavior still holds for pools, now via the descriptor). Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 6: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/buildSolverInput.ts packages/engine/src/agent/forwardSchedule/types.ts packages/engine/tests/forwardSchedule/rangeParsing.test.ts packages/engine/tests/forwardSchedule/rangeParsing.realdpr.test.ts
git commit -m "fix(planner): range parsing emits a pool descriptor, never a phantom single course (T5/no-invention)"
```

---

# T4 — Feasibility-aware pool placeholders

Represent choose-N pools as sound placeholders, not enumerated members. **T4a** = pool variable + search domain-legality; **T4b** = materialize the pool placeholder + bind-time. Depends on T5 (pool descriptor) + T1.

---

## Task T4a — Pool placeholder variable + sound domain legality

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/constraintModel.ts` (`buildRequirementVariables` emits a pool-kind variable; a pool-legality predicate for `(pool, term)`)
- Modify: `packages/engine/src/agent/forwardSchedule/search.ts` (value generation for a pool variable = `(POOL-<rId>, term)` legal iff ≥1 real member fits)
- Test: `packages/engine/tests/forwardSchedule/poolPlaceholders.test.ts` (new)

**Seam:** `buildRequirementVariables` [constraintModel.ts:104-145], `rawValues` [search.ts:190-202], the heavy-weight classification.

**Goal:** A requirement carrying a `pool` descriptor (from T5) OR `majorRuleKinds.get(rId)==="choose_n"` with many candidates becomes a **single pool variable** whose value is a synthetic `(courseId: "POOL-<rId>", term)` placeholder, legal in term T **iff ≥1 real catalog member in the pool is offered in T and its prereqs/coreqs are satisfiable by T** given the rest of the plan (sound — no false reservation). The search branches over **terms only**, not specific members → branching cut. Weight stays **heavy (1.0)** for major-elective/Core pools. Chain-linked members (a pool course that is a prereq/coreq of another required course) stay explicit (do NOT fold them into the opaque pool).

- [ ] **Step 1: Write the failing test.**
```ts
describe("pool placeholders — branch over terms, not members; sound legality; heavy weight", () => {
    it("a 50-member pool becomes ONE variable; the search does not enumerate members", () => {
        // 50 catalog members CSCI-UA 400..449, all offered fall+spring. As a pool, the
        // search must place a single POOL-r1 placeholder, not branch over 50 courses.
        const catalog = new Map(), offerings = new Map();
        for (let n = 400; n < 450; n++) {
            const id = `CSCI-UA ${n}`; catalog.set(id, { title: id, credits: 4 }); offerings.set(id, ["fall", "spring"]);
        }
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            unmetRequirements: [{
                rId: "r1", title: "CS Elective", category: "major_elective", credits: 4,
                candidateCourses: [], pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 },
            }],
            courseCatalog: catalog, offerings,
            programRules: { majorRuleKinds: new Map([["r1", "choose_n"]]), schoolCoreRuleIds: new Set(), generalCategoryRuleIds: new Set(), residencyMinCredits: null, majorCreditMinimum: null, upperLevelMinCredits: null },
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).not.toBeNull();
        const poolPlacement = res.plan!.placed.find(p => p.satisfiesRId === "r1");
        expect(poolPlacement).toBeDefined();
        expect(poolPlacement!.courseId).toBe("POOL-r1");           // synthetic, not a specific member
        expect(poolPlacement!.workloadWeight).toBeGreaterThanOrEqual(1.0); // heavy
    });

    it("a pool placeholder is NOT legal in a term where no real member is offered", () => {
        // Members offered FALL only; a one-term spring-only horizon ⇒ no legal pool value.
        const catalog = new Map([["CSCI-UA 400", { title: "x", credits: 4 }]]);
        const offerings = new Map([["CSCI-UA 400", ["fall"] as Array<"fall"|"spring"|"summer"|"january">]]);
        const input = makeInput({
            currentTerm: "2027-spring", graduationTerm: "2027-spring",
            unmetRequirements: [{ rId: "r1", title: "CS Elective", category: "major_elective", credits: 4, candidateCourses: [], pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 } }],
            courseCatalog: catalog, offerings,
            programRules: { majorRuleKinds: new Map([["r1", "choose_n"]]), schoolCoreRuleIds: new Set(), generalCategoryRuleIds: new Set(), residencyMinCredits: null, majorCreditMinimum: null, upperLevelMinCredits: null },
        });
        const ctx = buildConstraintContext(input);
        const res = findFirstValidPlan(ctx);
        expect(res.plan).toBeNull();                                // no legal term for the pool
        expect(res.blockers.some(b => b.rId === "r1")).toBe(true);
    });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm exec vitest run "poolPlaceholders"`.

- [ ] **Step 3: Implement.** In `constraintModel.ts`:
  - Extend `RequirementVariable` with `kind: "specific" | "pool"` and (for pool) the `pool` descriptor + the resolved real-member list `poolMembers: string[]` (catalog ids in `[levelMin, levelMax]` for `dept`, computed from `ctx.input.courseCatalog` keys). In `buildRequirementVariables`, when a requirement has a `pool` (and is not better served by explicit candidates), emit a single pool variable. **Chain-linked exception:** if a real member is a prereq/coreq of another required course (`ctx.dependentsIndex`/`coreqs`), keep that member an explicit candidate of a `specific` variable (do not bury it in the pool).
  - Add `poolMemberFitsTerm(pool/poolMembers, term, plan, ctx)`: true iff ∃ member offered in `term` (via `offerings`) whose prereqs are satisfiable by `term` (reuse `checkAllPrereqs` against `plannedPlacements`) — sound legality.
  - In `search.ts` `rawValues` [:190]: for a `pool` variable, generate values `(courseId:"POOL-"+v.rId, term)` for each `term` where `poolMemberFitsTerm(...)`; classify the placeholder heavy (weight 1.0) via `classifyWorkloadTier` with `satisfiesRules:[v.rId]` (major-elective/Core ⇒ heavy). `PlacedCourse.source` stays `"requirement"`, `satisfiesRId = v.rId`, credits = `v.credits`.
  - `checkRequirementCoverage` [constraintModel.ts:380]: a `POOL-<rId>` placement (source `"requirement"`, `satisfiesRId` set) already counts — no change needed (it counts by `satisfiesRId` + source, not courseId).

- [ ] **Step 4: Run + clean.** `pnpm exec vitest run "poolPlaceholders"` → PASS; re-run `constraintModel`, `search`, `feasibilityFirst`, `forwardScheduleSolver`. Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 5: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/constraintModel.ts packages/engine/src/agent/forwardSchedule/search.ts packages/engine/tests/forwardSchedule/poolPlaceholders.test.ts
git commit -m "feat(planner): feasibility-aware pool placeholder variables (branch over terms, sound legality, heavy weight) (T4a)"
```

---

## Task T4b — Materialize the pool placeholder + bind-time re-validation

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/materializePlan.ts` (render a `POOL-<rId>` placement as a pool placeholder slot carrying the descriptor + heavy weight, not a fabricated specific course)
- Modify: `packages/engine/src/agent/forwardSchedule/poolBinding.ts` (bind a real member at bind-time; re-validate)
- Test: `packages/engine/tests/forwardSchedule/poolPlaceholders.test.ts` (extend) + `poolBinding.test.ts`/`poolSlotBinding.test.ts` regression

**Seam:** materialize bound-placement branch [materializePlan.ts:396-615] (a `POOL-` courseId needs the placeholder treatment, not the specific-course slot); the placeholder pass [:633-705]; `poolBinding.ts` / `bindPoolSlot`.

**Goal:** A `POOL-<rId>` placement materializes as a `ScheduleSlotPlaceholder` (or a pool-typed `specific` slot) carrying the pool descriptor + **heavy weight (1.0)**, `bindingState: placeholder-pending/deferred`, `alternativeCourses` = the real pool members offerable in that term. Binding a real member (via `proposePlanChange`/`bindPoolSlot`) re-runs `runGraduationPathValidator` (validity-as-contract). Free electives remain light (0.3/0.5) and untouched.

- [ ] **Step 1: Write the failing test (materialize).**
```ts
import { buildConstraintContext } from "../../src/agent/forwardSchedule/constraintModel.js";
import { findFirstValidPlan } from "../../src/agent/forwardSchedule/search.js";
import { materializePlan } from "../../src/agent/forwardSchedule/materializePlan.js";
// ...
it("a POOL placement renders as a heavy pool placeholder slot carrying its members, not a phantom course", () => {
    const catalog = new Map(), offerings = new Map();
    for (let n = 400; n < 405; n++) { const id = `CSCI-UA ${n}`; catalog.set(id, { title: id, credits: 4 }); offerings.set(id, ["fall", "spring"]); }
    const input = makeInput({
        currentTerm: "2026-fall", graduationTerm: "2027-spring",
        unmetRequirements: [{ rId: "r1", title: "CS Elective", category: "major_elective", credits: 4, candidateCourses: [], pool: { dept: "CSCI-UA", levelMin: 400, levelMax: 499 } }],
        courseCatalog: catalog, offerings,
        programRules: { majorRuleKinds: new Map([["r1", "choose_n"]]), schoolCoreRuleIds: new Set(), generalCategoryRuleIds: new Set(), residencyMinCredits: null, majorCreditMinimum: null, upperLevelMinCredits: null },
    });
    const ctx = buildConstraintContext(input);
    const out = materializePlan(findFirstValidPlan(ctx).plan!, ctx);
    const slots = out.semesters.flatMap(s => s.slots);
    const poolSlot = slots.find(s => s.kind === "placeholder" && s.satisfiesRules.includes("r1"));
    expect(poolSlot).toBeDefined();
    expect(poolSlot!.workloadWeight).toBeGreaterThanOrEqual(1.0);             // heavy, not 0.3
    // No fabricated "POOL-r1" or "CSCI-UA 400" specific_planned slot.
    expect(slots.some(s => s.kind === "specific_planned" && s.courseId.startsWith("POOL-"))).toBe(false);
    // The placeholder lists real members as alternatives.
    expect((poolSlot as any).flexibility.alternativeCourses.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm exec vitest run "poolPlaceholders" -t "heavy pool placeholder"`.

- [ ] **Step 3: Implement.** In `materializePlan.ts`, before the specific-course slot build [:396], branch on `p.courseId.startsWith("POOL-")` (or a `p.source==="requirement"` placement whose requirement carries a `pool`): emit a `ScheduleSlotPlaceholder` like the placeholder pass [:681-701] but with `workloadWeight: p.workloadWeight` (heavy 1.0), `category: req.title`, `flexibility.alternativeCourses` = the pool members offerable in `p.term`, `placeholderId: "POOL-"+rId`, `bindingState` per immediacy, and add the term's credits. Do NOT add it to `placedCourseSet` as a real course (it's a placeholder), but it DOES cover the requirement for the validator (the coverage comes via the slot's `satisfiesRules:[rId]` — confirm `runGraduationPathValidator` axis 1 counts a placeholder with `satisfiesRules`? If it counts only `specific_planned`, emit instead a `specific_planned` pool slot with `courseId: "POOL-<rId>"`, `bindingState: "pool-pending"`, so coverage holds — **verify against the validator** and match whichever the validator credits; the cut-map notes the validator credits a *bound specific_planned* slot, so a pool slot likely must be `specific_planned`-shaped with a pool binding state). Update `poolBinding.ts`/`bindPoolSlot` so binding a real member replaces the pool slot and re-validates.

  > **Validator-coverage check (do first):** read `checkRequirementGroupsSatisfied` in `graduationPathValidator.ts` to confirm exactly what slot kind/shape it counts as a satisfier, and shape the pool slot to match (so a pool-covered requirement is not falsely "unsatisfied"). This is the validity-as-contract guard.

- [ ] **Step 4: Run + clean.** `pnpm exec vitest run "poolPlaceholders" "poolBinding" "poolSlotBinding" "materializePlan"` → PASS. Re-run `proposePlanChange`, `forwardScheduleSolver`. Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 5: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/materializePlan.ts packages/engine/src/agent/forwardSchedule/poolBinding.ts packages/engine/tests/forwardSchedule/poolPlaceholders.test.ts
git commit -m "feat(planner): materialize pool placeholders (heavy, members-as-alternatives) + bind-time re-validation (T4b)"
```

---

# T6 — F-1 floor edges (validity)

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/materializePlan.ts` (final-term fill exemption + final-term floor → RCL note instead of `credit_floor` violation)
- Modify: `packages/engine/src/dpr/visaValidator.ts` (final-term full-time relaxation, optional — or handle entirely in materialize)
- Test: `packages/engine/tests/forwardSchedule/f1FloorEdges.test.ts` (new)

**Seam:** materialize fill [materializePlan.ts:707-779] (force-fills final term to 16), the per-term visa block [:798-827] (pushes `credit_floor` for `fullTimeSatisfied.fail` on the final term), `visaValidator.evalFullTimeSatisfied` [visaValidator.ts:98-127] (no final-term exemption), validator axis 5 `checkVisaAxesPass` [graduationPathValidator.ts:338] (any `credit_floor` ⇒ fail; OGS/RCL note ⇒ requires-approval).

**Goal:** (a) Make "every NON-final term ≥ f1Floor for F-1" explicit (assert `effectiveTermTarget(non-final) ≥ f1Floor`; the fill already pads to 16 ≥ 12, but close the search-phase-vs-fill gap with an assertion/test). (b) **Final-term RCL exemption:** the final graduating term is NOT force-filled to 16 (takes the remainder), and an F-1 final term below 12 is **valid + RCL-flagged** (a `requires-approval` OGS/RCL note → `valid-with-trade-offs`), **not** a `credit_floor` violation (not refused) and **not** padded with junk electives.

- [ ] **Step 1: Write the failing test.**
```ts
describe("F-1 floor edges", () => {
    it("mid-degree (non-final) F-1 term is kept ≥ 12 via fill", () => {
        // A single requirement leaves a light non-final term; the fill must top it to ≥12.
        const input = makeInput({
            visaStatus: "f1", f1Floor: 12, creditTargetPerSemester: 16,
            currentTerm: "2026-fall", graduationTerm: "2027-fall",   // 3 terms; first is non-final
            creditsEarned: 80, graduationCreditMinimum: 128,
            unmetRequirements: [{ rId: "r1", title: "One", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] }],
            courseCatalog: new Map([["A-UA 1", { title: "A", credits: 4 }]]),
            offerings: new Map([["A-UA 1", ["fall"]]]),
        });
        const out = solveForwardSchedule(input);
        const nonFinal = out.semesters.slice(0, -1);
        for (const sem of nonFinal) expect(sem.plannedCredits).toBeGreaterThanOrEqual(12);
        // No credit_floor violation on a non-final term.
        expect(out.feasibility.constraintViolations.some(v => v.kind === "credit_floor")).toBe(false);
    });

    it("F-1 final term below 12 is VALID + RCL-flagged, not refused and not padded to 16", () => {
        // Near-graduate: only 8 credits of requirements remain, all in the final term.
        const input = makeInput({
            visaStatus: "f1", f1Floor: 12, creditTargetPerSemester: 16,
            currentTerm: "2027-spring", graduationTerm: "2027-spring", // single final term
            creditsEarned: 120, graduationCreditMinimum: 128,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_required", credits: 4, candidateCourses: ["A-UA 1"] },
                { rId: "r2", title: "Two", category: "major_required", credits: 4, candidateCourses: ["B-UA 2"] },
            ],
            courseCatalog: new Map([["A-UA 1", { title: "A", credits: 4 }], ["B-UA 2", { title: "B", credits: 4 }]]),
            offerings: new Map([["A-UA 1", ["spring"]], ["B-UA 2", ["spring"]]]),
        });
        const out = solveForwardSchedule(input);
        const finalSem = out.semesters[out.semesters.length - 1]!;
        // Takes the remainder (8 cr), NOT padded to 16.
        expect(finalSem.plannedCredits).toBeLessThan(16);
        // No hard credit_floor violation (not refused).
        expect(out.feasibility.constraintViolations.some(v => v.kind === "credit_floor")).toBe(false);
        // RCL/OGS surfaced as a note (→ validator requires-approval → valid-with-trade-offs).
        expect(finalSem.notes.some(n => /rcl|ogs|reduced course load/i.test(n))).toBe(true);
        expect(out.feasibility.feasible).toBe(true);
    });
});
```

- [ ] **Step 2: Run → FAIL.** `pnpm exec vitest run "f1FloorEdges"`. (Today the final term is force-filled to 16 — `plannedCredits < 16` fails; and/or a `credit_floor` violation appears.)

- [ ] **Step 3: Implement.** In `materializePlan.ts`:
  - **Fill exemption** [:718]: skip force-fill for the final term the same way optional terms are skipped — `if (isOptionalTerm(term) || term === lastTerm) { /* no pad — take remainder */ }`. BUT still ensure the **graduation credit minimum** is met by the requirement courses + earned credits (the `totalScheduled < graduationCreditMinimum` check [:855] remains the backstop; if requirements+earned already reach the min, the final term legitimately carries only the remainder). If the min is NOT met without padding, fill earlier non-final terms first / the relax ladder (T2) adds a term — do not pad the final term to manufacture credits.
  - **Final-term floor → RCL note** [:814-827]: when `term === lastTerm` and `vResult.fullTimeSatisfied.status === "fail"` for an F-1 student, do NOT push a `credit_floor` violation; instead push an RCL/OGS note onto the semester (`notes.push("Final-term enrollment below the F-1 full-time floor — verify a Reduced Course Load (RCL) with OGS.")`) so validator axis 5 returns `requires-approval` (the OGS/RCL note branch [graduationPathValidator.ts:352-360]) rather than `fail`. Keep the `credit_floor` push for NON-final terms unchanged.
  - Optionally mirror in `visaValidator.evalFullTimeSatisfied` (return `requires-approval`/`assumed-pass` when `isFinalTerm && termCredits < floor`), but the materialize-side note is sufficient and lower-risk; choose one and keep `visaValidator`'s existing tests green.

- [ ] **Step 4: Run + clean.** `pnpm exec vitest run "f1FloorEdges" "visaPolicy" "materializePlan" "forwardScheduleSolver" "summerJterm"` → PASS. Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 5: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/materializePlan.ts packages/engine/tests/forwardSchedule/f1FloorEdges.test.ts
git commit -m "fix(planner): F-1 final-term RCL exemption (take remainder, RCL-flag not refuse) + non-final floor assertion (T6)"
```

---

# T7 — Structured non-optimal / exhaustive signal

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/types.ts` (`SolverOutput.optimality?`) + `packages/shared/src/types.ts` (`ForwardSchedule.optimality?`)
- Modify: `packages/engine/src/agent/forwardSchedule/solver.ts` (compute + set `optimality`)
- Modify: `packages/engine/src/agent/forwardSchedule/build.ts` (`finalizeForwardSchedule` threads it) + `alternatives.ts` (`buildScheduleFromOutput` threads it)
- Test: `packages/engine/tests/forwardSchedule/optimalitySignal.test.ts` (new)

**Seam:** `truncationWarning` [solver.ts:89] (the existing string channel — keep it; add the structured companion); `SolverOutput` [types.ts:181]; `ForwardSchedule` [shared types.ts:1055]; `finalizeForwardSchedule` [build.ts:73-96] (thread like `warnings` [:95]).

**Goal:** A structured `optimality: "optimal" | "best-effort" | "feasibility-unconfirmed"` on `SolverOutput` + `ForwardSchedule`. Map from the feasibility-first result: a plan found by `findFirstValidPlan` is `best-effort` (valid, may not be most preferred) unless the search was exhaustive AND the winner is the proven optimum (rare post-T1 — only tiny inputs); an empty result that hit the budget is `feasibility-unconfirmed`; a proven-infeasible empty result keeps `feasible:false` (optimality is moot — omit or `feasibility-unconfirmed`). A consumer reading only `state`/`feasible` can still detect non-optimality via this field.

- [ ] **Step 1: Write the failing test.**
```ts
describe("structured optimality signal", () => {
    it("a feasibility-first found plan carries optimality 'best-effort'", () => {
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-fall", creditCeiling: 18,
            creditsEarned: 100, graduationCreditMinimum: 128,
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
            ],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}],["B-UA 2",{title:"B",credits:4}],["C-UA 3",{title:"C",credits:4}],["D-UA 4",{title:"D",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall","spring"]],["B-UA 2",["fall","spring"]],["C-UA 3",["fall","spring"]],["D-UA 4",["fall","spring"]]]),
        });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(true);
        expect(out.optimality).toBe("best-effort");
    });

    it("a forced-truncation empty result is 'feasibility-unconfirmed'", () => {
        // maxNodes=1 forces truncation before any leaf on a non-trivial input.
        const input = makeInput({
            currentTerm: "2026-fall", graduationTerm: "2027-spring",
            unmetRequirements: [
                { rId: "r1", title: "One", category: "major_elective", credits: 4, candidateCourses: ["A-UA 1", "B-UA 2"] },
                { rId: "r2", title: "Two", category: "major_elective", credits: 4, candidateCourses: ["C-UA 3", "D-UA 4"] },
            ],
            courseCatalog: new Map([["A-UA 1",{title:"A",credits:4}],["B-UA 2",{title:"B",credits:4}],["C-UA 3",{title:"C",credits:4}],["D-UA 4",{title:"D",credits:4}]]),
            offerings: new Map([["A-UA 1",["fall","spring"]],["B-UA 2",["fall","spring"]],["C-UA 3",["fall","spring"]],["D-UA 4",["fall","spring"]]]),
        });
        const out = solveForwardSchedule(input, 1); // maxNodes seam
        expect(out.optimality).toBe("feasibility-unconfirmed");
    });
});
```

- [ ] **Step 2: Run → FAIL** (`optimality` undefined). `pnpm exec vitest run "optimalitySignal"`.

- [ ] **Step 3: Implement.** Add `optimality?` to `SolverOutput` (types.ts) and `ForwardSchedule` (shared types.ts) per the preamble type. In `solver.ts`, compute alongside `truncationWarning`:
```ts
function deriveOptimality(exhaustive: boolean, hasValidPlan: boolean): "optimal" | "best-effort" | "feasibility-unconfirmed" {
    if (!hasValidPlan) return "feasibility-unconfirmed";   // empty: truncated OR proven-infeasible
    // A valid plan was found. Feasibility-first does not prove the global optimum, so a found
    // plan is best-effort; only a fully-exhausted search over the whole space proves "optimal".
    return exhaustive ? "optimal" : "best-effort";
}
```
Wait — post-T1 the primary path is feasibility-first (stops at first leaf), so `exhaustive` is true only when it ran out (no plan) OR the first leaf WAS the last node. For a *found* feasibility-first plan, treat it as **best-effort** regardless (we did not enumerate alternatives to prove optimality). So:
```ts
const hasValid = winner.plan !== null;
const optimality = !hasValid
    ? "feasibility-unconfirmed"            // includes proven-infeasible (feasible:false anyway)
    : "best-effort";                        // feasibility-first found a valid plan
```
(Only promote to `"optimal"` if a future exhaustive-proof mode is added; keep it simple here.) Set it on the returned `SolverOutput` (both the early-return branches and the final return). Thread it through `finalizeForwardSchedule` [build.ts:73-96] (`...(solverOutput.optimality ? { optimality: solverOutput.optimality } : {})`) and `buildScheduleFromOutput` [alternatives.ts:144-163].

- [ ] **Step 4: Run + clean.** `pnpm exec vitest run "optimalitySignal" "truncation" "forwardScheduleSolver" "forwardScheduleBuild"` → PASS. Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 5: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/types.ts packages/shared/src/types.ts packages/engine/src/agent/forwardSchedule/solver.ts packages/engine/src/agent/forwardSchedule/build.ts packages/engine/src/agent/forwardSchedule/alternatives.ts packages/engine/tests/forwardSchedule/optimalitySignal.test.ts
git commit -m "feat(planner): structured optimality signal on SolverOutput + ForwardSchedule (best-effort caveat) (T7)"
```

---

# T8 — Harden `simulate_alternatives` to the validator (display-only, lower priority)

**Files:**
- Modify: `packages/engine/src/agent/forwardSchedule/alternatives.ts` (validate or flag each displayed candidate)
- Test: `packages/engine/tests/agent/alternatives.test.ts` (extend)

**Seam:** `buildScheduleFromOutput` [alternatives.ts:136-164] assembles a `ForwardSchedule` WITHOUT `runGraduationPathValidator` (trusts coarse `out.state` [:157]).

**Goal:** A displayed alternative is either validator-checked (its `state`/`feasibility` come from `runGraduationPathValidator`) or explicitly flagged as unvalidated — no coarse-feasible-but-invalid alternative is shown as valid.

- [ ] **Step 1: Write the failing test.** Assert that a candidate `schedule` returned by `simulateAlternatives` has a validator-derived `state` (i.e. equals what `finalizeForwardSchedule` would produce), OR carries an explicit `unvalidated` marker. (Construct an input where the coarse state and the validator disagree — e.g. a plan the coarse path calls clean but the validator flags `requires-approval` — and assert the displayed candidate reflects the validator verdict.)
```ts
// alternatives.test.ts — new case:
it("displayed alternative schedules carry the validator-derived state, not the coarse solver state", () => {
    // ...build an input where simulateAlternatives returns a feasible candidate...
    const cands = simulateAlternatives(input);
    for (const c of cands) {
        if (c.schedule) {
            // The schedule's state must match runGraduationPathValidator's verdict.
            const v = runGraduationPathValidator({ plan: c.schedule, dpr: input.dpr, programRules: validatorRules });
            expect(c.schedule.state).toBe(derivePlanStateFromValidator(v, c.schedule));
        }
    }
});
```

- [ ] **Step 2: Run → FAIL** (coarse state may differ from validator state). `pnpm exec vitest run "agent/alternatives" -t "validator-derived state"`.

- [ ] **Step 3: Implement.** Route `buildScheduleFromOutput` through the shared `finalizeForwardSchedule` [build.ts:63] (needs `validatorRules`). `simulateAlternatives` already builds each relaxed `SolverInput`; obtain `validatorRules` via `buildSolverInputWithRules` (or thread it in). Replace the un-validated assembly [:144-163] with `finalizeForwardSchedule(out, relaxedInput, relaxedInput.dpr, validatorRules).schedule`. (If `validatorRules` isn't readily available in this path, the minimal alternative is to set an explicit `unvalidated: true`-style flag and have the agent surface "unverified" — but prefer the real validator route.)

- [ ] **Step 4: Run + clean.** `pnpm exec vitest run "agent/alternatives"` → PASS. Full suite ≥1565/9. Typecheck 3×. Shadows empty.

- [ ] **Step 5: Commit.**
```bash
git add packages/engine/src/agent/forwardSchedule/alternatives.ts packages/engine/tests/agent/alternatives.test.ts
git commit -m "fix(planner): route simulate_alternatives display candidates through runGraduationPathValidator (T8/M3)"
```

---

# T9 — Realistic-scale verification + regression

**Files:**
- Create: `packages/engine/tests/forwardSchedule/realisticScale.test.ts` (new)
- Optionally create: a derived fixture builder from `tests/fixtures/dpr_sample.redacted.txt`
- Test: the above

**Goal:** Prove the whole point: a 12–18-requirement, ~8-term DPR-derived input completes with **no truncation**, **passes `runGraduationPathValidator`**, returns a reasonable preference, and runs fast. Regression: never false-infeasible at scale; genuinely-infeasible still reports binding constraints; F-1 edges (T6) hold.

- [ ] **Step 1: Write the test.**
```ts
import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver.js";
import { buildConstraintContext } from "../../src/agent/forwardSchedule/constraintModel.js";
import { runGraduationPathValidator, derivePlanStateFromValidator } from "../../src/agent/forwardSchedule/graduationPathValidator.js";
// ... factories + a helper to assemble a ForwardSchedule from SolverOutput for the validator ...

describe("realistic full-degree scale", () => {
    function wideInput() {
        // 16 requirements, mix of single-candidate (required) + multi-candidate (electives)
        // + 2 pools, with a few prereq chains, over an ~8-term horizon. ceiling 18, target 16.
        const reqs = [], catalog = new Map(), offerings = new Map(), prereqs = new Map();
        // ... build 16 requirements; ~6 with 3-4 candidates; 2 pools (CSCI-UA 400-499, MATH-UA 200-299);
        //     a BASE→ADV prereq chain; all offered fall+spring unless noted ...
        return makeInput({
            currentTerm: "2024-fall", graduationTerm: "2028-spring",  // 8 main terms
            creditsEarned: 32, graduationCreditMinimum: 128, creditCeiling: 18, creditTargetPerSemester: 16,
            unmetRequirements: reqs, courseCatalog: catalog, offerings, prereqs,
            programRules: { majorRuleKinds: /* mark pools choose_n */ new Map(), schoolCoreRuleIds: new Set(), generalCategoryRuleIds: new Set(), residencyMinCredits: 64, majorCreditMinimum: 36, upperLevelMinCredits: null },
        });
    }

    it("completes without truncation and the result passes runGraduationPathValidator", () => {
        const input = wideInput();
        const out = solveForwardSchedule(input);
        // No truncation advisory.
        expect((out.warnings ?? []).some(w => w.includes("truncated"))).toBe(false);
        expect(out.optimality).not.toBe("feasibility-unconfirmed");
        expect(out.feasibility.feasible).toBe(true);
        // Passes the authoritative validator (assemble a ForwardSchedule + validate).
        const schedule = assembleSchedule(out, input);            // local helper mirroring build.ts
        const v = runGraduationPathValidator({ plan: schedule, dpr: input.dpr, programRules: validatorRulesFor(input) });
        expect(v.feasible).toBe(true);
    });

    it("never false-infeasible: a known-feasible wide input is feasible", () => {
        expect(solveForwardSchedule(wideInput()).feasibility.feasible).toBe(true);
    });

    it("genuinely-infeasible at scale still reports a binding constraint", () => {
        // Over-pack so even at 18/term across the window the credits can't fit.
        const input = /* wideInput but with too many required credits for the window */;
        const out = solveForwardSchedule(input);
        expect(out.feasibility.feasible).toBe(false);
        expect(out.feasibility.constraintViolations.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: Run → (expect PASS by now, after T1–T6).** `pnpm exec vitest run "realisticScale"`. If any case fails, it's a real gap — fix the underlying task (don't weaken the test); re-run its suite.

- [ ] **Step 3: Final whole-suite + clean.** `pnpm exec vitest run` ≥ 1565/9 (+ the new tests). Typecheck 3×. Shadow check → empty.

- [ ] **Step 4: Commit.**
```bash
git add packages/engine/tests/forwardSchedule/realisticScale.test.ts
git commit -m "test(planner): realistic full-degree-scale verification + regression (no truncation, validator-passing) (T9)"
```

---

## Global exit criteria (verify at the end)
Full suite green (≥1565/9 + new); 3× `tsc --noEmit` clean; 0 shadows; realistic 10–20-requirement full-degree plans complete without truncation, pass `runGraduationPathValidator`, return a strongly-preferred plan; never false-infeasible; genuinely-infeasible still explained (binding constraints); F-1 edges correct; all PRESERVE deliverables still pass. Then a final whole-branch review → present finishing options (leave / PR / merge) to the owner. **Do NOT push/merge unless asked.**

---

## Self-Review (writer's checklist — completed)

**1. Spec coverage** — every plan task maps to a granular task: PLAN-6→T1; 16-grid/relax→T2; PLAN-7 (local opt + top-K)→T3a/T3b; pools→T4a/T4b; range fix→T5; F-1 edges→T6; structured signal→T7; alternatives hardening→T8; realistic-scale→T9. The "deterministic on validity", "never false-infeasible", "PLAN-13 binding constraints", and "validity-as-contract" guardrails are asserted in T1a/T2/T4a/T9 tests.

**2. Placeholder scan** — no "TBD/handle edge cases" steps; every code step shows code or a precise edit against a cited seam. Two intentional implementer-judgment points are explicitly bounded: T2 Step 2 (pick the minimal failing fixture for the soft-grid; the *contract* is stated) and T4b Step 3 (shape the pool slot to whatever `checkRequirementGroupsSatisfied` credits — with a "read the validator first" instruction). These are verification-gated, not hand-waves.

**3. Type consistency** — `findFirstValidPlan`/`findDiverseValidPlans` return `SearchResult`/`PartialPlan[]` (search.ts types); `localImprove(plan, ctx, weights?) → PartialPlan`; the `pool?` descriptor `{dept, levelMin, levelMax}` is defined once (preamble, added in T5) and consumed unchanged in T4; `optimality` union is defined once (preamble, added in T7) and threaded identically in build.ts + alternatives.ts; `SearchOptions` gains `forbiddenSignatures?: Set<string>` (T3b) used by `findFirstValidPlan` (T1a) — note T3b extends the T1a signature, consistent.

---

## Execution Handoff

Execute **Subagent-Driven** (superpowers:subagent-driven-development): fresh implementer per task (T1a, T1b, T2, T3a, T3b, T5, T4a, T4b, T6, T7, T8, T9) with the full task text + cut-map seams (don't make them read this whole file) → spec-compliance review → code-quality review → fix loop. Reviews catch real bugs — don't skip. Trivial tasks may be controller-verified. Continuous green + TDD; scoped commit per task.

