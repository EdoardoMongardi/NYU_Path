# Planning Engine — Phase 2 (Solver Rebuild) Implementation Plan

> **STATUS: DRAFT SCAFFOLD.** This lays out the architecture, the surgical rebuild boundaries, the task decomposition, sequencing, and exit criteria. Each task still needs its granular TDD steps (failing test → minimal code → commit) filled in — that granularization depends on Task P2.0 (a close read of the current `solver.ts`). Do P2.0 first, then granularize task-by-task. Builds on the merged Phase 0+1 foundation (PR #35).

> **For agentic workers:** REQUIRED SUB-SKILL once granularized: superpowers:subagent-driven-development (fresh implementer per task + spec/quality review), exactly as Phase 1 was executed.

**Goal:** Replace the greedy, single-pass, no-backtracking placement core with a complete, deterministic **constraint search** that is *deterministic on validity* and *optimizes preference* among valid plans — producing the top-K distinct valid plans with real per-slot rationale and trade-offs.

**Architecture (from spec §7):** A **solver-agnostic constraint model** — HARD constraints define "valid" (mirroring the `graduationPathValidator` axes), SOFT constraints + a weighted objective define "preferred" (workload balance, load-style, pins, course/mode prefs). A hand-rolled **backtracking + forward-checking + branch-and-bound** search produces the best valid plan and enumerates top-K distinct ones. The **validator is the contract**: the search satisfies it by construction, and every plan (initial AND edit) is validated post-hoc. A pluggable external backend (CP-SAT/MILP) stays possible behind the constraint-model interface for the future FOSE section-packing sub-problem.

**Tech stack / conventions:** identical to Phase 1 — TypeScript pnpm monorepo, Vitest (`pnpm exec vitest run "<substr>" -t "<name>"`), typecheck `pnpm exec tsc -p <pkg>/tsconfig.json --noEmit` **only** (NEVER `tsc -b` — it re-emits the `.js` shadows we purged), new tests under `packages/engine/tests/forwardSchedule/` or `.../foundation/`, scoped commits, branch off `main`.

**Companion spec:** `docs/superpowers/specs/2026-06-05-planning-engine-rebuild-design.md` (§7 engine, §7.4 trade-offs, §11 principles). **Phase-1 status/follow-ups:** memory `nyupath_planning_foundation_execution.md`.

---

## What Phase 1 already delivered (the solver now has trustworthy inputs)
One unified `buildSolverInput` (build.ts + planChangeHelpers share it); offerings wired; requirement `kind` classified structurally; validator de-null-gated + bound-satisfiers-only; per-school config; DPR personalization correct; What-If parses as a DPR. The solver's INPUT contract is clean — Phase 2 only rebuilds the placement + adds the advisor-facing outputs.

## Reuse vs rebuild (surgical boundaries — confirm in P2.0)
- **Reuse unchanged:** `SolverInput`/`SolverOutput`/`ForwardSchedule` types, `graduationPathValidator` (the contract), `workloadTier` classifier, `balanceScore` formula, `forwardFeasibility` screen, `poolBinding`, the rationale TYPES (`SlotRationale`/`SlotFlexibility`/`DownstreamImpact`), `buildSolverInput` (Phase 1).
- **Rebuild:** the placement core inside `solver.ts` (the greedy first-fit at `solver.ts:~900/1191/1197` + the Stage-7 fake "alternatives"). Replace with the constraint search.
- **New modules:** `constraintModel.ts` (hard predicates + soft objective), `search.ts` (backtracking/B&B/top-K), `tradeOffEngine.ts` (plan-vs-plan diff).

---

## Task decomposition (sequence + dependencies; granularize each before executing)

### P2.0 — Grounding (do first; no code)
Close-read `solver.ts` (1547 L) end-to-end + `alternatives.ts`, `balanceScore.ts`, `forwardFeasibility.ts`, `poolBinding.ts`, and the rationale fields in `shared/types.ts`. Produce: the exact placement control-flow, the `SolverNode` mutable state, where greedy commits (no backtrack), how slots/rationale are currently built, and the precise seam where the new search replaces the greedy loop while keeping `solveForwardSchedule`'s signature + `SolverOutput` shape. **Exit:** a written cut-map (keep/replace/new with file:line) that the remaining tasks granularize against.

### P2.1 — Constraint model (solver-agnostic) · new `constraintModel.ts`
Formalize HARD constraints as pure predicates over a (partial) assignment — one per validator axis: requirement-coverage-by-bound-course, prereqs-in-earlier-term, coreqs-same/earlier-term, terms-offered, per-term ceiling, per-term floor (F-1/part-time), ≤ grad target, aggregate floors (degree/major/upper-level/residency/school-core), category caps (P/F/outside-home/online), exclusions/repeat, taken=locked/IP=fixed. And SOFT terms with weights: workload balance, load-style (+ per-term), pins (near-hard), course/content prefs, summer/J-term-if-opted, study-abroad/honors; **explicit student schedule = highest soft weight**. **Exit:** each HARD predicate unit-tested; the SOFT objective scores a known plan deterministically; the hard set is provably the validator's axes (a plan passing all HARD predicates passes `runGraduationPathValidator`). Depends: P2.0.

### P2.2 — The search · new `search.ts` (replaces greedy in `solver.ts`) — PLAN-6
Most-constrained-first variable ordering (prereq-depth → flexibility → weight); best-first candidate ordering by the objective; forward-checking/propagation (prereq windows, per-term credit slack, offering windows, cap usage); **backtracking** on dead-ends; **branch-and-bound** to the optimum-within-valid. Wire it into `solveForwardSchedule` behind the existing signature. **Exit:** completeness fixtures (finds a valid plan iff one exists, incl. the "two first-choices collide" case greedy fails); never emits invalid-as-valid (post-hoc validator agrees); deterministic (fixed ordering). Depends: P2.1.

### P2.3 — Top-K distinct valid plans — multi-plan
Enumerate the K best *distinct* complete valid plans (distinct = differ in ≥1 placement / grad term / course choice). Replace the fake Stage-7 "alternatives". **Exit:** top-K are all valid, distinct, and ranked by objective. Depends: P2.2.

### P2.4 — Workload balance as an OBJECTIVE — PLAN-7
Fold `balanceScore` into the P2.1 objective so even heavy/easy distribution *drives* placement, not just reports. **Exit:** a balance-preferring config measurably evens the heavy-course distribution vs an unconstrained baseline on a fixture. Depends: P2.1, P2.2.

### P2.5 — Rationale recorder — PLAN-8 (data)
During the single solve, populate `SlotRationale` (satisfies-which-req, why-this-term, **rejected alternatives now meaningful** — the search actually evaluated them), `SlotFlexibility` (earliest/latest term), `DownstreamImpact`. **Exit:** every placed slot carries real rationale; a "why X here / why not term T" query is answerable from recorded data + a counterfactual probe. Depends: P2.2.

### P2.6 — Trade-off engine · new `tradeOffEngine.ts` — PLAN-15
Deterministic diff of two valid plans across the 8 dimensions (grad term, requirement coverage, workload/balance, prereq cascades, petitions, risk/buffer, preference-fit, caps). **Populate the currently-hollow `newUnmetRequirements`/`newRequiresPetition`/`cascadedShifts` fields** by actually diffing the two plan objects. **Exit:** the explainPlanDiff renderer shows real ✓/✗/⚠ trade-offs (no hardcoded empties). Depends: P2.2.

### P2.7 — Validator-as-contract loop (initial + edit) — PLAN-3 (deferred from Phase 1)
Route `propose_plan_change` / `confirm_plan_change` THROUGH `runGraduationPathValidator` (today they trust the coarse solver state). One builder → one search → one validator for every path. **Exit:** a confirmed edit cannot be stored `valid` without the 7-axis validator passing; an invalid edit is refused with the binding constraint. Depends: P2.2, P2.6.

### P2.8 — Summer / J-term enumeration (opt-in) — PLAN-5 (structural part)
Make the term enumerator include summer/J-term when the student opts in (today `enumerateMainTerms` is fall/spring only). Remove the advertised-but-uncomputable summer/J-term infeasibility strings. **Exit:** opting in lets the search place into summer/J-term; opting out excludes them. Depends: P2.2.

### P2.9 — Real infeasibility explanation — PLAN-13
Replace `contingencyPlanAvailable:false` + the advertised-but-uncomputable relaxation strings with the actual binding constraint(s) the search hit. **Exit:** an infeasible case reports the true blocker ("would need 22 cr in spring, over the 18 ceiling"), not a generic promise. Depends: P2.2.

### P2.10 — Phase-1 follow-ups fold-in (small)
(a) `?? 128` degree-min: emit a warning when a non-CAS DPR omits creditsRequired (now there's a solver warnings channel to use); (b) remove the double `buildProgramRules` call in `buildForwardSchedule` (have `buildSolverInput` surface the bundle); (c) revisit `majorCreditMinimum` to also honor course-count floors where present; (d) replace the planChangeHelpers session mutate-restore with an explicit `preferencesOverride` option on `buildSolverInput`. **Exit:** each follow-up closed + tested. Depends: P2.1/P2.7 as relevant.

---

## Global exit criteria (Phase 2 done)
Full suite green; 3× `tsc --noEmit` clean; 0 shadows; the engine is **deterministic on validity** (completeness fixtures) and **optimizes preference** (objective fixtures); propose/confirm go through the validator; trade-offs are real; top-K valid plans returned with rationale. Then final whole-branch review → `finishing-a-development-branch`.

## Out of scope (later phases)
Layer ④ advisor agent (engine-introspection/counterfactual tools, grounding prompt rules, preference compiler, proactive elicitation), Layer ⑤ experience/UI + chat-sidebar continuity + DB wiring, and the full FOSE live-data layer (auto-swap, waitlist number, campus, instructor, recitation, section materialization + the pluggable CP-SAT backend). Each per the spec; each its own plan.

## Granularization checklist (turn this scaffold into an executable plan)
For each P2.x: after P2.0's cut-map, write the bite-sized TDD steps (exact file:line edits, complete test + impl code, run commands, commit) — same format as the Phase-1 plan. Recommended: do this in a focused session with the solver.ts close-read fresh in context, then execute subagent-driven as in Phase 1.
