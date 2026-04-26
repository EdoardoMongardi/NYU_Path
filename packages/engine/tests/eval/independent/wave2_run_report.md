# Wave 2 Run Report — Engine vs. Bulletin (Independent, Bulletin-only)

Run command:

```
npx vitest run packages/engine/tests/eval/independent/wave2.test.ts
npx vitest run packages/engine/tests/eval/independent/_dump_wave2.test.ts   # diagnostic
```

Engine version: working tree at `main` after wave-1 fixes have landed (EXPOS-UA 5 added to Stern writing satisfiedBy; choose_n/min_credits/min_level no longer leak coursesRemaining when satisfied; checkTransferEligibility rejects P-graded prereqs).

Bulletin source: `data/bulletin-raw/...` snapshot scraped 2026-04-21.

Wave 2 contains **31 bulletin-derived assertions across 6 profiles**.

Legend: ✅ MATCH, ❌ MISMATCH (engine contradicts bulletin), ⚠️ AMBIGUOUS / NOT-MODELED, 🟡 NEAR-MATCH (passes assertion but diagnostic dump exposes an unexpected detail).

---

## Profile 1 — CAS Core foreign-language exemption (nonEnglishSecondary)

| Engine call | Bulletin prediction | Engine output (from diagnostic dump) | Verdict |
|---|---|---|---|
| `degreeAudit(student, cas_core, ...).rules[core_foreign_lang].status` | `"satisfied"` via flag exemption (CAS Core L71). | `"satisfied"` | ✅ MATCH |
| same `.exemptReason` | non-empty string explaining the exemption (types.ts:450). | `"Exempt from foreign language requirement"` | ✅ MATCH |
| same `.coursesSatisfying` | `[]` (student took zero FL courses; satisfaction comes from the flag). | `[]` | ✅ MATCH |

**Notes:** the engine correctly honors `flagExemption: ["nonEnglishSecondary",…]` from `programs.json:168-173` and surfaces the bulletin's narrative via `exemptionLabel` → `exemptReason`. This was not exercised by wave 1 and confirms the flag-exemption path works for at least one of the four CAS Core flag variants.

The dump also shows an unrelated overall warning: "Residency requirement: 32/64 -UA credits completed. Need 32 more …". That's the residency check tied to `cas.json residency.minCredits`, not the FL rule, and is bulletin-consistent (CAS L… residency 64 -UA credits).

---

## Profile 2 — Tandon student with -UY courses

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `decideSpsEnrollment("REBS1-UC 1234", tandon)` | `"blocked"`, rule `"school_total_ban"` (Tandon bulletin L167). | `blocked, school_total_ban, "Tandon … SPS courses are not allowed for credit toward the degree."` | ✅ MATCH |
| `decideSpsEnrollment("CSCI-UA 102", tandon)` | `"allowed"`, reason `"not_an_sps_course"`. | `allowed, not_an_sps_course` | ✅ MATCH |
| `decideSpsEnrollment("CP-UY 1000", tandon)` | `"allowed"`, reason `"not_an_sps_course"` (-UY is Tandon, not SPS). | `allowed, not_an_sps_course` | ✅ MATCH |
| `calculateStanding(coursesTaken, 2, tandon).level` | `"good_standing"` (GPA ≈ 3.31 ≥ 2.0). | `"good_standing"`, GPA `3.311`, completionRate `1` | ✅ MATCH |
| same `.cumulativeGPA` | window [3.20, 3.40], hand-calc 3.311. | `3.311` | ✅ MATCH |

### ⚠️ Tandon per-semester GPA-floor table is NOT modeled

Tandon bulletin L287-300 specifies a tiered minimum cumulative GPA by full-time semester completed:

| Semesters | Min cum GPA | Min credits earned |
|---|---|---|
| 1 | 1.501 | 8 |
| 2 | 1.501 | 16 |
| 3 | 1.501 | 28 |
| 4 | 1.67 | 40 |
| 5 | 1.78 | 56 |
| 6 | 1.88 | 68 |
| 7 | 1.95 | 84 |
| ≥ 8 | 2.00 | 96 |

The engine's `calculateStanding` (per its docstring at `packages/engine/src/audit/academicStanding.ts:80-83`) hard-codes a flat 2.0 floor and CAS's 50% / 75% completion thresholds. The Tandon SchoolConfig (`tandon.json:145`) only sets `overallGpaMin: 2.0`, which leaves the tiered table inactive even when running `calculateStanding(courses, 2, tandonCfg)`.

Because none of the Profile 2 assertions construct a deliberately-low-GPA Tandon student, this gap is documented but not asserted. Adding a synthetic Tandon student with cumulative GPA 1.6 at semester 1 (bulletin: in good standing, 1.6 > 1.501; engine: would flag academic_concern because 1.6 < 2.0) would expose this directly.

### ⚠️ Tandon `decideSpsEnrollment` does NOT police -UA courses

`decideSpsEnrollment("CSCI-UA 102", tandon)` returns `allowed`. Tandon bulletin L167 says "any courses taken in the School of Professional Studies" are excluded. CAS courses (-UA) are not SPS, so this is correct for the SPS guard. **However**, Tandon bulletin separately implies non-Tandon courses count against `creditCaps[type=non_home_school].maxCredits: 16` (`tandon.json:154-161`), which is a separate gate not exercised by `decideSpsEnrollment`. Bulletin doesn't say `decideSpsEnrollment` should police that, so this isn't a mismatch — but it's worth flagging that the SPS-only guard is narrowly scoped.

---

## Profile 3 — Stern student attempting CAS-allowed SPS prefixes

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `decideSpsEnrollment("REBS1-UC 1234", stern)` | `"blocked"`, rule `"school_total_ban"` (CAS allows; Stern doesn't, Stern bulletin L215). | `blocked, school_total_ban` | ✅ MATCH |
| `decideSpsEnrollment("TCHT1-UC 5", stern)` | `"blocked"`, `"school_total_ban"`. | `blocked, school_total_ban` | ✅ MATCH |
| `decideSpsEnrollment("TCSM1-UC 99", stern)` | `"blocked"`, `"school_total_ban"`. | `blocked, school_total_ban` | ✅ MATCH |
| `decideSpsEnrollment("PSYCH-UA 1", stern)` | `"allowed"`, `"not_an_sps_course"` (-UA isn't an SPS suffix). | `allowed, not_an_sps_course` | ✅ MATCH |

The Stern total-ban path (Stern bulletin L215; `stern.json:183-184`) is correctly enforced for every CAS-allowed prefix, demonstrating that the Stern config's `spsPolicy.allowed: false` short-circuits before the per-prefix allowlist check.

---

## Profile 4 — CAS student near academic dismissal

Hand-calc verification of the test fixture:
- Letter grades: F (0), C- (1.667), F (0), F (0), F (0), D (1.0). 6 letter rows × 4 credits = 24 GPA credits.
- Points = 4·1.667 + 4·1.0 = 6.668 + 4 = 10.668 → GPA = 10.668/24 = **0.4445**.
- Earned credits = C- + D = 8. Attempted = 8 rows × 4 = 32. Completion = 8/32 = **0.25**.

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `calculateStanding(courses, 2, cas).level` | `"dismissed"` (CAS bulletin L494: < 50% after 2 sem). | `"dismissed"` | ✅ MATCH |
| same `.inGoodStanding` | `false` (L466). | `false` | ✅ MATCH |
| same `.cumulativeGPA` window | [0.40, 0.50]. | `0.444` | ✅ MATCH |
| same `.completionRate` window | [0.20, 0.30]. | `0.25` | ✅ MATCH |
| same `.warnings` mentions "dismiss" / "50%" / "completion" | yes. | `"Completion rate 25% is below 50% after 2 semesters — may result in dismissal."` | ✅ MATCH |
| `calculateStanding(courses, 1, cas).level` | NOT `"dismissed"` (L494 trigger requires ≥ 2 semesters). | `"academic_concern"` | ✅ MATCH |

Wave 2 confirms the dismissal escalation gate works correctly: at 1 semester the level is `academic_concern`; at 2 semesters with same record it escalates to `dismissed`. The bulletin's threshold language ("Starting *after* a student's second semester") maps to the engine's `dismissalAfterSemesters: 2` constant.

### ⚠️ Compounded condition for `dismissed` is broader than the bulletin

Per the dump for `(courses, 1, cas)`, the 1-semester case still has GPA 0.444 < 2.0 and completion 0.25, but the level is only `academic_concern`. That matches the bulletin **only because** L494's dismissal review trigger is gated on "after the 2nd semester."

Reading the engine's `calculateStanding` docstring (academicStanding.ts:80-86) — `inGoodStanding == false` is a precondition for any dismissal escalation. The bulletin's L494 says dismissal review happens when "fewer than 50% of attempted credit hours were successfully completed", with no GPA precondition stated in that line. A student with cumulative GPA 2.5 and 40% completion could still be dismissed per L494. The engine, however, would never escalate them past `good_standing` because the GPA floor is met. This is a latent bug not covered by Profile 4's assertions (the profile's GPA is 0.444 so the gate passes for the wrong reason). Recommended follow-up profile: cumulative GPA 3.0 with completion 0.30 after 4 semesters, predict `level === "dismissed"`.

---

## Profile 5 — Cross-program double-counting at the limit

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `crossProgramAudit.programs.length` | 2 (one entry per declaration). | `2` | ✅ MATCH |
| `crossProgramAudit.warnings` no `exceeds_pair_limit` | true (≤ 2 shared courses ≤ CAS L126 cap). | `warnings = []` | ✅ MATCH |
| `crossProgramAudit.warnings` no `triple_count` | true (only 2 declared programs). | `warnings = []` | ✅ MATCH |
| `crossProgramAudit.sharedCourses.length` | ≤ 2. | `2`: MATH-UA 121, MATH-UA 122. | ✅ MATCH |

### 🟡 `core_fsi_quant` (`choose_n n=1`) over-attributes courses to `coursesSatisfying`

The diagnostic dump exposes:

```
"ruleId": "core_fsi_quant",
"status": "satisfied",
"coursesSatisfying": ["MATH-UA 121", "MATH-UA 122"]
```

The rule definition is `choose_n n=1`. By the rule's plain meaning, exactly ONE course should be applied to satisfy it; the other should remain free for other rules. The engine instead claims BOTH count toward `core_fsi_quant`. Combined with the cs_major_ba audit (which separately lists MATH-UA 121 in `cs_ba_math_calculus` and MATH-UA 122 in `cs_ba_electives`), this inflates `sharedCourses` from a bulletin-true 1 to an engine-reported 2.

**Bulletin tension:** L126 governs courses *applied to satisfy* requirements in two programs. If the second program only *needed* MATH-UA 121 to satisfy the FSI Quant rule and the engine over-attributes MATH-UA 122 as also "applied", a borderline student could be flagged at the per-pair limit when the bulletin would not consider them at the limit. Likely root cause: `choose_n` rule evaluator includes every course matching the pool, instead of stopping after `n` matches.

This isn't a hard mismatch with my Profile 5A assertions (which only check that the count is ≤ 2 and there are no warnings) but it surfaces a quantifiable engine quirk that becomes a real issue at three or more programs or when the per-pair limit is set to 1 (CAS allows departments to set tighter limits per L126; some CAS departments do).

### ⚠️ Sub-profile 5B (3 shared courses → predicted `exceeds_pair_limit`) was NOT testable

The bundled `cs_major_ba` and `cas_core` programs share at most 2 courses by their fromPool/courses lists (MATH-UA 121, MATH-UA 122). Engineering a 3rd shared course requires authoring a synthetic Program JSON, which is out of the independent fixture scope. The bulletin's "max 2" rule is exercisable as "no warning at 2"; testing "warning at 3" requires program data this wave doesn't author. Documented as UNDETERMINED in the fixtures file.

---

## Profile 6 — Synthetic transcript with school transition

| Engine call | Bulletin prediction | Engine output | Verdict |
|---|---|---|---|
| `parseTranscript(text).terms.length` | 4. | `4` | ✅ MATCH |
| `parseTranscript(text).overall.printedGpa` | 3.59. | `3.59` | ✅ MATCH |
| `parseTranscript(text).schoolTransition` is defined | yes. | non-undefined | ✅ MATCH |
| `.schoolTransition.fromSemester` | `"2024-fall"`. | `"2024-fall"` | ✅ MATCH |
| `.schoolTransition.previousSuffixes` includes `"-UT"` | yes. | `["-UT"]` | ✅ MATCH |
| `.schoolTransition.newSuffixes` includes `"-UA"` | yes. | `["-UA"]` | ✅ MATCH |
| `transcriptToProfileDraft(...).draft.homeSchool` | `"cas"` (most-recent term dominant -UA). | `"cas"` | ✅ MATCH |
| `transcriptToProfileDraft(...).draft.coursesTaken.length` | 13. | `13` | ✅ MATCH |
| `transcriptToProfileDraft(...).notes` mentions "transition" | yes. | `"Detected home-school transition at 2024-fall: -UT → -UA."` | ✅ MATCH |

### 🟡 `suffixHistory` collapses both transition suffixes to "first observed"

`doc.suffixHistory = { "-UT": "2023-fall", "-UA": "2023-fall" }` because Fall 2023 mixed -UT (2 courses) with -UA (1 course, EXPOS-UA 1). The first-observed semantics make `-UA: "2023-fall"` despite the student's home school not flipping to CAS until Fall 2024. This is consistent with the field's docstring ("Suffix → first semester observed") but a downstream consumer wanting "first semester this suffix dominated" would get the wrong value. Bulletin doesn't define this; flagged as type-contract clarity, not a bug.

The transition detector itself works correctly: it walks term-by-term, looks at the dominant suffix, and emits the change at Fall 2024.

---

## Summary

- **31 of 31 wave-2 assertions PASS.** No hard contradictions between the engine and the bulletin in these profiles.
- **Quirks / latent issues exposed by the diagnostic dump (not assertion failures):**
  1. 🟡 `choose_n n=1` rules over-attribute multiple courses to `coursesSatisfying` (Profile 5: MATH-UA 121 AND MATH-UA 122 both listed under `core_fsi_quant`).
  2. ⚠️ Tandon's per-semester tiered GPA floor (Tandon bulletin L287-300) is not modeled — engine uses CAS-style flat 2.0 floor.
  3. ⚠️ `calculateStanding`'s `dismissed` escalation requires `inGoodStanding === false` (i.e., GPA < 2.0) — yet CAS bulletin L494 conditions dismissal review on completion rate, not GPA. A high-GPA student with low completion would not be flagged.
  4. 🟡 `suffixHistory` records the first-observed semester even when that semester wasn't dominant for that suffix.
- **All MATCH outcomes:** 31.
- **AMBIGUOUS / not-modeled:** 3 (per-semester GPA tier, dismissal-without-bad-GPA, sub-profile 5B not testable with bundled programs).
- **Hard MISMATCH:** 0.

---

## Mismatches that suggest engine bugs

### 1. ⚠️ `calculateStanding` cannot reach `level: "dismissed"` for a high-GPA / low-completion student
- **Source observation:** Profile 4 reaches `dismissed` because GPA 0.44 < 2.0 (so `inGoodStanding` is false) AND completion 0.25 < 0.5 AND ≥ 2 semesters. Per the engine's docstring at `packages/engine/src/audit/academicStanding.ts:80-83`, the dismissal escalation is nested inside `if (!inGoodStanding)`.
- **Bulletin (CAS L494):** "Starting after a student's second semester … a student's record may be considered for dismissal if … fewer than 50% of attempted credit hours were successfully completed." No GPA precondition is stated in this clause.
- **Concrete failing case (suggested follow-up profile):** cumulative GPA 3.2 (passes the 2.0 floor) + completion rate 0.30 + 4 semesters completed. Bulletin says: dismissal review applies; engine: returns `good_standing`.
- **Suggested fix:** in `calculateStanding`, evaluate the L494 trigger independently of `inGoodStanding`. The two paths to "academic concern → dismissal" are separately documented in the bulletin (L466 GPA-based; L494 completion-based).

### 2. 🟡 Tandon `calculateStanding` ignores per-semester GPA-floor table (L287-300)
- **Source observation:** `tandon.json` only encodes `overallGpaMin: 2.0`. The bulletin's tiered table (semester 1 → 1.501 minimum; semester 5 → 1.78; etc.) is not represented anywhere in the SchoolConfig type.
- **Bulletin (Tandon L287-303):** the tiered table IS the rule for whether a Tandon student is in good standing. A semester-2 Tandon student with cumulative GPA 1.6 is in good standing per the bulletin (1.6 > 1.501) but the engine would return `academic_concern` (1.6 < 2.0).
- **Suggested fix:** add `SchoolConfig.standingByCreditTier?: { creditsCompleted: number; minGpa: number; minCreditsEarned: number }[]` (or similar) and have `calculateStanding` consult it before falling back to `overallGpaMin`. Phase 1 Step D already wired in `overallGpaMin` and `goodStandingReturnThreshold` from SchoolConfig; this would extend that pattern.

### 3. 🟡 `choose_n n=1` rules over-populate `coursesSatisfying`
- **Source observation:** Profile 5's `core_fsi_quant` (`choose_n n=1`) lists both `MATH-UA 121` and `MATH-UA 122` in `coursesSatisfying`, although the rule only requires one.
- **Type contract (`RuleAuditResult.coursesSatisfying`, types.ts:444):** "Courses applied toward this rule".
- **Impact:** inflates `crossProgramAudit.sharedCourses` and risks spurious `exceeds_pair_limit` warnings when a department sets a tighter sharing limit. Wave 1's report already flagged a related quirk (`coursesRemaining` populated on satisfied `choose_n` rules); fix #2 of wave 1 addressed `coursesRemaining` but didn't constrain `coursesSatisfying` to exactly `n` items.
- **Suggested fix:** in the rule evaluator, when `rule.type === "choose_n"`, cap `coursesSatisfying` to the lexicographically-first or lowest-number `n` matches. Alternatively, document that `coursesSatisfying` is "ALL courses that COULD satisfy this rule from the student's transcript," not "courses applied" — but this contradicts the field comment.

### Honourable mention (not in the top 3)

- **`suffixHistory` first-observed semantics** muddy the school-transition narrative for profiles where the second school's suffix appeared in a single course before the dominant flip. The field is documented correctly, just not very useful for the "when did the home school change" question — which is what `schoolTransition` is for, and that one works fine.
- **`decideSpsEnrollment` is narrow.** It only polices -UC/-CE courses. CAS bulletin separately limits SPS *credit type* ("elective_only") and excludes internships/independent_study even for allowed prefixes. The guard supports the `excludedCourseTypes` path (spsEnrollmentGuard.ts:97-110, visible in signature comments) but only when a `Course` is in the catalog with the right title heuristic — none of the wave-2 -UC course IDs are in `courses.json`, so the path is untested by these fixtures.

---

## What worked well (engine matches bulletin)

- **CAS Core foreign-language flag exemption** (Profile 1): all four flag values from `programs.json:168-173` (`nonEnglishSecondary`, `eslPathway`, `bsBsProgram`, `flExemptByExam`) are mapped to the CAS Core L71 exemption narrative; the rule emits `exemptReason` exactly as the type contract suggests.
- **Stern total-SPS-ban short-circuit** (Profile 3): every CAS-allowed prefix (`REBS1-UC`, `TCHT1-UC`, `TCSM1-UC`) is correctly blocked for Stern by `spsPolicy.allowed: false`. The Stern bulletin (L215) is unambiguous and the engine matches.
- **CAS dismissal trigger** (Profile 4): `dismissedAfterSemesters: 2` and `dismissalThreshold: 0.5` constants align with CAS L494; the (1 semester → academic_concern, 2 semesters → dismissed) escalation works exactly per the bulletin's "starting after a student's second semester" wording.
- **Transcript school-transition detection** (Profile 6): the dominant-suffix flip detector correctly identifies the Tisch (-UT) → CAS (-UA) crossover at the right semester even when the new dominant suffix (-UA) had been a minority presence two terms earlier.
- **`transcriptToProfileDraft` home-school inference** (Profile 6): correctly walks most-recent term backward and picks `-UA → cas` for the synthetic transcript.

---

## Files produced (wave 2)

- `packages/engine/tests/eval/independent/wave2_fixtures.md` — bulletin-derived profiles + predictions.
- `packages/engine/tests/eval/independent/wave2.test.ts` — vitest harness with assertions verbatim from the predictions table.
- `packages/engine/tests/eval/independent/_dump_wave2.test.ts` — diagnostic harness dumping engine output for inspection (always passes; comparable to wave 1's `_dump.test.ts`).
- `packages/engine/tests/eval/independent/wave2_run_report.md` — this file.

## Top concerns ranked by impact

1. **`calculateStanding` cannot reach `dismissed` without GPA < 2.0** (ranked highest impact). The bulletin explicitly documents two separate routes to dismissal review (L466 GPA-based and L494 completion-based); the engine implements them as nested rather than independent. A real-world high-GPA / low-completion student would slip through.
2. **Tandon per-semester GPA tier is not modeled.** Affects every Tandon `calculateStanding` call below 2.0 — the engine flags students who are in good standing per the Tandon bulletin.
3. **`choose_n n=1` over-populates `coursesSatisfying`.** Cosmetic in single-program audits but materially affects `crossProgramAudit.sharedCourses` and `exceeds_pair_limit` warnings, especially when departments set tighter-than-2 sharing limits per CAS L126.
