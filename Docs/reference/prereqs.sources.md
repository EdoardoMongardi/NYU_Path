# Curation Sources & Audit Log for prereqs.json

## Phase 12.8 Task 4 Pre-Validation (2026-05-02)

Smoke test (5 courses) caught MGMT-UB 2 had 3 missing courses. The curation subagent's "strict-bracket only" rule had dropped real unbracketed course mentions. Pre-validation pass ran the LLM extractor against all 16 curated entries and surfaced mismatches. All discrepancies have been re-verified against bulletin _index.md sources and corrected below.

**Per-entry fix log:**

### CSCI-UA 101
**Status:** MATCH (no changes)
Source: data/bulletin-raw/courses/csci_ua/_index.md, line 95

### CSCI-UA 421
**Status:** MATCH (no changes to content; known parser bug: LLM parsed as single OR group instead of three AND, but curated structure is correct)
Source: data/bulletin-raw/courses/csci_ua/_index.md, line 189
Note: Parser misread "X AND Y AND Z OR any equivalent" as all-OR. Curated correctly captures required AND structure.

### CSCI-UA 310
**Status:** MATCH (no changes)
Source: data/bulletin-raw/courses/csci_ua/_index.md, line 165

### MATH-UA 122
**Status:** FIXED — added PLACE-MATH-PLCM2-100 (Decision Y′ canonical form)
Bulletin line 58: "Minimum grade of C in [MATH-UA 121] or (minimum AP Calculus AB or BC score of 4) or MATH\_PLCM2 score of 100."
Curated was missing the placement exam clause due to strict-bracket-only rule. Synth-ID schema per Decision Y′ (operator-confirmed): `PLACE-MATH-<LEVEL>-<SCORE>`.

### MATH-UA 123
**Status:** FIXED — added PLACE-MATH-PLCM3-100 (Decision Y′ canonical form)
Bulletin line 70: "Minimum grade of C in [MATH-UA 122] or AP Calculus BC score of 5 or MATH\_PLCM3 score of 100."
Curated was missing the placement exam clause due to strict-bracket-only rule. Synth-ID schema per Decision Y′ (operator-confirmed): `PLACE-MATH-<LEVEL>-<SCORE>`.

### MGMT-UB 2
**STATUS:** FIXED — added ECON-UA 0005, ECON-SHU 0002, ECON-SHU 0150
Bulletin line 35: "[ECON-UB 1] OR [ECON-UB 2] OR [ECON-UA 2] OR ECON-UA 5 OR [ECON-UA 10] OR [ECII-UF 102] OR [ECON-UH 2010] OR ECON-SHU 2 OR ECON-SHU 150 OR [ECON-SHU 3]"
Curated was missing ECON-UA 5 (now 0005), ECON-SHU 2 (now 0002), ECON-SHU 150 (now 0150) due to strict-bracket-only rule.

### MKTG-UB 54
**STATUS:** FIXED — added ECON-UA 0380, SOCSC-AD 110Q, SOCSC-AD 113Q
Bulletin line 298: "[STAT-UB 103] (or [STAT-UB 3] OR SOCSC-AD 110Q OR SOCSC-AD 113Q OR [BUSF-SHU 101] OR [ECON-UA 20] OR [ECON-UA 266] OR ECON-UA 380)."
Curated was missing SOCSC-AD 110Q, SOCSC-AD 113Q, ECON-UA 380 due to strict-bracket-only rule.

### CS-UY 1121
**Status:** MATCH (no changes)
Source: data/bulletin-raw/courses/cs_uy/_index.md, line 50

### CS-UY 1134
**Status:** MATCH (no changes)
Source: data/bulletin-raw/courses/cs_uy/_index.md, line 108

### MPATC-UE 9322
**Status:** FIXED — cleared coreqs field
Bulletin line 905: "[MPATC-UE 1302] and Corequisite [MPATC-UE 9312]."
Parser spec requires coreqs: [] (Phase 14 populates). Curated incorrectly had coreqs: ["MPATC-UE 9312"]. Corrected to empty array per schema.

### PHTI-UT 1014
**Status:** MATCH (no changes)
Bulletin line 131: "[PHTI-UT 1] AND [PHTI-UT 2]."
Note: Parser incorrectly combined into single AND group [PHTI-UT 0001, PHTI-UT 0002] instead of two separate AND groups. Curated structure (two separate AND) is correct per schema.
Source: data/bulletin-raw/courses/phti_ut/_index.md, line 131

### IDSEM-UG 1843
**Status:** MATCH (no changes)
Source: data/bulletin-raw/courses/idsem_ug/_index.md, line 1543

### CSCI-SHU 2314
**Status:** MATCH (no changes)
Source: data/bulletin-raw/courses/csci_shu/_index.md

### CS-UH 3090
**STATUS:** FIXED — added OR group for MATH-UH 1013Q
Bulletin line 329: "[CS-UH 1052] and [CS-UH 2010] and ([MATH-UH 1012Q] or MATH 1013Q)."
Curated was missing OR alternative (MATH-UH 1013Q) and had incorrect structure (three separate AND groups). 
Corrected to: AND CS-UH 1052, AND CS-UH 2010, OR [MATH-UH 1012Q, MATH-UH 1013Q].

### MATH-UA 121
**Status:** MATCH (no changes)
Source: data/bulletin-raw/courses/math_ua/_index.md, line 33

### ACCT-UB 1
**Status:** MATCH (no changes)
Source: data/bulletin-raw/courses/acct_ub/_index.md, line 19

---

## Validation Results Summary

- **Total entries validated:** 16
- **Matches:** 8
- **Mismatches (fixed):** 7 (MATH-UA 122, MATH-UA 123, MGMT-UB 2, MKTG-UB 54, MPATC-UE 9322, CS-UH 3090)
- **Parser bugs identified (not fixed in curated):** 2 (CSCI-UA 421 AND/OR parsing, PHTI-UT 1014 AND group consolidation)

All bulletin source references verified against `/Users/edoardomongardi/Desktop/Ideas/NYU Path/data/bulletin-raw/courses/*/\_index.md`.

---

## Phase 12.8 Silent-Failure Hand-Curation (2026-05-03)

The 29 silent-failure entries documented in `docs/PHASE_12_8_DATA_ISSUES.md` were hand-translated from bulletin source. Pure manual translation, no LLM calls. Schema decisions A, P, Y, Y′ enforced. Below: per-entry citation + 1-line justification of any non-obvious choice.

### ACE-UE 110
Source: `data/bulletin-raw/courses/ace_ue/_index.md`
Bulletin: `[EXPOS-UA 1] OR [EXPOS-UA 5] OR [EXPOS-UA 4]&9 and must be in Steinhardt, Nursing or Social Work.`
Hand-fix: 3-way OR group {EXPOS-UA 0001, 0005, 0004}. Dropped "must be in [school]" eligibility per Decision rule. Treated trailing "&9" fragment as a corrupt encoding artifact (likely orphaned `&` glyph) — kept the conservative 3-course reading rather than inventing a 4th.

### AE-UY 4653
Source: `data/bulletin-raw/courses/ae_uy/_index.md`
Bulletin: `[ME-UY 2223] with a Minimum Grade of D.`
Hand-fix: Single AND group {ME-UY 2223}. Grade threshold dropped (Phase 13 trusts DPR). ME-UY 2223 ≥ 1000 → not zero-padded.

### BMS-UY 4924
Source: `data/bulletin-raw/courses/bms_uy/_index.md`
Bulletin: `[CM-UY 4011] and senior status or adviser's approval.`
Hand-fix: AND group {CM-UY 4011} with `requiresPetition: true`. Treated 'or adviser's approval' as `requiresPetition: true` rather than dropping it entirely, because the bulletin frames it as an alternative path; consistent with Decision #3 middle-path soft-allow. Senior-standing eligibility dropped.

### CAM-UY 4504
Source: `data/bulletin-raw/courses/cam_uy/_index.md`
Bulletin (course-description Prerequisite line, more disambiguated than the structured **Prerequisites:** line): `Prerequisite: ([EXPOS-UA 1], [EXPOS-UA 4], [EXPOS-UA 5], [EXPOS-UA 9], [ASPP-UT 2], [WREX-UF 101] or [WRCI-UF 102]) and one TCS elective course and Junior/Senior standing.`
Hand-fix: Single 7-way OR group of writing/communication courses. The doc's suggested "5 AND + OR" reading was rejected after re-reading the parenthesized list — it's a single OR-of-7. Trailing "TCS elective" descriptor and "Junior/Senior standing" eligibility dropped.

### CBE-UY 4263
Source: `data/bulletin-raw/courses/cbe_uy/_index.md`
Bulletin: `[CBE-UY 4163] with a Minimum Grade of D AND [CBE-UY 4143] with a Minimum Grade of D.`
Hand-fix: Two separate AND groups (per "Multiple top-level AND clauses become separate AND groups"). Grades dropped. Both ≥ 1000 → not zero-padded.

### CHEM-UH 3011
Source: `data/bulletin-raw/courses/chem_uh/_index.md`
Bulletin: `Foundations of Science 1-6 Corequisite: [CHEM-UH 3012].`
Hand-fix: `prereqGroups: []`, `coreqs: ["CHEM-UH 3012"]`. "Foundations of Science 1-6" is a non-course descriptor (dropped). The bulletin literally provides only a coreq — confirmed-correct.

### CHEM-UH 3013
Source: `data/bulletin-raw/courses/chem_uh/_index.md`
Bulletin: `Foundations of Science 1-6 Corequisite: [CHEM-UH 3014].`
Hand-fix: `prereqGroups: []`, `coreqs: ["CHEM-UH 3014"]`. Same pattern as CHEM-UH 3011.

### CHEM-UH 3016
Source: `data/bulletin-raw/courses/chem_uh/_index.md`
Bulletin: `Foundations of Science 1-4 Pre- or Corequisite: [CHEM-UH 2010].`
Hand-fix: `prereqGroups: []`, `coreqs: ["CHEM-UH 2010"]`. "Pre- or Corequisite" is OR-of-types: conservative encoding places the reference in coreqs (per Decision P, coreqs at entry level only). Not duplicated as a prereq.

### CM-UY 1001
Source: `data/bulletin-raw/courses/cm_uy/_index.md`
Bulletin: `Co-requisites: [CM-UY 1003].`
Hand-fix: `prereqGroups: []`, `coreqs: ["CM-UY 1003"]`. Pure coreq.

### CM-UY 1011
Source: `data/bulletin-raw/courses/cm_uy/_index.md`
Bulletin: `Co-requisites: [CM-UY 1013].`
Hand-fix: `prereqGroups: []`, `coreqs: ["CM-UY 1013"]`. Pure coreq.

### CS-UY 1113
Source: `data/bulletin-raw/courses/cs_uy/_index.md`
Bulletin: `Co-requisite: EX-UY 1;.`
Hand-fix: `prereqGroups: []`, `coreqs: ["EX-UY 0001"]`. Pure coreq. EX-UY 1 zero-padded to EX-UY 0001 per Decision A.

### CS-UY 4793G
Source: `data/bulletin-raw/courses/cs_uy/_index.md`
Bulletin: `(CS-UY 2134 or [CS-UY 1134]) and ([CS-UY 2124] or CS-UY 1124) (C- or better).`
Hand-fix: Two AND-connected OR groups: {CS-UY 2134, CS-UY 1134} and {CS-UY 2124, CS-UY 1124}. Unbracketed CS-UY 2134 / CS-UY 1124 ARE real courses (per Decision rule overruling strict-bracket-only). All ≥ 1000 → not zero-padded. Grade threshold dropped.

### CSCI-UA 9480
Source: `data/bulletin-raw/courses/csci_ua/_index.md`
Bulletin: `([CSCI-UA 201] OR [CSCI-SHU 311] OR [CS-UH 2010] OR [CS-UY 2214]).`
Hand-fix: Single 4-way OR group. CSCI-UA 0201 + CSCI-SHU 0311 zero-padded; CS-UH 2010 + CS-UY 2214 ≥ 1000 → not padded.

### DS-UA 9201
Source: `data/bulletin-raw/courses/ds_ua/_index.md`
Bulletin: `[DS-UA 112].`
Hand-fix: Single AND group {DS-UA 0112}.

### ECON-UA 9316
Source: `data/bulletin-raw/courses/econ_ua/_index.md`
Bulletin: `([ECON-UA 10] OR [ECON-UA 11]).`
Hand-fix: Single OR group {ECON-UA 0010, ECON-UA 0011}.

### EN-UY 3814W
Source: `data/bulletin-raw/courses/en_uy/_index.md`
Bulletin: `[EXPOS-UA 1] or [EXPOS-UA 4].`
Hand-fix: Single OR group {EXPOS-UA 0001, EXPOS-UA 0004}.

### FIN-UY 4903
Source: `data/bulletin-raw/courses/fin_uy/_index.md`
Bulletin: `[FIN-UY 2003] AND [FIN-UY 2103] AND [FIN-UY 2203]` (with grade thresholds, dropped).
Hand-fix: Three separate AND groups (per "Multiple top-level AND clauses"). All ≥ 1000 → not padded.

### FMTV-UT 1777
Source: `data/bulletin-raw/courses/fmtv_ut/_index.md`
Bulletin: `One Intermediate level production course and [FMTV-UT 101] and Plan = Film and Television or Dual Degree Stern/Tisch.`
Hand-fix: Single AND group {FMTV-UT 0101}. "Intermediate level production course" is a non-course descriptor (dropped). "Plan = ..." is eligibility (dropped).

### HI-UY 3144
Source: `data/bulletin-raw/courses/hi_uy/_index.md`
Bulletin: `[EXPOS-UA 1].`
Hand-fix: Single AND group {EXPOS-UA 0001}.

### MA-UY 914
Source: `data/bulletin-raw/courses/ma_uy/_index.md`
Bulletin Prerequisites: `placement exam.` Bulletin Coreqs: `EX-UY 1.`
Hand-fix: `prereqGroups: []` (vague "placement exam" without level/score is unparseable per Decision Y′ — no fallback). `coreqs: ["EX-UY 0001"]` from the standalone Coreq line. NOT a synthetic PLACE-MATH-* (locked invariant: no generic placement token).

### MD-UY 2314G
Source: `data/bulletin-raw/courses/md_uy/_index.md`
Bulletin: `EXPOS-UA 2, [EXPOS-UA 9], [EXPOS-UA 22], [ASPP-UT 2] or [WRCI-UF 102].`
Hand-fix: Single 5-way OR group. Unbracketed EXPOS-UA 2 ARE real (per Decision rule). All zero-padded.

### MPAJZ-UE 1119
Source: `data/bulletin-raw/courses/mpajz_ue/_index.md`
Bulletin: `[MPAJZ-UE 1039] and [MPAJZ-UE 1040] Restriction: MPAP Plan Codes.`
Hand-fix: Two separate AND groups. Plan-code restriction dropped. Both ≥ 1000 → not padded.

### MPATC-UE 9343
Source: `data/bulletin-raw/courses/mpatc_ue/_index.md`
Bulletin: `MPATC-UE 1301Music or [MPATC-UE 35] and CO-REQ [MPATC-UE 9331].`
Hand-fix: OR group {MPATC-UE 1301, MPATC-UE 0035}; coreq MPATC-UE 9331. The "1301Music" is a bulletin spacing typo — the course is MPATC-UE 1301 (≥ 1000 → not padded), "Music" is the title text.

### PHIL-UA 9085
Source: `data/bulletin-raw/courses/phil_ua/_index.md`
Bulletin: `([PHIL-UA 1] OR [PHIL-UA 2] OR ... OR [PHIL-UA 8] OR equivalents) AND [PHIL-UA 70] OR [PHIL-SHU 70] OR [MATH-UA 120].`
Hand-fix: Two AND-connected OR groups: {PHIL-UA 0001..0008} (with `requiresPetition: true` for "OR equivalents" soft-allow) and {PHIL-UA 0070, PHIL-SHU 0070, MATH-UA 0120}. The "OR equivalents" trailing modifier on the first group is treated as a soft-allow signal (per the rule about "or instructor permission / department approval / adviser's approval" — same spirit, less strict than naming a specific permission); the solver allows placement, UI flags petition. Standard intro-philosophy + symbolic-logic prereq pattern.

### PHIL-UH 3410
Source: `data/bulletin-raw/courses/phil_uh/_index.md` (verified — the doc's claim of "missing entirely from dataset" was wrong)
Bulletin: `one History of Philosophy, Theoretical Philosophy, or Practical Philosophy electives (PHIL-UH 2200-2799).`
Hand-fix: NOT ADDED to prereqs.json. The bulletin Prerequisites line is purely a wildcard course range (PHIL-UH 2200-2799), which per the rules is dropped. No concrete course refs to encode. Course is absent from the JSON; if a future phase populates it, expect `prereqGroups: []`, `coreqs: []`.

### PHYS-UA 9012
Source: `data/bulletin-raw/courses/phys_ua/_index.md`
Bulletin: `([PHYS-UA 11] with Min Grade C- OR [PHYS-UA 9011] with Min Grade C-).`
Hand-fix: Single OR group {PHYS-UA 0011, PHYS-UA 9011}. Grades dropped.

### PSYCH-UA 9051
Source: `data/bulletin-raw/courses/psych_ua/_index.md`
Bulletin: `([PSYCH-UA 30] OR [PSYCH-UA 9030] OR [PSYCH-UA 32] OR [PSYCH-UA 9032] OR [PSYCH-UA 34] OR [PSYCH-UA 9034] OR [APSY-UE 10]).`
Hand-fix: Single 7-way OR group. PSYCH-UA 30/32/34 and APSY-UE 10 zero-padded; the 9000-series stays.

### STS-UY 4504
Source: `data/bulletin-raw/courses/sts_uy/_index.md`
Bulletin: same template as CAM-UY 4504 (the bulletin chunk is shared boilerplate across the TCS Advanced Seminars).
Hand-fix: Single 7-way OR group identical to CAM-UY 4504.

### URB-UY 4504
Source: `data/bulletin-raw/courses/urb_uy/_index.md`
Bulletin: same template as CAM-UY 4504.
Hand-fix: Single 7-way OR group identical to CAM-UY 4504.

### URBS-UA 301
Source: `data/bulletin-raw/courses/urbs_ua/_index.md`
Bulletin: `[URBS-UA 102].`
Hand-fix: Single AND group {URBS-UA 0102}.

---

### Detector residuals (false positives — bulletin Prerequisites line only contains a coreq/vague reference)

The `Real silent failures remaining` detector in the workflow flags 7 entries because their bulletin Prerequisites lines syntactically contain a course reference. All 7 are correctly handled — the reference is a coreq or an unparseable placement-exam mention. These are the entries already documented as "CONFIRM-ONLY" in PHASE_12_8_DATA_ISSUES.md (now resolved):

- CHEM-UH 3011, 3013, 3016: prereq line is "Foundations of Science X-Y Corequisite: [Z]" → only a coreq (placed at entry level).
- CM-UY 1001, 1011: "Co-requisites: [Z]" → only a coreq.
- CS-UY 1113: "Co-requisite: EX-UY 1;." → only a coreq.
- MA-UY 914: "placement exam." (no level/score) → unparseable per Decision Y′; coreq from a separate bulletin field.

Per the schema rules, all 7 are correctly empty in `prereqGroups`. The detector is a syntactic guard, not a semantic one.

