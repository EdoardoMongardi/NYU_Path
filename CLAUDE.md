# NYU Path — agent instructions

## Read this first (binding)

**Before ANY work on this repo — planning, editing, building, reviewing, answering — read [`Docs/core_philosophy.md`](Docs/core_philosophy.md).** It is the project's binding north-star and every decision here serves it. In one breath: the agent must behave like a **professional human academic adviser for ALL NYU undergrad** (including NYU Shanghai + NYU Abu Dhabi — never CAS-only); course plans are **deterministic on validity, then preferred**; any conclusion that is not ~99% grounded/computed carries a **confidence level + "verify with your adviser,"** and the agent **never invents a fact or ships an invalid plan**; identify risk / state trade-offs on both agent- and student-proposed decisions.

**Philosophy point #6 (doc discipline — binding):** every plan + audit file goes in its correct `Docs/` slot, and **after each verified-and-confirmed phase implementation, revise the matching `Docs/current-system/` doc** so the docs stay in sync with the code.

## Where things are

- All documentation lives under [`Docs/`](Docs/) — start at [`Docs/README.md`](Docs/README.md).
  - `Docs/STATUS.md` — **rolling current status** (this file keeps only the pointer below; update it after each verified phase).
  - `Docs/index.json` — **machine-readable retrieval index**: concept → spec → implementation → tests, path-verified. Query it (grep/jq) before deep-diving code or running an audit.
  - `Docs/FROZEN.md` — the **frozen engine contract + R1 guardrail manifest**: the exact files/symbols that must never change and the tests that guard them.
  - `Docs/current-system/` — how the system works **today** (`engine/` · `tools/` · `web/` · `surrounding/`), kept in sync with code.
  - `Docs/specs/2026-06-05-planning-engine-rebuild-design.md` — the canonical architecture.
  - `Docs/plans/` — implementation plans in planned order. **Latest implemented:** `38-…-fose-section-scheduling-replan.md` (😴 DORMANT — see [`Docs/STATUS.md`](Docs/STATUS.md)). Prior: `35`/`36`/`37`, `33`/`34`.
  - `Docs/audits/` · `Docs/reports/` · `Docs/reference/` · `Docs/deprecated/`.
- Code: `apps/web` (Next.js), `packages/engine` (agent loop + 24 tools + constraint-search planner + 8-axis validator), `packages/shared`, `data/`, `tools/`, `evals/`.

## Current status

**Full detail: [`Docs/STATUS.md`](Docs/STATUS.md)** (update it after each verified phase — philosophy #6). In one breath: planning-engine **Phases 0–4 are DONE + merged** (feasibility-first constraint search + the graduation-path validator + the tool suite + the advisor layer + the experience/continuity layer). **Plans 35 / 36 / 37** (what-if taxonomy + W/pass-fail modeling · scenarios workspace UI · slot-editor + per-school P/F validator axis) are **DONE + on `origin/main` `32cf861`**. **Plan 38 — FOSE section-scheduling** is implemented + merged to **LOCAL** `main` `c667262` but **😴 DORMANT** (parked 2026-06-21; NOT pushed to `origin`), blocked on an official NYU live-enrollment API — **no further FOSE work until it lands**. The **frozen engine contract** and the **R1 guardrail** are intact throughout — manifest: [`Docs/FROZEN.md`](Docs/FROZEN.md).

## Conventions

- **The working code is the source of truth** — never trust a stale comment or doc over the implementation.
- **Verify before claiming done:** `cd packages/engine && npx tsc --noEmit`; `cd apps/web && npx tsc --noEmit`; `npx vitest run` (repo root). Never `tsc -b` (it emits `.js` shadows vitest then runs instead of the `.ts`).
- **Git:** branch → PR → merge; stage selectively (**never `git add -A`**); end commit messages with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Model:** default primary `claude-sonnet-4-6` (override `NYUPATH_PRIMARY_MODEL`); fallback `gpt-4.1-mini`.
- **Leave the pre-existing working-tree leftovers untouched** (do not stage/revert): deleted `.agent/rules/00-implementation-guardrails.md`, modified `pnpm-lock.yaml`, untracked `packages/engine/scripts/diagnoseInfeasible.ts` + `tools/bulletin-parser/validateCurated.ts`.
- **Dispatching agents/workflows (large-repo discipline):** pin every subagent to the absolute path `/Users/edoardomongardi/Desktop/Ideas/NYU_Path` (the underscore clone — there is a stale space-named clone). Hand it a curated **context packet** (the 3–5 authoritative files for its task) and tell it to **cite the governing doc/§ or report a spec gap — never infer behavior**. Have it return a tight structured result, or write a report under `Docs/reports/` and return only the path — never raw dumps. For a broad audit/retrieval over the ~150k-LOC tree, use a **fan-out → adversarial-verify workflow** (one agent per subsystem, then a skeptic per finding) scoped via `Docs/index.json`, not one long session — keep the orchestrator holding pointers, not file contents.
