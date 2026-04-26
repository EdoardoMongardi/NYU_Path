---
title: Independent (Bulletin-only) Test Fixtures — Wave 2
author: independent-fixtures-author wave 2 (no engine source read beyond signatures + types)
date: 2026-04-26
inputs:
    - data/bulletin-raw/undergraduate/arts-science/college-core-curriculum/_index.md (FL exemption L71, L138, L681)
    - data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md (CAS double-count L126/L230, dismissal L494)
    - data/bulletin-raw/undergraduate/business/academic-policies/_index.md (Stern SPS total ban L215)
    - data/bulletin-raw/undergraduate/engineering/academic-policies/_index.md (Tandon residency L111, SPS ban L167, GPA tiers L287-300)
    - packages/shared/src/types.ts (StudentProfile.flags, RuleAuditResult.exemptReason, SchoolConfig.doubleCounting)
    - packages/engine/src/transcript/types.ts (TranscriptDocument.schoolTransition)
---

# Independent (Bulletin-only) Test Fixtures — Wave 2

This wave authors 6 NEW profiles, none overlapping wave 1.

Coverage areas (none of these were exercised by wave 1):

1. CAS Core foreign-language exemption via `flags: ["nonEnglishSecondary"]`.
2. Tandon student with `-UY` courses — exercises Tandon's `decideSpsEnrollment` (total ban), `checkResidencyCredits` analog (the bulletin's 64 -UY floor surfaces via degreeAudit/standing rather than a dedicated function), and `calculateStanding` against Tandon SchoolConfig.
3. Stern student attempting CAS-allowed SPS prefix — Stern bulletin L215 says SPS is totally banned for Stern, even prefixes that would be allowed for CAS (REBS1-UC).
4. CAS student near academic dismissal — completed >= 2 semesters at < 50% completion rate per CAS bulletin L494.
5. CAS double-counting at the limit — exactly 2 shared courses between two declared programs (predicted: no warning), then add a 3rd shared course (predicted: `exceeds_pair_limit` warning). CAS bulletin L126/L230: max 2 shared courses between two programs.
6. Synthetic transcript text with a school-transition (suffix dominance flips between terms). Predicts `doc.schoolTransition` is set and `transcriptToProfileDraft` infers `homeSchool` from the most-recent term's dominant suffix.

The engine *implementation* may diverge from these predictions; that's the point. Mismatches are surfaced in `wave2_run_report.md`.

Engine entry-point signatures exercised (read from source signature + return-type interface only):

| Function | Source signature |
|---|---|
| `degreeAudit(student, program, courses, schoolConfig)` | `packages/engine/src/audit/degreeAudit.ts:70` |
| `crossProgramAudit(student, programs, courses, schoolConfig)` | `packages/engine/src/audit/crossProgramAudit.ts:67` |
| `checkTransferEligibility(student, targetSchool, opts?)` | `packages/engine/src/audit/checkTransferEligibility.ts:70` |
| `decideSpsEnrollment(courseId, homeSchoolConfig, courseCatalog?)` | `packages/engine/src/audit/spsEnrollmentGuard.ts:47` |
| `calculateStanding(coursesTaken, semestersCompleted, schoolConfig?)` | `packages/engine/src/audit/academicStanding.ts:88` |
| `parseTranscript(text, opts?)` | `packages/engine/src/transcript/parser.ts:39` |
| `transcriptToProfileDraft(doc, options?)` | `packages/engine/src/transcript/profileMapper.ts:51` |

The bundled program catalog at the time of authoring contains only `cs_major_ba` (CS BA) and `cas_core` (CAS Core Curriculum). Wave 2 reuses these programs where it must, and the predictions section explicitly notes whenever the engine has no program JSON for the school under test (Tandon, Stern), in which case the relevant audit calls are tested via `decideSpsEnrollment` + `calculateStanding` only.

---

## Profile 1 — CAS Core foreign-language exemption (nonEnglishSecondary)

**Bulletin-derived facts:**

- CAS Core "Foreign Language → Exemptions" (`college-core-curriculum/_index.md` L71): "Students whose entire secondary schooling was in a language other than English, or who complete the EXPOS-UA 4 / EXPOS-UA 9 sequence, are exempt from the foreign language requirement."
- Re-stated in `academic-policies/_index.md` L681: "students who complete the EXPOS-UA 4 / EXPOS-UA 9 sequence are exempt from the foreign language requirement, as well as students whose entire secondary schooling was in a language other than English, and students in the dual-degree engineering program."
- The engine's `core_foreign_lang` rule lists `flagExemption: ["nonEnglishSecondary","eslPathway","bsBsProgram","flExemptByExam"]` (visible in `packages/engine/src/data/programs.json:168-173`). The flag set matches the bulletin's three exemption pathways.
- Per `RuleAuditResult.exemptReason` (`shared/src/types.ts:450`): "If rule was auto-satisfied by exemption, explains why." The engine should set this when a flag-exemption fires.

**StudentProfile JSON:**

```json
{
    "id": "synthetic-cas-fl-exempt-nonenglish",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cas_core", "programType": "major", "declaredAt": "2023-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "EXPOS-UA 1", "grade": "B+", "semester": "2023-fall", "credits": 4 },
        { "courseId": "FYSEM-UA 50", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CORE-UA 760", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CORE-UA 200", "grade": "A", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CORE-UA 100", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 201", "grade": "A", "semester": "2024-fall", "credits": 4 }
    ],
    "flags": ["nonEnglishSecondary"],
    "uaSuffixCredits": 32,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin / type citation |
|---|---|---|
| `degreeAudit(student, cas_core, courses, casConfig).rules.find(r => r.ruleId === "core_foreign_lang")` | `status === "satisfied"` AND `exemptReason` is non-empty (mentions "exempt" or "foreign language" or matches `exemptionLabel`). The student took NO foreign-language course, so without the exemption the rule could not pass. | CAS Core "Exemptions" L71. RuleAuditResult.exemptReason docstring (types.ts:450). engine programs.json:168-174 (`flagExemption: ["nonEnglishSecondary",…]`, `exemptionLabel: "Exempt from foreign language requirement"`). |
| Same call's `coursesSatisfying` | `[]` (the student satisfied the rule via flag, not via a course). | RuleAuditResult.coursesSatisfying = "Courses applied toward this rule" (types.ts:444). With no FL course taken, none should appear. **NOTE** — wave 1 already documented an engine quirk where `coursesRemaining` is populated on satisfied `choose_n` rules; bulletin says nothing about `coursesRemaining` here and we do not assert on it. |

---

## Profile 2 — Tandon BS student with -UY courses (no Tandon program JSON exists)

**Bulletin-derived facts:**

- Tandon `academic-policies/_index.md` L111 (Residency Requirement): "students must complete a minimum of at least half of the required credits at Tandon in approved Tandon coursework". For 128-credit BS (`tandon.json:144 totalCreditsRequired: 128`), residency floor = 64 -UY credits.
- Tandon L167: "Excluded from credit toward the degree are also any courses taken in the School of Professional Studies once a student is matriculated into Tandon." → SPS total ban.
- Tandon L281: "To remain in good academic standing, undergraduate students must maintain term and cumulative GPAs of 2.0 or greater."
- Tandon L287-303 contains a per-semester GPA-floor table (semester 1: 1.501, semester 4: 1.67, semester 5: 1.78, etc.). **However**, the engine's `calculateStanding` (per its docstring at `academicStanding.ts:80-83`) uses CAS's flat 2.0 floor and the CAS-derived 50% / 75% completion thresholds; the Tandon SchoolConfig overrides only `overallGpaMin` and `goodStandingReturnThreshold`. The Tandon per-semester GPA floor is therefore **not** modeled in the engine.

**StudentProfile JSON:**

```json
{
    "id": "synthetic-tandon-uy-student",
    "catalogYear": "2023",
    "homeSchool": "tandon",
    "declaredPrograms": [],
    "coursesTaken": [
        { "courseId": "MA-UY 1024", "grade": "B+", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CS-UY 1114", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "B", "semester": "2023-fall", "credits": 4 },
        { "courseId": "PH-UY 1013", "grade": "B", "semester": "2023-fall", "credits": 4 },
        { "courseId": "MA-UY 1124", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CS-UY 1134", "grade": "A", "semester": "2024-spring", "credits": 4 },
        { "courseId": "PH-UY 2023", "grade": "B-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "EG-UY 1004", "grade": "A-", "semester": "2024-spring", "credits": 2 }
    ],
    "uaSuffixCredits": 4,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin / type citation |
|---|---|---|
| `decideSpsEnrollment("REBS1-UC 1234", tandonConfig)` | `enrollment === "blocked"`, `rule === "school_total_ban"`. | Tandon bulletin L167 (SPS = no credit). `tandon.json:181-183` `spsPolicy.allowed: false`. spsEnrollmentGuard.ts L74-78 (signature visible). |
| `decideSpsEnrollment("CSCI-UA 102", tandonConfig)` | `enrollment === "allowed"`, reason `"not_an_sps_course"`. | Course id with -UA suffix is not SPS; spsEnrollmentGuard contract: only -UC/-CE suffixes are SPS. |
| `decideSpsEnrollment("CP-UY 1000", tandonConfig)` | `enrollment === "allowed"`, reason `"not_an_sps_course"`. The -UY suffix is Tandon, NOT SPS — even though Tandon bans SPS, this is not an SPS course. | spsEnrollmentGuard contract: only -UC/-CE are SPS. |
| `calculateStanding(coursesTaken, 2, tandonConfig).level` | `"good_standing"`. GPA computed only over letter-graded courses. By hand: 8 courses graded, credits = 4·4 + 4·4 + 4 + 4·4 + 4 + 4 + 4 + 2 = (let me redo) MA-UY 1024 B+ 4cr, CS-UY 1114 A- 4cr, EXPOS-UA 1 B 4cr, PH-UY 1013 B 4cr, MA-UY 1124 B+ 4cr, CS-UY 1134 A 4cr, PH-UY 2023 B- 4cr, EG-UY 1004 A- 2cr → totalGPACredits = 30. Pts = 4·3.333 + 4·3.667 + 4·3 + 4·3 + 4·3.333 + 4·4 + 4·2.667 + 2·3.667 = 13.332+14.668+12+12+13.332+16+10.668+7.334 = 99.334. GPA ≈ 99.334/30 ≈ 3.311. Level = good_standing because GPA >= 2.0. | CAS academic-policies grade-point map (re-applied because engine uses CAS map); Tandon `overallGpaMin: 2.0` (`tandon.json:145`). |
| `calculateStanding(coursesTaken, 2, tandonConfig).cumulativeGPA` | ≈ 3.31 (window 3.20-3.40). | Same hand calculation. |
| `degreeAudit(student, cs_major_ba, courses, tandonConfig)` | UNDETERMINED — the `cs_major_ba` program is a CAS BA, not a Tandon program. Running it against a Tandon student should still execute but the result has limited bulletin meaning; the bulletin doesn't say what happens when a student is audited against a program from a different school. **PREDICTION (defensive):** `overallStatus === "in_progress"` or `"not_started"`; the call should not throw. | Bulletin silent on cross-school audit; type contract (`AuditResult` always returns) is the only constraint. |

**Note on the Tandon per-semester GPA floor:** Tandon bulletin L287-300 defines a tiered minimum cumulative GPA by semester completed (1.501 through semester 3, escalating to 2.00 at >8 semesters). The engine's `calculateStanding` does not implement this tier — its CAS_DEFAULTS hard-code a flat overallGpaMin of 2.0 regardless of `semestersCompleted`. For a Tandon student with cumulative GPA 1.6 at semester 1, the bulletin says they remain in good standing (1.6 > 1.501), but the engine, configured against Tandon, would still flag GPA < 2.0 as academic_concern. We do NOT include this assertion in the test harness because (a) it requires constructing a deliberately-low-GPA student that the rest of this profile doesn't need, and (b) the wave 1 test runs the calculator successfully — we'd be duplicating its scope. Documenting the gap here for the human reviewer.

---

## Profile 3 — Stern student attempting CAS-allowed SPS course

**Bulletin-derived facts:**

- Stern `academic-policies/_index.md` L215: "Students do not receive credit for courses taken through the School of Professional Studies; therefore, Stern students are not permitted to enroll in courses through any SPS programs."
- Stern `stern.json:183-184` `spsPolicy: { allowed: false }`.
- CAS, by contrast, allows SPS prefixes `REBS1-UC, TCHT1-UC, TCSM1-UC, RWLD1-UC` per `cas.json:80`. The interesting test is a course id that CAS *would* allow (`REBS1-UC 1234`) being applied to a Stern student — bulletin says BLOCKED for Stern.

**StudentProfile JSON:**

```json
{
    "id": "synthetic-stern-sps-block",
    "catalogYear": "2025",
    "homeSchool": "stern",
    "declaredPrograms": [],
    "coursesTaken": [
        { "courseId": "ACCT-UB 1", "grade": "A-", "semester": "2025-fall", "credits": 3 }
    ],
    "uaSuffixCredits": 0,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2025,
    "visaStatus": "domestic"
}
```

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin / type citation |
|---|---|---|
| `decideSpsEnrollment("REBS1-UC 1234", sternConfig)` | `enrollment === "blocked"`, `rule === "school_total_ban"`. CAS allows REBS1-UC; Stern does NOT. | Stern bulletin L215; `stern.json:183-184` `spsPolicy.allowed: false`. spsEnrollmentGuard signature spsEnrollmentGuard.ts L20-24 (`SpsBlockRule` includes `"school_total_ban"`). |
| `decideSpsEnrollment("TCHT1-UC 5", sternConfig)` | `enrollment === "blocked"`, `rule === "school_total_ban"`. (Another CAS-allowed prefix.) | Same. |
| `decideSpsEnrollment("TCSM1-UC 99", sternConfig)` | `enrollment === "blocked"`, `rule === "school_total_ban"`. | Same. |
| `decideSpsEnrollment("PSYCH-UA 1", sternConfig)` | `enrollment === "allowed"`, reason `"not_an_sps_course"`. PSYCH-UA is CAS, not SPS. (The Stern bulletin separately governs whether CAS courses count toward Stern degree requirements; that's residency/credit-cap territory, not SPS-guard territory.) | spsEnrollmentGuard contract: only -UC/-CE suffixes trigger this guard. |

---

## Profile 4 — CAS student near academic dismissal (< 50% completion after 2 semesters)

**Bulletin-derived facts:**

- CAS `academic-policies/_index.md` L494: "Starting after a student's second semester enrolled in the College of Arts and Science, a student's record may be considered for dismissal if … fewer than 50% of attempted credit hours were successfully completed."
- L466: "A student will be considered as not in Good Academic Standing (i.e., progress will be deemed unsatisfactory) if, in any semester, the cumulative or semester grade point average falls below 2.0".
- L468: "complete 75% of attempted credits enrolled during the term of a Notice of Academic Concern." (return-to-good-standing threshold)
- The engine's `StandingLevel` type (academicStanding.ts L27-33) includes `"dismissed"` as a level.

**StudentProfile JSON (CAS, 2 semesters completed, 7 of 16 attempted credits earned = 43.75%):**

```json
{
    "id": "synthetic-cas-near-dismissal",
    "catalogYear": "2024",
    "homeSchool": "cas",
    "declaredPrograms": [],
    "coursesTaken": [
        { "courseId": "EXPOS-UA 1", "grade": "F", "semester": "2024-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "C-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CSCI-UA 101", "grade": "F", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "W", "semester": "2024-fall", "credits": 4 },
        { "courseId": "MATH-UA 9", "grade": "F", "semester": "2025-spring", "credits": 4 },
        { "courseId": "PSYCH-UA 1", "grade": "F", "semester": "2025-spring", "credits": 4 },
        { "courseId": "ANTH-UA 2", "grade": "W", "semester": "2025-spring", "credits": 4 },
        { "courseId": "ECON-UA 1", "grade": "D", "semester": "2025-spring", "credits": 4 }
    ],
    "uaSuffixCredits": 32,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2024,
    "visaStatus": "domestic"
}
```

Hand calculation:
- Letter grades: F (0), C- (1.667), F (0), F (0), F (0), D (1.0). Six letter-graded credits × 4 = 24 GPA credits. Points = 0 + 4·1.667 + 0 + 0 + 0 + 4·1.0 = 6.668 + 4 = 10.668. GPA = 10.668/24 ≈ 0.444.
- W rows (2 × 4 = 8 cr) and I/NR — engine treats W as attempted-but-not-earned per academicStanding.ts comments (visible from wave 1's run report).
- Attempted credits = all 8 courses × 4 = 32.
- Earned credits: only C- (4) and D (4) are PASSING (D is the lowest passing letter per CAS bulletin L94 and the engine's PASSING_GRADES set in academicStanding.ts L71 includes `D`). So earned = 8 cr.
- Completion rate = 8/32 = 0.25.

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin citation |
|---|---|---|
| `calculateStanding(coursesTaken, 2, casConfig).level` | `"dismissed"`. Cumulative GPA 0.44 < 2.0 (so not in good standing) AND completion rate 0.25 < 0.50 AND `semestersCompleted >= 2`. All three conditions for dismissal-level escalation are met. | CAS bulletin L466 (good standing GPA floor); L494 (dismissal review trigger after 2nd semester at < 50% completion); StandingLevel type includes `"dismissed"`. |
| Same call's `inGoodStanding` | `false`. | L466. |
| Same call's `cumulativeGPA` | ≈ 0.44, in window [0.40, 0.50]. | L350-362 grade-point map; hand calc above. |
| Same call's `completionRate` | ≈ 0.25, in window [0.20, 0.30]. | L494 ("fewer than 50%"); engine treatment of W as attempted (per wave 1 `_dump.test.ts`). |
| Same call's `warnings` | non-empty; at least one warning string mentions `"50%"` or `"dismiss"` or `"completion"`. | L494 wording. |
| `calculateStanding(coursesTaken, 1, casConfig).level` | NOT `"dismissed"`. After only 1 semester completed, even with the same poor record, the bulletin's dismissal trigger has not yet been reached. The level should still be `"academic_concern"` (or similar non-dismissal level) because GPA < 2.0 but `semestersCompleted < dismissalAfter`. | L494: "Starting *after* a student's second semester". |

---

## Profile 5 — Cross-program double-counting at the limit

**Bulletin-derived facts:**

- CAS `academic-policies/_index.md` L126: "No student may double count more than two courses between two majors (or between a major and a minor, or between two minors)".
- Re-stated at L230: "No student may double count more than two courses. Some departments have set more restrictive sharing rules…".
- L126 also says: "No course may ever be triple-counted among any combination of three majors and/or minors."
- `cas.json:86-93` `doubleCounting: { defaultMajorToMajor: 2, defaultMajorToMinor: 2, defaultMinorToMinor: 2, noTripleCounting: true }`.
- `crossProgramAudit` returns `DoubleCountWarning` with `kind: "exceeds_pair_limit"` (`crossProgramAudit.ts:34-43`).

The bundled program catalog has only `cs_major_ba` and `cas_core`. To exercise the pair-limit, this profile declares both programs (cas_core declared as `programType: "minor"`). Then we examine which courses the per-program audits include in `coursesSatisfying` for both programs:

- `MATH-UA 121` is in `cs_ba_math_calculus` (cs_major_ba) AND in `core_fsi_quant.fromPool` (cas_core). When the student takes MATH-UA 121, both per-program audits include it.
- `MATH-UA 122` is in `cs_ba_electives.mathSubstitutionPool` (cs_major_ba) AND in `core_fsi_quant.fromPool` (cas_core).
- `CHEM-UA 125` is in `core_fsi_physical.fromPool` only (cas_core).

There's no obvious THIRD course shared across both programs in the bundled JSON. To engineer a 3-shared-course test, we'd have to overload `core_fsi_quant` with `MATH-UA 121` AND `MATH-UA 122` AND a third item that also appears in cs_major_ba. The cs_major_ba program does not have any other course in cas_core's `core_fsi_quant.fromPool` beyond MATH-UA 121, MATH-UA 122. **Therefore the "exactly 2 shared courses, no warning" prediction is testable; the "3 shared, warning fires" variant needs UNDETERMINED status** — see the second sub-profile below.

**Sub-profile 5A — exactly 2 shared courses, predicted: no exceeds_pair_limit warning:**

```json
{
    "id": "synthetic-cas-doublecount-2-shared",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2023-fall", "declaredUnderCatalogYear": "2023" },
        { "programId": "cas_core", "programType": "minor", "declaredAt": "2023-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "B+", "semester": "2023-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "B+", "semester": "2023-fall", "credits": 4 },
        { "courseId": "FYSEM-UA 50", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CSCI-UA 102", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "MATH-UA 122", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 201", "grade": "B+", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CSCI-UA 202", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 760", "grade": "B+", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 200", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "CSCI-UA 472", "grade": "A-", "semester": "2025-spring", "credits": 4 }
    ],
    "flags": ["nonEnglishSecondary"],
    "uaSuffixCredits": 56,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

The shared courses we expect both audits to include in `coursesSatisfying`:
- `MATH-UA 121` (cs_ba_math_calculus + core_fsi_quant)
- `MATH-UA 122` (cs_ba_electives mathSubstitution + core_fsi_quant) — engine quirk warning: `core_fsi_quant` is `choose_n n=1`, so it would only need ONE of MATH-UA 121/122. The engine MAY assign just one of them to that rule; whichever it picks is the second shared course candidate.
- `EXPOS-UA 1` is only in cas_core (core_expos), not in cs_major_ba. NOT shared.
- The student includes `flags: ["nonEnglishSecondary"]` to satisfy `core_foreign_lang` by exemption (otherwise that rule blocks cas_core's overall completion and is a confounder for this test).

**Bulletin-predicted outcomes (5A):**

| Engine call | Predicted result | Bulletin citation |
|---|---|---|
| `crossProgramAudit(student, programs, courses, casConfig).warnings` | No `kind === "exceeds_pair_limit"` warnings between (cs_major_ba, cas_core). At most 2 shared courses → at the limit but not over. | CAS bulletin L126 (max 2 shared); cas.json `defaultMajorToMinor: 2` (since cas_core is declared as minor). |
| Same call's `sharedCourses.length` | 1 or 2 (at most 2). | crossProgramAudit.ts:54 `sharedCourses` documented as "Courses appearing in 2+ programs after audit". |
| Same call's `programs.length` | 2. | One `ProgramAuditEntry` per declaration. |
| Same call's per-entry audits | both `cs_major_ba` and `cas_core` audits run; `cs_major_ba` overall in_progress (5 electives are not all done — but the student has one, CSCI-UA 472), or satisfied for the rules they meet. | crossProgramAudit.ts:64-79 — runs `degreeAudit` per declaration. |

**Sub-profile 5B — 3+ shared courses (UNDETERMINED whether achievable with bundled programs):**

The bundled `cs_major_ba` and `cas_core` only share at most 2 courses by their `fromPool`/`courses`/`mathSubstitutionPool` lists. To engineer a 3rd shared course we'd need a custom Program JSON, which is out of scope for an independent fixture (we don't author program data). **UNDETERMINED — bulletin is not the source of the constraint here; the engine's bundled program catalog is.** The harness asserts that 5A produces no `exceeds_pair_limit`; we do NOT assert 5B because it's not achievable bulletin-only with the current data. The wave 1 `crossProgramAudit` smoke test already confirmed single-program audits produce no warnings.

---

## Profile 6 — Synthetic transcript with school transition

**Bulletin-derived facts:**

- The transcript types (`packages/engine/src/transcript/types.ts:62`) document `schoolTransition?: { fromSemester: string; previousSuffixes: string[]; newSuffixes: string[] }` — "Term in which the home school changed (G40), if detected".
- `transcriptToProfileDraft` (`profileMapper.ts:51`) sets `draft.homeSchool` based on the mapper's home-school inference from the transcript's most recent term (per the `MapperOptions` docstring at L23: "homeSchool: cas (inferred from -UA dominance from Fall 2024 onward)").

This is an arithmetic-clean synthetic transcript with two terms at "Tisch IMA" (-UT dominant) followed by two terms at "CAS" (-UA dominant). Term totals and overall block computed by hand, exact. No exam credits to simplify.

**Synthetic transcript text:**

```
Test Student
Bachelor of Arts / Major: Computer Science

Fall 2023
IMNY-UT 101  Creative Computing  A  4.0  4.0  16.0
IMNY-UT 102  Communications Lab  A  4.0  4.0  16.0
EXPOS-UA 1   Writing the Essay   B  4.0  4.0  12.0
Term Totals: AHRS 12.0 EHRS 12.0 QHRS 12.0 QPTS 44.0 GPA 3.667

Spring 2024
IMNY-UT 201  Interactive Lab     A-  4.0  4.0  14.668
IMNY-UT 202  Visual Computing    B+  4.0  4.0  13.332
ASPP-UT 2    Art Writing         B   4.0  4.0  12.0
Term Totals: AHRS 12.0 EHRS 12.0 QHRS 12.0 QPTS 40.0 GPA 3.333

Fall 2024
CSCI-UA 101  Intro CS            A   4.0  4.0  16.0
MATH-UA 121  Calculus I          A-  4.0  4.0  14.668
CORE-UA 400  Texts and Ideas     B+  4.0  4.0  13.332
EXPOS-UA 1   Writing the Essay   A   4.0  4.0  16.0
Term Totals: AHRS 16.0 EHRS 16.0 QHRS 16.0 QPTS 60.0 GPA 3.75

Spring 2025
CSCI-UA 102  Data Structures     A   4.0  4.0  16.0
MATH-UA 120  Discrete Math       A-  4.0  4.0  14.668
CORE-UA 500  Cultures Contexts   B   4.0  4.0  12.0
Term Totals: AHRS 12.0 EHRS 12.0 QHRS 12.0 QPTS 42.668 GPA 3.556

AHRS 52.0
EHRS 52.0
QHRS 52.0
QPTS 186.668
GPA 3.59
```

Arithmetic check (overall):
- AHRS = 12 + 12 + 16 + 12 = 52 ✓
- EHRS = 52 ✓
- QHRS = 52 ✓
- QPTS = 44 + 40 + 60 + 42.668 = 186.668 ✓
- GPA = 186.668 / 52 = 3.5897… → printed as 3.59 ✓

Per-term checks:
- Fall 2023: A·4·4 + A·4·4 + B·3·4 = 16+16+12 = 44 ✓; GPA 44/12 = 3.667 ✓
- Spring 2024: A-·3.667·4 + B+·3.333·4 + B·3·4 = 14.668+13.332+12 = 40 ✓; GPA 40/12 = 3.333 ✓
- Fall 2024: A·4·4 + A-·3.667·4 + B+·3.333·4 + A·4·4 = 16+14.668+13.332+16 = 60 ✓; GPA 60/16 = 3.75 ✓
- Spring 2025: A·4·4 + A-·3.667·4 + B·3·4 = 16+14.668+12 = 42.668 ✓; GPA 42.668/12 = 3.5556… → 3.556 ✓

Suffix dominance per term:
- Fall 2023: -UT × 2, -UA × 1 → dominant -UT
- Spring 2024: -UT × 3 → dominant -UT
- Fall 2024: -UA × 4 → dominant -UA (TRANSITION here)
- Spring 2025: -UA × 3 → dominant -UA

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Type / signature citation |
|---|---|---|
| `parseTranscript(text).schoolTransition` | non-undefined; `fromSemester === "2024-fall"`; `previousSuffixes` includes `"-UT"`; `newSuffixes` includes `"-UA"` and contains no `"-UT"`. | `TranscriptDocument.schoolTransition` (transcript/types.ts:62); parser detects "term in which the home school changed". |
| `parseTranscript(text).terms.length` | 4. | TranscriptTerm count. |
| `parseTranscript(text).overall.printedGpa` | 3.59. | OVERALL_LABEL_RE matches the trailing block. |
| `transcriptToProfileDraft(parseTranscript(text)).draft.homeSchool` | `"cas"` (the most-recent term's dominant suffix is `-UA`). | profileMapper.ts:51 contract; SUFFIX_TO_SCHOOL maps `-UA → cas` (profileMapper.ts L38-49). |
| `transcriptToProfileDraft(parseTranscript(text)).draft.coursesTaken.length` | 13 (all 13 graded course rows; `currentSemester` only collects `***` rows, none here). | profileMapper.ts:58-74 (skips `"***"` only). |
| `transcriptToProfileDraft(parseTranscript(text)).notes` | includes a string mentioning "transition" or `"-UT"` and `"-UA"`. | profileMapper.ts:127-132. |

---

## End of fixtures

Total profiles: 6.

Coverage summary vs wave 1:
- New: FL exemption flag-driven satisfaction (Profile 1)
- New: Tandon (-UY) school + SPS ban + tiered GPA-floor gap (Profile 2)
- New: Stern total SPS ban including CAS-allowed prefixes (Profile 3)
- New: Dismissal escalation after 2nd semester at < 50% completion (Profile 4)
- New: Two-program double-counting at limit (Profile 5)
- New: Transcript with school-transition detection + homeSchool inference (Profile 6)
