---
name: NYU CAS CS BA Advisor Rules
description: Comprehensive reference for implementing the CS BA academic advisor. Maps every rule to its authoritative source file and specifies whether it should be deterministic code or LLM context.
---

# NYU CAS CS BA Advisor — Rules Implementation Guide

## CRITICAL CONSTRAINTS

1. **NEVER invent rules.** Every rule referenced here comes from one of the five files in `Original rules/`. If a rule is not documented there, it does not exist for this system.
2. **NEVER search the web** for additional academic policies. The five source files are the complete, authoritative rule set.
3. **LLM context must be derived strictly** from the five source files. Do not add policies, constraints, or advice that cannot be traced to a specific passage in these files.
4. **When in doubt, say "consult your advisor"** rather than inventing an answer.

---

## Source Files

All rules originate from these five files in `Original rules/`:

| File | Abbreviation | Scope |
|---|---|---|
| `Major rules CS BA major` | **[CS-MAJOR]** | CS BA major-specific: courses, credits, GPA, electives, math subs |
| `CAS core rules.md` | **[CAS-CORE]** | College Core Curriculum: FYS, Writing, Language, FCC (4), FSI (3) |
| `General CAS academic rules.md` | **[GEN-ACAD]** | Degree requirements, residency, grading, academic standing, credit policies |
| `General rules for transfer credits.md` | **[TRANSFER]** | AP/IB/A-Level equivalencies, transfer credit policies |
| `F1 student rule.md` | **[F1-RULES]** | F-1/J-1 visa enrollment requirements |

---

## PART A: Deterministic Code Rules

These rules have binary, computable answers. Implement them in code — never leave them to LLM judgment.

---

### A1. CS BA Major Requirements [CS-MAJOR]

**Total:** 12 courses / 48 credits minimum

#### A1.1 Core Courses (7 required)

Implement as `must_take` + `choose_n` rules in `programs.json`:

| Course | Prerequisites | Semesters |
|---|---|---|
| CSCI-UA.0101 (Intro to CS) | CSCI-UA.0002 or CSCI-UA.0003 or placement | Fall / Spring |
| CSCI-UA.0102 (Data Structures) | CSCI-UA.0101 | Fall / Spring |
| CSCI-UA.0201 (Computer Systems Org) | CSCI-UA.0102 | Fall / Spring |
| CSCI-UA.0202 (Operating Systems) | CSCI-UA.0201 | Fall / Spring |
| CSCI-UA.0310 (Basic Algorithms) | CSCI-UA.0102 + MATH-UA.0120 + (MATH-UA.0121 or MATH-UA.0131) | Fall / Spring |
| MATH-UA.0121 (Calculus I) | MATH-UA.0009 | Fall / Spring / Summer |
| MATH-UA.0120 (Discrete Mathematics) | See A1.2 below | Fall / Spring |

#### A1.2 Discrete Mathematics Prerequisites [CS-MAJOR]

A student satisfies the prerequisite for MATH-UA.0120 if ANY ONE of:
- SAT Math ≥ 670
- ACT/ACTE Math ≥ 30
- AP Calculus AB score ≥ 3
- AP Calculus BC score ≥ 3
- A-Level Maths ≥ C (Further Maths varies by exam board)
- AS-Level Maths ≥ B
- IB HL Math ≥ 5
- IB SL Math ≥ 6
- MATH-UA.0009 with grade C or higher
- Passing placement exam

#### A1.3 Major Electives (5 required) [CS-MAJOR]

- Must be numbered **CSCI-UA.04xx** (400-level CS electives)
- Up to **2** may be substituted with math courses from this exact list:
  - MATH-UA.0122 (Calculus II)
  - MATH-UA.0140 (Linear Algebra)
  - MATH-UA.0185 (Probability and Statistics)
- Elective offerings vary by semester; one is typically offered in summer

#### A1.4 Major Credit Constraints [CS-MAJOR]

- Minimum **32 credits with CSCI-UA designation** within the 48-credit major
- Minimum **2.0 GPA** in the major
- Only grades **C or higher** count toward major (and prerequisites)
- **Pass/Fail grades NOT accepted** for major courses or prerequisite courses
- **50% of major** must be completed at CAS (NYU Washington Square)
- The following courses **do NOT count** toward the CS major: CSCI-UA 2, 4, 60, 61, 330, 380, 381, 520/1, 897/8, 997/8
- **Placement exam passes earn NO credit.** If the placed-out course is required for the CS major, it must be replaced with a CSCI-UA 400-level elective
- **Max 2 courses** may be double-counted between major(s) and/or minor(s)

#### A1.5 Credit Distribution Options [CS-MAJOR]

| Option | CS Courses (Credits) | Math Courses (Credits) | Total |
|---|---|---|---|
| 1 | 10 (40) | 2 (8) | 48 |
| 2 | 9 (36) | 3 (12) | 48 |
| 3 | 8 (32) | 4 (16) | 48 |

---

### A2. CAS Core Curriculum [CAS-CORE]

#### A2.1 Core Component List (11 requirements)

| Requirement | Rule ID | Pool |
|---|---|---|
| First-Year Seminar | `core_fys` | FYSEM-UA * |
| Expository Writing | `core_expos` | EXPOS-UA 1 or EXPOS-UA 9 (+ international pathways) |
| Foreign Language | `core_foreign_lang` | Intermediate II level of any language |
| FCC: Texts and Ideas | `core_fcc_texts` | CORE-UA 500 series |
| FCC: Cultures and Contexts | `core_fcc_cultures` | CORE-UA 600 series |
| FCC: Societies and Social Sciences | `core_fcc_societies` | CORE-UA 700 series |
| FCC: Expressive Culture | `core_fcc_expressive` | CORE-UA 800 series |
| FSI: Quantitative Reasoning | `core_fsi_quant` | CORE-UA 100 series (+ MATH-UA 121, Calc II, Stats AP, etc.) |
| FSI: Physical Science | `core_fsi_physical` | CORE-UA 200 series |
| FSI: Life Science | `core_fsi_life` | CORE-UA 300 series |

#### A2.2 Core Grading Rule [CAS-CORE]

- Minimum grade of **D (1.0)** required to satisfy any Core requirement
- Courses taken Pass/Fail **do NOT count** for Core — exception: foreign language courses below Intermediate II may be P/F

#### A2.3 Foreign Language Exemptions [CAS-CORE]

A student is exempt from the foreign language requirement if ANY of:
- Entire secondary schooling was in a language other than English
- Completed EXPOS-UA 4 + EXPOS-UA 9 (International Writing Workshop sequence)
- In the dual-degree BS/BS Engineering program
- Passed the CAS foreign language exemption exam
- Satisfied via AP/IB/A-Level score (see TRANSFER rules A5)

#### A2.4 FSI Exemptions and Substitutions [CAS-CORE]

**Who is exempt from all FSI:** Students who complete a major in natural sciences, the prehealth curriculum, or the combined dual-degree program in engineering.

**CS BA majors are NOT exempt from FSI.** They can only satisfy FSI components through:
- Taking the required CORE-UA courses, OR
- Having qualifying AP/IB/A-Level scores (see TRANSFER rules A5)

**Quantitative Reasoning substitutions** (any one satisfies it):
- CORE-UA 1XX courses
- AP or equivalent credit in Calculus (AB or BC, 4 or 8 points)
- AP or equivalent credit in Statistics (4 points)
- BIOL-UA 42 (Biostatistics)
- Calculus I, II, or III (MATH-UA 121, 122, 123)
- Math for Economics I, II, or III (MATH-UA 131, 132, 133)
- ECON-UA 18 or ECON-UA 20

#### A2.5 Expository Writing Requirements [CAS-CORE]

- Standard path: EXPOS-UA 1 (Writing as Inquiry)
- International path: EXPOS-UA 4 → EXPOS-UA 9 (also satisfies FL requirement)
- Extended international path: EXPOS-UA 3 → EXPOS-UA 4 → EXPOS-UA 9
- Minimum grade of **C** required in writing courses (not just D)
- Students not meeting the writing proficiency standard may need EXPOS-UA 2

---

### A3. General Degree Requirements [GEN-ACAD]

#### A3.1 Degree Completion

- **128 total credits** with cumulative GPA ≥ **2.0**
- Major GPA ≥ **2.0**
- Minor (if elected) GPA ≥ **2.0**

#### A3.2 Residency Requirements [GEN-ACAD]

- All 128 credits must be completed at NYU once enrolled
- **64 credits minimum** must have the **-UA suffix** (CAS courses)
- Courses from other NYU schools (non-UA), NYU Abu Dhabi (-AD/UH), NYU Shanghai (-SHU) do **NOT** count toward the 64 UA credits
- -UA study away courses **DO** count toward the 64 UA credits
- **Last 32 credits** must be completed while registered in CAS
- Student must be registered in CAS during the semester immediately before graduation
- **50% of major/minor courses** must be taken in CAS

#### A3.3 Credit Caps [GEN-ACAD]

| Cap | Limit | Source |
|---|---|---|
| Non-CAS NYU courses | **16 credits** max | [GEN-ACAD] "Courses at Other Schools" |
| Online courses | **24 credits** max toward degree | [GEN-ACAD] "Credit for Online Courses" — raised from 16 in Fall 2024 |
| Transfer credits | **64 credits** max | [GEN-ACAD] "Credit for Transfer Students" |
| Advanced standing (first-years) | **32 credits** max (AP + exams + prior college) | [GEN-ACAD] "Dual Enrollment" |
| Pass/Fail credits | **32 credits** max total career | [GEN-ACAD] "Pass/Fail Option" |
| Independent study | **12 credits** max total; **8 max** per department | [GEN-ACAD] "Credit for Independent Study" |

#### A3.4 Double Counting [GEN-ACAD]

- Max **2 courses** may be shared between any two majors, major+minor, or two minors
- Both departments must approve in writing
- **No course may ever be triple-counted** among any combination of three programs
- Some departments allow fewer (1 or 0); CS department allows max 2

#### A3.5 Pass/Fail Rules [GEN-ACAD]

- One P/F option per term (including summer)
- Max 32 P/F credits total career
- Must elect by end of **week 14** (week 5 of 6-week summer)
- P/F **NOT allowed** for: major courses, minor courses, Core courses
- P grade = A/B/C/D → not computed in GPA
- F grade under P/F option **IS computed** in GPA
- Foreign language courses below Intermediate II **may** be taken P/F

#### A3.6 Course Repetition [GEN-ACAD]

- A student may repeat a course **once**
- Max **2 course repeats** during entire undergraduate career
- No additional credit awarded for repeats — both grades computed in GPA
- Cannot repeat courses in a sequence after completing a more advanced course
- Pre-transfer repeats do not count against the 2-course limit

#### A3.7 Grading [GEN-ACAD]

Grade point values (effective Fall 2018):

| Grade | Points |
|---|---|
| A | 4.000 |
| A- | 3.667 |
| B+ | 3.333 |
| B | 3.000 |
| B- | 2.667 |
| C+ | 2.333 |
| C | 2.000 |
| C- | 1.667 |
| D+ | 1.333 |
| D | 1.000 |
| F | 0.000 |

Key grading rules:
- C- or lower **does not count** toward major or minor (but IS computed in GPA)
- D (1.0) is the minimum passing grade for Core
- C is the minimum required for writing courses
- Grades from study abroad at NYU programs ARE included in GPA
- Grades from external institutions are **NOT** included in GPA

#### A3.8 Academic Standing [GEN-ACAD]

A student is NOT in Good Academic Standing if cumulative or semester GPA < **2.0**.

To return to good standing, a student must in the notice semester:
- Semester GPA ≥ 2.0
- Cumulative GPA ≥ 2.0
- Complete ≥ 75% of attempted credits

Escalation levels:
1. Notice of Academic Concern
2. Notice of Continued Academic Concern
3. Notice of Academic Concern: Required Leave
4. Notice of Academic Concern: Pre-dismissal Notice
5. Academic Dismissal

Dismissal criteria: after 2nd semester, may be dismissed if < 50% of attempted credits completed.

#### A3.9 Time Limit [GEN-ACAD]

- All degree requirements within **8 years** of matriculation
- Transfer students: proportionately reduced
- No transfer credit for courses taken **> 10 years** before matriculation

#### A3.10 Enrollment Norms [GEN-ACAD]

- Standard full-time: **16 credits** per term
- Minimum full-time: **12 credits** per term
- Overload (> 18 credits): requires adviser approval
- < 24 credits/year: jeopardizes full-time status
- < 32 credits/year: may jeopardize financial aid

#### A3.11 Withdrawals [GEN-ACAD]

- Drop during **weeks 1-2**: no transcript record
- Drop during **weeks 3-14**: grade of W (not in GPA)
- After **week 14**: only with petition approval

---

### A4. F-1/J-1 Enrollment Rules [F1-RULES]

#### A4.1 Full-Time Requirement (Fall/Spring only)

- Undergraduate F-1/J-1: minimum **12 credits**
- Must be registered every Fall and Spring semester
- Summer/January: **no enrollment requirement**

#### A4.2 Online Course Limits [F1-RULES]

- F-1: max **1 online course OR 3 online credits** toward full-time per semester
- J-1: max **1 online course** toward full-time per semester
- "In-person," "hybrid," and "blended" instruction modes count as in-person
- Once full-time requirement is met, additional online courses are permitted

#### A4.3 Final Semester Exception [F1-RULES]

- May register below full-time with **OGS Reduced Course Load (RCL) permission**
- OGS still advises at least **one in-person course**
- Must remain in US if intending to apply for Post-completion OPT

#### A4.4 Reduced Course Load Options [F1-RULES]

Available for:
- Final semester (fewer than 12 remaining credits)
- Medical reasons
- Initial difficulty with English / unfamiliarity with US teaching methods / improper placement

**All require OGS approval before dropping below full-time.**

#### A4.5 Consequences of Violation [F1-RULES]

Dropping below full-time without OGS permission results in:
- Loss of F-1/J-1 status benefits
- Inability to stay and study in US
- Impact on CPT, OPT, or Academic Training eligibility
- Potential denial of future visa/status applications (H1B, O1, PR, etc.)

---

### A5. AP/IB/A-Level Credit Equivalencies [TRANSFER]

#### A5.1 General AP Rules [TRANSFER]

- Credit awarded for scores of **4 or 5** (most subjects)
- No credit for AP tests taken **after high school**
- AP credit **lost** if student takes the equivalent course at NYU
- Cannot earn credit for same subject via AP + IB + A-Level

#### A5.2 General IB Rules [TRANSFER]

- Only **Higher Level (HL)** exams qualify (no SL credit)
- Minimum score: **6** (most subjects require 6 or 7)
- 8 credits awarded per qualifying HL exam
- No credit for IB tests taken after high school

#### A5.3 General A-Level Rules [TRANSFER]

- Minimum score: **B** (Pre-U minimum: M2)
- **No credit for AS-Level** exams
- 8 credits awarded per qualifying A-Level exam
- Singapore: only **H2/H3** exams qualify; no credit for both H2 and H3 in same subject
- Cannot earn credit for same subject via AP + IB + A-Level

#### A5.4 AP Equivalency Table [TRANSFER]

> **Implementation note:** Build this as a deterministic lookup table in code (`apEquivalencies.ts`), not LLM text. Every row below comes directly from `General rules for transfer credits.md`.

Key CS-relevant AP equivalencies:

| AP Exam | Score | Credits | Equivalent | Core Satisfaction |
|---|---|---|---|---|
| Calculus AB | 4/5 | 4 | MATH-UA 121 | Quantitative Reasoning |
| Calculus BC | 4/5 | 8 | MATH-UA 121 + 122 | Quantitative Reasoning |
| Calculus BC (AB subscore 4/5, BC < 4) | — | 4 | MATH-UA 121 | Quantitative Reasoning |
| CS A | 4/5 | 4 | CSCI-UA 101 | None |
| CS Principles | 4/5 | 4 | CSCI-UA 2/3 (elective) | None |
| Statistics | 4/5 | 4 | elective | Quantitative Reasoning |

**Important CS-specific note from [CS-MAJOR]:** AP CS A credit is equivalent to CSCI-UA 101 but does NOT satisfy the residency requirement. Students must consult the CS department about whether it counts toward the major.

The complete AP, IB, and A-Level tables are in `General rules for transfer credits.md`. **Every entry must be implemented exactly as listed in that file.**

#### A5.5 Credit Cap for Examinations [GEN-ACAD]

- Max **32 credits** from any combination of AP/IB/A-Level/prior college coursework

---

## PART B: LLM Context Rules

These are rules that require natural-language explanation, interpretation, or judgment. Provide them as system prompt context for the LLM.

---

### B1. What the LLM Should Explain

The LLM's job is to **explain deterministic results** in natural language and **answer informational questions** by referencing the rules. It should:

1. **Explain audit results**: "You've completed 5/7 core courses. You still need CSO and OS, and CSO is the prerequisite for OS, so you should take CSO next."
2. **Explain planning rationale**: "I'm suggesting Algorithms next because you've completed all its prerequisites and it unlocks many 400-level electives."
3. **Answer policy questions**: Reference specific rules from the source files.
4. **Provide procedural guidance**: "To petition for X, contact the Office of Associate Dean for Students at 25 West 4th Street, 6th Floor; 212-998-8140."

### B2. LLM System Prompt Content Mapping

The LLM system prompt (`academicRules.ts`) should contain text derived **only** from the five source files. Here is what each section of the prompt should cover and its source:

| Prompt Section | Source File | Content |
|---|---|---|
| CS Major Structure | [CS-MAJOR] | 7 core + 5 electives, math substitution rules, 32 CSCI-UA credit min |
| Courses not applicable to CS | [CS-MAJOR] | CSCI-UA 2, 4, 60, 61, 330, 380, 381, 520/1, 897/8, 997/8 |
| Placement exam policy | [CS-MAJOR] | No credit earned; must replace with 400-level if course was required |
| CAS Core overview | [CAS-CORE] | 11 components, what satisfies each, exemptions |
| FSI exemptions | [CAS-CORE] | Natural science/prehealth/engineering exempt; CS BA is NOT exempt |
| FSI substitutions | [CAS-CORE] | List of courses/exams that satisfy QR, Physical Science, Life Science |
| Writing requirements | [CAS-CORE] | Standard vs. international pathways, minimum C grade |
| Foreign language exemptions | [CAS-CORE] | Non-English schooling, ESL pathway, engineering, exam exemption |
| Residency requirements | [GEN-ACAD] | 64 UA credits, last 32 in CAS, 50% major in CAS |
| Credit caps | [GEN-ACAD] | 16 non-CAS, 24 online, 64 transfer, 32 advanced standing, 32 P/F |
| Grading policies | [GEN-ACAD] | Grade table, GPA computation, C- rule for major, D rule for Core |
| Pass/Fail rules | [GEN-ACAD] | When allowed, what's excluded, deadlines |
| Academic standing | [GEN-ACAD] | GPA thresholds, concern levels, dismissal criteria |
| Repeat policy | [GEN-ACAD] | Max 2 repeats, no additional credit, both grades in GPA |
| Double counting | [GEN-ACAD] | Max 2 shared courses, no triple-counting |
| Withdrawal timeline | [GEN-ACAD] | Weeks 1-2 / 3-14 / after 14 |
| AP/IB/A-Level general rules | [TRANSFER] | What counts, what doesn't, credit loss if equivalent taken |
| F-1 enrollment context | [F1-RULES] | When to warn about visa status, RCL process, consequences |
| AP/IB equivalencies detail | [TRANSFER] | For answering "does my AP X count?" — supplement code lookup |
| Time limit | [GEN-ACAD] | 8 years, 10-year transfer limit |
| Reduced course load | [F1-RULES] | When and how to apply, OGS contact |

### B3. What the LLM Must NOT Do

- **Must NOT invent policies** not found in the five source files
- **Must NOT make up course equivalencies** — always defer to the coded AP/IB/A-Level lookup
- **Must NOT override code-computed results** — if the audit says a requirement is unmet, the LLM cannot say it's met
- **Must NOT provide legal immigration advice** — only reference the documented F-1 rules and recommend contacting OGS
- **Must NOT guess** about exam scores, transfer credits, or course availability — say "I don't have that information"

---

## PART C: Architecture Summary

```
┌───────────────────────────────────────────────────────┐
│                    Student Input                       │
│  (transcript, AP scores, visa status, question)        │
└──────────────────────┬────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│              DETERMINISTIC CODE LAYER                 │
│                                                       │
│  ┌────────────────┐  ┌────────────────────────────┐  │
│  │ AP/IB/A-Level  │  │ Degree Audit               │  │
│  │ Resolver       │  │ (programs.json rules)      │  │
│  │ [TRANSFER]     │  │ [CS-MAJOR] + [CAS-CORE]    │  │
│  └────────┬───────┘  └────────────┬───────────────┘  │
│           │                       │                   │
│  ┌────────┴───────┐  ┌───────────┴───────────────┐  │
│  │ Credit Cap     │  │ Semester Planner           │  │
│  │ Validators     │  │ (prereqs, risk, balance)   │  │
│  │ [GEN-ACAD]     │  │ [CS-MAJOR] + prereqs.json  │  │
│  └────────┬───────┘  └───────────┬───────────────┘  │
│           │                       │                   │
│  ┌────────┴───────┐  ┌───────────┴───────────────┐  │
│  │ F-1 Enrollment │  │ Academic Standing          │  │
│  │ Validator      │  │ Calculator                 │  │
│  │ [F1-RULES]     │  │ [GEN-ACAD]                 │  │
│  └────────────────┘  └───────────────────────────┘  │
│                                                       │
│  Output: structured JSON (audit, plan, warnings)      │
└──────────────────────┬────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│                   LLM LAYER                           │
│                                                       │
│  System prompt: rules text from [all 5 files]         │
│  Input: structured results from code layer            │
│  Job: explain, advise, answer questions               │
│  Constraint: NEVER contradict code results            │
│                                                       │
│  Output: natural language response to student          │
└──────────────────────────────────────────────────────┘
```

---

## PART D: File Reference Quick Lookup

When implementing a feature, use this table to find the authoritative source:

| Question | Look in |
|---|---|
| "How many CS electives do I need?" | `Major rules CS BA major` lines 52-56 |
| "Does AP Calc count for Core?" | `General rules for transfer credits.md` AP table |
| "Can I take a course P/F?" | `General CAS academic rules.md` → Pass/Fail Option |
| "Am I on track to graduate?" | `General CAS academic rules.md` → General Degree Requirements |
| "What happens if my GPA drops below 2.0?" | `General CAS academic rules.md` → Academic Standing |
| "How many online courses can I take?" | `General CAS academic rules.md` → Credit for Online Courses |
| "Do I need to be full-time?" | `F1 student rule.md` (if F-1/J-1) or `General CAS academic rules.md` (domestic) |
| "What Core courses do I still need?" | `CAS core rules.md` → full component list |
| "Can my IB score exempt me from a course?" | `General rules for transfer credits.md` → IB table |
| "Can I double count a course?" | `General CAS academic rules.md` → Double Counting + `Major rules CS BA major` line 10 |
| "What courses don't count for CS major?" | `Major rules CS BA major` line 9 |
| "Is my transfer credit accepted?" | `General CAS academic rules.md` → Transfer Students |
