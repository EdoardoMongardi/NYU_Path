# NYU Path — Phase 2 (Solver Rebuild): New-Session Handoff

You are picking up the **NYU Path** planning-engine rebuild. Phase 0+1 (the foundation) is merged to `main`. Your job is **Phase 2: replace the greedy course-planning solver with a constraint search.** This document is your full orientation — read the linked canonical docs, then granularize and execute the Phase 2 plan.

---

## 0. First actions (do these before anything else)

1. **Read, in order:**
   - Memory `nyupath_implementation_philosophy.md` — the project's core philosophy (**READ FIRST**; pro-human-advisor behavior, validity-vs-preference, no-invention/cite-or-stop).
   - Memory `nyupath_planning_foundation_execution.md` — what Phase 1 delivered + **infra learnings** + Phase-1 follow-ups to fold into Phase 2.
   - `docs/superpowers/specs/2026-06-05-planning-engine-rebuild-design.md` — the approved design (esp. **§7 engine**, §7.4 trade-offs, §11 cross-cutting principles).
   - `docs/superpowers/plans/2026-06-05-planning-engine-phase2-solver.md` — **your Phase 2 blueprint** (architecture, rebuild boundaries, tasks P2.0–P2.10, exit criteria).
   - `docs/superpowers/plans/2026-06-05-planning-engine-foundation.md` — the Phase 1 plan; use it as the **format reference** for granular TDD steps.
   - `AUDIT_FINDINGS.md` §C (PLAN-*) — the engine findings Phase 2 closes.
2. **Sync + branch:** `git checkout main && git pull` (local `main` is behind `origin/main`; PR #35 merged the foundation). Then create a fresh branch for Phase 2 work, e.g. `git checkout -b feat/phase2-solver`. (An in-place feature branch is the right call here — see §3 note on the working tree.)
3. **Confirm baseline green:** `pnpm exec vitest run` → expect **1395 passed / 9 skipped**.

---

## 1. CRITICAL infra rules (these will silently corrupt your work if ignored)

- **Stale `.js`/`.d.ts` shadow artifacts:** the repo's TS sources compile *next to themselves* if you run a build. Vitest resolves `./foo.js` imports to a stale `.js` BEFORE the `.ts`, so a stale shadow makes tests run **old code**. ~1,159 such files were purged and `.gitignore` now blocks them. **Therefore:**
  - **NEVER run `tsc -b`** (build mode re-emits the shadows). Typecheck **only** with `--noEmit`:
    `pnpm exec tsc -p packages/shared/tsconfig.json --noEmit`, `… packages/engine/tsconfig.json --noEmit`, `… apps/web/tsconfig.json --noEmit`.
  - After every task, verify zero shadows:
    `find packages/engine/src packages/shared/src apps/web/lib apps/web/app -name '*.js' | while read js; do { [ -f "${js%.js}.ts" ] || [ -f "${js%.js}.tsx" ]; } && echo "$js"; done` → must be empty; `rm` any that appear.
- **Run tests:** `pnpm exec vitest run "<path-substr>" [-t "<name>"]` from repo root. New engine tests live under `packages/engine/tests/forwardSchedule/` or `.../foundation/`.
- The engine `package.json` `main`/`exports` point at `.ts` directly; `apps/web` transpiles the workspace packages — so `.ts`/`.tsx` is the source of truth everywhere.
- **DPR test fixture pattern:** `readFileSync(join(__dirname,"..","fixtures","dpr_sample.redacted.txt"))` + `parseDpr(text,{pageCount:9,nowIso:"2026-04-27T00:00:00Z"})`. A What-If fixture exists too: `dpr_whatif_sample.redacted.txt`.

---

## 2. How to execute (methodology — same as Phase 1, which worked well)

1. **Granularize first.** The Phase 2 plan is a *scaffold* (tasks + sequencing + exit criteria, not yet per-step code). **Do Task P2.0 (close-read `solver.ts`) before anything**, produce the keep/replace/new cut-map, then turn each task P2.1–P2.10 into **bite-sized TDD steps** (failing test → minimal code → run → commit) in the Phase-1 plan's format. Use the **superpowers:writing-plans** skill for this.
2. **Execute subagent-driven** (superpowers:subagent-driven-development): for each task, dispatch a **fresh implementer subagent** with the FULL task text + scene-setting context (don't make it read the plan file), then a **spec-compliance review**, then a **code-quality review**, with a fix loop. *Reviews catch real bugs* — in Phase 1 they caught a duplicate keyword path and a validator placeholder gap. Don't skip them. (To conserve, a single reviewer doing "spec-then-quality, in that order" is acceptable for substantive tasks; trivial tasks can be controller-verified via `git show` + green suite.)
3. **Continuous green + TDD:** every task ends with full suite green, 3× `--noEmit` clean, zero shadows, and a **scoped commit**.
4. **Scoped commits only:** `git add <specific files>` — **NEVER `git add -A`.** The working tree has unrelated pre-existing changes (`D .agent/rules/...`, `M pnpm-lock.yaml`, `D validation_spec.md`) + untracked files; leave them alone.
5. **Commit trailer:** end messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
6. **Git etiquette:** branch off `main`; **don't push or merge unless the user asks**. When you finish, present finishing options (leave/PR/merge) for the user to choose.
7. **Stop-and-ask:** when a decision has real trade-offs you can't resolve from the spec/code, STOP and ask the user (per the project's no-skip rule) — don't guess on consequential forks.

---

## 3. What Phase 2 is (and isn't)

**Goal:** replace the greedy, single-pass, no-backtracking placement core with a complete, deterministic **constraint search** that is *deterministic on validity* and *optimizes preference* among valid plans — returning **top-K distinct valid plans** with **real per-slot rationale** and **real trade-offs**.

**Reuse unchanged** (hardened in Phase 1 — do NOT rebuild): `SolverInput`/`SolverOutput`/`ForwardSchedule` types; `graduationPathValidator` (the contract); `workloadTier` classifier; `balanceScore` formula; `forwardFeasibility`; `poolBinding`; the rationale TYPES (`SlotRationale`/`SlotFlexibility`/`DownstreamImpact`); and **`buildSolverInput.ts`** (the unified builder created in Phase 1 — both build + edit paths use it).
**Rebuild:** the placement core inside `packages/engine/src/agent/forwardSchedule/solver.ts` (the greedy first-fit + the fake Stage-7 "alternatives").
**New modules:** `constraintModel.ts`, `search.ts`, `tradeOffEngine.ts`.

**Tasks (full detail + exit criteria in the Phase 2 plan):** P2.0 grounding · P2.1 constraint model (hard predicates = validator axes; soft objective) · P2.2 backtracking+forward-check+branch-and-bound search (PLAN-6) · P2.3 top-K distinct plans · P2.4 balance as an objective (PLAN-7) · P2.5 rationale recorder (PLAN-8 data) · P2.6 trade-off engine (PLAN-15) · P2.7 route propose/confirm THROUGH the validator (PLAN-3) · P2.8 summer/J-term enumeration (PLAN-5 structural) · P2.9 real infeasibility explanation (PLAN-13) · P2.10 fold in the Phase-1 follow-ups.

**Decisions already locked (do NOT re-litigate):**
- **Hand-rolled** backtracking + branch-and-bound, NOT an external optimizer — chosen for explainability (the decision trace IS the "why") + the tiny problem size (~8 terms × tens of reqs). Keep the constraint model **solver-agnostic** so a CP-SAT/MILP backend is *pluggable later* — but only for the future **FOSE section-packing** sub-problem, not now.
- **Validity is a contract:** the validator is the single definition of "valid"; the search satisfies it *by construction*; every plan (initial AND edit) is validated post-hoc.
- **PLAN-3 belongs to Phase 2** (route propose/confirm through `runGraduationPathValidator` — it was intentionally deferred from Phase 1).
- **Structural now, FOSE later:** the FOSE live-data layer (Albert auto-swap, waitlist number, campus, instructor, recitation pairing, section materialization) is a **later phase, NOT Phase 2**.
- Every fix must **generalize** — no per-case patches, no keyword blacklists.

**Out of scope for Phase 2** (later phases, each its own plan): the advisor agent (Layer ④ — engine-introspection/counterfactual tools, grounding prompt rules, preference compiler, proactive elicitation), the experience/UI + chat-sidebar continuity + DB wiring (Layer ⑤), and the FOSE live-data layer.

---

## 4. Phase-1 follow-ups to fold into Phase 2 (Task P2.10)
- `graduationCreditMinimum ?? 128` is still silent in `build.ts` for a non-CAS DPR missing `creditsRequired` — surface a warning (a solver warnings channel exists now).
- `buildForwardSchedule` calls `buildProgramRules` twice (once inside `buildSolverInput`, once for `validatorRules`) — pure/cheap but redundant; have `buildSolverInput` surface the bundle.
- `majorCreditMinimum` currently = sum of *units*-counter major leaves (= 36 for the CAS CS/Math fixture, the joint-residency row); it does NOT capture *course-count* floors (e.g. an "18 courses" requirement). Revisit when course-count floors matter.
- `upperLevelMinCredits` is left null → validator returns `requires-approval`; source it from a reliable counter when available.
- `planChangeHelpers` preferences path uses a session mutate-then-restore pattern (works for current callers, not async-safe) — consider an explicit `preferencesOverride` option on `buildSolverInput`.

## 5. Honest caveats / known limits
- **Non-CAS correctness is built but unvalidated** — the home-school path degrades to school-agnostic `"unknown"`, and requirement classification falls back to `"unknown"` kind for hierarchies it can't structurally resolve. There is an `it.skip` placeholder in `packages/engine/tests/foundation/validityContract.test.ts` (and similar) gating this until a **real non-CAS DPR fixture** exists. If the user can supply a de-identified non-CAS DPR, wire it as a fixture and un-skip; otherwise keep the deferral (the philosophy forbids guessing DPR structure).

## 6. Definition of done (Phase 2)
Full suite green; 3× `tsc --noEmit` clean; 0 shadows; the engine is **deterministic on validity** (completeness fixtures: finds a valid plan iff one exists; never emits invalid-as-valid) and **optimizes preference** (objective fixtures); propose/confirm go through the validator; trade-offs are real (no hardcoded-empty fields); top-K distinct valid plans returned with real rationale. Then a final whole-branch review → present finishing options (leave/PR/merge) to the user.
