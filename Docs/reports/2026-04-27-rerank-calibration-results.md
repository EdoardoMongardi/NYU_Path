Loaded 636 chunks via openai:text-embedding-3-small
# Rerank A/B Calibration

Corpus: 636 chunks. 10 queries × 30-candidate vector search × top-3 display.

## f1-credit-floor — "F-1 international student minimum credits per semester"
Loose oracle: top-1 should mention `12`

- LocalLexical top-1 oracle: PASS (score 0.643)
- Cohere       top-1 oracle: FAIL (score 0.782)

### LocalLexical top-3
1. stern/Semester Course Loads and Credit Limits (rerank=0.643)
      Matriculated full-time students are expected to complete at least 32 credits per academic year. To be in good academic standing, students must complete a minimu…
2. tandon/Minimum Credits and Minimum GPA Required by Semester of Full-Time Study (rerank=0.629)
      Students must maintain a 2.0 GPA or better or performance approaching 2.0 in a steady and realistic fashion. The table below contains the absolute minimum cumul…
3. all/Maturity Certificate Examinations (rerank=0.500)
      The College will consider the results of certain foreign maturity certificate examinations for advanced standing credit. They are: * A Levels and Cambridge Pre-…

### Cohere top-3
1. tandon/Eligibility and Requirements: Students (rerank=0.782)
      F-1 international students are required to complete at least two semesters of full-time study in the United States (U.S.) to be eligible for internship authoriz…
2. stern/Semester Course Loads and Credit Limits (rerank=0.375)
      Matriculated full-time students are expected to complete at least 32 credits per academic year. To be in good academic standing, students must complete a minimu…
3. tandon/Minimum Credits and Minimum GPA Required by Semester of Full-Time Study (rerank=0.366)
      Students must maintain a 2.0 GPA or better or performance approaching 2.0 in a steady and realistic fashion. The table below contains the absolute minimum cumul…

Top-3 overlap: 2 / 3

## cas-pf-deadline — "CAS pass/fail option deadline"
Loose oracle: top-1 should mention `Pass`

- LocalLexical top-1 oracle: PASS (score 0.850)
- Cohere       top-1 oracle: PASS (score 0.805)

### LocalLexical top-3
1. stern/Pass/Fail Option (rerank=0.850)
      The pass/fail option is designed to facilitate flexibility to make curricular decisions as students craft their academic journey. Students are encouraged to mee…
2. cas/Pass/Fail Option (rerank=0.675)
      Students may elect one Pass/Fail option each term, including the summer sessions, for a total of not more than 32 credits during their college career. The Pass/…
3. gallatin/Pass/Fail Grade Option (rerank=0.675)
      Undergraduate students are permitted to request a grade of P/F (pass/fail) for some courses that are normally graded with letter grades (A through F). To make t…

### Cohere top-3
1. stern/Pass/Fail Option (rerank=0.805)
      The pass/fail option is designed to facilitate flexibility to make curricular decisions as students craft their academic journey. Students are encouraged to mee…
2. cas/Pass/Fail Option (rerank=0.785)
      Students may elect one Pass/Fail option each term, including the summer sessions, for a total of not more than 32 credits during their college career. The Pass/…
3. gallatin/Pass/Fail Policy Changes for Spring 2020 Semester Only (rerank=0.672)
      1. Multiple Pass/Fail Option grades were permitted for Spring 2020, even for all courses for which a student was registered. (Normally we permit only one Pass/F…

Top-3 overlap: 2 / 3

## cas-withdrawal — "withdrawal deadline grade of W"
Loose oracle: top-1 should mention `withdraw`

- LocalLexical top-1 oracle: PASS (score 0.900)
- Cohere       top-1 oracle: PASS (score 0.841)

### LocalLexical top-3
1. tandon/Course Withdrawal: The W Grade (rerank=0.900)
      Students may withdraw from a course or courses without academic penalty until the published withdrawal deadline of that particular term. Students should process…
2. gallatin/How Withdrawing Affects Student Records (rerank=0.700)
      Until the last day of the second week of classes for the fall and spring semesters, and until the third day of classes for the six-week summer sessions, dropped…
3. stern/Dropping and Withdrawing from Classes (rerank=0.700)
      At the start of each academic semester, students may access [Albert](https://albert.nyu.edu/) online to adjust their schedule by dropping and adding classes unt…

### Cohere top-3
1. tandon/Course Withdrawal: The W Grade (rerank=0.841)
      Students may withdraw from a course or courses without academic penalty until the published withdrawal deadline of that particular term. Students should process…
2. gallatin/How Withdrawing Affects Student Records (rerank=0.778)
      Until the last day of the second week of classes for the fall and spring semesters, and until the third day of classes for the six-week summer sessions, dropped…
3. liberal_studies/W Grade (rerank=0.722)
      The grade of W (“Withdrawal”) indicates an official withdrawal from a course.

Top-3 overlap: 2 / 3

## credit-overload — "how to take more than 18 credits per semester"
Loose oracle: top-1 should mention `credit`

- LocalLexical top-1 oracle: PASS (score 0.743)
- Cohere       top-1 oracle: PASS (score 0.855)

### LocalLexical top-3
1. stern/Semester Course Loads and Credit Limits (rerank=0.743)
      Matriculated full-time students are expected to complete at least 32 credits per academic year. To be in good academic standing, students must complete a minimu…
2. tandon/Minimum Credits and Minimum GPA Required by Semester of Full-Time Study (rerank=0.686)
      Students must maintain a 2.0 GPA or better or performance approaching 2.0 in a steady and realistic fashion. The table below contains the absolute minimum cumul…
3. tisch/Restrictions and Notes on Registration (rerank=0.600)
      1. Late registration: Students who register after the first week of classes will be charged a late registration fee. Late registration goes into effect one week…

### Cohere top-3
1. stern/Semester Course Loads and Credit Limits (rerank=0.855)
      Matriculated full-time students are expected to complete at least 32 credits per academic year. To be in good academic standing, students must complete a minimu…
2. cas/Academic Program (rerank=0.523)
      The programs and courses offered at the College of Arts and Science are designed for students who attend classes offered during the day on a full-time basis. A …
3. tisch/Restrictions and Notes on Registration (rerank=0.501)
      1. Late registration: Students who register after the first week of classes will be charged a late registration fee. Late registration goes into effect one week…

Top-3 overlap: 2 / 3

## double-counting — "double counting courses between two majors"
Loose oracle: top-1 should mention `major`

- LocalLexical top-1 oracle: PASS (score 0.783)
- Cohere       top-1 oracle: PASS (score 0.905)

### LocalLexical top-3
1. cas/Double Majors and Policy on Double Counting of Courses (rerank=0.783)
      Students may take a double (second) major. The same requirements, including the maintenance of a minimum grade point average of 2.0, apply to the second major a…
2. tisch/Double Major/Minor (rerank=0.633)
      In all Tisch undergraduate departments students may choose to pursue a second major or a minor. The second major or minor may be in another division of NYU or w…
3. cas/Double Counting of Credit (rerank=0.567)
      In some cases, course credit may be applicable to two majors, a major and a minor, or two minors, but only if the academic departments consider this appropriate…

### Cohere top-3
1. cas/Double Majors and Policy on Double Counting of Courses (rerank=0.905)
      Students may take a double (second) major. The same requirements, including the maintenance of a minimum grade point average of 2.0, apply to the second major a…
2. cas/Double Counting of Credit (rerank=0.822)
      In some cases, course credit may be applicable to two majors, a major and a minor, or two minors, but only if the academic departments consider this appropriate…
3. tisch/Double Major/Minor (rerank=0.808)
      In all Tisch undergraduate departments students may choose to pursue a second major or a minor. The second major or minor may be in another division of NYU or w…

Top-3 overlap: 3 / 3

## stern-internal-transfer — "internal transfer requirements to Stern"
Loose oracle: top-1 should mention `Stern`

- LocalLexical top-1 oracle: PASS (score 0.850)
- Cohere       top-1 oracle: PASS (score 0.886)

### LocalLexical top-3
1. stern/Internal Transfer Applicants (rerank=0.850)
      Students who wish to transfer from one school to another within the University must file an [Internal Transfer Application](https://www.nyu.edu/admissions/under…
2. stern/Residency Requirements (rerank=0.600)
      All degree candidates are subject to the following residency requirements: * Students must complete a minimum of 64 credits of business coursework (-UB or equiv…
3. stern/Transfer Credits (rerank=0.600)
      Transfer students from other NYU schools are required to transfer in all graded credits taken at NYU prior to entering Stern with the exception of any advanced …

### Cohere top-3
1. stern/Internal Transfer Applicants (rerank=0.886)
      Students who wish to transfer from one school to another within the University must file an [Internal Transfer Application](https://www.nyu.edu/admissions/under…
2. stern/Transfer Credits (rerank=0.852)
      Transfer students from other NYU schools are required to transfer in all graded credits taken at NYU prior to entering Stern with the exception of any advanced …
3. stern/External Transfer Applicants (rerank=0.794)
      Transfer applicants to Stern are considered for fall admission only. Admission of external transfers is limited by space availability. Students wishing to trans…

Top-3 overlap: 2 / 3

## stern-residency — "Stern residency credit requirement"
Loose oracle: top-1 should mention `Stern`

- LocalLexical top-1 oracle: FAIL (score 0.675)
- Cohere       top-1 oracle: PASS (score 0.866)

### LocalLexical top-3
1. tandon/Residency Requirement (rerank=0.675)
      To satisfy the residency requirement for the BS degree, NYU Tandon School of Engineering students must complete a minimum of at least half of the required credi…
2. liberal_studies/Residency Requirements (rerank=0.600)
      The Liberal Studies Core is a four-semester program. Students planning to transition to one of the baccalaureate programs at NYU normally must complete four sem…
3. stern/Residency Requirements (rerank=0.600)
      All degree candidates are subject to the following residency requirements: * Students must complete a minimum of 64 credits of business coursework (-UB or equiv…

### Cohere top-3
1. stern/Residency Requirements (rerank=0.866)
      All degree candidates are subject to the following residency requirements: * Students must complete a minimum of 64 credits of business coursework (-UB or equiv…
2. stern/Writing (rerank=0.772)
      All students entering Stern as first year students are required to complete an 8-credit writing sequence. No credit toward degree requirements is currently gran…
3. stern/Mathematics (rerank=0.749)
      * All students entering Stern as first year students are required to fulfill a 4-credit mathematics course. Students who earn a 4 or 5 on the AB or BC Calculus …

Top-3 overlap: 1 / 3

## advanced-standing-cap — "advanced standing credit cap CAS"
Loose oracle: top-1 should mention `advanced standing`

- LocalLexical top-1 oracle: PASS (score 0.740)
- Cohere       top-1 oracle: PASS (score 0.781)

### LocalLexical top-3
1. cas/Advanced Standing Credit (rerank=0.740)
      Advanced Placement (AP), A Level, International Baccalaureate (IB), or equivalent credits place students out of one or both of [ECON-UA 1](/search/?P=ECON-UA%20…
2. all/Advanced Standing Credit by Examination (Including International Maturity Examinations) (rerank=0.740)
      The Advanced Placement (AP) Program (College Entrance Examination Board), the International Baccalaureate (IB) Program, and the results of some foreign maturity…
3. liberal_studies/Advanced Standing Credits (rerank=0.680)
      Advanced standing credits are college credits earned before entering NYU. Examples of advanced standing credits include those earned at other accredited college…

### Cohere top-3
1. all/Advanced Standing Credit by Examination (Including International Maturity Examinations) (rerank=0.781)
      The Advanced Placement (AP) Program (College Entrance Examination Board), the International Baccalaureate (IB) Program, and the results of some foreign maturity…
2. liberal_studies/Advanced Standing Credits (rerank=0.781)
      Advanced standing credits are college credits earned before entering NYU. Examples of advanced standing credits include those earned at other accredited college…
3. cas/College Credits Taken in Secondary School by First-Year Matriculants in CAS (Dual Enrollment) (rerank=0.702)
      Credit may be awarded to students who completed college courses while in high school (credits from either a community college or a four-year college or universi…

Top-3 overlap: 2 / 3

## minor-basics — "CAS minor declaration rules"
Loose oracle: top-1 should mention `minor`

- LocalLexical top-1 oracle: PASS (score 0.700)
- Cohere       top-1 oracle: PASS (score 0.606)

### LocalLexical top-3
1. cas/Academic Policies (rerank=0.700)
      On This Page * [General Degree Requirements](#text) + [College Core Curriculum Requirements](#text)* [Residency Requirements](#text) * [The Major](#text) + [Dec…
2. tandon/NYU Cross-School Minors (rerank=0.525)
      Visit the [NYU Tandon Minors](http://engineering.nyu.edu/academics/minors#NYU%20Cross-School%20Minors) webpage for more detailed information on the [cross-schoo…
3. cas/Regulations Pertaining to Both the Major and Minor (rerank=0.425)
      The major and minor requirements to be followed are those stated in the departmental sections of the Bulletin in effect during the semester of the student's fir…

### Cohere top-3
1. cas/The Minor (rerank=0.606)
      The minor requirements are found in the departmental sections of the Bulletin. The (optional) minor must be completed with a minimum grade point average of 2.0.…
2. cas/Academic Policies (rerank=0.593)
      On This Page * [General Degree Requirements](#text) + [College Core Curriculum Requirements](#text)* [Residency Requirements](#text) * [The Major](#text) + [Dec…
3. stern/Declaring a Second Major in CAS (rerank=0.550)
      A second major from the College of Arts and Science can be declared to augment a student's primary degree program. Students looking to pursue this option are en…

Top-3 overlap: 1 / 3

## tandon-residency — "Tandon engineering residency requirement"
Loose oracle: top-1 should mention `Tandon`

- LocalLexical top-1 oracle: PASS (score 0.850)
- Cohere       top-1 oracle: PASS (score 0.925)

### LocalLexical top-3
1. tandon/Residency Requirement (rerank=0.850)
      To satisfy the residency requirement for the BS degree, NYU Tandon School of Engineering students must complete a minimum of at least half of the required credi…
2. tandon/Transfer Credits from other Undergraduate Institutions (rerank=0.525)
      Students who have completed undergraduate coursework at other universities prior to beginning their studies at NYU Tandon School of Engineering are encouraged t…
3. tandon/Degrees with Honors (rerank=0.525)
      The NYU Tandon School of Engineering adheres to New York University’s Latin Honors requirements. Latin Honors are given to Baccalaureate degree recipients who h…

### Cohere top-3
1. tandon/Residency Requirement (rerank=0.925)
      To satisfy the residency requirement for the BS degree, NYU Tandon School of Engineering students must complete a minimum of at least half of the required credi…
2. tandon/Transfer Credits While in Residence (rerank=0.841)
      Undergraduates at the NYU Tandon School of Engineering are expected to complete all coursework at the School. Exceptions are rare and only made in cases where T…
3. tandon/Degrees with Honors (rerank=0.827)
      The NYU Tandon School of Engineering adheres to New York University’s Latin Honors requirements. Latin Honors are given to Baccalaureate degree recipients who h…

Top-3 overlap: 2 / 3

## Summary

- LocalLexical top-1 oracle pass rate: **9 / 10** (90%)
- Cohere       top-1 oracle pass rate: **9 / 10** (90%)
- Both passed:  8 / 10

**Caveat:** the loose-substring oracle is a sanity floor, not a calibration. The real cohort-A composite measurement runs at Step 25.
