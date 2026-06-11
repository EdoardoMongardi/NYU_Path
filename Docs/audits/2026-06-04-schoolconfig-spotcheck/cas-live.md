# CAS school-config spot-check — LIVE/kept fields only

- **School:** `cas` — NYU College of Arts and Science (degreeType BA)
- **Config:** `data/schools/cas.json` (post Step-8e; per-student facts moved to DPR, dead fields deleted)
- **Bulletin (primary):** https://bulletins.nyu.edu/undergraduate/arts-science/academic-policies/ — `data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md`
- **Bulletin (honors):** https://bulletins.nyu.edu/undergraduate/arts-science/academic-policies/honors-awards/ — `.../academic-policies/honors-awards/_index.md`
- **Scope note:** gradeThresholds / residency.minCredits / passFail.careerLimit / overallGpaMin / doubleCounting / creditCaps[non_home_school] were REMOVED by the refactor and are intentionally NOT checked.

| Field | Config value | Verdict | Evidence (quote + source) |
|---|---|---|---|
| `maxCreditsPerSemester` | 18 | ✓ | "Students may register for more than 18 credits per term with the approval and clearance of their academic adviser." — academic-policies, "Academic Program" (L500). 18 is the ceiling beyond which approval is needed. |
| `f1FullTimeMinCredits` | 12 | ✓ (proxy) | "Minimal full-time status entails completing at least 12 credits per term, or 24 credits per year." — academic-policies, "Academic Program" (L500). Bulletin states institutional full-time min = 12; no F-1-specific number given (F-1 12-cr min is the standard SEVIS rule). |
| `residency.type` | suffix_based | ✓ | Residency is defined entirely by the -UA suffix: "All students must complete a minimum of 64 credits in College of Arts and Science coursework (-UA suffix). Courses … without a -UA suffix … do not count" — "Residency Requirements" (L100). |
| `residency.suffix` | -UA | ✓ | "64 credits in College of Arts and Science coursework (-UA suffix)" — "Residency Requirements" (L100); matches `courseSuffix: ["-UA"]`. |
| `residency.finalCreditsInResidence` | 32 | ✓ | "Students must complete their last 32 credits while registered in the College." — "Residency Requirements" (L102). Also "The last 32 credits for the degree must be taken in residence at CAS." (L303). |
| `residency.majorMinorResidencyPercent` | 50 | ✓ | "One-half of the courses used to complete the major or the (optional) minor must be taken in the College." — "Residency Requirements" (L104); "At least one-half of the courses … used to complete the major" (L110). |
| `creditCaps[online].maxCredits` | 24 | ✓ | "By vote of the faculty in Fall 2024, this limit is now raised to 24 credits." — "Credit for Online Courses" (L268). Config label ("raised from 16 in Fall 2024") matches. |
| `creditCaps[transfer].maxCredits` | 64 | ✓ | "Students are allowed to transfer up to 64 credits to the College" — "Credit for Transfer Students" (L282). |
| `creditCaps[advanced_standing].maxCredits` | 32 | ✓ | "students who enter CAS as first years may be awarded no more than 32 advanced standing credits; this limit includes both credits from Advanced Placement and similar examinations and previous college credits." — "Dual Enrollment" (L326); also L318. |
| `creditCaps[independent_study].maxCredits` | 12 | ✓ | "students are not permitted to take more than 12 credits of independent study and/or internship" — "Credit for Independent Study" (L262). `includesInternship:true` matches ("and/or internship"). |
| `creditCaps[independent_study].maxPerDepartment` | 8 | ✓ | "no more than 8 credits may be taken in any one department." — "Credit for Independent Study" (L262); also "not more than 8 credits of independent study for work approved in advance." |
| `transferCreditLimits.firstYearMaxTotal` | 32 | ✓ (interpreted) | No single "first-year transfer cap of 32" sentence exists; 32 is the advanced-standing ceiling for first-years (AP + prior college): "no more than 32 advanced standing credits; this limit includes both credits from Advanced Placement … and previous college credits." (L326). Reasonable mapping, but the label is overloaded with advanced_standing. |
| `transferCreditLimits.transferStudentMaxTotal` | 64 | ✓ | "Students are allowed to transfer up to 64 credits to the College" (L282); "transfer students … must complete 64 credits in CAS (-UA)" (L284). |
| `transferCreditLimits.springAdmitPostSecondaryMax` | 8 | ? | No spring-admit-specific post-secondary cap of 8 found anywhere in the CAS bulletin pages reviewed. Unverifiable from the bulletin; likely sourced from an external admissions/transfer-credit policy page not in `bulletin-raw`. |
| `overloadRequirements[0].minGpa` | 3.5 | ✗ DISCREPANCY | Bulletin states NO GPA threshold for overload — only adviser approval: "Students may register for more than 18 credits per term with the approval and clearance of their academic adviser." (L500). The config's `minGpa: 3.5` and note "Adviser approval required" invent a 3.5 floor. The only 3.5/3.50 figures in the CAS tree are for dental-program admission and honor-society membership — unrelated to overloads. Corrected value: no numeric GPA gate (adviser-approval only). |
| `goodStandingReturnThreshold` | 0.75 | ✓ | "complete 75% of attempted credits enrolled during the term of a Notice of Academic Concern." — "Criteria for Academic Standing Designations" (L468). 0.75 = 75%. |
| `maxCourseRepeats` | 2 | ✓ | "Students may not repeat more than two courses during their undergraduate careers." — "Restrictions on Receiving Credit" (L222). |
| `deansListThreshold.minGpa` | 3.65 | ✓ | "achieved an average of 3.65 or higher for that academic year … in at least 28 graded credits." — honors-awards, "Dean's Honors List" (L27). |
| `deansListThreshold.minCredits` | (absent) | ✗ DISCREPANCY | Bulletin's Dean's List rule has a credit floor the config omits: "an average of 3.65 or higher … **in at least 28 graded credits**." (honors-awards L27). Config carries only `minGpa` plus a hedge note ("Traditionally 3.65; see CAS honors page"); the required `minCredits: 28` is missing. Corrected: add `minCredits: 28` (graded, annual). |
| `passFail.careerLimitType` | credits | ✓ | "Students may elect one Pass/Fail option each term … for a total of not more than 32 credits during their college career." — "Pass/Fail Option" (L410). Career limit is expressed in credits. |
| `passFail.perTermLimit` (perTermUnit semester) | 1 | ✓ | "Students may elect one Pass/Fail option each term, including the summer sessions" — "Pass/Fail Option" (L410). |
| `passFail.countsForMajor` | false | ✓ | "The Pass/Fail option is not acceptable in the major, the minor, or any of the courses taken in fulfillment of the College Core Curriculum requirements." — "Pass/Fail Option" (L414); also L138. |
| `passFail.countsForMinor` | false | ✓ | Same quote — "not acceptable in the major, the minor" (L414). |
| `passFail.countsForGenEd` | false | ✓ | Same quote — "or any of the courses taken in fulfillment of the College Core Curriculum requirements" (L414). Core = CAS gen-ed. |
| `passFail.gradePassEquivalent` | D | ✓ | "P includes the grades of A, B, C, and D and is not counted in the average." — "Pass/Fail Option" (L412); also "Grade of P … passing grade (A, B, C, or D)" (L386). Lowest passing = D. |
| `passFail.failCountsInGpa` | true | ✓ | "F is counted in the average." — "Pass/Fail Option" (L412); "The grade of F under the Pass/Fail option is computed in the average." (L386). |
| `passFail.exceptions` (FL not used for FL req is P/F-eligible) | [1 item] | ✓ | "An exception is allowed for students pursuing a foreign language sequence; here only the Intermediate II level … must be taken for a letter grade and earlier courses in the sequence may be taken Pass/Fail." — Core Curriculum reqs (L94). |
| `spsPolicy.allowed` | true | ✓ | "Effective Spring 2025, the College of Arts and Science now permits CAS students to take courses sponsored by the School of Professional Studies in these three areas …" — "Courses at Other Schools…" (L246). |
| `spsPolicy.allowedPrefixes` | REBS1-UC, TCHT1-UC, TCSM1-UC, RWLD1-UC | ✓ | "(represented by course codes REBS1-UC; TCHT1-UC; TCSM1-UC; and RWLD1-UC)." — same paragraph (L246). Exact match. |
| `spsPolicy.creditType` = elective_only; `countsTowardResidency` false; `excludedCourseTypes` [internship, independent_study] | — | ✓ | "they count toward the baccalaureate degree as general degree electives only … cannot be used to meet the CAS residency requirement of 64 UA credits … CAS students may not apply SPS internship or independent studies credits toward their degree." (L246). |
| `degreeType` | BA | ✓ | "The BA degree is the most common credential conferred in the College." — "General Degree Requirements" (L84). BA is the default/primary CAS degree (BS exists only for specific majors). |
| `courseSuffix` | ["-UA"] | ✓ | "College of Arts and Science coursework (-UA suffix)" — "Residency Requirements" (L100). |

## Fields in task list but NOT present in config (correctly skipped, not flagged)
- `finalProbationGpaFloor` — not in config. (Bulletin defines dismissal via <50% completion, not a probation GPA floor: L494.)
- `gpaTierTable` — not in config.
- `deansListThreshold.minCredits` — covered above as a DISCREPANCY (the field is absent but the bulletin requires it).
