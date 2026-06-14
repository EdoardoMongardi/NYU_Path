# NYU Path — agent instructions

## Read this first (binding)

**Before ANY work on this repo — planning, editing, building, reviewing, answering — read [`Docs/core_philosophy.md`](Docs/core_philosophy.md).** It is the project's binding north-star and every decision here serves it. In one breath: the agent must behave like a **professional human academic adviser for ALL NYU undergrad** (including NYU Shanghai + NYU Abu Dhabi — never CAS-only); course plans are **deterministic on validity, then preferred**; any conclusion that is not ~99% grounded/computed carries a **confidence level + "verify with your adviser,"** and the agent **never invents a fact or ships an invalid plan**; identify risk / state trade-offs on both agent- and student-proposed decisions.

**Philosophy point #6 (doc discipline — binding):** every plan + audit file goes in its correct `Docs/` slot, and **after each verified-and-confirmed phase implementation, revise the matching `Docs/current-system/` doc** so the docs stay in sync with the code.

## Where things are

- All documentation lives under [`Docs/`](Docs/) — start at [`Docs/README.md`](Docs/README.md).
  - `Docs/current-system/` — how the system works **today** (`engine/` · `tools/` · `web/` · `surrounding/`), kept in sync with code.
  - `Docs/specs/2026-06-05-planning-engine-rebuild-design.md` — the canonical architecture.
  - `Docs/plans/` — implementation plans in planned order. **Latest implemented:** `32-2026-06-10-planning-engine-phase3-advisor.md` (Phase 3, merged via PRs #43–#48).
  - `Docs/audits/` · `Docs/reports/` · `Docs/reference/` · `Docs/deprecated/`.
- Code: `apps/web` (Next.js), `packages/engine` (agent loop + 21 tools + constraint-search planner + 7-axis validator), `packages/shared`, `data/`, `tools/`, `evals/`.

## Current status

Planning-engine rebuild **Phases 0–3 are DONE + merged** — feasibility-first constraint search + the 7-axis graduation-path validator (the single definition of "valid") + 21 tools; DPR-first (authoritative), bulletin RAG as cited/hedged tier-2. **Phase 3 — the advisor layer** — is DONE + merged to main (PRs #43–#48): `probe_counterfactual` (introspection/counterfactual), the plan-claim response-validator check, the soft-objective preference primitive, and proactive elicitation (CORE RULES 12/13) are all live.

## Conventions

- **The working code is the source of truth** — never trust a stale comment or doc over the implementation.
- **Verify before claiming done:** `cd packages/engine && npx tsc --noEmit`; `cd apps/web && npx tsc --noEmit`; `npx vitest run` (repo root). Never `tsc -b` (it emits `.js` shadows vitest then runs instead of the `.ts`).
- **Git:** branch → PR → merge; stage selectively (**never `git add -A`**); end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Model:** default primary `claude-sonnet-4-6` (override `NYUPATH_PRIMARY_MODEL`); fallback `gpt-4.1-mini`.
- **Leave the pre-existing working-tree leftovers untouched** (do not stage/revert): deleted `.agent/rules/00-implementation-guardrails.md`, modified `pnpm-lock.yaml`, untracked `packages/engine/scripts/diagnoseInfeasible.ts` + `tools/bulletin-parser/validateCurated.ts`.
