# School-config spot-check — consolidated findings

Adversarial re-verification of the 8 bulletin-extracted school configs
(`data/schools/*.json`) against their source bulletins. Per-school worksheets
are in this directory (`<school>.md`). Generated 2026-06-04.

**Overall:** extraction quality was high — the headline planner-critical
values were confirmed verbatim across the board (Steinhardt residency 56,
Nursing residency 32 + GPA 2.0 + C grade-thresholds, Gallatin 64/32 + P/F 4 +
Dean's 3.850, Liberal Studies null/time-based residency + lifecycle, Tisch P/F
32 + goodStanding 0.5, NYUAD P/F 3 + overload tiers, Shanghai non-home 36). No
confirmed-field had a wrong *headline* number. The issues below are mostly
edge fields, CAS-default fabrications, and schema-shape limits.

## A. HIGH impact — real planning-correctness bugs

1. **NYUAD missing `advanced_standing` cap → engine grants 32 AP credits it shouldn't.**
   NYUAD awards **zero** AP/IB credit, but with no `advanced_standing` entry the
   validator (`creditCapValidator.ts:131`) silently falls back to the CAS default
   **32**. Fix: add `{type:"advanced_standing", maxCredits:0}` to `nyuad.json`.
   (Shanghai already has `advanced_standing:0` — confirmed correct.)

2. **NYUAD + Shanghai residency is mis-modeled as a credit count.**
   Both use **semester-based / final-semester** residency, not a 64-credit floor:
   - NYUAD: `residency.minCredits 64 → null`; `majorMinorResidencyPercent 50 → null`;
     `type "suffix_based" → time-based`. Real rule: final semester in residence
     (+ in-absentia within 8 credits); double-majors ≥30 distinct credits each.
   - Shanghai: `minCredits 64 → null` (real: "≥6 fall/spring semesters at NYU
     Shanghai"); `finalCreditsInResidence 32 → final semester`; `majorMinorResidencyPercent
     50 → null` (minor rule is "≥12 unique credits").

## B. MEDIUM impact — CAS defaults that are wrong for the school

3. **`overloadRequirements.minGpa: 3.5` is a fabricated CAS default** for schools
   with no published overload GPA gate. Drop the number (→ `[]`/null) for:
   **liberal_studies, sps, nursing, shanghai** (each bulletin sets only
   "good standing", no 3.5).

4. **`gallatin.auditMode` should be `"advising_only"`.** Gallatin is
   individualized-study with no fixed major/gen-ed grids; the `SchoolConfig` type
   def literally comments `advising_only … (Gallatin)`. Omitting it defaults to
   hard `full` enforcement against design intent.

5. **`maxCreditsPerSemester` MISSED a real value for Liberal Studies.** LS
   publishes **16/term** normal full-time load (128cr/4yr) on its
   *Registration → Enrollment Status* page (extractor only read academic-policies).
   Config's inferred `18` is at best an overload ceiling.

6. **`degreeType` single-scalar is lossy for multi-degree schools** (schema limit):
   tisch (BA + BFA), steinhardt (multi; BS plurality), nyuad (BA + BSc),
   shanghai (BA + BS; 14/18 majors are BS), sps (BA/BS/AA/AAS). Either widen the
   field or accept the plurality pick as a documented simplification.

## C. LOW impact — mis-sourced / provenance cleanup

7. **`maxCourseRepeats` mis-presented as bulletin-claimed** where the bulletin
   states **no numeric cap**: gallatin (`2`) and nursing (`1`) — mark inferred or
   null. (nursing's "no more than once" is a sequence-withdrawal rule, not a
   repeat cap.)

8. **`deansListThreshold` wrong for NYUAD** — NYUAD has no Dean's List (uses
   percentile Latin Honors). Set `null`.

9. **Fields mis-flagged as inferred but actually bulletin-stated** (move OUT of
   `_inferredFields`; values are correct): tisch `transferCreditLimits.firstYearMaxTotal`;
   gallatin `f1FullTimeMinCredits` + `overloadRequirements.minGpa`(3.0, real);
   nursing `courseSuffix`/`residency.suffix` (-UN is explicit: NURSE-UN);
   liberal_studies + shanghai `passFail.countsForGenEd`; sps
   `doubleCounting.requiresDepartmentApproval`/`overrideByProgram`.

10. **`spsPolicy.allowedPrefixes`** (the CAS allowlist) copied unverified to
    steinhardt + shanghai (0 hits in their bulletins). Low impact; consider
    clearing or leaving flagged.

## D. STRUCTURAL — note, not a quick fix

11. **SPS scope gap.** `sps.json` encodes only Schack/Tisch numbers; the Division
    of Applied Undergraduate Studies (DAUS) diverges (residency **48** not 64,
    advanced-standing 80/30). Applying `sps.json` to DAUS programs gives wrong
    residency/transfer caps. Likely needs per-division handling.

12. **Tisch Dance** is a bulletin exception (no AP/IB credit; HS-college cap 8) the
    single school-level `advanced_standing:32` doesn't capture — per-program override.
