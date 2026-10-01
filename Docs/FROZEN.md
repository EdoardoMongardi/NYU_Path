# FROZEN — the engine contract & R1 guardrail manifest

The single place that names **what must never change** and **the tests that guard it**. Two invariants recur in nearly every plan and commit ("frozen contract intact", "R1 intact"); this file makes them a lookup instead of tribal knowledge.

- **Frozen engine contract** — every schedule-producing path must build and validate through the *same* seam (`buildSolverInput → solveForwardSchedule → finalizeForwardSchedule` + the 8-axis validator). New features (what-if, FOSE section-replan, plan-change) re-use it; they never fork or bypass it.
- **R1 guardrail** — the authoritative `students.parsed_dpr` is *never* overwritten by a hypothetical/synthetic DPR. A what-if confirm persists **only** the `forward_schedule`.

**How to use this file:** before touching anything listed here, stop — a change to a frozen symbol is an architecture decision, not a routine edit. If a task seems to require changing one, escalate to the owner and state the trade-off. The working code is the source of truth; `file:line` anchors are point-in-time (generated 2026-06-26, grep-verified) — re-confirm before relying on a line number.

---

## Frozen engine contract

### 1. `finalizeForwardSchedule` — the one finalize seam
**Rule:** every schedule-producing path (build, alternatives, what-if, propose/confirm plan-change, and the FOSE section-replan bridge) MUST assemble its `ForwardSchedule` and derive its authoritative state through this single seam — it runs `runGraduationPathValidator` and returns the validator-derived state. Its signature/behavior must never be forked or bypassed.
**Defined:** `packages/engine/src/agent/forwardSchedule/build.ts:64`
**Call sites (all must route through it):** `build.ts:203`, `build.ts:228`, `forwardSchedule/alternatives.ts:176`, `forwardSchedule/whatIfAssumption.ts:127`, `agent/tools/proposePlanChange.ts:171`, `agent/tools/confirmPlanChange.ts:211`, `agent/sectionMaterialization/sectionReplanBridge.ts:287`
**Guard tests:** `packages/engine/tests/agent/tools/proposeWhatIfAssumption.test.ts` (READ-ONLY / byte-identical), `packages/engine/tests/agent/sectionReplanBridge.test.ts` (bridge re-solves through the frozen seam)
**Note:** the 5th param `passFailConfig` is additive/optional (Plan 37, 8th axis) so the two legacy 4-arg callers still compile. Internal — not re-exported from the engine barrel.

### 2. `runGraduationPathValidator` — the 8-axis validator (the single definition of "valid")
**Rule:** validity is defined by exactly these **8 axes**; `feasible === (no axis has status 'fail')`. The axis set and the fail-only rule must never change, and no path may declare a plan valid without passing all 8.
**The 8 axes** (`graduationPathValidator.ts:51-59`, confirmed verbatim): `requirementGroupsSatisfied`, `poolSlotsResolvable`, `totalCreditsMeetMinimum`, `thresholdsMet`, `visaAxesPass`, `assumptionsExplicit`, `graduationTargetMet`, `passFailLimitsRespected`.
**Defined:** `packages/engine/src/agent/forwardSchedule/graduationPathValidator.ts:608` (axis union at `:51`)
**Guard tests:** `packages/engine/tests/agent/resolvablePlaceholders.test.ts` (poolSlotsResolvable), `packages/engine/tests/agent/optionalJTermValid.test.ts` (graduation-target/validity); per-axis coverage is spread across `tests/agent/*` validator suites.
**Note:** resolves the historical "7 or 8 axes" ambiguity — it is **8** (the 8th, `passFailLimitsRespected`, landed in Plan 37, impl `forwardSchedule/passFailLimitAxis.ts`). ⚑ Gap worth closing: there is no single "all-8-axes" test asserting the complete axis set.

### 3. `solveForwardSchedule` — the feasibility-first solver entrypoint
**Rule:** the constraint-search planner has exactly one entrypoint (`solveForwardSchedule`, feasibility-first via `findFirstValidPlan`); every plan/re-plan path MUST go through it (then `finalizeForwardSchedule`), and no path may build a schedule by a different search.
**Defined:** `packages/engine/src/agent/forwardSchedule/solver.ts:190`
**Call sites:** `build.ts:190`, `build.ts:227`, `alternatives.ts:56/75/95`, `whatIfAssumption.ts:119`, `tools/proposePlanChange.ts:162`, `tools/confirmPlanChange.ts:188`, `sectionMaterialization/sectionReplanBridge.ts:286`
**Guard tests:** `packages/engine/tests/agent/sectionReplanBridge.test.ts`, `packages/engine/tests/agent/tools/proposeWhatIfAssumption.test.ts`
**Note:** feasibility-first — returns the FIRST valid leaf (best-effort, does not prove global optimum). All 9 call sites grep-confirmed; each pairs with a `finalizeForwardSchedule` call.

### 4. Frozen-seam / R1-intact assertion tests
**Rule:** the what-if and FOSE-section-replan features MUST re-use the SAME frozen pipeline and must not fork it; these tests assert each feature re-solves through the frozen seam and persists only the schedule.
**Tests:** `apps/web/tests/whatIfAssumptionOrchestrator.test.ts` (header `:13` "frozen pipeline … persists ONLY the resulting forward_schedule"; `:17` "THE R1 GUARD TEST (launch gate)"), `packages/engine/tests/agent/sectionReplanBridge.test.ts:8` ("A3 re-solves through the frozen seam"), `packages/engine/tests/agent/tools/proposeWhatIfAssumption.test.ts:9`, `packages/engine/tests/agent/tools/probeCounterfactual.test.ts:445`

---

## R1 guardrail (DPR snapshot integrity)

### 5. `assertAuthoritativeDpr` — the persist chokepoint
**Rule:** only a DPR with `reportKind === "dpr"` may ever be written to `students.parsed_dpr`; any what-if / synthetic / assumption-transform DPR (`reportKind !== "dpr"`) MUST throw at the persist chokepoint and never overwrite the authoritative snapshot.
**Defined (canonical, engine):** `packages/engine/src/persistence/profileStore.ts:27` (throws `[snapshot-integrity] refusing to persist a non-authoritative … DPR`); enforced at the `InMemoryProfileStore.persistMutation` chokepoint `profileStore.ts:100`; re-exported from the barrel `packages/engine/src/index.ts:308`; web copy `apps/web/lib/db/assertAuthoritativeDpr.ts:18`
**Guard tests:** `apps/web/tests/snapshotIntegrityGuard.test.ts` ("passes silently for reportKind dpr" `:72`, "throws for reportKind what_if" `:77`; persistMutation throws + stores nothing `:101`), `apps/web/tests/whatIfAssumptionOrchestrator.test.ts:401`

### 6. Byte-identity tests — `parsed_dpr` unchanged after a what-if confirm
**Rule:** after a what-if assumption is CONFIRMED, `students.parsed_dpr` must be byte-identical to before (`JSON.stringify(after) === JSON.stringify(before)`) and still `reportKind === "dpr"`; only the `forward_schedule` may be persisted.
**Tests (three layers, all grep-confirmed):** `apps/web/tests/whatIfAssumptionOrchestrator.test.ts:362/386` ("persists the resulting forward_schedule AND leaves parsed_dpr BYTE-IDENTICAL"), `apps/web/tests/planWhatIfRoute.test.ts:332/352`, `packages/engine/tests/agent/tools/proposeWhatIfAssumption.test.ts:354`

---

## Deferred seam (extension point — NOT yet active)

### 7. `materializeSections` `swapHook` — the deferred structural-swap hook
**Kind:** seam (future extension point, **wired as a no-op today**).
**Rule:** the structural-swap cascade hook is the designated future extension point for section-driven course swaps; today it is a no-op (`async () => null`) at every production call site so materialization stays strictly read-only and surfaces wipes via the orchestrator's `dropped` array.
**Anchors:** type declared `materialize.ts:78`, invoked `materialize.ts:350` (`const altId = await swapHook(...)`), stub `tools/materializeSections.ts:201` (`… = async () => null;` — confirmed intact after FOSE plan 38), also `materialize.ts:235`, `apps/web/app/api/plan/stage2/route.ts:237`
**Guard tests:** `apps/web/tests/materializeFeasibleStage.test.ts`, `apps/web/tests/sectionReplanStage.test.ts`
**Note:** this is the seam a future live-seat-status `SeatStatusProvider` plugs behind when FOSE resumes (see `Docs/STATUS.md`) — no engine rework required.

---

_Generated 2026-06-26 by a path-/grep-verified fan-out audit. Regenerate after any change that touches the schedule pipeline, validator, or persistence chokepoint._
