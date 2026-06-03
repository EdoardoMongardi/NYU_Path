# Deprecated / Decommission-Candidate Docs

This folder holds documentation for parts of the system that are **deprecated, dead, or superseded** — segregated from the live docs so readers aren't confused about what's actually in production.

> These docs are kept for reference (they accurately describe code that still exists in the repo). The code they describe is a **Phase F decommission candidate** in [`../improvement-plan.md`](../improvement-plan.md) — i.e., slated for removal once its replacement is proven. Nothing here documents a current production code path.

| Doc | What it documents | Status / why it's here |
|---|---|---|
| [`plan_semester.md`](plan_semester.md) | The legacy single-term planner **tool** | Deprecated (May 2026); **not registered** in `ALL_NYUPATH_TOOLS`, so the agent can never call it. Superseded by `plan_forward_degree`. |
| [`planner.md`](planner.md) | The legacy planner **subsystem** (`semesterPlanner`, `balancedSelector`, `priorityScorer`, `multiSemesterProjector`, `crossProgramPlanner`, `graduationRisk`, `enrollmentValidator`, `explorePlanner`, `transferPrepPlanner`) | Fully superseded by the live forward-schedule subsystem ([`../engine/forward-schedule.md`](../engine/forward-schedule.md)). Verified: its only consumers are the package barrel export and the deprecated `plan_semester` tool — the live planner does **not** import from it. |
| [`plan-feasibility-verifier.md`](plan-feasibility-verifier.md) | The `planFeasibility` verifier (five hard-constraint checks on a planned term) | Its only consumer was the deprecated `plan_semester` tool — no live consumer today. |
| [`transcript.md`](transcript.md) | The deterministic unofficial-**transcript** parser module (`lexer` / `parser` / `profileMapper` / `confirmationFlow` / `invariants`) | Dead / test-only. The unofficial-transcript upload path was removed in the DPR-only pivot; the live onboarding accepts only the Albert DPR. This engine module was never wired into the production transcript upload (which used a separate LLM parser that has also been removed). |

## Why these aren't just deleted yet

Per the [improvement plan](../improvement-plan.md)'s **Phase F (strangler-fig)**: code is removed only after its replacement is live and validated, and each removal is its own small, reversible PR. The `plan_semester`/`planner`/`plan-feasibility-verifier` and the orphaned `transcript/` module are the lowest-risk removals (already dead / unregistered), but deleting the engine `transcript/` module requires surgery across ~6 mixed eval-test files, so it's deferred to that phase.

## What is **not** deprecated (kept in the live docs on purpose)

For clarity: the live planning system is the **forward-schedule subsystem** ([`../engine/forward-schedule.md`](../engine/forward-schedule.md)); the live transcript-of-record is the **DPR** ([`../engine/dpr.md`](../engine/dpr.md)). The `prereqs`/`prereqGraph`, `gpaCalculator.computePoolGpa`, and the per-school registration constants are all still load-bearing and stay in the live docs.
