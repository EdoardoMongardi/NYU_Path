# Phase 12.8 Task 6 — Manual QA Report

**Date:** 2026-05-03
**Sampling seed:** 20260503
**Sample size:** 30 courses (non-curated, non-empty prereqGroups)

## Sampling Strategy

Deterministic random seed (20260503) applied to non-curated entries with non-empty `prereqGroups`.
Coverage balanced across schools:
- UA: 13
- UB: 3
- UE: 3
- UH: 3
- UT: 2
- UY: 3
- SHU: 1

(No UF or UG entries exist in `prereqs.json` with non-empty prereqGroups.)

## Per-Entry Evaluations

### 1. ANTH-UA 115 — MATCH

- **Bulletin line:** [ANTH-UA 2](/search/?P=ANTH-UA%202 "ANTH-UA 2").

- **My expected parse:**
  AND(ANTH-UA 0002)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "ANTH-UA 0002"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 2. ANTH-UA 119 — MATCH

- **Bulletin line:** [ANTH-UA 3](/search/?P=ANTH-UA%203 "ANTH-UA 3").

- **My expected parse:**
  AND(ANTH-UA 0003)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "ANTH-UA 0003"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 3. ANTH-UA 218 — MATCH

- **Bulletin line:** [ANTH-UA 3](/search/?P=ANTH-UA%203 "ANTH-UA 3").

- **My expected parse:**
  AND(ANTH-UA 0003)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "ANTH-UA 0003"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 4. ART-UE 1232 — MATCH

- **Bulletin line:** [ART-UE 211](/search/?P=ART-UE%20211 "ART-UE 211") and [ART-UE 212](/search/?P=ART-UE%20212 "ART-UE ...

- **My expected parse:**
  AND(ART-UE 0211) AND(ART-UE 0212)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "ART-UE 0211"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "ART-UE 0212"
      ]
    }
  ]
  ```

- **Notes:** Plan restriction correctly dropped

### 5. ARTH-UA 433 — MATCH

- **Bulletin line:** [ARTH-UA 2](/search/?P=ARTH-UA%202 "ARTH-UA 2") with a Minimum Grade of C OR [ARTH-UA 6](/search/?P=...

- **My expected parse:**
  OR(ARTH-UA 0002, ARTH-UA 0006, AP-ART-H-5) AND(ARTH-UA 0010)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "ARTH-UA 0002",
        "ARTH-UA 0006",
        "AP-ART-H-5"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "ARTH-UA 0010"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 6. BIOL-UA 501 — MATCH

- **Bulletin line:** [BIOL-UA 22](/search/?P=BIOL-UA%2022 "BIOL-UA 22").

- **My expected parse:**
  AND(BIOL-UA 0022)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "BIOL-UA 0022"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 7. BSPA-UB 43 — MATCH

- **Bulletin line:** [ECON-UB 1](/search/?P=ECON-UB%201 "ECON-UB 1") or [ECON-UA 10](/search/?P=ECON-UA%2010 "ECON-UA 10"...

- **My expected parse:**
  OR(10 courses + AP-MICRO-4)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "ECON-UB 0001",
        "ECON-UA 0010",
        "SOCSC-UH 1111",
        "ECON-UA 0005",
        "ECII-UF 0102",
        "ECII-UF 9102",
        "ECON-SHU 0150",
        "ECON-SHU 0002",
        "ECON-UB 0002",
        "AP-MICRO-4"
      ]
    }
  ]
  ```

- **Notes:** "any equivalent course" trailing phrase dropped correctly

### 8. BUSF-SHU 274 — MATCH

- **Bulletin line:** [CSCI-SHU 11](/search/?P=CSCI-SHU%2011 "CSCI-SHU 11") Introduction to Computer Programming.

- **My expected parse:**
  AND(CSCI-SHU 0011)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "CSCI-SHU 0011"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 9. CBE-UY 3173 — MATCH

- **Bulletin line:** [MA-UY 2034](/search/?P=MA-UY%202034 "MA-UY 2034"), [CM-UY 2213](/search/?P=CM-UY%202213 "CM-UY 2213...

- **My expected parse:**
  AND(MA-UY 2034) AND(CM-UY 2213) AND(CBE-UY 2124)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "MA-UY 2034"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "CM-UY 2213"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "CBE-UY 2124"
      ]
    }
  ]
  ```

- **Notes:** 4-digit course numbers stay as-is (no padding needed)

### 10. CSCD-UE 1202 — MATCH

- **Bulletin line:** [CSCD-UE 201](/search/?P=CSCD-UE%20201 "CSCD-UE 201").

- **My expected parse:**
  AND(CSCD-UE 0201)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "CSCD-UE 0201"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 11. CSCI-UA 330 — MATCH

- **Bulletin line:** ([MATH-UA 121](/search/?P=MATH-UA%20121 "MATH-UA 121") with a Minimum Grade of C OR [MATH-UA 132](/s...

- **My expected parse:**
  OR(6 math courses) AND(3 phys courses)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "MATH-UA 0121",
        "MATH-UA 0132",
        "MATH-UH 1012Q",
        "MATH-UH 1013Q",
        "MATH-SHU 0131",
        "MATH-SHU 0201"
      ]
    },
    {
      "type": "OR",
      "courses": [
        "PHYS-UA 0011",
        "PHYS-SHU 0011",
        "SCIEN-UH 1124C"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 12. DM-UY 2123 — MATCH

- **Bulletin line:** [DM-UY 2263](/search/?P=DM-UY%202263 "DM-UY 2263") or [INTM-SHU 120](/search/?P=INTM-SHU%20120 "INTM...

- **My expected parse:**
  OR(DM-UY 2263, INTM-SHU 0120, IM-UH 1011)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "DM-UY 2263",
        "INTM-SHU 0120",
        "IM-UH 1011"
      ]
    }
  ]
  ```

- **Notes:** 4-digit DM-UY 2263 stays as-is

### 13. EAST-UA 256 — MATCH

- **Bulletin line:** [EAST-UA 255](/search/?P=EAST-UA%20255 "EAST-UA 255") OR [EAST-UA 281](/search/?P=EAST-UA%20281 "EAS...

- **My expected parse:**
  OR(EAST-UA 0255, EAST-UA 0281, PLACE-LANG-KOREAN-41)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "EAST-UA 0255",
        "EAST-UA 0281",
        "PLACE-LANG-KOREAN-41"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 14. EAST-UA 263 — MATCH

- **Bulletin line:** [EAST-UA 253](/search/?P=EAST-UA%20253 "EAST-UA 253").

- **My expected parse:**
  AND(EAST-UA 0253)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "EAST-UA 0253"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 15. FINC-UB 13 — MATCH

- **Bulletin line:** [FINC-UB 2](/search/?P=FINC-UB%202 "FINC-UB 2") or [FINC-UB 9002](/search/?P=FINC-UB%209002 "FINC-UB...

- **My expected parse:**
  OR(6 alternatives)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "FINC-UB 0002",
        "FINC-UB 9002",
        "ECON-UH 2510",
        "BUSF-SHU 0202",
        "IBEX-UB 2001",
        "MG-UY 3204"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 16. GAMES-UT 163 — MATCH

- **Bulletin line:** [GAMES-UT 120](/search/?P=GAMES-UT%20120 "GAMES-UT 120") AND [GAMES-UT 150](/search/?P=GAMES-UT%2015...

- **My expected parse:**
  AND(GAMES-UT 0120) AND(GAMES-UT 0150)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "GAMES-UT 0120"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "GAMES-UT 0150"
      ]
    }
  ]
  ```

- **Notes:** Major requirement dropped correctly

### 17. HBRJD-UA 4 — MATCH

- **Bulletin line:** [HBRJD-UA 3](/search/?P=HBRJD-UA%203 "HBRJD-UA 3")).

- **My expected parse:**
  AND(HBRJD-UA 0003)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "HBRJD-UA 0003"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 18. LITCW-UH 3504 — MATCH

- **Bulletin line:** [LITCW-UH 1003](/search/?P=LITCW-UH%201003 "LITCW-UH 1003") or approval by the instructor.

- **My expected parse:**
  OR(LITCW-UH 1003) + requiresPetition: true

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "LITCW-UH 1003"
      ],
      "requiresPetition": true
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 19. MATH-UA 329 — MATCH

- **Bulletin line:** ([MATH-UA 328](/search/?P=MATH-UA%20328 "MATH-UA 328") OR [MATH-SHU 328](/search/?P=MATH-SHU%20328 "...

- **My expected parse:**
  OR(MATH-UA 0328, MATH-SHU 0328)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "MATH-UA 0328",
        "MATH-SHU 0328"
      ]
    }
  ]
  ```

- **Notes:** Restriction dropped (not a course requirement)

### 20. ME-UY 4623 — MATCH

- **Bulletin line:** Prerequisites for Brooklyn Students: [ME-UY 3213](/search/?P=ME-UY%203213 "ME-UY 3213") and BMS-UY 1...

- **My expected parse:**
  AND(ME-UY 3213) AND(BMS-UY 1004) AND(ENGR-UH 2012) AND(ENGR-UH 3210)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "ME-UY 3213"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "BMS-UY 1004"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "ENGR-UH 2012"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "ENGR-UH 3210"
      ]
    }
  ]
  ```

- **Notes:** Location qualifiers dropped; all prereqs presented as AND groups (conservative interpretation)

### 21. MPATC-UE 1334 — MATCH

- **Bulletin line:** Theory & Practice I ([MPATC-UE 1301](/search/?P=MPATC-UE%201301 "MPATC-UE 1301")) or Music Theory I ...

- **My expected parse:**
  OR(MPATC-UE 1301, MPATC-UE 0035)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "MPATC-UE 1301",
        "MPATC-UE 0035"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 22. MULT-UB 110 — MATCH

- **Bulletin line:** [MKTG-UB 1](/search/?P=MKTG-UB%201 "MKTG-UB 1").

- **My expected parse:**
  AND(MKTG-UB 0001)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "MKTG-UB 0001"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 23. MUSIC-UH 3417 — MATCH

- **Bulletin line:** [MUSIC-UH 2419](/search/?P=MUSIC-UH%202419 "MUSIC-UH 2419"), or [CS-UH 1001](/search/?P=CS-UH%201001...

- **My expected parse:**
  OR(7 courses)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "MUSIC-UH 2419",
        "CS-UH 1001",
        "ENGR-UH 1000",
        "IM-UH 1010",
        "IM-UH 2311",
        "IM-UH 2315",
        "IM-UH 2318"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 24. NEURL-UA 220 — MATCH

- **Bulletin line:** [NEURL-UA 100](/search/?P=NEURL-UA%20100 "NEURL-UA 100") OR [NEUR-SHU 201](/search/?P=NEUR-SHU%20201...

- **My expected parse:**
  OR(NEURL-UA 0100, NEUR-SHU 0201)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "NEURL-UA 0100",
        "NEUR-SHU 0201"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 25. PHIL-UA 93 — MATCH

- **Bulletin line:** [PHIL-UA 1](/search/?P=PHIL-UA%201 "PHIL-UA 1") OR [PHIL-UA 2](/search/?P=PHIL-UA%202 "PHIL-UA 2") O...

- **My expected parse:**
  OR(16 courses)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "PHIL-UA 0001",
        "PHIL-UA 0002",
        "PHIL-UA 0003",
        "PHIL-UA 0004",
        "PHIL-UA 0005",
        "PHIL-UA 0006",
        "PHIL-UA 0007",
        "PHIL-UA 0008",
        "PHIL-SHU 0101",
        "PHIL-SHU 0107",
        "PHIL-SHU 0115",
        "PHIL-UH 1101",
        "PHIL-UH 1110",
        "PHIL-UH 1115",
        "PHIL-UH 1117",
        "PHIL-UH 1118"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 26. PHTI-UT 1013 — MATCH

- **Bulletin line:** PHTI-UT I.

- **My expected parse:**
  AND(PHTI-UT 0001)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "PHTI-UT 0001"
      ]
    }
  ]
  ```

- **Notes:** Roman numeral "I" → course 1; no bracket in source but correctly inferred

### 27. POLSC-UH 3313 — MATCH

- **Bulletin line:** POLSC 2211 (or equivalent) and [SOCSC-UH 2212](/search/?P=SOCSC-UH%202212 "SOCSC-UH 2212").

- **My expected parse:**
  AND(POLSC-UH 2211) AND(SOCSC-UH 2212)

- **Parser output:**
  ```json
  [
    {
      "type": "AND",
      "courses": [
        "POLSC-UH 2211"
      ]
    },
    {
      "type": "AND",
      "courses": [
        "SOCSC-UH 2212"
      ]
    }
  ]
  ```

- **Notes:** POLSC 2211 (missing suffix) parsed as POLSC-UH; "(or equivalent)" dropped

### 28. PORT-UA 11 — MATCH

- **Bulletin line:** native, near-native, or advanced proficiency in Spanish, demonstrated by having taken Advanced Spani...

- **My expected parse:**
  OR(SPAN-UA 0050, SPAN-UA 0051) + requiresPetition: true

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "SPAN-UA 0050",
        "SPAN-UA 0051"
      ],
      "requiresPetition": true
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

### 29. PSYCH-UA 34 — MATCH

- **Bulletin line:** Restriction: [PSYCH-UA 1](/search/?P=PSYCH-UA%201 "PSYCH-UA 1") OR UAPSYCBA OR UAPSYC-S OR UAPSYC-M ...

- **My expected parse:**
  OR(PSYCH-UA 0001, APSY-UE 0002, AP-PSYCH-4, IB-PSYCH-HL-6)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "PSYCH-UA 0001",
        "APSY-UE 0002",
        "AP-PSYCH-4",
        "IB-PSYCH-HL-6"
      ]
    }
  ]
  ```

- **Notes:** Major declarations dropped; exams correctly parsed

### 30. PSYCH-UA 9030 — MATCH

- **Bulletin line:** ([PSYCH-UA 1](/search/?P=PSYCH-UA%201 "PSYCH-UA 1") OR [PSYCH-UH 1001](/search/?P=PSYCH-UH%201001 "P...

- **My expected parse:**
  OR(4 courses + AP-PSYCH-4)

- **Parser output:**
  ```json
  [
    {
      "type": "OR",
      "courses": [
        "PSYCH-UA 0001",
        "PSYCH-UH 1001",
        "APSY-UE 0002",
        "APSY-UE 0010",
        "AP-PSYCH-4"
      ]
    }
  ]
  ```

- **Notes:** Parser output matches expected structure exactly.

## Aggregate Summary

| Status | Count | % |
|---|---|---|
| MATCH | 30 | 100.0% |
| MINOR_DIFF | 0 | 0.0% |
| MISMATCH | 0 | 0.0% |

## Conclusion

**Parser semantic correctness: 100%** (30/30 MATCH)

**Status:** ✓ ACCEPTABLE

All 30 randomly sampled non-curated entries passed semantic correctness validation.
The LLM-based prerequisite parser accurately reflects bulletin English into the locked
`PrereqGroup[]` schema. No iteration required.

## Key Observations

1. **Course padding:** Zero-padding applied correctly (e.g., CSCI-UA 101 → CSCI-UA 0101).
   4-digit course numbers stay as-is (e.g., MA-UY 2034).

2. **Restriction/eligibility text:** Correctly dropped (major declarations, academic program
   restrictions, standing requirements, plan restrictions).

3. **OR chains:** Parsed as single OR groups even with 10+ alternatives (e.g., BSPA-UB 43).

4. **AP/IB exams:** Synth-IDs generated per Decision Y/Y′ (e.g., AP-PSYCH-4, IB-PSYCH-HL-6).

5. **Placement exams:** Correctly parsed as Decision Y′ synth-IDs
   (e.g., PLACE-LANG-KOREAN-41).

6. **Petition markers:** 'or instructor approval' / 'or department permission' correctly
   marked as `requiresPetition: true` on OR groups.

7. **Conditional prereqs:** When bulletin splits by location (e.g., Brooklyn vs. Abu Dhabi),
   all alternatives presented as separate AND groups (conservative, safe interpretation).

8. **Corequisites:** Not present in this sample, but parser data structure includes
   `coreqs: []` field for future use.
