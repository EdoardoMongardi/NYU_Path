# NYU Path — Documentation

All project documentation lives in this folder. Organized 2026-06-10 (full repo audit + consolidation).
**Start here:** [`core_philosophy.md`](core_philosophy.md) — the project north-star (what the agent must be, "deterministic on validity then preferred", DPR-first, all NYU undergrad). Read it before anything else; it is the standard every other doc serves.
**Then, reading order for a newcomer:** `current-system/00-overview.md` → `specs/2026-06-05-planning-engine-rebuild-design.md` → `current-system/engine/forward-schedule.md`.
**Fast retrieval / navigation:** [`index.json`](index.json) — machine-readable concept → spec → implementation → tests crosswalk (query with jq/grep to scope an audit or locate code before deep-diving); [`FROZEN.md`](FROZEN.md) — the frozen engine contract + R1 guardrail manifest (what must never change + its guard tests); [`STATUS.md`](STATUS.md) — rolling current status; [`GLOSSARY.md`](GLOSSARY.md) — one-line definitions of the in-house jargon.

| Folder | What it holds | Ordering |
|---|---|---|
| [`current-system/`](current-system/) | How the system works **today** (kept in sync with code; revised against the working code, not comments) | by area: `engine/`, `tools/`, `web/`, `surrounding/` |
| [`specs/`](specs/) | Design documents | date prefix (creation) |
| [`plans/`](plans/) | Implementation plans, **all executed/historical** | `NN-` prefix = the order the work was planned |
| [`audits/`](audits/) | Point-in-time audits, QA reports, adversarial spot-checks | date prefix (creation) |
| [`reports/`](reports/) | Eval / benchmark / calibration run reports | date prefix (run date) |
| [`reference/`](reference/) | Reference (privacy/data-handling, undergrad schools, eval-set provenance, prereq sources) | n/a |
| [`mockups/`](mockups/) | HTML / visual mockups referenced by plans (e.g. the scenarios-workspace UI) | n/a |
| [`deprecated/`](deprecated/) | Docs for **removed** code, kept for history — do not trust as current | n/a |

## Living docs vs point-in-time records

Docs fall into two kinds, updated differently — this split is what prevents cross-doc reference drift:

- **Living docs** — describe the system **today**; kept in sync with code (per [`../CLAUDE.md`](../CLAUDE.md) §4.1, with greppable counts guarded by `packages/engine/tests/agent/docConsistency.test.ts`): [`core_philosophy.md`](core_philosophy.md), [`STATUS.md`](STATUS.md), [`FROZEN.md`](FROZEN.md), [`GLOSSARY.md`](GLOSSARY.md), [`index.json`](index.json), everything under [`current-system/`](current-system/), plus the repo-root `README.md` and `CLAUDE.md`. **When a fact changes, grep these for the old value and reconcile every hit** — `bash tools/check-living-docs.sh '<term>'`.
- **Point-in-time records** — dated snapshots, **never** retro-edited: [`plans/`](plans/), [`audits/`](audits/), [`reports/`](reports/), [`deprecated/`](deprecated/), [`specs/`](specs/). A June plan's now-stale counts are correct history — leave it.

## current-system/ — the living docs

- `00-overview.md` — plain-English tour of the whole product.
- `engine/` — one doc per engine subsystem (`packages/engine`): agent loop, system prompt, response validator, tool registry, DPR parser, **forward-schedule (the constraint-search planner)**, RAG, persistence, …
- `tools/` — one doc per live agent tool (22 registered in `packages/engine/src/agent/registry.ts`; the 1:1 doc↔registry match is guarded by `packages/engine/tests/agent/frozenContractManifest.test.ts`).
- `web/` — the Next.js app (`apps/web`): chat route, plan-action routes, stores, UI.
- `surrounding/` — shared package, data directory, offline data pipeline.

These were first written 2026-06-03 (pre-rebuild) and are being revised against the post-rebuild code (planning-engine rebuild Phases 0–3, merged via PRs #35–#41 then #43–#48, June 5–10 2026). A doc's header notes its last code-verification date.

## plans/ — planned order (NN- prefix)

Two eras, numbered continuously:

1. **01–19 — phase-plan era (Apr 27 – May 4 2026):** Phase 7-E (DPR-first pivot) → 8 (cleanup + bake-off) → 9 (bulletin RAG) → 10 (posture architecture) → 11 (verification layer) → 12/12.5 (cheap wins, validator hardening) → status-UX + reasoning-stream plans → `10-PHASE_PLANS_README.md` (the 12.7→15 execution index + the canonical **46 locked design decisions**) → 12.7/12.8/12.9/12.95 (bulletin scrape→parse→embed→offering confidence) → 13 (forward planner v1) → 14 (preferences) → 15 (FOSE sections) → 16 (persistence; the number was reused after the original RMP Phase 16 was dropped) → 17 (plan-action routes).
2. **20–32 — rebuild era (June 2–10 2026):** `20-improvement-plan.md` (the post-audit roadmap, Phases A–F incl. the pure-RAG decommission) → SPS division router → **planning-engine rebuild**: foundation (Phase 0/1, PR #35) → phase-2 solver (PR #36) → solver tractability (PR #38) → diverse-plans perf (PR #40) → double-count advisory (PR #41) → **32 — Phase 3 advisor agent** (introspection/counterfactual tools, plan-claim validator, preference compiler, proactive elicitation; PRs #43–#48). Cut-maps and handoffs are filed next to their plan.
3. **33–38 — experience + what-if + sections era (June 15–21 2026):** 33/34 (Phase 4 experience & continuity) → 35 (what-if taxonomy + W/pass-fail modeling) → 36 (scenarios workspace UI) → 37 (slot-editor actions + the 8th P/F validator axis) — all on `origin/main` (`32cf861`) → **38 (FOSE section-scheduling — ✅ built + merged to LOCAL `main` `c667262`, then ❌ DROPPED from the live agent 2026-07-14: the two FOSE tools unregistered + their prompt routing removed, registry 24→22; code kept but disconnected; NOT pushed to `origin`).** See `CLAUDE.md` Current status for the rationale.

**Most plans here have been executed and merged** (38 is on *local* `main` only, then DROPPED from the live agent 2026-07-14 — see its Status banner). They are historical records; the code has since drifted from some of their details — never treat a plan as a description of the present system.

## audits/ — creation order (date prefix)

- `2026-05-03-PHASE_12_8_*` — bulletin-parse data-quality issues + 30/30 manual QA sample.
- `2026-06-04-schoolconfig-spotcheck/` — adversarial per-school verification of all 11 `data/schools/*.json` configs against live bulletins (drove the NYUAD/SPS/Gallatin corrections).
- `2026-06-05-AUDIT_FINDINGS.md` — the consolidated code-truth issue audit (CAS-coupling, divergent pipelines, solver gaps) that motivated the planning-engine rebuild design.

## specs/

- `2026-03-04-validation_spec.md` — v0.1 validation spec (historical).
- `2026-04-ARCHITECTURE.md` — v3.2 agent architecture (envelope/posture era; partially superseded).
- `2026-06-04-loadcourses-full-catalog-design.md` — full undergrad catalog for the solver (Step 8d).
- `2026-06-05-planning-engine-rebuild-design.md` — **the canonical rebuild design** (6 layers, Phases 0–5). Phases 0–3 are implemented (Phase 3 — the advisor agent: introspection + counterfactual tools, response-validator plan-claim check, preference compiler, proactive elicitation — merged via PRs #43–#48); §7.2's branch-and-bound search was superseded in implementation by feasibility-first search + local improvement (PR #38).
- `2026-06-05-sps-division-router-design.md` — SPS division-aware credit caps.

## Deliberately *not* in this folder

- `README.md` at repo root and per-package READMEs (`packages/engine`, `apps/web`, `packages/engine/tests/eval/profiles`) — conventional entry points, left in place.
- `tools/cohort-eval/results/*.md` — gitignored local-only eval transcripts (PII-sensitive surrogate runs).
- `.superpowers/` — gitignored brainstorm visual mockups for the rebuild design.
- `.claude/scratch/` — session scratch notes.
