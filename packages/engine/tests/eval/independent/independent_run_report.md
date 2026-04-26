# Independent Run Report — Engine vs. Bulletin

Run command:

```
npx vitest run packages/engine/tests/eval/independent/independent.test.ts
npx vitest run packages/engine/tests/eval/independent/_dump.test.ts   # captures full engine output for inspection
```

Engine version: working tree at `c0fce4e` (working tree dirty; tests added under `packages/engine/tests/eval/independent/`).
Bulletin source: `data/bulletin-raw/...` snapshot scraped 2026-04-21.

The harness contains 21 bulletin-derived assertions across 6 profiles plus a smoke test for `crossProgramAudit`. Of those, **20 passed** and **1 failed** at the assertion level. Several additional concerning behaviors surfaced from the diagnostic dump (`_dump.test.ts`) but are NOT failing assertions because either (a) the bulletin is silent on the precise output, or (b) the bulletin-prediction was matched at a coarse-grained level even though the engine produced a confusing detail.

Legend: ✅ MATCH, ❌ MISMATCH (engine contradicts bulletin), ⚠️ AMBIGUOUS (bulletin silent or imprecise), 🟡 NEAR-MATCH (passes assertion, but engine output has an unexpected detail).

---

## Profile 1 — Real transcript student (CAS Math/CS BA)

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `degreeAudit` overallStatus | `in_progress` | `in_progress` | ✅ MATCH |
| `degreeAudit` `cs_ba_intro.status` | satisfied via AP CS A → CSCI-UA 101 | `satisfied`, `coursesSatisfying=["CSCI-UA 101"]` | ✅ MATCH |
| `degreeAudit` `cs_ba_intro.coursesRemaining` | `[]` (rule satisfied) | `["CSCI-UA 110"]` | 🟡 ENGINE-QUIRK: When a `choose_n` rule is satisfied, `coursesRemaining` is being populated with the unchosen alternative. This contradicts the field comment in `types.ts:447`: "Remaining courses needed (for must_take)". |
| `degreeAudit` `cs_ba_core.status` | in_progress, missing CSCI-UA 310 | `in_progress`, `coursesRemaining=["CSCI-UA 310"]` | ✅ MATCH |
| `degreeAudit` `cs_ba_math_calculus.status` | satisfied via AP MATH-UA 121 | `satisfied`, `coursesSatisfying=["MATH-UA 121"]` | ✅ MATCH |
| `degreeAudit` `cs_ba_electives.coursesSatisfying` | bulletin-undetermined; CS BA L164-168 says students "may replace a 400-level elective with one of MATH-UA 122/140/185 (max 2)" — but those must be courses *taken*; AP transfer credit's eligibility is not addressed | engine credits MATH-UA 122 (AP transfer) and MATH-UA 140 (graded A-) | ⚠️ AMBIGUOUS — bulletin doesn't say AP-transfer MATH-UA 122 can substitute. The plain-English reading "students may replace" suggests an actual class taken, not an AP score. Engine treats AP equivalents as fully equivalent. Worth a human review. |
| `checkTransferEligibility(stern)` overall status | not_yet_eligible (missing micro/stats/fin-acct/writing-might-be-saved-by-EXPOS-UA-5) | `not_yet_eligible`, `entryYear=junior`, `missingPrereqs=[writing_composition, statistics, financial_accounting, microeconomics]` | 🟡 STATUS MATCH — but writing prereq result diverges from bulletin (next row). |
| Stern prereq `writing_composition` | satisfied — EXPOS-UA 5 ("Writing the Essay: Art in the World") plainly counts as "1 semester of writing/composition" per Stern admissions bulletin L107/L128 (no course-id restriction in bulletin) | `satisfied=false`, candidates only `["EXPOS-UA 1","EXPOS-UA 4","EXPOS-UA 9"]` | ❌ MISMATCH (engine bug). Engine encodes a closed set in `data/transfers/cas_to_stern.json:84` that excludes EXPOS-UA 5. The cas_to_stern.json file even acknowledges this on line 60-62 as a "heuristic." Bulletin says "1 semester of writing/composition" — no specific course list. |
| Stern prereq `calculus` | satisfied (AP MATH-UA 121) | `satisfied=true`, `courseTaken=MATH-UA 123` | ✅ MATCH (engine picked a different calculus course, MATH-UA 123, but the bulletin only requires "calculus or higher" — both 121 and 123 qualify). |
| `decideSpsEnrollment("CSCI-UA 102")` | `not_an_sps_course` → allowed | `enrollment=allowed`, `reason=not_an_sps_course` | ✅ MATCH |
| `decideSpsEnrollment("REBS1-UC 1234")` | allowed (CAS allowlist) | allowed | ✅ MATCH |
| `calculateStanding` `cumulativeGPA` | ≈ 3.50 (transcript shows 3.500) | 3.5 | ✅ MATCH |
| `calculateStanding` `level` | good_standing | good_standing | ✅ MATCH |

---

## Profile 2 — CAS sophomore mid-CS-major, no AP

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `degreeAudit` overallStatus | in_progress | in_progress | ✅ MATCH |
| `cs_ba_intro` | satisfied | satisfied | ✅ MATCH |
| `cs_ba_math_calculus` | satisfied | satisfied | ✅ MATCH |
| `cs_ba_math_discrete` | satisfied | satisfied | ✅ MATCH |
| `cs_ba_core` | in_progress, remaining = [202, 310] | in_progress, remaining = [202, 310] | ✅ MATCH |
| `checkTransferEligibility(stern)` | sophomore-eligible | `eligible`, sophomore | ✅ MATCH |
| `calculateStanding` `cumulativeGPA` | ≈ 3.50 | 3.5 | ✅ MATCH |

---

## Profile 3 — CAS junior nearly Stern-eligible

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `checkTransferEligibility(stern)` | eligible, junior, no missing prereqs | `eligible`, junior, missingPrereqs=[] | ✅ MATCH |
| All five junior prereqs satisfied | yes (calc, writing, stats, fin-acct, micro) | all five `satisfied=true` | ✅ MATCH |
| `calculateStanding` GPA | ≥ 3.5 | 3.646 | ✅ MATCH |

---

## Profile 4 — CAS student missing exactly microeconomics

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `checkTransferEligibility(stern)` | not_yet_eligible, missingPrereqs.length=1, category=microeconomics | `not_yet_eligible`, `missingPrereqs=[{category:"microeconomics"}]` (length 1) | ✅ MATCH |
| ECON-UA 1 (macro) does NOT satisfy micro | yes (bulletin says "1 semester of microeconomics" specifically) | `satisfied=false`, candidates=[ECON-UA 2/10/11]; ECON-UA 1 not in candidates | ✅ MATCH |

---

## Profile 5 — Student exceeding CAS's 32-credit P/F career cap

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `degreeAudit.warnings` includes a P/F-cap message | yes (CAS bulletin L410: "not more than 32 credits during their college career") | `"Pass/Fail credit limit exceeded: 36/32 credits. Maximum 32 P/F credits allowed across entire career."` | ✅ MATCH |
| `calculateStanding` `level` | good_standing (P excluded from GPA) | good_standing, GPA 3.445 | ✅ MATCH |
| `checkTransferEligibility(stern)` | bulletin doesn't make a strong prediction here — student has all 60 credits letter-completed (CSCI 101, MATH 121, CSCI 102, MATH 120, CSCI 201, CSCI 202 letter-graded, plus 9 P-graded) and EXPOS-UA 1 is P, so the writing prereq is satisfied by a P-graded course. Bulletin (Stern admissions L107) does NOT say P is acceptable for prereq courses; in practice many advisers reject P for prereqs. | engine returns `eligible, sophomore`; writing satisfied via EXPOS-UA 1 (which has `gradeMode:"pf"` in this student's profile) | ⚠️ AMBIGUOUS / SUSPICIOUS — engine accepts a P-graded EXPOS-UA 1 as satisfying the Stern writing prereq. Stern admissions does not endorse P/F for prereqs (CAS bulletin L138 also says "No course to be counted toward the major or minor may be taken on a Pass/Fail basis"). It would be more cautious to require a letter grade for transfer prereqs. Bulletin is not 100% explicit, so flagged AMBIGUOUS. |

---

## Profile 6 — Student with W and I grades

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `cs_ba_math_discrete.status` | NOT satisfied (MATH-UA 120 = I, incomplete) | `not_started`, coursesRemaining=["MATH-UA 120"] | ✅ MATCH |
| `calculateStanding.cumulativeGPA` | ≈ 3.185 (W, I excluded from GPA per CAS bulletin L388-394, L400-406) | 3.185 | ✅ MATCH |
| `calculateStanding.completionRate` | bulletin-derived target ≈ 0.75 if W counted attempted, ~0.90 otherwise | 0.75 | 🟡 NEAR-MATCH — engine treats W as attempted-not-earned, same as I. The CAS bulletin is silent on whether W counts toward "attempted" for completion-rate. CAS bulletin L394 explicitly says NR is "credits attempted." For W, L390 says "indicates an official withdrawal of the student from a course in good academic standing" — sounds like a clean exit. The engine choice (W = attempted) is defensible but not bulletin-derived. |
| `calculateStanding.level` | good_standing (≥ 75% completion, GPA ≥ 2.0) | good_standing | ✅ MATCH |

---

## crossProgramAudit smoke test

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| Single-program crossProgramAudit | one entry, no warnings, no shared courses | `programs.length=1, warnings=[], sharedCourses=[]` | ✅ MATCH |

---

## Summary

- 21 assertions in `independent.test.ts`: **20 pass, 1 fail**.
- Cross-checking the diagnostic dump (`_dump.test.ts`) against `independent_fixtures.md` predictions:
  - **MATCH**: ~22 individual prediction-points
  - **MISMATCH (engine contradicts bulletin)**: 1 (writing prereq false-negative for EXPOS-UA 5)
  - **ENGINE-QUIRK / NEAR-MATCH**: 2 (`coursesRemaining` populated on satisfied `choose_n` rules; W treated as attempted without bulletin authority)
  - **AMBIGUOUS**: 2 (AP MATH-UA 122 substituting for CS elective; P-graded prereq accepted by Stern transfer check)

---

## Mismatches that suggest engine bugs

### 1. ❌ EXPOS-UA 5 incorrectly fails the Stern writing/composition prereq
- **Engine:** `data/transfers/cas_to_stern.json:84` — `"satisfiedBy": ["EXPOS-UA 1", "EXPOS-UA 4", "EXPOS-UA 9"]`. EXPOS-UA 5 ("Writing the Essay: Art in the World") is not in the list.
- **Bulletin:** `data/bulletin-raw/undergraduate/business/admissions/_index.md:107` and L128 say only "1 semester of writing/composition (two semesters are preferred)". No course list, no restriction. EXPOS-UA 5 is plainly a writing/composition course (the title literally starts with "Writing the Essay").
- **Impact:** Real-world student in Profile 1 (the actual transcript) is told they're missing writing/composition for the Stern transfer, when in fact their EXPOS-UA 5 grade of B+ should satisfy it.
- **The data file even self-flags this** at lines 58-62: `"satisfiedBy[] arrays here are HEURISTIC equivalencies derived from common CAS course catalog. The bulletin's Course Equivalencies page is the authoritative mapping; verify before relying on these for production advising."` — but the engine still reports it as ❌ MISSING rather than ⚠️ UNCERTAIN.
- **Suggested fix:** broaden satisfiedBy to all `EXPOS-UA *` courses, OR distinguish "definitively missing" vs "uncertain — needs equivalency check."

### 2. 🟡 `choose_n` rules expose `coursesRemaining` even when satisfied
- **Engine output (Profile 1):** `cs_ba_intro` rule has `status: "satisfied"`, `remaining: 0`, **but** `coursesRemaining: ["CSCI-UA 110"]`.
- **Type contract** (`packages/shared/src/types.ts:447-449`): `coursesRemaining: string[]` documented as "Specific courses still needed (for must_take rules)". On a satisfied choose_n rule, it should be `[]`.
- **Impact:** Downstream consumers reading `coursesRemaining` directly may report "still need CSCI-UA 110" to a student who has fully satisfied the intro requirement via CSCI-UA 101.
- **Suggested fix:** in `ruleEvaluator.ts` (intentionally not read here) make sure `coursesRemaining` is set to `[]` when `status === "satisfied"`.

### 3. ⚠️ P-graded EXPOS-UA 1 satisfies Stern transfer writing prereq (Profile 5)
- **Engine output (Profile 5):** Even though Profile 5's EXPOS-UA 1 is recorded with `grade: "P"` and `gradeMode: "pf"`, the engine's `checkTransferEligibility` reports `writing_composition.satisfied=true, courseTaken="EXPOS-UA 1"`.
- **Bulletin tension:** CAS bulletin L138 — "No course to be counted toward the major or minor may be taken on a Pass/Fail basis." Stern admissions doesn't explicitly state P-grade rejection for prereq courses, but treating a P as equivalent to an evaluated letter grade for transfer prereq purposes is inconsistent with normal NYU practice (admissions review wants to see graded prereq performance).
- **Suggested fix:** in `checkTransferEligibility`, only count a `CourseTaken` toward a prereq when its `gradeMode !== "pf"` OR when the bulletin explicitly allows P (none of Stern's prereq subjects do).

### Honourable mentions (not in the top 3)

- **MATH-UA 122 from AP applied as CS BA elective substitute (Profile 1).** The bulletin language "students may replace a 400-level elective with [MATH-UA 122 / 140 / 185]" reads as a chosen course substitution, not an AP-credit-derived one. Worth a human review to decide whether AP transfer credits should ever count as "elective substitutes" since the bulletin's intent is degree-elective enrichment.
- **Stern transfer `entryYear` auto-selection.** The engine picks the lowest-tier entry-year whose prereqs are met (sophomore for a 60-credit student in Profile 5). Bulletin language reads as student-choice ("Students wishing to transfer into the second/sophomore year should have completed..."); the engine collapses that decision. Not strictly a bug, but reporters using the engine should know that `entryYear` reflects "best year given current prereqs" rather than "student's stated target."

---

## What worked well (engine matches bulletin)

- Grade-point map (CAS bulletin L350-362) is implemented exactly. Profile 1 reproduces transcript GPA 3.500 and Profile 6 reproduces our hand-derived 3.185.
- W and I grades correctly excluded from GPA (CAS bulletin L390, L400-406).
- 32-credit P/F career cap warning is emitted when `passfailCredits > 32` (Profile 5).
- ECON-UA 1 (macro) correctly distinguished from ECON-UA 2/10/11 (micro) for the Stern prereq check (Profile 4).
- CAS academic concern threshold (50% completion → dismissal review after 2 semesters) and 75% return-to-good-standing threshold are reflected in `goodStandingReturnThreshold` and `dismissalThreshold` constants (CAS bulletin L468 / L494).

---

## Files produced

- `packages/engine/tests/eval/independent/independent_fixtures.md` — bulletin-derived profiles + predictions.
- `packages/engine/tests/eval/independent/independent.test.ts` — vitest harness with assertions copied from the predictions table.
- `packages/engine/tests/eval/independent/_dump.test.ts` — diagnostic harness dumping the full engine output for each profile (always passes; used to compare against the predictions table).
- `packages/engine/tests/eval/independent/independent_run_report.md` — this file.
