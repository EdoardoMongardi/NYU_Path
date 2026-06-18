# NYU Path — agent instructions

## Read this first (binding)

**Before ANY work on this repo — planning, editing, building, reviewing, answering — read [`Docs/core_philosophy.md`](Docs/core_philosophy.md).** It is the project's binding north-star and every decision here serves it. In one breath: the agent must behave like a **professional human academic adviser for ALL NYU undergrad** (including NYU Shanghai + NYU Abu Dhabi — never CAS-only); course plans are **deterministic on validity, then preferred**; any conclusion that is not ~99% grounded/computed carries a **confidence level + "verify with your adviser,"** and the agent **never invents a fact or ships an invalid plan**; identify risk / state trade-offs on both agent- and student-proposed decisions.

**Philosophy point #6 (doc discipline — binding):** every plan + audit file goes in its correct `Docs/` slot, and **after each verified-and-confirmed phase implementation, revise the matching `Docs/current-system/` doc** so the docs stay in sync with the code.

## Where things are

- All documentation lives under [`Docs/`](Docs/) — start at [`Docs/README.md`](Docs/README.md).
  - `Docs/current-system/` — how the system works **today** (`engine/` · `tools/` · `web/` · `surrounding/`), kept in sync with code.
  - `Docs/specs/2026-06-05-planning-engine-rebuild-design.md` — the canonical architecture.
  - `Docs/plans/` — implementation plans in planned order. **Latest implemented:** `35-2026-06-17-whatif-and-wpf-requirement-modeling.md` (the 3-branch what-if taxonomy + W/pass-fail requirement modeling — COMPLETE on `feat/plan35-whatif-wpf`, not yet merged). Prior: `33` (Phase 4) + `34` (F1–F3 + F3-revise/F3-campus), merged to `main` from `feat/phase4-experience`.
  - `Docs/audits/` · `Docs/reports/` · `Docs/reference/` · `Docs/deprecated/`.
- Code: `apps/web` (Next.js), `packages/engine` (agent loop + 21 tools + constraint-search planner + 7-axis validator), `packages/shared`, `data/`, `tools/`, `evals/`.

## Current status

Planning-engine rebuild **Phases 0–3 are DONE + merged** — feasibility-first constraint search + the 7-axis graduation-path validator (the single definition of "valid") + 21 tools; DPR-first (authoritative), bulletin RAG as cited/hedged tier-2. **Phase 3 — the advisor layer** — is DONE + merged to main (PRs #43–#48): `probe_counterfactual` (introspection/counterfactual), the plan-claim response-validator check, the soft-objective preference primitive, and proactive elicitation (CORE RULES 12/13) are all live.

**Phase 4 — Experience & continuity — is DONE + merged to `main`** (from `feat/phase4-experience`; plans 33 + 34). The chat/sidebar share one `useSyncExternalStore` plan-state store; edits are propose→preview→confirm (review card with ✓/⚠/✗ + Confirm/Cancel/Ask-why; invalid → red card, canvas untouched); the structured `OnboardingWizard` is the live `awaiting_dpr` onboarding; pending mutations + confirmed plans persist to Neon (durable `pending_mutations` table, supersede-then-insert) with OTP login + an always-on self-serve delete route. Pre-merge follow-ups landed: **F2** DPR-derived fields (home school / major-minor / catalog year / courses / grades) are READ-ONLY — change only via a corrected DPR (CORE RULE 14); **F3** IP-course changeability is window-aware + verification-grounded against an owner-correctable per-season academic calendar (`academicCalendar.ts`, cite-or-hedge; per-campus NY / Shanghai / Abu Dhabi), and a claimed current-term drop/withdraw/pass-fail is an unverified draft never recorded as fact until the next DPR (CORE RULE 15). The frozen engine contract (`finalizeForwardSchedule` + the 7-axis validator + the solver) was NOT touched.

**Plan 35 — what-if taxonomy + W / pass-fail requirement modeling — is DONE** (on `feat/plan35-whatif-wpf`, **not yet merged**; the formerly-deferred "W / pass-fail → requirement-engine modeling" is now resolved). The W/pass-fail consequence is **computed**, not just hedged: pure DPR transforms (`applyWithdrawalToDpr` / `applyPassFailToDpr`) edit the DPR *input* and re-run the **unchanged** frozen pipeline; per-school `pfEligibility` (over the existing `SchoolConfig.passFail`) makes a **W universal** but **P/F school-specific** (Stern counts toward the major; most schools electives-only; defer/unknown → hedge); a P/F fail re-opens + is not GPA-neutral (exact GPA left unquantified). Surfaced read-only via `probe_counterfactual` arms (+ F3 window caveat) and a **confirmable** `propose_whatif_assumption` flow (`/api/plan/whatif`) whose confirm persists **only the `forward_schedule`** — the **binding R1 guardrail**: the authoritative `students.parsed_dpr` is never overwritten by a hypothetical (the `assertAuthoritativeDpr` guard + a byte-identity test enforce it). Three branches (CORE RULE 16): **A** = a hypothetical PROGRAM change → upload the Albert What-If audit (`/api/whatif-audit`) as a labeled NON-committed exploration; **B** = current-term withdraw/pass-fail (above); **C** = a confidence-disclaimed estimate. CORE RULE 15 reworded (§6: confirming a PLAN ≠ recording a FACT). The frozen contract stays intact. ⚑ Still deferred: exact GPA-of-a-hypothetical-fail; remaining absent calendar windows; DPR parser gaps DPR-2/3/4.

## Conventions

- **The working code is the source of truth** — never trust a stale comment or doc over the implementation.
- **Verify before claiming done:** `cd packages/engine && npx tsc --noEmit`; `cd apps/web && npx tsc --noEmit`; `npx vitest run` (repo root). Never `tsc -b` (it emits `.js` shadows vitest then runs instead of the `.ts`).
- **Git:** branch → PR → merge; stage selectively (**never `git add -A`**); end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Model:** default primary `claude-sonnet-4-6` (override `NYUPATH_PRIMARY_MODEL`); fallback `gpt-4.1-mini`.
- **Leave the pre-existing working-tree leftovers untouched** (do not stage/revert): deleted `.agent/rules/00-implementation-guardrails.md`, modified `pnpm-lock.yaml`, untracked `packages/engine/scripts/diagnoseInfeasible.ts` + `tools/bulletin-parser/validateCurated.ts`.
