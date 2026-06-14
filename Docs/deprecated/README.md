# Deprecated Docs — index of REMOVED code

> Last verified against code: 2026-06-10 (post planning-engine rebuild, PRs #35-#41).

## Purpose

Every doc in this folder describes code that **no longer exists in the repository.** These modules and agent tools were deleted during the Step 8 decommission (rule engine + curated layers, June 4-5 2026) and the subsequent planning-engine rebuild (Phases 0-2, PRs #35-#41, June 5-7). The docs are kept only as a historical record of how the old system worked — useful when reading old commits or git blame, but **not** a description of anything running today.

If you are looking for the live system instead:

- **Planning / scheduling** — the forward-schedule subsystem: [`../current-system/engine/forward-schedule.md`](../current-system/engine/forward-schedule.md). The greedy single-term planner this folder documents is gone; planning is now feasibility-first backtracking search (`solveForwardSchedule` → `buildConstraintContext` → `findFirstValidPlan` → `localImprove` → `materializePlan`) gated by the 7-axis `runGraduationPathValidator`.
- **Student record of truth** — the DPR: [`../current-system/engine/dpr.md`](../current-system/engine/dpr.md). The unofficial-transcript upload path is gone; onboarding accepts only the Albert Degree Progress Report (DPR).
- **Live agent tools** — the tool registry (21 live tools): [`../current-system/engine/tool-registry.md`](../current-system/engine/tool-registry.md).
- **Policy / requirements answers** — pure bulletin RAG: [`../current-system/engine/rag.md`](../current-system/engine/rag.md). The curated/template policy layer this folder documents is gone.

Where a removed module's *functionality* survived in a new place, the table below names that successor.

## Removal context

Two waves of deletion produced everything in this folder:

1. **Step 8 decommission (June 4-5 2026)** — tore out the authored rule engine, the curated policy/template layers, the dead planner library, the standalone graph/equivalence/transcript modules, and the per-major JSON. After this wave the engine is **pure DPR + RAG**: the DPR is the authoritative tier-1 record, the bulletin RAG is the cited/hedged tier-2 source, and personalized tools hard-refuse when no DPR is loaded.
2. **Planning-engine rebuild (PRs #35-#41, June 5-7 2026)** — replaced the greedy planner with the feasibility-first forward-schedule solver and the 7-axis graduation validator. (This wave didn't remove the modules below — Step 8 already had — but it is why the *replacement* described in the live docs looks nothing like the old planner.)

## The 12 docs in this folder

| Doc | What the module was | Removed when / why | Removal commit(s) |
|---|---|---|---|
| [`README.md`](README.md) | This index. | — | — |
| [`plan_semester.md`](plan_semester.md) | The legacy single-term planner **tool** — recommended courses for the immediate next term only; wrote no schedule. | Unregistered since May 2026; superseded by the `plan_forward_degree` tool (full remaining-degree horizon). First removed in the Phase F pilot deletion. | `c31560a0` (2026-06-03) deleted the tool + its `planFeasibility` verifier. |
| [`plan-feasibility-verifier.md`](plan-feasibility-verifier.md) | The `planFeasibility` verifier — five hard-constraint checks on one planned term. | Its only consumer was the `plan_semester` tool, so it died with it. Live constraint-checking is now the 7-axis `runGraduationPathValidator` (see [`../current-system/engine/forward-schedule.md`](../current-system/engine/forward-schedule.md)). | `c31560a0` (2026-06-03), same commit as `plan_semester`. |
| [`planner.md`](planner.md) | The legacy planner **library** (`semesterPlanner`, `balancedSelector`, `priorityScorer`, `multiSemesterProjector`, `crossProgramPlanner`, `enrollmentValidator`, `explorePlanner`, `transferPrepPlanner`, `graduationRisk`). The greedy "what to take next term" recommender. | Fully deleted across three commits; the whole `packages/engine/src/planner/` directory is gone (verified absent on 2026-06-10). Superseded by the forward-schedule solver. **Note:** the old README claimed this library was "still present" and entangled, with `graduationRisk` "kept" — that is no longer true; everything was removed. | Bulk of the library in `51a03d3e` (2026-06-04, Step 8b); `transferPrepPlanner.ts` earlier in `8d055127` (2026-06-04); `graduationRisk.ts` (retained at 8b) finally in `605978af` (2026-06-05). |
| [`check_overlap.md`](check_overlap.md) | The authored `check_overlap` agent tool + `crossProgramAudit` engine — detected double-counting across programs from hand-authored rules. | Removed when double-counting moved to DPR + RAG (the DPR shows what counts where; RAG cites the bulletin policy). The tool is no longer in the registry. | `dc4a2674` (2026-06-04). |
| [`check_transfer_eligibility.md`](check_transfer_eligibility.md) | The authored `check_transfer_eligibility` agent tool + audit engine — judged internal NYU school-to-school transfer from hand-authored criteria. | Removed when internal-transfer answers moved to pure RAG. The tool is no longer in the registry. | `8d055127` (2026-06-04). |
| [`cli.md`](cli.md) | `apps/cli` — a 192-line command-line wrapper around `degreeAudit` + `planNextSemester` for poking at the rule engine without the web app. | Deleted with the rule engine + planner it wrapped, in Step 8b. The `apps/` directory now contains only `web/` (verified on 2026-06-10). | `51a03d3e` (2026-06-04). |
| [`citation-labels.md`](citation-labels.md) | `agent/citationLabels.ts` — built short human labels for cited sources. | Verified-dead (no live importer); deleted in the Step-8 dead-source sweep. | `605978af` (2026-06-05). |
| [`equivalence.md`](equivalence.md) | `equivalence/equivalenceResolver.ts` — cross-listing / mutually-exclusive course resolution and canonical-name picking. | Verified-dead; deleted in the dead-source sweep. The surviving sliver of this functionality is `canonicalizeCourseId` / `canonicalizeCourseIdSet` in `packages/engine/src/courseId.ts` (still live). | `605978af` (2026-06-05). |
| [`graph.md`](graph.md) | `graph/prereqGraph.ts` — the in-memory prerequisite graph (eligibility, "doors unlocked", cycle detection). | Verified-dead; deleted in the dead-source sweep. Live prerequisite checking now lives in `packages/engine/src/dpr/prereqSatisfaction.ts` (`isPrereqSatisfied`), which works against the DPR rather than a standalone graph. | `605978af` (2026-06-05). |
| [`template-matcher.md`](template-matcher.md) | `agent/templateMatcher.ts` + `rag/policyTemplate.ts` — pre-loop dispatch that matched a query to a curated policy template. | Removed when the curated policy layers were torn out and `search_policy` became pure RAG. | `8cb21774` (2026-06-04). |
| [`transcript.md`](transcript.md) | The deterministic unofficial-transcript parser (`lexer` / `parser` / `profileMapper` / `confirmationFlow` / `invariants`). Engine-side; **never wired into production** (the live web app used a separate LLM parser, also now removed). | Deleted in the dead-source sweep when the unofficial-transcript upload path was removed product-wide. Onboarding is DPR-only. | `605978af` (2026-06-05). |

## Other Step-8 removals (not separately documented here)

For completeness, the same wave also deleted, with no dedicated deprecated doc: the `search/availabilityPredictor.ts` module and the `agent/recorderClient.ts` (both in `605978af`); the legacy tool barrel + dead exports (`f3fdc2a9`); and the per-major `programs.json` + dead fact-resolution layer (`f14549f8`). All on 2026-06-05.

## Known limitations of these docs

- Each doc below this README still contains its **original 2026-06-03 prose**, describing code as if it were live. Only a one-line `> DEPRECATED …` banner has been added at the top of each. Do not read the body as current behavior — it is preserved verbatim for historical accuracy.
- Removal-commit hashes in the table were verified with `git log` on 2026-06-10. Hashes are short form and may need `--all` to resolve if branches have since been pruned.
