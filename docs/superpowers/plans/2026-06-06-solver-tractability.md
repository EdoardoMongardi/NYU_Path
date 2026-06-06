# Planning Engine — Solver Tractability & Pool Placeholders (Phase 2 follow-on)

> **STATUS: DRAFT PLAN (structured; granularize per task after T0).** Builds on the merged-pending Phase 2 work on branch `feat/phase2-solver`. The per-step TDD granularization for each task depends on **T0** (a re-read of the *as-built* search/constraint/materialize code — the P2.0 cut-map describes the *old* greedy `solver.ts`, which no longer exists). Do T0 first, then granularize T1→T9 into bite-sized TDD steps (Phase-1 format) and execute subagent-driven.

**Why this plan exists:** Phase 2 replaced the greedy solver with a constraint search and is correct + sound (verified: never reports false-"infeasible"; validity-as-contract holds; trade-offs/balance/rationale are real). **But** the search "optimizes while searching" (branch-and-bound scoring every node, no admissible bound), so it **truncates at ~5–6 multi-candidate requirements over a 4-year horizon** — and a real student plans a full degree of **10–20 requirements**, so essentially *every* realistic full-plan request truncates. It stays safe (returns a valid plan flagged "may not be optimal," or "feasibility unconfirmed") but does **not** deliver the designed guarantee — *"deterministic on validity → pick the preferred among the valid plans"* — for the primary use case. This plan makes it genuinely tractable and fixes the related correctness gaps surfaced during review.

**Goal:** A solver that, for a realistic full-degree plan (10–20 unmet requirements, up to ~8 future terms), **always finds a valid plan when one exists, fast, and returns a strongly-preferred one** — preserving validity-as-contract and never falsely refusing.

**Core approach (decided with the project owner):** **Feasibility-first, then optimize.** Separate finding a *valid* plan (needs no preferences) from choosing the *preferred* one (cheap ranking/local-improve). Use a **16-credit/term default grid as a fast first-fit heuristic** for the find-valid step, with an automatic **relax fallback** (never falsely infeasible). Represent **constrained course pools** (major electives + gen-ed/Core distribution) as **feasibility-aware placeholders** so the search never enumerates hundreds of specific pool courses.

**Tech stack / infra rules (unchanged, MANDATORY):** TS pnpm monorepo. Typecheck `pnpm exec tsc -p packages/{shared,engine}/tsconfig.json --noEmit` and `apps/web/tsconfig.json --noEmit` — **NEVER `tsc -b`** (it re-emits `.js` shadow artifacts that vitest runs instead of `.ts`). After each task verify zero shadows (`find packages/engine/src packages/shared/src apps/web/lib apps/web/app -name '*.js' | while read js; do { [ -f "${js%.js}.ts" ] || [ -f "${js%.js}.tsx" ]; } && echo "$js"; done` → empty). Tests `pnpm exec vitest run "<substr>"`. Scoped commits only (NEVER `git add -A`; pre-existing leftovers `D .agent/rules`, `M pnpm-lock`, `D validation_spec` stay untouched). Commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Execute subagent-driven (implementer → spec review → quality review). Baseline on `feat/phase2-solver` = **1565 passed / 9 skipped**.

**Sources reviewed (so nothing is neglected):** core philosophy memory `nyupath_implementation_philosophy.md`; design spec `docs/superpowers/specs/2026-06-05-planning-engine-rebuild-design.md` (§7 engine, §11 principles); Phase 2 scaffold `…/2026-06-05-planning-engine-phase2-solver.md`; as-built cut-map `…/2026-06-05-phase2-cutmap.md`; `AUDIT_FINDINGS.md` §C (PLAN-5/6/7/13); and this review's adversarial findings.

---

## Preserve — already built & verified-good (do NOT redo or regress)
Validity-as-contract + PLAN-3 (propose/confirm gated on `runGraduationPathValidator`); the 7-axis ↔ hard-predicate parity in `constraintModel.ts`; the trade-off engine filling real PlanDiff fields; balance-as-objective; the real rationale recorder (counterfactual rejected-alternatives, feasible window, coreq label); greedy deletion; summer/J-term opt-in (P2.8). **This plan refactors the SEARCH STRATEGY + pool handling + fill/floor edges only — it must keep all of the above passing.**

---

## Philosophy & audit alignment (the guardrails this plan must honor)
- **Deterministic on validity:** never falsely report infeasible. The relax fallback (T2) guarantees this: failing the fast 16/term grid → relax/broader search, *not* refusal. (PLAN-6.)
- **Genuinely-infeasible still explained:** when truly no valid plan exists, report the real binding constraints (preserve P2.9/PLAN-13). The fast-path must distinguish "couldn't find on the fast path → relax" from "proved infeasible → binding reasons."
- **Valid → preferred via defaults:** rank/optimize with defaults (balanced load, 16/term, graduate by target) when the student is silent; stated prefs override (priority: ① valid → ② explicit student schedule → ③ stated prefs → ④ defaults). (Spec §7.1.)
- **Preference is best-effort, honestly framed:** "preferred" becomes "best from feasibility-first + local-improve," surfaced with a confidence caveat when optimality isn't certain (T7) — consistent with *satisfy preferences as much as possible* + confidence/verify, not *prove global optimum*.
- **No invention:** stop fabricating phantom pool courses (T5 range-parsing fix); placeholders are sound (a real binding provably exists). (Cite-or-stop.)
- **F-1 full-time:** keep every non-final term ≥ the F-1 floor; exempt the final graduating term (RCL). (T6.)
- **Workload:** free electives = light (0.5); major-elective/Core pools = heavy (1.0). General fixes only — no per-case/keyword hacks.

---

## Tasks

### T0 — Re-ground on the AS-BUILT code (do first; no code)
The P2.0 cut-map describes the *old* greedy `solver.ts` (gone). Close-read the *current* implementation: `solver.ts` (379 L, the new orchestration), `search.ts` (689 L), `constraintModel.ts` (638 L), `materializePlan.ts` (1048 L), `solverHelpers.ts` (540 L), `buildSolverInput.ts` (candidate scrape + floors), `tradeOffEngine.ts`. Produce an updated cut-map: where `searchTopKPlans`/`runSearch` decide values + prune + truncate (`search.ts` `rawValues`, `maxNodes`, the B&B/score path); where `effectiveTermTarget`/free-elective fill live (`materializePlan.ts`/`solverHelpers.ts`); where `extractCandidateCourseIds` + `COURSE_ID_RE` build candidates and the floors (`buildSolverInput.ts`); the `exhaustive` flag flow. **Exit:** a written insertion map for T1–T8 with exact file:line seams.

### T1 — Feasibility-first architecture (the core fix) — PLAN-6
Restructure `solveForwardSchedule` from "branch-and-bound the optimum over the whole space" into three phases behind the frozen signature:
1. **findOneValidPlan** — a *sound, complete* search that returns the **first** valid full assignment (stops at first success, not the optimum), using strong ordering (most-constrained-first vars; T2's 16/term term-ordering). Because it stops at first valid, its effective reach is far beyond the optimize-everything budget.
2. **localImprove** (→ T3) — improve the found plan toward preference with validity-preserving moves.
3. **findDiverseValidPlans** (→ T3) — a few distinct valid plans for top-K, found cheaply (e.g., restart with different tie-breaks / forbid the prior winner's signature), not by exhausting the space.

Remove the "score every node / no admissible bound" optimize-while-searching as the *primary* path. **Exit:** realistic fixtures (12–18 reqs, 8 terms) find a valid plan well within budget (no truncation); never false-infeasible (known-feasible fixtures pass); deterministic (fixed ordering/tie-breaks). Depends: T0.

### T2 — 16-credit/term default grid + relax fallback (the fast heuristic for T1)
The find-valid step assumes a **16-credit/term grid** (default; horizon ≈ ⌈remaining credits ÷ 16⌉) and **first-fits required courses by prereq depth into the earliest feasible term** with capacity ≤ 16 credits. **16 is a default target, NOT a hard cap.** When the grid can't satisfy validity, **relax automatically** (allow up to the per-school ceiling/18; add a term; widen backtracking) — never refuse. Think in **credits (16)**, not "4 courses" (variable-credit courses exist). The **final term takes the remainder** (may be < 16). Respect the per-school ceiling (≤18) and F-1 floor (T6). Don't pad summer/J-term. **Exit:** the 90% case is a near-instant first-fit; accelerator (needs 18/term to hit grad target), near-graduate (short final term), and prereq-dense (a term needs 5 courses) cases **relax and still produce a valid plan**; a *genuinely* infeasible input still returns real binding constraints (PLAN-13 intact). Depends: T1.

### T3 — Local preference optimization + top-K — PLAN-7
On the found valid plan, apply validity-preserving improving moves toward the objective (the existing `computeBalanceScore` + load-style + pins + stated prefs + defaults; explicit student schedule highest). Re-check each move against the constraint model so it stays valid. Produce top-K distinct valid plans for `alternativeCandidates`. **Re-ranking on a preference change must reuse found plans / re-optimize — NOT re-search from scratch.** **Exit:** balance/load-style demonstrably improve the found plan (reuse/extend `objectiveBalance.test.ts`); a stated preference shifts the chosen plan; top-K are valid + distinct; changing a preference doesn't trigger a full re-search. Depends: T1, T2.

### T4 — Feasibility-aware placeholders for constrained pools (major electives + gen-ed/Core)
Represent "choose-N from a pool" requirements (major electives like `R1142/30`; CAS-Core distribution categories) as **placeholders carrying a pool descriptor** (dept/level/category), **not** enumerated specific courses. A pool placeholder may occupy term T **only if ≥1 real pool member is offered in T and its prereqs/coreqs are satisfiable by T given the rest of the plan** (sound — no false reservations). Keep the **heavy weight (1.0)** for major-elective/Core placeholders (distinct from light free-elective placeholders, 0.5). Keep **chain-linked** members explicit (a pool course that is itself a prereq/coreq of another required course). Defer the specific course pick to bind-time (`bindPoolSlot`/`proposePlanChange`), which already re-validates. **Exit:** the search no longer branches over specific pool courses (branching cut); a pool placeholder never lands in a term where no real member fits; binding a real course re-validates; weight stays heavy. Depends: T0; pairs with T5. (Free electives already placeholdered — leave; just confirm light weight + fill behavior.)

### T5 — Range-parsing correctness fix (latent no-invention bug)
`extractCandidateCourseIds`/`COURSE_ID_RE` (`buildSolverInput.ts`) collapses a pool **range** like `"CSCI-UA 400-499"` into a single, often **non-existent** course `"CSCI-UA 400"`. Fix it to recognize ranges/lists and emit a **pool descriptor** (dept + level range) feeding T4's placeholder — **never a fabricated single course.** **Exit:** `R1142/30` ("Computer Science: Elective Courses — CSCI-UA 400-499") yields a real pool (or sound placeholder), not phantom `CSCI-UA 400`; tested against the real `dpr_sample.redacted.txt`; no planned course is absent from the catalog. Depends: T0; feeds T4.

### T6 — F-1 floor edges (validity)
(a) Make the "every non-final term ≥ F-1 floor" guarantee **explicit** — assert `effectiveTermTarget ≥ f1Floor` for F-1 students and ensure the free-elective fill (which keeps the *materialized* plan full-time) is reflected in the floor check (close the search-phase-vs-fill gap the review found). (b) **Final-semester RCL exemption:** the F-1 12-credit floor must **not** be enforced on the final graduating term — a near-graduate with < 12 credits left is valid (flagged RCL/verify-with-OGS), not force-filled with junk electives nor refused. Verify `visaValidator`/the floor predicate handle the last term. **Exit:** an F-1 mid-degree term is kept ≥12 via fill; an F-1 final term with <12 is valid + RCL-flagged (not refused, not padded); tests cover both. Depends: T0; interacts with T2.

### T7 — Structured non-optimal / exhaustive signal
Promote the search's `exhaustive`/optimality status from a warning string to a **structured field** on `SolverOutput` + `ForwardSchedule` (e.g. `optimality: "optimal" | "best-effort" | "feasibility-unconfirmed"`). The agent/UI reads it and surfaces a **confidence caveat** ("valid plan; may not be the most preferred — say more about your priorities and I'll refine"), per the confidence/verify philosophy. **Exit:** a best-effort plan carries the structured flag; a consumer reading only `state`/`feasible` can still detect non-optimality; the advisor surfaces it. Depends: T1.

### T8 — Harden `simulate_alternatives` to the validator
`simulateAlternatives` (`alternatives.ts`) builds display candidates from the **coarse** solver state, which can disagree with the 7-axis validator (a coarse-feasible alt the validator would reject). Route it through `runGraduationPathValidator` (or clearly flag any unvalidated candidate). **Exit:** displayed alternatives are validator-checked or explicitly flagged; no coarse-feasible-but-invalid alternative is shown as valid. Depends: T0. (Lower priority — display-only path, not a persisting write.)

### T9 — Realistic-scale verification + regression
Add fixtures that exercise the real case: a 12–18-requirement, ~8-term DPR-derived input (CAS CS/Math from the sample, plus a multi-pool case). Assert: completes with **no truncation**; the result **passes `runGraduationPathValidator`**; preference is reasonable; runtime is fast. Regression: never false-infeasible (known-feasible at scale); a genuinely-infeasible input still reports binding constraints; the F-1 edges (T6) hold. **Exit:** realistic full-degree plans complete + validate; full suite green; 3× `--noEmit` clean; 0 shadows. Depends: T1–T6.

---

## Global exit criteria
Full suite green; 3× `tsc --noEmit` clean; 0 shadows; realistic 10–20-requirement full-degree plans **complete without truncation, pass the validator, and return a strongly-preferred plan**; never false-infeasible; genuinely-infeasible still explained; all preserved deliverables (validity-as-contract, PLAN-3, trade-offs, balance, rationale, summer/J-term) still pass. Then final whole-branch review → present finishing options (leave / PR / merge) to the owner.

## Sequencing
T0 → T1 → T2 → T3 (the tractability core) · T5 → T4 (range fix feeds pool placeholders) · T6, T7, T8 independent (any order after T0) · T9 last. T4/T5 and T6 can proceed in parallel with T1–T3 by a second track if desired, but T1–T3 are the critical path.

## Open decision flagged for the owner (stop-and-ask if it arises)
If, after T1–T2, a feasibility-first hand-rolled search *still* can't comfortably handle the worst realistic inputs (e.g. very dense prereq chains + many heavy pools), the design's reserved hedge is the **pluggable external solver backend** (CP-SAT/MILP) behind the same constraint-model interface — but that trades away some explainability, so it's a deliberate owner decision, not an automatic step.

## Granularization checklist
After T0's as-built cut-map, write each task's bite-sized TDD steps (exact file:line edits, complete test + impl code, run commands, scoped commit) in the Phase-1 plan's format; then execute subagent-driven (implementer + spec + quality review), preserving the "Preserve" list above at every step.
