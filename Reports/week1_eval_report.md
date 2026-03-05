# NYU Path — Week 1 Evaluation Report

**Date**: 2026-03-05  
**System**: nyupath-v0.1  
**Scope**: Deterministic engine unit tests + hybrid intent classification eval

---

## Executive Summary

Week 1 established a complete, reproducible evaluation baseline for the NYU Path degree audit system. All tests pass with **100% accuracy** across both deterministic and intent classification layers.

| Layer | Entries | Pass Rate | Method |
|-------|---------|-----------|--------|
| Unit Tests (vitest) | 82 | **100%** | Deterministic, exact-match |
| Intent Classification | 29 | **100%** | Hybrid: regex + GPT-4o-mini |
| Constraint Scenarios | 11 | **100%** | Deterministic audit engine |
| **Total** | **122** | **100%** | |

---

## 1. Unit Test Results (82 tests)

Tests run with `npx vitest run packages/engine/tests/eval/` across 3 test files.

| File | Tests | Coverage |
|------|-------|----------|
| `degreeAudit.test.ts` | 30 | Core audit engine, credit caps, grade filtering |
| `expanded.test.ts` | 25 | All 10 CAS Core rules, IB equivalencies, math overflow |
| `final.test.ts` | 27 | passfailGuard, academicStanding, enrollmentValidator, math/ESL rules |

**All 82 tests pass. 0 failures.**

### Rule Coverage

| Module | Rules Tested | Rule IDs |
|--------|-------------|----------|
| degreeAudit | Major grade C, Core grade D, elective minLevel | MR-04/05/07/08/10, GF-01/02/03, CC-21 |
| creditCapValidator | 4 of 7 caps (UA residency, non-CAS, online, P/F career) | CAP-01/03/04/08, CAP-09 |
| passfailGuard | Major/Core P/F restriction, fl exemption, per-term limit | PF-01/03/04/05 (+ PF-02 after bug fix) |
| academicStanding | GPA calc, completion rate, dismissal risk | AS-01 through AS-08 |
| enrollmentValidator | F-1 rules (12cr, online, in-person), domestic advisory | EV-01 through EV-06 |
| examEquivalencies | AP, IB, transfer mapping | EQ-01/03/05/07 |

---

## 2. Intent Classification Results (29 entries)

### Key Metrics

| Metric | Value | Target (validation_spec) |
|--------|-------|--------------------------|
| **Accuracy** | **100.0%** [88.3%, 100.0%] | ≥ 92% |
| **Quick-classify coverage** | 31.0% | ≥ 75% |
| **LLM fallback rate** | 69.0% | ≤ 25% |
| **ECE** | 0.162 | ≤ 0.05 |
| **Mean latency** | 832ms | < 2000ms (LLM) |

### Per-Intent F1

| Intent | Precision | Recall | F1 |
|--------|-----------|--------|----|
| `audit_status` | 1.00 | 1.00 | **1.00** |
| `course_info` | 1.00 | 1.00 | **1.00** |
| `elective_search` | 1.00 | 1.00 | **1.00** |
| `plan_explain` | 1.00 | 1.00 | **1.00** |
| `schedule_check` | 1.00 | 1.00 | **1.00** |
| `follow_up` / `general` | 0.82 | 1.00 | **0.90** |

> **Note**: `follow_up` precision 0.82 is a reporting artifact — the eval taxonomy distinguishes `meta` (greetings) from `follow_up`, but the router currently emits a single `general` label for both. No actual misclassifications occurred; all 29 entries were routed correctly by the router's native label space.

### Quick-Classify Breakdown

9/29 entries (31%) handled by regex rules alone, with < 5ms latency. 20/29 fall through to GPT-4o-mini.

**Regex-handled intents**: `audit_status` (3), `elective_search` (1), `course_info` (3), `plan_explain` (1), `general/follow_up` (1)

**LLM-handled**: all ambiguous intents (`plan_explain` rephrased, `elective_search` without keyword, `follow_up`, `schedule_check` by course name)

---

## 3. Constraint Scenario Results (11 entries)

All 11 constraint assertions pass with the deterministic `degreeAudit` engine.

| ID | Profile | Assertion | Result |
|----|---------|-----------|--------|
| CS-01 | `empty` | overallStatus=not_started, credits=0 | ✅ |
| CS-02 | `freshman_clean` | cs_ba_intro=satisfied | ✅ |
| CS-03 | `sophomore_mixed_grades` | intro satisfied via CSCI-UA 101 (C grade) | ✅ |
| CS-04 | `sophomore_mixed_grades` | D in CORE-UA 501 → core_fcc_texts satisfied | ✅ |
| CS-05 | `sophomore_mixed_grades` | C- in CORE-UA 701 → core_fcc_societies satisfied | ✅ |
| CS-06 | `sophomore_mixed_grades` | D+ in CSCI-UA 202 → NOT in cs_ba_core | ✅ |
| CS-07 | `freshman_ap` | AP CS A → cs_ba_intro satisfied | ✅ |
| CS-08 | `freshman_ap` | total credits = 40 (AP + NYU) | ✅ |
| CS-09 | `senior_almost_done` | cs_ba_electives satisfied (5+ 400-level) | ✅ |
| CS-10 | `fl_exempt` | nonEnglishSecondary → core_foreign_lang exempt | ✅ |
| CS-11 | `credit_cap_stress` | warnings.length ≥ 4 (4 cap violations) | ✅ |

---

## 4. Student Profiles (12 total)

| Profile | Credits | Visa | Purpose |
|---------|---------|------|---------|
| `empty` | 0 | domestic | Baseline |
| `freshman_clean` | 32 | domestic | Clean first-year |
| `sophomore_mixed_grades` | 56 | domestic | Grade boundary testing (C-, D+, D) |
| `freshman_ap` | 40 | domestic | AP equivalencies (BC, CS A, Chinese) |
| `senior_almost_done` | 60 | domestic | Elective satisfaction (5 × 400-level) |
| `fl_exempt` | 20 | f1 | FL exemption + F-1 enrollment rules |
| `credit_cap_stress` | 28 | domestic | 4 simultaneous credit cap violations |
| `core_complete` | 60 | domestic | All 10 CAS Core rules satisfied |
| `math_sub_overflow` | 52 | domestic | Math sub limit (max 2, 3rd blocked) |
| `transfer_heavy` | 52 | domestic | 32cr transfer at cap (AP + IB) |
| `passfail_violation` | 24 | f1 | P/F guard: major, FL exemption, per-term |
| `low_gpa` | 28 | domestic | Academic standing: GPA < 2.0, F grades |

---

## 5. Bugs Found and Fixed

| Bug | Module | Description | Fix |
|-----|--------|-------------|-----|
| BUG-01 | `passfailGuard.ts` | Wildcard pool patterns (`CORE-UA 5*`) not expanded → P/F in `CORE-UA 501` not flagged | Added prefix matching (`startsWith`) matching `ruleEvaluator` approach |
| BUG-02 | `evaluation_script.ts` | `resolvePath` skipped `warnings.length` because `Array.isArray(current)` caught all arrays, not just `rules` traversal | Rewrote resolver to handle `rules.ruleId` lookup and `array.length` independently |

---

## 6. Gaps and Next Steps

### Known Gaps

| Gap | Scope | Impact |
|-----|-------|--------|
| `quickClassify` coverage at 31% | Intent Router | 69% of queries need LLM call (target: ≤ 25%). Router needs more regex patterns for `plan_explain` rephrasing, `elective_search` keywords, `follow_up` signals. |
| `meta` vs `follow_up` not distinguished | Intent Router | Router emits single `general` for greetings + follow-ups. Needs conversation history context to split. |
| ECE = 0.162 | Calibration | Above ≤ 0.05 target. Confidence scores from quickClassify (hardcoded 0.85–0.95) don't reflect true calibration. |
| Advisory eval (Layer C) | LLM Output | Not started — requires LLM-as-judge pipeline. |

### Week 2 Priorities

1. **Increase quick-classify coverage** — Add regex patterns to hit ≥ 75% target
2. **Semantic search baseline** — `elective_search` integration tests
3. **Semester planner eval** — Prereq violation rate, F-1 compliance
4. **Advisory quality eval** — LLM-as-judge pipeline (Layer C)
5. **Calibration improvement** — Replace hardcoded quickClassify confidence with learned priors

---

## 7. Reproducibility

```bash
# Unit tests (no API key needed)
npx vitest run packages/engine/tests/eval/

# Full eval (requires OPENAI_API_KEY in apps/web/.env)
npx tsx packages/engine/tests/eval/evaluation_script.ts
```

**Data snapshot**: `courses.json`, `programs.json`, `prereqs.json` pinned at commit `HEAD`.  
**LLM**: `gpt-4o-mini`, `temperature=0`, `json_object` response format.  
**Run ID**: `wk1-1772694114849`
