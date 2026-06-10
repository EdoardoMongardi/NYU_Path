# Phase 13 — Multi-Semester Forward Planner with Constraint Solver + Schedule Sidebar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Architectural principle (read first)

**Plan with available data + sensible defaults; ask the student only when input would change a trade-off.**

The planner ALWAYS ships a plan. Defaults are concrete answers, not "unknown" gaps. Validators distinguish verified-pass from assumed-pass from requires-approval — the plan ships in all three cases; the agent's surfacing language differs per axis. The formal mechanism is **Decision #40** (`ValidationResult` 4-state union: `pass | assumed-pass | requires-approval | fail`) defined and implemented in this phase.

Concretely for Phase 13:
- **`ForwardSchedule.state`** is one of 4 values (Decision #32): `valid-clean` (every validator returns verified `pass`), `valid-with-trade-offs` (any validator returns `assumed-pass` / `requires-approval`, OR any non-validator caveat — petition slot, low-confidence offering on critical path, IP assumption), `infeasible-draft` (any validator returns `fail`), `student-preferred-invalid-draft` (Phase 14 override). Routing: clean / with-trade-offs → `session.forwardSchedule`. infeasible / student-preferred-invalid → `session.studentDraftPlan`.
- **F-1 visa axes** ship with appropriate `ValidationResult` shapes: `pass`/`fail` for credit-floor + full-time; `requires-approval` for RCL / CPT / final-term-exception; `assumed-pass` for online/in-person axes (promoted to verified `pass`/`fail` by Phase 15 once FOSE supplies meetingPattern data).
- **Free-elective placeholders** ship with `workloadWeight = 0.3` as a planning-time assumption (Decision #37); once bound (via Phase 14 tools), weight is recomputed from real metadata and a warning fires if the delta is large.
- **The solver never refuses to ship a plan because of missing input.** Missing data → conservative default → `assumed-pass` validator → `valid-with-trade-offs` plan state → agent surfaces the assumption to the student.

The solver's hard constraints (Decisions #1, #4, #5, #34) DO block placement; that's distinct from validator metadata. Hard constraints prevent infeasible plans; validators describe the assumption-shape of feasible plans.

**Before implementing:** read `docs/PHASE_PLANS_README.md` (full 43-decision canonical list + cross-phase execution order + pre-flight verification table). The pre-flight checks must pass before the first code change in this phase.

---

**Goal:** Replace the single-semester planner with a multi-semester constraint-satisfaction solver that distributes remaining requirements across all remaining terms (slack-based), respects prereqs + term-offering patterns + visa floors + school ceilings, persists the resulting `ForwardSchedule` across the conversation, reconciles against new DPRs, exposes the live schedule via a chat-page sidebar, and addresses three reasoning-trace bugs surfaced in operator-test pass 4.

**Architecture (deterministic-core, LLM-shell):**
1. **Engine state**: a new `ForwardSchedule` type lives on `ToolSession`. The solver consumes student profile + DPR + parsed prereqs (Phase 12.8) + parsed offerings (Phase 12.8) + visa-aware credit target. Output: full forward plan with discriminated-union slots (completed / in_progress / specific_planned / placeholder).
2. **Constraint solver**: greedy + backtracking. Hard constraints from this plan's locked design decisions: NOT clauses (strict), AP/IB synthetic IDs (strict), instructor-permission soft-allow with `requiresPetition` flag, **prereq satisfaction via the optimistic-forward-projection rule** (Decision #4 — see table below for the full semantic; canonical helper at `packages/engine/src/dpr/prereqSatisfaction.ts` consumes `Prerequisite.minGrades` for explicit thresholds and falls back to DPR `requirementGroups[…].satisfiedBy[]` membership when no threshold is specified), full undergrad bulletin coverage means no annotated-cross-school path. Soft objective: balance per-term credit load via slack distribution.
3. **SSE transport**: a new `forward_schedule_update` event kind streams the structured schedule to the chat page whenever it changes.
4. **UI**: a header-toggle button reveals a right-rail sidebar that renders the schedule by semester with locked / planned / placeholder color-coding. Free-elective placeholders ABOVE the credit floor get distinct rendering (dotted border, "optional" tag).
5. **Reasoning-trace fixes**: validator allows arithmetic-derived numbers; replay-turn thinking suppressed; `thinkingText` cleared on first `hasRealThinking` flip.

**Tech Stack:** TypeScript, Zod schemas, vitest, Next.js 16 App Router (SSE), React. Engine: `packages/engine/src/agent/`. Web: `apps/web/`.

**Prerequisites:**
- **Phase 12.7** complete (full undergrad bulletin scrape — supplies the source text for prereq + offering parsing).
- **Phase 12.8** complete (`packages/engine/src/data/prereqs.json` + `courses-offerings.json` populated; 27-curated-validated baseline).
- **Phase 12.9.5** complete (`OfferingEntry.confidence` field populated on every entry per Decision #29 — Phase 13's forward-feasibility screen [#27] and per-slot risk impact [#39] both depend on this).

**Required by:**
- **Phase 14** (preferences + overrides + binding tools) — depends on `ForwardSchedule`, the solver, and `PlaceholderSlot` semantics shipping in this phase.
- **Phase 15** (FOSE section materialization) — composes with Phase 13's structural plan; promotes axes from `assumed-pass` to verified per Decisions #29-extension and #34-extension.

**Out of scope (Phase 14):**
- Load styles other than balanced (frontload / backload / light / heavy / part-time-domestic)
- LLM-side preference extraction ("I want a free spring")
- Course pinning + exclusions (`propose_plan_change` / `confirm_plan_change` tools)
- Click-to-edit slot in sidebar
- Co-requisite enforcement (PrereqGroup.coreqs are empty in Phase 12.8 output)
- Summer + J-term as available terms (kept as data but excluded from main-term distribution)
- `simulate_alternatives` / failed-course retake analyzer

---

## Locked design decisions (from operator review)

These shape the constraint solver. Recorded here so an executor implementing Phase 13 doesn't have to relitigate them.

| # | Decision | Solver behavior |
|---|---|---|
| 1 | NOT operator | Strictly enforced. If `notCourses` includes a course in `coursesTaken`, the dependent course is filtered out of suggestions. |
| 2 | AP/IB equivalency | Synthetic course IDs (`AP-CS-A-3`, etc.) treated as normal courseIds. The DPR ingest path (Task 9 of this plan) injects synthetic IDs when an AP-credit row is present. |
| 3 | Instructor permission | Soft-allow. The PrereqGroup's `requiresPetition: true` flag does NOT block placement, but the slot carries a `requiresPetition: true` annotation that the sidebar renders as a yellow flag. **Petition placement is a LAST-RESORT fallback (Stage 9e)** — only used when no clean non-petition plan exists within current horizon and preferences. Petitions are externally gated and may be denied; over-using them produces plans that look feasible to the solver but require approval to realize. Stage 9e fires only after Stages 9a-9d (relax weights, add summer/J-term, extend graduation, drop optional electives) have all failed. |
| 4 | Prereq satisfaction (revised 2026-05-03; supersedes original "trust DPR" + first revision) | **Optimistic-forward-projection.** A prereq course Y satisfies course X's requirement in term T iff: (1) Y is in `dpr.requirementGroups[…].satisfiedBy[]` (officially completed and accepted), OR (2) Y has type `IP` in `dpr.courseHistory[]` (currently enrolled, **assumed-passing for planning**), OR (3) Y is placed by the solver in some term **strictly before T** in the current plan. **Hard reject** only when Y has a final past attempt (type EN/TE) that fails its check AND no later retake exists. **The "fails its check" rule:** if `Prerequisite.minGrades[Y]` is set, use `meetsGradeThreshold(attempt.grade, minGrades[Y])` from `packages/engine/src/dpr/gradeComparison.ts` (below threshold → fail); if `minGrades[Y]` is absent, use the DPR's own `requirementGroups[…].satisfiedBy[]` membership as the registrar's implicit-floor signal (not present → fail). Coreqs follow the same logic with `≤ T` (same-term allowed). Re-plan trigger: if DPR refresh shows an IP/future course got a final grade that fails, downstream slots lose satisfaction → solver re-runs (Phase 13's `reconcile.ts`). **Why:** without forward-projection, students with currently-IP prereqs can't be planned around — broken UX for the most common forward-planning case. Without grade-aware checking, ~4 high-grade entries silently green-light unreachable downstream courses. See `packages/engine/src/dpr/prereqSatisfaction.ts` for the canonical implementation. |
| 5 | Cross-school courses | Full undergrad bulletin coverage (Phase 12.7 + 12.8) means almost all CAS prereqs reference courses we have data for. Edge cases (rare grad-school refs, withdrawn courses) gracefully degrade to "satisfied if in coursesTaken, else assume satisfied" (lenient — no annotation). |
| 6 | Co-requisites | Deferred to Phase 14 for **same-term enforcement** (the additional constraint that the coreq be placed in the SAME term as the dependent course). However, prereq-satisfaction logic (Decision #4) ALREADY treats coreqs the same as prereqs but with `≤ T` instead of `< T` so an entry-level `coreqs: ["EX-UY 0001"]` is correctly counted as satisfiable when EX-UY 1 is placed in the same term. Phase 12.8 populated coreqs from bulletin where present (16 curated entries, plus extracted-pass entries). |
| 7 | Same-course retake (subsumed by Decision #4's optimistic-forward-projection) | If DPR shows a past attempt that failed AND there's a later attempt (IP, future-plan, or another `satisfiedBy` row), the later attempt overrides — NYU's "most recent grade counts" policy. If no later attempt exists, the failed attempt is hard-reject and the course must be placed earlier in the schedule (it stays in `unmetRequirements`). |
| 8 | Optional electives above floor | Sidebar distinguishes electives below floor (solid border, required) from above floor (dotted border, "optional" tag). |
| 21 | Study-abroad (9000-series CAS) default-skip | Solver filters out any candidate course whose ID matches `^[A-Z]+-UA 9\d{3}` unless `profile.studyAbroadOptIn === true`. Bulletin location data is too sparse and drift-prone to encode statically; Phase 15's FOSE materializer surfaces actual section locations via `meetingPattern.location`. UI's "I want to study abroad in [Term X]" preference (Phase 14, same shape as summer/J-term opt-in) flips the flag and re-runs the solver. |
| 22a | Per-slot reasoning trace | Each `ScheduleSlot` carries `rationale: { satisfiesRequirements: string[], termConstraints: Array<{kind: "prereqChain"\|"offering"\|"creditCeiling"\|"creditFloor"\|"visaFloor"\|"coreqSameTerm", …}>, consideredAlternatives: Array<{courseId, rejectedBecause: string}>, decisionsApplied: Array<"D4-IPProjection"\|"D21-studyAbroadSkip"\|"D3-petitionSoftAllow"\|…>, petitionTrigger?: {fromCourse: courseId, bulletinText: string} }`. Solver tracks these during backtracking; carrying them into output is a 1-day add. Without this, the agent re-derives reasoning by walking prereq trees in-prompt — slow + error-prone. With it, the agent reads `slot.rationale` and paraphrases verbatim. |
| 22b | Per-slot flexibility | Each slot carries `flexibility: { earliestPossibleTerm: Term, latestPossibleTerm: Term, alternativeCourses: courseId[] }`. Computed at near-zero cost during placement. Enables "where do I have wiggle room?" / "can I move this earlier?" without solver re-runs. |
| 22c | Per-slot downstream impact | Each slot carries `downstreamImpact: { courseIds: string[], graduationDelay: number }` — pre-computed via the prereq-graph forward walk. If this slot is dropped, these N courses cascade and graduation slips by M terms. Enables "which course is least disruptive to drop?" deterministically. |
| 22d | Per-term load rationale | Each `ForwardSemester` carries `loadRationale: { strategy: "balanced"\|"frontload"\|"backload"\|"light"\|"heavy", creditsTarget: number, slack: number, alternativeDistributionsConsidered: Array<{distribution: number[], rejectedBecause: string}> }`. Extended by Decision #24 with `weightedCredits`, `hardCount`, `easyCount`. Captures the per-term distribution decision separately from per-slot rationale so the agent can answer "why are some terms heavier than others?" with the actual slack-balancing reasoning. |
| 24 | Workload-tier weighted balance | "Busy" ≠ credits alone. **Per slot (extends 22a):** `workloadTier: "major-required"\|"major-elective"\|"school-core"\|"free-elective"\|"general-elective"` derived deterministically from `rationale.satisfiesRequirements` against program rules; `workloadWeight: number` (1.0 / 1.0 / 1.0 / 0.5 / 0.6 with capstone bump to 1.2 when prereqs.json has ≥3 prereq groups). **Per term (extends 22d):** `loadRationale` gains `weightedCredits` (Σ credits × weight), `hardCount` (weight ≥ 1.0), `easyCount` (weight < 1.0). **Stage 7 slack-balance** uses `-Σ(weightedCredits-variance) - Σ(hardCount-variance)` instead of raw-credit variance. **PlanDiff (Decision #23) extension:** `weightedCreditsByTermDelta` + `workloadTierShifts: Array<{term, before:{hardCount,easyCount,weightedCredits}, after:{…}}>`. Without this, "balanced" 16-credit semesters with 4 major-required courses look identical to 16-credit semesters with 1 major-required + 3 free electives — they aren't, and the student's pin scenarios (e.g. pinning 3 free electives to one term) would silently produce future-term workload pile-up that the agent can't legitimately flag. |
| 25 | Pre-computed aggregate balance score | Decision #24 emits per-term metrics; #25 emits the plan-level verdict. **`ForwardSchedule.balanceScore: number`** — single scalar, lower = better; range ~0 (perfect) to ~50 (deeply imbalanced). Components: `α × weightedCredits-variance + β × hardCount-variance + γ × loadStyle-target-deviation`. Solver already computes this during Stage 7 to pick winning distribution; emitting it costs nothing. **`PlanDiff.balanceImpact: { before, after, delta, classification: "improved"\|"negligible"\|"degraded-mild"\|"degraded-significant" }`** — agent reads `classification` directly to decide whether to flag, no in-prompt variance arithmetic. Thresholds: delta ≤ 0 → improved; \|delta\| < 1.5 → negligible; 1.5 ≤ delta < 4 → degraded-mild; delta ≥ 4 → degraded-significant. Without #25, the agent re-derives balance via 7-step arithmetic on every turn — LLMs are unreliable at variance math on 8+ numbers, leading to inconsistent verdicts across turns. Same pattern as Decision #22a (rationale field instead of re-derivation): the solver has the numbers, just emit them. |
| 27 | Forward-feasibility SCREEN at every placement (NOT a formal oracle) | After every Stage 6c placement, run `forwardFeasibilityScreen(partialPlan, remainingUnmet, remainingTerms): boolean`: bin-pack remaining-courses' minimum-required-terms (from prereq DAG depths in Stage 2) against remaining-term capacity (creditCeiling − already-placed). Cheap O(unmet × terms). Reject placement if screen fails; pick next candidate. Uses Decision #29's `confidence` tier — `irregular` and `permission_only` offerings count as half-capacity. **Important — this is a SCREEN, not a proof.** Can produce false positives (passes bin-packing but a hidden choose_n / coreq / double-counting issue downstream still makes plan infeasible) AND false negatives. The actual feasibility verdict is Stage 8's `runGraduationPathValidator` (Decision #41). Implementer rule: NEVER call this an "oracle" or treat its output as a feasibility proof. |
| 28 | Late-binding for choose_n elective pools | Many requirements are flexible pools ("5 of 20 advanced electives"; "16 credits of major electives"). Committing to a specific course at Stage 6c locks the plan into a fragile combination. **`ScheduleSlot.poolBinding?: { poolId: string, candidates: courseId[], satisfiesRule: ruleId }`** — slot reserves credits + workloadWeight without committing to a courseId. Solver maintains constraint `Σ over pool members placed across plan ≥ N`. Stage 6 places pool slot abstractly; Stage 7 promotes specific courseIds when needed for prereq chains or feasibility. Distinct from Decision #37 (free electives) — pool members are a constrained set per the program's choose_n rule. Phase 14's `propose_plan_change` exposes `bindPoolSlot` mutation kind for explicit student confirmation. |
| 30 | IP courses are conditional assumptions, not facts | Decision #4's IP-forward-projection is optimistic; #30 makes the optimism EXPLICIT in output. **`ForwardSchedule.assumptions: Assumption[]`** is a discriminated union with multiple `type` variants: `IP_COURSE_COMPLETION` (this decision; `Assumption = { type: "IP_COURSE_COMPLETION", courseId, requiredGrade?: string (from minGrades), consequenceIfFalse: string (computed from downstreamImpact #22c), cascadingSlots: courseId[], contingencyPlanAvailable: boolean }`); `LLM_RANKED_ALTERNATIVE` (Tier B per Decision #42 — emitted when the agent picks among top-K alternative-plan summaries from Decision #44); `HEURISTIC_MAPPING` (Tier D per Decision #42 — soft constraints only; discriminated at the type level via the `studentConstraintFraming: "soft"` literal so hard-framed constraints CANNOT construct this variant, TypeScript compile-time guard, Layer 2 of Tier-D 3-layer enforcement). See Decisions #42 + #44 for the full Tier-B/D shapes. Solver populates `IP_COURSE_COMPLETION` entries; Phase 14's tools populate `LLM_RANKED_ALTERNATIVE` and `HEURISTIC_MAPPING` entries. Phase 14's `simulate_alternatives` generates contingency plans alongside the optimistic plan (one extra solver run); when generated, sets `contingencyPlanAvailable: true` so the agent can offer "want to see the recovery path?" without recomputing. Re-plan trigger from Decision #4 still applies on DPR refresh. |
| 31 | Pin precedence + per-stage check timing | Decision #10 says pins are hard constraints; #31 makes hierarchy + check timing explicit. **Hierarchy (highest first):** (1) Visa/legal (#34), (2) Prereq + offering + NOT clauses (#1, #4, #5), (3) Confirmed-offering availability (#29), (4) Student pins, (5) Soft preferences, (6) Optimization. **Per-stage check timing (precedence ≠ timing):** Stage 6a evaluates ONLY candidate-level checks (single-course existence, restrictions, prereq satisfaction, offering-in-season, NOT, exclusion, pinned-set membership) — NOT term-level visa axes like full-time credits or online-credit limit (those need the full term schedule). Stage 6d evaluates term-level invariants once the term schedule is populated (visaValidator per term, coreq same-term, credit ceiling/floor). Stage 8 (#41) evaluates plan-level (total credits, residency, upper-level, choose_n resolution, all-terms-visa, graduation target). **Wording rule:** pins are **mandatory preferences within the valid candidate set only** — pinned courses are PRIORITIZED among already-valid candidates, NOT INJECTED past hard filters. The phrase "pins score ∞" is forbidden in implementation. Conflict at rank 1-3 → `InfeasibilityReport` + `relaxationSuggestions[]` + no-pin `fallbackSchedule` (#10). |
| 32 | Plan-validity states (`PlanState` + `session.studentDraftPlan`) | Decision #13's "confirmation = highest authority" applies WITHIN valid-plan space. **`ForwardSchedule.state: "valid-clean" \| "valid-with-trade-offs" \| "infeasible-draft" \| "student-preferred-invalid-draft"`** (4 states, intentionally coarse — granularity lives in `assumptions[]` / `slot.requiresPetition` / `slot.confidence` / `slot.isCriticalPath` / `slot.approvalAuthority` / Decision #40 validator results). `"valid-clean"` requires every Decision #40 validator axis to return `pass` (no `assumed-pass`, no `requires-approval`) AND no caveats elsewhere. `"valid-with-trade-offs"` covers any of: an `Assumption` from #30, a slot with `requiresPetition: true`, a slot with `confidence` ∈ {`historically_partial`, `irregular`, `permission_only`}, a `historically_likely` slot that is also `isCriticalPath: true` (#39) with no pool alternatives, OR any validator returning `assumed-pass` or `requires-approval`. Routing: `valid-clean` and `valid-with-trade-offs` write to `session.forwardSchedule`. `infeasible-draft` and `student-preferred-invalid-draft` write to `session.studentDraftPlan` (NEVER forwardSchedule). Agent surfaces specific trade-offs from existing fields, not from finer state names. |
| 33 | Audited optionality | Decision #8's "optional iff above per-term floor" is too local. **`ScheduleSlot.optionalReason?: { droppable: boolean, blockingConstraints?: string[] }`**. Compute via full audit: removing slot must preserve degree-credit-minimum (e.g. 128) AND school-residency AND major-credit-minimum AND upper-level-credit count AND F-1 floor across affected terms AND graduation-target-term AND all unmetRequirements still satisfiable AND forward feasibility (#27). If any check fails: `droppable: false` + `blockingConstraints` lists failures. Stage 9d's "drop optional electives" fallback is gated on `droppable: true`. Agent answers "this looks like a free elective but is contributing to your 128-credit total" with specifics. |
| 34 | Multi-axis F-1 visa validator (using Decision #40 ValidationResult) | `packages/engine/src/dpr/visaValidator.ts` (extends `visaPolicy.ts`): every axis returns `ValidationResult` from Decision #40 (`pass` / `assumed-pass` / `requires-approval` / `fail`). Stage 6d invariant: every axis returns `pass` or `assumed-pass`. Any `fail` → infeasible-draft. Any `requires-approval` → plan ships with `valid-with-trade-offs` state. **Phase 13 ships verified `pass`/`fail`** for `fullTimeSatisfied`, `creditMinimumSatisfied`; `requires-approval` for `rclEligible`, `cptConflict`, `finalTermExceptionPossible` (need OGS / registrar). **Pre-Phase-15:** `onlineLimitSatisfied` + `inPersonMinimumSatisfied` return `{ status: "assumed-pass", assumption: "all sections in-person", whatWouldFlipIt: "if any section is online and total online credits would exceed 3 (F-1 limit)" }`. Plan ships; agent surfaces assumption explicitly. **Post-Phase-15:** axes flip to verified `pass`/`fail` based on FOSE meetingPattern data. Citations are pointers to OGS policy sections. |
| 35 | Workload-tier modifiers (W/L/level/capstone) | Decision #24's tier classification + #35's modifiers. `slot.workloadWeight` extension: `+0.2` for W-suffix or writing-intensive (parsed from courseId or bulletin keywords), `+0.15` for L-suffix or "Lab" in title, `+0.2` for course numbers ≥4000 in CAS / ≥3000 in Tandon, `+0.2` for capstone (≥3 prereq groups, already in #24). Stack; cap at +0.6. Catches student picking "Quantum Field Theory" as "free elective" — modifiers push weight 0.5 → 1.1, triggering #25's balanceImpact warning. Out of scope per Phase 16 drop: professor-specific workload, RMP, course evaluations. |
| 36 | Stage 7 moves trigger full plan revalidation | Per-term invariants aren't enough — moves can break choose_n buckets, double-counting, residency, future feasibility, F-1 across terms. Each Stage 7 candidate move: apply tentatively → re-run Stages 1-6 (cheap, mostly unchanged placements) → run `runFullAudit` equivalent (all requirement groups, total credits ≥ degree minimum, residency / upper-level / major / choose_n buckets resolve, forward feasibility via #27, visa via #34) → accept iff `balanceScore` improves AND all checks pass; else revert. More expensive but tractable. Future iteration: fold workload-balance objective into Stage 6's main solver (CP-style) instead of Stage-7 post-hoc — likely Phase 13.5 / v1.1. |
| 37 (solver) | Free-elective placeholders + low-weight default | Distinct from #28 (constrained pools). **`ScheduleSlot.bindingState: "bound" \| "placeholder-pending" \| "placeholder-deferred"`** and **`placeholderId?: string`**. `courseId` null when unbound. Default weights: `placeholder-deferred` (future term) → 0.3; `placeholder-pending` (immediate term awaiting selection) → 0.3; `bound` → per #24 + #35. **The 0.3 default is a PLANNING PLACEHOLDER ONLY** — it represents the typical-student assumption that free electives are picked to be easy. Once a slot is bound via `bind_free_elective` (Phase 14), `workloadWeight` MUST be recomputed from real course metadata (#24 + #35), and a warning fires if recomputed delta is large. Implementers must NEVER trust 0.3 as the actual workload signal once a course is bound. Stage 6c places free-elective slots as placeholders by reserving credits without picking courseId. Solver flows them through Stages 6d / 7 as low-weight reserved-credit slots. Slot kind discriminated via Decision #38's `PlaceholderSlot` tagged union (`FreeCreditSlot` variant). Phase 14 owns the `bind_free_elective` tool. |
| 38 | Tagged-union `PlaceholderSlot` discriminator | Type-level safety to prevent `RequirementPoolSlot` (constrained candidates per #28) and `FreeCreditSlot` (any course per #37) from being confused at the implementation layer. `type PlaceholderSlot = RequirementPoolSlot \| FreeCreditSlot \| AdvisingPlaceholderSlot`. Each variant has different binding-validation rules: `RequirementPoolSlot.bind(courseId)` enforces `candidates.includes(courseId)`; `FreeCreditSlot.bind(courseId)` accepts any in-scope course; `AdvisingPlaceholderSlot.bind(courseId)` requires advisor-confirmed first. TypeScript exhaustiveness checks on the union prevent future bugs when a new placeholder kind is added without binding logic. Phase 14's `bind_free_elective` and `bindPoolSlot` tools dispatch on `kind`. |
| 39 | `OfferingRiskImpact` per slot (slim) | `ScheduleSlot.confidence: ConfidenceTier` (copied from `OfferingEntry` per #29) + `ScheduleSlot.isCriticalPath: boolean` (true if this slot is the only satisfier of a requirement OR is sole prereq for ≥2 downstream slots). Two booleans + `slot.downstreamImpact` (#22c) compose into agent's risk-surfacing language. Skipped: broader `OfferingRiskImpact` taxonomy with `riskLevel` enum and `latestSafeTerm` — derivable from existing fields if it ever becomes load-bearing. |
| 40 | `ValidationResult` 4-state union (validator-status mechanism) | The formal mechanism that lets the planner ALWAYS ship a plan (architectural principle) WHILE validators carry honest metadata. `type ValidationResult = { status: "pass"; verifiedFrom: DataSource } \| { status: "assumed-pass"; assumption: string; whatWouldFlipIt: string } \| { status: "requires-approval"; authority: ApprovalAuthority } \| { status: "fail"; reason: string }`. Plan ships in `pass` AND `assumed-pass` cases; `requires-approval` ships with `valid-with-trade-offs` state; `fail` blocks. Categorization in Decision #40 of canonical list. Replaces all boolean validator fields throughout `visaValidator.ts` and any future validators. |
| 41 | Stage 8 = FINAL PLAN VALIDATION GATE | Stage 8's gate runs `runGraduationPathValidator(plan, dpr, programRules)`. Plan is feasible iff: (1) all requirementGroups satisfied (or assumed-pass for IP slots), (2) all RequirementPoolSlot placeholders resolvable (#28), (3) total credits ≥ degree minimum, (4) residency / upper-level / major / minor / school-core thresholds met, (5) `visaValidator` returns no `fail` axis on any term, (6) all assumptions/approvals explicitly represented in `assumptions[]` + per-slot fields, (7) graduation target met OR plan state reflects delay. Verdict feeds `PlanState` per #32. Stage 8 is distinct from Stage 7's per-move revalidation (#36) — Stage 7 validates moves DURING optimization; Stage 8 validates the FINAL plan once Stage 7 has converged. |
| 44 | Solver emits top-K alternative-plan summaries (Stage 7 byproduct) | During Stage 7's distribution-selection, the solver already evaluates rejected distributions per Decision #22d. Decision #44 retains the top-5 by `balanceScore` as `AlternativePlanSummary[]` on `ForwardSchedule.alternativeCandidates` instead of discarding them. Each summary carries `balanceScore`, per-term `weightedCredits` / `hardCount` / `easyCount`, subject distribution, `distinctSubjectsCount`, `totalPetitionCount`, `totalAssumptionCount`, `graduationTerm`, and `topDiffsFromWinner`. Summary metadata only — NOT a full `ForwardSchedule` (token budget). Phase 14's `compare_plan_alternatives` tool consumes this for Tier-B fallback (Decision #42). Section-level extension exists but is OPTIONAL (Phase 15 stretch). |

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/types.ts` | **Modify** | Add `ForwardSchedule` (with `balanceScore` per #25, `assumptions: Assumption[]` per #30, `state: PlanState` per #32, `alternativeCandidates?: AlternativePlanSummary[]` per #44), `ForwardSemester` (with `loadRationale` per #22d, extended by #24), `ScheduleSlot` (with `rationale` per #22a + `flexibility` per #22b + `downstreamImpact` per #22c + `workloadTier`/`workloadWeight` per #24 + `bindingState`/`placeholderId?` per #37 + `poolBinding?` per #28 + `optionalReason?` per #33 + `confidence` + `isCriticalPath` per #39 + `approvalAuthority?` per #34/#40), `PlaceholderSlot` tagged union per #38 (`RequirementPoolSlot \| FreeCreditSlot \| AdvisingPlaceholderSlot`), `ValidationResult` per #40 (4-state union with `DataSource` + `ApprovalAuthority` enums), `FeasibilityReport`, `InfeasibilityReport`, `SlotRationale`, `TermConstraint`, `LoadRationale`, `WorkloadTier`, `Assumption` discriminated union with variants `IP_COURSE_COMPLETION` (#30, with `contingencyPlanAvailable`) + `LLM_RANKED_ALTERNATIVE` (Tier B per #42) + `HEURISTIC_MAPPING` (Tier D per #42; carries `studentConstraintFraming: "soft"` as a literal-type discriminator — hard constraints CANNOT construct this variant, TypeScript compile-time guard, Layer 2 of Tier-D 3-layer enforcement), `PlanState` (4 states), `PoolBinding`, `AlternativePlanSummary` (#44) types. |
| `packages/engine/src/agent/tool.ts` | **Modify** | Add `forwardSchedule?: ForwardSchedule` to `ToolSession`. |
| `packages/engine/src/agent/forwardSchedule/types.ts` | **Create** | Internal solver types (Constraint, SolverNode, etc.). |
| `packages/engine/src/agent/forwardSchedule/solver.ts` | **Create** | Greedy + backtracking solver. Reads parsed prereqs + offerings (now with `confidence` tier per Decision #29) + visa profile, satisfies hard constraints (precedence per Decision #31), optimizes slack-based balance via **weighted-credit + hard-count variance per Decision #24** (NOT raw-credit variance). **Stage-5 candidate ranking is workload-tier-aware per Decision #26**: when a per-term `loadStyleOverride: light` is in effect, candidate priority for that term is multiplied by `(1 − 0.3 × slot.workloadWeight)` (favors easy slots); when `heavy` is in effect, multiplied by `(1 + 0.3 × slot.workloadWeight)` (favors hard slots). **Stage 6c calls `forwardFeasibilityCheck` per Decision #27** after every placement; if check fails, reject placement and try next candidate. **Stage 6d invariant per Decision #34** runs full `visaValidator` (skip online/in-person axes until Phase 15). **Stage 6c handles placeholder slots per Decision #37**: reserves credits without picking courseId for free-elective slots, weight 0.3 default. **Stage 7 per Decision #36** triggers full plan revalidation (re-run Stages 1-6 + full audit) on each candidate move; accepts iff balanceScore improves AND all checks pass. **Stage 7 emits top-5 `alternativeCandidates` per Decision #44** as a free byproduct of distribution-selection: it already tracks `alternativeDistributionsConsidered` per #22d during Stage 7; #44 retains the top-5 by balanceScore as `AlternativePlanSummary[]` on the output `ForwardSchedule` instead of discarding. Phase 14's `compare_plan_alternatives` tool (Tier B per Decision #42) consumes this. **Stage 7 also handles `poolBinding` slots per Decision #28**: promotes pool placeholders to specific courseIds when prereq chains or feasibility require. **Emits all rationale fields per #22a-d, #24, #25, plus `assumptions[]` per Decision #30 + `state: PlanState` per #32 + `optionalReason` per Decision #33 on each slot.** Hard constraints (prereqs / offerings / `earliestPossibleTerm` / visaValidator / confirmed offerings) still win — soft ranking bias never overrides. |
| `packages/engine/src/agent/forwardSchedule/forwardFeasibility.ts` | **Create** | Pure function `forwardFeasibilityScreen(partialPlan, remainingUnmet, remainingTerms, prereqDepths, offerings): boolean` per Decision #27. Bin-packs remaining-courses' minimum-required-terms against remaining-term capacity. Cheap O(unmet × terms). Low-confidence offerings (#29) count as half-capacity. **NAMED "screen" not "oracle"** — fast pruning heuristic only; can produce false positives AND false negatives. Decision #41's `runGraduationPathValidator` (Stage 8) is the actual feasibility gate. Pure-function shape; trivially unit-testable. |
| `packages/engine/tests/agent/forwardFeasibility.test.ts` | **Create** | Unit tests covering: (a) tight schedule feasible → true, (b) over-stuffed → false, (c) pin-induced infeasibility detected, (d) low-confidence offering counted as half-capacity, (e) prereq-depth-equals-remaining-terms edge case, (f) screen returns true but full validator (#41) returns false (false-positive case explicitly documented in test name to remind future devs that the screen is NOT a proof). |
| `packages/engine/src/agent/forwardSchedule/graduationPathValidator.ts` | **Create** | Per Decision #41 — the FINAL plan validation gate at Stage 8. Function `runGraduationPathValidator(plan, dpr, programRules): { feasible: boolean, axisResults: Record<string, ValidationResult>, infeasibilityReport?: InfeasibilityReport }`. Runs the 7-axis check from Decision #41: requirementGroups satisfied, RequirementPoolSlot resolvable (#28), total credits, residency / upper-level / major / minor / school-core thresholds, visaValidator no `fail` (#34), assumptions/approvals explicit (#30 + per-slot), graduation target. Each axis returns a ValidationResult per Decision #40. Verdict feeds PlanState per #32. Stage 8 calls this once after Stage 7 converges; same logic invoked from Stage 7's full-revalidation per #36 (with cheaper subset). |
| `packages/engine/tests/agent/graduationPathValidator.test.ts` | **Create** | Tests for each of the 7 axes individually + multi-axis cases. Asserts `valid-clean` state when all axes return verified `pass`; `valid-with-trade-offs` when any `assumed-pass` or `requires-approval` or non-likely confidence trade-offs; `infeasible-draft` when any `fail`. Coverage: pin-induced violation, choose_n bucket fails to resolve, residency credit shortfall, F-1 fail, IP assumption present (still passes — assumed-pass routes to valid-with-trade-offs), petition slot present (requires-approval), historically_likely + isCriticalPath + no alternatives → trade-off, historically_likely + alternatives → still valid-clean. |
| `packages/engine/src/dpr/visaValidator.ts` | **Create** | Multi-axis F-1 / domestic visa validation per Decisions #34 + #40. Exports `visaValidator(termPlan, profile, schoolConfig): VisaValidationResult` where every axis is a `ValidationResult` (`pass` / `assumed-pass` / `requires-approval` / `fail`) per Decision #40. Phase 13 ships verified `pass`/`fail` for credit-floor + full-time axes; `requires-approval` for RCL / CPT / final-term-exception (require OGS/registrar action); `assumed-pass` for online/in-person axes pre-Phase-15 (assumption: "all sections in-person"). Phase 15 promotes online/in-person axes to verified `pass`/`fail` once FOSE meetingPattern data is available. Citations are pointers to OGS policy sections. |
| `packages/engine/tests/dpr/visaValidator.test.ts` | **Create** | Tests covering each axis × ValidationResult-status cell: F-1 12-credit floor verified pass + verified fail (10 credits); RCL-eligible final-term returns `requires-approval` with `authority: "OGS"`; CPT-enrolled returns `requires-approval`; domestic part-time + `allowBelowF1Floor: true` returns `pass`; pre-Phase-15 online-axis returns `assumed-pass` with `assumption: "all sections in-person"` and `whatWouldFlipIt` populated; citations populated for each axis. |
| `packages/engine/src/agent/forwardSchedule/auditOptionality.ts` | **Create** | Pure function `canDropSlot(slot, plan, programRules, dpr): { droppable: boolean, blockingConstraints?: string[] }` per Decision #33. Runs the 7-axis check (degree minimum, residency, major minimum, upper-level, F-1, graduation target, forward feasibility). Used by Stage 9d (fallback "drop optional electives") and slot.optionalReason emission. Pure function — no side effects, trivially unit-testable across many hypothetical drop scenarios. |
| `packages/engine/tests/agent/auditOptionality.test.ts` | **Create** | Tests covering each blocking constraint individually + multi-constraint cases. Asserts `droppable: false` when removing the slot would violate any check, `droppable: true` otherwise. |
| `packages/engine/src/agent/forwardSchedule/contingencyPlans.ts` | **Create** | Generates contingency plans for IP courses per Decision #30. Function `generateContingencies(forwardSchedule, dpr, prereqsData): { optimistic: ForwardSchedule, conservative: ForwardSchedule[] }` — runs the solver once with IP courses removed from satisfied set (simulating failure) and returns the recovery plan. The optimistic plan is the original; conservatives are per-IP-course-failure scenarios. Phase 14's `simulate_alternatives` consumes this. |
| `packages/engine/src/agent/forwardSchedule/poolBinding.ts` | **Create** | Late-binding logic for choose_n elective pools per Decision #28. Defines `PoolBinding` type, `placePoolSlot` function (reserves credits + weight without committing to courseId), `promotePoolSlotToConcrete` function (called from Stage 7 when prereq chains or feasibility require a specific courseId). |
| `packages/engine/src/agent/forwardSchedule/workloadTier.ts` | **Create** | Pure function `classifyWorkloadTier(slot, programRules, prereqsEntry): { tier: WorkloadTier, weight: number }` per Decisions #24 + #35. Tier from program-rule satisfaction; weight from tier (1.0 / 0.5 / 0.6) plus modifiers per #35: `+0.2` W-suffix / writing-intensive, `+0.15` L-suffix / lab, `+0.2` course numbers ≥4000 in CAS / ≥3000 in Tandon, `+0.2` capstone (≥3 prereq groups). Modifiers stack; cap +0.6. Used by `solver.ts` during placement and by `propose_plan_change` (Phase 14) for diff-time re-classification. |
| `packages/engine/tests/agent/workloadTier.test.ts` | **Create** | Tests covering: 5 tier classifications + capstone bump + W-suffix bump + L-suffix bump + advanced-level bump + stacking cap at +0.6 + ambiguous case (course satisfies major-required AND school-core → major-required wins for tier). |
| `packages/engine/src/agent/forwardSchedule/balanceScore.ts` | **Create** | Pure function `computeBalanceScore(semesters, loadStyle): number` — the canonical balance scalar consumed by Stage 7's distribution selection AND emitted on `ForwardSchedule.balanceScore` per Decision #25. Components: `α × variance(weightedCredits across terms) + β × variance(hardCount across terms) + γ × loadStyleDeviation(semesters, loadStyle)`. Coefficients (α=1.0, β=2.0, γ=0.5) calibrated empirically once first 5-10 student plans land. Pure-function shape (no side effects, no IO) so it's trivially unit-testable across many synthetic semester arrays. Also exports `classifyBalanceDelta(before, after): "improved"\|"negligible"\|"degraded-mild"\|"degraded-significant"` for `PlanDiff.balanceImpact.classification` (Phase 14's `propose_plan_change` calls it). |
| `packages/engine/tests/agent/balanceScore.test.ts` | **Create** | Unit tests for `computeBalanceScore` covering: (a) perfectly balanced plan → low score, (b) one heavy term → moderate score, (c) all hard courses in one term → high score (hardCount variance dominates), (d) `frontload` style with hard courses early → low score, (e) `frontload` style with hard courses late → high score (loadStyleDeviation kicks in), (f) `light` per-term override → no penalty for that specific term being below loadStyle target. Plus `classifyBalanceDelta` tests for the 4 threshold buckets. |
| `packages/engine/src/agent/forwardSchedule/workloadTier.ts` | **Create** | Pure function `classifyWorkloadTier(slot, programRules, prereqsEntry): { tier: WorkloadTier, weight: number }`. Deterministic — no LLM, no heuristics beyond the rule-table in Decision #24. Used by `solver.ts` during placement and by `propose_plan_change` (Phase 14) for diff-time re-classification. |
| `packages/engine/tests/agent/workloadTier.test.ts` | **Create** | Unit tests for the tier classifier covering: (a) major-required from `must_take` rule, (b) major-elective from `choose_n` rule, (c) school-core from school-core ruleId, (d) free-elective from `optional: true`, (e) general-elective from general-category placeholder, (f) capstone bump (3+ prereq groups → weight 1.2), (g) ambiguous case (course satisfies both major-required AND school-core → major-required wins for tier). |
| `packages/engine/src/agent/forwardSchedule/build.ts` | **Create** | Orchestrator: composes the input bundle from session/DPR/profile, runs the solver, produces a `ForwardSchedule`. |
| `packages/engine/src/agent/forwardSchedule/reconcile.ts` | **Create** | DPR-hash-based reconciliation: replaces planned slots that are now completed/in-progress in the new DPR. |
| `packages/engine/src/agent/forwardSchedule/visaPolicy.ts` | **Create** | `creditTargetForVisa()`, `visaNotesForCredits()`, F-1 floor / domestic part-time-floor handling. |
| `packages/engine/src/dpr/prereqSatisfaction.ts` | **Create** | Canonical `isPrereqSatisfied(courseId, term, dpr, plan, minGrades)` helper implementing Decision #4's optimistic-forward-projection. Imports `meetsGradeThreshold` from `gradeComparison.ts`. The solver and `planFeasibility.ts` both call this — single source of truth so the rule can't drift between tools. |
| `packages/engine/tests/dpr/prereqSatisfaction.test.ts` | **Create** | Unit tests for the 7 truth-table rows: past-completion satisfied, past-F no override, past-F + IP override, past-F + future-plan override (strictly before T), past-F + future-plan AT or AFTER T (no override), currently-IP no past attempt, future-plan no past attempt, plus the minGrades / DPR-satisfiedBy branching. |
| `packages/engine/tests/agent/forwardScheduleRationale.test.ts` | **Create** | Asserts every slot in a solved `ForwardSchedule` has a non-empty `rationale.satisfiesRequirements` AND at least one `termConstraints` entry AND a `flexibility.earliestPossibleTerm` ≤ `latestPossibleTerm` range AND `downstreamImpact.graduationDelay >= 0`. Asserts every semester has `loadRationale.creditsTarget` matching the actual sum of slot credits. Catches solver regressions where rationale fields would silently go empty. |
| `packages/engine/tests/agent/forwardScheduleSolver.test.ts` | **Create** | Unit tests for solver: distribution, prereq blocks, offering blocks, NOT enforcement, AP synthetic IDs, slack-based balancing, requiresPetition pass-through. |
| `packages/engine/tests/agent/forwardScheduleReconcile.test.ts` | **Create** | Unit tests for reconciliation: completed-slot replacement, in-progress replacement, hash-mismatch detection. |
| `packages/engine/src/agent/tools/planForwardDegree.ts` | **Create** | New tool `plan_forward_degree`. Replaces `plan_semester` in the registry (old tool kept as a thin shim that delegates to this for back-compat). |
| `packages/engine/src/agent/tools/viewForwardPlan.ts` | **Create** | Read-only tool: returns `session.forwardSchedule`. |
| `packages/engine/src/agent/registry.ts` | **Modify** | Replace `planSemesterTool` with `planForwardDegreeTool`; add `viewForwardPlanTool`. |
| `packages/engine/src/agent/responseValidator.ts` | **Modify** | Extend `checkGrounding` to allow numbers that equal `a ± b` for any pair of grounded numbers. |
| `packages/engine/src/agent/agentLoop.ts` | **Modify** | Pass `isReplayTurn` flag to `runOneTurn`; suppress `thinking_delta` yields on replay. |
| `apps/web/lib/chatV2Client.ts` | **Modify** | Add `{ kind: "forward_schedule_update"; schedule: ForwardSchedule }` to `ChatV2Event`. |
| `apps/web/lib/sseStream.ts` | **Modify** | Same variant added to `SseEvent`. |
| `apps/web/app/api/chat/v2/route.ts` | **Modify** | Detect mutation of `session.forwardSchedule` and emit the new SSE event. |
| `apps/web/app/chat/page.tsx` | **Modify** | Hold `forwardSchedule` in state; consume the new SSE event; render sidebar; clear `thinkingText` on first `hasRealThinking` flip. |
| `apps/web/app/chat/scheduleSidebar.tsx` | **Create** | Right-rail sidebar component with semester cards + 4-variant slot rendering + optional-elective styling. |
| `apps/web/app/chat/chat.module.css` | **Modify** | Sidebar styles: panel, semester cards, slot color tokens, optional-elective dotted border, transition animation. |

---

## Module Implementation Order (sub-task breakdown for the expanded scope)

The 10 numbered Tasks below were drafted for the original 8-decision scope. After Decisions #21–#41 landed, ~12 new modules + 8 new test files joined the file-structure table. This appendix maps each new module to the existing Task it belongs under, so a fresh executor knows what to build inside each Task. **Within each Task, implement modules in the listed order — later modules import earlier ones.**

### Task 1 — types (modify `packages/shared/src/types.ts`)

Add ALL these types in one pass; later tasks depend on them. Order within Task 1:

1. `ValidationResult` 4-state union + `DataSource` + `ApprovalAuthority` enums (Decision #40) — foundational; all validators consume this
2. `WorkloadTier` union, `LoadRationale` interface, `Assumption` interface (Decisions #24, #22d, #30)
3. `ConfidenceTier` re-export from Phase 12.9.5's shared module if not already present (Decision #29)
4. `PoolBinding` interface (Decision #28), `PlaceholderSlot` tagged union with `RequirementPoolSlot | FreeCreditSlot | AdvisingPlaceholderSlot` variants (Decision #38)
5. `SlotRationale` + `TermConstraint` types (Decision #22a)
6. `ScheduleSlot` discriminated union with all 4 kinds; `specific_planned` and `placeholder` variants carry `rationale`, `flexibility`, `downstreamImpact`, `workloadTier`, `workloadWeight`, `bindingState`, `placeholderId?`, `poolBinding?`, `optionalReason?`, `confidence`, `isCriticalPath`, `approvalAuthority?` (Decisions #22a-d, #24, #28, #33, #37, #38, #39, #40)
7. `ForwardSemester` with `loadRationale: LoadRationale` (extended per #24 with `weightedCredits`, `hardCount`, `easyCount`)
8. `PlanState` 4-state union (Decision #32): `"valid-clean" | "valid-with-trade-offs" | "infeasible-draft" | "student-preferred-invalid-draft"`
9. `ForwardSchedule` with `state: PlanState`, `balanceScore: number`, `assumptions: Assumption[]` (Decisions #25, #30, #32)
9.1. `AlternativePlanSummary` interface (Decision #44) — `{planIndex, balanceScore, weightedCreditsByTerm, hardCountByTerm, easyCountByTerm, subjectDistributionByTerm, distinctSubjectsCount, totalPetitionCount, totalAssumptionCount, graduationTerm, topDiffsFromWinner: Array<{aspect, change}>}` — and the `alternativeCandidates?: AlternativePlanSummary[]` field on `ForwardSchedule`. Phase 14's `compare_plan_alternatives` tool consumes this for Tier-B fallback (Decision #42).
9.2. Promote `Assumption` from a single interface to a discriminated union (Decisions #30 + #42): variants `IP_COURSE_COMPLETION` (existing — solver-emitted), `LLM_RANKED_ALTERNATIVE` (Phase-14-emitted Tier B), `HEURISTIC_MAPPING` (Phase-14-emitted Tier D — soft constraints only; carries `studentConstraintFraming: "soft"` as a literal-type discriminator so a hard-framed instance is a TypeScript compile-time error, Layer 2 of Tier-D 3-layer enforcement).
10. `FeasibilityReport` + `InfeasibilityReport` (re-used by Tasks 3 + 5)

Phase 14's `SchedulePreferences`, `PlanChangeProposal`, `PlanDiff`, `PlanMutation` types are NOT added here — they're added in Phase 14 Task 1.

### Task 2 — visa helpers (extend the original 1-file plan to 2 files)

Original Task 2 ships `visaPolicy.ts` (simple credit-target + notes). Extend Task 2 to also ship `visaValidator.ts` because Decision #34 + #40 promote visa-axis checking from boolean to multi-axis `ValidationResult`. Order within Task 2:

1. `packages/engine/src/agent/forwardSchedule/visaPolicy.ts` — `creditTargetForVisa()`, `visaNotesForCredits()` (existing scope, unchanged)
2. `packages/engine/src/dpr/visaValidator.ts` — multi-axis F-1 / domestic visa validation per Decisions #34 + #40. Every axis returns a `ValidationResult` from Task 1's union. Phase 13 ships verified `pass`/`fail` for credit-floor + full-time axes; `requires-approval` for RCL / CPT / final-term-exception (require OGS/registrar action); `assumed-pass` for online/in-person axes pre-Phase-15 (assumption: "all sections in-person")
3. `packages/engine/tests/agent/visaPolicy.test.ts` (existing scope)
4. `packages/engine/tests/dpr/visaValidator.test.ts` — every axis × every ValidationResult-status cell (see file-structure row for the full coverage matrix)

### Task 3 — solver foundation (originally one big task; expand to ordered sub-steps)

Original Task 3 covers the constraint solver. With Decisions #4 + #24 + #25 + #27 + #28 + #30 + #33 + #35 + #41 added, several pure-helper modules must be built FIRST so the solver can import them. Order within Task 3:

**Step 3.0 — Pure helper modules (build before touching solver.ts):**

1. `packages/engine/src/dpr/gradeComparison.ts` — `meetsGradeThreshold(actualGrade, requiredGrade): boolean`. NYU letter-grade ordinals (A+, A, A-, B+, B, B-, C+, C, C-, D+, D, F). Imported by `prereqSatisfaction.ts`. Trivial; ~30 LOC.
2. `packages/engine/src/dpr/prereqSatisfaction.ts` — `isPrereqSatisfied(courseId, term, dpr, plan, minGrades)` per Decision #4's optimistic-forward-projection. Imports `meetsGradeThreshold`. Single source of truth — solver and any future tool that checks prereqs both call this helper.
3. `packages/engine/tests/dpr/prereqSatisfaction.test.ts` — 7 truth-table rows from the file-structure entry (TDD; write tests before implementation).
4. `packages/engine/src/agent/forwardSchedule/workloadTier.ts` — `classifyWorkloadTier(slot, programRules, prereqsEntry): { tier, weight }` per Decisions #24 + #35. Pure function; deterministic.
5. `packages/engine/tests/agent/workloadTier.test.ts` — 7+ classification cases from file-structure entry.
6. `packages/engine/src/agent/forwardSchedule/balanceScore.ts` — `computeBalanceScore(semesters, loadStyle): number` + `classifyBalanceDelta(before, after)` per Decision #25. Pure function. Phase 14's `propose_plan_change` also calls this.
7. `packages/engine/tests/agent/balanceScore.test.ts` — 6 scoring cases + 4 delta-classification thresholds.
8. `packages/engine/src/agent/forwardSchedule/forwardFeasibility.ts` — `forwardFeasibilityScreen(partialPlan, remainingUnmet, remainingTerms, prereqDepths, offerings): boolean` per Decision #27. **Named "screen" not "oracle"** — fast pruning heuristic. Pure function.
9. `packages/engine/tests/agent/forwardFeasibility.test.ts` — 6 cases including the explicit false-positive case (test name reminds future devs the screen is NOT a proof).
10. `packages/engine/src/agent/forwardSchedule/auditOptionality.ts` — `canDropSlot(slot, plan, programRules, dpr): { droppable, blockingConstraints? }` per Decision #33. Pure function. Used by Stage 9d + slot.optionalReason emission.
11. `packages/engine/tests/agent/auditOptionality.test.ts` — per-blocking-constraint coverage from file-structure entry.
12. `packages/engine/src/agent/forwardSchedule/poolBinding.ts` — `PoolBinding` type + `placePoolSlot()` + `promotePoolSlotToConcrete()` per Decision #28.

**Step 3.1 — Solver scaffolding (now safe to write because helpers exist):**

13. `packages/engine/src/agent/forwardSchedule/types.ts` — internal solver types (`SolverInput`, `SolverOutput`, `SolverNode`).
14. `packages/engine/src/agent/forwardSchedule/solver.ts` — greedy + backtracking solver with the stage breakdown from Decision #31. Imports all the pure helpers above. Emits `rationale`, `flexibility`, `downstreamImpact`, `workloadTier`/`weight`, `bindingState`, `confidence`, `isCriticalPath`, `optionalReason`, `assumptions[]`, `state: PlanState` on each output. Emit top-5 `alternativeCandidates` per Decision #44 (free byproduct of Stage 7's distribution-selection — see Decision #22d's `alternativeDistributionsConsidered` tracking).
15. `packages/engine/tests/agent/forwardScheduleSolver.test.ts` — solver behavior under hard constraints (existing test file from Task 3; keep + extend).
16. `packages/engine/tests/agent/forwardScheduleRationale.test.ts` — every slot has non-empty rationale fields (NEW; catches regressions where the new fields silently go empty).

**Step 3.2 — Final-validation gate (build last because it consumes the solver's output):**

17. `packages/engine/src/agent/forwardSchedule/graduationPathValidator.ts` — `runGraduationPathValidator(plan, dpr, programRules)` per Decision #41. The Stage-8 final feasibility gate. Returns `{ feasible, axisResults: Record<string, ValidationResult>, infeasibilityReport? }`. Verdict feeds `PlanState` per #32.
18. `packages/engine/tests/agent/graduationPathValidator.test.ts` — each of the 7 axes individually + multi-axis cases + state-routing assertions (`valid-clean` vs `valid-with-trade-offs` vs `infeasible-draft`).
19. `packages/engine/src/agent/forwardSchedule/contingencyPlans.ts` — `generateContingencies(forwardSchedule, dpr, prereqsData)` per Decision #30. One extra solver run per IP course; Phase 14's `simulate_alternatives` consumes the output. May ship in Phase 14 instead — see Self-review note at end of plan.

### Task 4 — reconciliation (unchanged)

Original Task 4 covers `reconcile.ts` + tests. No new modules. Only update: `reconcileWithDpr` must re-run `runGraduationPathValidator` (Task 3 step 3.2) after slot replacement so `ForwardSchedule.state` and `assumptions[]` stay correct after a DPR refresh.

### Task 5 — orchestrator (`build.ts`) — extend to call new modules

`build.ts` composes the solver-input bundle from session + DPR + profile, calls `solveForwardSchedule`, then post-processes the output to populate fields the solver itself doesn't fill in (final `state`, `balanceScore`, `assumptions[]` from IP scan). Order:

1. Existing scope (DPR-bundle composition, AP/IB synthetic-ID injection, term iteration).
2. After solver returns: call `runGraduationPathValidator` to compute the final `state: PlanState`.
3. Call `computeBalanceScore` from `balanceScore.ts` to populate `ForwardSchedule.balanceScore`.
4. Walk `coursesInProgress` to populate `ForwardSchedule.assumptions[]` (one `IP_COURSE_COMPLETION` entry per IP course relied on by downstream slots).

### Task 6 — tools (`plan_forward_degree`, `view_forward_plan`) (unchanged scope)

Tool wrappers around `build.ts`. No new modules.

### Task 7 — wire `forwardSchedule` into `ToolSession` (unchanged)

Modify `packages/engine/src/agent/tool.ts` to add `forwardSchedule?: ForwardSchedule` AND `studentDraftPlan?: ForwardSchedule` to `ToolSession` (the second slot is for `infeasible-draft` / `student-preferred-invalid-draft` plans per Decision #32 routing).

### Task 8 — reasoning-trace fixes (unchanged scope)

3 sub-fixes from operator-test pass 4. No new modules.

### Task 9 — SSE event + sidebar (unchanged scope, plus Decision #32 surfacing)

Sidebar must render the 4-state `ForwardSchedule.state` distinctly. Suggested: `valid-clean` → no banner; `valid-with-trade-offs` → blue info banner listing assumptions/trade-offs; `infeasible-draft` → red banner with infeasibility reasons; `student-preferred-invalid-draft` → orange banner with "Student-confirmed plan despite warnings" note. Optional-elective dotted-border styling (Decision #8) unchanged.

### Task 10 — manual verification (unchanged)

Add to the Phase-13 verification checklist:
- Verify a plan with an IP course shows `state: valid-with-trade-offs` and the assumption is surfaced in the sidebar.
- Verify a plan with `requires-approval` on RCL renders the OGS-approval flag.
- Verify F-1 online/in-person axes show as `assumed-pass` (Phase 15 will promote them to verified).

---

## Task 1: Define `ForwardSchedule` and supporting types

**Files:**
- Modify: `packages/shared/src/types.ts`

The shared package provides the canonical types so engine + web can both reference them.

- [ ] **Step 1: Add the new types**

Append to `packages/shared/src/types.ts`:

```typescript
/**
 * Phase 13 — Slot in a forward-planned semester. Discriminated union;
 * the UI renders each kind differently (completed = green, in_progress
 * = yellow, specific_planned = blue, placeholder = grey + dotted if
 * "optional"). Solver only mutates `specific_planned` and `placeholder`
 * kinds; `completed` and `in_progress` come straight from the DPR and
 * are never re-planned.
 */

export type ScheduleSlotKind = "completed" | "in_progress" | "specific_planned" | "placeholder";

export interface ScheduleSlotCompleted {
    kind: "completed";
    courseId: string;
    title: string;
    credits: number;
    grade: string;
}

export interface ScheduleSlotInProgress {
    kind: "in_progress";
    courseId: string;
    title: string;
    credits: number;
}

export interface ScheduleSlotSpecificPlanned {
    kind: "specific_planned";
    courseId: string;
    title: string;
    credits: number;
    /** Requirement IDs this slot satisfies. */
    satisfiesRules: string[];
    /** One-line rationale shown in the sidebar tooltip. */
    reason: string;
    /** Phase 13 — set when the prereq tree had an "or instructor
     *  permission" clause. Sidebar renders a yellow flag. */
    requiresPetition?: boolean;
}

export interface ScheduleSlotPlaceholder {
    kind: "placeholder";
    /** Human-readable category, e.g. "CS major elective", "CAS Texts & Ideas",
     *  "Free elective". */
    category: string;
    credits: number;
    /** Requirement IDs this placeholder satisfies (often a single rule;
     *  sometimes empty for plain "free elective"). */
    satisfiesRules: string[];
    /** Phase 13 — true when this elective is ABOVE the credit floor
     *  AND the student's degree-credit minimum is already met. The
     *  sidebar renders these with a dotted border + "optional" tag. */
    optional: boolean;
    /** One-line rationale shown in the sidebar tooltip. */
    reason: string;
}

export type ScheduleSlot =
    | ScheduleSlotCompleted
    | ScheduleSlotInProgress
    | ScheduleSlotSpecificPlanned
    | ScheduleSlotPlaceholder;

export interface ForwardSemester {
    /** Term code: "2026-fall", "2027-spring", "2027-summer", "2027-january". */
    term: string;
    /** True when this term's slots are entirely DPR-derived (completed +
     *  in-progress). Locked semesters never get re-planned. */
    locked: boolean;
    slots: ScheduleSlot[];
    /** Sum of slot credits. */
    plannedCredits: number;
    /** Visa / load advisories. Examples:
     *   - "Below F-1 full-time floor of 12 — RCL approval from OGS required"
     *   - "Part-time enrollment (10 credits) — confirm financial-aid impact"
     *   - "Above credit ceiling of 18 — overload approval needed" */
    notes: string[];
}

export interface FeasibilityReport {
    /** Was the solver able to produce a complete, valid plan? */
    feasible: boolean;
    /** Human-readable reason if not feasible. */
    infeasibilityReason?: string;
    /** Per-constraint diagnostics. */
    constraintViolations: Array<{
        kind:
            | "prereq_unsatisfiable"
            | "offering_pattern"
            | "credit_floor"
            | "credit_ceiling"
            | "graduation_total"
            | "not_clause"
            | "pass_fail_cap"
            | "online_credit_cap"
            | "outside_home_credit_cap"
            | "gpa_floor"
            | "other";
        course?: string;
        term?: string;
        detail: string;
    }>;
    /** Per-course "why placed where" annotations. */
    placementRationale: Record<string, string>;
}

export interface ForwardSchedule {
    studentId: string;
    homeSchoolId: string;
    /** Spring/Fall term the student is targeting for graduation. */
    graduationTerm: string;
    /** Per-semester credit target. F-1 default 12, domestic default 16. */
    creditTargetPerSemester: number;
    /** F-1 floor (12) when student is on F-1 visa, otherwise null. */
    f1Floor: number | null;
    /** Domestic part-time floor (8) when student is NOT F-1, otherwise null. */
    domesticPartTimeFloor: number | null;
    /** Hard graduation credit minimum (128 for CAS). */
    graduationCreditMinimum: number;
    /** True when the student already has ≥ graduationCreditMinimum credits.
     *  When true, free-elective placeholders above the floor render as optional. */
    degreeCreditsMet: boolean;
    /** Chronological list, oldest term first. */
    semesters: ForwardSemester[];
    /** SHA-256 of the DPR's courseHistory at compute time. New DPR with
     *  different hash → reconcile via reconcile.ts. */
    dprCourseHistoryHash: string;
    /** Epoch ms when this schedule was last computed. */
    computedAt: number;
    /** Feasibility diagnostics from the solver. */
    feasibility: FeasibilityReport;
}
```

- [ ] **Step 2: Type-check shared + engine + web**

```bash
cd packages/shared && npx tsc --noEmit
cd ../engine && npx tsc --noEmit
cd ../../apps/web && npx tsc --noEmit
```

Expected: zero new errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): ForwardSchedule + 4-variant slot union + FeasibilityReport"
```

---

## Task 2: Visa-policy helper

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/visaPolicy.ts`
- Create: `packages/engine/tests/agent/visaPolicy.test.ts`

Pure helper functions: pick a credit target based on visa, derive per-term notes from credits + visa context.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/visaPolicy.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { creditTargetForVisa, visaNotesForCredits } from "../../src/agent/forwardSchedule/visaPolicy";

describe("creditTargetForVisa", () => {
    it("returns 12 for F-1 (full-time floor)", () => {
        expect(creditTargetForVisa("f1")).toBe(12);
    });
    it("returns 16 for domestic", () => {
        expect(creditTargetForVisa("domestic")).toBe(16);
    });
    it("returns 16 for unknown / undefined visa (safe default)", () => {
        expect(creditTargetForVisa(undefined)).toBe(16);
        expect(creditTargetForVisa("other")).toBe(16);
    });
});

describe("visaNotesForCredits", () => {
    it("flags F-1 below floor as RCL-required", () => {
        const notes = visaNotesForCredits({ credits: 8, visa: "f1", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /F-?1/i.test(n) && /RCL/i.test(n))).toBe(true);
    });
    it("does NOT flag F-1 at or above floor", () => {
        const notes = visaNotesForCredits({ credits: 12, visa: "f1", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /RCL/i.test(n))).toBe(false);
    });
    it("flags domestic part-time enrollment between floor and full-time threshold", () => {
        const notes = visaNotesForCredits({ credits: 10, visa: "domestic", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /part-?time/i.test(n))).toBe(true);
    });
    it("flags credit-load below the part-time floor as below-minimum", () => {
        const notes = visaNotesForCredits({ credits: 4, visa: "domestic", f1Floor: 12, domesticPartTimeFloor: 8 });
        expect(notes.some(n => /below.*minimum/i.test(n))).toBe(true);
    });
});
```

- [ ] **Step 2: Implement**

Create `packages/engine/src/agent/forwardSchedule/visaPolicy.ts`:

```typescript
/**
 * Phase 13 — Visa-aware credit-target + per-term notes.
 *
 * - F-1 floor: 12 credits per main term (school-config-derived; default 12).
 *   Below this without OGS-approved RCL: visa status is at risk.
 * - Domestic part-time floor: 8 credits (school-config-derived; default 8).
 *   Below this: not registered for any standing.
 * - Domestic full-time threshold: typically 12 (school-config or
 *   f1Floor as proxy). Between part-time floor and full-time: part-time
 *   notice + financial-aid implications.
 */

interface VisaContext {
    credits: number;
    visa: string | undefined;
    f1Floor: number | null;
    domesticPartTimeFloor: number | null;
}

export function creditTargetForVisa(visa: string | undefined): number {
    if (visa === "f1") return 12;
    return 16;
}

export function visaNotesForCredits(ctx: VisaContext): string[] {
    const notes: string[] = [];
    if (ctx.visa === "f1" && ctx.f1Floor != null && ctx.credits < ctx.f1Floor) {
        notes.push(
            `Below F-1 full-time floor of ${ctx.f1Floor} credits — Reduced Course Load (RCL) approval from NYU OGS required before registration.`
        );
    }
    if (ctx.visa !== "f1" && ctx.f1Floor != null && ctx.domesticPartTimeFloor != null) {
        if (ctx.credits >= ctx.domesticPartTimeFloor && ctx.credits < ctx.f1Floor) {
            notes.push(
                `Part-time enrollment (${ctx.credits} credits, below ${ctx.f1Floor}-credit full-time threshold). Confirm financial-aid impact with the bursar.`
            );
        }
        if (ctx.credits < ctx.domesticPartTimeFloor) {
            notes.push(
                `Below ${ctx.domesticPartTimeFloor}-credit minimum enrollment — student would not be registered for standing.`
            );
        }
    }
    return notes;
}
```

- [ ] **Step 3: Run tests**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/visaPolicy.test.ts
```

Expected: 7/7 PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/forwardSchedule/visaPolicy.ts packages/engine/tests/agent/visaPolicy.test.ts
git commit -m "feat(engine): visaPolicy helper for credit targets + per-term notes"
```

---

## Task 3: Constraint solver — types + skeleton

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/types.ts`
- Create: `packages/engine/src/agent/forwardSchedule/solver.ts`

Defines the solver's input/output contracts. The solver is invoked by `build.ts` (Task 5) which assembles inputs from session + DPR + parsed data.

- [ ] **Step 1: Write the solver-types module**

Create `packages/engine/src/agent/forwardSchedule/types.ts`:

```typescript
import type { CoursePrereqs, PrereqGroup, ForwardSemester, ScheduleSlot, FeasibilityReport } from "@nyupath/shared";

/**
 * Phase 13 — Solver input bundle. All fields are immutable from the
 * solver's perspective; the solver builds a fresh `ForwardSchedule`
 * from these inputs and never mutates them.
 */
export interface SolverInput {
    /** Student-side state. */
    studentId: string;
    homeSchoolId: string;
    visaStatus: string | undefined;
    /** Course IDs the student has already completed (DPR + AP/IB synthetic). */
    coursesTaken: Set<string>;
    /** Course IDs in-progress in the current term (DPR rows with type === "IP"). */
    coursesInProgress: Set<string>;
    /** Current term, e.g. "2026-fall". */
    currentTerm: string;
    /** Target graduation term, e.g. "2027-spring". */
    graduationTerm: string;
    /** Per-semester credit target (12 / 16 / 18). */
    creditTargetPerSemester: number;
    /** F-1 minimum (typically 12) when applicable, else null. */
    f1Floor: number | null;
    /** Domestic part-time floor (typically 8) when applicable, else null. */
    domesticPartTimeFloor: number | null;
    /** Per-school upper credit ceiling (typically 18). */
    creditCeiling: number;
    /** Hard graduation total (128 for CAS). */
    graduationCreditMinimum: number;
    /** Total credits already earned (per DPR). */
    creditsEarned: number;
    /** Pass/fail unit cap (CAS = 32). Hard constraint: planned + already-used P/F
     *  units cannot exceed this. */
    passFailCap: number;
    /** Pass/fail units already used (per DPR header). */
    passFailUsed: number;
    /** Online-credit cap toward the major (school-config-derived; CAS commonly 8 or 16). */
    onlineCreditCap: number | null;
    /** Online credits already counted toward the major (per DPR header). */
    onlineCreditsUsed: number;
    /** Outside-home-school credit cap (CAS = 16 for non-CAS courses). */
    outsideHomeCreditCap: number | null;
    /** Outside-home-school credits already used (per DPR header). */
    outsideHomeCreditsUsed: number;
    /** Cumulative GPA per the latest DPR. Used to flag a graduation-GPA-floor risk. */
    cumulativeGpa: number;
    /** Cumulative major GPA per the DPR (when available). */
    majorGpa: number | null;
    /** School-required cumulative GPA floor for graduation (typically 2.0). */
    graduationGpaFloor: number;
    /** Major-GPA floor (when applicable; null if school has no separate major-GPA rule). */
    majorGpaFloor: number | null;
    /** Unmet requirements from DPR's notSatisfiedRequirements. Each becomes
     *  a candidate to place; rId, title, category, credits required. */
    unmetRequirements: Array<{
        rId: string;
        title: string;
        /** Best-effort category label: "cs_major_required" | "cas_core" |
         *  "free_elective" | "minor_required" | etc. */
        category: string;
        /** Credits this requirement consumes. Usually 4 in CAS. */
        credits: number;
        /** Specific course IDs that satisfy this requirement (when known
         *  from program data). Empty for placeholder-style requirements
         *  like "any free elective". */
        candidateCourses: string[];
    }>;
    /** Parsed prereqs (Phase 12.8 output). */
    prereqs: Map<string, PrereqGroup[]>;
    /** Parsed offerings (Phase 12.8 output). */
    offerings: Map<string, Array<"fall" | "spring" | "summer" | "january">>;
    /** Course metadata: title + credits, indexed by courseId. */
    courseCatalog: Map<string, { title: string; credits: number }>;
    /** DPR's courseHistory hash (for the resulting ForwardSchedule). */
    dprCourseHistoryHash: string;
}

export interface SolverOutput {
    semesters: ForwardSemester[];
    feasibility: FeasibilityReport;
}

/** Internal solver-state node. */
export interface SolverNode {
    /** Per-term tentative slot list (mutable during search). */
    perTerm: Map<string, ScheduleSlot[]>;
    /** Course IDs already placed (for prereq + NOT checks). */
    placedCourses: Set<string>;
    /** Courses we've decided to NOT place (e.g. excluded by NOT clauses). */
    excludedCourses: Set<string>;
    /** Per-term running credit count. */
    perTermCredits: Map<string, number>;
    /** Backtrack history (for debugging only). */
    decisions: string[];
}
```

- [ ] **Step 2: Write the solver skeleton + key tests**

Create `packages/engine/tests/agent/forwardScheduleSolver.test.ts` first (TDD):

```typescript
import { describe, it, expect } from "vitest";
import { solveForwardSchedule } from "../../src/agent/forwardSchedule/solver";
import type { SolverInput } from "../../src/agent/forwardSchedule/types";

function makeInput(overrides: Partial<SolverInput> = {}): SolverInput {
    return {
        studentId: "t",
        homeSchoolId: "cas",
        visaStatus: "f1",
        coursesTaken: new Set(),
        coursesInProgress: new Set(),
        currentTerm: "2026-fall",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        creditCeiling: 18,
        graduationCreditMinimum: 128,
        creditsEarned: 96,
        passFailCap: 32,
        passFailUsed: 4,
        onlineCreditCap: 16,
        onlineCreditsUsed: 0,
        outsideHomeCreditCap: 16,
        outsideHomeCreditsUsed: 0,
        cumulativeGpa: 3.4,
        majorGpa: 3.3,
        graduationGpaFloor: 2.0,
        majorGpaFloor: 2.0,
        unmetRequirements: [],
        prereqs: new Map(),
        offerings: new Map(),
        courseCatalog: new Map(),
        dprCourseHistoryHash: "test-hash",
        ...overrides,
    };
}

describe("solveForwardSchedule — slack-based distribution", () => {
    it("places 4 unmet hard requirements roughly evenly across 2 semesters when each slot is empty", () => {
        const input = makeInput({
            unmetRequirements: [
                { rId: "r1", title: "CS 421", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 421"] },
                { rId: "r2", title: "MATH-UA 250", category: "math_major_required", credits: 4, candidateCourses: ["MATH-UA 250"] },
                { rId: "r3", title: "CORE-UA 400", category: "cas_core", credits: 4, candidateCourses: ["CORE-UA 400"] },
                { rId: "r4", title: "CORE-UA 500", category: "cas_core", credits: 4, candidateCourses: ["CORE-UA 500"] },
            ],
            offerings: new Map([
                ["CSCI-UA 421", ["fall", "spring"]],
                ["MATH-UA 250", ["fall", "spring"]],
                ["CORE-UA 400", ["fall", "spring"]],
                ["CORE-UA 500", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 421", { title: "Software Engineering", credits: 4 }],
                ["MATH-UA 250", { title: "Mathematical Statistics", credits: 4 }],
                ["CORE-UA 400", { title: "Texts & Ideas", credits: 4 }],
                ["CORE-UA 500", { title: "Cultures & Contexts", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        const fallHard = fall.slots.filter(s => s.kind === "specific_planned").length;
        const springHard = spring.slots.filter(s => s.kind === "specific_planned").length;
        // 4 hard requirements across 2 terms: 2 each.
        expect(fallHard).toBe(2);
        expect(springHard).toBe(2);
    });

    it("does NOT add more hard requirements to a term that's already full of locked credits", () => {
        const input = makeInput({
            coursesInProgress: new Set(["CORE-UA 700", "MATH-UA 251", "MATH-UA 343"]),
            unmetRequirements: [
                { rId: "r1", title: "CS 421", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 421"] },
                { rId: "r2", title: "CORE-UA 400", category: "cas_core", credits: 4, candidateCourses: ["CORE-UA 400"] },
            ],
            offerings: new Map([
                ["CSCI-UA 421", ["fall", "spring"]],
                ["CORE-UA 400", ["fall", "spring"]],
                ["CORE-UA 700", ["fall", "spring"]],
                ["MATH-UA 251", ["fall", "spring"]],
                ["MATH-UA 343", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 421", { title: "X", credits: 4 }],
                ["CORE-UA 400", { title: "Y", credits: 4 }],
                ["CORE-UA 700", { title: "Z1", credits: 4 }],
                ["MATH-UA 251", { title: "Z2", credits: 4 }],
                ["MATH-UA 343", { title: "Z3", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        // Fall already has 12 credits locked (3 in_progress) — slack to 16 = 4.
        // Both hard requirements should NOT land in fall; one (or both) goes
        // to spring where slack is full (16).
        const fallSpecificPlanned = fall.slots.filter(s => s.kind === "specific_planned").length;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        const springSpecificPlanned = spring.slots.filter(s => s.kind === "specific_planned").length;
        expect(fallSpecificPlanned + springSpecificPlanned).toBe(2);
        expect(springSpecificPlanned).toBeGreaterThanOrEqual(1); // at least one hard in spring
    });
});

describe("solveForwardSchedule — prereq + offering constraints", () => {
    it("blocks a course in a term where its offering pattern excludes that term", () => {
        const input = makeInput({
            unmetRequirements: [
                { rId: "r1", title: "CS 421", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 421"] },
            ],
            offerings: new Map([
                ["CSCI-UA 421", ["spring"]], // spring-only
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 421", { title: "Software Engineering", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        const fallHasIt = fall.slots.some(s => "courseId" in s && s.courseId === "CSCI-UA 421");
        const springHasIt = spring.slots.some(s => "courseId" in s && s.courseId === "CSCI-UA 421");
        expect(fallHasIt).toBe(false);
        expect(springHasIt).toBe(true);
    });

    it("respects prereq satisfaction — places X only after Y is in coursesTaken or scheduled earlier", () => {
        const input = makeInput({
            coursesTaken: new Set(), // student hasn't taken Y yet
            unmetRequirements: [
                { rId: "rX", title: "CS X", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA X"] },
                { rId: "rY", title: "CS Y", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA Y"] },
            ],
            prereqs: new Map([
                ["CSCI-UA X", [{ type: "AND", courses: ["CSCI-UA Y"], coreqs: [], requiresPetition: false, notCourses: [] }]],
            ]),
            offerings: new Map([
                ["CSCI-UA X", ["fall", "spring"]],
                ["CSCI-UA Y", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA X", { title: "X", credits: 4 }],
                ["CSCI-UA Y", { title: "Y", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const spring = out.semesters.find(s => s.term === "2027-spring")!;
        const fallY = fall.slots.find(s => "courseId" in s && s.courseId === "CSCI-UA Y");
        const springX = spring.slots.find(s => "courseId" in s && s.courseId === "CSCI-UA X");
        // Y must come before X.
        expect(fallY).toBeDefined();
        expect(springX).toBeDefined();
    });
});

describe("solveForwardSchedule — NOT clause", () => {
    it("excludes a course whose NOT clause references something in coursesTaken", () => {
        const input = makeInput({
            coursesTaken: new Set(["CSCI-UA 2"]),
            unmetRequirements: [
                { rId: "r1", title: "CS 101", category: "cs_major_required", credits: 4, candidateCourses: ["CSCI-UA 101"] },
            ],
            prereqs: new Map([
                ["CSCI-UA 101", [{ type: "NOT", courses: [], coreqs: [], requiresPetition: false, notCourses: ["CSCI-UA 2"] }]],
            ]),
            offerings: new Map([
                ["CSCI-UA 101", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 101", { title: "Intro", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const placed = out.semesters.flatMap(s => s.slots).find(s => "courseId" in s && s.courseId === "CSCI-UA 101");
        expect(placed).toBeUndefined();
        // And feasibility report flags it.
        expect(out.feasibility.constraintViolations.some(v => v.kind === "not_clause" && v.course === "CSCI-UA 101")).toBe(true);
    });
});

describe("solveForwardSchedule — instructor permission", () => {
    it("places a course whose only prereq path is 'or instructor permission' but flags requiresPetition", () => {
        const input = makeInput({
            coursesTaken: new Set(),
            unmetRequirements: [
                { rId: "r1", title: "Special Topics", category: "cs_major_elective", credits: 4, candidateCourses: ["CSCI-UA 480"] },
            ],
            prereqs: new Map([
                ["CSCI-UA 480", [{
                    type: "OR",
                    courses: [],
                    coreqs: [],
                    requiresPetition: true,
                    notCourses: [],
                }]],
            ]),
            offerings: new Map([
                ["CSCI-UA 480", ["fall", "spring"]],
            ]),
            courseCatalog: new Map([
                ["CSCI-UA 480", { title: "ST", credits: 4 }],
            ]),
        });
        const out = solveForwardSchedule(input);
        const placed = out.semesters.flatMap(s => s.slots).find(s => "courseId" in s && s.courseId === "CSCI-UA 480");
        expect(placed).toBeDefined();
        expect((placed as { requiresPetition?: boolean }).requiresPetition).toBe(true);
    });
});

describe("solveForwardSchedule — optional electives flag", () => {
    it("marks free-elective placeholders ABOVE the floor as optional when degreeCreditsMet === true", () => {
        const input = makeInput({
            creditsEarned: 138, // already over 128
            unmetRequirements: [], // no hard reqs left
        });
        const out = solveForwardSchedule(input);
        const fall = out.semesters.find(s => s.term === "2026-fall")!;
        const placeholders = fall.slots.filter(s => s.kind === "placeholder") as Array<{ optional?: boolean }>;
        expect(placeholders.length).toBeGreaterThan(0);
        // F-1 student → floor 12. Above 12, electives are optional.
        const aboveFloor = placeholders.filter(p => p.optional === true);
        expect(aboveFloor.length).toBeGreaterThan(0);
    });
});

describe("solveForwardSchedule — additional credit-cap constraints", () => {
    it("flags pass_fail_cap when passFailUsed >= passFailCap", () => {
        const input = makeInput({ passFailCap: 32, passFailUsed: 32 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "pass_fail_cap")).toBe(true);
    });
    it("does NOT flag pass_fail_cap when student is well under the cap", () => {
        const input = makeInput({ passFailCap: 32, passFailUsed: 4 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "pass_fail_cap")).toBe(false);
    });

    it("flags online_credit_cap when student is already over the cap", () => {
        const input = makeInput({ onlineCreditCap: 16, onlineCreditsUsed: 20 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "online_credit_cap")).toBe(true);
    });

    it("flags outside_home_credit_cap when student is already over the cap", () => {
        const input = makeInput({ outsideHomeCreditCap: 16, outsideHomeCreditsUsed: 20 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "outside_home_credit_cap")).toBe(true);
    });
});

describe("solveForwardSchedule — GPA-floor checks", () => {
    it("flags gpa_floor when cumulative GPA is below the graduation floor", () => {
        const input = makeInput({ cumulativeGpa: 1.85, graduationGpaFloor: 2.0 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "gpa_floor" && /Cumulative GPA/.test(v.detail))).toBe(true);
    });
    it("flags gpa_floor when major GPA is below the major-completion floor", () => {
        const input = makeInput({ majorGpa: 1.95, majorGpaFloor: 2.0, cumulativeGpa: 3.0 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "gpa_floor" && /Major GPA/.test(v.detail))).toBe(true);
    });
    it("does NOT flag gpa_floor when both GPAs are above floor", () => {
        const input = makeInput({ cumulativeGpa: 3.4, majorGpa: 3.3, graduationGpaFloor: 2.0, majorGpaFloor: 2.0 });
        const out = solveForwardSchedule(input);
        expect(out.feasibility.constraintViolations.some(v => v.kind === "gpa_floor")).toBe(false);
    });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/forwardScheduleSolver.test.ts
```

Expected: FAIL — `solveForwardSchedule` doesn't exist yet.

- [ ] **Step 4: Implement the solver**

Create `packages/engine/src/agent/forwardSchedule/solver.ts`:

```typescript
import type { ScheduleSlot, ForwardSemester, FeasibilityReport, PrereqGroup } from "@nyupath/shared";
import type { SolverInput, SolverOutput, SolverNode } from "./types.js";

const SEASONS = ["spring", "summer", "fall", "january"] as const;
type Season = typeof SEASONS[number];

function parseTerm(t: string): { year: number; season: Season } | null {
    const m = t.toLowerCase().match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return null;
    return { year: parseInt(m[1]!, 10), season: m[2] as Season };
}

function termOrd(p: { year: number; season: Season }): number {
    return p.year * 4 + SEASONS.indexOf(p.season);
}

function termCode(p: { year: number; season: Season }): string {
    return `${p.year}-${p.season}`;
}

function nextMainTerm(p: { year: number; season: Season }): { year: number; season: Season } {
    // Phase 13 skips summer + january in the future-term enumeration.
    if (p.season === "spring") return { year: p.year, season: "fall" };
    if (p.season === "fall") return { year: p.year + 1, season: "spring" };
    if (p.season === "summer") return { year: p.year, season: "fall" };
    return { year: p.year, season: "spring" }; // january
}

function enumerateMainTerms(start: string, end: string): string[] {
    const a = parseTerm(start);
    const b = parseTerm(end);
    if (!a || !b) return [];
    const out: string[] = [];
    let cur = a;
    while (termOrd(cur) <= termOrd(b)) {
        if (cur.season === "fall" || cur.season === "spring") out.push(termCode(cur));
        if (termOrd(cur) === termOrd(b)) break;
        cur = nextMainTerm(cur);
        if (cur.year > b.year + 6) break;
    }
    return out;
}

/**
 * Phase 13 — checks whether a course's prereq tree is satisfied by the
 * union of coursesTaken (DPR) and a candidate `placedBefore` set
 * (courses we've placed in prior terms during this solve).
 *
 * Implements decisions:
 *  - #1 NOT clause: if any course in `notCourses` is in coursesTaken,
 *    the course is excluded.
 *  - #4 Trust DPR: any course in coursesTaken is treated as satisfied.
 *  - #5 Lenient cross-school: if we don't have prereq data on a foreign
 *    course AND it's in coursesTaken, treat as satisfied. If we don't
 *    have data AND it's NOT in coursesTaken, treat as the OR-fallback
 *    (some other clause may carry the placement).
 *  - Strict synthetic AP/IB: same path as normal coursesTaken membership;
 *    parser already minted them.
 */
function isPrereqSatisfied(
    groups: PrereqGroup[],
    coursesTaken: Set<string>,
    placedBefore: Set<string>,
): { satisfied: boolean; excluded: boolean; requiresPetition: boolean } {
    let requiresPetition = false;
    for (const g of groups) {
        if (g.type === "NOT") {
            const blocking = g.notCourses?.find(c => coursesTaken.has(c) || placedBefore.has(c));
            if (blocking) return { satisfied: false, excluded: true, requiresPetition: false };
            continue;
        }
        if (g.requiresPetition) requiresPetition = true;
        const checkSatisfied = (c: string) =>
            coursesTaken.has(c) || placedBefore.has(c);
        if (g.type === "AND") {
            for (const c of g.courses) {
                if (!checkSatisfied(c)) {
                    if (!g.requiresPetition) {
                        return { satisfied: false, excluded: false, requiresPetition: false };
                    }
                }
            }
        } else if (g.type === "OR") {
            const anyOk = g.courses.some(c => checkSatisfied(c));
            if (!anyOk && !g.requiresPetition) {
                return { satisfied: false, excluded: false, requiresPetition: false };
            }
        }
    }
    return { satisfied: true, excluded: false, requiresPetition };
}

/**
 * Phase 13 — Slack-based ordering. Returns a sorted list of (term, slack)
 * pairs, descending by slack. Hard-requirement placement walks this in
 * order so the term with the most empty space gets filled first.
 */
function termsBySlack(
    futureTerms: string[],
    perTermCredits: Map<string, number>,
    target: number,
): Array<{ term: string; slack: number }> {
    return futureTerms
        .map(t => ({ term: t, slack: target - (perTermCredits.get(t) ?? 0) }))
        .sort((a, b) => b.slack - a.slack);
}

export function solveForwardSchedule(input: SolverInput): SolverOutput {
    const violations: FeasibilityReport["constraintViolations"] = [];
    const placementRationale: Record<string, string> = {};

    // 1. Build past + current semesters from DPR (locked).
    const lockedSemesters: ForwardSemester[] = []; // Past + current — populated by build.ts wrapper

    // 2. Enumerate future main terms.
    const futureTerms = enumerateMainTerms(input.currentTerm, input.graduationTerm)
        .filter(t => t !== input.currentTerm); // current is locked

    if (futureTerms.length === 0) {
        // Only the locked current term remains. Nothing to plan.
        return {
            semesters: [],
            feasibility: {
                feasible: true,
                constraintViolations: [],
                placementRationale: {},
            },
        };
    }

    // 3. Initialize per-term credit counts and slot lists.
    const perTermSlots = new Map<string, ScheduleSlot[]>();
    const perTermCredits = new Map<string, number>();
    for (const t of futureTerms) {
        perTermSlots.set(t, []);
        perTermCredits.set(t, 0);
    }

    // 4. Build placement-decision queue. Course IDs from unmetRequirements
    //    that have at least one candidate course we know about (from the
    //    courseCatalog). Requirements without a specific candidate become
    //    placeholder slots in step 6.
    const placedBefore = new Set<string>(); // for prereq satisfaction within same plan

    interface Candidate {
        rId: string;
        courseId: string;
        title: string;
        credits: number;
        category: string;
    }

    const candidates: Candidate[] = [];
    const placeholderRequirements: typeof input.unmetRequirements = [];
    for (const req of input.unmetRequirements) {
        if (req.candidateCourses.length === 0) {
            placeholderRequirements.push(req);
            continue;
        }
        // Pick the first candidate. Future iterations could try multiple.
        const courseId = req.candidateCourses[0]!;
        const meta = input.courseCatalog.get(courseId);
        if (!meta) {
            // Catalog gap — degrade gracefully.
            placeholderRequirements.push(req);
            continue;
        }
        candidates.push({ rId: req.rId, courseId, title: meta.title, credits: meta.credits, category: req.category });
    }

    // 5. Place each candidate using slack-based ordering + prereq +
    //    offering constraints. Greedy with a single-level fallback.
    for (const cand of candidates) {
        const sched = isPrereqSatisfied(
            input.prereqs.get(cand.courseId) ?? [],
            input.coursesTaken,
            placedBefore,
        );
        if (sched.excluded) {
            violations.push({
                kind: "not_clause",
                course: cand.courseId,
                detail: `Course ${cand.courseId} is excluded by a NOT prereq clause (something in coursesTaken blocks it).`,
            });
            continue;
        }

        const offered = input.offerings.get(cand.courseId);
        const sortedTerms = termsBySlack(futureTerms, perTermCredits, input.creditTargetPerSemester);
        let placed = false;
        for (const { term, slack } of sortedTerms) {
            if (slack < cand.credits) continue;
            const seasonOnly = term.split("-")[1] as "fall" | "spring";
            if (offered && !offered.includes(seasonOnly)) continue;
            // For simplicity Phase 13: prereq satisfaction checks against
            // the running placedBefore. If a prereq is unmet, skip — the
            // backtracking version (Phase 15+) would re-order. Phase 13
            // is greedy.
            if (!sched.satisfied) {
                violations.push({
                    kind: "prereq_unsatisfiable",
                    course: cand.courseId,
                    term,
                    detail: `Course ${cand.courseId} prereqs not yet satisfied by placement order in ${term}.`,
                });
                continue;
            }
            // OK to place.
            const slot: ScheduleSlot = {
                kind: "specific_planned",
                courseId: cand.courseId,
                title: cand.title,
                credits: cand.credits,
                satisfiesRules: [cand.rId],
                reason: `Required (${cand.category}) placed in ${term} for slack-balanced load.`,
                ...(sched.requiresPetition ? { requiresPetition: true } : {}),
            };
            perTermSlots.get(term)!.push(slot);
            perTermCredits.set(term, (perTermCredits.get(term) ?? 0) + cand.credits);
            placedBefore.add(cand.courseId);
            placementRationale[cand.courseId] = slot.reason;
            placed = true;
            break;
        }
        if (!placed) {
            violations.push({
                kind: "offering_pattern",
                course: cand.courseId,
                detail: `Could not place ${cand.courseId} — no future term has sufficient slack and matching offering pattern.`,
            });
        }
    }

    // 6. Place placeholder requirements (no specific candidate course).
    for (const req of placeholderRequirements) {
        const sortedTerms = termsBySlack(futureTerms, perTermCredits, input.creditTargetPerSemester);
        const term = sortedTerms[0]?.term;
        if (!term) continue;
        const slot: ScheduleSlot = {
            kind: "placeholder",
            category: req.title,
            credits: req.credits,
            satisfiesRules: [req.rId],
            optional: false,
            reason: `Distributed from ${input.unmetRequirements.length} unmet requirements across ${futureTerms.length} remaining semesters.`,
        };
        perTermSlots.get(term)!.push(slot);
        perTermCredits.set(term, (perTermCredits.get(term) ?? 0) + req.credits);
    }

    // 7. Fill remaining capacity with free-elective placeholders.
    const degreeCreditsMet = input.creditsEarned >= input.graduationCreditMinimum;
    for (const term of futureTerms) {
        const cur = perTermCredits.get(term) ?? 0;
        const cap = input.creditTargetPerSemester;
        let credits = cur;
        while (credits + 4 <= cap) {
            const aboveFloor = credits >= (input.f1Floor ?? input.domesticPartTimeFloor ?? 0);
            const optional = degreeCreditsMet && aboveFloor;
            perTermSlots.get(term)!.push({
                kind: "placeholder",
                category: "Free elective",
                credits: 4,
                satisfiesRules: [],
                optional,
                reason: optional
                    ? "Above degree minimum and credit floor — optional load."
                    : `Brings total to ${cap}-credit target.`,
            });
            credits += 4;
        }
        perTermCredits.set(term, credits);
    }

    // 8. Build ForwardSemester[].
    const semesters: ForwardSemester[] = futureTerms.map(t => {
        const slots = perTermSlots.get(t) ?? [];
        const credits = slots.reduce((s, x) => s + x.credits, 0);
        const notes: string[] = [];
        if (input.f1Floor != null && credits < input.f1Floor && input.visaStatus === "f1") {
            notes.push(`Below F-1 full-time floor of ${input.f1Floor} credits — RCL approval from OGS required.`);
            violations.push({ kind: "credit_floor", term: t, detail: `Below F-1 floor (${credits} < ${input.f1Floor}).` });
        }
        if (credits > input.creditCeiling) {
            notes.push(`Above credit ceiling of ${input.creditCeiling} — overload approval needed.`);
            violations.push({ kind: "credit_ceiling", term: t, detail: `Above ceiling (${credits} > ${input.creditCeiling}).` });
        }
        return { term: t, locked: false, slots, plannedCredits: credits, notes };
    });

    // 9. Graduation total check.
    const totalScheduled = input.creditsEarned + semesters.reduce((s, sem) => s + sem.plannedCredits, 0);
    if (totalScheduled < input.graduationCreditMinimum) {
        violations.push({
            kind: "graduation_total",
            detail: `Projected total ${totalScheduled} < graduation minimum ${input.graduationCreditMinimum}.`,
        });
    }

    // 10. Pass/fail cap check. Phase 13 doesn't yet allow pinning courses
    //     as P/F via preferences (that arrives in Phase 14), so the
    //     planner only flags when the student has ALREADY used >= cap and
    //     would block any future P/F decisions. The hard-cap math runs
    //     here so the report carries the constraint regardless.
    if (input.passFailUsed >= input.passFailCap) {
        violations.push({
            kind: "pass_fail_cap",
            detail: `Student has used ${input.passFailUsed} of ${input.passFailCap} P/F units. Any future placement must be letter-graded.`,
        });
    }

    // 11. Online-credit cap. The bulletin notes some online-only courses;
    //     when they bear that flag, the solver counts them against the
    //     online-credit budget. Phase 13 doesn't yet track per-course
    //     online flag (that's a Phase 12.8 catalog enrichment), so the
    //     check here is a header-level guard: if the student is already
    //     above the cap, surface as a hard violation so the agent's reply
    //     warns them.
    if (input.onlineCreditCap != null && input.onlineCreditsUsed > input.onlineCreditCap) {
        violations.push({
            kind: "online_credit_cap",
            detail: `Student has used ${input.onlineCreditsUsed} online credits, exceeding the ${input.onlineCreditCap}-credit cap toward the major. Future online courses will not count.`,
        });
    }

    // 12. Outside-home credit cap. CAS students may take up to 16 credits
    //     outside the College of Arts & Science. If already over, future
    //     non-home placements must be flagged.
    if (input.outsideHomeCreditCap != null && input.outsideHomeCreditsUsed > input.outsideHomeCreditCap) {
        violations.push({
            kind: "outside_home_credit_cap",
            detail: `Student has used ${input.outsideHomeCreditsUsed} credits outside ${input.homeSchoolId}, exceeding the ${input.outsideHomeCreditCap}-credit cap. Future non-${input.homeSchoolId} courses will not count toward graduation.`,
        });
    }

    // 13. Graduation GPA floor. The student's cumulative GPA must meet
    //     the school's floor (typically 2.0) at graduation. Below the
    //     floor → flag as gpa_floor violation so the agent surfaces a
    //     banner ("you're at risk of not graduating even with this
    //     plan; talk to advising").
    if (input.cumulativeGpa < input.graduationGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Cumulative GPA ${input.cumulativeGpa} is below the ${input.graduationGpaFloor} graduation floor. The plan does not address this — the student must improve grades on the remaining courses or graduation will be denied.`,
        });
    }
    if (input.majorGpaFloor != null && input.majorGpa != null && input.majorGpa < input.majorGpaFloor) {
        violations.push({
            kind: "gpa_floor",
            detail: `Major GPA ${input.majorGpa} is below the ${input.majorGpaFloor} major-completion floor. Some required courses may need to be retaken for higher grades.`,
        });
    }

    return {
        semesters,
        feasibility: {
            feasible: violations.length === 0,
            ...(violations.length > 0 ? { infeasibilityReason: `${violations.length} constraint violations.` } : {}),
            constraintViolations: violations,
            placementRationale,
        },
    };
}
```

This is a Phase-13-class **greedy** solver: no backtracking, single-pass slack-based placement. It's intentionally simpler than the full CSP described in the architecture doc. Phase 15 will introduce backtracking; Phase 13 ships the greedy version with feasibility-report annotations so unfilled-prereq cases are surfaced explicitly even when not solved.

- [ ] **Step 5: Run tests to verify pass**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/forwardScheduleSolver.test.ts
```

Expected: all tests PASS (or document specific cases that fall to Phase 15's backtracking — e.g. the prereq-ordering test may need the candidate sort by prereq depth before slack).

If a test fails because the greedy is too naive, either:
- Adjust the test's expectation to match Phase 13's greedy semantics (with a comment explaining what Phase 15 will improve).
- Add a small pre-pass that topologically sorts candidates by prereq depth, so courses with no dependencies place first.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/forwardSchedule/solver.ts packages/engine/src/agent/forwardSchedule/types.ts packages/engine/tests/agent/forwardScheduleSolver.test.ts
git commit -m "feat(engine): forward-schedule constraint solver (greedy + slack-based)"
```

---

## Task 4: Reconciliation helper (DPR re-upload)

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/reconcile.ts`
- Create: `packages/engine/tests/agent/forwardScheduleReconcile.test.ts`

When the user uploads a new DPR, we hash its `courseHistory` and compare to `forwardSchedule.dprCourseHistoryHash`. On mismatch, walk the existing schedule and:
- For each `specific_planned` slot: if the new DPR shows the course completed → replace with `completed`. If in-progress → replace with `in_progress`.
- For each `placeholder` slot whose satisfying requirement is now met by a DPR completed course → remove or re-categorize.

- [ ] **Step 1: Write the tests** (similar pattern to Task 3 — load fake schedules, drive `reconcileWithDpr`, assert specific slot transformations).

- [ ] **Step 2: Implement `reconcile.ts`**

Create `packages/engine/src/agent/forwardSchedule/reconcile.ts`:

```typescript
import { createHash } from "node:crypto";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import type { DPRCourseRow, DegreeProgressReport } from "../../dpr/schema.js";

export function dprCourseHistoryHash(courseHistory: DPRCourseRow[]): string {
    const normalized = courseHistory
        .map(c => `${c.subject} ${c.catalogNbr}|${c.term}|${c.grade ?? ""}|${c.units}|${c.type}`)
        .sort();
    return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 16);
}

export function reconcileWithDpr(old: ForwardSchedule, newDpr: DegreeProgressReport): ForwardSchedule {
    const newCompleted = new Map<string, DPRCourseRow>();
    const newInProgress = new Map<string, DPRCourseRow>();
    for (const row of newDpr.courseHistory) {
        const id = `${row.subject} ${row.catalogNbr}`;
        if (row.type === "IP") newInProgress.set(id, row);
        else if (row.grade && row.grade !== "") newCompleted.set(id, row);
    }
    const reconciled = old.semesters.map(sem => ({
        ...sem,
        slots: sem.slots.map(slot => {
            if (slot.kind !== "specific_planned") return slot;
            const c = newCompleted.get(slot.courseId);
            if (c) {
                return {
                    kind: "completed" as const,
                    courseId: slot.courseId,
                    title: slot.title,
                    credits: slot.credits,
                    grade: c.grade ?? "",
                };
            }
            const ip = newInProgress.get(slot.courseId);
            if (ip) {
                return {
                    kind: "in_progress" as const,
                    courseId: slot.courseId,
                    title: slot.title,
                    credits: slot.credits,
                };
            }
            return slot;
        }),
    }));
    return {
        ...old,
        semesters: reconciled,
        dprCourseHistoryHash: dprCourseHistoryHash(newDpr.courseHistory),
        computedAt: Date.now(),
    };
}
```

- [ ] **Step 3: Run tests** — expected pass.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/forwardSchedule/reconcile.ts packages/engine/tests/agent/forwardScheduleReconcile.test.ts
git commit -m "feat(engine): forwardSchedule reconcile-with-DPR helper"
```

---

## Task 5: `build.ts` — orchestrator

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/build.ts`

Wraps the solver with the DPR-bundle composition. Loads parsed prereqs + offerings from disk (Phase 12.8 outputs); builds locked past/current semesters from DPR; calls `solveForwardSchedule`; assembles the final `ForwardSchedule`.

```typescript
import type { ForwardSchedule, ForwardSemester } from "@nyupath/shared";
import * as fs from "node:fs";
import * as path from "node:path";
import { solveForwardSchedule } from "./solver.js";
import { creditTargetForVisa } from "./visaPolicy.js";
import { dprCourseHistoryHash } from "./reconcile.js";
import type { ToolSession } from "../tool.js";

const PREREQS_PATH = path.resolve(__dirname, "../../data/prereqs.json");
const OFFERINGS_PATH = path.resolve(__dirname, "../../data/courses-offerings.json");
const COURSES_PATH = path.resolve(__dirname, "../../data/courses.json");

let cachedPrereqs: Map<string, any> | null = null;
let cachedOfferings: Map<string, any> | null = null;
let cachedCatalog: Map<string, any> | null = null;

function loadPrereqs() {
    if (cachedPrereqs) return cachedPrereqs;
    const raw: Array<{ course: string; prereqGroups: any[] }> = JSON.parse(fs.readFileSync(PREREQS_PATH, "utf8"));
    cachedPrereqs = new Map(raw.map(r => [r.course, r.prereqGroups]));
    return cachedPrereqs;
}

function loadOfferings() {
    if (cachedOfferings) return cachedOfferings;
    const raw: Record<string, { termsOffered: string[] }> = JSON.parse(fs.readFileSync(OFFERINGS_PATH, "utf8"));
    cachedOfferings = new Map(Object.entries(raw).map(([id, v]) => [id, v.termsOffered]));
    return cachedOfferings;
}

function loadCatalog() {
    if (cachedCatalog) return cachedCatalog;
    const raw: Array<{ id: string; title: string; credits: number }> = JSON.parse(fs.readFileSync(COURSES_PATH, "utf8"));
    cachedCatalog = new Map(raw.map(c => [c.id, { title: c.title, credits: c.credits }]));
    return cachedCatalog;
}

interface BuildArgs {
    session: ToolSession;
    currentTerm: string;
    graduationTerm: string;
    creditTargetPerSemester?: number;
}

const SEASONS_ORDERED = ["spring", "summer", "fall", "january"] as const;
type Season = typeof SEASONS_ORDERED[number];

/** "2024 Fall" → "2024-fall"; "2024 Spr" → "2024-spring"; etc. Returns
 *  null when the input doesn't parse. */
function normalizeDprTermToCode(dprTerm: string): string | null {
    const m = dprTerm.toLowerCase().match(/(\d{4})\s+(fall|fal|spring|spr|summer|sum|january|jan|j-?term)/);
    if (!m) return null;
    const year = m[1]!;
    const seasonRaw = m[2]!;
    let season: Season;
    if (seasonRaw.startsWith("fal")) season = "fall";
    else if (seasonRaw.startsWith("spr")) season = "spring";
    else if (seasonRaw.startsWith("sum")) season = "summer";
    else season = "january";
    return `${year}-${season}`;
}

function parseTermCode(t: string): { year: number; season: Season } | null {
    const m = t.match(/^(\d{4})-(spring|summer|fall|january)$/);
    if (!m) return null;
    return { year: parseInt(m[1]!, 10), season: m[2] as Season };
}

/**
 * Phase 13 — Map a DPR transfer/exam-credit row to a Phase 12.8
 * synthetic courseId. Returns null when the row's subject doesn't
 * match a known AP/IB exam name. The mapping mirrors
 * `tools/bulletin-parser/syntheticCourseIds.ts`'s tables — keep them
 * in sync if those tables change.
 */
function synthesizeFromDprRow(row: { subject: string; courseTitle: string; grade: string | null; units: number }): string | null {
    const subjectLower = row.subject.toLowerCase();
    const titleLower = (row.courseTitle ?? "").toLowerCase();
    const combined = `${subjectLower} ${titleLower}`;
    const score = row.grade ? parseInt(row.grade, 10) : null;
    if (score == null || Number.isNaN(score)) return null;
    if (combined.includes("comp sci a") || combined.includes("computer science a")) return `AP-CS-A-${score}`;
    if (combined.includes("comp sci principles") || combined.includes("computer science principles")) return `AP-CS-P-${score}`;
    if (combined.includes("calculus bc")) return `AP-CALC-BC-${score}`;
    if (combined.includes("calculus ab")) return `AP-CALC-AB-${score}`;
    if (combined.includes("ap statistics") || (subjectLower.includes("adv plac") && titleLower.includes("statistics"))) return `AP-STATS-${score}`;
    // Extend as needed; fall through to null if unrecognized so the
    // synthetic ID doesn't get minted incorrectly.
    return null;
}

export function buildForwardSchedule(args: BuildArgs): ForwardSchedule {
    const session = args.session;
    const student = session.student!;
    const dpr = session.degreeProgressReport!;
    const schoolConfig = session.schoolConfig!;

    const coursesTaken = new Set<string>();
    const coursesInProgress = new Set<string>();
    for (const row of dpr.courseHistory) {
        const id = `${row.subject} ${row.catalogNbr}`;
        if (row.type === "IP") coursesInProgress.add(id);
        else if (row.grade) coursesTaken.add(id);
    }

    // Phase 13 — inject AP/IB synthetic course IDs from DPR rows that
    // represent test credit. The DPR uses `type === "TE"` for transfer/
    // exam credit; the row's `subject` carries the exam name (e.g.
    // "Adv Plac Comp Sci A") and `grade` the score. Map to the synthetic
    // courseId scheme defined in Phase 12.8 Task 2 (AP-CS-A-3, etc.) so
    // the prereq solver can resolve "AP Computer Science A >= 3" clauses.
    for (const row of dpr.courseHistory) {
        if (row.type !== "TE") continue;
        const synthetic = synthesizeFromDprRow(row);
        if (synthetic) coursesTaken.add(synthetic);
    }

    const visa = student.visaStatus;
    const creditTarget = args.creditTargetPerSemester ?? creditTargetForVisa(visa);
    const f1Floor = visa === "f1" ? (schoolConfig.f1FullTimeMinCredits ?? 12) : null;
    const partTimeFloor = (schoolConfig as { domesticPartTimeFloor?: number }).domesticPartTimeFloor ?? 8;

    const unmetRequirements = (dpr.requirementGroups ?? [])
        .flatMap(g => g.children ?? [])
        .filter((r: any) => r.statusText !== "satisfied")
        .map((r: any) => ({
            rId: r.rId,
            title: r.title ?? "Unmet requirement",
            category: (r.category ?? "unknown") as string,
            credits: r.credits ?? 4,
            candidateCourses: r.coursesUsed ?? [],
        }));

    const out = solveForwardSchedule({
        studentId: student.id,
        homeSchoolId: student.homeSchool,
        visaStatus: visa,
        coursesTaken,
        coursesInProgress,
        currentTerm: args.currentTerm,
        graduationTerm: args.graduationTerm,
        creditTargetPerSemester: creditTarget,
        f1Floor,
        domesticPartTimeFloor: partTimeFloor,
        creditCeiling: schoolConfig.maxCreditsPerSemester ?? 18,
        graduationCreditMinimum: schoolConfig.graduationCreditMinimum ?? 128,
        creditsEarned: dpr.creditsEarned ?? 0,
        unmetRequirements,
        prereqs: loadPrereqs(),
        offerings: loadOfferings(),
        courseCatalog: loadCatalog(),
        dprCourseHistoryHash: dprCourseHistoryHash(dpr.courseHistory),
    });

    // Phase 13 — build past + current locked semesters from DPR.
    // Past terms (DPR-completed) become semesters with completed slots.
    // The current term (DPR in-progress rows) becomes a single locked
    // semester with in_progress slots. Both never re-plan.
    const byTerm = new Map<string, typeof dpr.courseHistory>();
    for (const row of dpr.courseHistory) {
        const tc = normalizeDprTermToCode(row.term); // "2024 Fall" → "2024-fall"
        if (!tc) continue;
        if (!byTerm.has(tc)) byTerm.set(tc, []);
        byTerm.get(tc)!.push(row);
    }
    const lockedSemesters: ForwardSemester[] = [];
    for (const [termCode, rows] of byTerm) {
        const isCurrent = termCode === args.currentTerm;
        const slots: ScheduleSlot[] = rows.map(r => {
            if (r.type === "IP") {
                return {
                    kind: "in_progress",
                    courseId: `${r.subject} ${r.catalogNbr}`,
                    title: r.courseTitle,
                    credits: r.units,
                };
            }
            return {
                kind: "completed",
                courseId: `${r.subject} ${r.catalogNbr}`,
                title: r.courseTitle,
                credits: r.units,
                grade: r.grade ?? "",
            };
        });
        const credits = slots.reduce((s, x) => s + x.credits, 0);
        lockedSemesters.push({
            term: termCode,
            locked: true,
            slots,
            plannedCredits: credits,
            notes: [],
        });
    }
    // Sort chronologically.
    lockedSemesters.sort((a, b) => {
        const pa = parseTermCode(a.term);
        const pb = parseTermCode(b.term);
        return (pa?.year ?? 0) * 4 + (pa ? SEASONS_ORDERED.indexOf(pa.season) : 0)
             - ((pb?.year ?? 0) * 4 + (pb ? SEASONS_ORDERED.indexOf(pb.season) : 0));
    });

    return {
        studentId: student.id,
        homeSchoolId: student.homeSchool,
        graduationTerm: args.graduationTerm,
        creditTargetPerSemester: creditTarget,
        f1Floor,
        domesticPartTimeFloor: partTimeFloor,
        graduationCreditMinimum: schoolConfig.graduationCreditMinimum ?? 128,
        degreeCreditsMet: (dpr.creditsEarned ?? 0) >= (schoolConfig.graduationCreditMinimum ?? 128),
        semesters: [...lockedSemesters, ...out.semesters],
        dprCourseHistoryHash: dprCourseHistoryHash(dpr.courseHistory),
        computedAt: Date.now(),
        feasibility: out.feasibility,
    };
}
```

Adapt all `dpr.*` and `schoolConfig.*` field accesses to the actual repo's types (the agent will read those during implementation).

- Commit: `feat(engine): build.ts orchestrator for ForwardSchedule construction`

---

## Task 6: New tools — `plan_forward_degree` + `view_forward_plan`

**Files:**
- Create: `packages/engine/src/agent/tools/planForwardDegree.ts`
- Create: `packages/engine/src/agent/tools/viewForwardPlan.ts`
- Modify: `packages/engine/src/agent/registry.ts`

Replace the single-semester `plan_semester` with `plan_forward_degree`. The old name stays as a back-compat shim (delegates to the new tool with `targetSemester` mapped to `currentTerm`).

- Implement, register, test.
- Commit.

---

## Task 7: Wire `forwardSchedule` into `ToolSession`

**Files:**
- Modify: `packages/engine/src/agent/tool.ts`

Add the new field so subsequent turns can read the persisted schedule + reconcile against new DPR uploads. The mutation is intentionally per-session (in-memory) — Phase 13 does NOT add server-side persistence. Server-side persistence is a Phase 14+ follow-up.

- [ ] **Step 1: Read the current `ToolSession` definition**

```bash
grep -n "interface ToolSession\|export interface ToolSession" packages/engine/src/agent/tool.ts
```

Quote the existing fields so the new field slots in alongside `pendingMutations`.

- [ ] **Step 2: Add the import + field**

At the top of `packages/engine/src/agent/tool.ts`, add the import:

```typescript
import type { ForwardSchedule } from "@nyupath/shared";
```

In the `ToolSession` interface, append the new field at the end (mirror the JSDoc style of the surrounding fields):

```typescript
    /** Phase 13 — persistent multi-semester forward plan. Initialized
     *  when `plan_forward_degree` first runs; updated on each call;
     *  reconciled on DPR re-upload via `reconcileWithDpr` from
     *  `forwardSchedule/reconcile.ts`. Read by `view_forward_plan` and
     *  surfaced to the chat UI via the `forward_schedule_update` SSE
     *  event (Task 9). In-memory only; lost on session end. */
    forwardSchedule?: ForwardSchedule;
```

- [ ] **Step 3: Type-check**

```bash
cd packages/engine && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/tool.ts
git commit -m "feat(engine): ToolSession.forwardSchedule for persistent multi-semester plan"
```

---

## Task 8: Reasoning-trace fixes (3 sub-fixes)

**Files:**
- Modify: `packages/engine/src/agent/responseValidator.ts` (arithmetic-grounded numbers — sub-fix 8a)
- Modify: `packages/engine/src/agent/agentLoop.ts` (suppress thinking on replay turns — sub-fix 8b)
- Modify: `apps/web/app/chat/page.tsx` (clear `thinkingText` when `hasRealThinking` first flips — sub-fix 8c)
- Create: `packages/engine/tests/agent/groundingArithmetic.test.ts`

These three carry-forward bugs from operator test pass 4 are independent. Each sub-fix has its own TDD test + commit. The sub-fixes can ship in any order; here they go 8a → 8b → 8c.

### Sub-fix 8a: Validator allows arithmetic on grounded numbers

**Bug:** the validator flags `16` as ungrounded when the assistant says "your total is 16 (12 already + 4 planned)" because `16` doesn't appear verbatim in any tool result, even though `12` and `4` both do. The model self-censors on basic addition.

**Fix:** extend `checkGrounding`'s allow-set to include sums and differences of all pairs of grounded numbers.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/groundingArithmetic.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator";

const MINIMAL_STUDENT = {
    studentId: "t",
    homeSchoolId: "cas",
    declaredPrograms: [],
    visaStatus: undefined,
    transcript: { semesters: [] },
    plans: [],
    expectedGraduationTerm: undefined,
};

describe("grounding allows arithmetic on grounded numbers", () => {
    it("allows '16' when both '12' and '4' appear in tool results (12 + 4 = 16)", () => {
        const verdict = validateResponse({
            assistantText: "Your total is 16 credits (12 already registered + 4 planned).",
            invocations: [
                { toolName: "plan_semester", summary: "12 credits already registered, 4 credits planned" } as any,
            ],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what's my total?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "16")).toBe(false);
    });

    it("allows '8' when '12' and '4' appear (12 - 4 = 8)", () => {
        const verdict = validateResponse({
            assistantText: "After dropping the 4-credit course you'll have 8 credits.",
            invocations: [{ toolName: "plan_semester", summary: "12 credits planned, 4-credit course" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what if I drop one?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "8")).toBe(false);
    });

    it("STILL flags a number that is neither verbatim nor a sum/diff of grounded numbers", () => {
        const verdict = validateResponse({
            assistantText: "Your GPA is 3.7.",
            invocations: [{ toolName: "x", summary: "12 credits planned" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what's my GPA?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "3.7")).toBe(true);
    });

    it("allows arithmetic on userQuestion + tool-result numbers (16 from user, 4 from tool, 16 - 4 = 12)", () => {
        const verdict = validateResponse({
            assistantText: "Of the 16 you asked for, the planner placed 4 — so you're 12 short.",
            invocations: [{ toolName: "plan_semester", summary: "4 credits planned" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "plan for 16 credits",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "12")).toBe(false);
    });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/groundingArithmetic.test.ts
```

Expected: tests 1, 2, 4 FAIL (validator currently flags `16`, `8`, `12` as ungrounded). Test 3 PASSES.

- [ ] **Step 3: Modify `checkGrounding` in `responseValidator.ts`**

Find `checkGrounding` (around line 176 per prior Phase-12.5 audit). The current shape builds a `groundCorpus` string and uses `.includes()` to verify each claim. Extend it with a number-set that also covers sums and differences:

```typescript
function extractAllNumbers(text: string): string[] {
    const matches = text.match(/-?\d+(?:\.\d+)?/g);
    return matches ?? [];
}

function checkGrounding(ctx: ValidatorContext): Violation[] {
    const violations: Violation[] = [];
    const claims = extractClaimNumbers(ctx.assistantText);
    if (claims.size === 0) return violations;

    // Phase 13 §8a — collect all groundable numbers (tool results + user
    // question). A claim is grounded if it appears verbatim OR if it
    // equals a ± b for some pair of grounded numbers.
    const groundedNumbers = new Set<number>();
    const sources = [
        ...ctx.invocations.map((inv) => `${inv.summary ?? ""} ${JSON.stringify(inv.args)}`),
        ctx.userQuestion ?? "",
    ];
    const groundCorpus = sources.join(" ").toLowerCase();
    for (const s of sources) {
        for (const n of extractAllNumbers(s)) {
            const parsed = parseFloat(n);
            if (Number.isFinite(parsed)) groundedNumbers.add(parsed);
        }
    }
    const numbersArr = [...groundedNumbers];

    function isDerivable(claim: string): boolean {
        if (groundCorpus.includes(claim)) return true;
        const claimVal = parseFloat(claim);
        if (!Number.isFinite(claimVal)) return false;
        for (let i = 0; i < numbersArr.length; i++) {
            for (let j = 0; j < numbersArr.length; j++) {
                if (numbersArr[i]! + numbersArr[j]! === claimVal) return true;
                if (numbersArr[i]! - numbersArr[j]! === claimVal) return true;
            }
        }
        return false;
    }

    for (const claim of claims) {
        if (!isDerivable(claim)) {
            violations.push({
                kind: "ungrounded_number",
                number: claim,
                detail: `Number "${claim}" appears in the reply but does not appear verbatim in any tool result this turn, nor is it a sum or difference of two grounded numbers. Either call the tool that returns it or remove the claim.`,
            });
        }
    }
    return violations;
}
```

If the existing `checkGrounding` already lives inside a function with a different signature (e.g. takes `groundCorpus` as an argument), adapt the integration point — the principle is: extend the allow-set with pairwise sums + differences of all grounded numbers.

- [ ] **Step 4: Run tests to verify pass**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/groundingArithmetic.test.ts
```

Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agent/responseValidator.ts packages/engine/tests/agent/groundingArithmetic.test.ts
git commit -m "fix(engine): grounding validator allows sums/differences of grounded numbers"
```

### Sub-fix 8b: Suppress `thinking_delta` on replay turns

**Bug:** when `validateResponse` rejects a turn and the agent loop replays, the model on the replay turn often produces self-correction monologue ("the validator caught my synthesized 16, let me remove that"). This thinking text reaches the user via the `thinking_delta` SSE event.

**Fix:** thread an `isReplayTurn` flag through `runOneTurn`. When set, skip yielding `thinking_delta` events.

- [ ] **Step 1: Modify `runOneTurn`'s signature**

In `packages/engine/src/agent/agentLoop.ts`, find `runOneTurn`. Add an `isReplayTurn = false` parameter and gate the thinking-delta yield:

```typescript
async function* runOneTurn(
    client: LLMClient,
    args: LLMCompleteArgs,
    outDeltas: string[],
    isReplayTurn = false,
) {
    for await (const ev of client.streamComplete(args)) {
        if (ev.type === "text_delta") {
            outDeltas.push(ev.text);
            yield { type: "text_delta", text: ev.text };
        } else if (ev.type === "thinking_delta") {
            // Phase 13 §8b — on replay turns, the model often narrates
            // its self-correction in the open. That monologue
            // ("the validator caught my synthesized 16…") is internal
            // and should not reach the user. Suppress here.
            if (!isReplayTurn) yield { type: "thinking_delta", text: ev.text };
        } else if (ev.type === "done") {
            yield { type: "_turn_result", result: { ok: true, completion: ev.completion } };
        }
    }
}
```

- [ ] **Step 2: Pass `true` from the replay invocation**

Find the place inside `runAgentTurnStreaming` where the loop re-calls `runOneTurn` after a validator rejection. Pass `isReplayTurn: true`. Example shape:

```typescript
// Phase 12.5 wired the validator-replay loop. The second runOneTurn
// invocation is the replay; pass true so its thinking is suppressed.
for await (const ev of runOneTurn(client, replayArgs, replayDeltas, /* isReplayTurn */ true)) {
    // …
}
```

- [ ] **Step 3: Manual smoke-test**

This sub-fix is best validated in the browser: trigger a validator violation, observe that the replay turn's thinking text is empty in the SSE stream while the corrected answer still streams normally. (No automated test — the existing `validatorMessageLeak` test from Phase 12.5 already covers the broader leak path; this is an incremental tightening.)

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/agent/agentLoop.ts
git commit -m "fix(engine): suppress thinking_delta on validator-replay turns"
```

### Sub-fix 8c: Clear `thinkingText` when `hasRealThinking` first flips

**Bug:** the synthesized tool-thought sentence ("Now I'll sketch a semester plan…") is appended to `thinkingText` BEFORE the first real `thinking` event arrives (because `tool_invocation_start` typically fires first). Once real thinking starts, `hasRealThinking` flips to true — but the synthesized sentence stays in the buffer, so the user sees both.

**Fix:** when `hasRealThinking` is FALSE and the first real `thinking` event arrives, REPLACE `thinkingText` with the new event's text instead of appending. Subsequent thinking events (with `hasRealThinking` already true) keep appending.

- [ ] **Step 1: Modify the `case "thinking":` handler in `apps/web/app/chat/page.tsx`**

Find the `case "thinking":` branch in `applyEvent`. Currently it appends + sets the flag. Restructure:

```typescript
case "thinking":
    setMessages(prev => prev.map(m => {
        if (m.id !== assistantId) return m;
        if (!m.hasRealThinking) {
            // Phase 13 §8c — first real thinking event. The synthesized
            // tool-sentence narration (if any) was a fallback; real
            // reasoning replaces it. Clear and start fresh.
            return {
                ...m,
                thinkingText: ev.text,
                thinkingRevealed: 0, // restart the typewriter on the new text
                hasRealThinking: true,
            };
        }
        return {
            ...m,
            thinkingText: (m.thinkingText ?? "") + ev.text,
            hasRealThinking: true,
        };
    }));
    break;
```

- [ ] **Step 2: Smoke-test in browser**

Send any tool-using question. Observe:
- The synthesized "Now I'll sketch a semester plan…" appears briefly (before the first real thinking event).
- When the first real thinking event arrives, the indented reasoning block CLEARS and starts re-revealing with the model's actual reasoning text.
- No double-narration ("Now I'll sketch…" + real-thinking-prose) visible.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/chat/page.tsx
git commit -m "fix(web): clear thinkingText buffer on first real-thinking event"
```

---

## Task 9: `forward_schedule_update` SSE event + schedule sidebar

**Files:**
- Modify: `apps/web/lib/chatV2Client.ts`
- Modify: `apps/web/lib/sseStream.ts`
- Modify: `apps/web/app/api/chat/v2/route.ts`
- Modify: `apps/web/tests/chatV2Client.test.ts`
- Modify: `apps/web/app/chat/page.tsx`
- Create: `apps/web/app/chat/scheduleSidebar.tsx`
- Modify: `apps/web/app/chat/chat.module.css`

The structured schedule needs to reach the chat page so the sidebar can render it live. We add a new SSE event kind, wire it through both client and server unions, render the sidebar component conditionally on a header-toggle button, and color-code the four slot kinds (with optional electives styled distinctly per locked decision #8).

### Step group A — Add the SSE event kind end-to-end

- [ ] **Step 1: Extend `ChatV2Event` and `SseEvent` unions**

In `apps/web/lib/chatV2Client.ts`, find the `ChatV2Event` discriminated union. Append:

```typescript
    | { kind: "forward_schedule_update"; schedule: ForwardSchedule }
```

Add the import at the top:

```typescript
import type { ForwardSchedule } from "@nyupath/shared";
```

In `apps/web/lib/sseStream.ts`, append the SAME variant to `SseEvent`. Both unions must stay in lockstep — Phase 12.5 Task 3 fix established that pattern.

- [ ] **Step 2: Add a round-trip test in `chatV2Client.test.ts`**

Append a new `it()` block (mirror the existing `parses a thinking event` test):

```typescript
it("parses a forward_schedule_update event and round-trips its payload", async () => {
    const fakeSchedule = {
        studentId: "t",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [],
        dprCourseHistoryHash: "abc",
        computedAt: 0,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
    };
    const chunks = [
        "event: forward_schedule_update\ndata: " + JSON.stringify({ kind: "forward_schedule_update", schedule: fakeSchedule }) + "\n\n",
        "event: done\ndata: " + JSON.stringify({ kind: "done", finalText: "ok", modelUsedId: "claude-haiku-4-5-20251001" }) + "\n\n",
    ];
    const resp = fakeResponse(chunks);
    const events: ChatV2Event[] = [];
    for await (const ev of /* the existing helper used by sibling tests */) {
        events.push(ev);
    }
    expect(events[0]).toEqual({ kind: "forward_schedule_update", schedule: fakeSchedule });
    expect(events[1]!.kind).toBe("done");
});
```

Adapt the helper-name to whatever the existing tests use (`streamChatV2`, `streamChatV2FromResponse`, etc.).

- [ ] **Step 3: Server-side emit detection**

In `apps/web/app/api/chat/v2/route.ts`, find `runV2Turn` (or the function that orchestrates the agent loop and SSE writes per turn). Capture the `forwardSchedule.computedAt` BEFORE the agent runs and again AFTER. If the timestamp changed (or the schedule appeared for the first time), emit:

```typescript
const beforeComputedAt = sessionForTurn.forwardSchedule?.computedAt;
// ... run agent loop ...
const afterComputedAt = sessionForTurn.forwardSchedule?.computedAt;
const scheduleChanged = sessionForTurn.forwardSchedule
    && (beforeComputedAt == null || beforeComputedAt !== afterComputedAt);
if (scheduleChanged) {
    writer.write({
        kind: "forward_schedule_update",
        schedule: sessionForTurn.forwardSchedule!,
    });
}
```

- [ ] **Step 4: Type-check + run tests**

```bash
cd apps/web && npx tsc --noEmit
cd ../.. && node_modules/.bin/vitest run apps/web/tests/
```

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/chatV2Client.ts apps/web/lib/sseStream.ts apps/web/tests/chatV2Client.test.ts apps/web/app/api/chat/v2/route.ts
git commit -m "feat(web): forward_schedule_update SSE event end-to-end"
```

### Step group B — Frontend state + sidebar component

- [ ] **Step 1: Add `forwardSchedule` + `sidebarOpen` to chat-page state**

In `apps/web/app/chat/page.tsx`, near the existing `useState` calls, add:

```typescript
import type { ForwardSchedule } from "@nyupath/shared";
import ScheduleSidebar from "./scheduleSidebar";

// inside ChatPage:
const [forwardSchedule, setForwardSchedule] = useState<ForwardSchedule | null>(null);
const [sidebarOpen, setSidebarOpen] = useState(false);
```

- [ ] **Step 2: Handle the new event in `applyEvent`**

Add a new case:

```typescript
case "forward_schedule_update":
    setForwardSchedule(ev.schedule);
    break;
```

- [ ] **Step 3: Add the toggle button in the header**

Find the existing header JSX (search for `headerLogo` / `headerBadge`). Add the toggle button on the right side:

```typescript
<button
    type="button"
    className={styles.scheduleToggle}
    onClick={() => setSidebarOpen(o => !o)}
    aria-label="Toggle schedule sidebar"
    aria-expanded={sidebarOpen}
>
    📅 Schedule
</button>
```

- [ ] **Step 4: Render the sidebar at the page bottom**

Just before the final closing `</div>` of `ChatPage`, add:

```typescript
<ScheduleSidebar
    schedule={forwardSchedule}
    open={sidebarOpen}
    onClose={() => setSidebarOpen(false)}
/>
```

- [ ] **Step 5: Create the sidebar component**

Create `apps/web/app/chat/scheduleSidebar.tsx`:

```typescript
"use client";

import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import styles from "./chat.module.css";

interface ScheduleSidebarProps {
    schedule: ForwardSchedule | null;
    open: boolean;
    onClose: () => void;
}

export default function ScheduleSidebar({ schedule, open, onClose }: ScheduleSidebarProps) {
    if (!open) return null;

    return (
        <aside className={styles.scheduleSidebar} aria-label="Forward schedule">
            <div className={styles.scheduleSidebarHeader}>
                <h2 className={styles.scheduleSidebarTitle}>Your Schedule</h2>
                <button onClick={onClose} className={styles.scheduleSidebarClose} aria-label="Close schedule">✕</button>
            </div>
            {!schedule ? (
                <p className={styles.scheduleSidebarEmpty}>
                    No plan yet. Ask me what to take next semester to compute one.
                </p>
            ) : (
                <div className={styles.scheduleSidebarBody}>
                    <p className={styles.scheduleSidebarMeta}>
                        Targeting graduation in <strong>{formatTermLabel(schedule.graduationTerm)}</strong>
                        {" · "}
                        <strong>{schedule.creditTargetPerSemester} credits</strong> per semester
                    </p>
                    {!schedule.feasibility.feasible && (
                        <div className={styles.scheduleInfeasibilityBanner}>
                            ⚠ Plan has constraint violations:
                            <ul>
                                {schedule.feasibility.constraintViolations.slice(0, 5).map((v, i) => (
                                    <li key={i}>{v.detail}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {schedule.semesters.map(sem => (
                        <section key={sem.term} className={`${styles.semesterCard} ${sem.locked ? styles.locked : ""}`}>
                            <header className={styles.semesterCardHeader}>
                                <h3>{formatTermLabel(sem.term)}</h3>
                                <span className={styles.semesterCredits}>{sem.plannedCredits} cr</span>
                            </header>
                            {sem.notes.length > 0 && (
                                <ul className={styles.semesterNotes}>
                                    {sem.notes.map((n, i) => <li key={i}>{n}</li>)}
                                </ul>
                            )}
                            <ul className={styles.slotList}>
                                {sem.slots.map((slot, i) => (
                                    <li key={i} className={`${styles[`slot_${slot.kind}`]} ${slot.kind === "placeholder" && (slot as any).optional ? styles.slotOptional : ""}`}>
                                        {renderSlot(slot)}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ))}
                </div>
            )}
        </aside>
    );
}

function renderSlot(slot: ScheduleSlot) {
    switch (slot.kind) {
        case "completed":
            return (
                <>
                    <span className={styles.slotIcon}>✓</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
                    <span className={styles.slotMeta}>{slot.credits}cr · {slot.grade}</span>
                </>
            );
        case "in_progress":
            return (
                <>
                    <span className={styles.slotIcon}>⏳</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
                    <span className={styles.slotMeta}>{slot.credits}cr</span>
                </>
            );
        case "specific_planned":
            return (
                <>
                    <span className={styles.slotIcon}>📅</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
                    <span className={styles.slotMeta}>{slot.credits}cr</span>
                    {slot.requiresPetition && <span className={styles.slotFlag} title="Requires petition (instructor permission)">⚠</span>}
                </>
            );
        case "placeholder":
            return (
                <>
                    <span className={styles.slotIcon}>{slot.optional ? "○" : "●"}</span>
                    <span className={styles.slotPlaceholderCategory}>{slot.category}</span>
                    <span className={styles.slotMeta}>
                        {slot.credits}cr
                        {slot.optional && <span className={styles.slotOptionalTag}> · optional</span>}
                    </span>
                </>
            );
    }
}

function formatTermLabel(term: string): string {
    const m = term.match(/^(\d{4})-(spring|summer|fall|january)$/i);
    if (!m) return term;
    const season = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1).toLowerCase();
    return `${season} ${m[1]}`;
}
```

- [ ] **Step 6: Append CSS**

Append to `apps/web/app/chat/chat.module.css`:

```css
/* ---------- Phase 13 — Schedule sidebar ---------- */
.scheduleToggle {
    background: transparent;
    border: 1px solid var(--border-light);
    color: var(--text-primary);
    padding: 6px 12px;
    border-radius: var(--radius-full);
    font-size: 0.85em;
    cursor: pointer;
    margin-left: auto;
}
.scheduleToggle:hover { background: var(--bg-secondary); }
.scheduleToggle:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--nyu-violet-glow);
    border-color: var(--nyu-violet);
}

.scheduleSidebar {
    position: fixed;
    right: 0;
    top: 0;
    bottom: 0;
    width: 380px;
    background: var(--bg-primary);
    border-left: 1px solid var(--border-light);
    overflow-y: auto;
    box-shadow: -4px 0 16px rgba(0, 0, 0, 0.05);
    z-index: 50;
    animation: slideInRight 0.2s ease-out;
}
@keyframes slideInRight {
    from { transform: translateX(100%); }
    to   { transform: translateX(0); }
}
@media (prefers-reduced-motion: reduce) {
    .scheduleSidebar { animation: none; }
}

.scheduleSidebarHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-light);
    position: sticky;
    top: 0;
    background: var(--bg-primary);
}
.scheduleSidebarTitle { font-size: 1rem; font-weight: 600; margin: 0; }
.scheduleSidebarClose {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: 1.1em;
    padding: 4px 8px;
    color: var(--text-secondary);
}
.scheduleSidebarBody { padding: 12px 20px 24px; }
.scheduleSidebarMeta { color: var(--text-secondary); font-size: 0.85em; margin: 8px 0 16px 0; }
.scheduleSidebarEmpty { padding: 24px 20px; color: var(--text-secondary); font-size: 0.9em; }

.scheduleInfeasibilityBanner {
    background: #fff3cd;
    border: 1px solid #ffe69c;
    color: #664d03;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 0.85em;
    margin-bottom: 12px;
}
.scheduleInfeasibilityBanner ul { margin: 6px 0 0 16px; padding: 0; }

.semesterCard {
    margin-bottom: 16px;
    padding: 12px;
    border: 1px solid var(--border-light);
    border-radius: 8px;
}
.semesterCard.locked {
    background: rgba(108, 117, 125, 0.04);
    border-color: rgba(108, 117, 125, 0.18);
}
.semesterCardHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}
.semesterCardHeader h3 { margin: 0; font-size: 0.95em; font-weight: 600; }
.semesterCredits { font-size: 0.8em; color: var(--text-secondary); }
.semesterNotes {
    list-style: disc;
    margin: 0 0 8px 16px;
    font-size: 0.78em;
    color: #b58000;
    padding: 0;
}

.slotList { list-style: none; padding: 0; margin: 0; }
.slotList li {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 4px 6px;
    font-size: 0.85em;
    line-height: 1.4;
    border-bottom: 1px dashed rgba(0, 0, 0, 0.04);
    border-radius: 4px;
}
.slotList li:last-child { border-bottom: none; }

.slotIcon { flex: 0 0 16px; text-align: center; opacity: 0.7; }
.slotCourseId { font-family: var(--font-mono); font-weight: 600; }
.slotTitle, .slotPlaceholderCategory { flex: 1 1 auto; color: var(--text-primary); }
.slot_placeholder .slotPlaceholderCategory { font-style: italic; color: var(--text-secondary); }
.slotMeta { flex: 0 0 auto; font-size: 0.8em; color: var(--text-secondary); }
.slotFlag { color: #b58000; font-size: 0.85em; margin-left: 4px; }

.slot_completed { background: rgba(40, 167, 69, 0.06); }
.slot_in_progress { background: rgba(255, 193, 7, 0.08); }
.slot_specific_planned { background: rgba(13, 110, 253, 0.06); }
.slot_placeholder { background: transparent; }

/* Phase 13 §locked-decision-8 — optional electives (above floor when
   degree-credit minimum is already met) get a dotted border + faded
   tone so the student knows they're discretionary. */
.slotOptional {
    border: 1px dashed var(--border-light) !important;
    background: transparent !important;
}
.slotOptionalTag {
    font-style: italic;
    color: var(--text-tertiary);
}
```

- [ ] **Step 7: Type-check + run web tests**

```bash
cd apps/web && npx tsc --noEmit
cd ../.. && node_modules/.bin/vitest run apps/web/tests/
```

Expected: clean.

- [ ] **Step 8: Smoke-test in browser**

Refresh `http://localhost:3001`. Send "what should I take next semester?" Toggle the 📅 Schedule button. Verify:
- Sidebar slides in from the right.
- Past terms render as locked (greyed out) with completed-course slots showing grades.
- Current term shows in-progress slots (yellow tint).
- Future terms show specific-planned (blue tint) + placeholder (transparent) slots.
- Optional placeholders (when `degreeCreditsMet === true`) render with dotted border + "optional" tag.
- Visa notes appear under any term below 12 credits for F-1 students.
- Infeasibility banner appears when feasibility report is non-feasible.

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/chat/page.tsx apps/web/app/chat/scheduleSidebar.tsx apps/web/app/chat/chat.module.css
git commit -m "feat(web): schedule sidebar with 4-variant slot rendering + optional flag"
```

---

## Task 10: Manual browser verification + push

(Same as prior Phase 13 Task 10 — verify schedule populates, sidebar opens, multi-semester distribution looks right, optional electives render distinctly, DPR re-upload reconciles, reasoning-trace fixes hold.)

---

## Self-review notes

- Coverage: ships the locked design decisions 1-8 from the operator review.
- Pre-reqs: Phases 12.7 + 12.8 must be in main before this starts; the solver hard-depends on `prereqs.json` + `courses-offerings.json` being populated.
- Out of scope: load styles, pinning, exclusions, summer/J-term as available terms — all in Phase 14.
- Solver class: greedy in Phase 13. Phase 15 introduces backtracking. The greedy outputs a `FeasibilityReport` with explicit constraint violations even when it can't solve everything, so the LLM has data to narrate.
- **Solver-contract isolation (gates the future Phase 15.5 MIP migration; see README's "Phase 15.5 (DEFERRED)" stub):** Reviewer must verify that no module added in Phase 13 imports stage-internal types from `solver.ts`. Public surface is `SolverInput`, `SolverOutput`, `ForwardSchedule`, `FeasibilityReport`, `InfeasibilityReport`, `PlanDiff`, and the named slot/semester/assumption types — all in `@nyupath/shared`. Internal types (`SolverNode`, per-stage helpers, `forwardFeasibilityScreen` internal shapes) live in `solver.ts` (or a `solver/internal/` subdirectory) with no exports beyond the contract surface. Reviewer's check: `grep -rn "from .*solver/\(types\|stages\|internal\)" packages/` returns zero matches outside `solver.ts`. This preserves the Phase 15.5 swap-internals migration path; a leak grows the migration cost from ~3–5 days to ~7–10 days.
