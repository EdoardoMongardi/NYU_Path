# Wave 3 Run Report — Engine vs. Bulletin (Independent, Bulletin-only)

Run command:

```
npx vitest run packages/engine/tests/eval/independent/wave3.test.ts
npx vitest run packages/engine/tests/eval/independent/_dump_wave3.test.ts   # diagnostic
```

Engine version: working tree at `main` after waves 1+2 fixes have landed. Phase 3 modules in scope: `multiSemesterProjector`, `explorePlanner`, `transferPrepPlanner`, `crossProgramPlanner`, `transcript/confirmationFlow`.

Bulletin source: `data/bulletin-raw/...` snapshot scraped 2026-04-21.

Wave 3 contains **42 bulletin-derived assertions across 6 profiles** (3 failed, 39 passed).

Legend: ✅ MATCH, ❌ MISMATCH (engine contradicts bulletin/prediction), ⚠️ AMBIGUOUS / NOT-MODELED, 🟡 NEAR-MATCH (passes assertion but diagnostic dump exposes an unexpected detail).

---

## Profile 1 — Multi-semester projection: graduation semester

| Engine call | Bulletin/prediction | Engine output | Verdict |
|---|---|---|---|
| `projectMultiSemester(...).semesters.length` | between 1 and 6. | varies (length ≤ 6). | ✅ MATCH |
| `result.semesters[0].semester` | `"2025-fall"`. | `"2025-fall"`. | ✅ MATCH |
| `result.semesters[1].semester` | `"2026-spring"`. | `"2026-spring"`. | ✅ MATCH |
| `result.projectedGraduationSemester` | one of `["2026-spring","2026-fall","2027-spring"]`. | matched (in window). | ✅ MATCH |
| `result.semesters` cumulative non-decreasing | yes. | yes. | ✅ MATCH |
| `result.notes` mention "Assumed grade" | yes. | yes ("Assumed grade for projected courses..."). | ✅ MATCH |

**6/6 PASS for Profile 1.** Multi-semester projector cleanly projects forward with the documented Fall→Spring helper and emits a sensible `projectedGraduationSemester`. The cumulative-credits non-decreasing invariant holds.

---

## Profile 2 — Multi-semester projection: early halt with note

| Engine call | Bulletin/prediction | Engine output | Verdict |
|---|---|---|---|
| `result.semesters.length` | exactly 1 (planner halts when 0 suggestions). | **5** (the projector ran the FULL semesterCount=5; never halted). | ❌ MISMATCH |
| `result.notes` contains "halted" / "2026-fall" | yes. | only `["Assumed grade for projected courses..."]`. | ❌ MISMATCH |

### ❌ Mismatch root cause: planner never returns 0 suggestions for a "completed" student

The diagnostic dump shows that even after every CS BA major rule is satisfied — `cs_ba_intro`, `cs_ba_core`, `cs_ba_electives` (8 distinct 400-level CSCI plus 2 math substitutions, vs. n=5 required), `cs_ba_math_calculus`, `cs_ba_math_discrete` — and the student is at 124+ NYU credits, the planner still suggests:

```
2026-fall: CSCI-UA 110 ("unlocks 18 future course(s); critical path course"),
           MATH-UA 235, EXPOS-UA 4, ...  (4 suggestions)
2027-spring: CSCI-UA 453, 467, 469 ("available elective")
2027-fall:   CSCI-UA 475, 478, 479 ("available elective")
2028-spring: CSCI-UA 476, MATH-UA 123, MATH-UA 234 ("available elective")
2028-fall:   DS-UA 301, FYRS-UA 500, CORE-UA 600 ("available elective")
```

The student finishes at `cumulativeCreditsAtEnd: 204` after 5 projected semesters (4 sem × 16 cr = 64 cr added on top of 140 baseline). All beyond `totalCreditsRequired: 128`.

**Bulletin tension:** Per CS BA bulletin (`programs/computer-science-ba/_index.md`), 128 credits is the cap; the bulletin says nothing about projecting 5 semesters of post-graduation electives. The bulletin doesn't *forbid* this either, but `MultiSemesterResult.notes` was spec'd to surface a halt-with-note when the student has run out of useful suggestions (multiSemesterProjector.ts:99-107). This branch is essentially dead code unless `planNextSemester` itself returns no candidates — which doesn't happen as long as the engine has *any* additional course in `courses.json` whose prerequisites are met.

**Suggested fix:**

In `planNextSemester`, gate `category: "elective"` suggestions behind `audit.totalCreditsCompleted < program.totalCreditsRequired`. Once the student has reached the program total AND every program rule is satisfied, return zero suggestions so the projector can halt. Alternatively, expose a `MultiSemesterRequest.haltOnDegreeComplete?: boolean` opt-in.

**Suggested follow-up assertion** (to verify the fix lands):
```ts
expect(r.semesters.length).toBe(1);
expect(r.notes.some(n => /halted/i.test(n))).toBe(true);
```

The two failing assertions in this profile are both consequences of the same root cause.

### Notable secondary observation: planner suggests CSCI-UA 110 as "critical path"

The very first iteration's top suggestion is `CSCI-UA 110` ("unlocks 18 future course(s); critical path course"). But the student already took CSCI-UA 101 (cs_ba_intro is `choose_n n=1` from `["CSCI-UA 101","CSCI-UA 110"]`), so 101 already satisfies that rule. CSCI-UA 110 isn't "critical path" — taking it now adds zero rule-satisfaction value beyond elective credit. The "unlocks 18 future course(s)" reason looks like the prereq-graph was computed against an empty completed set OR ignored equivalence. Likely a `priorityScorer` quirk — out of wave-3's scope to assert against.

---

## Profile 3 — Exploratory mode: undeclared CAS student

| Engine call | Bulletin/prediction | Engine output | Verdict |
|---|---|---|---|
| `planExploratory` is NOT `{ kind: "unsupported" }` | true. | true. | ✅ MATCH |
| `result.auditedProgramId` | `"cas_core"`. | `"cas_core"`. | ✅ MATCH |
| `result.basis` mentions CAS Core | yes. | yes. | ✅ MATCH |
| `result.plan.suggestions.length > 0` | true. | yes. | ✅ MATCH |
| every suggestion's reason starts with `[exploratory` | true. | true. | ✅ MATCH |
| notes mention "exploratory / undeclared" | yes. | yes. | ✅ MATCH |

**6/6 PASS for Profile 3.** The exploratory planner correctly:
- Recognises 0 declared programs as the trigger condition.
- Resolves `cas.json sharedPrograms[0]` to `cas_core`.
- Re-tags every suggestion with the `[exploratory mode — toward CAS Core Curriculum]` prefix so the chat layer can render contextually.

The engine routes a 0-courses CAS first-year exactly the way the bulletin's first-year guidance reads (CAS Core L43-47: "complete Core courses by the end of sophomore year"; L46: "Students must complete EXPOS-UA 1 ... during their first year"; L294: FYSEM required of all entering students).

---

## Profile 4 — Transfer-prep eligible CAS junior

| Engine call | Bulletin/prediction | Engine output | Verdict |
|---|---|---|---|
| `planForTransferPrep` not unsupported | true. | true. | ✅ MATCH |
| `transferDecision.status === "eligible"` | yes (5/5 prereqs met). | yes. | ✅ MATCH |
| `transferDecision.entryYear === "junior"` | yes. | yes. | ✅ MATCH |
| `transferDecision.missingPrereqs.length === 0` | yes. | yes. | ✅ MATCH |
| `deadlineWarnings` includes "March 1" | yes. | yes. | ✅ MATCH |
| `deadlineWarnings` includes "fall" | yes. | yes. | ✅ MATCH |
| no plan suggestion's reason starts with `[transfer-prereq` | true (none missing → none promoted). | true. | ✅ MATCH |
| `plan.enrollmentWarnings` includes "March 1" | true. | true. | ✅ MATCH |

**8/8 PASS for Profile 4.** The transfer-prep planner happy-path is wired correctly:
- It calls `checkTransferEligibility` and respects the 5-prereq satisfaction.
- The deadline string from `cas_to_stern.json` (`"March 1"`) and `acceptedTerms: ["fall"]` both surface in `deadlineWarnings`.
- The engine correctly elects NOT to add `[transfer-prereq` prefixes when nothing is missing — this matches the `transferPrepPlanner.ts:108-117` semantics (the prefix loop is gated on `promotedIds`, which is empty when there are no missing prereqs).
- `plan.enrollmentWarnings` are correctly merged with the deadline warnings (transferPrepPlanner.ts:127).

This is the strongest "engine matches bulletin" profile in wave 3.

---

## Profile 5 — Cross-program priority: shared course +30 boost

| Engine call | Bulletin/prediction | Engine output | Verdict |
|---|---|---|---|
| `planMultiProgram.perProgram.length === 2` | yes. | yes. | ✅ MATCH |
| `result.merged.length > 0` | yes. | yes. | ✅ MATCH |
| `result.merged[0].courseId === "MATH-UA 121"` | yes. | yes. | ✅ MATCH |
| `result.merged[0].reason` starts with `[shared across 2 programs:` | yes. | yes. | ✅ MATCH |
| `result.merged[0].satisfiesRules` includes `cs_ba_math_calculus` AND `core_fsi_quant` | yes. | yes. | ✅ MATCH |
| no `exceeds_pair_limit` warnings | yes (only 1 shared candidate). | yes. | ✅ MATCH |
| notes mention "shared" | yes. | yes. | ✅ MATCH |

**7/7 PASS for Profile 5.** Cross-program priority works exactly as the docstring (`crossProgramPlanner.ts:46-49 SHARED_COURSE_BOOST = 30`) describes:
- `MATH-UA 121` is a candidate in both per-program plans (it satisfies `cs_ba_math_calculus` in cs_major_ba AND `core_fsi_quant` in cas_core).
- The merge step adds +30 to its priority, prefixes its reason with `[shared across 2 programs: cs_major_ba, cas_core]`, and re-sorts.
- It lands at `merged[0]`, ranked above the per-program-only suggestions.

This validates the "multi-program planner test … cross-program priority scoring" deliverable from Phase 3 §12.6.

---

## Profile 6 — Transcript confirmation flow on the real transcript

| Engine call | Bulletin/prediction | Engine output | Verdict |
|---|---|---|---|
| `parseTranscript(...).terms.length` | 4. | 4. | ✅ MATCH |
| `parseTranscript(...).overall.printedGpa` | 3.500. | 3.500. | ✅ MATCH |
| `transcriptToProfileDraft.draft.homeSchool` | `"cas"`. | `"cas"`. | ✅ MATCH |
| `summary.homeSchool` | `"cas"`. | `"cas"`. | ✅ MATCH |
| `summary.cumulativeGPA` | 3.5. | 3.5. | ✅ MATCH |
| `summary.attemptedCredits` | **48** (12 letter-graded × 4 + 0 from 0-cr P-row). | **52** (engine reconstructs the 0-cr P-row to 4). | ❌ MISMATCH |
| `summary.examCreditsApplied` | 32. | 32. | ✅ MATCH |
| `summary.inProgressCount` | 4. | 4. | ✅ MATCH |
| `summary.declaredProgramsCount` | 0. | 0. | ✅ MATCH |
| `fieldsRequiringExplicitConfirmation` includes `"declaredPrograms"` | yes. | yes. | ✅ MATCH |
| `homeSchoolBasis` starts with `"homeSchool:"` | yes. | yes. | ✅ MATCH |
| `inProgressCourses` lists the 4 expected ids | yes. | yes. | ✅ MATCH |
| `inferenceNotes` contain "transition" | yes. | yes. | ✅ MATCH |

**12/13 PASS for Profile 6.** Plus several diagnostic-dump observations below.

### ❌ Mismatch root cause: profileMapper synthesizes 4 credits for any 0-EHRS row

The PDF (`packages/engine/tests/eval/real_transcripts/sample_01.pdf`) explicitly prints:

```
IMA Cohort: Community is a Practice    IMNY-UT 99-1   0.0 P
```

i.e. EHRS `0.0`, grade `P`, course `IMNY-UT 99`. This is a 0-credit cohort marker — the bulletin does not award it any graduation credit (and Wave 1's fixture took the same view, hard-coding `credits: 0` for that row).

But the engine's `profileMapper.ts:66` says:

```ts
const credits = c.ehrs > 0 ? c.ehrs : (c.qhrs > 0 ? c.qhrs : 4);
```

When both EHRS and QHRS are zero, the mapper *invents* `credits: 4`. The diagnostic dump confirms:

```
{ "courseId": "IMNY-UT 99", "grade": "P", "semester": "2023-fall", "credits": 4 }
```

This 4 then flows into `buildConfirmationSummary`'s `attemptedCredits` accumulator (`confirmationFlow.ts:73`), inflating it from the bulletin-true 48 to the engine-reported 52.

**Bulletin / type tension:**
- The PDF is the source of truth and prints `0.0`. The mapper's "fall back to 4" heuristic was designed for W/I/NR rows (where the transcript intentionally hides EHRS but the course was still 4 credits). It's wrong for genuine 0-credit cohort rows, of which `IMNY-UT 99` is the canonical NYU example.
- `CourseTaken.credits` (types.ts:397+) doesn't have an "unknown" sentinel; the field is required, so the mapper has to pick *some* value. But picking 4 misrepresents zero-credit administrative rows.

**Suggested fix:**
1. Treat `grade === "P"` AND `ehrs === 0` AND `qhrs === 0` as a 0-credit row (no fallback). Bulletin justification: a `P` with 0 hours is a cohort/lab marker, not a 4-credit course.
2. Alternatively, skip 0-credit P-rows entirely from `coursesTaken` (similar to how `***` rows are skipped). They have no meaning for downstream audits.

**Concrete failing scenario already hits in production:** a CAS-bound IMA student with `IMNY-UT 99` in their transcript will be told they've attempted 4 more credits than they actually have, which then propagates into:
- `summary.completedCredits` (also 52 instead of 48 — visible in dump).
- `summary.attemptedCredits` (52 instead of 48).
- Any downstream credit-cap or residency check that counts attempted credits.

### 🟡 `schoolTransition` detected at the WRONG semester (Spring 2024)

The diagnostic dump shows:

```
"Detected home-school transition at 2024-spring: -UA,-UT → -UT,-UA."
```

This is **wrong**. The PDF clearly shows the home-school flips from Tisch (Fall 2023, Spring 2024) to CAS (Fall 2024 onward). The actual transition is at **Fall 2024**, not Spring 2024.

What happened: Fall 2023 has 2× -UT (IMNY) + 1× -UA (EXPOS) + 2× -UT (IMNY) = `[-UT, -UA]` set. Spring 2024 has 1× -UT (ASPP) + 3× -UA (CSCI/MATH/SPAN) = `[-UT, -UA]` set but the dominant order flipped. The engine's `detectSchoolTransition` (parser.ts) appears to compare unordered set membership rather than dominance, so it falsely flags Spring 2024 as the transition because the `-UT` and `-UA` ordering changed in its internal collection.

This propagates downstream:
- `summary.earlierProgram` is `"-UA,-UT"` (the regex extracted the first `-UA,-UT` token from the bogus note), not the real "previous school" answer.
- A user reading the chat layer's confirmation summary would see "earlier program: -UA,-UT" — meaningless.

**Bulletin tension:** `TranscriptDocument.schoolTransition` (types.ts:67-68) is documented as "Term in which the home school changed (G40), if detected." A change in alphabetical ordering of the suffix set is NOT a home-school change. The bulletin (CAS academic-policies §G40 internal transfers) speaks of one home school flipping to another — a domain-meaningful event. The engine's heuristic admits any suffix-set churn.

**Suggested fix:** the transition detector should track the *dominant* suffix per term (the one with the largest count), and emit a transition only when the dominant suffix differs between consecutive terms. That gives Fall 2023 (dom -UT, 4 of 5 rows are -UT) → Spring 2024 (dom -UA, 3 of 4 rows are -UA) — wait, that's also a transition, but the more visible one is Spring 2024 → Fall 2024 (still -UA dominant, but program metadata changes from Tisch BFA to CAS BA). Without tracking program metadata (which the parser doesn't), the dominant-suffix approach surfaces Fall 2023 → Spring 2024 as the transition. The truly bulletin-faithful answer requires reading the printed program lines ("Tisch School of the Arts / Bachelor of Fine Arts" vs "College of Arts and Science / Bachelor of Arts") — not just the course suffixes. **Wave 2 already detected -UT → -UA on a synthetic transcript and reported MATCH because the synthetic flipped exactly once and the order matched.** The real transcript is messier.

Wave 2's report mentioned this would be brittle for the real transcript; wave 3 confirms.

### 🟡 `homeSchoolBasis` says "inferred from -UA dominance in 2025-spring" but Spring 2025 is in-progress (no graded credits)

`homeSchoolBasis: "homeSchool: cas (inferred from -UA dominance in 2025-spring)."` — the inference walked back from the most-recent term (Spring 2025) where every row is `***`. The dominance is real (`CORE-UA 500`, `CSCI-UA 310`, `MATH-UA 233`, `MATH-UA 325` are all -UA), but the message implicitly suggests the inference looked at completed credit. That's a wording-precision concern, not a correctness bug. profileMapper.ts:139-167 does include `***` rows in the suffix-count walk (it iterates `term.courses` without filtering on grade). The right answer (cas) was reached.

---

## Summary

- **39 of 42 wave-3 assertions PASS.**
- **3 hard MISMATCHes**, all from the same 2 underlying engine quirks:
    1. `multiSemesterProjector` does not halt at degree completion — `planNextSemester` keeps surfacing "available elective" suggestions for any unlocked course in the catalog (Profile 2: 2 failed assertions).
    2. `profileMapper` synthesizes 4 credits for genuine 0-credit P-graded rows like `IMNY-UT 99` (Profile 6: 1 failed assertion).
- **Latent issues exposed by the diagnostic dump (not assertion failures):**
    1. 🟡 `schoolTransition` mis-detection on the real transcript (Profile 6 dump).
    2. 🟡 Planner suggests `CSCI-UA 110` as "critical path" when `CSCI-UA 101` already satisfies the same `choose_n n=1` rule (Profile 2 dump).
    3. 🟡 `summary.earlierProgram` extracts garbage (`"-UA,-UT"`) because the upstream transition note is malformed (Profile 6 dump).

---

## Mismatches that suggest engine bugs

### 1. ❌ `multiSemesterProjector` projects post-graduation semesters indefinitely

- **Files:** `packages/engine/src/planner/multiSemesterProjector.ts:99-107` (the halt branch); `packages/engine/src/planner/semesterPlanner.ts:39+` (the per-semester planner that supplies the suggestions); `packages/engine/src/planner/balancedSelector.ts` (likely site of the "available elective" filler logic).
- **Bulletin (CS BA `programs.json:8` + bulletin):** total credits required = 128. Once the student is at 128+ AND every rule is satisfied, no further courses are needed for the degree.
- **Engine:** Profile 2's student is at 124 NYU credits with every CS BA rule satisfied. The projector still runs 5 more semesters projecting up to 204 cumulative credits, suggesting bare elective filler ("available elective") on each iteration. The halt-branch (`if (plan.suggestions.length === 0) ... break`) is unreachable as long as the catalog has any unlocked course.
- **Bulletin-derived expected behavior:** the projector should halt at the degree-complete iteration with the documented note: `"Projection halted at <semester>: planner returned zero suggestions. Either all degree requirements are satisfied or no unlocked courses remain."`
- **Suggested fix:** in `planNextSemester`, gate `category: "elective"` filler suggestions behind `audit.totalCreditsCompleted < program.totalCreditsRequired || audit.overallStatus !== "satisfied"`. Alternatively, expose `MultiSemesterRequest.haltOnDegreeComplete?: boolean = true` and stop folding electives when it's set.

### 2. ❌ `profileMapper` invents 4 credits for 0-credit P-graded cohort rows

- **File:** `packages/engine/src/transcript/profileMapper.ts:66`
- **Bulletin / transcript ground-truth:** the real transcript prints `IMNY-UT 99-1   0.0 P` for the IMA Cohort row. NYU awards no degree credit for that row. Wave 1 hand-coded `credits: 0` for the same course.
- **Engine:** the mapper falls back to `4` whenever `ehrs <= 0 && qhrs <= 0`, regardless of grade. So the IMA Cohort row gets 4 credits in the draft — and `summary.attemptedCredits` becomes 52 instead of the bulletin-correct 48.
- **Concrete consequence:** any CAS Core / Tisch IMA student with `IMNY-UT 99` (or any other 0-credit cohort marker) will see inflated credit totals at every confirmation step, and downstream audits (`creditCapValidator`, `degreeAudit.totalCreditsCompleted`) will likewise read high.
- **Suggested fix:** change the conditional to:
  ```ts
  let credits: number;
  if (c.ehrs > 0) credits = c.ehrs;
  else if (c.qhrs > 0) credits = c.qhrs;
  else if (c.grade === "P" || c.grade === "TR") credits = 0;  // honour 0-cr admin rows
  else credits = 4;  // W/I/NR fallback
  ```
  Or skip 0-credit P rows entirely from `coursesTaken` (they're administrative).

### 3. 🟡 `schoolTransition` detector mis-identifies the transition on the real transcript

- **File:** `packages/engine/src/transcript/parser.ts` (the `detectSchoolTransition` helper, called at L171).
- **Real transcript ground-truth:** transition from Tisch (Fall 2023, Spring 2024) to CAS (Fall 2024, Spring 2025). Bulletin-meaningful event happens **at Fall 2024**.
- **Engine:** reports `"Detected home-school transition at 2024-spring: -UA,-UT → -UT,-UA."` — the `-UA,-UT` set is identical between Fall 2023 and Spring 2024; only the *ordering* in the engine's internal record changed.
- **Downstream effect:** `confirmationFlow.ts:85-87` extracts `earlierProgram = "-UA,-UT"` from this malformed note. The chat layer would surface "earlier program: -UA,-UT" — semantically meaningless to a user.
- **Suggested fix:**
  1. Use *dominant* suffix per term (highest count), not the unordered set, when comparing consecutive terms.
  2. Better still, parse the printed program metadata lines (`"Tisch School of the Arts / Bachelor of Fine Arts / Major: Interactive Media Arts"` vs `"College of Arts and Science / Bachelor of Arts / Major: Computer Science/Math"`) and emit the transition where the school *line* changes, not where the suffix set rotates.

---

## Non-bug observations — Phase 3 design choices that surprised but I can't prove are wrong

1. **`planExploratory` re-tags every suggestion's reason** with `[exploratory mode — toward CAS Core Curriculum]`, even suggestions that are already self-explanatory (e.g., `"unlocks 18 future courses"`). The doubled prefix could be noisy in chat output but isn't bulletin-disallowed; it's a UX call.
2. **`crossProgramPlanner` uses `+30` for the shared-course boost and `-40` for the over-limit penalty** (`crossProgramPlanner.ts:49,54`). These magnitudes aren't in the bulletin; they're engine heuristics. The relative ordering is what wave 3 verified — not the magnitudes. A future change that tunes them would be invisible to bulletin-based fixtures.
3. **`transferPrepPlanner` boosts missing-prereq suggestions by `+50` priority** (`transferPrepPlanner.ts:123`) — chosen to dominate elective-only suggestions. Same caveat as (2): the magnitude is out of scope for bulletin checks.
4. **`projectMultiSemester` advances Fall→Spring→Fall only**, skipping summer/January (multiSemesterProjector.ts:138-150). The CAS bulletin documents summer/January terms; some students take courses in them. Engine's choice to ignore them is a Phase-3 simplification noted in the doc comment, not a bug.
5. **`ProfileDraft.notes` includes the synthesized homeSchool note even when the inferred school comes from `***` in-progress rows** (Profile 6: "inferred from -UA dominance in 2025-spring" where Spring 2025 is in-progress). The fact that the inference works for the real transcript (it correctly returns "cas") suggests the engine intentionally walks `***` rows for suffix counting. Bulletin doesn't dictate behavior here.

---

## Files produced (wave 3)

- `packages/engine/tests/eval/independent/wave3_fixtures.md` — bulletin-derived profiles + predictions.
- `packages/engine/tests/eval/independent/wave3.test.ts` — vitest harness with 42 assertions verbatim from the predictions table.
- `packages/engine/tests/eval/independent/_dump_wave3.test.ts` — diagnostic harness dumping engine output for inspection (always passes).
- `packages/engine/tests/eval/independent/wave3_run_report.md` — this file.

---

## Top concerns ranked by impact

1. **`multiSemesterProjector` never halts at degree completion** (Profile 2). Highest impact: a student running `projectMultiSemester` to ask "how many semesters until I graduate?" gets a nonsense answer if they're past 128 credits or close to it — the engine projects pure elective filler indefinitely (up to `semesterCount`). The halt-with-note branch is dead code in practice. CS BA bulletin: 128 cr is the cap.
2. **`profileMapper` invents 4 credits for 0-credit P rows** (Profile 6). Real-world Tisch-IMA → CAS transfer students all carry `IMNY-UT 99` rows; their attempted-credits totals will be wrong by 4 per such row. Real PDF extraction confirms the engine misreads the canonical 0-credit cohort marker.
3. **`schoolTransition` detector mis-identifies the transition on the real transcript** (Profile 6 diagnostic). The detector confuses ordering of a suffix set with a genuine school change. The right answer requires reading printed program-metadata lines, not just course suffixes. Wave 2 found this could work on a clean synthetic transcript; wave 3 shows it breaks on a real one.

All three concerns are concrete file:line citations with bulletin or transcript counter-evidence; each has a suggested fix in the section above.
