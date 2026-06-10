# Deprecated / Decommission-Candidate Docs

This folder holds documentation for parts of the system that are **deprecated, dead, or superseded** — segregated from the live docs so readers aren't confused about what's actually in production.

> These docs are kept for reference (they accurately describe code that still exists in the repo). The code they describe is a **Phase F decommission candidate** in [`../improvement-plan.md`](../docs/improvement-plan.md) — i.e., slated for removal once its replacement is proven. Nothing here documents a current production code path.

| Doc | What it documents | Status / why it's here |
|---|---|---|
| [`plan_semester.md`](plan_semester.md) | The legacy single-term planner **tool** | ✅ **REMOVED (Phase F)** — `tools/planSemester.ts` deleted. Was unregistered since May 2026; superseded by `plan_forward_degree`. Doc retained as a historical record. |
| [`planner.md`](planner.md) | The legacy planner **subsystem** (`semesterPlanner`, `balancedSelector`, `priorityScorer`, `multiSemesterProjector`, `crossProgramPlanner`, `graduationRisk`, `enrollmentValidator`, `explorePlanner`, `transferPrepPlanner`) | Superseded by the live forward-schedule subsystem ([`../engine/forward-schedule.md`](../engine/forward-schedule.md)) but **still present** — Phase F removed the `plan_semester` *tool* + `planFeasibility` *verifier* (the agent-facing twins); the planner *library* modules are entangled (e.g. `explorePlanner`/`transferPrepPlanner` import `semesterPlanner`) and their removal + the 9-file test surgery is a deferred follow-up. `graduationRisk` is independent and barrel-exported (kept). |
| [`plan-feasibility-verifier.md`](plan-feasibility-verifier.md) | The `planFeasibility` verifier (five hard-constraint checks on a planned term) | ✅ **REMOVED (Phase F)** — `verifiers/planFeasibility.ts` deleted (its only consumer was the removed `plan_semester` tool). Doc retained as a historical record. |
| [`transcript.md`](transcript.md) | The deterministic unofficial-**transcript** parser module (`lexer` / `parser` / `profileMapper` / `confirmationFlow` / `invariants`) | Dead / test-only. The unofficial-transcript upload path was removed in the DPR-only pivot; the live onboarding accepts only the Albert DPR. This engine module was never wired into the production transcript upload (which used a separate LLM parser that has also been removed). |

## Why these aren't just deleted yet

Per the [improvement plan](../docs/improvement-plan.md)'s **Phase F (strangler-fig)**: code is removed only after its replacement is live and validated, and each removal is its own small, reversible PR. **Done so far:** the `plan_semester` tool + `plan-feasibility-verifier` are now **deleted** (the agent-facing twins of `plan_forward_degree`). **Still deferred:** the planner *library* subsystem (entangled — `explorePlanner`/`transferPrepPlanner` import `semesterPlanner`; removal needs surgery across 9 mixed test files) and the orphaned engine `transcript/` module (~6 mixed eval-test files). These docs are retained as historical records for the removed/soon-to-be-removed code.

## What is **not** deprecated (kept in the live docs on purpose)

For clarity: the live planning system is the **forward-schedule subsystem** ([`../engine/forward-schedule.md`](../engine/forward-schedule.md)); the live transcript-of-record is the **DPR** ([`../engine/dpr.md`](../engine/dpr.md)). The `prereqs`/`prereqGraph`, `gpaCalculator.computePoolGpa`, and the per-school registration constants are all still load-bearing and stay in the live docs.
