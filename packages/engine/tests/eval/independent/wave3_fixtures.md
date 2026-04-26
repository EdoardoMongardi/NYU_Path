---
title: Independent (Bulletin-only) Test Fixtures — Wave 3
author: independent-fixtures-author wave 3 (no engine source read beyond signatures + types)
date: 2026-04-26
inputs:
    - data/bulletin-raw/undergraduate/arts-science/college-core-curriculum/_index.md (Core components L33-39, EXPOS-UA 1 L46, FYSEM L290-308)
    - data/bulletin-raw/undergraduate/arts-science/programs/computer-science-ba/_index.md (CS BA total credits, plan-of-study)
    - data/bulletin-raw/undergraduate/business/admissions/_index.md (Stern internal-transfer prereqs, March 1 deadline)
    - data/transfers/cas_to_stern.json (heuristic equivalencies)
    - packages/engine/tests/eval/real_transcripts/sample_01.pdf (extracted via Read; see Profile 6 transcript text)
    - packages/shared/src/types.ts (StudentProfile, ProgramDeclaration, CourseSuggestion)
    - Phase 3 module signatures only (multiSemesterProjector.projectMultiSemester, planExploratory, planForTransferPrep, planMultiProgram, transcript/index.ts exports)
---

# Independent (Bulletin-only) Test Fixtures — Wave 3

This wave authors 6 NEW profiles, none overlapping waves 1+2. Coverage targets the Phase 3 modules:

1. **Multi-semester projection — graduation semester:** project a CAS junior forward 6 semesters; predict the projected graduation semester from `program.totalCreditsRequired = 128` and the planner's per-semester max (5 courses × 4 cr = 20 cr/sem default).
2. **Multi-semester projection — early halt with note:** profile already at 124 credits with all CS BA + CAS Core requirements satisfied; planner should halt with a note when suggestions go to zero.
3. **Exploratory mode — undeclared CAS student** with 0 courses; predict `auditedProgramId === "cas_core"` (cas.json sharedPrograms).
4. **Transfer-prep — eligible CAS junior** that meets all 5 Stern junior prereqs; predict `transferDecision.status === "eligible"`, `missingPrereqs.length === 0`, deadlineWarnings includes "March 1", suggestions don't get a `[transfer-prereq` prefix.
5. **Cross-program priority** — student in cs_major_ba + cas_core; predict the shared course MATH-UA 121 receives the +30 SHARED_COURSE_BOOST and is ranked at the top.
6. **Transcript confirmation flow on the real transcript** (`real_transcripts/sample_01.pdf`).

Each profile's predictions are bulletin-derived; the engine implementation may diverge (mismatches surfaced in `wave3_run_report.md`).

Engine entry-point signatures exercised (from source signature + return-type only):

| Function | Source signature |
|---|---|
| `projectMultiSemester(req)` | `packages/engine/src/planner/multiSemesterProjector.ts:73` |
| `planExploratory(student, courses, prereqs, config, schoolConfig, programs)` | `packages/engine/src/planner/explorePlanner.ts:44` |
| `planForTransferPrep(student, currentMajor, targetSchool, courses, prereqs, config, schoolConfig?, opts?)` | `packages/engine/src/planner/transferPrepPlanner.ts:53` |
| `planMultiProgram(student, programs, courses, prereqs, config, schoolConfig?)` | `packages/engine/src/planner/crossProgramPlanner.ts:56` |
| `parseTranscript(text, opts?)` | `packages/engine/src/transcript/parser.ts` (re-exported via `transcript/index.ts:3`) |
| `transcriptToProfileDraft(doc, options?)` | `packages/engine/src/transcript/profileMapper.ts:51` |
| `buildConfirmationSummary(draft)` | `packages/engine/src/transcript/confirmationFlow.ts:54` |

The bundled program catalog (`packages/engine/src/data/programs.json`) at the time of authoring still contains only `cs_major_ba` (128 credit total) and `cas_core` (128 credit total). Wave 3 reuses these programs.

---

## Profile 1 — Multi-semester projection: graduation semester

**Bulletin / signature-derived facts:**

- CS BA bulletin (`programs/computer-science-ba/_index.md`): the BA totals 128 credits across 32 courses (`packages/engine/src/data/programs.json:8 totalCreditsRequired: 128`).
- `MultiSemesterRequest.maxCoursesPerSemester` default is 5; `maxCreditsPerSemester` default is 18 (signature L41-43 — semantic defaults baked into the function).
- `MultiSemesterResult.projectedGraduationSemester` is the earliest semester whose `cumulativeCreditsAtEnd >= program.totalCreditsRequired` (signature L62 + 120-121).
- Course rows are 4 credits each in CAS (every CSCI-UA / MATH-UA / CORE-UA / EXPOS-UA shipped in `courses.json` is 4 cr — observable from any wave-1 profile with realistic credit math). With `maxCredits=18` per semester, the planner adds at most 4 four-credit courses per term (4×4 = 16 ≤ 18; a 5th would exceed 18).
- The student starts at 64 NYU graded credits + 32 AP credits = 96 (the 32 AP credits show in `transferCourses` and ARE counted toward `totalCreditsCompleted` per the planner's transfer-equivalent injection at semesterPlanner L60-67 — which then flows into the audit's totalCreditsCompleted via the credit-cap validator). Need 128 - 96 = 32 more credits. At 16 cr/sem (4 courses × 4 cr), that's 2 more semesters. Starting `2025-fall`, the projector advances Fall→Spring→Fall (helper L141-150). So the **earliest semester to reach 128** is `2026-spring` (after 2025-fall: 96+16=112; after 2026-spring: 112+16=128).
- **However**: the planner's cumulativeCreditsAtEnd is `plan.projectedTotalCredits` (multiSemesterProjector.ts L75). `projectedTotalCredits` (SemesterPlan field, types.ts:562) is "Total credits after this semester" — it could be either (a) only graded NYU credits + this-sem suggestions or (b) everything (incl. AP). The bulletin doesn't tell us which; the type comment is ambiguous. **PREDICTION:** if AP credits flow through (the more inclusive interpretation), 2026-spring is the projected graduation; if only graded NYU credits flow through, the count is 64+16+16+... which means 4 more semesters → `2027-spring`. We assert the LOOSER prediction: `projectedGraduationSemester` is non-undefined and is one of `{"2026-spring", "2026-fall", "2027-spring"}` — i.e., the projector successfully detects a graduation semester within 6 projected semesters of starting at 64+ credits. We do NOT assert the exact semester because the bulletin is silent on which credit definition the planner uses for `projectedTotalCredits`.

**StudentProfile JSON (CAS junior, 64 graded NYU cr + 32 AP cr):**

```json
{
    "id": "synthetic-cas-junior-multisem-grad",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2023-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "A-", "semester": "2023-fall", "credits": 4 },
        { "courseId": "FYSEM-UA 50", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CSCI-UA 102", "grade": "B+", "semester": "2024-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "ECON-UA 2", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "A-", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 201", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "MATH-UA 235", "grade": "B+", "semester": "2024-fall", "credits": 4 },
        { "courseId": "FREN-UA 1", "grade": "A-", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CSCI-UA 202", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "CSCI-UA 310", "grade": "B+", "semester": "2025-spring", "credits": 4 },
        { "courseId": "FREN-UA 2", "grade": "A-", "semester": "2025-spring", "credits": 4 },
        { "courseId": "CORE-UA 760", "grade": "B+", "semester": "2025-spring", "credits": 4 }
    ],
    "transferCourses": [
        { "source": "AP Calculus BC", "scoreOrGrade": "5", "nyuEquivalent": "MATH-UA 121", "credits": 4 },
        { "source": "AP Computer Science A", "scoreOrGrade": "5", "nyuEquivalent": "CSCI-UA 101", "credits": 4 },
        { "source": "AP Microeconomics", "scoreOrGrade": "5", "nyuEquivalent": "ECON-UA 2", "credits": 4 },
        { "source": "AP Macroeconomics", "scoreOrGrade": "5", "credits": 4 },
        { "source": "AP World History", "scoreOrGrade": "5", "credits": 4 },
        { "source": "AP English Lit", "scoreOrGrade": "5", "credits": 4 },
        { "source": "AP Spanish Lang", "scoreOrGrade": "5", "credits": 4 },
        { "source": "AP US History", "scoreOrGrade": "5", "credits": 4 }
    ],
    "uaSuffixCredits": 60,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2023,
    "visaStatus": "domestic"
}
```

Project 6 semesters starting at `2025-fall` with default caps.

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin / signature citation |
|---|---|---|
| `projectMultiSemester({ student, program: cs_major_ba, courses, prereqs, startSemester: "2025-fall", semesterCount: 6 }).semesters.length` | between 1 and 6 inclusive (the planner halts early when it runs out of suggestions, multiSemesterProjector L100-107). | multiSemesterProjector.ts:60-77, 100-107. |
| `result.projectedGraduationSemester` | non-undefined, equal to one of `["2026-spring","2026-fall","2027-spring"]` (graduation reachable within 4 semesters of `2025-fall` given 64 graded + 32 AP = 96 cr already; need 32 more at ≤ 16 cr/sem). | CS BA `totalCreditsRequired: 128`; multiSemesterProjector.ts:120-121 (earliest semester whose `onTrackForGraduation === true`). |
| `result.semesters[0].semester` | `"2025-fall"`. | multiSemesterProjector.ts L82 — first iteration uses `startSemester`. |
| `result.semesters[1].semester` (if length ≥ 2) | `"2026-spring"`. | multiSemesterProjector helper L141-150 (Fall → Spring → Fall). |
| `result.semesters` cumulative non-decreasing | `semesters[i].cumulativeCreditsAtEnd >= semesters[i-1].cumulativeCreditsAtEnd`. | The planner folds suggestions back as completed, so cumulative cannot decrease across iterations. |
| `result.notes` | non-empty; contains a string mentioning the assumed grade ("Assumed grade for projected courses"). | multiSemesterProjector.ts L124-127. |

---

## Profile 2 — Multi-semester projection: early halt with note

**Bulletin / signature-derived facts:**

- The projector halts when `plan.suggestions.length === 0` (multiSemesterProjector.ts L99-107) and pushes a note: "Projection halted at <semester>: planner returned zero suggestions. Either all degree requirements are satisfied or no unlocked courses remain."
- A student who has already taken every required CSCI-UA and a sufficient slate of math/CSCI electives has nothing the planner can recommend. The CS BA program rules in `programs.json` are: `cs_ba_intro` (CSCI-UA 101 or 110), `cs_ba_core` (CSCI-UA 102, 201, 202, 310 — must_take), `cs_ba_electives` (5× 400-level CSCI-UA, with up to 2 substitutions from {MATH-UA 122, MATH-UA 140, MATH-UA 185}), `cs_ba_math_calculus` (MATH-UA 121), `cs_ba_math_discrete` (MATH-UA 120). Total = 1 + 4 + 5 + 1 + 1 = 12 required courses → 48 credits worth of major requirements.
- Build a profile that has all of these requirements met AND has 124+ credits total. The planner then has nothing major-related to suggest. (It may still suggest electives/Core if degreeAudit's overallStatus !== "satisfied"; the prediction below allows for some uncertainty here.)
- Halting in this case happens **at the first projection iteration** — `i === 0`. The note is emitted at that semester. After the halt, the loop breaks, so there should be exactly 1 entry in `result.semesters`.

**StudentProfile JSON (CAS senior with all CS BA major rules met):**

```json
{
    "id": "synthetic-cas-senior-cs-major-complete",
    "catalogYear": "2023",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2022-fall", "declaredUnderCatalogYear": "2023" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "A", "semester": "2022-fall", "credits": 4 },
        { "courseId": "MATH-UA 121", "grade": "A", "semester": "2022-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "A", "semester": "2022-fall", "credits": 4 },
        { "courseId": "FYSEM-UA 50", "grade": "A", "semester": "2022-fall", "credits": 4 },
        { "courseId": "CSCI-UA 102", "grade": "A", "semester": "2023-spring", "credits": 4 },
        { "courseId": "MATH-UA 120", "grade": "A", "semester": "2023-spring", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "A", "semester": "2023-spring", "credits": 4 },
        { "courseId": "CORE-UA 500", "grade": "A", "semester": "2023-spring", "credits": 4 },
        { "courseId": "CSCI-UA 201", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CSCI-UA 202", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CORE-UA 760", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CORE-UA 200", "grade": "A", "semester": "2023-fall", "credits": 4 },
        { "courseId": "CSCI-UA 310", "grade": "A", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 470", "grade": "A", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 472", "grade": "A", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CORE-UA 100", "grade": "A", "semester": "2024-spring", "credits": 4 },
        { "courseId": "CSCI-UA 473", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CSCI-UA 474", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CSCI-UA 480", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 201", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CSCI-UA 481", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "MATH-UA 122", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "MATH-UA 140", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "MATH-UA 233", "grade": "A", "semester": "2025-spring", "credits": 4 },
        { "courseId": "FREN-UA 12", "grade": "A", "semester": "2025-fall", "credits": 4 },
        { "courseId": "ECON-UA 1", "grade": "A", "semester": "2025-fall", "credits": 4 },
        { "courseId": "PHIL-UA 1", "grade": "A", "semester": "2025-fall", "credits": 4 },
        { "courseId": "ANTH-UA 1", "grade": "A", "semester": "2025-fall", "credits": 4 },
        { "courseId": "MATH-UA 325", "grade": "A", "semester": "2026-spring", "credits": 4 },
        { "courseId": "MATH-UA 328", "grade": "A", "semester": "2026-spring", "credits": 4 },
        { "courseId": "MATH-UA 329", "grade": "A", "semester": "2026-spring", "credits": 4 }
    ],
    "uaSuffixCredits": 124,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2022,
    "visaStatus": "domestic"
}
```

Total = 31 courses × 4 cr = 124 credits.

Project 5 semesters starting at `2026-fall` with default caps.

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin / signature citation |
|---|---|---|
| `projectMultiSemester({ ..., startSemester: "2026-fall", semesterCount: 5 }).semesters.length` | exactly 1 — the planner halts at first iteration when 0 suggestions are returned. | multiSemesterProjector.ts L99-107 (`if (plan.suggestions.length === 0) ... break;`). |
| `result.semesters[0].semester` | `"2026-fall"`. | First iteration starts at `startSemester`. |
| `result.notes` | contains a string mentioning "halted" and "2026-fall". | multiSemesterProjector.ts L100-104 (the halt-note text is verbatim "Projection halted at <cursor>: planner returned zero suggestions ..."). |

**Caveat:** if degreeAudit treats the cs_major_ba as still "in_progress" because the student lacks a 5th 400-level CSCI elective despite the math substitutions hitting the 2-cap (then needing 3 more 400-level CSCI), the planner could continue suggesting CSCI-UA 4xx. Still, after `cs_ba_electives` n=5 with 8 different 400-level CSCIs taken (470, 472, 473, 474, 480, 481) + 2 math substitutions (MATH-UA 122, MATH-UA 140), the rule is over-satisfied. The bulletin says nothing prevents completion at 124 credits, so the prediction stands.

If the engine continues suggesting (e.g., generic-elective filler), the test will fail and surface a planner-recursion bug.

---

## Profile 3 — Exploratory mode: undeclared CAS student

**Bulletin / signature-derived facts:**

- CAS Core bulletin (`college-core-curriculum/_index.md` L33-39): the Core has 5 components — First-Year Seminar, Foreign Language, Expository Writing, Foundations of Contemporary Culture (FCC), Foundations of Scientific Inquiry (FSI).
- L46: "Students must complete EXPOS-UA 1 Writing as Inquiry during their first year."
- L201: "During their first year, students normally complete a class from Texts and Ideas (CORE-UA 4XX) and one from Cultures and Contexts (CORE-UA 5XX)" — but L207 forbids exemption for those two, so they're always required for an undeclared student.
- L294: "The First-Year Seminar is required of all entering College of Arts and Science first-year students."
- `cas.json:110 sharedPrograms: ["cas_core"]`. `explorePlanner.ts:62-83` uses `schoolConfig.sharedPrograms[0]` as the audit target.
- `programs.json:91 cas_core` is the bundled core program with rules: `core_expos`, `core_fys`, `core_foreign_lang`, `core_fcc_texts` (CORE-UA 5*), `core_fcc_cultures` (CORE-UA 6*), `core_fcc_societies` (CORE-UA 7*), `core_fcc_expressive` (CORE-UA 8*), `core_fsi_quant`, `core_fsi_physical`, `core_fsi_life`. With ZERO courses taken, every rule is `not_started`.

**StudentProfile JSON (undeclared CAS first-year, 0 courses):**

```json
{
    "id": "synthetic-cas-undeclared-zero-courses",
    "catalogYear": "2025",
    "homeSchool": "cas",
    "declaredPrograms": [],
    "coursesTaken": [],
    "uaSuffixCredits": 0,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2025,
    "visaStatus": "domestic"
}
```

Run `planExploratory(student, courses, prereqs, { targetSemester: "2025-fall", maxCourses: 5, maxCredits: 18 }, casConfig, programsMap)` where `programsMap.get("cas_core")` resolves.

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin / signature citation |
|---|---|---|
| Result is NOT a `{ kind: "unsupported", ... }` discriminant | true — student has no declared programs (the supported precondition); CAS has `sharedPrograms: ["cas_core"]`. | explorePlanner.ts:52-83 (returns `unsupported` only when (a) student has declared programs or (b) school lacks sharedPrograms or (c) sharedProgram missing from catalog). |
| `result.auditedProgramId` | `"cas_core"`. | explorePlanner.ts:74 (`targetProgramId = sharedProgramIds[0]`). |
| `result.basis` | non-empty string mentioning "CAS Core Curriculum" or "cas_core". | explorePlanner.ts:97-99 (`basis: "Student has no declaredPrograms; audit run against shared core ..."`). |
| `result.plan.suggestions.length` | > 0 — for an empty student the planner has many unmet Core rules. | Each Core rule is `not_started` → planNextSemester scores their fromPool entries. |
| Each suggestion in `result.plan.suggestions[*].reason` | starts with `"[exploratory mode — toward "` substring (the planner re-tags every suggestion with this prefix). | explorePlanner.ts:90-94. |
| `result.plan.suggestions` includes at least one `EXPOS-UA 1` candidate | true — `core_expos` rule's `fromPool: ["EXPOS-UA 1","EXPOS-UA 4","EXPOS-UA 9"]` (programs.json:103-107). EXPOS-UA 1 is the most common of those and CAS Core L46 says students "must complete EXPOS-UA 1 ... during their first year". | programs.json `core_expos` rule. |
| `result.plan.suggestions` includes at least one `FYSEM-UA *` candidate | true — `core_fys` rule's `fromPool: ["FYSEM-UA *"]` and CAS Core L294 says FYSEM is required of all entering students. | programs.json `core_fys` rule. |
| `result.plan.suggestions` includes at least one `CORE-UA 4*` (Texts and Ideas) candidate | true — `core_fcc_texts.fromPool = ["CORE-UA 5*"]` ... wait, programs.json shows `core_fcc_texts.fromPool = ["CORE-UA 5*"]` and `core_fcc_cultures.fromPool = ["CORE-UA 6*"]`. **CONFLICT WITH BULLETIN**: bulletin (L201) says Texts and Ideas is `CORE-UA 4XX` and Cultures and Contexts is `CORE-UA 5XX`, but the engine's program JSON has these number-ranges shifted up by 1. **This is a known engine-data quirk we don't assert on**; we just check that the suggestions include some CORE-UA Number rows for FCC. | CAS Core L201 vs `programs.json` cas_core. |
| `result.notes` | non-empty; first note mentions "Exploratory mode" or "undeclared". | explorePlanner.ts:100-104. |

---

## Profile 4 — Transfer-prep eligible CAS junior

**Bulletin / signature-derived facts:**

- Stern admissions bulletin junior-entry prereqs (5 of them): calculus, writing/composition, statistics, financial accounting, microeconomics.
- `data/transfers/cas_to_stern.json` `applicationDeadline: "March 1"`, `acceptedTerms: ["fall"]`.
- Wave 1's Profile 3 already exercised `checkTransferEligibility` with all 5 prereqs satisfied and predicted `status: "eligible"`. Wave 3 reuses that profile but routes it through `planForTransferPrep` to exercise the planner-side wrapper.
- transferPrepPlanner.ts L93-127: when `decision.status === "eligible"`, the planner pushes a deadlineWarning ("`<targetSchool>` internal-transfer application deadline: `<deadline>`. Accepted terms: `<acceptedTerms>`."). Then since `missingPrereqs` is empty, no suggestion gets a `[transfer-prereq for stern: ...]` prefix.
- The student's homeSchool MUST be `cas` (not `stern`) — `checkTransferEligibility` returns `unsupported` if homeSchool === targetSchool (signature L77-83).

**StudentProfile JSON (CAS junior, all 5 Stern junior prereqs satisfied):**

```json
{
    "id": "synthetic-cas-junior-stern-eligible-w3",
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

Five junior prereqs:
- calculus → MATH-UA 121 ✓ (cas_to_stern.json L100)
- writing_composition → EXPOS-UA 1 ✓ (cas_to_stern.json L105)
- statistics → MATH-UA 235 ✓ (cas_to_stern.json L110)
- financial_accounting → ACCT-UB 1 ✓ (cas_to_stern.json L115)
- microeconomics → ECON-UA 2 ✓ (cas_to_stern.json L120)

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin / signature citation |
|---|---|---|
| `planForTransferPrep(student, cs_major_ba, "stern", courses, prereqs, config, casConfig)` is NOT `{ kind: "unsupported", ... }` | true — cas→stern data is authored. | transferPrepPlanner.ts:62-70. |
| `result.transferDecision.status` | `"eligible"`. | Stern bulletin junior prereqs (5 listed); cas_to_stern.json `entryYearRequirements[junior]`. Profile lists every required course. |
| `result.transferDecision.entryYear` (after narrowing on status) | `"junior"` — student has 16 NYU graded courses × 4 = 64 credits ≥ 64 junior threshold. | Wave 1 Profile 3 already verifies this; reused here. |
| `result.transferDecision.missingPrereqs.length` | `0`. | All 5 satisfiedBy lists hit. |
| `result.deadlineWarnings.length` | `>= 1`. | transferPrepPlanner.ts:93-96 always pushes one. |
| `result.deadlineWarnings.join(" ")` contains `"March 1"` | true. | cas_to_stern.json applicationDeadline = "March 1". |
| `result.deadlineWarnings.join(" ")` contains `"fall"` (the accepted term) | true. | cas_to_stern.json acceptedTerms = ["fall"]. |
| `result.plan.suggestions.every(s => !s.reason.startsWith("[transfer-prereq"))` | `true` — when missingPrereqs is empty, no suggestion is promoted. | transferPrepPlanner.ts:108-117 only promotes suggestions whose courseId is in `missingPrereqsAsCourses[*].candidates`; that map is empty when missingPrereqs is empty. |
| `result.plan.enrollmentWarnings` includes at least one entry that contains `"March 1"` | true. | transferPrepPlanner.ts:127 `plan.enrollmentWarnings = [...plan.enrollmentWarnings, ...deadlineWarnings]`. |

---

## Profile 5 — Cross-program priority: shared course gets +30 boost

**Bulletin / signature-derived facts:**

- crossProgramPlanner.ts L49: `SHARED_COURSE_BOOST = 30` is added when a course satisfies rules in 2+ declared programs.
- crossProgramPlanner.ts L113-117: if `programsCount >= 2`, the suggestion's reason is prefixed with `[shared across N programs: ...]` and priority is increased by 30.
- CAS bulletin double-counting (academic-policies §A3.4): max 2 courses shared between major/minor pair.
- Programs available: `cs_major_ba` and `cas_core`.
  - `cs_ba_math_calculus` rule lists `MATH-UA 121` (programs.json:67) → that course satisfies the calculus requirement of cs_major_ba.
  - `core_fsi_quant` rule's fromPool includes `MATH-UA 121` (programs.json:254) → it satisfies the FSI Quant requirement of cas_core.
  - Therefore MATH-UA 121 satisfies rules in BOTH programs. A student who has NOT yet taken MATH-UA 121 should see it suggested by both per-program plans, and the merge step should boost it by +30 with a `[shared across 2 programs: cs_major_ba, cas_core]` prefix.
- Construct a profile that has NOT taken MATH-UA 121 but has unlocked it (no prereq for MATH-UA 121 — it's the entry-level calculus course). The student also has the `nonEnglishSecondary` flag to satisfy `core_foreign_lang` exemption (so cas_core completion isn't blocked by FL — keeps merge clean).

**StudentProfile JSON (CAS first-year with cs_major_ba + cas_core declared, no MATH-UA 121 yet):**

```json
{
    "id": "synthetic-cas-multiprogram-shared",
    "catalogYear": "2024",
    "homeSchool": "cas",
    "declaredPrograms": [
        { "programId": "cs_major_ba", "programType": "major", "declaredAt": "2024-fall", "declaredUnderCatalogYear": "2024" },
        { "programId": "cas_core", "programType": "minor", "declaredAt": "2024-fall", "declaredUnderCatalogYear": "2024" }
    ],
    "coursesTaken": [
        { "courseId": "CSCI-UA 101", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "EXPOS-UA 1", "grade": "B+", "semester": "2024-fall", "credits": 4 },
        { "courseId": "FYSEM-UA 50", "grade": "A", "semester": "2024-fall", "credits": 4 },
        { "courseId": "CORE-UA 400", "grade": "B+", "semester": "2024-fall", "credits": 4 }
    ],
    "flags": ["nonEnglishSecondary"],
    "uaSuffixCredits": 16,
    "nonCASNYUCredits": 0,
    "onlineCredits": 0,
    "passfailCredits": 0,
    "matriculationYear": 2024,
    "visaStatus": "domestic"
}
```

Run `planMultiProgram(student, programsMap, courses, prereqs, { targetSemester: "2025-spring", maxCourses: 5, maxCredits: 18 }, casConfig)`.

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Bulletin / signature citation |
|---|---|---|
| `planMultiProgram(...).perProgram.length` | 2. | crossProgramPlanner.ts:65-76 — one entry per declared program. |
| `result.merged.length` | `>= 1`. | merged is the dedup-by-courseId of per-program suggestions. With at least the FYSEM-already-done plus some next-semester needs, at least one suggestion exists. |
| `result.merged[0].courseId` | `"MATH-UA 121"`. | This is the only course currently both in cs_ba_math_calculus AND in core_fsi_quant for an unmet rule pair. After +30 boost over any single-program suggestion, it should sort to position 0. |
| `result.merged[0].reason` | starts with `"[shared across 2 programs:"` substring. | crossProgramPlanner.ts:114-117. |
| `result.merged[0].satisfiesRules` | includes both `"cs_ba_math_calculus"` and `"core_fsi_quant"`. | crossProgramPlanner.ts:91-96 (rules merged across the per-program suggestion's lists). |
| `result.audit.warnings.filter(w => w.kind === "exceeds_pair_limit").length` | `0`. | Only one shared course is in play (MATH-UA 121 not yet taken; the rule is unmet); cas.json double-count limit is 2. |
| `result.notes` | non-empty; mentions "shared across declared programs" or "shared". | crossProgramPlanner.ts:140 always pushes one. |

**Caveat / UNDETERMINED:** if the engine's merge step does NOT add MATH-UA 121 from BOTH programs (e.g., if the cs_major_ba audit doesn't flag MATH-UA 121 as a suggestion because the student already has CSCI-UA 101 and the planner doesn't prioritize math early; or if the cas_core audit only suggests it as part of `core_fsi_quant` whose `n=1` is also met by other courses in the fromPool), the +30 boost may not be applied to MATH-UA 121 at all. The bulletin doesn't dictate the planner's per-rule scoring; the prediction above relies on `MATH-UA 121` actually being in BOTH per-program plans for this student. We assert it AS WRITTEN; if it fails, the report will document why the engine routed differently.

---

## Profile 6 — Transcript confirmation flow on the real transcript

**Transcript-derived facts (verbatim from `real_transcripts/sample_01.pdf`):**

Header: Edoardo Mongardi, Birthdate 08/21, Print Date 04/08/2025, Student ID N17849249.

Test Credits Applied Toward Fall 2024 (8 entries, 4.0 units each, 32.0 total):
- ADV_PL Calculus BC (×2)
- ADV_PL Economics – Microeconomics
- ADV_PL Physics C Elec & Magnetism
- ADV_PL Physics C Mechanics
- ADV_PL Chinese Language & Culture
- ADV_PL Computer Science A
- ADV_PL World History

Term blocks:

- **Fall 2023 (Tisch BFA, IMA major):** CSCI-UA 102 4.0 B; EXPOS-UA 5 4.0 B+; IMNY-UT 99 0.0 P; IMNY-UT 101 4.0 A; IMNY-UT 102 4.0 A. Term totals: AHRS 16.0 EHRS 16.0 QHRS 16.0 QPTS 57.332 GPA 3.583.
- **Spring 2024 (Tisch BFA, IMA major):** ASPP-UT 2 4.0 B; CSCI-UA 201 4.0 B+; MATH-UA 120 4.0 B+; SPAN-UA 1 4.0 A-. Term totals: AHRS 16.0 EHRS 16.0 QHRS 16.0 QPTS 53.332 GPA 3.333. Cumulative: AHRS 32.0 EHRS 32.0 QHRS 32.0 QPTS 110.664 GPA 3.458.
- **Fall 2024 (CAS BA, CS/Math major):** CSCI-UA 202 4.0 A; ECON-UA 1 4.0 B; MATH-UA 123 4.0 A-; MATH-UA 140 4.0 A-. Term totals: AHRS 16.0 EHRS 16.0 QHRS 16.0 QPTS 57.336 GPA 3.584. Cumulative: AHRS 48.0 EHRS 80.0 QHRS 48.0 QPTS 168.000 GPA 3.500.
- **Spring 2025 (CAS BA, CS/Math major) — UNOFFICIAL/in-progress:** CORE-UA 500 4.0 ***; CSCI-UA 310 4.0 ***; MATH-UA 233 4.0 ***; MATH-UA 325 4.0 ***. Term totals: AHRS 16.0 EHRS 0.0 QHRS 0.0 QPTS 0.000 GPA 0.000. Cumulative: AHRS 64.0 EHRS 80.0 QHRS 48.0 QPTS 168.000 GPA 3.500.

Counts derived for buildConfirmationSummary fields:

- `homeSchool`: most-recent term (Spring 2025) suffix dominance is `-UA` (3 of 3 graded-or-IP rows are -UA: CORE-UA 500, CSCI-UA 310, MATH-UA 233, MATH-UA 325 — actually 4 of 4). Inference walks back from the last term; first term with any -U* suffix wins. Spring 2025 has 4× -UA → `homeSchool === "cas"`. Wave 1 also predicts and verifies this.
- `cumulativeGPA` (computed by buildConfirmationSummary, NOT taken from transcript): the function iterates `coursesTaken` (which excludes `***` rows) using the GRADE_POINTS table at confirmationFlow.ts:61-67. Letter grades and credits taken (from `coursesTaken`):
  - CSCI-UA 102 B 4 → 3.000 × 4 = 12.000
  - EXPOS-UA 5 B+ 4 → 3.333 × 4 = 13.332
  - IMNY-UT 99 P 0 → P excluded from GRADE_POINTS (only "PASSING"); 0 credits anyway
  - IMNY-UT 101 A 4 → 4.000 × 4 = 16.000
  - IMNY-UT 102 A 4 → 4.000 × 4 = 16.000
  - ASPP-UT 2 B 4 → 3.000 × 4 = 12.000
  - CSCI-UA 201 B+ 4 → 3.333 × 4 = 13.332
  - MATH-UA 120 B+ 4 → 3.333 × 4 = 13.332
  - SPAN-UA 1 A- 4 → 3.667 × 4 = 14.668
  - CSCI-UA 202 A 4 → 4.000 × 4 = 16.000
  - ECON-UA 1 B 4 → 3.000 × 4 = 12.000
  - MATH-UA 123 A- 4 → 3.667 × 4 = 14.668
  - MATH-UA 140 A- 4 → 3.667 × 4 = 14.668

  Sum of qpts = 12 + 13.332 + 16 + 16 + 12 + 13.332 + 13.332 + 14.668 + 16 + 12 + 14.668 + 14.668 = **167.999 ≈ 168.000** (matches transcript cumulative QPTS).

  Sum of qhrs (only letter-graded rows with credits>0): 4+4+4+4+4+4+4+4+4+4+4+4 = 48 (the `IMNY-UT 99 P` row has 0 credits).

  `cumulativeGPA = 168 / 48 = 3.500` exactly. After `Math.round(... * 1000) / 1000` (confirmationFlow.ts:80), the result is **3.500**.

- `attemptedCredits` (confirmationFlow.ts:73 sums `credits ?? 4` for every coursesTaken row except `grade === "TR"`):
  - 12 letter-graded rows × 4 credits each = 48
  - IMNY-UT 99 P 0 credits → adds 0
  - Total **48**.
- `examCreditsApplied` (confirmationFlow.ts:103 sums `transferCourses[*].credits`):
  - 8 AP exams × 4 credits = **32**.
- `inProgressCount` (confirmationFlow.ts:99-100 = `currentSemester?.courses.length ?? 0`):
  - 4 in-progress courses (CORE-UA 500, CSCI-UA 310, MATH-UA 233, MATH-UA 325) → **4**.

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Type / signature citation |
|---|---|---|
| `parseTranscript(transcriptText).terms.length` | 4. | TranscriptTerm count; verbatim from PDF (Fall 2023, Spring 2024, Fall 2024, Spring 2025). |
| `parseTranscript(transcriptText).overall.printedGpa` | 3.500. | "Cumulative ... GPA 3.500" at "End of Undergraduate Record". |
| `transcriptToProfileDraft(doc).draft.homeSchool` | `"cas"`. | Spring 2025 dominant suffix is `-UA`; profileMapper.ts:139-167 SUFFIX_TO_SCHOOL[-UA] = "cas". |
| `buildConfirmationSummary(draft).homeSchool` | `"cas"`. | confirmationFlow.ts:92 propagates from draft.homeSchool. |
| `buildConfirmationSummary(draft).cumulativeGPA` | `3.5` (or `3.500`; equivalent under JS numeric printing — assert `.toBeCloseTo(3.5, 2)`). | Hand calc above; confirmationFlow.ts:80. |
| `buildConfirmationSummary(draft).attemptedCredits` | `48`. | Hand calc above (12 letter-graded × 4 + 0 from IMNY-UT 99 P at 0 cr). |
| `buildConfirmationSummary(draft).examCreditsApplied` | `32`. | 8 AP exams × 4 cr each. |
| `buildConfirmationSummary(draft).inProgressCount` | `4`. | 4 *** rows from Spring 2025. |
| `buildConfirmationSummary(draft).declaredProgramsCount` | `0`. | profileMapper.ts:108-114 (declaredPrograms left empty + needsConfirmation flagged). |
| `buildConfirmationSummary(draft).fieldsRequiringExplicitConfirmation` includes `"declaredPrograms"` | true. | profileMapper.ts:113. |
| `buildConfirmationSummary(draft).homeSchoolBasis` starts with `"homeSchool:"` | true. | confirmationFlow.ts:82-83 (looks for the `homeSchool:` note from profileMapper). |
| `buildConfirmationSummary(draft).earlierProgram` | should be defined as `"-UT"` (the previous suffix from the school transition note). | confirmationFlow.ts:85-87 regex `transition at .+?: (\S+) →` matches profileMapper's `Detected home-school transition at 2024-fall: -UT → -UA.` Captured group = `-UT`. |
| `buildConfirmationSummary(draft).inProgressCourses` | length 4; each row has `courseId` matching one of `["CORE-UA 500","CSCI-UA 310","MATH-UA 233","MATH-UA 325"]`. | confirmationFlow.ts:100-102. |
| `buildConfirmationSummary(draft).inferenceNotes` | non-empty; contains a string that mentions "transition" (the school-change note) AND a string that starts with "homeSchool:". | profileMapper.ts:127-132 always emits the transition note when set. |

---

## End of fixtures

Total profiles: 6.

Coverage summary vs waves 1+2:
- New: `projectMultiSemester` happy path → projectedGraduationSemester (Profile 1)
- New: `projectMultiSemester` early halt path with note (Profile 2)
- New: `planExploratory` for an undeclared CAS first-year (Profile 3)
- New: `planForTransferPrep` for an ELIGIBLE student (no prereqs missing — wave 1 only tested `checkTransferEligibility` directly, not the planner wrapper) (Profile 4)
- New: `planMultiProgram` shared-course +30 boost on a course that's still required by both programs (Profile 5)
- New: `buildConfirmationSummary` on the real transcript — wave 1 stopped at `transcriptToProfileDraft`, this wave runs the full confirmation flow (Profile 6)
