# Test Profiles — Visual Overview (All 12)

## 1. `empty` — Baseline
| Programs | cs_major_ba | Visa: domestic |
|----------|-------------|----------------|
| **Courses** | *(none)* | |
> Tests: all not_started, 0 credits

---

## 2. `freshman_clean` — 32cr
| Semester | Courses |
|----------|---------|
| **F23** | CSCI-UA 101 (A) · MATH-UA 121 (A-) · EXPOS-UA 1 (B+) · CORE-UA 501 (B) |
| **S24** | CSCI-UA 102 (B+) · MATH-UA 120 (B) · CORE-UA 601 (A-) · SPAN-UA 1 (B) |
> ✅ Prereqs: 101→102 · Tests: MR-02/03/07, CC-09/11/12, AS-06/07/08, EV-06

---

## 3. `sophomore_mixed_grades` — 56cr
| Semester | Courses |
|----------|---------|
| **F23** | CSCI-UA 101 (**C**) · MATH-UA 121 (A) · EXPOS-UA 1 (B) · SPAN-UA 1 (B+) |
| **S24** | CSCI-UA 102 (B) · MATH-UA 120 (B-) · CORE-UA 501 (**D**) · SPAN-UA 2 (A) |
| **F24** | CSCI-UA 201 (**C**) · CSCI-UA 310 (B) · CORE-UA 701 (**C-**) · SPAN-UA 3 (A-) |
| **S25** | CSCI-UA 202 (**C-**) · SPAN-UA 4 (B+) |
> ✅ Prereqs: 101→102→201+310→202 · 310 needs 120  
> **Grades**: C=min passing major · C- in 202=no major · D in Core=✅ · C- in Core=✅  
> Tests: GF-01/02/03, MR-04, CC-03/21

---

## 4. `freshman_ap` — 40cr
| Semester | Courses |
|----------|---------|
| **F23** | CSCI-UA 102 (A) · EXPOS-UA 1 (A-) · CORE-UA 501 (B+) |
| **S24** | CORE-UA 601 (B) · CORE-UA 701 (A-) |

| Transfer (AP) | Score | Cr | NYU Equiv |
|---------------|-------|----|-----------|
| AP CS A | 5 | 4 | CSCI-UA 101 |
| AP Calc BC | 5 | 4 | MATH-UA 121 |
| AP Calc BC (sub) | 5 | 4 | MATH-UA 122 |
| AP Chinese | 5 | 4 | EAST-UA 204 |
| AP English Lit | 4 | 4 | *(generic)* |
> ✅ AP 101→102 · Total: 20+16+4 = **40cr** · Tests: EQ-01/03/05

---

## 5. `senior_almost_done` — 60cr
| Semester | Courses |
|----------|---------|
| **F22** | CSCI-UA 101 (A) · MATH-UA 121 (A) |
| **S23** | CSCI-UA 102 (A-) · MATH-UA 120 (A-) · MATH-UA 140 (B+) |
| **F23** | CSCI-UA 201 (B+) · CSCI-UA 310 (B) |
| **S24** | CSCI-UA 202 (A-) · CSCI-UA 467 (A) · MATH-UA 122 (B) |
| **F24** | CSCI-UA 472 (B+) · CSCI-UA 474 (A) |
| **S25** | CSCI-UA 480 (A-) · CSCI-UA 473 (B+) |
| **F25** | CSCI-UA 478 (A) |
> ✅ Full prereq chain · 6 CS 400-level + 2 math subs · ⚠️ No Core  
> Tests: MR-07/08/10

---

## 6. `fl_exempt` — 20cr
| Semester | Courses |
|----------|---------|
| **F23** | CSCI-UA 101 (A) · MATH-UA 121 (B+) · EXPOS-UA 1 (A) |
| **S24** | CSCI-UA 102 (A-) · MATH-UA 120 (B) |
> Flags: `nonEnglishSecondary` · Visa: `f1` · Tests: CC-04, EV-01/02/03/04/05

---

## 7. `credit_cap_stress` — 28cr
| Semester | Courses |
|----------|---------|
| **F23** | CSCI-UA 101 (A) · MATH-UA 121 (A) |
| **S24** | CSCI-UA 102 (A-) · MATH-UA 120 (B+) |
| **F24** | CSCI-UA 201 (B+) · CSCI-UA 310 (B) |
| **S25** | CSCI-UA 202 (A-) |

| Cap | Value | Limit | Status |
|-----|-------|-------|--------|
| UA credits | 50 | ≥ 64 | ⚠️ short |
| Non-CAS | 20 | ≤ 16 | ⚠️ over |
| Online | 28 | ≤ 24 | ⚠️ over |
| P/F | 36 | ≤ 32 | ⚠️ over |
> Tests: CAP-01/03/04/08

---

## 8. `core_complete` — 60cr
| Semester | Courses |
|----------|---------|
| **F22** | EXPOS-UA 1 (B+) · FYSEM-UA 740 (A-) · SPAN-UA 1 (B) · MATH-UA 121 (A) |
| **S23** | SPAN-UA 2 (B+) · CORE-UA 501 (B) · CORE-UA 601 (A-) |
| **F23** | SPAN-UA 3 (A) · CORE-UA 701 (B+) · CORE-UA 801 (B) · CSCI-UA 101 (A) |
| **S24** | SPAN-UA 4 (A-) · PHYS-UA 11 (B+) · BIOL-UA 12 (B) · CSCI-UA 102 (A-) |
> All 10 Core rules satisfied · Tests: CC-01/03/09/11–17, QR double-count

---

## 9. `math_sub_overflow` — 52cr
| Semester | Courses |
|----------|---------|
| **F22** | CSCI-UA 101 (A) · MATH-UA 121 (A) |
| **S23** | CSCI-UA 102 (A-) · MATH-UA 120 (B+) · MATH-UA 140 (A) |
| **F23** | CSCI-UA 201 (B+) · CSCI-UA 310 (B) · MATH-UA 122 (A-) |
| **S24** | CSCI-UA 202 (A-) · MATH-UA 185 (B+) |
| **F24** | CSCI-UA 467 (A) · CSCI-UA 472 (B+) |
| **S25** | CSCI-UA 474 (A) |
> **Math subs**: 122 ✅, 140 ✅, 185 taken but not counted (3rd exceeds max 2 — earns general credits only)  
> **Electives**: 3 CS 400-level + 2 math subs = 5 · Tests: MR-11

---

## 10. `transfer_heavy` — 52cr
| Semester | Courses |
|----------|---------|
| **S24** | MATH-UA 120 (A) |
| **F24** | CSCI-UA 201 (B+) · CSCI-UA 310 (B) · EXPOS-UA 1 (A-) |
| **S25** | CSCI-UA 202 (A-) |

| Transfer | Score | Cr | NYU Equiv |
|----------|-------|----|-----------|
| AP CS A | 5 | 4 | CSCI-UA 101 |
| AP Calc BC | 5 | 4 | MATH-UA 121 |
| AP Calc BC (sub) | 5 | 4 | MATH-UA 122 |
| AP English Lit | 5 | 4 | *(generic)* |
| AP Psychology | 5 | 4 | *(generic)* |
| AP Physics C | 5 | 4 | PHYS-UA 11 |
| AP Biology | 5 | 4 | BIOL-UA 12 |
| IB CS HL | 6 | 4 | CSCI-UA 102 |
> Transfer: 24 mapped + 8 generic = **32cr exactly** (at cap) · Tests: EQ-01/03/07, CAP-09

---

## 11. `passfail_violation` — 24cr
| Semester | Courses |
|----------|---------|
| **F23** | CSCI-UA 101 (**P**) · MATH-UA 121 (A) · CORE-UA 501 (**P**) · EXPOS-UA 1 (**P**) |
| **S24** | SPAN-UA 1 (**P**) · CORE-UA 601 (B+) |
> **P/F violations**: 101 P/F=major error · Expos P/F=Core error · SPAN-UA 1 P/F=allowed (FL exception)  
> 3 P/F in F23 term → 1-per-term error · ⚠️ CORE-UA 501 P/F not detected (wildcard bug)  
> Tests: PF-01/02/03/04/05, P-grade in audit

---

## 12. `low_gpa` — 28cr attempted, 20cr earned
| Semester | Courses |
|----------|---------|
| **F23** | CSCI-UA 101 (**D**) · MATH-UA 121 (**D+**) · EXPOS-UA 1 (**C-**) · CORE-UA 501 (**F** ❌) |
| **S24** | CSCI-UA 102 (**D**) · MATH-UA 120 (**C-**) · CORE-UA 601 (**F** ❌) |
> GPA ≈ 0.95 → not in good standing · 2 F's = 0 credits earned · Completion 71%  
> Tests: AS-01/02/03/04/05
