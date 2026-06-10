# School Config Spot-Check — Steinhardt

**School:** NYU Steinhardt School of Culture, Education, and Human Development (`steinhardt`)
**Config audited:** `data/schools/steinhardt.json`
**Authoritative source (bulletin):** https://bulletins.nyu.edu/undergraduate/culture-education-human-development/academic-policies/
**Supplementary sources:** `.../student-services/registration/`, `.../student-services/advising/`
**Catalog year:** 2025–2026 | **Reviewed:** 2026-06-04 | Adversarial spot-check; 34 inferred fields scrutinized.

Legend — Bulletin-claimed (not in `_inferredFields`): `✓ confirmed` / `✗ DISCREPANCY` / `? unverifiable`. Inferred (in `_inferredFields`): `⚠ inferred-OK` / `✗ MISSED` / `⚠ inferred-SUSPECT`.

| Field | Config value | Verdict | Evidence (quote + source line, or note) |
|---|---|---|---|
| `schoolId` | `steinhardt` | ✓ confirmed | Identity field; matches school. |
| `name` | NYU Steinhardt School of Culture, Education, and Human Development | ✓ confirmed | Matches bulletin title / `_index.md`. |
| `degreeType` | `BS` | ? unverifiable (representative, simplification) | The academic-policies page never assigns one school-wide degree type. Steinhardt is multi-degree: catalog has **26 BS, 6 BM, 1 BFA, 1 BA** (programs `_index.md`). BS is the plurality so it's a defensible representative, but 8 of 34 programs are non-BS (e.g. "Education Studies (BA)", all Music "(BM)", "Studio Art (BFA)"). Not in `_inferredFields`, yet not literally stated. School-wide rule that *is* stated: "minimum number of credits required for the baccalaureate degree is 128 credits" (academic-policies L382). |
| `courseSuffix` | `["-UE"]` | ✓ confirmed | Steinhardt course suffix is `-UE` throughout bulletin, e.g. `ACE-UE 110`, `MAINT-UE 4747` (academic-policies L151, L531). |
| `overallGpaMin` | `2.0` | ✓ confirmed | "Minimum 2.0 term and cumulative grade point average." (academic-policies L475). |
| `residency.type` | `suffix_based` | ⚠ inferred-OK | Bulletin states a 56-credit-at-NYU minimum but not a "suffix_based" mechanism; CAS-style default, plausible given `-UE` suffix. |
| `residency.suffix` | `-UE` | ✓ confirmed | See `courseSuffix` evidence. |
| `residency.minCredits` | `56` | ✓ confirmed | **"Steinhardt students must complete a minimum of 56 credits at NYU."** (academic-policies L66). Corroborated by Latin Honors L98 ("at least 56 credits toward the degree … in residence"). |
| `residency.finalCreditsInResidence` | `32` | ⚠ inferred-OK | No "final 32 credits in residence" rule in Steinhardt bulletin; CAS default. Plausible but unverified. |
| `residency.majorMinorResidencyPercent` | `50` | ⚠ inferred-OK | No explicit major/minor residency-percentage rule in bulletin; CAS default. |
| `creditCaps[non_home_school].maxCredits` | `16` | ⚠ inferred-OK | No non-Steinhardt credit cap stated in bulletin; CAS default (16). Cross-School Registration section (registration L98) sets no numeric cap. |
| `creditCaps[online].maxCredits` | `24` | ⚠ inferred-OK | No online-credit cap in Steinhardt bulletin; CAS default (24, raised from 16 Fall 2024). Label already flags "inferred". |
| `creditCaps[transfer].maxCredits` | `72` | ✓ confirmed | "eligible to transfer up to 72 credits." (academic-policies L128). |
| `creditCaps[advanced_standing].maxCredits` | `32` | ⚠ inferred-OK | No AP/IB/A-Level total cap stated; CAS default (32). Bulletin lists per-exam awards (AP=4cr, IB=8cr, A-Level=8cr) but no aggregate cap. Label flags "inferred". |
| `creditCaps[independent_study].maxCredits` | `6` | ✓ confirmed | "For undergraduate students, a maximum of 6 units over the course of the undergraduate career" (registration L114); also "Independent Study carries 1 to 6 units" (L110). |
| `creditCaps[independent_study].maxPerDepartment` | `8` | ⚠ inferred-OK | Bulletin: "As part of specialization: as determined by each department/program" (registration L112) — no number 8. CAS default leftover; harmless but unsupported and slightly inconsistent with the 6-unit career cap. |
| `creditCaps[independent_study].includesInternship` | `true` | ⚠ inferred-SUSPECT | CAS bundles internship + independent study (8/dept). Steinhardt's bulletin treats Internships as a **separate** section (Fieldwork Placement Advisory, academic-policies L594) with **no credit cap and no bundling**, and gives Independent Study its own standalone "6 units over the … career" cap (registration L114) with no mention of internships. Bundling appears imported from CAS and is likely wrong here. |
| `gradeThresholds.core` | `D` | ⚠ inferred-OK | Bulletin defers grade minimums to departments: "Course grade minimums as determined by program/departmental policies." (academic-policies L476). No school-wide core=D stated; CAS default plausible. |
| `gradeThresholds.major` | `C` | ⚠ inferred-OK | Same — "Course grade minimums as determined by program/departmental policies" (L476); no school-wide major=C. CAS default. |
| `gradeThresholds.minor` | `C` | ⚠ inferred-OK | Same as major; CAS default. |
| `passFail.careerLimitType` | `percent_of_program` | ✓ confirmed | "the maximum of such courses is not to exceed **25 percent** of the student's total program" (academic-policies L453). (Note: differs from CAS, which is credit-based.) |
| `passFail.careerLimit` | `25` | ✓ confirmed | Same quote, "25 percent of the student's total program" (academic-policies L453). |
| `passFail.perTermLimit` | `1` | ⚠ inferred-OK | Bulletin states only the 25%-of-program cap; **no per-term limit is stated** anywhere. CAS default (1/term) — no bulletin value to miss. |
| `passFail.perTermUnit` | `semester` | ⚠ inferred-OK | Not stated; CAS default. |
| `passFail.countsForMajor` | `false` | ⚠ inferred-OK | Not explicitly stated for Steinhardt; CAS default, consistent with general NYU practice. |
| `passFail.countsForMinor` | `false` | ⚠ inferred-OK | Not explicitly stated; CAS default. |
| `passFail.countsForGenEd` | `false` | ⚠ inferred-OK | Not explicitly stated; CAS default. |
| `passFail.excludedCourseTypes` | `[]` | ⚠ inferred-OK | Bulletin: "This pass/fail option can be applied to any course." (L455) — supports empty exclusion list. |
| `passFail.canElect` | `true` | ⚠ inferred-OK | "Matriculated students have the option to take courses on a pass/fail basis" (L453) — supports `true`. |
| `passFail.autoExcludedFromLimit` | `[]` | ⚠ inferred-OK | Departmentally-designated P/F courses are excluded from the 25% (see `exceptions`), but no auto-exclusion list applies; CAS default. |
| `passFail.gradePassEquivalent` | `D` | ⚠ inferred-OK | Not stated by Steinhardt; CAS default. Grade scale (L420-431) has D=1.0 lowest passing; plausible. |
| `passFail.failCountsInGpa` | `true` | ⚠ inferred-OK | Not explicitly stated; CAS default. Consistent with F=0 in scale and repeat policy ("all grades are counted", L443). |
| `passFail.exceptions` | (2 strings: 25% dept-designated exclusion; 64-credit weighted-honors note) | ✓ confirmed (content) / ⚠ inferred (field) | Both quotes verbatim from bulletin: "Courses that are departmentally designated as pass/fail are not included in the 25 percent pass/fail option" and "(To qualify for honors, a student must have completed at least **64 credits** toward the degree in weighted grades in residence.)" (academic-policies L455). Strongly bulletin-grounded despite being in `_inferredFields`. |
| `spsPolicy.allowed` | `true` | ⚠ inferred-OK | Whole `spsPolicy` block is inferred. SPS internal-transfer + cross-school registration exist (academic-policies L279, registration L98); allowing SPS electives is plausible. |
| `spsPolicy.allowedPrefixes` | `[REBS1-UC, TCHT1-UC, TCSM1-UC, RWLD1-UC]` | ⚠ inferred-SUSPECT | These four SPS prefixes appear **nowhere** in the Steinhardt bulletin (grep: 0 hits). They are copied verbatim from `cas.json`. Plausible NYU-wide SPS allowlist, but unverified for Steinhardt — treat as CAS carryover, not a Steinhardt-sourced list. |
| `spsPolicy.creditType` / `countsTowardResidency` / `countsAgainstNonHomeSchoolCap` / `excludedCourseTypes` | elective_only / false / true / [internship, independent_study] | ⚠ inferred-OK | Entire block inferred from CAS; no Steinhardt-specific SPS credit rules in bulletin. Plausible defaults. |
| `doubleCounting.defaultMajorToMajor` | `2` | ⚠ inferred-OK | Bulletin gives a qualitative rule, not a number: courses "may be applicable to both majors if the academic departments consider this appropriate … Some departments … set more restrictive sharing rules (a limit of one shared course, or none at all)." (academic-policies L394). Default of 2 is a CAS number, not stated; acceptable as a default. |
| `doubleCounting.defaultMajorToMinor` | `2` | ⚠ inferred-OK | Same qualitative minor rule (academic-policies L416); no number stated. CAS default. |
| `doubleCounting.defaultMinorToMinor` | `2` | ⚠ inferred-OK | Not addressed in bulletin; CAS default. |
| `doubleCounting.noTripleCounting` | `true` | ⚠ inferred-OK | Not stated in Steinhardt bulletin; CAS default. |
| `doubleCounting.requiresDepartmentApproval` | `true` | ✓ confirmed | "Students must then obtain written approval for the shared course(s) from the Program Director and/or Advisor of both programs." (academic-policies L394, L416). (Field not in `_inferredFields`.) |
| `doubleCounting.overrideByProgram` | `true` | ⚠ inferred-OK (well-grounded) | Supported: "Some departments and programs have set more restrictive sharing rules … must be followed in those cases." (academic-policies L394). |
| `transferCreditLimits.firstYearMaxTotal` | `32` | ⚠ inferred-OK | No first-year transfer cap stated for Steinhardt; CAS default (32). |
| `transferCreditLimits.transferStudentMaxTotal` | `72` | ✓ confirmed | "eligible to transfer up to 72 credits." (academic-policies L128). (Not in `_inferredFields`.) |
| `transferCreditLimits.springAdmitPostSecondaryMax` | `8` | ⚠ inferred-OK | No spring-admit post-secondary cap stated; CAS default (8). |
| `acceptsTransferCredit` | `true` | ✓ confirmed | External Transfer Credit section confirms transfer credit accepted up to 72 (academic-policies L126-128). |
| `maxCreditsPerSemester` | `18` | ✓ confirmed | "the maximum number of credits permitted for enrollment per term (Fall and Spring) is **18 credits**." (registration L65). |
| `f1FullTimeMinCredits` | `12` | ⚠ inferred-OK | No F-1 / full-time minimum stated in Steinhardt bulletin (grep: 0 hits in academic-policies). Standard NYU/SEVIS value (12); CAS default, plausible. |
| `overloadRequirements[0].minGpa` | `null` + note "petition department … up to 20 credits; no GPA threshold" | ⚠ inferred-OK (matches bulletin) | Bulletin overload rule: "Undergraduate students may, by exception, petition their department to permit them to register for up to **20 credits**." (registration L65) — **no GPA threshold stated**, so `null` is correct (and correctly diverges from CAS's 3.5). Note text is accurate. |
| `goodStandingReturnThreshold` | `0.75` | ⚠ inferred-OK | No return-to-good-standing GPA-recovery threshold in Steinhardt bulletin; CAS default (0.75). Closest bulletin fact is unrelated: incomplete-grades review triggers if a student "fail[s] to complete 50% or more of their attempted credits" (academic-policies L489) — a different metric, not a contradiction. |
| `maxCourseRepeats` | `2` | ⚠ inferred-OK | Bulletin Course Repeat Policy states only: "If a student repeats a course in which they had received a failing grade, all grades are counted in the grade-point average." (academic-policies L443). **No numeric repeat cap** is given, so `2` is an unsupported CAS default — but no bulletin value is being missed. |
| `sharedPrograms` | `[]` | ✓ confirmed | No school-wide shared-core program for Steinhardt (CAS has `cas_core`; Steinhardt has none). Empty is correct. |
| `programExclusions` | `[]` | ⚠ note | Bulletin DOES name a program-level exclusion: GPH co-majors "are not eligible to declare a non-primary major" (academic-policies L396). This is program-scoped, not a school-wide config exclusion, so `[]` is acceptable at this granularity — flagged for awareness only. |
| `deansListThreshold.minGpa` | `3.7` | ✓ confirmed | "a GPA of **3.7 or higher** in at least 12 graded credits each fall and spring term" (academic-policies L94). (Correctly differs from CAS's 3.65; not inferred.) |
| `deansListThreshold.note` | "GPA 3.7+ in ≥12 graded credits each fall/spring; no missing/N/Incomplete; P/F-elected ineligible" | ✓ confirmed | Verbatim support: "at least 12 graded credits each fall and spring term with no missing grades, N grades, or Incomplete grades … Students who elected to take a course pass/fail grading option are not eligible" (academic-policies L94). |
| `advisingContact.name` | Steinhardt Office of Advisement and Registration Services | ✓ confirmed | "Steinhardt Office of Advisement and Registration Services" (academic-policies L523); registration page "Registration Services Team". |
| `advisingContact.email` | steinhardt.advisement.registration@nyu.edu | ✓ confirmed | Email appears repeatedly, e.g. registration L25, L91; academic-policies L124. (Note: an older alias `steinhardt-registration-and-advisement-group@nyu.edu` also appears — primary address is correct.) |
| `advisingContact.url` | .../student-services/advising/ | ✓ confirmed | Valid bulletin advising page (exists, `advising/_index.md`). |

## Cross-checks of note
- **Honors GPA 3.5** (academic-policies L80, "at least a 3.5 GPA" for the Honors Program) is a *different* threshold from the Dean's List 3.7 — config correctly uses 3.7 for `deansListThreshold`; no honors-program field exists to mis-set.
- **128-credit degree minimum** (L382) and **10-year time-to-degree** (registration L37) are stated in the bulletin but have no corresponding config fields (those fields were intentionally removed per repo history) — not scored.
