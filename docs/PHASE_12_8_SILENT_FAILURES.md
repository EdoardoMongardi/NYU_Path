# Phase 12.8 Task 4b — Silent failures human review

After the third backfill pass (targeted against 30 hand-filtered hard cases + full 401-item run), **0 of 30** hand-filtered silent failures were fixed by the LLM. The full 401-item run fixed **152 of 401** overall, but the 30 hard cases remain empty despite containing course references in the bulletin Prerequisites lines.

## Summary
- **Total targets (hard 30):** 30
- **Fixed:** 0
- **Still failing:** 30

## Analysis
These 30 courses represent systematic parsing failures where the bulletin Prerequisites line contains course-shaped references (e.g., `[CHEM-UH 3012]`, `(CS-UY 2134 or [CS-UY 1134])`, or mixed admin + course text), but the LLM-based extractor fails to extract them. Common patterns:

1. **Coreq-only lines** — Prerequisites line is purely corequisite (e.g., `Corequisite: [CHEM-UH 3012]`) — parser correctly leaves `prereqGroups` empty, but human review needed to confirm coreqs are populated.
2. **Mixed admin + course refs** — Lines like `[CM-UY 4011] and senior status or adviser's approval` where admin conditions mix with course prerequisites.
3. **Unbracketed course refs** — Lines like `(CS-UY 2134 or [CS-UY 1134])` where some courses lack `[...]` brackets.
4. **Truncation edge case** — `PHIL-UH 3410` had an LLM response truncation error during the 401-item run.

## Human review needed
Each entry below requires one of three actions:
1. **Hand-curate** — Read the bulletin and populate `prereqGroups` manually.
2. **Confirm parser is correct** — Verify the line is coreq-only or eligibility-only (no real prereq).
3. **Report parser bug** — Flag for systematic prompt improvement in Phase 12.8 Task 5.

---

### ACE-UE 110
**Bulletin prereq line:** `[EXPOS-UA 1](/search/?P=EXPOS-UA%201 "EXPOS-UA 1") OR [EXPOS-UA 5](/search/?P=EXPOS-UA%205 "EXPOS-UA 5") OR [EXPOS-UA 4](/search/?P=EXPOS-UA%204 "EXPOS-UA 4")&9 and must be in Steinhardt, Nursing or Social Work.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### AE-UY 4653
**Bulletin prereq line:** `[ME-UY 2223](/search/?P=ME-UY%202223 "ME-UY 2223") with a Minimum Grade of D.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### BMS-UY 4924
**Bulletin prereq line:** `[CM-UY 4011](/search/?P=CM-UY%204011 "CM-UY 4011") and senior status or adviser’s approval.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### CAM-UY 4504
**Bulletin prereq line:** `[EXPOS-UA 1](/search/?P=EXPOS-UA%201 "EXPOS-UA 1"), [EXPOS-UA 4](/search/?P=EXPOS-UA%204 "EXPOS-UA 4"), [EXPOS-UA 5](/search/?P=EXPOS-UA%205 "EXPOS-UA 5"), [EXPOS-UA 9](/search/?P=EXPOS-UA%209 "EXPOS-UA 9"), [ASPP-UT 2](/search/?P=ASPP-UT%202 "ASPP-UT 2"), [WREX-UF 101](/search/?P=WREX-UF%20101 "WREX-UF 101") or [WRCI-UF 102](/search/?P=WRCI-UF%20102 "WRCI-UF 102") and Junior/Senior standing.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### CBE-UY 4263
**Bulletin prereq line:** `[CBE-UY 4163](/search/?P=CBE-UY%204163 "CBE-UY 4163") with a Minimum Grade of D AND [CBE-UY 4143](/search/?P=CBE-UY%204143 "CBE-UY 4143") with a Minimum Grade of D.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### CHEM-UH 3011
**Bulletin prereq line:** `Foundations of Science 1-6 Corequisite: [CHEM-UH 3012](/search/?P=CHEM-UH%203012 "CHEM-UH 3012").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `["CHEM-UH 3012"]`

### CHEM-UH 3013
**Bulletin prereq line:** `Foundations of Science 1-6 Corequisite: [CHEM-UH 3014](/search/?P=CHEM-UH%203014 "CHEM-UH 3014").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `["CHEM-UH 3014"]`

### CHEM-UH 3016
**Bulletin prereq line:** `Foundations of Science 1-4 Pre- or Corequisite: [CHEM-UH 2010](/search/?P=CHEM-UH%202010 "CHEM-UH 2010").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `["CHEM-UH 2010"]`

### CM-UY 1001
**Bulletin prereq line:** `Co-requisites: [CM-UY 1003](/search/?P=CM-UY%201003 "CM-UY 1003").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `["CM-UY 1003"]`

### CM-UY 1011
**Bulletin prereq line:** `Co-requisites: [CM-UY 1013](/search/?P=CM-UY%201013 "CM-UY 1013").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `["CM-UY 1013"]`

### CS-UY 1113
**Bulletin prereq line:** `Co-requisite: EX-UY 1;.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `["EX-UY 0001"]`

### CS-UY 4793G
**Bulletin prereq line:** `(CS-UY 2134 or [CS-UY 1134](/search/?P=CS-UY%201134 "CS-UY 1134")) and ([CS-UY 2124](/search/?P=CS-UY%202124 "CS-UY 2124") or CS-UY 1124) (C- or better).`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### CSCI-UA 9480
**Bulletin prereq line:** `([CSCI-UA 201](/search/?P=CSCI-UA%20201 "CSCI-UA 201") OR [CSCI-SHU 311](/search/?P=CSCI-SHU%20311 "CSCI-SHU 311") OR [CS-UH 2010](/search/?P=CS-UH%202010 "CS-UH 2010") OR [CS-UY 2214](/search/?P=CS-UY%202214 "CS-UY 2214")).`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### DS-UA 9201
**Bulletin prereq line:** `[DS-UA 112](/search/?P=DS-UA%20112 "DS-UA 112").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### ECON-UA 9316
**Bulletin prereq line:** `([ECON-UA 10](/search/?P=ECON-UA%2010 "ECON-UA 10") OR [ECON-UA 11](/search/?P=ECON-UA%2011 "ECON-UA 11")).`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### EN-UY 3814W
**Bulletin prereq line:** `[EXPOS-UA 1](/search/?P=EXPOS-UA%201 "EXPOS-UA 1") or [EXPOS-UA 4](/search/?P=EXPOS-UA%204 "EXPOS-UA 4").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### FIN-UY 4903
**Bulletin prereq line:** `[FIN-UY 2003](/search/?P=FIN-UY%202003 "FIN-UY 2003") with a Minimum Grade of D AND [FIN-UY 2103](/search/?P=FIN-UY%202103 "FIN-UY 2103") with a Minimum Grade of D AND [FIN-UY 2203](/search/?P=FIN-UY%202203 "FIN-UY 2203") with a Minimum Grade of D.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### FMTV-UT 1777
**Bulletin prereq line:** `One Intermediate level production course and [FMTV-UT 101](/search/?P=FMTV-UT%20101 "FMTV-UT 101") and Plan = Film and Television or Dual Degree Stern/Tisch.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### HI-UY 3144
**Bulletin prereq line:** `[EXPOS-UA 1](/search/?P=EXPOS-UA%201 "EXPOS-UA 1").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### MA-UY 914
**Bulletin prereq line:** `placement exam.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `["EX-UY 0001"]`

### MD-UY 2314G
**Bulletin prereq line:** `EXPOS-UA 2, [EXPOS-UA 9](/search/?P=EXPOS-UA%209 "EXPOS-UA 9"), [EXPOS-UA 22](/search/?P=EXPOS-UA%2022 "EXPOS-UA 22"), [ASPP-UT 2](/search/?P=ASPP-UT%202 "ASPP-UT 2") or [WRCI-UF 102](/search/?P=WRCI-UF%20102 "WRCI-UF 102").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### MPAJZ-UE 1119
**Bulletin prereq line:** `[MPAJZ-UE 1039](/search/?P=MPAJZ-UE%201039 "MPAJZ-UE 1039") and [MPAJZ-UE 1040](/search/?P=MPAJZ-UE%201040 "MPAJZ-UE 1040") Restriction: MPAP Plan Codes.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### MPATC-UE 9343
**Bulletin prereq line:** `MPATC-UE 1301Music or [MPATC-UE 35](/search/?P=MPATC-UE%2035 "MPATC-UE 35") and CO-REQ [MPATC-UE 9331](/search/?P=MPATC-UE%209331 "MPATC-UE 9331").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### PHIL-UA 9085
**Bulletin prereq line:** `([PHIL-UA 1](/search/?P=PHIL-UA%201 "PHIL-UA 1") OR [PHIL-UA 2](/search/?P=PHIL-UA%202 "PHIL-UA 2") OR [PHIL-UA 3](/search/?P=PHIL-UA%203 "PHIL-UA 3") OR [PHIL-UA 4](/search/?P=PHIL-UA%204 "PHIL-UA 4") OR [PHIL-UA 5](/search/?P=PHIL-UA%205 "PHIL-UA 5") OR [PHIL-UA 6](/search/?P=PHIL-UA%206 "PHIL-UA 6") OR [PHIL-UA 7](/search/?P=PHIL-UA%207 "PHIL-UA 7") OR [PHIL-UA 8](/search/?P=PHIL-UA%208 "PHIL-U`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### PHIL-UH 3410
**Bulletin prereq line:** `(N/A)`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### PHYS-UA 9012
**Bulletin prereq line:** `([PHYS-UA 11](/search/?P=PHYS-UA%2011 "PHYS-UA 11") with a Minimum Grade of C- OR [PHYS-UA 9011](/search/?P=PHYS-UA%209011 "PHYS-UA 9011") with a Minimum Grade of C-).`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### PSYCH-UA 9051
**Bulletin prereq line:** `([PSYCH-UA 30](/search/?P=PSYCH-UA%2030 "PSYCH-UA 30") OR [PSYCH-UA 9030](/search/?P=PSYCH-UA%209030 "PSYCH-UA 9030") OR [PSYCH-UA 32](/search/?P=PSYCH-UA%2032 "PSYCH-UA 32") OR [PSYCH-UA 9032](/search/?P=PSYCH-UA%209032 "PSYCH-UA 9032") OR [PSYCH-UA 34](/search/?P=PSYCH-UA%2034 "PSYCH-UA 34") OR [PSYCH-UA 9034](/search/?P=PSYCH-UA%209034 "PSYCH-UA 9034") OR [APSY-UE 10](/search/?P=APSY-UE%2010 "A`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### STS-UY 4504
**Bulletin prereq line:** `[EXPOS-UA 1](/search/?P=EXPOS-UA%201 "EXPOS-UA 1"), [EXPOS-UA 4](/search/?P=EXPOS-UA%204 "EXPOS-UA 4"), [EXPOS-UA 5](/search/?P=EXPOS-UA%205 "EXPOS-UA 5"), [EXPOS-UA 9](/search/?P=EXPOS-UA%209 "EXPOS-UA 9"), [ASPP-UT 2](/search/?P=ASPP-UT%202 "ASPP-UT 2"), [WREX-UF 101](/search/?P=WREX-UF%20101 "WREX-UF 101") or [WRCI-UF 102](/search/?P=WRCI-UF%20102 "WRCI-UF 102") and Junior/Senior standing.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### URB-UY 4504
**Bulletin prereq line:** `[EXPOS-UA 1](/search/?P=EXPOS-UA%201 "EXPOS-UA 1"), [EXPOS-UA 4](/search/?P=EXPOS-UA%204 "EXPOS-UA 4"), [EXPOS-UA 5](/search/?P=EXPOS-UA%205 "EXPOS-UA 5"), [EXPOS-UA 9](/search/?P=EXPOS-UA%209 "EXPOS-UA 9"), [ASPP-UT 2](/search/?P=ASPP-UT%202 "ASPP-UT 2"), [WREX-UF 101](/search/?P=WREX-UF%20101 "WREX-UF 101") or [WRCI-UF 102](/search/?P=WRCI-UF%20102 "WRCI-UF 102") and Junior/Senior standing.`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`

### URBS-UA 301
**Bulletin prereq line:** `[URBS-UA 102](/search/?P=URBS-UA%20102 "URBS-UA 102").`

**Parser output:**
- `prereqGroups`: `[]`
- `coreqs`: `[]`
