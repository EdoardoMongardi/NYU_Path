/**
 * Comprehensive academic rules knowledge base for LLM advisory.
 *
 * This string constant is injected into the LLM system prompt so it can
 * reason about CS BA major rules, CAS core curriculum, AP/IB/A-Level
 * transfer credits, FYSEM policies, and workload balancing.
 */

export const ACADEMIC_RULES = `
=== CS BA MAJOR RULES (College of Arts & Science) ===

DEGREE REQUIREMENTS:
- 12 courses / 48 credits minimum
- Minimum GPA: 2.0
- Only grades of "C" or higher count toward the major
- P/F grades are NOT applicable
- Minimum 32 credits must have the CSCI-UA designation
- 50% of major courses must be completed at CAS (residency requirement)
- Max 2 courses can be double-counted across majors/minors

CORE REQUIREMENTS (7 courses):
1. CSCI-UA 101 — Introduction to Computer Science (prereq: CSCI-UA 2 or 3 or placement exam)
2. CSCI-UA 102 — Data Structures (prereq: CSCI-UA 101)
3. CSCI-UA 201 — Computer Systems Organization (prereq: CSCI-UA 102)
4. CSCI-UA 202 — Operating Systems (prereq: CSCI-UA 201)
5. CSCI-UA 310 — Basic Algorithms (prereqs: CSCI-UA 102 + MATH-UA 120 + MATH-UA 121)
6. MATH-UA 121 — Calculus I
7. MATH-UA 120 — Discrete Mathematics

ELECTIVES (5 courses):
- Must be numbered CSCI-UA 4xx (400-level)
- Elective offerings vary each fall and spring semester
- One elective option is offered in summer
- If elective list for the target semester hasn't been published yet, inform student to wait

MATH SUBSTITUTION POLICY:
- Students may substitute up to 2 of the 5 electives with these Math courses:
  • MATH-UA 122 (Calculus II)
  • MATH-UA 140 (Linear Algebra)
  • MATH-UA 185 (Probability and Statistics)
- Maximum of 2 math substitutions allowed

CREDIT DISTRIBUTION OPTIONS (12 courses / 48 credits):
- 10 CS (40 cr) + 2 Math (8 cr) = 83% CS, 17% Math
- 9 CS (36 cr) + 3 Math (12 cr) = 75% CS, 25% Math
- 8 CS (32 cr) + 4 Math (16 cr) = 67% CS, 33% Math (minimum 32 CSCI-UA credits)

COURSES NOT APPLICABLE TO CS MAJOR:
CSCI-UA 2, 4, 60, 61, 330, 380, 381, 520/521, 897/898, 997/998

DECLARATION REQUIREMENT:
- Must complete CSCI-UA 101 (or higher) with grade C or better before declaring

RESTRICTIONS:
- Tandon students cannot declare CS major at CAS
- Data Science majors cannot double-major in CS, CS/Math, or CS/Econ

PLACEMENT EXAM POLICY:
- Passing a placement exam does NOT earn credit
- If the placed-out course is required for the major, it must be replaced with a CSCI-UA 400-level elective

AP/IB/A-LEVEL CREDITS:
- College Board AP credits, A Levels, IB HL scores, internal NYU Study Abroad courses DO NOT satisfy CAS residency requirement
- AP CS A (score 4/5): equivalent to CSCI-UA 101, but does NOT count toward CS major (only toward minor in Web Programming)
- AP CS Principles (score 4/5): equivalent to CSCI-UA 2/3, elective credit only — not for CS major
- IB CS HL (score 6/7): equivalent to CSCI-UA 101 + 102 — must consult CS department about counting toward major
- A-Level CS (grade B+): equivalent to CSCI-UA 101 + 102 — must consult CS department about counting toward major

=== CAS CORE CURRICULUM ===

WRITING:
- Expository Writing (EXPOS-UA 1 or EXPOS-UA 9)

FIRST-YEAR SEMINAR (FYSEM):
- Course prefix: FYSEM-UA
- CRITICAL: Can ONLY be taken during first year (freshman fall or spring)
- If a student is past their first year and hasn't taken it, do NOT suggest it — inform them it was a first-year-only requirement
- If suggesting to a freshman, recommend taking it in fall or spring of their first year
- The specific FYSEM courses offered change each semester
- If the course list for the target semester hasn't been published yet, tell the student to wait for the list to be released
- Examples of past FYSEM courses: Complexities: Ocean, Journalism of War, Game Theory and the Humanities, Heroic Journeys: Homer, Virgil, Dante, History of Italian Opera, Reading Freud, Language and Migration, What is Horror?, etc.

FOREIGN LANGUAGE:
- Intermediate proficiency required
- Satisfied by: AP 4/5 in any language, IB HL 6/7 in any language, A-Level B+ in any language
- Students continuing a language at NYU must take CAS placement exam

FOUNDATIONS OF CONTEMPORARY CULTURE (FCC) — 4 courses:
1. Texts and Ideas (CORE-UA 500 series)
2. Cultures and Contexts (CORE-UA 600 series)
3. Societies and Social Sciences (CORE-UA 700 series)
4. Expressive Culture (CORE-UA 800 series)

FOUNDATIONS OF SCIENTIFIC INQUIRY (FSI) — 3 courses:
1. Quantitative Reasoning (CORE-UA 100 series)
2. Physical Science
3. Life Science
NOTE: CS majors are generally exempt from FSI requirements, but check individual student's audit.

=== AP CREDIT EQUIVALENCIES (Complete) ===

GENERAL AP RULES:
- Scores of 4 or 5 required (except Russian Language: 5 only)
- Max 32 exam credits toward degree (combined AP + IB + A-Level)
- Cannot earn credit for same subject via multiple exam types
- Taking the corresponding college course forfeits AP credit
- No credit for AP Seminar or Research (Capstone program)

AP EXAM → COURSE EQUIVALENT → CORE SATISFACTION:

Art History:
  Score 4 → 4 cr, ARTH-UA elective (not for major/minor)
  Score 5 → 4 cr, ARTH-UA 10 (exempts majors from ARTH-UA 10)

Biology:
  Score 4/5 → 8 cr, BIOL-UA 11 + BIOL-UA 12
  Core: Satisfies LIFE SCIENCE + PHYSICAL SCIENCE
  Note: Prehealth students cannot use to place out of BIOL-UA 11/12

Calculus AB:
  Score 4/5 → 4 cr, MATH-UA 121
  Core: Satisfies QUANTITATIVE REASONING
  Note: Econ majors cannot use for MATH-UA 131/132/133

Calculus BC:
  Score 4/5 → 8 cr, MATH-UA 121 + MATH-UA 122
  Core: Satisfies QUANTITATIVE REASONING
  AB subscore 4/5 (if BC < 4) → 4 cr, MATH-UA 121
  Note: Econ majors cannot use for MATH-UA 131/132/133

Chemistry:
  Score 4/5 → 8 cr, CHEM-UA 125 + CHEM-UA 126
  Core: Satisfies PHYSICAL SCIENCE + LIFE SCIENCE
  Note: Not for Bio/Chem majors/minors; prehealth cannot place out

Chinese Language:
  Score 4/5 → 8 cr, EAST-UA 204
  Core: Satisfies FOREIGN LANGUAGE
  Note: Cannot use for placement; must take CAS placement exam

Computer Science A:
  Score 4/5 → 4 cr, CSCI-UA 101
  Core: None
  Note: Counts toward Web Programming minor ONLY, NOT CS major

Computer Science Principles:
  Score 4/5 → 4 cr, CSCI-UA 2 or CSCI-UA 3
  Core: None
  Note: Elective credit only, not for any CS program

English Language/Literature:
  Score 4/5 → 4 cr, elective
  Core: None

Environmental Science:
  Score 4/5 → 4 cr, elective
  Core: Satisfies PHYSICAL SCIENCE
  Note: Not for Environmental Studies major/minor

European/US/World History:
  Score 4/5 → 4 or 8 cr, elective
  Core: None
  Note: Max 4 AP cr toward History major

French Language:
  Score 4/5 → 8 cr, FREN-UA 30
  Core: Satisfies FOREIGN LANGUAGE

German Language:
  Score 4/5 → 8 cr, GERM-UA 4
  Core: Satisfies FOREIGN LANGUAGE

Government & Politics (US or Comparative):
  Score 4/5 → 4 or 8 cr, POL-UA elective
  Core: None

Italian Language:
  Score 4/5 → 8 cr, ITAL-UA 12
  Core: Satisfies FOREIGN LANGUAGE

Japanese Language:
  Score 4/5 → 8 cr, EAST-UA 250
  Core: Satisfies FOREIGN LANGUAGE
  Note: Cannot use for placement at NYU

Latin:
  Score 4/5 → 8 cr, CLASS-UA 6
  Core: Satisfies FOREIGN LANGUAGE

Macroeconomics:
  Score 4/5 → 4 cr, ECON-UA 1
  Core: None
  Note: Satisfies Econ major/minor intro requirement

Microeconomics:
  Score 4/5 → 4 cr, ECON-UA 2
  Core: None
  Note: Satisfies Econ major/minor intro requirement

Music Theory:
  Score 4/5 → 4 cr, elective
  Core: None
  Note: Not for Music major/minor

Physics 1 (algebra-based):
  Score 4/5 → 4 cr, PHYS-UA 11
  Core: Satisfies PHYSICAL SCIENCE
  Note: Not for Physics major/minor; prehealth cannot place out

Physics 2 (algebra-based):
  Score 4/5 → 4 cr, PHYS-UA 12
  Core: Satisfies PHYSICAL SCIENCE
  Note: Not for Physics major/minor; cannot combine with Physics C E&M

Physics C: Mechanics:
  Score 4/5 → 4 cr, PHYS-UA 11 (or PHYS-UA 91 with dept approval)
  Core: Satisfies PHYSICAL SCIENCE

Physics C: Electricity & Magnetism:
  Score 4/5 → 4 cr, PHYS-UA 12 (or PHYS-UA 93 with dept approval)
  Core: Satisfies PHYSICAL SCIENCE
  Note: Cannot combine with Physics 2

Precalculus:
  Score 4/5 → 4 cr, MATH-UA 9 (prerequisite satisfaction only)
  Core: None
  Note: NEVER counts toward any major/minor or Core requirement

Psychology:
  Score 4/5 → 4 cr, PSYCH-UA 1
  Core: None

Spanish Language:
  Score 4 → 8 cr, SPAN-UA 4
  Score 5 → 8 cr, SPAN-UA 50
  Core: Satisfies FOREIGN LANGUAGE
  Note: Non-natives must take placement exam; scores >18 months old invalid for placement

Spanish Literature:
  Score 4/5 → 8 cr, SPAN-UA 50
  Core: Satisfies FOREIGN LANGUAGE

Statistics:
  Score 4/5 → 4 cr, PSYCH-UA 10
  Core: None
  Note: Satisfies Psych stats requirement; NOT for Econ/IR/Sociology/Business Studies

African American Studies:
  Score 4/5 → 4 cr, elective
  Note: May be applicable to Social and Cultural Analysis; consult department

=== IB CREDIT EQUIVALENCIES (Complete) ===

GENERAL IB RULES:
- Only Higher Level (HL) exams, NEVER Standard Level (SL)
- Score of 6 or 7 required
- Cannot earn credit for same subject via AP + IB + A-Level
- "B" language = second language (intermediate level)
- "A" language = native/near-native (post-intermediate level)
- Students with "A" language credits continuing the language must take CAS placement exam

IB EXAM (HL) → COURSE EQUIVALENT → CORE SATISFACTION:

Math: Analysis and Approaches HL:
  Score 6 → 4 cr, MATH-UA 121
  Score 7 → 8 cr, MATH-UA 121 + MATH-UA 122
  Core: Satisfies QUANTITATIVE REASONING
  Note: Score 7 students entering Calc III should review polar coordinates/parametric equations

Math: Applications and Interpretation HL:
  Score 6/7 → 4 cr, MATH-UA 121
  Core: Satisfies QUANTITATIVE REASONING

Biology HL:
  Score 6/7 → 8 cr, BIOL-UA 11 + BIOL-UA 12
  Core: Satisfies PHYSICAL SCIENCE + LIFE SCIENCE
  Note: Prehealth cannot place out; non-prehealth consult Bio department

Chemistry HL:
  Score 6/7 → 8 cr, CHEM-UA 125 + CHEM-UA 126
  Core: Satisfies PHYSICAL SCIENCE + LIFE SCIENCE
  Note: Not for Bio/Chem majors/minors; prehealth cannot place out

Chinese B/A HL:
  Score 6/7 → 8 cr, EAST-UA 203/204
  Core: Satisfies FOREIGN LANGUAGE
  Note: Must take CAS placement exam for registration

Classical Languages (Greek/Latin) HL:
  Score 6/7 → 8 cr, CLASS-UA 9/10 or 5/6
  Core: Satisfies FOREIGN LANGUAGE
  Note: Consult Classics department for placement

Computer Science HL:
  Score 6/7 → 8 cr, CSCI-UA 101 + CSCI-UA 102
  Core: None
  Note: MUST consult CS department about counting toward major/minor

Economics HL:
  Score 6/7 → 8 cr, ECON-UA 1 + ECON-UA 2
  Core: None
  Note: Satisfies Econ major/minor intro requirements

English A/B HL:
  No credit awarded for English B; Anglophones cannot take English A

French B/A HL:
  Score 6/7 → 8 cr, FREN-UA 11/12
  Core: Satisfies FOREIGN LANGUAGE

German B/A HL:
  Score 6/7 → 8 cr, GERM-UA 3/4
  Core: Satisfies FOREIGN LANGUAGE

Hebrew B/A HL:
  Score 6/7 → 8 cr, HBRJD-UA 3/4
  Core: Satisfies FOREIGN LANGUAGE

History (any) HL:
  Score 6/7 → 8 cr, elective
  Note: Max 4 of 8 credits toward History major; not for minor

Italian B/A HL:
  Score 6/7 → 8 cr, ITAL-UA 11/12
  Core: Satisfies FOREIGN LANGUAGE

Japanese B/A HL:
  Score 6/7 → 8 cr, EAST-UA 249/250
  Core: Satisfies FOREIGN LANGUAGE

Korean B/A HL:
  Score 6/7 → 8 cr, EAST-UA 256/257
  Core: Satisfies FOREIGN LANGUAGE

Philosophy HL:
  Score 7 → 8 cr, PHIL-UA 1 + elective (4 cr toward major/minor)
  Score 6 → 8 cr, elective only

Physics HL:
  Score 6/7 → 8 cr, elective
  Core: Satisfies PHYSICAL SCIENCE + LIFE SCIENCE
  Note: Not for Physics or Chemistry majors/minors

Psychology HL:
  Score 6/7 → 8 cr, PSYCH-UA 1 + elective
  Note: 4 cr exempt from PSYCH-UA 1 for major/minor

Government & Politics HL:
  Score 6/7 → 8 cr, POL-UA elective
  Note: Max 8 cr (2 courses) toward Politics major; 4 cr toward minor

Portuguese B/A HL:
  Score 6/7 → 8 cr, PORT-UA 3/4
  Core: Satisfies FOREIGN LANGUAGE

Russian B/A HL:
  Score 6/7 → 8 cr, RUSSN-UA 3/4
  Core: Satisfies FOREIGN LANGUAGE

Social & Cultural Anthropology HL:
  Score 6/7 → 8 cr, ANTH-UA 1+ elective
  Core: None

Spanish B/A HL:
  Score 6/7 → 8 cr, SPAN-UA 3/4
  Core: Satisfies FOREIGN LANGUAGE
  Note: Must take CAS placement exam; scores >18 months old invalid

=== A-LEVEL CREDIT EQUIVALENCIES (Complete) ===

GENERAL A-LEVEL RULES:
- Minimum score: B (Pre-U minimum: M2)
- No credit for AS-Level exams
- Cannot earn credit for same subject via AP + IB + A-Level
- 8 credits awarded per qualifying exam
- Singapore: only H2/H3 exams; no credit for both H2 and H3 in same subject
- Pre-U acceptable score range (low to high): M2, M1, D3, D2, D1

A-LEVEL EXAM → COURSE EQUIVALENT → CORE SATISFACTION:

Biology:
  Grade B+ → 8 cr, BIOL-UA 11 + BIOL-UA 12
  Core: Satisfies PHYSICAL SCIENCE + LIFE SCIENCE
  Note: Prehealth cannot place out

Chemistry:
  Grade B+ → 8 cr, CHEM-UA 125 + CHEM-UA 126
  Core: Satisfies PHYSICAL SCIENCE + LIFE SCIENCE
  Note: Not for Bio/Chem majors/minors; prehealth cannot place out

Chinese:
  Grade B+ → 8 cr, EAST-UA 203/204
  Core: Satisfies FOREIGN LANGUAGE
  Note: Must take CAS placement exam

Classical Languages (Greek/Latin):
  Grade B+ → 8 cr, CLASS-UA 9/10 or 5/6
  Core: Satisfies FOREIGN LANGUAGE
  Note: Consult Classics department for placement

Computer Science:
  Grade B+ → 8 cr, CSCI-UA 101 + CSCI-UA 102
  Core: None
  Note: MUST consult CS department about counting toward major/minor

Economics:
  Grade B+ → 8 cr, ECON-UA 1 + ECON-UA 2
  Core: None

French:
  Grade B+ → 8 cr, FREN-UA 11/12
  Core: Satisfies FOREIGN LANGUAGE

German:
  Grade B+ → 8 cr, GERM-UA 3/4
  Core: Satisfies FOREIGN LANGUAGE

History (any):
  Grade B+ → 8 cr, elective
  Note: Max 4 of 8 credits toward History major

History of Art:
  Grade B → 8 cr, ARTH-UA elective (not for major/minor)
  Grade A → 8 cr, 4 cr toward Art History major
  Note: Never counts toward minor

Italian:
  Grade B+ → 8 cr, ITAL-UA 11/12
  Core: Satisfies FOREIGN LANGUAGE

Latin:
  Grade B+ → 8 cr, CLASS-UA 5/6
  Core: Satisfies FOREIGN LANGUAGE

Mathematics:
  Grade B+ → 8 cr, MATH-UA 121 (Calculus I) equivalent
  Core: Satisfies QUANTITATIVE REASONING
  Note: Further/Pure Mathematics — consult Math department for equivalencies
  Note: Econ majors cannot use for MATH-UA 131/132/133

Philosophy:
  Grade A → 8 cr, 4 cr toward PHIL-UA 1 (major/minor intro)
  Grade B → 8 cr, elective only

Physics:
  Grade B+ → 8 cr, elective
  Core: Satisfies PHYSICAL SCIENCE + LIFE SCIENCE
  Note: Not for Physics or Chemistry majors/minors

Portuguese:
  Grade B+ → 8 cr, PORT-UA 3/4
  Core: Satisfies FOREIGN LANGUAGE

Psychology:
  Grade B+ → 8 cr, PSYCH-UA 1 + elective
  Note: 4 cr exempt from PSYCH-UA 1 for major/minor

Religious Studies:
  Grade B+ → 8 cr, elective
  Note: Cannot count toward Religious Studies major/minor

Sociology:
  Grade B+ → 8 cr, elective
  Note: 4 cr toward major with dept approval; cannot exempt from SOC-UA 1/2

Spanish:
  Grade B+ → 8 cr, SPAN-UA 3/4
  Core: Satisfies FOREIGN LANGUAGE
  Note: Non-natives placement exam required; scores >18 months old invalid

Statistics:
  Grade B+ → 8 cr, elective
  Core: Satisfies QUANTITATIVE REASONING
  Note: Not for Econ/IR/Sociology/Business Studies; consult Math/Psych for equivalency
  Note: Cannot get full 8 cr for each if presenting multiple math A-Level exams

Any other Foreign Language:
  Grade B+ (A-Level) or M2+ (Pre-U) → satisfies FOREIGN LANGUAGE Core requirement

=== FIRST-YEAR SEMINAR (FYSEM) RULES ===

- Course prefix: FYSEM-UA
- ONLY available to first-year (freshman) students
- Must be taken in freshman fall or freshman spring
- If a student is past their first year and has NOT taken FYSEM, do NOT recommend it — inform them this was a first-year-only requirement
- If recommending to a current freshman who hasn't taken it yet:
  - If in freshman fall: recommend for fall or spring
  - If in freshman spring and not yet taken: recommend for spring (last chance)
- FYSEM courses change every semester and cover diverse topics
- If the specific FYSEM courses for the target semester have not been published yet, inform the student to check back when the course list is released

=== WORKLOAD & COURSE SWAP ADVISORY ===

F-1 VISA STUDENTS:
- Must maintain minimum 12 credits per semester (full-time status)

TYPICAL LOAD:
- Standard: 4 courses (16 credits)
- Heavy: 4+ courses or 3+ major requirement courses in one semester
- Light: Fewer than 4 courses (check F-1 status requirements)

WORKLOAD ASSESSMENT:
- Major core courses (CSCI-UA 201, 202, 310) are significantly harder than electives
- Taking 3+ core CS courses in one semester is considered heavy
- Free electives are generally easier than major courses
- Balance is key: mix required courses with lighter electives

COURSE SWAP EVALUATION:
- If student wants to swap a required course for an elective: WARN about pushing harder courses to future semesters if swapping will force the student to have a semester with three major core courses.
- If student loads 4+ free electives in one semester: WARN about heavier future semesters
- If student drops below 12 credits: WARN about F-1 visa implications
- Consider remaining semesters until graduation when advising swaps
- If a swap doesn't affect graduation timeline and the student has good reasons, support it
`;
