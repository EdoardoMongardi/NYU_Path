# Curated prereqs ground truth — bulletin sources

This file is the per-entry citation map for `prereqs.json`. Each line records
which bulletin section was hand-read on the verification date below; future
drift detection (Phase 12.8 Task 5) compares the live bulletin against the
JSON entries and flags divergences.

Verification date: 2026-05-02
Bulletin scrape: `data/bulletin-raw/courses/<dept>/_index.md`
  (scraped_at headers in each `_index.md`; most files dated 2026-04-21)

## Entries

- CSCI-UA 101 — data/bulletin-raw/courses/csci_ua/_index.md (verified 2026-05-02)
- CSCI-UA 421 — data/bulletin-raw/courses/csci_ua/_index.md (verified 2026-05-02)
- CSCI-UA 310 — data/bulletin-raw/courses/csci_ua/_index.md (verified 2026-05-02)
- MATH-UA 122 — data/bulletin-raw/courses/math_ua/_index.md (verified 2026-05-02)
- MATH-UA 123 — data/bulletin-raw/courses/math_ua/_index.md (verified 2026-05-02)
- MGMT-UB 2 — data/bulletin-raw/courses/mgmt_ub/_index.md (verified 2026-05-02)
- MKTG-UB 54 — data/bulletin-raw/courses/mktg_ub/_index.md (verified 2026-05-02)
- CS-UY 1121 — data/bulletin-raw/courses/cs_uy/_index.md (verified 2026-05-02)
- CS-UY 1134 — data/bulletin-raw/courses/cs_uy/_index.md (verified 2026-05-02)
- MPATC-UE 9322 — data/bulletin-raw/courses/mpatc_ue/_index.md (verified 2026-05-02)
- PHTI-UT 1014 — data/bulletin-raw/courses/phti_ut/_index.md (verified 2026-05-02)
- IDSEM-UG 1843 — data/bulletin-raw/courses/idsem_ug/_index.md (verified 2026-05-02)
- CSCI-SHU 2314 — data/bulletin-raw/courses/csci_shu/_index.md (verified 2026-05-02)
- CS-UH 3090 — data/bulletin-raw/courses/cs_uh/_index.md (verified 2026-05-02)
- MATH-UA 121 — data/bulletin-raw/courses/math_ua/_index.md (verified 2026-05-02; no `**Prerequisites:**` line in section)
- ACCT-UB 1 — data/bulletin-raw/courses/acct_ub/_index.md (verified 2026-05-02; no `**Prerequisites:**` line in section)

## Coverage summary

| Bucket | Entries | Notes |
|---|---|---|
| CSCI-UA (CAS, diverse complexity) | 3 | 101 (multi-AP OR), 421 (3-course AND chain), 310 (deep AND/AND/(OR)) |
| MATH-UA (CAS, sequence chains) | 2 | 122 → 121 (OR with two AP scores), 123 → 122 (OR with one AP score) |
| STERN-UB | 2 | MGMT-UB 2 (cross-CAS OR + NOT), MKTG-UB 54 (cross-CAS OR) |
| TANDON CS-UY | 2 | 1121 (simple AND single course), 1134 (cross-school multi-campus OR) |
| STEINHARDT-UE | 1 | MPATC-UE 9322 (AND with bracketed coreq) |
| TISCH-UT | 1 | PHTI-UT 1014 (two-AND chain) |
| GALLATIN | 1 | IDSEM-UG 1843 — bulletin uses `_ug` suffix for Gallatin (not `_uf`); `_uf` files (Liberal Studies) contain zero `**Prerequisites:**` lines |
| SHANGHAI-SHU | 1 | CSCI-SHU 2314 (cross-dept OR; only 2 SHU prereqs in the bulletin and this is the cleaner one) |
| ABU DHABI-UH | 1 | CS-UH 3090 (deep AND with bracketed coreq) |
| Empty `Prerequisites: None` | 2 | MATH-UA 121, ACCT-UB 1 |
| NOT clause | embedded | covered by MGMT-UB 2 entry-level NOT group |
| Co-requisite | embedded | covered by CS-UH 3090 (`CS-UH 2012`) and MPATC-UE 9322 (`MPATC-UE 9312`) |

Total entries: 16.

## Parsing-discipline notes

- Strict bracket rule: only `[CourseId](/search/...)` references in the bulletin
  are treated as courseIds. Unbracketed shorthand (`OR 122 OR 123`, `ECON-UA 5`,
  `ECON-SHU 2`, `MATH-UH 1020` without anchor) is intentionally dropped — too
  ambiguous to reliably round-trip.
- Class-standing constraints (`Sophomore or higher`, `Soph+`, `Plan = Stern`,
  `Senior only`, `Game Design Major`) are dropped — they are not courseIds.
- Placement-test tokens (`MATH_PLCM2`, `MATH_PLCM3`, `MATH_PLCMT`,
  `CALC AB/BC 4+`, `CALC 2/3 PLACEMENT`, `MATH AD 111Q`, `IBEX-UB 2001`,
  `SOCSC-AD 110Q`) are dropped — none correspond to a NYU courseId or an
  AP/IB-dictionary entry. Per locked Decision Y this is correct: no
  `PLACEMENT_EXAM` token; per-exam-per-score IDs only.
- "or equivalent" / "or equivalent courses" / "or any equivalent courses" is
  dropped — it is a transfer-credit policy clause, not a courseId, and is not
  the locked `requiresPetition: true` trigger ("or instructor permission" /
  "or department approval").
- AP/IB clauses are normalized via the helper at
  `tools/bulletin-parser/syntheticCourseIds.ts`. The bulletin variant
  "AP Calculus AB or BC score of 4" was parsed as TWO synthetic IDs
  (`AP-CALC-AB-4`, `AP-CALC-BC-4`) since the helper dictionary recognizes both
  exam names independently.
- Coreqs at entry-level are NOT zero-padded — Decision A's padding rule applies
  only to course IDs inside `prereqGroups[].courses`.
