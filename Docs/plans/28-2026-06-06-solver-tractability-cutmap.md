# T0 — Solver Tractability: AS-BUILT Insertion Cut-Map

> **Status:** T0 deliverable (close-read output, 2026-06-06). Produced from a full read of the *current* (post-Phase-2, merged to `main` @ `d3d31bbc`) `solver.ts` (379 L), `search.ts` (689 L), `constraintModel.ts` (638 L), `materializePlan.ts` (1048 L), `solverHelpers.ts` (540 L), `buildSolverInput.ts` (603 L), `types.ts` (220 L), `build.ts` (170 L), `alternatives.ts` (207 L), `visaValidator.ts` (306 L), `graduationPathValidator.ts` (axes 5 + 7), and the shared `ForwardSchedule`/`PlanState`/`SolverOutput` types.
>
> **The old greedy `solver.ts` is GONE.** The P2.0 cut-map (`2026-06-05-phase2-cutmap.md`) describes it for intent only. This document is the keep/insert map the T1–T9 granular TDD steps are written against. All `file:line` references are to the state on `feat/solver-tractability` (= `origin/main` @ `d3d31bbc`). Baseline suite: **1565 passed / 9 skipped**.

---

## 0. The pipeline as built (the frozen seam + its body)

`solveForwardSchedule(input: SolverInput, maxNodes?: number): SolverOutput` — [solver.ts:167]. The **single-arg public contract is frozen**; `maxNodes` is an optional trailing test seam (forces truncation). Body:

| Step | Where | What |
|---|---|---|
| 1. Build context | `buildConstraintContext(input)` [constraintModel.ts:76] | `{ input, futureTerms, prereqDepths, dependentsIndex }`. `futureTerms = enumerateTerms(currentTerm, graduationTerm, {includeSummer, includeJTerm})` [solverHelpers.ts:93] — fall/spring always; summer/january only if opted-in. |
| 2. Empty-horizon early-out | [solver.ts:179] | `futureTerms.length === 0` → `materializePlan({placed:[]}, ctx)`. |
| 3. Build `fixed` | [solver.ts:194-291] | IP rows (`source:"ip"`, `satisfiesRId:null`) [202-224]; pins (`source:"pin"`, coverage = first unmet req whose candidates include the pin [269-270]; off-window/offering-mismatch pins → `extraViolations` + skip [240-266]). |
| 4. **Search** | `searchTopKPlans(ctx, {fixed, k:5, maxNodes?})` [search.ts:631] | Returns `{plans[], scores[], exhaustive, nodesExplored, unsatisfiable[], blockers[]}`. `winnerPlan = plans[0] ?? {placed:fixed}` [solver.ts:307]. |
| 5. Honest truncation | `truncationWarning(exhaustive, hasValid, nodes)` [solver.ts:89] | Pushes a warning string when truncated [312]. |
| 6. Infeasibility fold | [solver.ts:314-339] | When `plans.length===0`: push per-req `blockers` [321-323]; capacity diagnostic `computeCapacityDiagnostic` [126] **gated on `exhaustive`** [335]. |
| 7. **Materialize** | `materializePlan(winnerPlan, ctx)` [materializePlan.ts:289] | Search result → full `SolverOutput`. |
| 8. Alternatives | `top.plans.slice(1).map(materializePlan)` → `buildAlternativeSummaries` [solver.ts:349-351; materializePlan.ts:964] | Real top-K distinct (P2.3). |
| 9. Fold + re-derive | [solver.ts:353-378] | Fold `extraViolations` into feasibility; `derivePlanState` [solverHelpers.ts:512]; spread `warnings`. |

Consumer wrap: `build.ts` → `buildForwardSchedule` [build.ts:131] → `finalizeForwardSchedule` [build.ts:63] assembles the `ForwardSchedule` literal [73-96] and runs `runGraduationPathValidator` [98] → `derivePlanStateFromValidator` [103] = **authoritative state** (overrides the solver's coarse state). The edit path (propose/confirm) shares `finalizeForwardSchedule` (P2.7/PLAN-3).

### The tractability defect (the root)
`runSearch` [search.ts:267-403] is the single backtracking traversal. It invokes `onValidLeaf(plan, score)` at **every** valid complete leaf [351] and recurses over **all** surviving candidate values [384-397] with **no score-based prune** (the objective is non-monotonic, comment [385-394]). Pruning is only the sound incremental forward-check `incrementalOk = {offering, NOT, coreq, ceiling}` [227-234]; `{prereqs, coverage, major-credit, residency}` are checked at the completion leaf `i === variables.length` [336-353]. Both `searchBestPlan` [564] and `searchTopKPlans` [631] explore the **identical full tree** to *know* the optimum → with 10–20 multi-candidate requirements over ~8 terms the leaf count explodes and the search hits `maxNodes = 200_000` [131] → `exhaustive=false` → truncates. Today it stays honest (valid-but-flagged) but never delivers the designed "pick the preferred among the valid plans" guarantee at realistic scale.

---

## 1. T1 — Feasibility-first architecture (PLAN-6) · **search.ts + solver.ts**

**Seam:** `runSearch` [search.ts:267] + the two entry points [searchBestPlan:564, searchTopKPlans:631]; consumed at [solver.ts:306].

**Insight:** the truncation exists *only because* we enumerate all leaves to prove the optimum. Stop at the **first** valid leaf and the search returns fast for every feasible input (the per-variable value ordering [377-382] is already best-first by `scorePlan`, so the first leaf is a *good* plan). Infeasibility cost is unchanged (must still exhaust to prove no leaf exists → blockers).

**Insert:**
- A new entry point `findFirstValidPlan(ctx, options)` (or a `stopAtFirst` flag threaded into `runSearch`) that **early-terminates the recursion** at the first accepted leaf — mirror the existing `truncated` early-return pattern [331-334, 396] with a `found` flag set inside the leaf callback [351] and checked after each `recurse(...)` [395-396]. Reuse the *identical* variable ordering [306-321], `incrementalOk` prune [374], completion-leaf checks [345-350], and `computeBlockers` [505] on empty.
- `solveForwardSchedule` [solver.ts:306] swaps `searchTopKPlans` for: `findOneValidPlan` (T1) → `localImprove` (T3) → `findDiverseValidPlans` (T3). Keep the frozen signature + `maxNodes` seam.
- Preserve all honest-labeling: `found` → not truncated; exhausted-without-find within budget → real infeasibility (`blockers`); hit `maxNodes` without find → `exhaustive=false` → feasibility-unconfirmed (T7).

**Preserve:** `runSearch`'s soundness contract (incremental prune is later-variable-independent; prereqs/floors at the leaf). Determinism via fixed ordering + `planKey` tie-break [409].
**Tests:** `forwardSchedule/search.test.ts`, `truncation.test.ts`; new realistic-scale fixture proves no-truncation (feeds T9).

---

## 2. T2 — 16-credit/term grid + relax fallback · **search.ts (per-term target) + solverHelpers/buildSolverInput (horizon) + materializePlan (final-term remainder)**

**Today:** the search caps per-term at `creditCeiling` (=18) via `checkPerTermCeiling` [constraintModel.ts:307] — there is **no 16-credit grid** in the find-valid step; it explores placements up to 18. The horizon `futureTerms` is derived once: `deriveGraduationTerm(currentTerm, creditsEarned, min, creditTargetPerSemester=16)` [buildSolverInput.ts:554, 159] → `enumerateTerms` [constraintModel.ts:77]. The free-elective fill pads every non-optional term to `effectiveTermTarget` (16) [materializePlan.ts:718-779].

**Insert (relax ladder, never false-infeasible):**
1. **Default grid = 16** in the find-valid step (a *soft* per-term target the first-fit honors), distinct from the hard `creditCeiling` (18). First-fit required courses by prereq depth into the earliest feasible term with ≤16.
2. **Relax** when the 16-grid can't place a variable: allow up to `creditCeiling` (18) for that term → then **add a term** (extend the *derived* horizon) → then widen backtracking. Each relax step is automatic.
3. **Final term takes the remainder** (may be <16) — see T6; do not pad it to 16.
4. **Think in credits**, not "4 courses" (variable-credit courses).

**Critical design nuance (flag in granular plan):** the "add a term" relax applies to a **derived** horizon (no student-stated target). When the student stated a *hard* `graduationTarget`, you cannot silently extend it — report the real binding constraint (the `computeCapacityDiagnostic` [solver.ts:126] already distinguishes "needs N cr > capacity" and is gated on `exhaustive`). Don't pad summer/J-term ([materializePlan.ts:719] already skips optional terms; [solverHelpers.ts:71] `isOptionalTerm`).

**Preserve:** PLAN-13 binding-constraint infeasibility; `creditCeiling` stays the hard cap; optional-term exemptions.
**Tests:** `forwardSchedule/search.test.ts`, new T2 cases (accelerator needs 18/term; near-grad short final term; prereq-dense term needs 5 courses; genuinely-infeasible → binding constraints). Depends T1.

---

## 3. T3 — Local preference optimization + top-K (PLAN-7) · **search.ts + new localImprove + solver.ts**

**Today:** top-K = `searchTopKPlans` [search.ts:631] (exhausts the space). Preference (`scorePlan` = balance + timeToDegree [constraintModel.ts:589]) is found *during* search.

**Insert:**
- `localImprove(plan, ctx, weights)`: validity-preserving improving moves (move a course to another legal term; swap a candidate) that lower `scorePlan` [constraintModel.ts:589]; re-check each move with `checkHardConstraints(plan, ctx)` [constraintModel.ts:542] (or the incremental set + completion set). Reuse `computeBalanceScore` [balanceScore.ts:45] + `effectiveTermTarget` + `loadStyle`. Pins (`source:"pin"`) and explicit student schedule are highest-weight (never moved into invalidity).
- `findDiverseValidPlans(plan, ctx, k)`: a few distinct valid plans via restart with different tie-breaks / forbidding the winner's `planKey` signature [search.ts:409] — **not** by exhausting the space. Feeds `buildAlternativeSummaries` [materializePlan.ts:964] → `alternativeCandidates`.
- **Re-rank on preference change reuses found plans / re-optimizes — NOT a full re-search.** Check the consumer re-solve sites: `planForwardDegree.ts`, `reconcile.ts`, the edit path (`proposePlanChange`/`confirmPlanChange` via `finalizeForwardSchedule`).

**Preserve:** `objectiveBalance.test.ts` (balance evens heavy courses; loadStyle shifts centroid); real top-K distinct; `buildAlternativeSummaries` output shape.
**Tests:** extend `objectiveBalance.test.ts`; new "stated pref shifts chosen plan", "top-K valid + distinct", "pref change doesn't full-re-search". Depends T1, T2.

---

## 4. T5 — Range-parsing correctness fix (no-invention) · **buildSolverInput.ts** *(do before T4)*

**Bug:** `COURSE_ID_RE = /\b([A-Z][A-Z0-9]*-[A-Z]{2,3})\s+(\d{1,4}[A-Z]?)\b/g` [buildSolverInput.ts:585] + `extractCandidateCourseIds` [587] collapse a range `"CSCI-UA 400-499"` to the single (often non-existent) `CSCI-UA 400` (the `-499` tail has no dept prefix, so it's dropped). This fabricates a phantom course — a no-invention violation.

**Insert:** recognize ranges/lists in the requirement `description`/`statusText`/`title` and emit a **pool descriptor** (dept + level range, e.g. `{dept:"CSCI-UA", levelMin:400, levelMax:499}`) instead of a fabricated single id. The descriptor feeds T4's placeholder. A *single explicit* course id still emits that id. Type change: extend `SolverInput.unmetRequirements[]` [types.ts:98-108] with an optional `pool?` descriptor (additive).

**Tests:** new `forwardSchedule/` test against the real `tests/fixtures/dpr_sample.redacted.txt`: `R1142/30` ("Computer Science: Elective Courses — CSCI-UA 400-499") yields a real pool descriptor (or sound placeholder), **not** phantom `CSCI-UA 400`; assert no planned course is absent from the catalog. Depends T0; feeds T4.

---

## 5. T4 — Feasibility-aware pool placeholders · **constraintModel.ts (buildRequirementVariables) + search.ts + materializePlan.ts + poolBinding.ts**

**Today:** `buildRequirementVariables` [constraintModel.ts:104] turns each unmet requirement into a CSP variable whose `candidates` = every catalog-present, non-excluded, non-study-abroad course in `candidateCourses` [112-117], with a `(courseId, term)` `domain` [121-133]. A choose-N pool with many members → the search **branches over each specific course** (a major source of blowup). The validator counts a requirement satisfied only by a **bound `specific_planned`/pin** slot [constraintModel.ts:380; graduationPathValidator axis 1]; pool placeholders today come from the *empty-candidate* path in `materializePlan` [633-705] (`bindingState: placeholder-pending/deferred`, weight 0.3 — too light).

**Insert:**
- For a choose-N pool requirement (with a `pool` descriptor from T5, or `majorRuleKinds.get(rId)==="choose_n"` [buildSolverInput.ts:352]), represent it as **one placeholder variable carrying the pool descriptor**, *not* enumerated members. The search treats it as a single unit that **may occupy term T only if ≥1 real pool member is offered in T AND its prereqs/coreqs are satisfiable by T** given the rest of the plan (sound — no false reservation). This is a new domain-legality predicate alongside the per-course `domain` build [constraintModel.ts:121-133], reusing `offerings` + `checkAllPrereqs` [solverHelpers.ts:275].
- **Keep the heavy weight (1.0)** for major-elective/Core pool placeholders (distinct from free-elective light 0.5/0.3) — `classifyWorkloadTier` [workloadTier.ts] already tiers by rule kind; ensure pool placeholders classify heavy, not the 0.3 free-fill weight [materializePlan.ts:696].
- **Keep chain-linked members explicit:** a pool course that is itself a prereq/coreq of another required course stays an explicit variable (don't fold it into the opaque pool).
- **Defer the specific pick to bind-time:** `poolBinding.ts` / `bindPoolSlot` / `proposePlanChange` (which already re-validates). Materialize emits a pool placeholder slot (not a fabricated specific course).

**Preserve:** validity-as-contract (a pool placeholder never lands where no real member fits; binding a real course re-validates); free electives stay placeholdered + light (leave [materializePlan.ts:707-779]).
**Tests:** `forwardSchedule/` new pool test (branching cut: search no longer enumerates pool members; placeholder never in a no-member term; binding re-validates; weight heavy); `poolBinding.test.ts`/`poolSlotBinding.test.ts` regression. Depends T0; pairs with T5.

---

## 6. T6 — F-1 floor edges (validity) · **materializePlan.ts (fill + visa block) + visaValidator.ts**

**(a) Non-final ≥ floor (make explicit).** `effectiveTermTarget` [solverHelpers.ts:179] for an F-1 non-final term = 16 (default) ≥ 12; the fill [materializePlan.ts:718-779] tops each non-optional term to the target, so the *materialized* plan is full-time. The search itself does **not** enforce the per-term floor (it's fill-dependent — `checkPerTermFloor` is a completion axis excluded from the search [constraintModel.ts:331; search.ts boundary comment 39-48]). **Insert:** assert `effectiveTermTarget ≥ f1Floor` for F-1 students and make the search-phase-vs-fill guarantee explicit (the review-found gap).

**(b) Final-term RCL exemption (the real bug).** `visaValidator.evalFullTimeSatisfied` [visaValidator.ts:98-127] returns `fail` whenever `termCredits < floor` **regardless of `isFinalTerm`** — the `isFinalTerm` flag is consumed only by the *separate* `evalFinalTermExceptionPossible` axis [205], which never relaxes `fullTimeSatisfied`. So the final term stays valid **only because** the fill force-pads it to 16 [materializePlan.ts:718-779]. For a near-graduate who needs only the remainder (<12), the materialize visa block [798-827] would push a `credit_floor` violation → validator axis 5 `checkVisaAxesPass` [graduationPathValidator.ts:338-349] = **fail** → infeasible.

**Insert:** the final graduating term must NOT be force-filled to 16 (take the remainder — ties to T2) AND must NOT yield a hard `credit_floor` violation when an F-1 student is below the floor in their last term; instead emit an **RCL/verify-with-OGS note** → axis 5 returns `requires-approval` (note path [graduationPathValidator.ts:352-360]) → `valid-with-trade-offs`, not refused. The fill exemption mirrors the existing optional-term exemption [materializePlan.ts:719, 813]; the floor relaxation is a final-term branch in the visa block [814-827] (and/or a `finalTermException`-style path in `visaValidator`).

**Preserve:** mid-degree F-1 terms still kept ≥12 via fill; domestic part-time floor [visaValidator.ts:129-140] unchanged; optional-term exemptions.
**Tests:** `forwardSchedule/` new F-1 test: mid-degree term ≥12 via fill; F-1 final term <12 is valid + RCL-flagged (not refused, not padded). Depends T0; interacts with T2.

---

## 7. T7 — Structured non-optimal / exhaustive signal · **solver.ts + types.ts + shared types + build.ts**

**Today:** `truncationWarning` [solver.ts:89] returns a *string* pushed onto `SolverOutput.warnings` [types.ts:192]. The structured optimality status (`exhaustive`, `hasValidPlan`) is otherwise discarded.

**Insert:** a structured field `optimality: "optimal" | "best-effort" | "feasibility-unconfirmed"` on `SolverOutput` [types.ts:181-198] and `ForwardSchedule` [shared types.ts:1055-1079], threaded through `finalizeForwardSchedule` [build.ts:73-96] (like `warnings` [95]) and `buildScheduleFromOutput` [alternatives.ts:144-163]. Map: exhaustive+valid → `optimal`; truncated/feasibility-first-found+valid → `best-effort`; truncated+no-valid → `feasibility-unconfirmed`. **Reconcile with T1:** once feasibility-first is primary, a found plan is `best-effort` unless an exhaustive optimum proof exists; the advisor surfaces the confidence caveat ("valid plan; may not be most preferred — tell me your priorities and I'll refine"). A consumer reading only `state`/`feasible` can still detect non-optimality via this field.

**Preserve:** the `warnings` channel (keep it; `optimality` is the structured companion). `PlanState` [shared types.ts:995] unchanged.
**Tests:** new + extend `truncation.test.ts`: best-effort plan carries the structured flag; consumer can detect it. Depends T1.

---

## 8. T8 — Harden simulate_alternatives to the validator · **alternatives.ts** *(lower priority, display-only)*

**Today:** `simulateAlternatives` [alternatives.ts:43] re-solves with relaxed inputs and `buildScheduleFromOutput` [136] assembles a `ForwardSchedule` **without** `runGraduationPathValidator` — it trusts the coarse `out.state` [157]. A coarse-feasible alt the 7-axis validator would reject can be shown as valid (pre-existing M3).

**Insert:** route each displayed candidate through `runGraduationPathValidator` (reuse `finalizeForwardSchedule` [build.ts:63] — needs `validatorRules`, available from `buildSolverInputWithRules`) or clearly flag any unvalidated candidate as unverified.
**Tests:** `alternatives.test.ts` — displayed alternatives are validator-checked or flagged. Depends T0.

---

## 9. T9 — Realistic-scale verification + regression · **new fixtures + tests**

Add a 12–18-requirement, ~8-term DPR-derived input (CAS CS/Math from `tests/fixtures/dpr_sample.redacted.txt`, plus a multi-pool case). Assert: completes with **no truncation** (`exhaustive` true or feasibility-first found within budget); the result **passes `runGraduationPathValidator`**; preference reasonable; fast. Regression: never false-infeasible at scale; genuinely-infeasible still reports binding constraints; F-1 edges (T6) hold. Depends T1–T6.

---

## 10. KEEP — reuse unchanged (do NOT rebuild)
- **Constraint model** HARD predicates [constraintModel.ts:206-519] + `checkHardConstraints` [542] + `scorePlan` [589] — the contract. The hard ⇒ valid invariant (major-credit/coverage count `{requirement,pin}` only, NOT `ip`; residency counts `ip`; per-placement constraints not re-checked by validator).
- **Search soundness scaffolding** [search.ts:227-403]: `incrementalOk`, completion-leaf checks, `computeBlockers` [505], `planKey` [409], determinism.
- **Materialize tail** [materializePlan.ts:289-926]: slot building, rationale (P2.5 counterfactual rejected-alternatives [158], feasible window [221]), placeholder pass, Stage-8 global checks [851-897], `buildIpAssumptions`/`derivePlanState` [solverHelpers.ts:443, 512], `buildAlternativeSummaries` [964].
- **Validator-as-contract** [build.ts:63] on every path; trade-off engine `tradeOffEngine.ts`; balance `balanceScore.ts`; visa `visaPolicy.ts`/`visaValidator.ts`; `enumerateTerms`/term utils [solverHelpers.ts:25-129]; opt-in summer/J-term (P2.8).

## 11. PRESERVE — verified-good Phase 2 (must not regress)
Validity-as-contract + PLAN-3 (propose/confirm gated on `runGraduationPathValidator`); constraint↔validator 7-axis parity; trade-off engine real PlanDiff fields; balance-as-objective; real rationale recorder; greedy deletion; opt-in summer/J-term. Re-run after every task: `forwardScheduleSolver`, `constraintModel`, `search`, `materializePlan`, `objectiveBalance`, `infeasibility`, `truncation`, `summerJterm`, `tradeOffEngine`, `rationaleRecorder`, `coreqs`, `proposePlanChange`, `solverPreferences`, `alternatives` tests.

## 12. Test layout (where granular steps add tests)
- `packages/engine/tests/forwardSchedule/` — `search.test.ts`, `constraintModel.test.ts`, `materializePlan.test.ts`, `objectiveBalance.test.ts`, `infeasibility.test.ts`, `truncation.test.ts`, `summerJterm.test.ts`, `tradeOffEngine.test.ts`, `rationaleRecorder.test.ts` (+ new `feasibilityFirst.test.ts`, `relaxGrid.test.ts`, `poolPlaceholders.test.ts`, `f1FloorEdges.test.ts`, `optimalitySignal.test.ts`, `realisticScale.test.ts`).
- `packages/engine/tests/agent/` — `forwardScheduleSolver.test.ts`, `coreqs.test.ts`, `alternatives.test.ts`, `solverPreferences.test.ts`, `proposePlanChange.test.ts`.
- Fixtures: `packages/engine/tests/fixtures/dpr_sample.redacted.txt` (real CAS CS DPR) — the T5/T9 ground truth.

## 13. Infra (every task)
- Typecheck **ONLY** `pnpm exec tsc -p packages/{shared,engine}/tsconfig.json --noEmit` + `apps/web/tsconfig.json --noEmit` — **NEVER `tsc -b`** (re-emits `.js` shadows vitest runs instead of `.ts`).
- After each task: 0 shadows (`find packages/engine/src packages/shared/src apps/web/lib apps/web/app -name '*.js' | while read js; do { [ -f "${js%.js}.ts" ] || [ -f "${js%.js}.tsx" ]; } && echo "$js"; done` → empty).
- Tests `pnpm exec vitest run "<substr>"`; full suite green (≥1565/9) at every task.
- Scoped commits (`git add <files>`, NEVER `-A`); trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Don't push/merge unless the owner asks.
