# Fix: `findDiverseValidPlans` re-searches to the full budget (perf) — small follow-on

> **For the agent who implemented the solver tractability rebuild (PR #38).** You have full context on `search.ts` / `solver.ts`. This is one focused, self-contained fix surfaced by post-merge verification. Small enough to implement directly with TDD + a self-review (no multi-agent ceremony needed). Base: `main` (8e641de0). Branch off `main`.

## The bug (measured, not theoretical)
`findDiverseValidPlans` (`search.ts:837-851`) loops up to `k` times, each calling `findFirstValidPlan` with a growing `forbidden` signature set, breaking when an iteration returns `plan === null`. Its docstring claims **"O(k × first-plan-cost), not O(full-space)"** — that is **false**: to return `null`, the terminal iteration must run `runSearch` to **exhaustion or the 200k `DEFAULT_MAX_NODES` budget** (it can't know "no more distinct plans" without searching the space). So whenever fewer than `k` distinct plans exist, the *last* iteration is a full-space search.

It runs on **every** production plan generation (`solver.ts:394`, and thus `build.ts`, `proposePlanChange.ts`, `confirmPlanChange.ts`, the relax-variant in `alternatives.ts`). Independently measured:
- Realistic 16-req / 8-term / 2-pool plan: **~70ms** (fine).
- Zero-slack near-graduate prereq chain (exactly fills the horizon → ~1 distinct plan): **~1.9s** (the terminal iteration burns 200,001 nodes proving null).
- ~30-req oversized input: **~28s** (`findDiverseValidPlans` ≈ 88% of wall-clock).

The **winner is unaffected** — it comes from `findFirstValidPlan` with the full budget (`solver.ts:337`); only the *alternatives* generator is slow. So this is an edge-case latency regression (not a correctness bug, not on the realistic path), but it's on every solve.

## The fix
Cap each diverse iteration's node budget to a small value so the terminal "no-more-distinct-plans" iteration gives up fast. Alternatives are **best-effort** — returning fewer than `k` when additional distinct plans are expensive to find is acceptable; the winner is always found separately with the full budget.

**`search.ts`:**
1. Add a constant near `DEFAULT_MAX_NODES` (`search.ts:141`):
   ```ts
   /** Per-iteration node cap for findDiverseValidPlans. Alternatives are best-effort:
    *  the terminal "no more distinct plans" iteration must search to prove null, so we
    *  bound it well below DEFAULT_MAX_NODES. The WINNER is found separately by
    *  findFirstValidPlan with the full budget (solver.ts) and is NOT affected. */
   const DIVERSE_MAX_NODES = 20_000;
   ```
2. In `findDiverseValidPlans` (`search.ts:845`), pass the cap to each call (caller may still override via `options.maxNodes`):
   ```ts
   const res = findFirstValidPlan(ctx, {
       ...options,
       forbiddenSignatures: forbidden,
       maxNodes: options?.maxNodes ?? DIVERSE_MAX_NODES,
   });
   ```
3. Replace the **false** docstring (`search.ts:825-835`): state that each iteration is **node-capped** (`DIVERSE_MAX_NODES`); the result is best-effort and **may return fewer than `k`** distinct plans when additional ones exceed the per-iteration budget; `plans[0]` is still `findFirstValidPlan`'s first plan; the winner used by the solver is computed separately with the full budget and is unaffected.

> Do NOT change `findFirstValidPlan` / `searchBestPlan` / `searchTopKPlans` behavior, the winner, or the validator. Only `findDiverseValidPlans` + the new constant + the docstring change.

## TDD (write tests first; all deterministic — no wall-clock assertions)
New file `packages/engine/tests/forwardSchedule/diversePerf.test.ts` (mirror the `makeInput`/`makeMinimalDpr`/`placed` patterns in `search.test.ts` / `diversePlans.test.ts`).

1. **Terminal iteration is capped (the core fix).** Build a tightly-constrained `ConstraintContext` with **exactly one** valid plan (e.g. a forced prereq chain that exactly fills the horizon — reuse the zero-slack fixture style from `relaxAddTerm.test.ts`/your T2b fixtures). Let `winnerSig = reqSignature(findFirstValidPlan(ctx).plan!)`. Assert:
   - `findFirstValidPlan(ctx, { forbiddenSignatures: new Set([winnerSig]), maxNodes: 20_000 }).nodesExplored <= 20_000` **and** `.exhaustive === false` (truncated at the cap — proving it no longer runs to 200k). *(Before the fix this iteration explores ~200,001 nodes.)*
   - `findDiverseValidPlans(ctx, { k: 5 }).length === 1` (returns just the winner; no hang).
2. **No regression when distinct plans are cheap.** Build a context with ≥3 cheap distinct valid plans (e.g. 3 independent requirements each with 2 interchangeable candidates over 2 terms). Assert `findDiverseValidPlans(ctx, { k: 5 })` returns ≥3 plans, pairwise-distinct by `reqSignature`, and `plans[0]` equals `findFirstValidPlan(ctx).plan` (same first plan).
3. **Winner unaffected end-to-end.** On the zero-slack input, `solveForwardSchedule(input)` returns the same valid winner + `feasible === true` as before (the cap never touches the winner search). Assert feasible + the winner's placements.

Steps: write the tests → run (test 1's first assertion FAILS pre-fix: nodesExplored ≈ 200_001) → apply the fix → run (PASS) → full suite `pnpm exec vitest run` green → `pnpm exec tsc -p packages/engine/tsconfig.json --noEmit` clean → 0 shadows → scoped commit.

## Exit criteria
The zero-slack and oversized inputs no longer spend seconds in `findDiverseValidPlans` (terminal iteration bounded to `DIVERSE_MAX_NODES`); realistic inputs still return multiple distinct alternatives; the winner + `feasible`/validator result are unchanged; full suite green (was 1646/9); 3× `--noEmit` clean; 0 shadows.

## Infra reminders (you know these)
`--noEmit` typecheck only (NEVER `tsc -b` — re-emits `.js` shadows). Scoped commit (`git add <files>`, never `git add -A`; leave the pre-existing leftovers). Commit trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Don't push/merge unless the owner asks.

## Optional (note only — NOT required; surface to the owner if you want to do more)
- **Skip diverse on edit paths:** `propose`/`confirm` may not need top-K alternatives at all — gating `findDiverseValidPlans` to the initial-build path would remove the cost there entirely. Owner decision.
- **Perturbation diversifier:** a future cheaper alternative-generator could derive diverse plans by perturbing the winner (swap a few placements via the `localImprove` move set) instead of re-searching with forbidden signatures — O(moves), no full-space risk. Bigger change; not needed for this fix.

## Do NOT (guardrails specific to this change)
- Don't re-flag pool overlap / double-counting as a validity bug — one course counting toward two requirements is **policy-legal up to a per-program limit** the engine deliberately defers to RAG/DPR (see memory `nyupath_planning_foundation_execution.md`, 2026-06-07 note). This fix is purely about the diverse-search node budget, not the validator.
