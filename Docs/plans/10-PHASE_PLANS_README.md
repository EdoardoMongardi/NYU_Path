# Phase Plans 12.7–15 — Execution Index

This index ties together the five planning documents that take NYU Path
from its current state (Phase 12.5 in production) through to a full
multi-semester forward planner with live FOSE section materialization.
Each plan is self-contained; this document is the orchestrator.

## Execution order (linear; do not skip)

1. **`PHASE_12_7_PLAN.md`** — Bulletin scrape extension to all 8 undergrad schools. Pure data; ~½–1 day. **No engine impact.** Output: `data/bulletin-raw/courses/<DEPT>_<SCHOOL>/<NUMBER>/index.md` for ~5,000–7,000 courses.
2. **`PHASE_12_8_PLAN.md`** — Bulletin parsing → structured `prereqs.json` + `courses-offerings.json`. Depends on 12.7. ~2 days. Validation gate: must match the 27 hand-curated entries already in `packages/engine/src/data/prereqs.json`.
3. **`PHASE_12_9_PLAN.md`** — Bulletin embeddings: rich course descriptions for `search_courses` (B) + non-CAS curriculum chunks for `search_policy` (C). Optional but recommended; can run in parallel with Phase 13. ~1 day.
4. **`PHASE_12_95_PLAN.md`** — Offering confidence enrichment (Decision #29). Classifies each course's historical FOSE termsOffered pattern into confidence tiers (`historically_likely` / `historically_partial` / `irregular` / `permission_only` / `restricted`). Phase 13's solver penalizes scheduling low-confidence offerings into critical-path slots. Pure data-prep, ~½–1 day. Must run before Phase 13.
5. **`PHASE_13_PLAN.md`** — Multi-semester forward planner with constraint solver + schedule sidebar UI + 3 reasoning-trace fixes + Decisions #27, #28, #30, #31, #32, #33, #34 (skeleton), #35, #36, #37 (solver-side placeholder semantics) + Decision #44 (top-K alternative-plan emission). Depends on 12.8 + 12.9.5. ~10–13 days (expanded from original 5–6 to absorb correctness/safety fixes from operator-review concerns).
6. **`PHASE_14_PLAN.md`** — Preferences + overrides (load styles, pins, exclusions, summer/J-term opt-in, alternatives, co-req enforcement) + LLM-extraction system prompt + Decisions #28 (pool-slot binding) and #37 (free-elective binding) student-facing tools (`bind_free_elective` + `bind_pool_slot`) + Decisions #42 (4-tier fallback hierarchy with HARD-FORBIDDEN Tier-D for hard constraints) + #44 (top-K comparison tool). Depends on 13. 11 tasks, ~7–9 days.
7. **`PHASE_15_PLAN.md`** — Live FOSE section materialization, time-conflict detection, conflict-free combination enumeration, instructor surfacing + Decision #34 online/in-person extension to `visaValidator` + Decision #43 (scheduling preferences). Depends on 13 (composes cleanly with 14). ~3–4 days. (Section-level Decision #44 extension is OPTIONAL stretch; not a Phase 15 acceptance gate.)

8. **`PHASE_15_5_PLAN.md` (DEFERRED — to be authored ONLY after Phase 15 ships and produces real production data; do NOT write this plan now).** MIP-solver migration: swap-internals-only replacement of `packages/engine/src/agent/forwardSchedule/solver.ts` with a MIP formulation (HiGHS-WASM is the leading candidate; final selection deferred to plan-authoring time). Preserves the `SolverInput → SolverOutput` contract; everything outside `solver.ts` (build.ts, reconcile.ts, all Phase-14/15 tools, all validators) stays unchanged. Trigger evidence to collect during Phase 14/15 production traffic: Decision #27 forward-feasibility false-positive/negative rate; Decision #41 graduationPathValidator rejection rate on heuristic outputs; Stage-7 full-revalidation latency on real plans; student-reported correctness gaps; infeasibility-report frequency. Plan to be authored once this evidence is in hand by a fresh agent. Estimate: ~3–5 days post-trigger; fully separate from the 12.7–15 plan scope. **Does NOT block the original execution path — Phases 13/14/15 ship on the heuristic solver, MIP migration is a post-ship internal upgrade.**

**Phase 16 (RateMyProfessor / instructor-rating overlay) is explicitly DROPPED.** Reasons documented in `PHASE_15_PLAN.md`. Instructor names are surfaced verbatim per section so the student picks based on their own preferences — no rating overlay.

## How to execute

Each plan declares its required sub-skill:
> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans

In a fresh session:

```
Working in /Users/edoardomongardi/Desktop/Ideas/NYU Path on branch
phase-10-architecture-and-followups. Read PHASE_<N>_PLAN.md in full.
Execute via superpowers:subagent-driven-development — fresh subagent
per task, two-stage review (spec then code-quality) after each.
```

The subagent-driven-development skill dispatches fresh subagents that read the plan directly, so cross-conversation context is not needed.

## Pre-flight verification (do this BEFORE any code change in any phase)

Before the first code-edit task in each phase, the executor MUST verify the repo's current shape matches the plan's assumptions. The plans assert specific field names that an investigation confirmed earlier. Repo state can drift; assertions can become stale. Verify:

| Assertion | Verify by |
|---|---|
| `packages/engine/src/data/prereqs.json` contains 27 hand-curated entries | `wc -l packages/engine/src/data/prereqs.json && jq 'length' packages/engine/src/data/prereqs.json` |
| `packages/engine/src/dpr/schema.ts` field names: `courseHistory`, `requirementGroups`, `creditsEarned` | Read the file end-to-end |
| `SchoolConfig` field name for graduation minimum (`graduationCreditMinimum` / `graduationMinimumCredits` / etc.) | `grep -n "graduation\|credit" packages/shared/src/types.ts` |
| `ToolInvocation` field shape for `summary` and `result` | Read `packages/engine/src/agent/agentLoop.ts` |
| Existing `searchAvailability` tool path (the registered one vs. the dead duplicate) | `grep -rn "searchAvailability" packages/engine/src/agent/registry.ts` |
| `LLMStreamEvent` union variants (post Phase 12.5: includes `thinking_delta`) | `grep -n "type:.*delta" packages/engine/src/agent/llmClient.ts` |
| `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` env vars live in `.env.local` | `cat .env.local 2>/dev/null \| grep -E "OPENAI\|ANTHROPIC"` |
| Existing course-catalog embedding index path | `ls data/course-catalog/` |
| Existing policy chunks file path | `ls data/policy-corpus/` |
| Bulletin layout: per-dept `_index.md` (NOT per-course subdirs); names are lowercase + underscore + may contain digits | `find data/bulletin-raw/courses -maxdepth 2 -name "_index.md" \| head -5` and confirm output shows `<dept>_<suffix>/_index.md` paths, not `<DEPT>_<SUFFIX>/<NUM>/index.md` |

If any assertion is wrong, **adapt the plan's code to match the actual repo** rather than forcing the repo to match the plan. The plans were drafted from earlier investigations; ground truth is the current repo state.

## All 46 locked design decisions (canonical list)

> **Architectural principle (locked):** The planner always ships a plan using available data + sensible defaults for missing data. **Defaults are concrete answers, not "unknown" gaps.** The agent surfaces trade-offs and asks targeted questions when student input might invalidate a default. Validators distinguish verified-pass from assumed-pass from requires-approval — the plan ships in all three cases, but the agent's surfacing language differs per axis. See Decision #40 (`ValidationResult` union) for the formal mechanism.
>
> When student input doesn't map to a modeled factor, fallback flows through a 4-tier hierarchy (Decision #42): (A) deterministic extraction, (B) top-K alternative-plan comparison via LLM judgment (Decision #44), (C) clarification dialogue for unsatisfiable hard constraints, (D) heuristic mapping as last resort, HARD-FORBIDDEN for any constraint the student frames as non-negotiable. Each tier emits a distinct Assumption shape so the agent can surface the chosen path to the student honestly.

Recorded across the plans. Restated here so a fresh executor sees them in one place.

### Phase 12.9.5 (decision 29)

29. **Course offering data carries a confidence tier.** See `docs/PHASE_12_95_PLAN.md`. Each `OfferingEntry` in `courses-offerings.json` gains `confidence: "historically_likely" | "historically_partial" | "irregular" | "permission_only" | "restricted" | "confirmed"`. Tier assignment: ≥75% appearance in last 4 same-season terms → `historically_likely`; 25–75% → `historically_partial`; <25% → `irregular`; bulletin "permission of department" → overrides to `permission_only`; major-restricted text → `restricted`; `confirmed` is reserved for Phase 15's FOSE materializer (set only at runtime when the actual section lands in FOSE). Phase 13's solver penalizes scheduling low-confidence offerings into critical-path slots; agent surfaces "this plan assumes X is offered, historically likely but unconfirmed."

### Phase 13 (decisions 1–8 + 21 + 22a–22d + 24 + 25 + 27 + 28 + 30 + 31 + 32 + 33 + 34 + 35 + 36 + 37[solver-side] + 38 + 39 + 40 + 41)

(Decision #26 lives in Phase 14 because it extends Decision #9's per-term override semantics, but it has a Phase 13 solver-side touchpoint at Stage 5 candidate-ranking. See `docs/PHASE_13_PLAN.md` solver.ts row for the Stage-5 implementation note.)

1. **NOT operator** in prereq trees: strictly enforced. Solver filters out a dependent course when any course in `notCourses` is in `coursesTaken`.
2. **AP/IB equivalency:** modeled as synthetic course IDs (`AP-CS-A-3`, `IB-MATH-HL-5`). Treated as normal courseIds; the DPR ingest path injects synthetic IDs when an AP-credit row is present.
3. **Instructor permission ("or instructor permission" / "or department approval"):** middle path. Solver places the course (soft-allow), but the slot carries `requiresPetition: true` annotation that the sidebar renders as a yellow flag. **Petition placement is treated as a last-resort fallback** (Stage 9e in the cascade) — only used when no clean non-petition plan exists within the current horizon and preferences. Rationale: petitions are externally gated (they may be denied), so over-relying on them produces plans that look feasible to the solver but require successful approval to actually realize. Stage 9e fires only after Stages 9a–9d (relax weights, add summer / J-term, extend graduation, drop optional electives) have all failed.
4. **Prereq satisfaction (revised 2026-05-03 — supersedes the original "trust DPR; don't verify grade" stance and its first revision).** A prereq course Y satisfies course X's requirement in term T iff:
   - **Optimistic-forward-projection (any one suffices):**
     - Y is in `dpr.requirementGroups[…].satisfiedBy[]` (DPR has officially recorded Y as satisfying *some* requirement — passed, met any registrar floor, on the student's program track), OR
     - Y has type `IP` in `dpr.courseHistory[]` (currently enrolled, **assumed-passing for planning purposes**), OR
     - Y is placed by the solver in some term **strictly before T** in the current plan being constructed.
   - **Hard reject** when Y has a final past attempt (`type EN/TE` in `courseHistory`) AND that attempt fails the satisfaction check (defined below) AND no later retake exists (no IP attempt, no future-plan placement, no other `satisfiedBy` entry for Y).
   - **The "fails the satisfaction check" rule for an attempt:**
     - **If `Prerequisite.minGrades[Y]` is set** (added by `tools/bulletin-parser/extractGradeThresholds.ts`): use `meetsGradeThreshold(attempt.grade, minGrades[Y])` from `packages/engine/src/dpr/gradeComparison.ts`. Below threshold → fail.
     - **If `minGrades[Y]` is absent**: the registrar's implicit floor governs. Authoritative signal: does the DPR record Y in any `requirementGroups[…].satisfiedBy[]` (effectively "did the institution accept this attempt as satisfying anything")? Yes → satisfied. No → fail.
   - **Coreqs use the same logic but allow same-term placement** (`≤ T` instead of `< T`).
   - **Re-plan trigger:** if the DPR refreshes and an IP-or-future course gets a final grade that fails its check, downstream slots that depended on it lose satisfaction → solver re-runs (Phase 13's `reconcile.ts`).
   - **Why this matters:** without forward-projection, the solver couldn't plan downstream courses for students with currently-IP prereqs (the most common forward-planning case) — broken UX. Without grade-aware checking, the solver silently green-lights downstream courses that high-grade prereqs (B/B+/A-) actually block.
5. **Cross-school courses:** lenient. With full undergrad bulletin coverage from Phase 12.7+12.8, almost all CAS prereqs reference courses we have data for. Edge cases gracefully degrade to "satisfied if in coursesTaken, else assume satisfied" — no annotation needed.
6. **Co-requisites:** Phase 13 ignores the `coreqs` field. Phase 14 implements same-term enforcement.
7. **Same-course retake:** trust DPR. If the course appears in both `coursesTaken` and `unmetRequirements`, the solver places it normally; downstream prereqs naturally chain.
8. **Optional electives above floor:** distinct rendering. Free-elective placeholders BELOW the credit floor (or when degree-credit minimum NOT met) render solid + "required." Above floor when degree minimum IS met → `optional: true`, dotted border + "optional" tag.

21. **Study-abroad courses (9000-series CAS) default-skip in solver, FOSE materializes site at runtime.** Bulletin location data is unreliable (~3% of chunks mention a study-abroad city, mostly as descriptive content like "Languages of Paris" rather than as a location qualifier; year-to-year drift makes static extraction stale). The structural signal is the courseId number range — NYU CAS uses 9000-series for site offerings (`ANTH-UA 9070`, `EXPOS-UA 9070`). Phase 13's solver default-skips any courseId matching `^[A-Z]+-UA 9\d{3}` unless the student has explicitly opted into a study-abroad term (Phase 14 preference, same shape as the summer/J-term opt-in). When a structural-plan course materializes through Phase 15's FOSE call, the section's `location` field tells the UI which site it actually runs at; the student picks the section accordingly. This split — bulletin for structure, FOSE for runtime — mirrors the prereqs-vs-availability split.

22a. **Per-slot reasoning trace (`slot.rationale`).** Each `ScheduleSlot` carries a structured `rationale` field documenting (a) `satisfiesRequirements: string[]` — which unmet requirement(s) the slot fills, (b) `termConstraints: Array<{kind, …}>` — why this specific term (`prereqChain` / `offering` / `creditCeiling` / `creditFloor` / `visaFloor` / `coreqSameTerm`), (c) `consideredAlternatives: Array<{courseId, rejectedBecause}>` — what the solver evaluated and rejected for this slot, (d) `decisionsApplied: Array<…>` — which locked decisions fired (e.g. `D4-IPProjection`, `D21-studyAbroadSkip`, `D3-petitionSoftAllow`), (e) `petitionTrigger?: {fromCourse, bulletinText}` — which course's "or instructor permission" clause triggered the yellow flag (set only when `requiresPetition: true`). Without this, the agent re-derives reasoning by walking prereq trees in-prompt — slow and error-prone. With it, the agent reads `slot.rationale` and paraphrases verbatim. Phase 13's `solver.ts` already tracks these reasons internally during backtracking; carrying them into the output is a one-day add.

22b. **Per-slot flexibility (`slot.flexibility`).** Each slot carries `{earliestPossibleTerm: Term, latestPossibleTerm: Term, alternativeCourses: courseId[]}` — the wiggle-room a student has to move this slot or substitute it. Computed during placement at near-zero marginal cost. Lets the agent answer "where do I have wiggle room in this plan?" / "can I move X earlier?" without re-running the solver. The `alternativeCourses` list captures functionally-equivalent options the solver considered but didn't pick (electives that satisfy the same requirement; cross-listed alternatives).

22c. **Per-slot downstream impact (`slot.downstreamImpact`).** Each slot carries `{courseIds: string[], graduationDelay: number}` — if this slot is dropped or fails, which downstream slots cascade and how many terms graduation slips. Pre-computed during the prereq-graph walk at solve time. Lets the agent answer "which course is least disruptive to drop?" / "what's the cost of failing this?" deterministically rather than by mental simulation.

22d. **Per-term load rationale (`semester.loadRationale`).** Each `ForwardSemester` carries `{strategy: "balanced"|"frontload"|"backload"|"light"|"heavy", creditsTarget: number, slack: number, alternativeDistributionsConsidered: Array<{distribution, rejectedBecause}>}`. Captures WHY this term ended up at 16 vs 14 vs 18 credits, beyond what per-slot rationale shows. Lets the agent answer "why are some semesters heavier than others?" with the actual balancing rationale rather than post-hoc inference. Extended by Decision #24 to also carry `weightedCredits`, `hardCount`, and `easyCount`.

24. **Workload-tier weighted balance.** "Busy" depends on workload character, not just credit count. A 16-credit term with 4 major-required courses is far busier than a 16-credit term with 1 major-required + 3 free electives, but the original credit-only balance metric would treat them as identical. Decision #24 adds:
    - **Per slot (extends Decision #22a):** `workloadTier: "major-required" | "major-elective" | "school-core" | "free-elective" | "general-elective"` (deterministically derived from `rationale.satisfiesRequirements` against program rules — `must_take` against major program → `major-required`; `choose_n` against major → `major-elective`; satisfaction against school-core ruleId → `school-core`; `optional: true` or no specific requirement → `free-elective`; satisfaction of a general-category placeholder → `general-elective`). `workloadWeight: number` derived from tier (1.0 / 1.0 / 1.0 / 0.5 / 0.6) with a 1.2 bump for capstone-class courses (defined as: prereqs.json entry has ≥3 prereq groups, indicating deep prereq chain).
    - **Per term (extends Decision #22d):** `loadRationale` adds `weightedCredits: number` (Σ slot.credits × slot.workloadWeight), `hardCount: number` (slots with workloadWeight ≥ 1.0), `easyCount: number` (slots with workloadWeight < 1.0).
    - **Stage 7 slack-balance optimization** uses `score = -Σ(per-term-weightedCredits-variance) - Σ(per-term-hardCount-variance)` instead of raw-credit variance. Solver natively avoids piling all hard courses into one term.
    - **Per-diff (extends Decision #23):** `PlanDiff` adds `weightedCreditsByTermDelta: Record<Term, number>` and `workloadTierShifts: Array<{term, before: {hardCount, easyCount, weightedCredits}, after: {…}}>`. Lets the agent flag "this term is now 4 hard + 0 easy where it was 2 hard + 2 easy" — the actual workload-imbalance signal, not just credit count.
    - **Why:** without weighted balance, the planner produces "balanced" plans where every semester is 16 credits but one semester has 4 major-required courses and another has 4 free electives. The student preference `loadStyle: "balanced"` should mean balanced WORKLOAD, not balanced credit count. Lock this so the solver and the agent's consequence-explanation both use the same metric.

25. **Pre-computed aggregate balance score (`ForwardSchedule.balanceScore` + `PlanDiff.balanceImpact`).** Decision #24 added per-term workload-tier metrics. Decision #25 adds the **plan-level aggregate** so the agent doesn't re-derive balance arithmetic on every turn.
    - **Per plan (extends `ForwardSchedule`):** `balanceScore: number` — single scalar, lower = better. The solver already computes this during Stage 7 to pick the winning distribution; carrying it into output saves the agent from doing variance math in-prompt every turn (LLMs are unreliable at arithmetic on 8+ numbers, leading to inconsistent verdicts across turns). Components: `α × weightedCredits-variance + β × hardCount-variance + γ × loadStyle-target-deviation`. Coefficients calibrated so range is roughly 0 (perfect) to ~50 (deeply imbalanced); a delta of 2-3 between two plans is the "noticeable" threshold for a `balanced`-preference student.
    - **Per diff (extends Decision #23 PlanDiff):** `balanceImpact: { before: number, after: number, delta: number, classification: "improved" | "negligible" | "degraded-mild" | "degraded-significant" }`. Pre-computed; the agent reads `classification` and decides whether to flag — no in-prompt variance arithmetic. Classification thresholds: delta ≤ 0 → improved; |delta| < 1.5 → negligible; 1.5 ≤ delta < 4 → degraded-mild; delta ≥ 4 → degraded-significant. Calibrate empirically once first 5–10 student plans are reviewed.
    - **Why:** Decision #24's per-term metrics are inputs; Decision #25's aggregate is the verdict. Without the verdict pre-computed, the agent re-derives via 7-step in-prompt arithmetic each turn — risk of LLM math errors, inconsistent thresholds across turns, wasted compute. Same architectural pattern as Decision #22a (per-slot rationale instead of agent re-derivation): the solver already has the numbers, just emit them.

27. **Forward-feasibility SCREEN at every placement (NOT a formal oracle).** Greedy term-by-term placement with backtracking can still miss globally feasible plans — a locally good choice in term T can lock out a future course's only valid window. Decision #27 mandates that every placement in Stage 6c is followed by a fast `forwardFeasibilityScreen`: "given remaining unmet courses + remaining terms + offering availability + prereq depths, does it look like at least one valid graduation path exists from this partial plan?" Implementation: bin-packing the remaining courses' minimum-required-terms (computed from prereq DAG depths in Stage 2) against remaining-term capacity (creditCeiling − already-placed). Cheap (~O(unmet × terms)). Reject the placement if the screen fails; pick next candidate.
    
    **Important — this is a screen, not a proof.** The screen can produce false positives (passes the bin-packing but a hidden choose_n / double-counting / coreq / petition issue downstream still makes the plan infeasible) AND false negatives (rejects a valid placement that would have worked under elective rebinding). It's a fast pruning heuristic only — sufficient for catching obvious dead-ends, insufficient for declaring a plan shippable. The actual feasibility verdict is Stage 8's full validation gate (`runGraduationPathValidator`). Naming this "oracle" would invite future implementers to rely on it as ground truth, which would be wrong.
    
    The screen uses Decision #29's `confidence` tier so low-confidence offerings count as half-capacity. Production principle: a next-semester recommendation should only be treated as valid if Stage 8's validator confirms it preserves a valid path to graduation; the Stage 6c screen just prevents the solver from descending into obviously-doomed branches.

28. **Late-binding for choose_n elective pools.** Many degree requirements are flexible pools — "5 of 20 advanced electives," "16 credits of major electives," "any course satisfying CAS Core category Y." Committing to a specific course at Stage 6c too early can lock the plan into a fragile elective combination when better alternatives exist. Decision #28 represents elective pools as **delayed-binding pool slots** until the term gets close enough that offerings are firm OR the student explicitly confirms the pick. Schema: `ScheduleSlot.poolBinding?: { poolId: string, candidates: courseId[], satisfiesRule: ruleId }`. The slot reserves credits + workloadWeight without committing to a courseId. The solver maintains a constraint that `Σ over pool members placed across plan ≥ N` (the choose_n requirement). Stage 6 places the pool slot abstractly; Stage 7 promotes specific courseIds when needed for prereq chains or feasibility. Phase 14's `propose_plan_change` exposes a `bindPoolSlot` mutation kind for student confirmation. Distinct from Decision #37 (free-elective late-binding) because pool members are a constrained set, not "any course."

30. **In-progress (IP) courses are conditional assumptions, not completed facts.** Decision #4 lets IP courses count toward prereq satisfaction optimistically. Decision #30 makes that optimism EXPLICIT in the output so the agent can honestly surface the assumption to the student. Schema: `ForwardSchedule.assumptions: Assumption[]` where `Assumption = { type: "IP_COURSE_COMPLETION", courseId: string, requiredGrade?: string (from Prerequisite.minGrades if applicable), consequenceIfFalse: string (computed from downstreamImpact #22c — "CSCI-UA 201, 310, 421, 480 shift by ≥1 term"), cascadingSlots: courseId[], contingencyPlanAvailable: boolean (true when Phase 14's simulate_alternatives has generated a recovery plan for this assumption's failure mode) }`. The solver populates one entry per IP course relied on. Phase 14's `simulate_alternatives` can ALSO generate contingency plans alongside the optimistic plan (one extra solver run): "if CSCI-UA 102 grade is below C, here's the recovery path." When a contingency plan is generated, set `contingencyPlanAvailable: true` so the agent can offer "want to see the recovery path?" without recomputing. Without #30, the agent silently ships a plan that depends on unverified outcomes; #30 makes the dependency contract explicit. Re-plan trigger from Decision #4 still applies — when DPR refresh shows the assumption was wrong, the affected slots invalidate.

31. **Pin precedence is bounded by hard institutional constraints; per-stage check timing is explicit.** Decision #10 says pins are hard solver constraints; Decision #31 makes the precedence hierarchy explicit so a Phase 13 implementer doesn't accidentally let pins bypass legal/visa/prereq filters. **Hierarchy (highest precedence first):**
    1. Visa / institutional / legal constraints (F-1 floor + visaValidator per #34, school enrollment policies)
    2. Prereq + offering + NOT clauses (Decisions #1, #4, #5)
    3. Confirmed-offering availability (Decision #29 — a course not in the bulletin/FOSE for term T cannot be pinned to T)
    4. Student pins (HARD preferences — must yield to ranks 1-3; otherwise propagate as InfeasibilityReport per #10)
    5. Student soft preferences (loadStyle, exclusions when they conflict with pins)
    6. Optimization objectives (balanceScore, downstreamImpact, etc.)
    
    **Per-stage check timing (the hierarchy is the precedence order, NOT the check-timing order):** Most validations are evaluated at multiple stages with different scopes:
    - **Stage 6a (candidate-level filters)** evaluates only what can be checked per single candidate course — course-existence, course-restricted-to-other-major, single-course prereq satisfaction, single-course offering in season, NOT clauses, exclusion list, study-abroad-9000-skip, pinned-set membership. Term-level visa (full-time credits, online-credit total, in-person minimum) CANNOT be checked at 6a because they're properties of the entire term schedule, not of one candidate.
    - **Stage 6d (per-term invariants)** evaluates term-level checks once that term's schedule is fully populated — visaValidator (#34) per term, coreq same-term constraints (#14), credit-ceiling and credit-floor.
    - **Stage 8 (final plan validation gate, #41)** evaluates plan-level checks once Stage 7 has converged — total credits ≥ degree minimum, residency, upper-level, choose_n bucket resolution, forwardFeasibilityScreen, all-terms-visa-OK, graduation target.
    
    **Wording rule for implementers:** pins are **mandatory preferences within the valid candidate set only**. Pins cannot introduce candidates that violate ranks 1–3. The phrase "pins score ∞" is forbidden in implementation — it invites future code that short-circuits ranks 1–3 filters. The correct mental model: pinned courses are PRIORITIZED among already-valid candidates, not INJECTED past hard filters. When a pin would require violating a hard constraint, the solver returns `InfeasibilityReport` with the pin identified as the conflict source + `relaxationSuggestions[]` + the no-pin `fallbackSchedule` (Decision #10's existing fallback).

32. **Plan-validity states (`PlanState` + `session.studentDraftPlan`).** Decision #13 says student confirmation is highest authority. Decision #32 narrows that to apply only WITHIN the space of valid plans — a student can prefer between valid plans, but cannot turn an academically/visa-invalid plan into `session.forwardSchedule` by confirming it.
    
    Schema (4 states):
    - `"valid-clean"` — all hard constraints met, all Decision #40 validator axes return `pass`, no `assumed-pass` and no `requires-approval` outstanding. Ship as-is, no caveats. (Renamed from "valid" — the bare word "valid" was ambiguous because `valid-with-trade-offs` is also a valid plan; `valid-clean` is precise about meaning "no caveats.")
    - `"valid-with-trade-offs"` — all hard constraints met, but at least ONE of:
        - An `Assumption` from Decision #30 (IP course outcomes)
        - A slot with `requiresPetition: true` (#3)
        - A slot with offering `confidence` in `{"historically_partial", "irregular", "permission_only"}` (#29) — these always trigger trade-offs
        - A `historically_likely` slot that is also `isCriticalPath: true` (#39) AND has no alternatives in its requirement pool — only this combination of `historically_likely` triggers trade-offs; non-critical-path `historically_likely` slots stay clean to avoid warning fatigue across multi-year plans
        - Any validator returning `assumed-pass` (#40 — defaulted axis like F-1 online-credit limit pre-Phase-15)
        - Any validator returning `requires-approval` (#40 — petition / RCL / CPT / transfer-credit / equivalency / substitution)
      
      Ship the plan; agent surfaces the specific trade-offs from `assumptions[]` + `slot.requiresPetition` + `slot.confidence` + `slot.isCriticalPath` + validator results so the student decides eyes-open.
    - `"infeasible-draft"` — at least one hard-constraint violation (validator returns `fail`, or rank 1-3 of Decision #31 violated). Plan does NOT write to `session.forwardSchedule`.
    - `"student-preferred-invalid-draft"` — student explicitly confirmed despite hard violations. Plan goes to `session.studentDraftPlan`; preserved for advisor review but the agent NEVER treats it as a valid plan in subsequent reasoning.
    
    **Routing rule:** `"valid-clean"` and `"valid-with-trade-offs"` write to `session.forwardSchedule`. `"infeasible-draft"` and `"student-preferred-invalid-draft"` write to `session.studentDraftPlan`. Agent surfaces: "I can save this as a preference draft, but I can't mark it as a valid plan because [violations]." Avoids the liability of the system endorsing an illegal plan. Decision #13's "confirmation = authority" is preserved for the valid-plan space (`valid-clean` + `valid-with-trade-offs`); Decision #32 only restricts the invalid space.
    
    The trade-off granularity (which assumption / which petition / which low-confidence offering) lives in the existing fields (`assumptions[]`, `slot.requiresPetition`, `slot.confidence`, `slot.approvalAuthority`), NOT in finer-grained PlanState distinctions. The 4-state union is intentionally coarse so the agent can read the state quickly and dispatch to the appropriate trade-off-surface fields for detail.

33. **Audited optionality — a slot is only droppable if removing it preserves all global constraints.** Decision #8 lets free electives above the credit floor be marked `optional: true`. Decision #33 prevents this from causing plans that meet the per-term floor but miss degree-total credits, residency, upper-level, scholarship, visa, or future-feasibility requirements. Schema: `ScheduleSlot.optionalReason?: { droppable: boolean, blockingConstraints?: string[] }`. Compute via full audit: `canDrop(slot) = removing it preserves degree-credit-minimum (e.g. 128) AND school-residency AND major-credit-minimum AND upper-level-credit count AND F-1 floor across affected terms AND graduation-target-term AND all unmetRequirements still satisfiable AND forward feasibility (Decision #27)`. If any check fails, `droppable: false` + `blockingConstraints` lists the failing checks. Stage 9d's "drop optional electives" fallback is gated on `droppable: true`. Agent can answer "this looks like a free elective but it's contributing to your 128-credit total" with specifics.

34. **F-1 visa validation is a multi-axis check using `ValidationResult` per axis (Decision #40), not a credit floor.** Decision #9's "F-1 floor ≥12 cr" is necessary but not sufficient. Decision #34 introduces `packages/engine/src/dpr/visaValidator.ts` (extending the planned `visaPolicy.ts`) with a structured per-term check using the `ValidationResult` 4-state union from Decision #40:

    ```typescript
    interface VisaValidationResult {
        fullTimeSatisfied: ValidationResult;       // pass / fail (we have credit data)
        creditMinimumSatisfied: ValidationResult;  // pass / fail
        onlineLimitSatisfied: ValidationResult;    // assumed-pass (default in-person) PRE-Phase-15;
                                                   // pass / fail POST-Phase-15
        inPersonMinimumSatisfied: ValidationResult; // same as above
        rclEligible: ValidationResult;              // requires-approval (OGS) when below floor
        cptConflict: ValidationResult;              // requires-approval when CPT term flag set
        finalTermExceptionPossible: ValidationResult; // requires-approval (registrar)
        overallWarningLevel: "none" | "low" | "medium" | "high";
        citations: string[];  // pointers to OGS policy sections
    }
    ```

    Stage 6d invariant: every axis returns `pass` or `assumed-pass` for the plan to ship. Any `fail` → infeasible-draft. Any `requires-approval` → plan ships with state `valid-with-trade-offs` and the axis surfaces in the agent's response.

    **Phase 13 ships:** all axes that work without FOSE data — `fullTimeSatisfied`, `creditMinimumSatisfied`, `rclEligible`, `cptConflict`, `finalTermExceptionPossible` (all return real `pass` / `fail` / `requires-approval`).

    **Phase 13 ships PRE-Phase-15:** `onlineLimitSatisfied` + `inPersonMinimumSatisfied` return `{ status: "assumed-pass", assumption: "all sections in-person", whatWouldFlipIt: "if any section is online and total online credits would exceed 3 (F-1 limit) or fall below in-person minimum" }`. Plan ships with these axes; agent says "Your plan satisfies F-1 credit minimum. **One thing I'm assuming:** all your sections are in-person. F-1 limits you to 3 online credits per term — if any of your sections turn out to be online, let me know and I'll re-check."

    **Phase 15 promotes:** when FOSE meetingPattern data lands per term, `onlineLimitSatisfied` / `inPersonMinimumSatisfied` flip from `assumed-pass` to actual `pass` / `fail` with verified data. The plan's state can re-evaluate from `valid-with-trade-offs` to `valid-clean` once all axes are verified.

    Citations are pointers to OGS policy sections so the agent can surface "per OGS Policy 5.2.1 [link]…". Visa errors are high-stakes; the `assumed-pass` distinction prevents the system from claiming verification it didn't perform.

35. **Workload-tier modifiers beyond requirement-type (W/L/level/capstone).** Decision #24's tier classification (major-required vs free-elective etc.) is the core signal but doesn't capture writing-intensiveness, lab structure, or course level. Decision #35 extends `slot.workloadWeight` with deterministic modifiers from data we already have:
    - `+0.2` for W-suffix or writing-intensive courses (parsed from bulletin: courseIds ending in `W`, or bulletin description containing "writing-intensive" / "intensive writing" / "expository writing")
    - `+0.15` for L-suffix or lab courses (courseIds ending in `L`, or bulletin "Lab" in title)
    - `+0.2` for course numbers ≥ 4000 in CAS / ≥ 3000 in Tandon (advanced level)
    - `+0.2` for capstone (≥3 prereq groups in `prereqs.json`, already in Decision #24)
    
    Modifiers stack; cap at +0.6 to avoid runaway weights. Catches a student picking "Quantum Field Theory" as a "free elective" — the modifiers push its weight from 0.5 → 1.1, triggering the workload-tier-shift warning in Decision #25's `balanceImpact`. Out-of-scope per the Phase 16 drop: professor-specific workload, RMP-style ratings, course-evaluation-derived difficulty, prior-grade-risk personalization. We have ~70% of the granular workload signal without those.

36. **Stage 7 slack-balance moves trigger full plan revalidation, not just per-term invariants.** Original Stage 7 design re-validates per-term invariants (creditFloor, coreqs, ceiling). Decision #36 widens to full plan revalidation per move because moving a course can break global constraints invisible at the per-term level: choose_n bucket satisfaction, double-counting rules, residency / upper-level / major credit thresholds, future feasibility, F-1 across affected terms, choose-N pool resolution. **For each candidate Stage 7 move:** apply tentatively → re-run Stages 1-6 (cheap because most placements unchanged) → run `runFullAudit` equivalent (all requirement groups satisfied, total credits ≥ minimum, residency / upper-level / major OK, all choose_n buckets resolve, forward-feasibility still holds via Decision #27, visa OK via Decision #34) → accept iff balanceScore improves AND all checks pass; else revert. More expensive moves but tractable since each is a local delta. Future iteration: fold workload-balance objective into Stage 6's main solver (constraint-programming style) instead of post-hoc Stage-7 repair — likely Phase 13.5 or v1.1.

37. **Free-elective placeholders default to low workload weight; binding deferred to immediate-term selection step.** Distinct from Decision #28 (constrained pool late-binding) — free electives are unconstrained "fill credits" slots and students typically use them to LIGHTEN a semester (Intro to Film, Personal Finance, Yoga). Decision #37 codifies this assumption.
    - **Schema:** `ScheduleSlot` gains `bindingState: "bound" | "placeholder-pending" | "placeholder-deferred"` and `placeholderId?: string` (e.g. "FREE-ELECTIVE-1"). `courseId` is null for unbound placeholders. The slot kind is discriminated via Decision #38's `PlaceholderSlot` tagged union — free-elective slots are a `FreeCreditSlot` variant with no requirement-pool constraint.
    - **Default weights:** `placeholder-deferred` (future term) → 0.3 (optimistic — student typically picks easy); `placeholder-pending` (immediate term, awaiting selection) → 0.3; once `bound`, weight is per Decision #24 + #35 normal calc. **The 0.3 default is a planning placeholder ONLY** — it represents the assumption that students typically pick low-workload courses for free electives (Intro to Film, Personal Finance, etc.). Once a `FreeCreditSlot` is bound to a specific course via `bind_free_elective` (Phase 14), `workloadWeight` is recomputed from real course metadata (#24 tier + #35 modifiers), and a warning fires if the recomputed weight is much higher than 0.3 (per the warning thresholds in this Decision). **Implementers must NEVER trust 0.3 as the actual workload signal once a course is bound** — recompute on every binding.
    - **Binding flow:** after structural plan is approved, agent identifies placeholders in the IMMEDIATE-NEXT term only (T+1). Future-term placeholders stay symbolic. Agent prompts: "You have N free-elective slots in [T+1]. Want suggestions, or do you have one in mind?" Student picks → agent calls new Phase 14 tool `bind_free_elective(slotId, courseId)`.
    - **Workload recheck on bind:** solver computes new workloadWeight from the bound courseId (Decision #24 + #35). If delta from placeholder's 0.3 is significant: 0.2 < delta ≤ 0.7 → "this is harder than typical free electives" warning; delta > 0.7 OR balanceImpact = degraded-* → "much harder than typical; balance shifts from X to Y" strong warning. State becomes `bound-with-warning` for the elevated cases.
    - **Re-binding:** Phase 14's mutation array (Decision #23) gains `{kind: "bindFreeElective", slotId, courseId}` and `{kind: "unbindFreeElective", slotId}` — student can swap freely until registration.
    - **Boundary rules:** only IMMEDIATE-next term prompts binding. Future placeholders re-prompt as time advances. "None" / "skip" is valid — slot stays placeholder; agent re-prompts at registration time.

38. **Tagged-union `PlaceholderSlot` discriminator.** Decisions #28 and #37 both introduce placeholder slots, but they have different validation rules. Without explicit type discrimination at the implementation layer, a `RequirementPoolSlot` (must satisfy choose_n rule) could accidentally be bound to any course; a `FreeCreditSlot` (just fills credits) could be confused with a major-elective requirement.
    
    Schema:
    ```typescript
    type PlaceholderSlot =
        | RequirementPoolSlot       // #28 — bound courseId must be in candidates[]; satisfies a specific ruleId
        | FreeCreditSlot             // #37 — bound courseId can be any in-scope course; default low workload weight
        | AdvisingPlaceholderSlot;   // advisor-flagged manual choice (e.g. honors thesis topic, study-abroad equivalency request needing faculty negotiation)
    
    interface RequirementPoolSlot {
        kind: "requirement-pool";
        ruleId: string;                       // e.g. "CS_ADVANCED_ELECTIVE_400"
        candidates: CourseId[];                // from program rules; subset of in-scope catalog
        constraints: RequirementConstraint[];  // double-counting, level minimum, etc.
        bindingState: "unbound" | "candidate-set" | "bound";
        bound?: CourseId;
    }
    interface FreeCreditSlot {
        kind: "free-credit";
        defaultWeight: 0.3;                   // per Decision #37
        bindingState: "placeholder-pending" | "placeholder-deferred" | "bound";
        bound?: CourseId;
    }
    interface AdvisingPlaceholderSlot {
        kind: "advising-placeholder";
        advisingNote: string;                 // e.g. "Honors thesis — topic TBD with faculty"
        bindingState: "advisor-pending" | "bound";
        bound?: CourseId;
    }
    ```
    
    The discriminator (`kind`) lives at the type level, not as convention. Each variant has different binding-validation rules: `RequirementPoolSlot.bind(courseId)` enforces `candidates.includes(courseId)`; `FreeCreditSlot.bind(courseId)` accepts any in-scope course; `AdvisingPlaceholderSlot.bind(courseId)` requires the slot to have been advisor-confirmed first. Phase 14's `bind_free_elective` and `bindPoolSlot` tools (Decisions #28 + #37) dispatch on this discriminator. The TypeScript exhaustiveness check on the union prevents future bugs where a new placeholder kind is added without binding logic.

39. **`OfferingRiskImpact` per slot (slim).** Decision #29 attaches a `confidence` tier to each course; Decision #39 surfaces the criticality interaction at the slot level so the agent can answer "is this offering's risk actually a problem for me?" without re-deriving from prereq data each turn.
    
    Schema (added to `ScheduleSlot`):
    ```typescript
    confidence: ConfidenceTier;          // copied from OfferingEntry per Decision #29
    isCriticalPath: boolean;             // true if this slot is the only satisfier of a requirement,
                                          // OR is a sole prereq for ≥2 downstream slots in the plan
    ```
    
    The two booleans (plus `slot.downstreamImpact` from Decision #22c) compose into the agent's risk-surfacing language:
    - `confidence === "historically_likely" && !isCriticalPath` → no flag
    - `confidence === "irregular" && !isCriticalPath` → "fyi, X is offered irregularly but you have alternatives"
    - `confidence === "irregular" && isCriticalPath` → "**warning: X is offered irregularly AND has no alternative for [requirement]; consider opting into summer term as a buffer**"
    - `confidence === "permission_only"` → always surface; emit `slot.requiresPetition: true` per #3
    
    Skipped (over-engineered for v1, no consumer): the broader `OfferingRiskImpact` taxonomy with `riskLevel` enum and `latestSafeTerm` — derivable from existing fields if it ever becomes load-bearing.

40. **`ValidationResult` 4-state union (the validator-status mechanism).** This is the formal mechanism that lets the planner ALWAYS ship a plan (per the architectural principle locked at the top of this list) WHILE the validator carries honest metadata about what was actually checked vs. defaulted vs. requires-external-approval. Yesterday's "validators stay boolean" stance was wrong: the plan ships with default assumptions (your principle) AND validators distinguish verified-pass from assumed-pass from requires-approval (GPT's pushback) — these are not in conflict. The plan ships in BOTH the `pass` and `assumed-pass` cases.
    
    Schema:
    ```typescript
    type ValidationResult =
        | { status: "pass"; verifiedFrom: DataSource }
        | { status: "assumed-pass"; assumption: string; whatWouldFlipIt: string }
        | { status: "requires-approval"; authority: ApprovalAuthority }
        | { status: "fail"; reason: string };
    
    type DataSource = "DPR" | "FOSE" | "bulletin" | "program-rules" | "student-input";
    type ApprovalAuthority = "instructor" | "department" | "advisor" | "registrar" | "OGS" | "school-dean";
    ```
    
    **Behavior contract:**
    - `pass` — verified against data we have. Agent says "✓ verified."
    - `assumed-pass` — defaulted to typical case; data not yet available (or not applicable to verify). Plan ships AS IF pass. Agent says "✓ assumed (assuming `<assumption>`); if `<whatWouldFlipIt>`, I'll re-check." Examples: F-1 online-credit limit pre-Phase-15 (assumes in-person), IP grade outcomes per #30, free-elective workload pre-binding.
    - `requires-approval` — plan ships AS IF feasible BUT the student must take an external action to actually realize the plan. Agent says "⚠ requires approval from `<authority>`; without approval, you'd need [fallback]." Plan state per Decision #32 is `valid-with-trade-offs`. Examples: petitions, RCL, CPT enrollment, transfer-credit equivalency, substitution requests, study-abroad equivalency.
    - `fail` — verified against data; constraint violated. Plan does NOT ship; state is `infeasible-draft` per Decision #32.
    
    **Categorization (which axes use which states):**
    - **Always boolean `pass` / `fail`** (we have authoritative data): total credits ≥ degree minimum, prereq satisfaction with explicit minGrades, NOT clauses, F-1 12-credit floor, coreq same-term placement, course exists in catalog.
    - **`assumed-pass` (default-typical with explicit assumption flag)**: F-1 online-credit limit pre-Phase-15, F-1 in-person minimum pre-Phase-15, free-elective workload pre-binding (Decision #37), IP grade outcome (Decision #30 — `assumption` field already on `Assumption`).
    - **`requires-approval`**: petition slots (per #3), CPT enrollment, RCL applications, transfer-credit equivalency, substitution approvals, study-abroad course equivalency, grade override / forgiveness petitions.
    - **`fail` (refuse to claim feasibility)**: course doesn't exist; pinned to a term where the bulletin definitively shows it isn't offered; prereq cycle.
    
    **Routing into `PlanState` (Decision #32):**
    - All axes `pass` (no `assumed-pass`, no `requires-approval`) → `valid-clean`; otherwise `valid-with-trade-offs`
    - Any `requires-approval` → `valid-with-trade-offs`
    - Any `fail` → `infeasible-draft`
    
    **Why this is correct:** Plan still ships in `pass` and `assumed-pass` cases (architectural principle preserved). The `assumed-pass` carries `assumption` text the agent surfaces verbatim — so the student knows what was checked vs defaulted, asymmetrically calibrating to the real-world stakes. `requires-approval` separates "this needs external action" from "this is uncertain" — different conversation flow with the student. `fail` is the only case where we refuse to commit, and it's reserved for things we definitively know break.
    
    **Implementation note:** the existing boolean fields on validator results (e.g. `fullTimeSatisfied: boolean`) are replaced with `ValidationResult` typed fields throughout `visaValidator.ts` (Decision #34) and any future validators. Existing code that reads `result.fullTimeSatisfied` as a boolean must be updated to read `result.fullTimeSatisfied.status === "pass" || result.fullTimeSatisfied.status === "assumed-pass"`. Phase 13's `visaValidator.ts` file structure entry already reflects this in the file-structure table.

41. **Stage 8 = FINAL PLAN VALIDATION GATE (replaces "all unmet courses placed" check).** Stage 8's gate must verify every axis a plan needs to be shippable, not just placement coverage. The previous "all unmet courses placed in some term ≤ graduation target" wording is necessary but not sufficient — a plan can have all courses placed yet violate residency credits, fail to resolve a choose_n bucket, or carry unannotated petition requirements.
    
    Stage 8 invokes `runGraduationPathValidator(plan, dpr, programRules)`. Plan is feasible iff:
    1. All `requirementGroups` are satisfied (or marked as `assumed-pass` for IP-dependent slots per #30).
    2. All `RequirementPoolSlot` placeholders are resolvable (#28 — at least one valid binding remains in `candidates[]` after constraints).
    3. Total credits ≥ degree minimum (e.g. 128).
    4. Residency / upper-level / major / minor / school-core credit thresholds are met.
    5. `visaValidator` (Decision #34) returns no `fail` axis on any term (`assumed-pass` and `requires-approval` are acceptable; they affect `PlanState` per #32 but don't block).
    6. All assumptions and approvals are explicitly represented in `ForwardSchedule.assumptions[]` (#30) + per-slot `requiresPetition` / `approvalAuthority` (#3 + part of #34/#40).
    7. Graduation target term met OR plan state explicitly reflects delay.
    
    Verdict: feasible → `PlanState` per #32 (`valid-clean` or `valid-with-trade-offs` based on Decision #40 axis statuses) → write to `session.forwardSchedule`. Infeasible → `InfeasibilityReport` with the specific axis (1-7) that failed.
    
    Stage 8 IS NOT the place where Stage 7's per-move revalidation (Decision #36) happens. Stage 7 validates moves DURING optimization; Stage 8 validates the FINAL plan once Stage 7 has converged. Both invoke similar checklists; they fire at different points.

### Phase 14 (decisions 9–15 + 23 + 26 + 37[binding tools] + 42 + 44)

9. **Load styles:** 5 modes — `balanced` (default, slack-based), `frontload` (place hard reqs early), `backload` (defer hard reqs), `light` (per-term override; pulls credit target down to floor), `heavy` (per-term override; pushes up to ceiling). `part-time-domestic` requires explicit `allowBelowF1Floor: true`. **Extended by Decision #26**: per-term `light`/`heavy` overrides also bias Stage 5's candidate ranking by workload-tier (so `light` actually means light-and-easy, not just light-on-credits).
10. **Pinning:** two-step (`propose_plan_change` → `confirm_plan_change`). Hard constraint in solver. Infeasible pins return conflict + a no-pin fallback plan.
11. **Exclusions:** same shape as pins, inverse polarity. CourseId is filtered out of candidates for the given term (or globally).
12. **Summer / J-term:** off by default. When standard schedule infeasible, `simulate_alternatives` proposes adding them. When student opts in, they enter the available-term enumeration.
13. **Confirmation = highest authority.** Student-confirmed plan is written to `session.forwardSchedule` even when it deviates from solver-optimal. Agent surfaces consequences but doesn't override.
14. **Co-requisite enforcement:** same-term constraint in solver. Phase 14 also adds the parser extension to populate the previously-empty `coreqs` field.
15. **Failed-course retake:** if DPR shows a failed grade (F or W), the course appears in `unmetRequirements`. Solver places it normally; if a downstream course depends on it, prereq check forces the failed course earlier in the schedule.

23. **`propose_plan_change` accepts a MUTATION ARRAY + returns a structured `PlanDiff`.** Tool input: `{mutations: PlanMutation[]}` where each mutation is `{kind: "pin" | "exclude" | "swap" | "addTerm" | "loadStyleOverride", …}`. Output: `{newSchedule?: ForwardSchedule, diff?: PlanDiff, infeasibility?: InfeasibilityReport}`. The `PlanDiff` shape: `{creditsByTermDelta: Record<Term, number>, graduationTermShift: number_of_terms, newRequiresPetition: courseId[], removedRequiresPetition: courseId[], newUnmetRequirements: courseId[], cascadedShifts: Array<{courseId, fromTerm, toTerm, becauseOf: courseId}>}`. Cascade list is built from Decision #22c's `downstreamImpact`. Multi-mutation support means the agent can answer "what if I drop my CS minor AND swap Algorithms for Theory AND take summer 2027?" in a single tool call. Without #23, the agent either runs the solver three times or punts.

26. **Per-term `light`/`heavy` overrides are workload-tier-aware at BOTH ranking and optimization stages.** Decision #9 specifies the credit-target adjustment. Decision #26 extends to specify the workload-tier preference too — without it, a Phase 14 implementer reading Decision #9 in isolation might wire only the credit cap and trust Stage 7's variance metric (Decision #24) to handle workload-tier rebalancing. That works partially, but Stage 5's candidate ranking would still pick hard courses to fill the lower cap, leaving the term "light by credits" but "heavy by workload character." This decision locks the Stage-5 bias.

    **For per-term `light`:**
    - Credit target → floor (Decision #9 behavior, unchanged).
    - **Stage 5 candidate ranking for that term**: multiply candidate priority by `(1 − 0.3 × slot.workloadWeight)` — soft preference for free/general electives in this term; hard courses get pushed to other terms in candidate ordering.
    - **Stage 7 redistribution**: weighted-variance metric (Decision #24) naturally pulls hard courses out due to lower credit cap (existing emergent behavior, just made explicit).
    - **Result:** term lands light in BOTH credit count AND hard-course count. The student's "make Spring 2027 lighter" intent is served.

    **For per-term `heavy`:**
    - Credit target → ceiling.
    - **Stage 5 candidate ranking**: multiply by `(1 + 0.3 × slot.workloadWeight)` — soft preference for hard courses landing here.
    - **Stage 7**: tolerates higher hardCount for that term (the higher credit cap absorbs the load).

    **Hard constraints still win:** if a course's `earliestPossibleTerm` is the constrained term (no other valid placement window per prereqs/offerings), the solver places it there regardless of the workload-tier soft preference. Override doesn't break feasibility — it influences ranking, not constraint validity.

    **Paired overrides ("make Fall heavy so Spring is light")** flow through Decision #23's mutation array as two `loadStyleOverride` entries in one `propose_plan_change` call. The solver applies both simultaneously and finds the redistributed plan; the resulting `PlanDiff.balanceImpact` (Decision #25) classifies whether the swap-style intent improved or degraded overall balance.

    **Why:** without explicit Stage-5 + Stage-7 wording, Phase 14's executor risks shipping `light` overrides that only adjust credits, leaving students confused ("you said Spring would be lighter — why does it still have 3 hard classes in 12 credits?"). Locking this makes student-facing semantics match student intuition.

42. **4-tier fallback hierarchy for unmodeled student factors.** When the student states a preference, the agent applies tiers in order; each tier degrades gracefully to the next. **Constraint framing must be classified BEFORE picking a tier.** If the student cites a non-negotiable reason (work, childcare, religious observance, athletic/medical commitments, financial), mark the constraint hard. Hard constraints route only through Tier A or Tier C — NEVER B or D. (Asymmetric stakes — a wrong Tier-B pick is recoverable; a wrong Tier-D mapping of a hard constraint ships a plan that breaks the student's actual life.)

    - **Tier A — Modeled factor.** Deterministic extraction → `PlanMutation` → solver. Decisions #9–#15, #23, #26, #43.
    - **Tier B — Top-K alternative-plan comparison (Decision #44).** Tool: `compare_plan_alternatives(studentStatedFactor, dimensions?)` reads `ForwardSchedule.alternativeCandidates` and returns `{selectedPlanIndex, reasoning, plansSummarized}`. Tool is read-only; the agent applies via `confirm_plan_change` only after the student confirms. Emits Assumption type `LLM_RANKED_ALTERNATIVE`. Plan ships in `valid-with-trade-offs` state.
    - **Tier C — Clarification dialogue.** Used when no candidate plan satisfies a hard constraint OR when the student's framing requires confirmation before any mutation. Agent surfaces the gap and requests the student drop / swap / relax.
    - **Tier D — Heuristic mapping (last resort, soft constraints ONLY).** Used only for soft preferences AND only when Tier B has no axis-aligned variation among candidates. **Tier D is HARD-FORBIDDEN for any constraint the student frames as non-negotiable.** For hard constraints, the only valid fallback is Tier C clarification.

    Schema:
    ```typescript
    type Assumption = {
        type: "HEURISTIC_MAPPING";
        studentStatedFactor: string;
        studentConstraintFraming: "soft";  // <-- discriminator;
                                           // "hard" framing CANNOT
                                           // emit this Assumption
                                           // (TypeScript compile
                                           // error)
        mappedToMutation: PlanMutation;
        confidence: "low" | "medium" | "high";
        reasoning: string;
        consequenceIfWrong: string;
    };
    ```

    The `studentConstraintFraming: "soft"` literal type at the schema level is the second enforcement layer (the system-prompt rule is the first; the eval-suite Tier-D-negative bucket in Phase 14 is the third). Hard-framed constraints cannot construct this Assumption variant, so a Tier-D emission for a hard constraint is a compile-time error, not a prompt-rule violation.

    **Why:** pure heuristic-mapping is too eager (LLM hallucinates mappings for everything); pure top-K comparison fails on hard constraints + uniform-axis cases. The hierarchy uses each tool where it's strongest. Schema-level safety is unchanged: the LLM can only emit existing `PlanMutation` kinds; Tier D's "heuristic" label is metadata about *why* the kind was chosen, not a new mutation.

44. **Solver emits top-K alternative-plan summaries.** During Stage 7, the solver already considers and rejects alternative distributions (Decision #22d's `alternativeDistributionsConsidered`). Currently it picks one by `balanceScore` and discards the rest. Decision #44 keeps the top-K (k=5).

    Schema: `ForwardSchedule.alternativeCandidates?: AlternativePlanSummary[]` (sized ≤5). Each `AlternativePlanSummary` carries: `{planIndex, balanceScore, weightedCreditsByTerm, hardCountByTerm, easyCountByTerm, subjectDistributionByTerm, distinctSubjectsCount, totalPetitionCount, totalAssumptionCount, graduationTerm, topDiffsFromWinner: Array<{aspect, change}>}`. NOT a full `ForwardSchedule` (token budget) — summary metadata only.

    **Section-level extension (OPTIONAL — stretch task in Phase 15, not a Phase 15 acceptance gate):** Decision #18's enumeration of conflict-free section combinations naturally produces multiple options. The same top-K pattern can extend to this layer for unmodeled intra-term preferences ("back-to-back vs. gaps," "hardest class first thing in the morning"). Schema slot is reserved on `MaterializedTermAlternatives[]`. Ship the implementation only if it cleanly fits the `materialize.ts` orchestrator without re-architecting; defer otherwise. Most students don't articulate intra-term preferences; Tier D handles the residual long tail cheaply.

    **Why:** Tier B of Decision #42 needs grounded alternatives, not arbitrary mutation translations. Free byproduct of existing Stage 7 work. Same pattern as Decision #22a (rationale field instead of re-derivation): the solver computes the metric, the agent reads it.

### Phase 15 (decisions 16–20 + 43 + 44[section-level, OPTIONAL])

16. **Per-call FOSE data-availability gate:** each `materialize_sections` invocation classifies the FOSE response as `full` / `partial` / `unavailable`. NOT a static window assumption; we don't assume "registration opens April 20." Each call inspects live response shape.
17. **Instructor names always surfaced:** FOSE returns `instr` (string) per section. Threaded verbatim to the UI. Student picks a section based on (open status + meeting time + instructor name). No instructor-rating overlay.
18. **Time-conflict detection:** two sections conflict if any of their `MeetingPattern`s overlap on the same day. Conflict-free combinations enumerated combinatorially, capped at 50.
19. **Course-swap on FOSE-unavailable:** if a structural-plan course has zero open sections in the target term, the materializer asks the structural solver for a legal alternative; original course defers to a later term. Structural plan persists; only immediate-term placement adjusts.
20. **FOSE TTL cache:** 5-minute in-memory cache per `(termCode, keyword)` query. No persistence.

43. **Scheduling preferences (time/day) are first-class.** Modeled in Phase 15. Reserved-but-unused slot in Phase 14's `SchedulePreferences` type so the mutation array shape doesn't version-skew across phases.

    Schema (Phase-14 type, Phase-15 consumer):
    ```typescript
    interface SchedulingPreferences {
        avoidDays?: Array<{ day: Day; strict: boolean }>;
        avoidTimeWindows?: Array<{ days: Day[]; startMin: number; endMin: number; strict: boolean }>;
        preferTimeWindows?: Array<{ days: Day[]; startMin: number; endMin: number; weight: number }>;
        desiredFreeDay?: { day: "any" | Day; strict: boolean };
        avoidConsecutiveLongBlocks?: boolean;
    }
    type Day = "M" | "Tu" | "W" | "Th" | "F" | "Sa" | "Su";
    ```

    `strict: true` → HARD filter (drops sections); `strict: false` → soft deboost in section ranking. Phase 15's `materialize_sections` applies the filter BEFORE Decision #18's conflict-free combination enumeration (cheaper). When a strict filter eliminates all sections of a course, the Decision #19 cascade fires (clean superset — no new code path, new trigger). New `PlanMutation` kinds `{kind: "setSchedulingPreference", value}` and `{kind: "clearSchedulingPreference"}`.

    The `strict` field is INDEPENDENT from the Tier-A/C routing in Decision #42 — `strict: true` says the FILTER is hard, not that the student framed the preference as non-negotiable for Decision #42 purposes. The two flags are usually correlated (childcare-driven Friday avoidance: `strict=true` AND `framing=hard`) but not coupled at the schema level.

    **Why:** time/day constraints are too frequent for the heuristic-mapping fallback (which is for the long tail). Phase 15's `MeetingPattern` data already supports the filter; adding a preference field is cheap. Many students treat this as a hard constraint (work, childcare, religious observance), so routing through Tier D would force inappropriate refusals.

## What's deferred / out of scope

- **RateMyProfessor / instructor-rating overlay (Phase 16):** SKIPPED. ToS violation risk + poor data density at NYU + 2-year-stale wrappers. Instructor name strings ARE surfaced; rating data is not.
- **NYU CourseEvalPro / Albert internal evaluations:** out of scope. NetID-gated, NYU-policy risk on top of RMP-style ToS risk.
- **Drag-to-reorder slots in sidebar:** Phase 16+.
- **Server-side persistence of `ForwardSchedule` to Postgres:** in-memory only through Phase 15. Phase 16+ if needed.
- **Honors thesis 2-term blocks:** Phase 16+.
- **Study-abroad term modeling:** Phase 16+.
- **CPT / internship credit adjustments:** Phase 16+.
- **Major change mid-stream:** already handled by `update_profile` two-step path; no new work.

## Risk areas worth eyes-on

- **Phase 12.8's LLM-parser regression validation:** must produce IDENTICAL JSON to the 27 curated entries. If parser fails on any of them, iterate on prompt before scaling.
- **Phase 13's solver greedy nature:** Phase 13 ships greedy + slack-based; Phase 15+ may need backtracking for complex prereq chains. Greedy outputs feasibility report so unsolved cases surface explicitly.
- **Phase 14's natural-language preference extraction:** 85% accuracy bar via the eval suite. Lower → iterate on system prompt.
- **Phase 14's 4-tier fallback eval suite:** ≥85% per-tier accuracy across A/B/C/D-positive/D-negative paths (5 buckets, NOT 4). Per-bucket (not just overall) is the gate — without it the LLM can game the metric by always defaulting to one tier. The D-negative bucket (hard-flagged constraints that must NOT be heuristic-mapped) is critical: it enforces the asymmetric-stakes principle behind Tier D's hard-constraint exclusion. Author ≥10 fixture cases per bucket (50+ total).
- **Phase 15's FOSE response shape:** `hours` field format is unknown until Task 0 records real fixtures. Don't design parser blind.
- **Solver-contract leakage during Phases 13/14/15** (gates Phase 15.5 MIP migration cost): `SolverInput → SolverOutput` is the stable boundary for the future MIP-solver swap (see Phase 15.5 stub above). During Phase 13/14/15 reviewer passes, verify NO module outside `solver.ts` imports stage-internal types: `SolverNode`, per-stage helpers (`forwardFeasibilityScreen` internal shapes, Stage-6c/6d/7 helpers), or anything not exported from `@nyupath/shared` as part of the `SolverInput` / `SolverOutput` / `ForwardSchedule` / `FeasibilityReport` / `InfeasibilityReport` / `PlanDiff` surface. If a leak lands, Phase 15.5 migration cost grows from "swap internals (~3–5 days)" to "swap internals + refactor consumers (~7–10 days)." Catching this at review is cheap; catching it later is not. Reviewer's checklist line: `grep -rn "from .*solver/\(types\|stages\|internal\)" packages/` should return zero matches outside `solver.ts` itself.

## When something goes wrong mid-execution

- **Subagent reports `BLOCKED` or `NEEDS_CONTEXT`:** Read its report. If the blocker is a repo-state assumption mismatch (file not found, type field name wrong), update the plan's code to match the real repo and re-dispatch. If the blocker is an architectural ambiguity, escalate to the human operator.
- **Spec-compliance review fails:** the implementer subagent fixes within the same task; re-run the spec reviewer. Don't proceed to the code-quality reviewer until spec is ✅.
- **Code-quality reviewer flags Critical or Important issues:** the implementer subagent fixes; re-review. Don't mark the task complete until all Critical + Important issues are resolved.
- **Manual browser verification reveals a bug:** dispatch a fix subagent for the specific gap; do NOT proceed to the next phase.

## Push policy

Each phase ends with a final commit + push. Don't accumulate multiple phases' worth of unpushed commits — push at the end of each phase so origin reflects the latest stable state.
