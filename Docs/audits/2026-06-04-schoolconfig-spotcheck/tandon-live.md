# Tandon (NYU Tandon School of Engineering) — LIVE school-config spot-check

- **School:** `tandon` — NYU Tandon School of Engineering (undergraduate, BS)
- **Config:** `data/schools/tandon.json`
- **Bulletin URL:** https://bulletin.nyu.edu/undergraduate/engineering/academic-policies/
- **Bulletin file:** `data/bulletin-raw/undergraduate/engineering/academic-policies/_index.md` (+ `student-services/_index.md`, `student-services/registration/_index.md`)
- **Catalog year:** 2025-2026
- **Scope:** Only LIVE/kept fields verified. Per Step 8e, the following were REMOVED and are NOT flagged: `gradeThresholds`, `residency.minCredits`, `passFail.careerLimit`, `overallGpaMin`, `doubleCounting`, `creditCaps[non_home_school]`.

## Verdict legend
✓ confirmed · ✗ DISCREPANCY (config ≠ bulletin) · ? unverifiable in supplied bulletin

---

### `gpaTierTable` — Minimum Credits and Minimum GPA Required by Semester of Full-Time Study (academic-policies, table at lines 291–300)

> | Number of Full-time Semesters Completed | Minimum Required Cum Grade Point Average | Minimum Credits to be Earned |
> | 1 | 1.501 | 8 |
> | 2 | 1.501 | 16 |
> | 3 | 1.501 | 28 |
> | 4 | 1.67 | 40 |
> | 5 | 1.78 | 56 |
> | 6 | 1.88 | 68 |
> | 7 | 1.95 | 84 |
> | >8 | 2.00 | 96 |

| Field | Config value | Verdict | Evidence |
| --- | --- | --- | --- |
| gpaTierTable[sem 1] | minCumGpa 1.501, minCreditsEarned 8 | ✓ | Bulletin row "1 \| 1.501 \| 8" (line 293) |
| gpaTierTable[sem 2] | minCumGpa 1.501, minCreditsEarned 16 | ✓ | Bulletin row "2 \| 1.501 \| 16" (line 294) |
| gpaTierTable[sem 3] | minCumGpa 1.501, minCreditsEarned 28 | ✓ | Bulletin row "3 \| 1.501 \| 28" (line 295) |
| gpaTierTable[sem 4] | minCumGpa 1.67, minCreditsEarned 40 | ✓ | Bulletin row "4 \| 1.67 \| 40" (line 296) |
| gpaTierTable[sem 5] | minCumGpa 1.78, minCreditsEarned 56 | ✓ | Bulletin row "5 \| 1.78 \| 56" (line 297) |
| gpaTierTable[sem 6] | minCumGpa 1.88, minCreditsEarned 68 | ✓ | Bulletin row "6 \| 1.88 \| 68" (line 298) |
| gpaTierTable[sem 7] | minCumGpa 1.95, minCreditsEarned 84 | ✓ | Bulletin row "7 \| 1.95 \| 84" (line 299) |
| gpaTierTable[>8] | semestersCompleted null, minCumGpa 2.0, minCreditsEarned 96 | ✓ | Bulletin row ">8 \| 2.00 \| 96" (line 300); config note "applies to >8 full-time semesters" matches the ">8" label |

**All 8 tiers match the bulletin table exactly** (minCumGpa and minCreditsEarned on every row).

---

### Standing fields (computed-with by calculateStanding)

| Field | Config value | Verdict | Evidence |
| --- | --- | --- | --- |
| finalProbationGpaFloor | 1.5 | ✓ | Table footnote 1: "Any time a student's cumulative GPA falls below 1.5 they are placed on Final Probation regardless of how many credits they have completed." (line 303) |
| goodStandingReturnThreshold | 0.67 | ? | NOT stated in the Tandon academic-policies bulletin. Config's own provenance (`<unprovenanced-at-v1>`, line 147) flags 0.67 as a CAS-style inherited default pending a Tandon source. The "two-thirds of the sessions" at line 216 is the W-grade withdrawal deadline, unrelated to a good-standing-return ratio. Unverifiable here. |

---

### Credit load / full-time

| Field | Config value | Verdict | Evidence |
| --- | --- | --- | --- |
| maxCreditsPerSemester | 18 | ✓ | "Full-time undergraduate students may register for 12-18 credits (all credits in excess of 18 are charged at the per credit rate)." (registration/_index.md line 46). Also probation cap: "limited to a maximum of 18 credits per semester while on probation" (line 326); normal load "14-18 credits" (line 357). 18 is the registration ceiling. |
| f1FullTimeMinCredits | 12 | ✓ (by inference) | "Undergraduate students registered for 12 or more credits per semester are categorized as full time." (line 357); registration line 46 "12-18 credits". Bulletin defines full-time floor as 12; it does not separately name an "F-1" minimum, but 12 is the full-time credit floor an F-1 student must meet. |
| overloadRequirements[default] | minGpa null, note "Adviser approval required" | ✓ | "Credit 'overloads' are approved on a case-by-case basis and dependent upon a student's academic performance… The form must be signed first by the department adviser." (registration lines 48). No fixed GPA gate stated → minGpa null is correct. |

---

### Residency

| Field | Config value | Verdict | Evidence |
| --- | --- | --- | --- |
| residency.type | suffix_based | ✓ | Residency = "approved Tandon coursework" identified by the -UY suffix; "Courses offered at the NYU Global Academic Centers (in-person or online) ending in -UY count towards the Tandon residency requirement." (student-services line 125). Suffix-based model is correct. |
| residency.suffix | -UY | ✓ | Tandon course IDs use -UY (e.g., CP-UY internships line 454; MA-UY 914 / MA-UY 1024 line 496); -UY counts toward residency (student-services line 125). |
| residency.finalCreditsInResidence | null | ✓ | "students must complete their final semester's worth of credits at the University" (line 111) — a final-semester requirement, not a fixed credit count. null correctly encodes "not denominated as a fixed credit count." |
| residency.majorMinorResidencyPercent | 50 | ✓ | "complete a minimum of at least half of the required credits at Tandon" and "In regards to Tandon minors, one-half of the coursework must be completed at the NYU Tandon School of Engineering." (line 111) |

---

### Credit caps & transfer

| Field | Config value | Verdict | Evidence |
| --- | --- | --- | --- |
| creditCaps[transfer] | maxCredits 64 | ✓ | "The maximum number of credits that can be granted is half of the degree" (line 123). Half of a 128-credit BS = 64. (Half-of-degree is the rule; 64 assumes 128 credits — see _notes caveat for non-128 programs.) |
| creditCaps[online] | (absent) | ✓ | No online-credit cap stated anywhere in the engineering bulletin. Correct to omit. |
| creditCaps[advanced_standing] | (absent) | ✓ | No advanced-standing cap stated. (AP/IB credit, line 177, is uncapped in the bulletin; Credit-by-Exam max 16, line 506, is a distinct mechanism, not a creditCaps entry.) Correct to omit. |
| creditCaps[independent_study] | (absent) | ✓ | No independent-study credit cap stated. Correct to omit. |
| transferCreditLimits.transferStudentMaxTotal | 64 | ✓ | "maximum number of credits that can be granted is half of the degree" (line 123) → 64 of 128. |
| transferCreditLimits.firstYearMaxTotal | 32 | ? | Not explicitly stated in the bulletin. Config provenance (`<unprovenanced-at-v1>`, line 147) flags 32 as a CAS-style inherited default pending a Tandon source. Unverifiable here. |
| acceptsTransferCredit | true | ✓ | "NYU Tandon awards transfer credit for relevant courses completed satisfactorily at other accredited institutions." (line 121) |

---

### Pass/Fail

| Field | Config value | Verdict | Evidence |
| --- | --- | --- | --- |
| passFail.careerLimitType | "credits" | ? | Bulletin imposes NO numeric P/F cap ("it is inadvisable to take too many courses as P/F", line 220, is advisory only). With perTermLimit null and no career limit field, careerLimitType "credits" is a vestigial unit label with no live numeric limit to scope. No bulletin number to confirm the unit. |
| passFail.perTermLimit | null | ✓ | No per-term P/F limit stated in the bulletin. null correct. |
| passFail.countsForMajor | false | ✓ | P/F course "will count only as a Free Elective course and in no other way" (line 161); "count towards a free elective course… not… any other way" (line 220). Not for major. |
| passFail.countsForMinor | false | ✓ | Same free-elective-only restriction (lines 161, 220). Not for minor. |
| passFail.creditType | "elective_only" | ✓ | "the course will count only as a Free Elective course" (line 161); "count towards a free elective course within the degree requirements" (line 220). |
| passFail.canElect | false | ✓ | "Students cannot elect to change the grading scale of classes to P/F if it is not already set up that way." (line 220) |
| passFail.gradePassEquivalent | "D" | ✓ | "A grade of P indicates a 'Pass' (equivalent to a D or above)" (line 220). |
| passFail.failCountsInGpa | true | ✓ | "Passing grades in P/F courses do not count towards the GPA. However, F grades received in a P/F graded course will count towards the GPA." (line 212); reaffirmed line 220 "an F grade will count towards the GPA." |

---

### Other policy fields

| Field | Config value | Verdict | Evidence |
| --- | --- | --- | --- |
| degreeType | "BS" | ✓ | "To be awarded a Bachelor of Science degree at NYU Tandon School of Engineering…" (line 518); "residency requirement for the BS degree" (line 111). |
| courseSuffix | ["-UY"] | ✓ | -UY observed throughout (CP-UY line 454; MA-UY 914/1024 line 496; -UY counts for residency, student-services line 125). |
| spsPolicy.allowed | false | ✓ | "Excluded from credit toward the degree are also any courses taken in the School of Professional Studies once a student is matriculated into Tandon." (line 167) |
| maxCourseRepeats | 2 | ✓ | "No undergraduate course may be taken more than three times (i.e., two repeats maximum)." (line 254); "No undergraduate course may be repeated more than twice, for a total of three attempts." (line 340). 2 repeats = correct. |
| deansListThreshold | (absent) | ✓ | No Dean's List / honor-roll GPA threshold exists in the Tandon bulletin. Honors are percentile-based Latin Honors only: summa = top 5%, magna = next 10%, cum laude = next 15% of prior year's class (lines 553), no fixed GPA. Correct to omit a deansListThreshold. |
| programExclusions[duplicate_major_other_school] | note re: no duplicate 2nd major at another NYU school (e.g., CS, Math) | ✓ | "Tandon students may not declare a second major at another NYU School if a similar major, in name and content, is offered at Tandon… may not double major in computer science at CAS… must declare the double major in math at Tandon." (lines 91–92) |

---

## Summary

- **40 field-rows checked** (8 gpaTierTable tiers + 32 other rows).
- **✓ confirmed: 36** · **✗ discrepancies: 0** · **? unverifiable: 4** (`goodStandingReturnThreshold`, `transferCreditLimits.firstYearMaxTotal`, `passFail.careerLimitType` unit, `f1FullTimeMinCredits` confirmed only by inference from the 12-credit full-time floor).
- **The two standing-critical fields are exact:** all 8 `gpaTierTable` tiers match the bulletin table, and `finalProbationGpaFloor` 1.5 matches the footnote. No standing-classification risk.
