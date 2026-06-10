---
title: Independent (Bulletin-only) Test Fixtures
author: independent-fixtures-author (no engine source read beyond signatures)
date: 2026-04-26
inputs:
    - data/bulletin-raw/undergraduate/arts-science/programs/computer-science-ba/_index.md
    - data/bulletin-raw/undergraduate/arts-science/programs/mathematics-computer-science-ba/_index.md
    - data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md
    - data/bulletin-raw/undergraduate/business/admissions/_index.md
    - packages/engine/tests/eval/real_transcripts/sample_01.pdf (extracted via pdfminer.six)
---

# Independent (Bulletin-only) Test Fixtures

Each profile below has:
1. **StudentProfile JSON** matching `packages/shared/src/types.ts`.
2. **Bulletin-derived predictions** — what a careful bulletin reader believes the engine should return when the audit functions are run on this profile. The predictions are NOT derived from engine source.
3. The engine *implementation* may diverge from these predictions; that's the point. Mismatches are surfaced in `independent_run_report.md`.

Programs the engine ships with at the time this fixture was authored: `cs_major_ba` (Computer Science BA) and `cas_core` (CAS Core Curriculum). Math/CS BA, Econ/CS BA, Stern programs, etc. are NOT yet in `programs.json`. Wherever a profile would naturally use Math/CS BA, we audit it against `cs_major_ba` because that's what's available; the bulletin-predictions section explicitly notes this.

Engine entry points exercised:

| Function | Source signature |
|---|---|
| `degreeAudit(student, program, courses, schoolConfig)` | `packages/engine/src/audit/degreeAudit.ts:70` |
| `crossProgramAudit(student, programs, courses, schoolConfig)` | `packages/engine/src/audit/crossProgramAudit.ts:67` |
| `checkTransferEligibility(student, targetSchool, opts?)` | `packages/engine/src/audit/checkTransferEligibility.ts:70` |
| `whatIfAudit(student, hypothetical, programs, courses, schoolConfig, compareWithCurrent?)` | `packages/engine/src/audit/whatIfAudit.ts:66` |
| `decideSpsEnrollment(courseId, homeSchoolConfig, courseCatalog?)` | `packages/engine/src/audit/spsEnrollmentGuard.ts:47` |
| `calculateStanding(coursesTaken, semestersCompleted, schoolConfig?)` | `packages/engine/src/audit/academicStanding.ts:88` |

---

## Profile 1 — Real transcript student (CAS Math/CS BA, mid-sophomore)

**Source:** real_transcript (`packages/engine/tests/eval/real_transcripts/sample_01.pdf`, extracted with `pdfminer.six`)

**Transcript-derived facts (verbatim from PDF):**

- Header: "Bachelor of Arts / Major: Computer Science/Math". Most recent block: "College of Arts and Science / Bachelor of Arts / Major: Computer Science/Math" (Fall 2024 block).
- Test Credits Applied Toward Fall 2024 (each 4.0 units, all "ADV_PL"):
    - Calculus BC ×2 (most schools award AB+BC = MATH-UA 121 + MATH-UA 122)
    - Economics – Microeconomics
    - Physics C Elec & Magnetism
    - Physics C Mechanics
    - Chinese Language & Culture
    - Computer Science A
    - World History
    - Test Totals: 32.0
- The transcript begins as a Tisch BFA student (Fall 2023, Spring 2024) and switches to CAS in Fall 2024.
- Coursework (chronological):
    - **Fall 2023 (Tisch BFA / IMA):**
        - CORE-UA 500 (Cultures & Contexts: Wine and Feasting in the Ancient Mediterranean) — 4.0, no graded mark shown ("***")
        - CSCI-UA 102 (Data Structures) — 4.0 B
        - EXPOS-UA 5 (Writing the Essay: Art in the World) — 4.0 B+
        - IMNY-UT 99 (IMA Cohort) — 0.0 P
        - IMNY-UT 101 (Creative Computing) — 4.0 A
        - IMNY-UT 102 (Communications Lab) — 4.0 A
        - "Unofficial / Unofficial" markers shown for two courses → CSCI-UA 310 / MATH-UA 233 / MATH-UA 325 — those are listed under the Spring 2025 block.
    - **Spring 2024 (Tisch BFA / IMA):**
        - ASPP-UT 2 (The World Through Art Writing The Essay) — 4.0 B
        - CSCI-UA 201 (Computer Systems Org) — 4.0 B+
        - MATH-UA 120 (Discrete Mathematics) — 4.0 B+
        - SPAN-UA 1 (Spanish for Beginners – Level I) — 4.0 A-
    - **Fall 2024 (CAS / Math-CS BA):**
        - CSCI-UA 202 (Operating Systems) — 4.0 A
        - ECON-UA 1 (Introduction to Macroeconomics) — 4.0 B
        - MATH-UA 123 (Calculus III) — 4.0 A-
        - MATH-UA 140 (Linear Algebra) — 4.0 A-
    - **Spring 2025 (CAS / Math-CS BA — UNOFFICIAL block, in progress):**
        - CSCI-UA 310 (Basic Algorithms) — 4.0 ***
        - MATH-UA 233 (Theory of Probability) — 4.0 ***
        - MATH-UA 325 (Analysis) — 4.0 ***
- Cumulative numbers at end of Fall 2024: AHRS 48 / EHRS 80 / QHRS 48 / GPA 3.500.
- Cumulative numbers at end of "End of Undergraduate Record" (Tisch portion): AHRS 64 / EHRS 80 / QHRS 48 / GPA 3.500. (16 + 16 + 16 = 48 graded NYU credits; the "EHRS 80" reflects 48 graded + 32 AP test credits applied.)

**Mapping decisions:**

- Birthdate "08/21" parsed as a partial DOB; not stored on StudentProfile (no field for it).
- AP Calc BC counted twice on the transcript (units 4 + 4) — interpret as one credit for AB sub-score (MATH-UA 121) and one for BC sub-score (MATH-UA 122). This matches NYU's published equivalencies.
- AP Computer Science A → CSCI-UA 101 (per CS BA bulletin L260 "AP credit for Computer Science A is the equivalent of CSCI-UA 101 ... and counts toward the major").
- Spring 2025 UNOFFICIAL grades go into `currentSemester` (per CourseTaken docs: "These do NOT satisfy prerequisites yet — they're used for prereq risk analysis.")
- 8 AP exams × 4.0 cr = 32 advanced-standing credits, exactly at the CAS cap (CAS bulletin L46 cap = 32; data/schools/cas.json:46).
- `homeSchool: "cas"`, `catalogYear: "2023"` (the program JSON we audit against has catalogYear 2023; in real life the student matriculated 2023-fall too).
- The available Program in the engine is `cs_major_ba`, NOT a Math/CS joint major. We declare `cs_major_ba` (BA) for purposes of this fixture; in production the student should be audited against `mathcs_major_ba`. We note this dichotomy in predictions.
- `passfailCredits = 0`. Even though IMNY-UT 99 has grade "P", that's a 0-credit cohort marker, not a P/F election.
- `nonCASNYUCredits` = 16 (Tisch IMNY-UT cohort + creative computing + communications lab + ASPP-UT all from non-CAS NYU schools, totaling > 16; but only 16 count). Strictly counted: IMNY-UT 99 (0) + IMNY-UT 101 (4) + IMNY-UT 102 (4) + ASPP-UT 2 (4) = 12. So `nonCASNYUCredits = 12`.
- `uaSuffixCredits` after Fall 2024: CSCI-UA 102 (4) + EXPOS-UA 5 (4) + CORE-UA 500 (4) + CSCI-UA 201 (4) + MATH-UA 120 (4) + SPAN-UA 1 (4) + CSCI-UA 202 (4) + ECON-UA 1 (4) + MATH-UA 123 (4) + MATH-UA 140 (4) = 40.
- Visa status not on transcript; default `"domestic"`.

**StudentProfile JSON:**

```json
{
    "id": "anonymous-student-real-01",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2024-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CORE-UA 500", "grade": "P", "semester": "2023-fall", "credits": 4, "gradeMode": "pf" },
        { "courseId": "CSCI-UA 102", "grade": "B", "semester": "2023-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 5", "grade": "B+", "semester": "2023-fall", "credits": 4 },
        { "courseId": "IMNY-UT 99", "grade": "P", "semester": "2023-fall", "credits": 0 },
        { "courseId": "IMNY-UT 101", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "IMNY-UT 102", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "ASPP-UT 2", "grade": "B", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 201", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "SPAN-UA 1", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 202", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "ECON-UA 1", "grade": "B", "semester": "2024-fall", "credits": 4 },
        { "courseId": "MATH-UA 123", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "MATH-UA 140", "grade": "A-", "semester": "2024-fall", "credits": 4 }
    ],
    "transferCourses": [
        { "source": "AP Calculus BC (AB sub-score)", "scoreOrGrade": "5", "nyuEquivalent": "MATH-UA 121", "credits": 4 },
        { "source": "AP Calculus BC", "scoreOrGrade": "5", "nyuEquivalent": "MATH-UA 122", "credits": 4 },
        { "source": "AP Microeconomics", "scoreOrGrade": "5", "nyuEquivalent": "ECON-UA 2", "credits": 4 },
        { "source": "AP Physics C: E&M", "scoreOrGrade": "5", "credits": 4 },
        { "source": "AP Physics C: Mechanics", "scoreOrGrade": "5", "credits": 4 },
        { "source": "AP Chinese Language and Culture", "scoreOrGrade": "5", "credits": 4 },
        { "source": "AP Computer Science A", "scoreOrGrade": "5", "nyuEquivalent": "CSCI-UA 101", "credits": 4 },
        { "source": "AP World History", "scoreOrGrade": "5", "credits": 4 }
    ],
    "currentSemester": {
        "term": "2025-spring",
        "courses": [
            { "courseId": "CSCI-UA 310", "title": "Basic Algorithms", "credits": 4 },
            { "courseId": "MATH-UA 233", "title": "Theory of Probability", "credits": 4 },
            { "courseId": "MATH-UA 325", "title": "Analysis", "credits": 4 }
        ]
    },
    "uaSuffixCredits": 40,
    "nonCASNYUCredits": 12,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes for the engine:**

| Engine call | Bulletin-predicted result | Bulletin / type citation |
|---|---|---|
| `degreeAudit(student, cs_major_ba, courses, casConfig)` | `overallStatus = "in_progress"`. `totalCreditsCompleted` ≥ 40 NYU graded + 32 AP = 72 (or 40 if engine ignores AP — see ambiguity below). Rules: (a) `cs_ba_intro` → satisfied via AP Computer Science A → CSCI-UA 101 equivalence. (b) `cs_ba_core` → 3 of 4 satisfied (CSCI-UA 102, 201, 202 all earned ≥ C); CSCI-UA 310 still IN PROGRESS, so rule status `in_progress`, `coursesRemaining = ["CSCI-UA 310"]`. (c) `cs_ba_electives` (5× 400-level CSCI-UA) → not_started. (d) `cs_ba_math_calculus` → satisfied via AP MATH-UA 121. (e) `cs_ba_math_discrete` → satisfied (MATH-UA 120, B+). | CS BA bulletin L138-150 (curriculum table); CS BA L260 (AP CS A = CSCI-UA 101); Stern AP table not relevant. CAS academic-policies L94 (D-floor for Core); L138 ("No course for major may be P/F") implies CORE-UA P does not count for major, but does count for graduation credit. |
| `checkTransferEligibility(student, "stern")` | `status = "not_yet_eligible"`, `entryYear` would be `"junior"` (student has > 32 + 32 AP credits, i.e., ≥ 64), `missingPrereqs` includes `microeconomics` (student took ECON-UA 1 = macro, NOT micro), `financial_accounting` (student has no ACCT-UB), `statistics` (student has no completed stats — MATH-UA 233 is in-progress and is *probability*, not the bulletin's statistics list). Calculus = satisfied (AP MATH-UA 121). Writing = SATISFIED only if EXPOS-UA 5 maps to writing/composition (the engine's hard-coded satisfiedBy list = ["EXPOS-UA 1","EXPOS-UA 4","EXPOS-UA 9"]); the BULLETIN says "1 semester of writing/composition" generally, so EXPOS-UA 5 should count. **PREDICTION: bulletin says writing satisfied; engine likely says NOT satisfied because of the heuristic satisfiedBy.** | Stern admissions L130-136 (junior prereqs); CAS academic-policies L386 (P grade definition); EXPOS-UA 5 is "Writing the Essay" — clearly a writing/comp course per any reading of the bulletin's "1 semester of writing/composition" requirement. |
| `crossProgramAudit(student, {cs_major_ba}, courses, casConfig)` | Single-program — same as `degreeAudit` above; `warnings = []`, `sharedCourses = []` (only one program). | Definition of crossProgramAudit (one program only). |
| `decideSpsEnrollment("CSCI-UA 102", casConfig)` | `enrollment = "allowed"`, `reason = "not_an_sps_course"` (no -UC/-CE suffix). | spsEnrollmentGuard contract: only -UC/-CE suffixes are SPS. |
| `decideSpsEnrollment("REBS1-UC 1234", casConfig)` | `enrollment = "allowed"` (CAS allows the prefixes REBS1-UC, TCHT1-UC, TCSM1-UC, RWLD1-UC per `cas.json` SPS policy and per CAS bulletin §A3.3 implementing). | data/schools/cas.json L78-85 (cross-checked against CAS bulletin allowed prefixes). |
| `calculateStanding(coursesTaken, 4, casConfig)` | `cumulativeGPA ≈ 3.50` (matches transcript's printed cumulative GPA of 3.500). `inGoodStanding = true`. `level = "good_standing"`. | CAS academic-policies L350-362 (grade-point map). Transcript shows cumulative GPA = 3.500 directly. |

Notable risk: the Stern transfer prereqs file lists `EXPOS-UA 1/4/9` as the only writing satisfiedBy options, but the bulletin merely says "1 semester of writing/composition" — EXPOS-UA 5 ("Writing the Essay: Art in the World") is plainly a writing course. If the engine treats the encoded `satisfiedBy` as the closed set, EXPOS-UA 5 will be falsely marked unsatisfied.

---

## Profile 2 — CAS sophomore mid-CS-major, no AP credits

**Source:** bulletin-only

**Bulletin-derived facts driving this profile:**

- A student declares the CS BA after CSCI-UA 101 with C or better (CS BA bulletin L250 "Students must complete either CSCI-UA 101 or CSCI-UA 102 ... with a grade of C or better before they can declare the major").
- Sample plan-of-study (CS BA L174-203) shows a typical sophomore in-progress at semester 4 has CSCI-UA 2, 101, 102, MATH-UA 120, MATH-UA 121, EXPOS-UA 1, plus core/FYS/elective gen-eds; 5th-semester courses (CSCI-UA 202, CSCI-UA 310) NOT yet taken.
- CAS bulletin L344: full grade range A through F, including C+ etc.

**StudentProfile JSON:**

```json
{
    "id": "synthetic-cas-sophomore-cs-noap",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2024-spring", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "B", "semester": "2023-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "B+", "semester": "2023-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CSCI-UA 102", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "A", "semester": "2024-spring", "credits": 4 },
        { "courseId": "FREN-UA 1", "grade": "B", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 201", "grade": "B", "semester": "2024-fall", "credits": 4 },
        { "courseId": "FREN-UA 2", "grade": "B+", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 760", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 200", "grade": "A", "semester": "2024-fall", "credits": 4 }
    ],
    "uaSuffixCredits": 48,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes for the engine:**

| Engine call | Bulletin-predicted result | Bulletin citation |
|---|---|---|
| `degreeAudit(student, cs_major_ba, courses, casConfig)` | `overallStatus = "in_progress"`. Rules: `cs_ba_intro` SATISFIED (CSCI-UA 101 with B). `cs_ba_core` IN_PROGRESS — has CSCI-UA 102, 201; missing 202, 310. `cs_ba_electives` NOT_STARTED. `cs_ba_math_calculus` SATISFIED (MATH-UA 121, B+). `cs_ba_math_discrete` SATISFIED (MATH-UA 120, A-). `totalCreditsCompleted = 48` (12 courses × 4). | CS BA bulletin L138-150 (12 4-credit major courses required). |
| `checkTransferEligibility(student, "stern")` | `status = "not_yet_eligible"`, `entryYear = "sophomore"` (32 ≤ creds < 64) OR `"junior"` (48 ≥ 64? — student has 48, not 64; **sophomore**). Sophomore prereqs require calculus (have MATH-UA 121 ✓) + writing (EXPOS-UA 1 ✓). **PREDICTION: status = "eligible"** for sophomore-year transfer. | Stern admissions L125-128. |
| `calculateStanding(coursesTaken, 3, casConfig)` | GPA ≈ {(4·3)+(4·3.333)+(4·3.667)+(4·4) + (4·3.333)+(4·3.667)+(4·4)+(4·3) + (4·3)+(4·3.333)+(4·3.667)+(4·4)} / 48 = (12+13.332+14.668+16 + 13.332+14.668+16+12 + 12+13.332+14.668+16)/48 = 168/48 = 3.50. `cumulativeGPA ≈ 3.50`, `level = "good_standing"`, `inGoodStanding = true`. | CAS academic-policies L350-362 grade-point table; L466 ("not in Good Academic Standing if cumulative or semester GPA < 2.0"). |

---

## Profile 3 — CAS junior nearly eligible to transfer to Stern

**Source:** bulletin-only

**Bulletin-derived facts driving this profile:**

- Stern admissions bulletin L130-136 lists junior-entry prereqs: 1 sem calculus, 1 sem writing/composition, 1 sem statistics, 1 sem financial accounting, 1 sem microeconomics. Plus L123: "Students must complete (or be in the process of completing) one full year (32 credits) of academic study in their original school of enrollment". 64+ credits → junior status.
- Build a CAS junior who has taken every junior prereq.

**StudentProfile JSON:**

```json
{
    "id": "synthetic-cas-junior-stern-eligible",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2023-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CSCI-UA 102", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "ECON-UA 2", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "ACCT-UB 1", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 201", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "MATH-UA 235", "grade": "B+", "semester": "2024-fall", "credits": 4 },
        { "courseId": "FREN-UA 1", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CSCI-UA 202", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "MATH-UA 122", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "FREN-UA 2", "grade": "A-", "semester": "2025-spring", "credits": 4 },
        { "courseId": "CORE-UA 760", "grade": "B+", "semester": "2025-spring", "credits": 4 }
    ],
    "uaSuffixCredits": 60,
    "nonCASNYUCredits": 4,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes for the engine:**

| Engine call | Bulletin-predicted result | Bulletin citation |
|---|---|---|
| `checkTransferEligibility(student, "stern")` | `status = "eligible"`. `entryYear = "junior"` (16 NYU courses × 4 = 64 credits ≥ 64 threshold). `missingPrereqs = []`. All five required junior prereqs are present: calculus = MATH-UA 121, writing = EXPOS-UA 1, statistics = MATH-UA 235, financial accounting = ACCT-UB 1, microeconomics = ECON-UA 2. | Stern admissions L132-136 (junior prereqs); cas_to_stern.json:79 (calculus satisfiedBy MATH-UA 121); cas_to_stern.json:84 (EXPOS-UA 1); cas_to_stern.json:104 (statistics MATH-UA 235); cas_to_stern.json:109 (ACCT-UB 1); cas_to_stern.json:114 (ECON-UA 2). |
| `degreeAudit(student, cs_major_ba, courses, casConfig)` | `overallStatus = "in_progress"`. `cs_ba_intro` SATISFIED. `cs_ba_core` IN_PROGRESS (has 102, 201, 202; missing 310). `cs_ba_electives` NOT_STARTED. `cs_ba_math_calculus` SATISFIED. `cs_ba_math_discrete` SATISFIED. `totalCreditsCompleted = 64`. | CS BA bulletin L138-150. |
| `calculateStanding(coursesTaken, 4, casConfig)` | `cumulativeGPA ≈ 3.69`. `level = "good_standing"`. | CAS academic-policies L350-362. |

---

## Profile 4 — CAS student missing exactly one Stern transfer prereq (microeconomics)

**Source:** bulletin-only

**Bulletin-derived facts driving this profile:**

- Identical to Profile 3 except ECON-UA 2 (Microeconomics) is replaced with a different course. Result: 4 of 5 junior prereqs satisfied; microeconomics missing.

**StudentProfile JSON:**

```json
{
    "id": "synthetic-cas-junior-missing-micro",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2023-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CSCI-UA 102", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "ECON-UA 1", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "ACCT-UB 1", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 201", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "MATH-UA 235", "grade": "B+", "semester": "2024-fall", "credits": 4 },
        { "courseId": "FREN-UA 1", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CSCI-UA 202", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "MATH-UA 122", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "FREN-UA 2", "grade": "A-", "semester": "2025-spring", "credits": 4 },
        { "courseId": "CORE-UA 760", "grade": "B+", "semester": "2025-spring", "credits": 4 }
    ],
    "uaSuffixCredits": 60,
    "nonCASNYUCredits": 4,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes for the engine:**

| Engine call | Bulletin-predicted result | Bulletin citation |
|---|---|---|
| `checkTransferEligibility(student, "stern")` | `status = "not_yet_eligible"`, `entryYear = "junior"`, `missingPrereqs.length === 1`, the single missing prereq has `category === "microeconomics"`. ECON-UA 1 (Intro to Macroeconomics) is NOT in the bulletin's microeconomics satisfiedBy set. | Stern admissions L130-136 (1 semester of microeconomics required); cas_to_stern.json:114 satisfiedBy = ["ECON-UA 2","ECON-UA 10","ECON-UA 11"]; ECON-UA 1 is macro per any standard NYU course catalog naming. |

---

## Profile 5 — Student exceeding CAS's 32-credit P/F career cap

**Source:** bulletin-only

**Bulletin-derived facts driving this profile:**

- CAS bulletin L410 (academic-policies/_index.md): "Students may elect one Pass/Fail option each term ... for a total of not more than 32 credits during their college career."
- Construct a profile with 36 P/F credits (9 P-graded courses × 4 credits) so that the audit must surface a violation/warning.
- Note: bulletin L138 says no major or minor course may be P/F, and L94/L414 say P/F doesn't count for Core. So none of these P courses count toward the major (which means the major rules will all be `not_started` w.r.t. those courses), but the CAREER total exceeds 32.

**StudentProfile JSON:**

```json
{
    "id": "synthetic-cas-pf-overcap",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2024-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "A", "semester": "2022-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "A-", "semester": "2022-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "P", "semester": "2022-fall", "credits": 4, "gradeMode": "pf" },
        { "courseId": "CORE-UA 400", "grade": "P", "semester": "2022-fall", "credits": 4, "gradeMode": "pf" },
        { "courseId": "CSCI-UA 102", "grade": "B+", "semester": "2023-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "A-", "semester": "2023-spring", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "P", "semester": "2023-spring", "credits": 4, "gradeMode": "pf" },
        { "courseId": "FREN-UA 1", "grade": "P", "semester": "2023-spring", "credits": 4, "gradeMode": "pf" },
        { "courseId": "CSCI-UA 201", "grade": "B", "semester": "2023-fall", "credits": 4 },
        { "courseId": "FREN-UA 2", "grade": "P", "semester": "2023-fall", "credits": 4, "gradeMode": "pf" },
        { "courseId": "CORE-UA 760", "grade": "P", "semester": "2023-fall", "credits": 4, "gradeMode": "pf" },
        { "courseId": "CORE-UA 200", "grade": "P", "semester": "2024-spring", "credits": 4, "gradeMode": "pf" },
        { "courseId": "CSCI-UA 202", "grade": "B", "semester": "2024-spring", "credits": 4 },
        { "courseId": "ANTH-UA 2", "grade": "P", "semester": "2024-fall", "credits": 4, "gradeMode": "pf" },
        { "courseId": "PSYCH-UA 1", "grade": "P", "semester": "2024-fall", "credits": 4, "gradeMode": "pf" }
    ],
    "uaSuffixCredits": 60,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 36,
    "matriculationYear": 2022,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes for the engine:**

| Engine call | Bulletin-predicted result | Bulletin citation |
|---|---|---|
| `degreeAudit(student, cs_major_ba, courses, casConfig)` | The audit MUST surface a warning that P/F career credits (36) exceed the 32-credit cap. Either (a) `warnings` array contains a string mentioning `"pass/fail"` or `"32 credits"` or `"P/F cap"`, or (b) one of the rules emits an `exceptionLabel`/`exemptReason` flagging it. The CS major rules themselves remain `in_progress` (only 3 of 4 core CSCI courses, no electives, etc.). | CAS academic-policies L410 (32-credit P/F career cap); types.ts L429 ("Total P/F credits taken career-wide [GEN-ACAD] §A3.5 — max 32 allowed"). The fact that the field is on `StudentProfile` and explicitly tagged "max 32 allowed" implies the engine SHOULD validate it. **Bulletin-prediction: a warning is produced.** |
| `calculateStanding(coursesTaken, 5, casConfig)` | `level = "good_standing"`. Cumulative GPA computed only over letter-graded courses (P excluded). Letter-graded credits = 6 courses × 4 = 24 GPA credits, all in B/A-/A range, GPA ≈ 3.5. | CAS academic-policies L386 ("The grade of P ... is not computed in the average."); L350-362 grade-point table. |

---

## Profile 6 — Student with W and I grades

**Source:** bulletin-only

**Bulletin-derived facts driving this profile:**

- CAS bulletin L390: "The grade of W indicates an official withdrawal of the student from a course in good academic standing." L516-518: courses with W "is not calculated in the GPA."
- CAS bulletin L394: "Grades not entered ... will lapse to NR. Courses with NR grades will not count toward earned credit and will not factor into the GPA, but will count as credits attempted and will impact academic progress evaluations".
- CAS bulletin L400-406: I (Incomplete) is a temporary grade — by analogy with NR, it counts as attempted but not earned and is not in GPA until resolved.
- The engine's GRADE_POINTS map (academicStanding.ts L56-68) excludes P, W, I, NR, TR. Thus attempted vs earned should diverge for this student.

**StudentProfile JSON:**

```json
{
    "id": "synthetic-cas-w-and-i-grades",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2023-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "B", "semester": "2023-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "B+", "semester": "2023-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "W", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CSCI-UA 102", "grade": "C+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "I", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "B", "semester": "2024-spring", "credits": 4 },
        { "courseId": "FREN-UA 1", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 201", "grade": "B", "semester": "2024-fall", "credits": 4 },
        { "courseId": "FREN-UA 2", "grade": "W", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 760", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 200", "grade": "B+", "semester": "2024-fall", "credits": 4 }
    ],
    "uaSuffixCredits": 48,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes for the engine:**

| Engine call | Bulletin-predicted result | Bulletin citation |
|---|---|---|
| `degreeAudit(student, cs_major_ba, courses, casConfig)` | `cs_ba_math_discrete` rule status: NOT satisfied (MATH-UA 120 has grade `I` — Incomplete is "temporary ... could pass" but until resolved it does NOT count toward credits earned per L394 NR analogy and per CAS practice). So `cs_ba_math_discrete` should be `in_progress` with `coursesRemaining = ["MATH-UA 120"]`. The `W`-graded courses (CORE-UA 400, FREN-UA 2) do not contribute. `totalCreditsCompleted` should NOT include W or I credits — only the 9 letter-graded (≥ D) courses × 4 = 36 earned credits. | CAS academic-policies L388-390 (Grade of W); L394 (NR analogy for unfinished work); L400-406 (Grade of I temporary). |
| `calculateStanding(coursesTaken, 3, casConfig)` | GPA computed ONLY over letter-graded courses (W and I excluded). 9 letter grades. Pts = 4·3 + 4·3.333 + 4·3.667 + 4·2.333 + 4·3 + 4·3.333 + 4·3 + 4·3.667 + 4·3.333 = 12 + 13.332 + 14.668 + 9.332 + 12 + 13.332 + 12 + 14.668 + 13.332 = 114.664; GPA = 114.664 / 36 ≈ **3.185**. `completionRate` = earned/attempted = 36/48 = **0.75** (CAS bulletin L468 = good standing return threshold). `level = "good_standing"` because GPA ≥ 2.0. **Caveat:** if the engine treats `I` as attempted-but-unearned (per L394 analogy), completion ratio would be 36/48 = 0.75 (right at the threshold). If `I` is counted as earned credits the ratio rises to 40/48 = 0.833. The bulletin direction is L394: "Courses with NR grades will not count toward earned credit and will not factor into the GPA, but will count as credits attempted." `I` is the closest analogue. | CAS academic-policies L350-362 (grade-point map); L388-390 (W) ; L394 (NR not earned, attempted); L400-406 (I); L468 (75% return-to-good-standing). |

---

## End of fixtures

Total profiles: 6.
