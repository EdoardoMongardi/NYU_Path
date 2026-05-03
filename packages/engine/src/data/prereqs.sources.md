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
**Status:** FIXED — added MATH-PLCM2-100
Bulletin line 58: "Minimum grade of C in [MATH-UA 121] or (minimum AP Calculus AB or BC score of 4) or MATH\_PLCM2 score of 100."
Curated was missing MATH-PLCM2-100 due to strict-bracket-only rule applied to placement exam placeholder.

### MATH-UA 123
**Status:** FIXED — added MATH-PLCM3-100
Bulletin line 70: "Minimum grade of C in [MATH-UA 122] or AP Calculus BC score of 5 or MATH\_PLCM3 score of 100."
Curated was missing MATH-PLCM3-100 due to strict-bracket-only rule.

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
