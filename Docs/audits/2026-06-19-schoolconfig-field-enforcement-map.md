# School-config field → enforcement map (2026-06-19)

**Status:** reference. **Decision: KEEP all current `data/schools/*.json` fields** (including the currently-dormant ones) for future implementations. Do **not** run a naive "delete unused fields" cleanup — see *Why keep* below.

**Scope:** classifies every field in the 11 per-school configs (`data/schools/*.json`) by the *exact* mechanism that resolves it today, so future work doesn't mistake deliberately-retained bulletin facts for dead code. Grounded in code (file:line verified 2026-06-19).

## Background (one paragraph)

`data/schools` was authored in **Step 8c** (`6a0ae49`, 2026-06-04) as a provenance-cited per-school **facts** dataset, filling the Phase-0 `schoolConfigLoader` path. The original Phase 10–12 intent was full rule-engine enforcement; the **Phase-7E DPR-first pivot** + the **Step-8b rule-engine decommission** reversed that, and **Step 8e parts 1–3 (PRs #28–#30: `2ee4a4c` / `5e33a44` / `3a5a051`)** already purged the orphaned validators and every DPR-duplicate / inferred-default / orphaned field, establishing the rule *"configs record ONLY bulletin-confirmed facts."* What remains is intentional. See `Docs/deprecated/README.md`, `Docs/audits/2026-06-05-AUDIT_FINDINGS.md`, and `Docs/audits/2026-06-04-schoolconfig-spotcheck/`.

## The map (six mechanisms)

### ① Hard-enforced — can block/alter a forward plan
| Field | Source | Where it bites |
|---|---|---|
| `maxCreditsPerSemester` | config | solver per-term **ceiling** — `checkPerTermCeiling` (`constraintModel.ts:499`) |
| `f1FullTimeMinCredits` | config | validator **visa axis** — `checkPerTermFloor` → `visaValidator` (F-1 only) |
| `domesticPartTimeFloor` | config | validator **visa axis** — same path (`constraintModel.ts:540`) |
| `passFail.canElect` / `careerLimitType` / `careerLimitValue` | config | **8th P/F axis** (`passFailLimitAxis.ts:44/61/49`) |
| GPA floor (`cumulativeGpaRequired`) | **DPR** | `checkGpaFloors` (`constraintModel.ts:696`) |
| Residency (`residencyRequired`) | **DPR** | `checkResidencyFloor` (`constraintModel.ts:646`) |
| Credits required (`creditsRequired`) | **DPR** | `checkCreditMinimum` (`constraintModel.ts:571`) |
| P/F cap (`passFailCapUnits` / `passFailUsedUnits`) | **DPR** | 8th P/F axis |

The 7-axis `graduationPathValidator` reads the **DPR + program rules**, not raw config caps (only `passFail` reaches it, for the 8th axis).

### ② DPR-sourced but NOT enforced (surfaced for citation only)
- `outsideHomeCapUnits` — the in-NYU cross-school cap; `get_credit_caps` *displays* it, no solver gate.
- `timeLimitYears` — shown in `get_credit_caps` + `run_full_audit`, no feasibility check.

### ③ Tool-surfaced advisory (config read by a tool → numbers/labels; nothing downstream enforces)
- `creditCaps[]`, `overloadRequirements`, `transferCreditLimits` → `get_credit_caps` (doc: *"No enforcement module… surfaces the numbers; nothing downstream automatically enforces"*).
- `gpaTierTable`, `finalProbationGpaFloor`, `completionRatePolicy` → `get_academic_standing` computes a **standing label** (good / concern / final-probation / dismissed); hard branches inside, but the label is **informational — it does not gate the planner**.
- `doubleCounting.*` → `doubleCountAdvisory` → a `Disclaimer` (*"NO enforcement"*; advisory re-added 2026-06-07, Plan 31).
- `courseSuffix[]` → `searchCourses` (scopes course accessibility in search) — consumed, not a planning constraint.

### ④ Consumed by the P/F-eligibility helper (what-if / probe path, not solver/validator)
- `passFail.countsForMajor` / `countsForMinor` / `countsForGenEd` → `pfEligibility.ts:146-152` (switch over requirement category), reachable from `probe_counterfactual` / `propose_whatif_assumption`. **(A 2026-06-19 ad-hoc field scan false-flagged `countsForMinor`/`countsForGenEd` as dead — they are live. Do not trust a "never-read" scan as a delete-list.)**

### ⑤ RAG-answered
- `gradeThresholds` ("C required in the major") — removed from config in Step 8e; answered via `search_policy`.

### ⑥ Currently unconsumed — ZERO readers today (retained, provenance-cited; **dormant, not dead**)
`residency.{type, finalCreditsInResidence, majorMinorResidencyPercent}` · `spsPolicy.*` (all 6 sub-fields) · `deansListThreshold.*` · `maxCourseRepeats` · `passFail.{perTermLimit, perTermUnit, gradePassEquivalent, failCountsInGpa, creditType, excludedCourseTypes, autoExcludedFromLimit}` · `creditCaps[].{subtype, maxPerDepartment}`.

These are the deliberate "asked-facts" bucket from Step 8e — bulletin-confirmed and provenance-cited, but **no tool/RAG path surfaces them to the agent today**. They are retained-for-future, not wired.

## How the engine resolves the *un-enforced* caps

It largely **doesn't enforce** them — by design:
1. **The DPR is authoritative** — Albert already enforced GPA / residency / credits / P-F / outside-home / time-limit on the real record. The planner *re-enforces* the four structural ones as forward axes and **trusts the DPR** for outside-home + time-limit (surfaced, not gated).
2. **Tools surface** the numbers/labels for the agent to **cite + hedge** (`get_credit_caps`, `get_academic_standing`) — no automatic enforcement.
3. **RAG** answers narrative policy (grade thresholds).
4. **⑥ is dormant** retained data.

## Why keep ⑥ (the decision)

- Not dead rule-engine cruft — that was already purged in Step 8e. These are cited bulletin facts.
- Near-zero carrying cost (a handful of JSON fields + `_provenance` rows + schema entries).
- Plausible future consumers: an "ask-the-adviser facts" citation surface (`spsPolicy`, `deansListThreshold`, `maxCourseRepeats`), per-term P/F enforcement (`passFail.perTermLimit`/`perTermUnit`, Plan 37 C1/C2 if pursued), or a cross-school-cap feature (`outsideHomeCapUnits`).
- Re-deriving them later means re-researching the bulletin; keeping them preserves the verified, cited fact.

If a future lean-config pass *does* prune ⑥, it must also drop the matching `configSchema.ts` entries and the `_provenance` rows in each config (don't leave half-removed fields).

**Related:** `Docs/plans/37-2026-06-18-slot-editor-actions-and-pf-validation.md` (D-4 + the "do NOT run a dead-field cleanup" note), `Docs/current-system/tools/get_credit_caps.md` + `get_academic_standing.md`, `Docs/current-system/surrounding/shared-package.md §3.4`.
