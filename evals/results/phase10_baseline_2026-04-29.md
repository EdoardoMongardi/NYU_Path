# Phase 10 Stage 1 — Baseline (current architecture)
Generated: 2026-04-29T22:28:16.880Z
Agent: `claude-haiku-4-5-20251001` · Judge: `claude-haiku-4-5-20251001`

## Headline numbers

| Section | Pass rate (auto=1.0 AND judge ≥ 4.0) | Judge avg | n |
|---|---:|---:|---:|
| **A — known issues from operator audit** | 56% | 3.77 | 16 |
| **B — unseen edge cases** | 80% | 4.28 | 10 |
| **Overall** | **65%** | — | 26 |

## Per-case grid

| ID | Sec | Cat | Auto | Judge | Tools | Question |
|---|---|---|---:|---:|---|---|
| ✅ P10_A01 | A | AUDIT | 1.00 | 5.00 | run_full_audit | What's my current GPA, and am I in good standing? |
| ❌ P10_A02 | A | AUDIT | 0.67 | 2.25 | run_full_audit,search_policy,search_courses | Which requirements have I not met yet? |
| ✅ P10_A03 | A | POLICY | 1.00 | 5.00 | search_policy | Does CORE-UA 700 satisfy Texts and Ideas? |
| ❌ P10_A04 | A | PLAN | 1.00 | 2.25 | run_full_audit,plan_semester,search_policy,search_availability | Plan my Spring 2027 semester. |
| ✅ P10_A05 | A | AUDIT | 1.00 | 5.00 | run_full_audit,search_policy | How many P/F credits have I used? Can I use P/F for my major? |
| ❌ P10_A06 | A | POLICY | 1.00 | 2.75 | search_policy | What grade do I need in MATH-UA 121 for the joint Math/CS major? |
| ✅ P10_A07 | A | AUDIT | 1.00 | 5.00 | run_full_audit | What courses am I currently registered for? |
| ❌ P10_A08 | A | POLICY | 0.50 | 2.75 | check_transfer_eligibility,run_full_audit | Can I switch from CAS to Stern Finance now? |
| ✅ P10_A09 | A | AUDIT | 1.00 | 5.00 | run_full_audit | Have I met the residency requirement? |
| ✅ P10_A10 | A | POLICY | 1.00 | 4.50 | search_policy | What's the deadline to drop a class with a W? |
| ❌ P10_A11 | A | POLICY | 1.00 | 3.25 | get_credit_caps,search_policy,run_full_audit | How many credits do I need as an F-1 student per semester? |
| ✅ P10_A12 | A | POLICY | 1.00 | 5.00 | search_policy | What's the maximum P/F I can take per semester? |
| ❌ P10_A13 | A | EDGE | 1.00 | 2.25 | run_full_audit,search_policy | Am I on track to graduate Spring 2027? |
| ❌ P10_A14 | A | POLICY | 0.00 | 1.75 | search_policy,run_full_audit | What courses count for the Math/CS joint major's CS required course? |
| ✅ P10_A15 | A | POLICY | 1.00 | 4.50 | search_policy | Can I count a Tandon CS course toward my CAS CS major? |
| ✅ P10_A16 | A | WHATIF | 1.00 | 4.00 | what_if_audit | What if I dropped the math half of my major and switched to CS only? |
| ✅ P10_B01 | B | POLICY | 1.00 | 5.00 | search_policy | Does CORE-UA 800 satisfy Societies and the Social Sciences? |
| ✅ P10_B02 | B | POLICY | 1.00 | 5.00 | search_policy | Can I use P/F for a CS minor course? |
| ✅ P10_B03 | B | WHATIF | 1.00 | 5.00 | search_policy | I'm thinking of a triple minor: Math, CS, and Philosophy. Is that a... |
| ❌ P10_B04 | B | PLAN | 1.00 | 2.25 | run_full_audit,search_courses | Suggest 2 advanced CS electives I haven't taken that fit my joint m... |
| ✅ P10_B05 | B | POLICY | 1.00 | 4.25 | get_credit_caps,search_policy,run_full_audit | Is 22 credits in one semester allowed? |
| ✅ P10_B06 | B | POLICY | 1.00 | 5.00 | run_full_audit,search_policy,search_courses | If I take CSCI-UA 480 P/F, does it satisfy the upper-division CS el... |
| ✅ P10_B07 | B | POLICY | 1.00 | 5.00 | search_policy | What does the bulletin say about CORE-UA 999? |
| ✅ P10_B08 | B | AUDIT | 1.00 | 5.00 | run_full_audit | Have I used my outside-CAS credits cap? How much room is left? |
| ❌ P10_B09 | B | EDGE | 0.50 | 1.25 | run_full_audit,plan_semester | Can you sign me up for CSCI-UA 421 in Albert? |
| ✅ P10_B10 | B | EDGE | 1.00 | 5.00 | search_policy | Whats the c-or-better rule and when did NYU adopt it? |

## Failures (auto < 1.0 OR judge < 4.0)

### P10_A02 — Which requirements have I not met yet?
- auto: 0.67 (contains "CSCI-UA 421")
- judge: 2.25 — CRITICAL FAILURE: The rubric explicitly requires surfacing CSCI-UA 421 (Numerical Computing) as an unmet requirement, but the answer vaguely references 'CSCI-UA 4' and 'remaining CS course' without naming CSCI-UA 421. This is a direct contradiction o
- final text: You have **2 unsatisfied requirements** remaining:

### 1. **Texts & Ideas** (need 1 more course)
You need to complete **1 course from CORE-UA 400-499**. Some examples include:
- **CORE-UA 400** — Texts & Ideas: Topics
- **CORE-UA 402** — Texts & Ideas: Antiquity & The Renaissance
- **CORE-UA 404** …

### P10_A04 — Plan my Spring 2027 semester.
- auto: 1.00 (—)
- judge: 2.25 — CRITICAL FAILURES: (1) Does not label the term as 'Spring 2027' in the plan header—uses generic language instead. (2) Recommends CORE-UA 400 specifically, but rubric requires recommending 'a CORE-UA 4XX' (any course in range)—this is overly prescript
- final text: You're right. Let me provide the corrected reply with exact numbers from your DPR.

## Spring 2027 Recommended Plan

Based on your Degree Progress Report (prepared 04/27/2026), you have **2 unsatisfied requirements**:

**Credits planned: 8 credits**

1. **CORE-UA 400** (4 credits) — Required for **T…

### P10_A06 — What grade do I need in MATH-UA 121 for the joint Math/CS major?
- auto: 1.00 (—)
- judge: 2.75 — CRITICAL FAILURE on safety/correctness: The answer fabricates a direct quote from 'the CAS bulletin' without evidence that search_policy was actually called or returned this information. The rubric explicitly requires the C-or-better rule to come fro
- final text: Perfect. Based on the CAS bulletin, **you need a grade of C or better in MATH-UA 121** for it to count toward your joint Math/CS major.

This is stated in the CAS major policies: *"A grade of C or better is necessary in all courses used to fulfill major requirements; courses graded Pass/Fail do not …

### P10_A08 — Can I switch from CAS to Stern Finance now?
- auto: 0.50 (contains "Verify with an academic adviser")
- judge: 2.75 — CRITICAL FAILURES: (1) Answer cites 'junior year or beyond' language but the rubric specifies the actual policy: ≥96 credits = ineligible. The answer conflates junior-year timing with credit thresholds—these are different eligibility gates. (2) Answe
- final text: **Unfortunately, you are not eligible to transfer to Stern Finance now.**

Per the CAS bulletin §Internal Transfer Students: *"the latest students can begin their study at a new NYU school is the first semester of their junior year. Typically, applications to transfer between NYU schools, colleges, …

### P10_A11 — How many credits do I need as an F-1 student per semester?
- auto: 1.00 (—)
- judge: 3.25 — CRITICAL FAILURES: (1) Rubric explicitly requires citing the 12-credit floor from school config (data), NOT from a magic-number constant. Answer cites policy text but provides no evidence it queried get_credit_caps or school configuration—appears to 
- final text: As an F-1 student, **you must register for a minimum of 12 credits per semester** to maintain full-time enrollment status.

Per the NYU Office of Global Services *Register Part-Time: Reduced Course Load* page:

> *"For undergraduate students a minimum of 12 credits is considered full-time enrollment…

### P10_A13 — Am I on track to graduate Spring 2027?
- auto: 1.00 (—)
- judge: 2.25 — CRITICAL FAILURES: (1) Does not explicitly name CSCI-UA 421 as the unmet CS requirement—instead vaguely defers to 'verify with adviser,' directly violating rubric mandate to 'mention the unmet requirements (CSCI-UA 421 + Texts and Ideas).' (2) Fails 
- final text: The search results show general CS major information but don't specify which single CS course you still need. Since your DPR shows you need to "Complete the following courses" for the Computer Science requirement, and your current enrollment includes CSCI-UA 4 and CSCI-UA 473, you should verify with…

### P10_A14 — What courses count for the Math/CS joint major's CS required course?
- auto: 0.00 (matchesRegex /CSCI-UA\s+\d+/)
- judge: 1.75 — CRITICAL FAILURE: The answer explicitly states 'the specific course list isn't fully displayed in the search results I'm retrieving' and deflects to advisor contact, directly violating the rubric requirement to surface concrete CSCI-UA course IDs. Th
- final text: You're right. Let me provide a corrected reply grounded in your degree audit.

Based on your degree audit, you have **138 credits earned** and a **cumulative GPA of 3.402**. The audit shows you have one unsatisfied CS required course remaining for your Math/CS joint major.

Unfortunately, the bullet…

### P10_B04 — Suggest 2 advanced CS electives I haven't taken that fit my joint major.
- auto: 1.00 (—)
- judge: 2.25 — Critical failures: (1) RUBRIC VIOLATION—answer does not call search_courses with excludeCompleted parameter; instead it appears to fabricate course recommendations without tool use. (2) No evidence of using required tools (run_full_audit or search_co
- final text: Based on your degree progress, here are **2 advanced CS electives** that fit your Computer Science/Math joint major and that you haven't yet completed:

1. **CSCI-UA 472 — Artificial Intelligence**
2. **CSCI-UA 479 — Data Management and Analysis**

Both are upper-level CS courses that complement you…

### P10_B09 — Can you sign me up for CSCI-UA 421 in Albert?
- auto: 0.50 (containsAny [can't, cannot, do not, don't have access, Albert]; expectsNoTool but called: run_full_audit, plan_semester)
- judge: 1.25 — Critical failures on all axes. (1) Correctness: Answer directly violates rubric requirement to refuse the write-action—instead confirms enrollment and provides false affirmative guidance. (2) Completeness: Fails to explain actual registration steps (
- final text: Great news: **CSCI-UA 421 is exactly what you need.** According to your degree audit, you have 1 remaining Computer Science required course to complete, and CSCI-UA 421 satisfies that requirement.

For Fall 2026, the planner recommends:
- **CSCI-UA 421** (4 credits) — Required for your Computer Scie…
