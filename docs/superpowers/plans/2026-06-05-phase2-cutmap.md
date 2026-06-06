# Phase 2 — P2.0 Grounding: `solver.ts` Cut-Map

> **Status:** P2.0 deliverable (close-read output). Produced from a full read of `solver.ts` (1547 L) + `graduationPathValidator.ts`, `forwardSchedule/types.ts`, `alternatives.ts`, `balanceScore.ts`, `forwardFeasibility.ts`, `poolBinding.ts`, `build.ts`, and the shared slot/rationale/plan types (`packages/shared/src/types.ts:679-1274`). This is the keep/replace/new map the P2.1–P2.10 tasks granularize against.

All `file:line` references are to the state at branch `feat/phase2-solver` (= merged foundation, PR #35).

---

## 1. The seam (what stays fixed)

`solveForwardSchedule(input: SolverInput): SolverOutput` (`solver.ts:632`) is the **only** entry point and **its signature + return shape are frozen**. The rebuild replaces the *body*.

Call site / wiring (`build.ts:50-106`):
1. `buildSolverInput(session, dpr, {graduationTermOverride})` → `SolverInput` (`:59`).
2. `buildProgramRules(...)` re-derived for `validatorRules` — **redundant 2nd call** (`:66`; P2.10b).
3. `solveForwardSchedule(solverInput)` → `SolverOutput` (`:70`).
4. Wrap into `ForwardSchedule` (`:77-94`); `state` here is the solver's **coarse** `derivePlanState` (`:90`, comment "overridden below").
5. `runGraduationPathValidator({plan, dpr, programRules: validatorRules})` (`:98`) → `derivePlanStateFromValidator` (`:103`) → `finalState`.
6. `return {...initialSchedule, state: finalState}` (`:105`).

**Contract consequence:** the validator already runs post-hoc on the *initial* build path and overrides the state. Phase 2 must (a) make the search satisfy the 7 axes *by construction*, (b) keep the post-hoc validator as defense-in-depth, and (c) extend the same validator gate to the **edit** path (propose/confirm), which today trusts the coarse state (PLAN-3 / P2.7).

`SolverOutput` (`forwardSchedule/types.ts:172-183`): `{ semesters: ForwardSemester[]; feasibility: FeasibilityReport; alternativeCandidates?: AlternativePlanSummary[]; balanceScore: number; assumptions: Assumption[]; state: PlanState }` — frozen.

`SolverInput` (`forwardSchedule/types.ts:43-166`): frozen. Note already-present but **under-used** fields the search will consume: `preferences.includeSummer`/`includeJTerm` (ignored today — P2.8), `coreqs`, `offerings`/`offeringConfidence`, `minGrades`.

`SolverNode` (`forwardSchedule/types.ts:189-200`) is **defined but unused** — the current solver mutates local `Map`s directly (see §3). The new search can adopt/extend `SolverNode` as its backtracking state.

---

## 2. Control-flow of the current `solveForwardSchedule` (greedy)

| Lines | Stage | Role |
|---|---|---|
| `645` | enumerate terms | `enumerateMainTerms(currentTerm, graduationTerm)` — **fall/spring only** (`:85-99`); never reads `includeSummer/includeJTerm` (P2.8) |
| `648-661` | early-out | grad==current → empty valid plan |
| `664-698` | init state | `perTermSlots`/`perTermCredits` Maps; pre-place IP rows as `in_progress` slots (`:682-698`) |
| `701-707` | candidates | `plannedPlacements` (courseId→term); gather `allCandidateCourseIds` |
| `714-744` | **Stage 5: variable order** | `computePrereqDepths`; `sortedRequirements` = sort by (prereq-depth ASC, workload-weight DESC) (`:732-741`); `buildDependentsIndex` |
| `769-868` | pin pass | place `preferences.pins` first (hard within valid set); off-catalog pin softening (`:785-801`) |
| `875-877` | exclusions | `excludedCourseSet` |
| `879-1212` | **Stage 6: greedy placement loop** | per requirement (see below) |
| `1214-1298` | placeholders | requirements with no catalog/candidate → `ScheduleSlotPlaceholder` |
| `1300-1370` | free-elective fill | top off each term to target (Decision #8 optional above floor) |
| `1372-1444` | **Stage 6d: visa + materialize** | per-term `visaValidator`/`visaNotesForCredits`; build `ForwardSemester[]`; push `credit_floor`/`credit_ceiling` violations |
| `1446-1504` | **Stage 8: global checks** | graduation_total, pass_fail_cap, online_credit_cap, outside_home_credit_cap, gpa_floor → `violations[]` |
| `1510-1546` | post-pass | `buildIpAssumptions`; `computeBalanceScore` (**post-hoc** — P2.4); `feasibility`; `derivePlanState` (coarse); `buildAlternativeCandidates` (**fake** — P2.3); return |

### The greedy commit (Stage 6 inner loop, `879-1212`) — PLAN-6
```
for req of sortedRequirements:                         # static order, no reordering
    filteredCandidates = req.candidateCourses − excluded
    courseId = filteredCandidates[0]            # :901  GREEDY: only the first candidate is ever tried
    ...filters (catalog/study-abroad/NOT-clause)...
    for term of termsForPlacement(...):         # :960  load-style order; "balanced"==chronological
        ...checks: offering :973, slack :978, prereqs :981, coreqs :992-1049, fwd-screen :1051...
        ...build slot + rationale :1088-1189...
        place; placed=true; break               # :1197 FIRST-FIT: first feasible term wins, no B&B
    if !placed: push violation + placeholder     # :1200-1211  no unwind of prior placements
```
**Why it fails (PLAN-6):** (a) only `candidateCourses[0]` is considered per requirement — never the alternatives; (b) first feasible `(course, term)` is committed with no rollback; (c) on a dead-end it emits a placeholder/violation instead of backtracking. Two requirements whose first-choice candidates collide on the only legal term ⇒ false "infeasible." Balance is measured after the fact, never optimized.

### How slots + rationale are built today (to preserve in P2.5)
- `specific_planned` slot assembled at `:1172-1189` with `rationale` (`:1135`), `flexibility` (`:1156`), `downstreamImpact` (`:1162`), `isCriticalPath` (`:1164`), `workloadTier/Weight`, `confidence`.
- `consideredAlternatives` is **fake**: every alt is stamped `"greedy-first-candidate-wins (Phase 15 will evaluate all)"` (`:1138-1141`). P2.5 replaces this with the alternatives the search *actually* evaluated + their real rejection reason.
- `flexibility.earliest/latestPossibleTerm` computed from offering windows (`:1124-1130`), not from a real domain analysis.

---

## 3. State model

Current solver state = four local mutables (NOT `SolverNode`):
- `perTermSlots: Map<term, ScheduleSlot[]>` (`:664`)
- `perTermCredits: Map<term, number>` (`:665`)
- `plannedPlacements: Map<courseId, term>` (`:701`) — drives `isPrereqSatisfied` future-placement + dedupe
- `placedCourseSet: Set<courseId>` (`:751`)
- plus `violations[]` (`:633`), `placementRationale` (`:634`), `placeholderRequirements[]` (`:750`)

For backtracking, the search needs these to be **snapshot/restore-able** (a node = the 4 maps + decision trail). `SolverNode` (`types.ts:189-200`) already sketches `{perTerm, placedCourses, excludedCourses, perTermCredits, decisions}` — adopt + extend (add `plannedPlacements`, per-term cap usage for P/F·online·outside-home·residency, and the assignment list).

---

## 4. The HARD-constraint contract — the 7 validator axes

`runGraduationPathValidator` (`graduationPathValidator.ts:539-573`) defines "valid". The constraint model's HARD predicates (P2.1) must be **exactly** these, so a plan passing all HARD predicates passes the validator by construction:

| Axis | Fn | Predicate the search must satisfy |
|---|---|---|
| `requirementGroupsSatisfied` | `:85` | every actionable unmet leaf (`notSatisfiedRequirements`) is covered by a **bound** `specific_planned` slot (or DPR `coursesUsed`, or IP assumed-pass). **Placeholders do NOT count** (`:121-133`). |
| `poolSlotsResolvable` | `:190` | each pool placeholder has ≥1 resolvable candidate; no pool over-saturation (`:195-217`). |
| `totalCreditsMeetMinimum` | `:227` | `creditsEarned + Σ plannedCredits ≥ degreeCreditMinimum`. |
| `thresholdsMet` | `:250` | residency floor (planned specific+IP credits) + major-credit floor (**bound major-tier slots only**, `:288-306`); `null` floor → `requires-approval` (not fail) (`:320-322`); upperLevel intentionally unchecked (`:324-329`). |
| `visaAxesPass` | `:338` | no `credit_floor`/`credit_ceiling`/`gpa_floor` in `feasibility.constraintViolations`; OGS/RCL/CPT notes → `requires-approval` (`:353-360`). |
| `assumptionsExplicit` | `:372` | every IP course relied on as a prereq of a planned slot has an `IP_COURSE_COMPLETION` assumption (`:431-456`). |
| `graduationTargetMet` | `:465` | plan reaches `degreeCreditMinimum` by a term `≤ graduationTargetTerm` (`:478-500`). |

**Per-placement hard constraints** (enforced inside the greedy loop today; become forward-checks in the search): prereqs-in-earlier-term (`checkAllPrereqs:255`), NOT-clause (`isExcludedByNotClause:215`), terms-offered season match (`:973`), per-term credit ceiling (`:1420`), per-term F-1/part-time floor (`visaValidator`), coreq same/earlier term (`:992-1049`), taken=locked / IP=fixed-in-term (`:682-698`), study-abroad≥9000 skip (`:236`), category caps P/F·online·outside-home (Stage-8 `:1461-1486`).

Note `feasibility.constraintViolations` is **produced by the solver** and **read by axis 5** — the materialize step (§2 rows `1372-1504`) must keep populating it so the post-hoc validator stays consistent.

---

## 5. The SOFT objective (P2.1 / P2.4)

`computeBalanceScore(semesters, loadStyle)` (`balanceScore.ts:45`): `1.0·var(weightedCredits) + 2.0·var(hardCount) + 0.5·loadStyleDeviation`; **lower = better**; pure. Today computed once post-placement (`solver.ts:1512`). P2.4 folds it into the search objective so it *drives* placement. Other soft terms (design §7.1, priority hierarchy ① valid → ② explicit student schedule → ③ stated prefs → ④ defaults): load-style + per-term light/heavy, pins (near-hard), time-to-degree, course/content prefs, summer/J-term-if-opted, study-abroad/honors. **Explicit student schedule = highest soft weight.**

---

## 6. Keep / Replace / New

### KEEP — reuse unchanged (do NOT rebuild)
- **Term utils** `solver.ts:59-109` (`parseTerm`/`termOrd`/`termCode`/`nextMainTerm`/`compareSolverTerms`). `enumerateMainTerms:85` is reused but **extended** for summer/J-term (P2.8).
- **Hard-constraint helpers:** `checkAllPrereqs:255` (+ `isPrereqSatisfied`), `isExcludedByNotClause:215`, `isStudyAbroadCourse:236`, `effectiveTermTarget:159`.
- **Ordering/rationale helpers:** `computePrereqDepths:181`, `buildDependentsIndex:337`, `computeDownstreamImpact:359`, `isCriticalPath:375`, `buildLoadRationale:417`.
- **Reused modules:** `workloadTier.ts` (`classifyWorkloadTier`), `balanceScore.ts` (`computeBalanceScore`), `forwardFeasibility.ts` (`forwardFeasibilityScreen` — pruning), `poolBinding.ts`, `visaPolicy.ts`/`visaValidator`, `graduationPathValidator.ts` (the contract), `buildIpAssumptions:571`.
- **Materialize + global checks** `solver.ts:1372-1504` — reused to turn a chosen assignment into `ForwardSemester[]` + `feasibility.constraintViolations` (driven by the search's result, not greedy).
- **Types + builder:** all `SolverInput`/`SolverOutput`/`ForwardSchedule`/slot/rationale types; `buildSolverInput.ts`.

### REPLACE — inside `solver.ts`
- **Stage 5 variable order** `:714-744` → most-constrained-first ordering in `search.ts` (P2.2).
- **Stage 6 greedy loop** `:879-1212` (esp. `candidateCourses[0]` `:901`, first-fit `break` `:1197`, no-unwind `:1200-1211`) → backtracking + forward-check + B&B over `(requirement → course → term)` (P2.2).
- **`termsForPlacement` "balanced"=chronological** `:126-136` → balance-as-objective candidate ordering (P2.4).
- **Fake top-K** `buildAlternativeCandidates:463-565` + `ALT_DISTRIBUTIONS:455` → real top-K distinct valid plans from the search (P2.3).
- **Fake `consideredAlternatives`** `:1138-1141` → real evaluated alternatives (P2.5).
- **`derivePlanState` coarse** `:598-626` — superseded by `derivePlanStateFromValidator` on **every** path incl. edit (P2.7).
- **`contingencyPlanAvailable:false`** `:588` + `alternatives.ts:44-98` advertising strings → real binding-constraint infeasibility (P2.9).

### NEW modules (`packages/engine/src/agent/forwardSchedule/`)
- **`constraintModel.ts`** — HARD predicates (the §4 axes, evaluable over a partial assignment) + SOFT objective (§5). Solver-agnostic (P2.1).
- **`search.ts`** — backtracking + forward-checking/propagation + branch-and-bound + top-K distinct enumeration; wired into `solveForwardSchedule` behind the frozen signature (P2.2/P2.3).
- **`tradeOffEngine.ts`** — deterministic 8-dimension diff of two valid plans; populates `PlanDiff.newUnmetRequirements`/`newRequiresPetition`/`cascadedShifts`/`newAssumptions` (today hardcoded `[]` in `planChangeHelpers.ts:627-634`) (P2.6).

---

## 7. Files still to close-read when their task is granularized
- **P2.6/P2.7:** `planChangeHelpers.ts` (25 KB — edit path, hollow `PlanDiff` fields `:627-634`), `explainPlanDiff.ts` (renderer reading those fields `:82-235`), `tools/proposePlanChange.ts` / `tools/confirmPlanChange.ts` (coarse-state trust), `reconcile.ts`.
- **P2.10:** `buildSolverInput.ts` (`?? 128` degree-min, double `buildProgramRules`, `majorCreditMinimum`, `preferencesOverride`), `workloadTier.ts`.

---

## 8. Architecture of the rebuilt `solveForwardSchedule`
1. **Setup** (reuse `:645-744`): enumerate terms (now opt-in summer/J-term), pre-place IP, gather candidates, prereq depths, dependents index.
2. **Build constraint model** (`constraintModel.ts`): HARD predicate set + SOFT objective from `SolverInput`.
3. **Search** (`search.ts`): most-constrained-first vars → best-first `(course,term)` by objective → forward-check (prereq windows, credit slack, offering windows, cap usage; reuse `forwardFeasibilityScreen`) → backtrack on dead-ends → B&B to the objective optimum; collect **top-K distinct** valid assignments.
4. **Materialize** (reuse `:1088-1189`, `:1372-1504`): chosen assignment → `ScheduleSlot`/`ForwardSemester[]` + real rationale (P2.5) + `feasibility.constraintViolations`.
5. **Post** (reuse): `buildIpAssumptions`, `computeBalanceScore`, top-K summaries (P2.3), coarse `state` (validator still overrides in `build.ts`), real infeasibility report when empty (P2.9).
6. Return frozen `SolverOutput`.

**Determinism:** fixed variable/candidate ordering + stable tie-breaks (course-id, term-ord) ⇒ deterministic on validity. Complete at this scale (~8 terms × tens of reqs).
