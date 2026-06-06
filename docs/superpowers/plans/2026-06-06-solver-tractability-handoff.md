# Solver Tractability — New-Session Handoff (granularize + execute)

You are picking up the **NYU Path** planning engine. Phases 0+1 (foundation) and 2 (greedy→constraint-search rebuild) are **merged to `main`**. Your job: **granularize the tractability plan into bite-sized TDD steps, then execute it subagent-driven.**

The blueprint is already written — your job is to (a) re-ground on the as-built code (Task **T0**), (b) turn each task into TDD steps in the Phase-1 plan's format, and (c) execute it task-by-task with reviews.

## 0. Read first (in order)
- Memory `nyupath_implementation_philosophy.md` — core philosophy (**READ FIRST**: validity-vs-preference, deterministic-on-validity, defaults for every preference, F-1 full-time, workload balance, no-invention/confidence-verify).
- **`docs/superpowers/plans/2026-06-06-solver-tractability.md`** — **THE PLAN you are executing** (goal, approach, tasks T0–T9, exit criteria, philosophy/audit guardrails, the "Preserve" list).
- `docs/superpowers/plans/2026-06-05-phase2-cutmap.md` — the P2.0 cut-map (NOTE: it describes the *old greedy* `solver.ts`, now deleted — useful for intent, but T0 must re-read the **as-built** code).
- `docs/superpowers/specs/2026-06-05-planning-engine-rebuild-design.md` — design (§7 engine, §11 principles).
- `docs/superpowers/plans/2026-06-05-planning-engine-foundation.md` — **format reference** for granular TDD steps.
- Memory `nyupath_planning_foundation_execution.md` — infra learnings + follow-ups.
- `AUDIT_FINDINGS.md` §C — PLAN-5/6/7/13 (the engine findings).

## 1. Why this work exists (the one-paragraph context)
Phase 2's constraint search is correct and **sound** (verified: never reports false-"infeasible"; validity-as-contract holds; trade-offs/balance/rationale are real). But it **optimizes while searching** (branch-and-bound scoring every node, no admissible bound), so it **truncates at ~5–6 multi-candidate requirements over a 4-year horizon** — and a real full-degree plan has **10–20 requirements**, so it essentially always truncates → it degrades to a safe best-effort heuristic, not the complete+optimal "pick the preferred among the valid plans" engine we designed. This plan makes it tractable (feasibility-first) and fixes the related correctness gaps.

## 2. CRITICAL infra rules (will silently corrupt your work if ignored)
- **NEVER run `tsc -b`** — it re-emits `.js`/`.d.ts` shadow artifacts that vitest runs *instead of* the `.ts` source. Typecheck ONLY with `--noEmit`: `pnpm exec tsc -p packages/{shared,engine}/tsconfig.json --noEmit` and `apps/web/tsconfig.json --noEmit`.
- After each task, verify zero shadows: `find packages/engine/src packages/shared/src apps/web/lib apps/web/app -name '*.js' | while read js; do { [ -f "${js%.js}.ts" ] || [ -f "${js%.js}.tsx" ]; } && echo "$js"; done` (must be empty; `rm` any).
- Tests: `pnpm exec vitest run "<substr>"`. **Baseline on `main` after Phase 2 = 1565 passed / 9 skipped.**
- **Scoped commits only** (`git add <files>`, NEVER `git add -A` — pre-existing leftovers `D .agent/rules`, `M pnpm-lock`, `D validation_spec` + a couple untracked files must stay untouched).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch off `main`; **don't push/merge unless the owner asks**; present finishing options when done.

## 3. How to execute (same flow as Phases 1 & 2 — it worked)
1. `git checkout main && git pull` → `git checkout -b feat/solver-tractability`. Confirm baseline `pnpm exec vitest run` = 1565/9.
2. **Do T0 first** (re-read the as-built `solver.ts`/`search.ts`/`constraintModel.ts`/`materializePlan.ts`/`solverHelpers.ts`/`buildSolverInput.ts`/`tradeOffEngine.ts` → an insertion cut-map). Use **superpowers:writing-plans** to granularize T1–T9 into bite-sized TDD steps against that cut-map.
3. **Execute subagent-driven** (superpowers:subagent-driven-development): per task → fresh implementer (full task text + context; don't make it read the plan file) → spec-compliance review → code-quality review → fix loop. *Reviews catch real bugs — don't skip.* Trivial tasks may be controller-verified.
4. **Continuous green + TDD:** every task ends with full suite green, 3× `--noEmit` clean, 0 shadows, a scoped commit.
5. **Stop-and-ask** on consequential trade-offs (see §6).

## 4. PRESERVE — verified-good Phase 2 deliverables that must NOT regress
Validity-as-contract + PLAN-3 (propose/confirm gated on `runGraduationPathValidator`); constraint↔validator 7-axis parity; the trade-off engine's real PlanDiff fields; balance-as-objective; the real rationale recorder; greedy deletion; opt-in summer/J-term. This work refactors the **search strategy + pool handling + fill/floor edges only**. Re-run the relevant Phase-2 tests after each task to confirm no regression.

## 5. Locked decisions (do NOT re-litigate)
- **Feasibility-first, then optimize:** find a *valid* plan fast (needs no preferences), then rank/locally-improve for preference. Don't optimize-while-searching across the whole space.
- **16-credit/term default grid is a DEFAULT, not a hard cap.** Fast first-fit for the ~90%; **relax automatically** (up to per-school ceiling/18, add a term, widen backtracking) when it can't satisfy validity — **never false-infeasible.** Think in *credits (16)*, not "4 courses." Final term takes the remainder. Don't pad summer/J-term.
- **Constrained pools** (major electives + gen-ed/Core): **feasibility-aware placeholders** (heavy weight 1.0; only placeable where ≥1 real pool member is offered + prereqs/coreqs satisfiable; defer specific binding; keep chain-linked members explicit). **Free electives are already placeholders** (light 0.5) — leave them; just keep the fill respecting the F-1 floor + 18 ceiling.
- **No invention:** fix the range-parsing so elective pools never become a phantom single course (e.g. `CSCI-UA 400`); placeholders must be *sound* (a real binding provably exists).
- **F-1:** keep non-final terms ≥ floor; **exempt the final graduating term (RCL)** — don't force-fill or refuse a short final term.
- **Preference is best-effort, honestly framed** (structured optimality signal + confidence caveat) — *satisfy preferences as much as possible*, not *prove global optimum*.
- **Validity is the contract** everywhere: the validator is the single definition of valid; the search satisfies it by construction; genuinely-infeasible inputs still report real binding constraints (don't lose PLAN-13).

## 6. Stop-and-ask (escalate to the owner)
If, after T1–T2, a feasibility-first hand-rolled search *still* can't comfortably handle worst-case realistic inputs (very dense prereq chains + many heavy pools), the design's reserved hedge is a **pluggable external solver backend (CP-SAT/MILP)** behind the same constraint-model interface — but it trades away explainability, so it's a deliberate owner decision, not an automatic step. Surface it; don't switch silently.

## 7. Done when
Realistic 10–20-requirement full-degree plans **complete without truncation, pass `runGraduationPathValidator`, and return a strongly-preferred plan**; never false-infeasible; genuinely-infeasible still explained; F-1 edges correct; all PRESERVE deliverables still pass; full suite green; 3× `--noEmit` clean; 0 shadows. Then final whole-branch review → present finishing options (leave / PR / merge) to the owner.
