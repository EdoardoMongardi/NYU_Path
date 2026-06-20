# Phase 38 — FOSE section-scheduling re-plan (cross-term conflict cascade + section picker)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **Before any work, read [`Docs/core_philosophy.md`](../core_philosophy.md).**

> **Status:** PLANNED (written 2026-06-19, verified against code at `main` `ffd3834`). Supersedes the deferred FOSE re-plan items in spec §9 and the stubbed Decision #19 in `materialize.ts`/`materializeSections.ts`.

---

## Binding invariants (read first — these are non-negotiable)

1. **Frozen engine contract.** `solveForwardSchedule` / `finalizeForwardSchedule` / the constraint search / the 8-axis `graduationPathValidator` are **NOT modified**. This phase adds a section→structure **bridge** that sits strictly ON TOP and re-uses the existing solve+validate seam. (The 8th P/F axis in plan 37 was the one owner-approved extension; this phase adds none.)
2. **Every re-plan is requirement-validated.** A section conflict never edits a schedule directly. It emits one or more **plan mutations** (`move` / `swap` / `exclude` / `addTerm` — the kinds `propose_plan_change` already accepts) and re-solves through `finalizeForwardSchedule`, whose verdict (`valid-clean` / `valid-with-trade-offs` / infeasible) gates everything. **Never ship an invalid plan** (CORE philosophy + plan 37 M1/M2): an infeasible re-plan shows the red explanation card, never a commit.
3. **Deterministic on validity, then preferred.** Section feasibility is a *constraint on which valid plan we land on*, never a way to ship an invalid one. Among valid re-plans, professor/recitation/time preferences only *rank* (soft objectives / scheduling preferences).
4. **R1 guardrail.** No synthetic/section-driven artifact is ever written to `students.parsed_dpr`; a confirmed re-plan persists only `forward_schedule` (the plan-35/37 pattern via the existing confirm chokepoint).
5. **Surface as a confirmable proposal.** Re-plans reuse the plan-36/37 propose→preview→confirm + scenarios infrastructure (`plan_proposal` SSE → a `kind:"proposed"` scenario → the single Confirm chokepoint). The section layer never auto-commits.
6. **Cite-or-hedge.** FOSE data is live but incomplete (no recitation model yet; some calendar windows unsourced). Where the engine can't compute with confidence, it hedges + "verify with your adviser/registrar" — never fabricates a section, professor, or deadline.

---

## §0. What is ALREADY BUILT (verified against code 2026-06-19 — do NOT rebuild)

The Phase-15 section-materialization foundation is complete and tested. Start here:

| Capability | Where | Status |
|---|---|---|
| Live FOSE class-search client | `packages/engine/src/api/nyuClassSearch.ts` (`searchCourses` → `https://bulletins.nyu.edu/class-search/api/`, `API_BASE` :144) | ✅ built |
| `search_availability` tool | `agent/tools/searchAvailability.ts` (injectable `searchFn`; prod = live client) | ✅ built |
| Meeting-time parsing | `sectionMaterialization/parseMeetingTimes.ts` (`meets` + `meetingTimes` JSON; 27 fixtures) | ✅ built |
| Availability classification | `sectionMaterialization/foseAvailabilityGate.ts` (`classifyAvailability` → full/partial/unavailable) | ✅ built |
| 5-min TTL cache | `sectionMaterialization/foseCache.ts` (`DEFAULT_TTL_MS=300000`) | ✅ built |
| Time-conflict detection | `sectionMaterialization/conflictDetection.ts` (`patternsOverlap` half-open; `enumerateConflictFreeCombinations`, `MAX_COMBINATIONS=50`) | ✅ built — **single fixed per-term set; cannot move courses across terms** |
| Scheduling-preference filter | `sectionMaterialization/applySchedulingPreferences.ts` (Decision #43: strict-drop + soft-rerank) | ✅ built |
| 11-step orchestrator | `sectionMaterialization/materialize.ts` | ✅ built — **step 7 swap cascade present but the hook is stubbed** |
| `materialize_sections` (read-only) + `confirm_section_combination` | `agent/tools/materializeSections.ts` | ✅ built — confirm attaches CRN/meeting/instructor metadata onto already-bound `specific_planned` slots in place; never re-places, never re-validates |
| Propose→confirm + scenarios + `plan_proposal` SSE | plans 36/37 (`planState.ts`, `scenarioModel.ts`, `planProposalEvent.ts`, `/api/plan/*`) | ✅ built — the surface for proposals |
| Plan mutations | `forwardSchedule/planChangeHelpers.ts` (`move`/`swap`/`exclude`/`pin`/`addTerm`/`setSchedulingPreference`/`addSoftObjective`) | ✅ built — the re-plan vocabulary |

**The one stub that blocks the owner's scenario:** `materialize.ts` step 7 calls `swapHook(courseId, reason)` (`:347`); the hook is `async () => null` (`materializeSections.ts:198-201`), so a course with no conflict-free / open section is **dropped** (`dropped[]`, `:349`) rather than swapped or moved. And a HARD time-conflict surfaces only as the message *"Found courses but no conflict-free combinations exist"* (`materialize.ts:430`) with **no re-plan trigger**.

**Two more known coarsenesses to fix (Phases F + G):** (1) **Recitation** — FOSE rows carry the component type `schd` (`LEC`/`RCT`/`LAB`, `nyuClassSearch.ts:37`), but `conflictDetection` enumerates ONE section per course, so a course needing a lecture **and** a required recitation (two time-blocks, both must be conflict-free) is not modeled. (2) **Waitlist** — `isOpenStatus` (`materialize.ts:222`) returns true for BOTH `"O"` and `"W"`, so waitlist sections are silently treated as open; and `FoseSearchResult` has **no waitlist-count field** (search returns only O/W/C, never the queue length).

---

## §1. The gap = the owner's scenario

After FOSE-API integration (done) the agent queries the next term's live sections and checks whether a conflict-free time-combination exists for the current plan's courses, factoring section timing, instructor preference, and recitation timing. Two outcomes are currently unhandled:

- **HARD conflict** — no conflict-free section combination exists for a term's planned course set (`materialize` returns zero `combinations`), OR a course has no open/available section at all. Today: dropped/dead-ends. **Target:** force a re-plan of that term that **cascades forward** (move the un-schedulable course to a later term; re-solve the rest).
- **SOFT conflict** — a conflict-free combo exists but the student rejects it (dislikes all live sections — e.g. every CS421 professor this term, or the only recitation slot clashes). Today: no affordance. **Target:** re-plan current + future terms (CS421 moves to a later term for different professors; next term's CS421 slot becomes a different course; if swapping one course doesn't yield a valid plan, multiple courses may move and **the agent must surface the multi-course trade-off**).

Both are *constraints that select among valid plans*. Neither may ever produce an invalid plan.

**Trigger frequency (don't over-engineer the rare branch).** Empirically, real Albert/FOSE sections carry complete meeting times, so `classifyAvailability` (`foseAvailabilityGate.ts`) almost always returns `full`. The re-plan triggers worth engineering for are, in order of real-world frequency: **(1) `unavailable` — the course is simply not offered next term (0 sections)**, the most common and the clearest "move it to a later term" case; **(2) a genuine time-conflict** (zero conflict-free combos); **(3) student rejection** (instructor/timing/recitation). The `partial` state (meeting times present but un-parseable) is a **rare defensive safety-net** for malformed FOSE data — keep it at a hedge ("section data looks incomplete — verify with your adviser"); do NOT build re-plan logic on it. Two clarifications that prevent false triggers: a missing **instructor** does NOT lower availability (the gate reads meeting *times*, not professors — a `TBA`-instructor section is still `full`; instructor-rejection is the separate SOFT path), and a **by-arrangement / TBA / async** course (e.g. private-lesson piano) parses as `asynchronous` ⇒ counts as `full` and never conflicts in time-detection — it is handled gracefully, not as a data gap.

**FOSE DATA AUDIT (done 2026-06-19 against the 27 recorded fixtures `packages/engine/tests/fixtures/fose/`) — answers the two data questions empirically:**
- **Components (recitation / lab / tutorial): identifiable, common, but UNLINKED.** Every row carries `schd` = `LEC`/`RCT`/`LAB`/`TUT`/`SEM`…. Multi-component is normal — MATH-UA 121 = 18 LEC + 83 RCT + 21 LAB; CHEM-UA 125 = 6 LEC + 23 RCT + 36 LAB + 37 TUT — and single-component is also common — CSCI-UA 101 = 22 LEC, no recitation. **But there is NO field linking a RCT/LAB to its parent LEC**: no row references another row's `crn`/`key`; `no` is ambiguous (several distinct sections share `no="001"`); `mpkey` is a meeting-pattern id (same-time sections share it), not a group key. ⇒ Baseline model = a course needs **one section of each required component type, all time-conflict-free**; the *which-RCT-pairs-with-which-LEC* linkage is NOT in the search row → free-pairing approximation + hedge, OR a `getCourseDetails` probe (the Phase-F pairing refinement).
- **Waitlist number: NOT available.** Search rows carry `total` (= section **capacity**, e.g. "35") + `stat` (`O`/`W`/`C`/`A`) — but **no enrolled-count, no waitlist-count, no queue-position**. ⇒ the agent **cannot** say "N people ahead of you" → **hedge the number** ("check the waitlist length in Albert"), never fabricate. (`total`/capacity IS available as context and isn't surfaced on `SectionView` today; the detail endpoint is unverified for a count → default to hedge.)
- **Status caveat.** The fixtures are pre-registration snapshots (`stat` all `"A"`), so they don't exercise live `O`/`W`/`C` — but the field SET is fixed, so both findings hold for live data (the absence of a waitlist-count field is a schema fact, not a snapshot artifact).

---

## §2. Architecture — enumerate → score → pick; escalate only if all are rejected

Once a term's courses are materialized, the PRIMARY flow is **not** "find a conflict → re-plan." It is: **enumerate every feasible single-term schedule, score them by preference, show the student the top few, and let them pick.** A structural re-plan is the LAST resort — only when the student rejects every feasible schedule (or none is feasible).

**① Enumerate all feasible single-term schedules.** Per planned course, pull live sections and group by component (`schd`: LEC / RCT / LAB / TUT…). A *course selection* picks one section of EACH required component (lecture-only like CSCI-UA 101, or lecture + recitation + lab like CHEM-UA 125). A *schedule* picks one selection per course. Feasible iff: **(a) no time conflict** among ALL chosen blocks — every component of every course (a recitation/lab clashes exactly like a lecture), via the existing `conflictDetection`; **(b) not closed/cancelled** — each section is open (`O`) or waitlist (`W`); **(c) strict student prefs honored** (e.g. "no Friday", a rejected instructor); **(d) graduation-safe even on waitlist** — a `W` section is allowed ONLY with a valid OPEN fallback: preferentially an open section of the SAME course (Albert auto-swap ⇒ trivially grad-safe — usually just a different section of the same class), else an open course satisfying the same requirement leaf, validated grad-safe.

**② Score + rank.** Each feasible schedule scores by preference: **open ≻ waitlist** (penalty per waitlisted section), **fewer waitlisted sections is better**, then the student's time/day/instructor soft prefs (reuses the Decision-#43 rerank weights + a waitlist term).

**③ Top-5 picker (+ see-more).** Show the top 5 schedules; if >5 are feasible, "see more" reveals the next 5 by score (the strict filters usually leave few; `MAX_COMBINATIONS=50` already caps enumeration). Student picks → `confirm_section_combination` (attach CRN/meeting/instructor); each waitlisted section in the pick gets the open-fallback + Albert auto-swap recommendation.

**④ Escalate ONLY if the student rejects every feasible schedule** (or none is feasible: a required course isn't offered / every combo clashes). Then the structural **resolution ladder** — the section→structure bridge below — re-solves through the FROZEN solver:

```
materialize.ts result  ──▶  sectionReplanBridge (NEW)  ──▶  plan mutation(s)
   { combinations:[],            classify the failure          move/swap/exclude/addTerm
     dropped:[...] }             choose a resolution                    │
                                 strategy (within-term →                ▼
                                 cross-term → multi-course)   finalizeForwardSchedule (FROZEN)
                                                                        │  requirement-validated
                                                                        ▼
                                                              valid? → plan_proposal (proposed scenario, Confirm)
                                                              invalid? → red explanation card (no commit)
```

**Resolution ladder (cheapest first; stop at the first valid result):**
1. **Within-term swap (Decision #19)** — wire the stubbed `swapHook` to ask the structural solver for an alternative *course in the same term* that satisfies the same requirement leaf and has an open, conflict-free section. (Smallest change; the orchestrator already has the cascade slot.)
2. **Cross-term move** — if no within-term swap exists, move the un-schedulable course to the **nearest later term whose domain allows it** (`move` mutation) and re-solve forward. The course keeps satisfying its requirement; the term it vacated may pull a different planned course earlier.
3. **Multi-course re-plan** — if a single move is infeasible (cascade breaks a prereq/credit/grad-term axis), search a bounded set of multi-course move/swap combinations; pick the valid one with the smallest disruption (fewest moved courses, latest-unchanged grad term). If several are valid, present the top trade-offs.
4. **No valid resolution** — surface honestly: "these courses can't be scheduled together next term and I can't find a valid re-plan that keeps your graduation target — here are the options (push graduation a term / open a summer term / drop a preference)." Never invent one.

Every rung 1–3 ends in `finalizeForwardSchedule` → only a `valid-clean`/`valid-with-trade-offs` result becomes a proposal.

---

## §3. Decisions to confirm with the owner (each has a chosen default)

- **D1 — Trigger surface.** The section→replan check runs (a) automatically when the agent materializes the near term and finds a HARD conflict, AND (b) on an explicit student rejection (SOFT). *Default: both; the auto path emits a proposal the student can ignore, never an auto-commit.*
- **D2 — SOFT-rejection vocabulary.** Student rejections map to **scheduling preferences** (`setSchedulingPreference`, Decision #43) extended with `rejectInstructor` / `rejectSection(crn)` / `avoidRecitationConflict`. *Default: extend the existing `SchedulingPreferences` schema (strict=hard-drop, soft=rerank) rather than a new mutation kind.*
- **D3 — Cross-term move target.** Move to the **nearest later fall/spring term whose offering domain + prereqs allow the course**; only open a summer/J-term if the student opted in (`addTerm`) — and label it optional (plan 37 L1/L2 rule). *Default: nearest later regular term; summer only on opt-in.*
- **D4 — Multi-course search bound.** Cap the multi-course search at K moved courses (start K=2) and N candidate plans, ranked by disruption. *Default: K=2, reuse the solver's existing top-K; never an unbounded search.*
- **D5 — Multi-component courses (LEC + RCT / LAB / TUT).** A course selection picks one section of EACH required component, and ALL component times join conflict detection. Pairing-linkage (which RCT pairs with which LEC) is NOT in the FOSE search row (audit). *Default: free-pairing approximation (any RCT/LAB of the course, time-compatible) + hedge; a `getCourseDetails` probe is the refinement (Phase F).*
- **D6 — Waitlist is feasible, just lower priority.** A waitlisted section keeps a schedule feasible IFF it has a valid open fallback. *Default: include waitlist schedules, penalize per waitlisted section in scoring, require the fallback (preferentially a same-course open section ⇒ Albert auto-swap, grad-safe), surface the auto-swap advice; the engine only RECOMMENDS, never registers.*
- **D7 — Present top-5; escalate on reject-all.** *Default: rank feasible schedules by score, show top 5 + a "see more" (next 5 by score); run the §2-④ escalation ladder ONLY when the student rejects every feasible schedule, or none is feasible.*
- **D8 — Waitlist number.** Not available from FOSE search (audit — only `total`/capacity + `O`/`W`/`C`). *Default: decide on status + student willingness + capacity, and HEDGE the queue length; optionally probe `getCourseDetails` for a count (open question G0).*
- **D9 — Section-picker UI scope.** A workspace top-5 schedule picker (read-only) fed by a new `/api/v2/materialize` route wrapping the orchestrator; "use this schedule" drives `confirm_section_combination`. The escalation re-plan reuses the existing `plan_proposal` proposal surface. *Default: as stated.*

---

> **Phase ↔ §2 map.** The PRIMARY flow (§2 ①②③ — enumerate, score, top-5 picker) is **Phase 0** below. The structural **escalation** (§2 ④) is **Phases A–D** (bridge / swapHook / cross-term / SOFT-reject). **Phase F** (multi-component) + **Phase G** (waitlist) supply the feasibility rules ① depends on, so they land WITH Phase 0. **Phase E** is the picker UI. Suggested build order: **F0** (pairing audit) → **F1 + G1** (component + O/W feasibility) → **Phase 0** (enumerate + score + top-5) → **E** (picker) → **A–D** (escalation) → **G3** (auto-swap advice).

## Phase 0 — Feasible-schedule enumeration + scoring + top-5 picker (PRIMARY; §2 ①②③)

**Goal:** from a term's planned courses + live FOSE sections, produce the ranked top-N feasible single-term schedules.

**Files:** extend `sectionMaterialization/materialize.ts` (group by `schd`, enumerate per-component, score) + `conflictDetection.ts` (multi-block selections) + `applySchedulingPreferences.ts` (soft scoring); reuse `MAX_COMBINATIONS=50`.

- [ ] **0.1 — component grouping:** group a course's sections by `schd`; a *course selection* = one section of each required component type present (LEC + any RCT / LAB / TUT). Test: CSCI-UA 101 → lecture-only selections; CHEM-UA 125 → LEC × LAB × (RCT/TUT) selections.
- [ ] **0.2 — feasible enumeration:** enumerate schedules (one selection per course); keep only those with **no time-conflict across ALL component blocks** (extend `enumerateConflictFreeCombinations` to multi-block selections), **all open-or-waitlist**, **strict-prefs-ok**, and **waitlist ⇒ an open fallback exists** (Phase G). Test: a fixture where the only conflict-free schedule needs one specific recitation.
- [ ] **0.3 — score + rank:** score = open ≻ waitlist penalty + fewer-waitlists-better + soft-pref rerank (Decision #43 weights); return top-N sorted. Test: an all-open schedule outranks an equivalent waitlist one; a soft-pref match outranks a non-match.
- [ ] **0.4 — top-5 + see-more contract:** the result exposes the top 5 + a cursor for the next 5 by score. Test: >5 feasible → page 1 = 5, page 2 = next 5.

## Phase A — The escalation bridge (§2 ④; engine, pure)

**Goal:** a pure module that turns a `MaterializationResult` (+ the current `ForwardSchedule` + DPR + a rejection signal) into a ranked list of candidate plan-mutation batches, each already re-solved + validated. **Runs only when the student rejects every feasible schedule (or none is feasible).**

**Files:** NEW `packages/engine/src/agent/sectionMaterialization/sectionReplanBridge.ts`; read `materialize.ts` (result shape), `forwardSchedule/planChangeHelpers.ts` (mutation kinds + `applyMutationsToPreferences`/`resolveBindMutations`), `forwardSchedule/build.ts` (`finalizeForwardSchedule`), `forwardSchedule/buildSolverInput.ts`.

- [ ] **A1 — failure classifier.** Pure function `classifySectionFailure(result, rejections) → { kind: "hard-conflict" | "course-wipe" | "soft-rejection", courseIds[] }`. Test: zero-combinations → hard-conflict; `dropped[]` non-empty → course-wipe; rejection signal → soft-rejection.
- [ ] **A2 — resolution-ladder generator.** Pure function that, given a classified failure, emits an ordered list of mutation batches (rung 1→3 of §2). Rung 1 = `swap` (within-term alt course); rung 2 = `move` (course → later term); rung 3 = multi-course move/swap (≤ K). Test: each rung produces the expected mutation array shape.
- [ ] **A3 — validate-each-candidate.** For each batch, run the EXISTING `propose`-path internals — the exact chain in `proposePlanChange.ts:146-176`: `applyMutationsToPreferences` → `buildSolverInputWithRulesFromSession` → `solveForwardSchedule` → `finalizeForwardSchedule` — and keep only `validatorResult.feasible` results, ranked by disruption (fewest moved courses, unchanged grad term first). **Do not modify `finalizeForwardSchedule`/the solver/the validator** (verified composition point, used by both build + propose paths). Test: a hard-conflict on a fixture yields ≥1 valid re-plan whose grad term is unchanged when a later term has room.
- [ ] **A4 — honest no-op.** When no rung yields a valid plan, return `{ resolutions: [], reason }` with the binding constraint (from the validator's `infeasibilityReport`). Test: an over-constrained fixture returns empty + a non-empty reason.

## Phase B — Wire the Decision #19 within-term swapHook

**Goal:** replace the `async () => null` stub with a real within-term course-swap that asks the structural layer for an alternative course satisfying the same requirement leaf.

**Files:** `agent/tools/materializeSections.ts` (`swapHook` at `:198-201`); read `forwardSchedule/constraintModel.ts` (`poolMembersFor` — requirement membership), `forwardSchedule/materializePlan.ts` (pool descriptors).

- [ ] **B1 — failing test** (`materialize` integration): a course with zero open sections, whose requirement leaf has another catalog member that IS offered + open this term, gets **swapped** (not dropped). Assert `finalBundles` contains the alt, `dropped` is empty.
- [ ] **B2 — implement** `swapHook`: given `(failedCourseId, reason)`, look up the requirement leaf `failedCourseId` was satisfying, enumerate `poolMembersFor` that leaf, return the first alternative offered+open this term (or `null`). Keep it pure/deterministic. **No change to the solver.**
- [ ] **B3 — resolve the documented I-1 rerank-weight no-op** (`materialize.ts:353-377`) only if cheap; else leave the documented behavior. Test: swapped combos still rank sanely.

## Phase C — Cross-term move + forward cascade (the HARD case)

**Goal:** when no within-term swap exists, move the un-schedulable course to a later term and re-solve forward — requirement-validated.

**Files:** `sectionReplanBridge.ts` (rung 2); read `planChangeHelpers.ts` (`move`), `buildSolverInput.ts` (offering domains / `includeSummer`/`includeJTerm`).

- [ ] **C1 — failing test:** a term with an unavoidable HARD conflict between two requirement courses → the bridge emits a `move` of one course to the nearest later term whose domain allows it; `finalizeForwardSchedule` returns `valid-with-trade-offs` (grad term may shift) and the vacated term re-fills. Assert the moved course still satisfies its leaf.
- [ ] **C2 — implement** rung 2: pick the move target per D3 (nearest later regular term; summer only on opt-in, labeled optional per plan 37 L1/L2). Re-solve via the frozen seam.
- [ ] **C3 — grad-term honesty:** if the only valid move pushes the graduation target later, the proposal's `consequences` MUST say so explicitly (reuse `deriveConsequences`/`buildPlanDiff`). Test: the consequence string names the new grad term.

## Phase D — SOFT-rejection re-plan (reject sections / professors / recitation)

**Goal:** let the student reject the live sections (timing / professor / recitation) and trigger a re-plan that may move the course to a later term for different professors.

**Files:** extend `SchedulingPreferences` (`packages/shared/src/types.ts`) per D2; `applySchedulingPreferences.ts`; `sectionReplanBridge.ts` (rung detection); the SOFT path of `materialize`.

- [ ] **D1 — failing test:** with a `rejectInstructor: [<all CS421 profs this term>]` strict preference, every CS421 section is eliminated → course-wipe → the bridge first tries a within-term swap, then a cross-term move (CS421 → a later term), and the next term's slot re-fills with a different valid course. Assert validity + that CS421 moved.
- [ ] **D2 — implement** the extended scheduling preferences (`rejectInstructor` / `rejectSection` / `avoidRecitationConflict`), strict ⇒ drop (feeds course-wipe → bridge), soft ⇒ rerank only. Reuse the Decision #43 machinery.
- [ ] **D3 — multi-course trade-off (rung 3):** when one move isn't valid, the bridge searches ≤ K multi-course batches and the agent presents the top trade-offs ("to free CS421 for new professors next term, MATH-UA 121 also shifts — here's the impact"). Test: a fixture where a single move is infeasible but a 2-course batch is valid.

## Phase E — Section-picker UI + the proposal surface

**Goal:** surface live sections + conflict-free combos in the workspace, and surface a forced re-plan as a confirmable proposal (reusing plans 36/37).

**Files:** NEW `apps/web/app/api/v2/materialize/route.ts` (wraps `materialize_sections`, read-only); NEW workspace section-picker component; reuse `planProposalEvent.ts` / scenarios / `/api/plan/confirm`.

- [ ] **E1 — `/api/v2/materialize` route** (read-only): given a term, returns the `MaterializationResult` (combos + dropped + state). Test: route returns combos for a seeded term; R1 — never writes `parsed_dpr`.
- [ ] **E2 — section-picker panel:** read-only list of conflict-free combos per term with status (open/waitlist/closed), instructor, meeting times; "use this combo" drives the existing `confirm_section_combination` (metadata attach only). Test: render + select.
- [ ] **E3 — forced re-plan as proposal:** when the bridge (Phase A) produces a valid re-plan, emit it through the EXISTING `plan_proposal` SSE → a `kind:"proposed"` scenario → Confirm chokepoint. Invalid → red explanation card (plan 37 M-path). Test: the proposed scenario carries the moved course + the consequence string; confirm persists only `forward_schedule`.

## Phase F — Recitation (LEC + RCT) co-scheduling  *(first-class; gated only on the F0 pairing-data audit)*

**Why first-class (owner clarification 2026-06-19):** many courses are a lecture PLUS a **required recitation** — e.g. the lecture meets Mon/Wed 2–3pm *and* you must also pick one RCT slot during the week. **That recitation's meeting time must join the same conflict graph as every other course (and every other course's recitation).** So one valid combo for such a course = a **(LEC time + RCT time) pair, BOTH conflict-free with the whole term's selections**. This changes what `conflictDetection` enumerates, so — if F0 confirms the data — F1 is **foundational** and should land before/with Phase A's combo logic (every "conflict-free combo" in A/C/D depends on it once recitations exist).

**What we already have vs. what's missing:** FOSE search rows DO carry `schd` (`"LEC"` / `"RCT"` / `"LAB"` / `"SEM"` …, `nyuClassSearch.ts:37`) + `crn` + `no`, so recitation rows ARE identifiable. **Missing:** today `enumerateConflictFreeCombinations` picks exactly ONE section (one time-block) per course (`conflictDetection.ts`) — it cannot require a LEC *and* a compatible RCT for the same course.

**Files:** `sectionMaterialization/conflictDetection.ts`, `materialize.ts` (re-bucketing), `parseMeetingTimes.ts`; possibly `nyuClassSearch.ts:getCourseDetails` for the pairing key.

- [ ] **F0 — pairing-data audit (FIRST, gating):** from recorded fixtures, determine HOW a RCT links to its parent LEC — derivable from the search rows (`schd`/`no`/`crn` grouping) or only from the detail endpoint? Decide free-pairing (any RCT with the chosen LEC) vs. bound-pairing (a specific LEC↔RCT set). If the link is NOT reliably derivable → STOP: keep the agent's recitation hedge ("this course has a required recitation — confirm a recitation time that fits, in Albert / with your adviser") and document the gap.
- [ ] **F1 — model** a LEC+RCT course as a unit contributing TWO meeting-time blocks to a combo: extend combo enumeration so a valid combo includes a compatible `(LEC, RCT)` pair and BOTH blocks pass `patternsOverlap` against all other selected blocks. Test: a fixed LEC + 3 RCT options where only the non-clashing RCT survives.
- [ ] **F2 — recitation as a re-plan trigger:** a course whose every recitation clashes (or whose only non-clashing recitation is closed/waitlist-rejected) is a HARD-conflict / course-wipe trigger into the Phase-A bridge, exactly like a lecture clash.

## Phase G — Waitlist strategy (advisory; the engine never registers)

**Owner requirement:** lectures AND recitations are often waitlist. The agent should (a) distinguish waitlist from open, (b) factor the student's willingness to waitlist (and the queue number when available), and (c) when the student waitlists, recommend an OPEN fallback + Albert's auto-swap binding. Matches `core_philosophy.md:11`.

**Two hard truths from the code (don't overpromise):**
1. **The engine is READ-ONLY (CORE RULE 8)** — it NEVER registers, waitlists, or binds in Albert. Phase G is purely **advisory**: it surfaces status + recommends a strategy the student executes in Albert.
2. **FOSE search returns only `stat` = O/W/C — NOT the waitlist NUMBER** (`FoseSearchResult` has no count/position field — verified). So "identify the waitlist number if available" (philosophy) is currently **not satisfiable from the search endpoint** → either probe `getCourseDetails` (G0) or **HEDGE** ("I can't see the waitlist length — check it in Albert"). Never fabricate a number.

**Files:** `materialize.ts` (`isOpenStatus` at `:222` currently returns true for BOTH `"O"` and `"W"` — split it), `sectionMaterialization/types.ts` (`status`), `searchAvailability.ts` (already labels O/W/C), the Phase-E section-picker, the agent prompt.

- [ ] **G0 — waitlist-number audit:** check whether `getCourseDetails` / the raw FOSE detail response exposes a waitlist count or position. Yes → surface it; No → the agent hedges the number (cite-or-hedge). Document the finding.
- [ ] **G1 — distinguish O vs W in materialization:** stop treating `"W"` as plainly open. Keep waitlist sections in the combos but **tag** them `waitlist`, and rank an all-open combo above a waitlist-containing one when both exist. Test: an open combo ranks above a waitlist combo; the waitlist combo is labeled.
- [ ] **G2 — waitlist decision per preference:** a `willingToWaitlist` preference (+ an optional queue-length threshold when G0 yields a number) decides whether a waitlist-only course is acceptable or should trigger the Phase-A bridge (move to a later term / swap to an open alternative). Test: `willingToWaitlist:false` + a waitlist-only course → bridge re-plan; `true` → accept-with-caveat.
- [ ] **G3 — open fallback + auto-swap advice:** when the student waitlists, the agent RECOMMENDS (never performs) an OPEN fallback for the same requirement leaf + explains Albert auto-swap ("register the open course, add the waitlisted one and bind it via Albert's auto-swap; if it clears, Albert swaps the fallback out"). Deterministic copy, cite `core_philosophy.md:11`. Test: a waitlisted course with an open same-leaf alternative produces the fallback + auto-swap recommendation string.

## §4. Prerequisites & known hedged gaps (NOT blockers — fold in)

- **Calendar windows** (`dpr/academicCalendar.ts`): Shanghai-spring withdrawal + non-NY summer/J-term deadlines are unsourced → the slot matrix already hedges (cite-or-hedge). FOSE re-plan deadline gating inherits the same hedge. *Owner-fill data when available; not a code blocker.*
- **Non-CAS `requirementKind`** (`forwardSchedule/requirementKind.ts`): off-CAS leaves return `unknown` → the within-term swap (Phase B) hedges "I can't confirm this alternative counts for the same requirement at your school — verify with your adviser" for Shanghai/NYUAD. *Independent; hedge defensible meantime.*
- **GPA-of-a-hypothetical-fail, attempt-caps, composed what-ifs, grad-term feasibility** — all confirmed un-implemented but **FOSE-independent**; out of scope here (tracked separately).

## Self-review checklist (run before handing off)

- [ ] Frozen contract untouched: `git diff` shows **no** edits to `solveForwardSchedule` / `finalizeForwardSchedule` / the search / the 8 validator axes. The bridge only *calls* them.
- [ ] Every candidate re-plan flows through `finalizeForwardSchedule`; only `feasible` results become proposals; invalid → red card, no commit.
- [ ] R1: no section/re-plan artifact written to `parsed_dpr`; confirm persists only `forward_schedule` (byte-identity test as in plan 35).
- [ ] No fabricated sections/professors/recitations/deadlines — cite-or-hedge throughout; recitation hedged until Phase F0 confirms the data.
- [ ] Optional-term rule (plan 37 L1/L2) honored when a move opens summer/J-term.
- [ ] Engine + web `tsc --noEmit` clean; `npx vitest run` green; docs synced (philosophy #6): revise `Docs/current-system/engine/section-materialization.md` + `forward-schedule.md` + the spec §9 status when each phase lands.

## Open questions for the owner

1. **Auto vs. ask** for the HARD-conflict trigger (D1) — emit a proposal automatically on near-term materialization, or only when the student asks "can I take these next term?"
2. **Recitation pairing data** (F0) — owner-confirmed recitation conflict-checking is in scope (lecture + a required RCT, both must fit the whole term). The remaining unknown is purely a DATA question: is the LEC↔RCT link derivable from the search rows, or does it need the detail endpoint? (Drives whether Phase F is built now or hedged.)
3. **Disruption metric** (D4) — rank multi-course re-plans by fewest-moved-courses, or by latest-unchanged-grad-term, or a blend?
4. **Summer/J-term** (D3) — may a forced re-plan *suggest* opening a summer term (opt-in) when no regular-term move is valid, or never?
5. **Waitlist number** (G0) — FOSE *search* returns only O/W/C, no queue length. Worth probing the detail endpoint for a count, or hedge the number and decide on status + student willingness alone?
6. **Waitlist acceptance default** (G2) — absent an explicit `willingToWaitlist`, is a waitlist-only course (a) accepted with a caveat, or (b) treated as a re-plan trigger (prefer an open alternative)?
