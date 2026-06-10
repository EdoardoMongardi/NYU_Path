# Stern (Leonard N. Stern School of Business) — Live SchoolConfig Spot-Check

- **School:** `stern` — NYU Stern School of Business, undergraduate
- **Config:** `data/schools/stern.json`
- **Primary bulletin:** https://bulletins.nyu.edu/undergraduate/business/academic-policies/
- **Secondary:** https://bulletins.nyu.edu/undergraduate/business/student-services/honors-societies-awards/
- **Scope:** Only LIVE/kept fields verified. Fields removed in Step 8e (gradeThresholds, residency.minCredits, passFail.careerLimit, overallGpaMin, doubleCounting, creditCaps[non_home_school], etc.) are intentionally NOT evaluated.

| Field | Config value | Verdict | Evidence |
| --- | --- | --- | --- |
| `maxCreditsPerSemester` | 18 | ✓ confirmed | "Permission from the Stern Office of Academic Advising is required if a student wishes to take more than 18 credits in a given semester." (academic-policies, Semester Course Loads and Credit Limits) |
| `f1FullTimeMinCredits` | 12 | ? unverifiable (consistent) | Bulletin treats <12 credits as part-time ("Students are only permitted to register on a part-time basis (fewer than 12 credits) during a summer session and/or the final semester"); full-time = 12+. No explicit F-1/SEVIS minimum stated in Stern bulletin — value is the standard NYU F-1 minimum but not sourced here. |
| `residency.suffix` | "-UB" | ✓ confirmed | "complete a minimum of 64 credits of business coursework (**-UB** or equivalent) in residence" (Residency Requirements) |
| `residency.finalCreditsInResidence` | null | ✓ confirmed (none) | No "final N credits in residence" rule exists; Stern residency is the 64 -UB credits total, which is the removed `residency.minCredits`. Null is correct — no such requirement to assert. |
| `residency.majorMinorResidencyPercent` | 50 | ? unverifiable | No major/minor-specific residency percentage appears anywhere in the Stern academic-policies or student-services pages. Not contradicted, but not sourced (likely a CAS-style default). |
| `residency.type` | "suffix_based" | ✓ confirmed | Residency is defined by course suffix: "64 credits of business coursework (-UB or equivalent) in residence." Suffix-based model matches. |
| `creditCaps[advanced_standing]` | 32 | ✓ confirmed | "Non-transfer students are allowed to transfer in a maximum of 32 credits from … Advanced Placement … International Baccalaureate … foreign certificate … and college credit earned prior or during matriculation" (Residency Requirements) |
| `creditCaps[online]` | (absent) | ✓ confirmed (not present) | Config has no `online` creditCap. Bulletin only mentions online within the 8-credit while-enrolled non-business cap ("max of 8 credits … This includes courses taken online"), not a standalone online cap. Nothing to flag. |
| `creditCaps[transfer]` | (absent) | ✓ confirmed (not present) | No `transfer`-type entry in `creditCaps[]`; transfer caps live in `transferCreditLimits` (below). Consistent. |
| `creditCaps[independent_study]` | (absent) | ✓ confirmed (not present) | No `independent_study` creditCap. Bulletin describes Independent Study as a 1-credit course but states no aggregate credit cap. Nothing to flag. |
| `transferCreditLimits.firstYearMaxTotal` | 32 | ✓ confirmed | "Students can transfer back a maximum of 32 credits of non-business coursework" (Non-NYU Coursework Taken Prior to Enrolling in NYU). (Non-transfer/first-year inbound ceiling = 32; matches the advanced-standing 32 cap.) |
| `transferCreditLimits.transferStudentMaxTotal` | 64 | ✓ confirmed | "External transfer students can transfer in a maximum of 64 credits from their prior institution(s)." (Transfer Credits) |
| `overloadRequirements[firstYear].minGpa` | 3.5 | ✓ confirmed | "First year students may be given permission to take more than 18 credits … only after completing one full semester … and only if the student has a GPA of 3.5 or better." (Semester Course Loads and Credit Limits) |
| `overloadRequirements[continuing].minGpa` | 3.0 | ✓ confirmed | "Permission to take more than 18 credits per term is limited to students who have completed at least 32 credits … and who have maintained a cumulative GPA of 3.0 or better." (Semester Course Loads and Credit Limits) |
| `goodStandingReturnThreshold` | 0.67 | ✗ DISCREPANCY | No 67% / two-thirds completion-rate (pace) rule exists in the Stern bulletin. Standing is defined by "maintaining a cumulative GPA of at least 2.0 and completing no less than 12 units during each academic semester" and "complete a minimum of 24 credits per academic year" for good standing — not a 0.67 ratio. Value is an unsourced CAS-style default (config's own `_provenance` admits this). |
| `finalProbationGpaFloor` | (absent) | ✓ confirmed (not present) | No probation GPA floor field in config; bulletin defines academic alert/concern/dismissal narratively with a 2.0 cumulative GPA floor but no distinct "final probation" numeric floor. Nothing to assert. |
| `gpaTierTable` | (absent) | ✓ confirmed (not present) | Config has no GPA-tier table. Bulletin's only GPA table is the Abu Dhabi letter→points scale (standard 4.0 scale), not a standing-tier table. Nothing to flag. |
| `deansListThreshold` | (absent) | ✓ confirmed (not present) | Config has no `deansListThreshold`. (For reference, bulletin sets it at GPA 3.667 + ≥28 graded credits/year — but field is absent, so nothing to verify.) |
| `maxCourseRepeats` | 2 | ✗ DISCREPANCY | Course Repeat Policy contradicts a cap of 2: "**Students may retake a required course as many times as needed until the course is passed.**" A passed course (D or better) may not be retaken at all. So there is no "max 2 repeats" rule — it is unlimited-until-passed for failures, zero for passes. Unsourced default; config's own `_provenance` flags maxCourseRepeats (2) as a CAS-style inherited value. |
| `passFail.careerLimitType` | "courses" | ✓ confirmed | "A maximum of **4 courses** may be elected pass/fail during a student's academic career." Stern counts COURSES, not credits. Confirmed. (academic-policies, Pass/Fail Option) |
| `passFail.perTermLimit` | 1 (per academic_year) | ✓ confirmed | "No more than **one course** may be elected pass/fail in an academic year, defined as beginning in the fall and ending at the close of that following summer." perTermUnit "academic_year" matches. |
| `passFail.countsForMajor` | true | ✓ confirmed | "A course designated as pass/fail may be used to fulfill degree requirements (including BS in Business concentrations, BPE and BTE requirements)." |
| `passFail.countsForMinor` | true | ? unverifiable (weak) | Bulletin does NOT affirmatively confirm minor: it warns "If pursuing a minor or CAS major you may have **additional restrictions** on what can or cannot be elected pass/fail based on the policies that govern those areas." Not a clean ✓; the governing minor's own policy controls. Not flagged as ✗ since Stern doesn't prohibit it outright, but `true` is an over-assertion. |
| `passFail.countsForGenEd` | (absent) | ✓ confirmed (not present) | No `countsForGenEd` field in config; nothing to verify. |
| `passFail.gradePassEquivalent` | "D" | ✓ confirmed | "The Registrar automatically converts any letter grades **'A' through 'D' to 'P'** … A letter grade of 'F' will remain an 'F'." D is the lowest letter that converts to P. (Pass/Fail Important Notes) |
| `passFail.failCountsInGpa` | true | ✓ confirmed | "Grade of F: 4 grade points; 0 credits earned." and IBEX: "failing grades factor into a student's grade point average." A P/F-elected F counts in the GPA. |
| `spsPolicy.allowed` | false | ✓ confirmed | "Students do not receive credit for courses taken through the School of Professional Studies; therefore, **Stern students are not permitted to enroll in courses through any SPS programs.**" The SPS ban is real. (Elective Requirements) |
| `degreeType` | "BS" | ✓ confirmed | Degree is the Bachelor of Science: "make steady and substantial progress toward the **Bachelor of Science** degree"; Independent Study eligibility requires being a "**Bachelor of Science** candidate." |
| `courseSuffix` | ["-UB"] | ✓ confirmed | Stern business coursework carries the **-UB** suffix: "64 credits of business coursework (**-UB** or equivalent)"; course pages (ACCT-UB, FINC-UB, etc.) all -UB. |

## Summary

- **✓ confirmed:** 19
- **✗ DISCREPANCY:** 2 (`goodStandingReturnThreshold` 0.67; `maxCourseRepeats` 2)
- **? unverifiable / weak:** 3 (`f1FullTimeMinCredits`, `residency.majorMinorResidencyPercent`, `passFail.countsForMinor`)

Both discrepancies are values the config's own `_provenance` block already flags as unsourced CAS-style inherited defaults (`<unprovenanced-at-v1>` entry), pending a Stern-specific source. The Stern-specific claims the prompt singled out — P/F career limit counted in **courses** (4), and the **SPS enrollment ban** — both check out cleanly.
