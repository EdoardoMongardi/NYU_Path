# Eval Set Provenance — Phase-5-prep Model Bakeoff

> **Frozen:** 2026-04-26
> **Authored by:** independent eval-set author (no engine implementation context)
> **Files in this set:** `tool_selection.json` (18 cases), `synthesis.json` (18 cases), `decomp.json` (10 cases)
> **Total cases:** 46
> **Source-of-truth philosophy:** `nyupath_implementation_philosophy.md` — bulletin first, no invention, cite or stop.

Citations point to the bulletin file path, the line number when applicable, and the Architecture section that justifies the rubric. For counter-cases (forbidden claims), the rationale is given.

Throughout this document, paths under `data/bulletin-raw/` are relative to the repo root, and Architecture sections refer to `ARCHITECTURE.md`.

---

## File 1 — `tool_selection.json` (18 cases)

The tool registry is in §7.1 (table) and §7.2 (per-tool definition). Every TS-Tool case must map to one tool name in {`run_full_audit`, `plan_semester`, `search_policy`, `check_transfer_eligibility`, `what_if_audit`, `update_profile`}.

### tool-001 — "How far along am I in my degree…"
- **Architecture:** §7.1 row `run_full_audit` — *"Any question about degree progress, remaining requirements"*. §7.2 `run_full_audit.prompt()` — *"Call when student asks about progress, remaining requirements, or graduation."*
- **Bulletin:** `data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md:86` — *"To be eligible for the bachelor's degree, students must complete 128 credits with a cumulative grade point average of at least 2.0."* The number-of-credits-remaining concept is bulletin-defined; the model must call the deterministic tool that computes it (Cardinal Rule §2.1).

### tool-002 — "Pull up my degree audit…"
- **Architecture:** §7.1 row `run_full_audit`; §7.2 audit.summarizeResult mentions *"Audit: N requirements remaining"*. Direct lexical match for the audit tool.
- **Bulletin:** `…/academic-policies/_index.md:162` — *"The Albert Degree Progress Report is the assessment tool used by the University to determine degree completion."* The audit concept is grounded in the bulletin's degree-progress framework.

### tool-003 — "What is my current cumulative GPA?"
- **Architecture:** §7.1 (`get_academic_standing` row — *"GPA, SAP, standing status"*). §9.1 Part 4b table — GPA claims require `get_academic_standing` invocation. §2.1 Cardinal Rule — *"every number a student sees (GPA, credits remaining, completion rate) comes from a deterministic tool."*
- **Implementation note:** This case pins `run_full_audit` because §7.2's `summarizeResult` for `run_full_audit` *also* returns `cumulativeGPA`, and §6.5.2 system prompt rule 5 says *"Before discussing CREDIT COUNTS, GPA, GRADUATION PROGRESS… call at minimum: get_academic_standing → get_credit_caps."* Either tool is defensible — the test is that the model **does NOT synthesize a GPA from training data or context**. The eval-harness code can soft-accept either tool name; the JSON pins the most general (`run_full_audit`) but the rubric note documents the variance.
- **Counter-case rationale:** This case's **forbidden** behavior is "answer 3.X without calling any tool" (§9.1 Part 4b: "Block + re-prompt").

### tool-004 — "I'm registering for next term in two weeks…"
- **Architecture:** §7.1 row `plan_semester` — *""Plan my next semester", "What should I take?""*. §7.2 `plan_semester.prompt()` — *"Call when student asks about next semester or course recommendations."*
- **Bulletin:** `…/academic-policies/_index.md:500` — *"A full-time schedule normally consists of 16 credits per term."* Default `maxCredits=16` aligns with bulletin.
- **Note:** The expectedArgsShape pins `term`, `year` shape only — the model must decide the semester values from "next term" + the date context (2026-04-26 → next term ~ Fall 2026), but the eval doesn't pin those exactly because shape-match is the §6.5.1 grading rule.

### tool-005 — "Catching up over Summer 2026…"
- **Architecture:** §7.1 `plan_semester`. The `term` enum in `inputSchema` includes `'summer'`.
- **Bulletin:** `…/academic-policies/_index.md:410` — Pass/Fail option *"each term, including the summer sessions"* — confirms summer is a valid registration term.

### tool-006 — "I'm in CAS now but I want to move over to Stern…"
- **Architecture:** §7.1 row `check_transfer_eligibility` — *""Can I transfer to Stern?", "Am I eligible?""*. §7.2 `check_transfer_eligibility.prompt()` — *"Call when student asks about transferring between NYU schools."* Argument shape requires `targetSchool`.
- **Bulletin:** `…/academic-policies/_index.md:63` — *"Students who wish to transfer from one school to another within the University must file an internal transfer application…"* And `…/student-services/advising/_index.md:72` — references the *"College of Arts and Science Pathway with the Stern School of Business."*

### tool-007 — "What would I need to switch into Tandon for engineering?"
- **Architecture:** §7.1 `check_transfer_eligibility`.
- **Bulletin:** `…/student-services/advising/_index.md:74` — references *"Joint BS/BS Program in Engineering (with the NYU Tandon School of Engineering)"*. Tandon is a recognized internal-transfer target.

### tool-008 — "If I picked up a Math minor on top of what I have now…"
- **Architecture:** §7.1 row `what_if_audit` — *""What if I switch to Econ?", "Compare CS vs Math""*. §7.2 `what_if_audit.prompt()` — *"Call when student asks 'what if I switched to…', 'compare X vs Y', or 'should I major in…'"*
- **Bulletin:** `…/academic-policies/_index.md:130` — *"The minor requirements are found in the departmental sections of the Bulletin. The (optional) minor must be completed with a minimum grade point average of 2.0."* — minor declaration is bulletin-grounded.

### tool-009 — "Compare what's left for me as a CS major versus an Economics major…"
- **Architecture:** §7.1 `what_if_audit`. `hypotheticalPrograms` is `array(string)` with no fixed cardinality — supports comparison of two.
- **Bulletin:** `…/academic-policies/_index.md:108` — *"Major requirements, varying from department to department, are specified in the sections of this Bulletin."* Comparing two majors is grounded in the bulletin's per-major-program structure.

### tool-010 — "Take a course required for my major Pass/Fail?"
- **Architecture:** §7.1 row `search_policy` — *"Policy questions, P/F rules, petition processes."* §7.2 `search_policy.prompt()` — *"NEVER answer a policy question from training data — always call this tool and cite the result."*
- **Bulletin:** `…/academic-policies/_index.md:138` — *"No course to be counted toward the major or minor may be taken on a Pass/Fail basis."* And `…/academic-policies/_index.md:414` (Pass/Fail Option section). Direct policy match.
- **Curated template:** `data/policy_templates/cas_pf_major.json` — exists for exactly this query.

### tool-011 — "Hard cap on credits per semester at CAS?"
- **Architecture:** §7.1 `search_policy`.
- **Bulletin:** `…/academic-policies/_index.md:500` — *"Students may register for more than 18 credits per term with the approval and clearance of their academic adviser."*
- **Curated template:** `data/policy_templates/cas_credit_overload.json`.

### tool-012 — "Online course toward my CAS degree, is there a limit?"
- **Architecture:** §7.1 `search_policy`.
- **Bulletin:** `…/academic-policies/_index.md:268` — *"By vote of the faculty in Fall 2024, this limit is now raised to 24 credits."* And `…/academic-policies/_index.md:272` — *"Online courses cannot meet the requirements of any CAS major or minor unless they are accepted and approved by the department's director of undergraduate studies."*

### tool-013 — "Latest in the term I can drop a course and have it just disappear from my transcript?"
- **Architecture:** §7.1 `search_policy`.
- **Bulletin:** `…/academic-policies/_index.md:516` — *"Courses dropped during the first two weeks of the term will not appear on the transcript. Those dropped from the beginning of the third week through the 14th week of the term will be recorded with a grade of W."* Direct match.

### tool-014 — "How many courses can I share between two majors?"
- **Architecture:** §7.1 `search_policy`.
- **Bulletin:** `…/academic-policies/_index.md:126` — *"No student may double count more than two courses between two majors (or between a major and a minor, or between two minors)…"* Direct match.

### tool-015 — "Officially declared my Politics major last week."
- **Architecture:** §7.1 row `update_profile` — *"Student corrects/adds info: 'I declared a minor.'"* §7.2 `update_profile`'s `inputSchema.field` enum includes `'declaredPrograms'`. Table at §7.2 — *"I officially declared CS"* → `update_profile` with status change.
- **Bulletin:** `…/academic-policies/_index.md:120` — *"Students must visit the office of the department or program to declare a major and have it posted in the Student Information System (Albert)."* The student is reporting a real-world event the system must mirror.

### tool-016 — "Update my graduation plan to Spring 2027."
- **Architecture:** §7.2 `update_profile.inputSchema.field` enum includes `'targetGraduationTerm'`. §7.2 post-mutation table — `targetGraduationTerm` mutation triggers re-run of `plan_semester`.
- **Bulletin:** `…/academic-policies/_index.md:162` — *"Students who do not successfully complete all academic requirements by the end of that semester must reapply for graduation for the following term."* Graduation term is a tracked profile field.

### tool-017 — "Remove AP Calc BC from my profile."
- **Architecture:** §7.2 `update_profile` example: *"I actually don't have AP Calc"* → *"Yes — after confirmation"*. `field` enum includes `'transferCourses'`.
- **Bulletin:** `…/admissions/_index.md:39` — *"Credit may be awarded to students who completed college courses while in high school… provided that they received a grade of C or better."* AP credit is bulletin-tracked transfer credit.

### tool-018 — "Am I on track to graduate on time?" (counter-case)
- **Architecture:** §7.1 `run_full_audit` — graduation progress is the audit's job. §A.System-Prompt rule 17 — *"NEVER say 'all requirements met' unless run_full_audit returned overall status === 'complete' for EVERY declared program."* §9.1 Part 4b — *"Degree requirements / progress → run_full_audit … If Missing → Block + re-prompt."*
- **Counter-case rationale:** The question feels like a yes/no but it is a degree-progress claim. A model that answers from session memory or training data violates the Cardinal Rule. The forbidden behavior is **answering without calling `run_full_audit` this turn**.

---

## File 2 — `synthesis.json` (18 cases)

Synthesis cases freeze tool outputs and grade response quality against Appendix D. Required caveats and forbidden claims are derived from §D.1–D.4.

### synth-001 — "Where do I stand right now?" (frozen: 7 unmet rules)
- **Architecture:** §D.1 Grounding — *"A specific number (count) … 'You have 7 requirements remaining' must come from a tool."* §A System-Prompt rule 16 — *"X credits remaining — include which tool produced that number."*
- **Bulletin:** `…/academic-policies/_index.md:86` — bulletin defines the 128-credit total against which "remaining" is computed.
- **Forbidden-claim rationale:** "8 requirements remaining" tests off-by-one drift; "all requirements met" is the §A rule 17 cardinal violation.

### synth-002 — "What's my GPA?" (frozen: 3.42)
- **Architecture:** §D.1 Grounding row 1 — *"A specific number (GPA) … Required Source: A deterministic tool result"*. §2.1 Cardinal Rule — *"Every number a student sees (GPA, credits remaining, completion rate) comes from a deterministic tool."*
- **Bulletin:** `…/academic-policies/_index.md:86` — *"with a cumulative grade point average of at least 2.0."* GPA is bulletin-grounded as a tracked value.
- **Forbidden-claim rationale:** "around 3.4" / "approximately 3.4" / "3.5" test rounding & paraphrase drift. The tool returned 3.42; per §D.1 the response must say 3.42.

### synth-003 — Study-abroad seminar petition (low-conf RAG + adviser caveat)
- **Architecture:** §D.3 Uncertainty Transparency — *"RAG confidence 0.3-0.6 → R must include a caveat: 'I'd recommend confirming with your adviser.'"* §A System-Prompt rule 10 — same.
- **Bulletin:** `…/academic-policies/_index.md:140` — *"Transfer students from other colleges and universities must have the written approval of the director of undergraduate studies to count transfer courses toward the major or the minor."* — adviser-confirmation requirement is bulletin-grounded.

### synth-004 — F-1 student credit-load
- **Architecture:** §D.2 Completeness — *"F-1 enrollment constraints | If P.visaStatus === 'F-1' | Q touches course load, credits, or enrollment."* §9.1 Part 4c heuristic enforces.
- **Bulletin:** `data/bulletin-raw/undergraduate/business/academic-policies/_index.md:298` — *"international students who pursue an approved semester of either an increased course load or fewer than 12 credits must meet with the Office of Global Services to discuss any potential implications on their Visa status."* The 12-credit minimum is bulletin-grounded.
- **Forbidden-claim rationale:** "no problem at all" omits the F-1 caveat — the dominant academic-advising failure mode (§2.5).

### synth-005 — Online course satisfying CS major (policy uncertainty flag)
- **Architecture:** §D.3 — uncertainty must be transparent. §7.2 `search_policy.summarizeResult` includes `applicabilityNotes` & `needsAdviserConfirmation`.
- **Bulletin:** `…/academic-policies/_index.md:272` — *"Online courses cannot meet the requirements of any CAS major or minor unless they are accepted and approved by the department's director of undergraduate studies."* Direct quote, source-grounded caveat.

### synth-006 — Cross-school CAS+Stern P/F (must cite both schools)
- **Architecture:** §D.2 — *"Cross-program overlap rules | If P.declaredPrograms.length > 1."* §11.4 Cross-School Audit Flow.
- **Bulletin:** CAS rule at `…/arts-science/academic-policies/_index.md:138` (no P/F for CAS major/minor) AND Stern rule at `…/business/academic-policies/_index.md:401` (P/F can fulfill Stern degree requirements). Both are required because the student straddles two schools.
- **Forbidden-claim rationale:** Saying "Stern's rule applies to your CAS minor" is the inversion error. Saying "yes, P/F is fine" omits the CAS-minor restriction (§D.2 omission risk).

### synth-007 — Spring plan with uncertainties
- **Architecture:** §A System-Prompt rule 20 — *"AFTER plan_semester returns, check uncertainties[]. For each: call search_policy with the suggestedPolicyQuery."* §D.3 — *"Plan includes uncertainties → R must list all uncertainties from plan_semester result."*
- **Bulletin:** `…/academic-policies/_index.md:126` — double-counting cap policy supports the second uncertainty.

### synth-008 — Near-graduation timeline
- **Architecture:** §D.2 — *"Graduation timeline impact | If P.totalCredits > (totalRequired - 16)."* §9.1 Part 4c heuristic. §A System-Prompt rule 17 — never say "all requirements met" prematurely.
- **Bulletin:** `…/academic-policies/_index.md:102` — *"Students must complete their last 32 credits while registered in the College."* Residency-rule citation.

### synth-009 — Low-confidence policy match (no answer)
- **Architecture:** §D.3 — *"RAG confidence < 0.3 → R must include: 'I couldn't find a specific policy. Contact [resource].'"* §9.1 Part 5 fallback templates. §A System-Prompt rule 9.
- **Bulletin:** No specific bulletin citation needed — the rubric tests the *behavior* on a low-confidence search, not a specific policy.
- **Forbidden-claim rationale:** "the deadline is" / "you have until" — fabricating a deadline from training data violates §D.4 non-fabrication.

### synth-010 — Multi-program overlap (CAS double-count cap)
- **Architecture:** §D.2 — *"Cross-program overlap rules"*. §A System-Prompt rule 4 — *"For double-major/minor questions, ALWAYS call check_overlap."*
- **Bulletin:** `…/academic-policies/_index.md:126` — *"No student may double count more than two courses between two majors (or between a major and a minor, or between two minors)."* — exact quote ground for the "2" caveat.

### synth-011 — Stern transfer not yet eligible
- **Architecture:** §7.2 `check_transfer_eligibility.prompt()` — *"NOTE: GPA requirements are NOT published by most schools — always caveat this."* §D.3 — uncertainty transparency.
- **Bulletin:** `…/admissions/_index.md:63` — *"Students may apply for an internal transfer no sooner than the start of their second consecutive semester of full-time study."* Credit/year minimums are bulletin-grounded.
- **Forbidden-claim rationale:** "minimum GPA is 3.5" / "the GPA cutoff is" — these are training-data hallucinations. The bulletin does not publish a numeric internal-transfer GPA cutoff. (§D.4 + §7.2's explicit `gpaNote`.)

### synth-012 — Multi-semester plan future projection
- **Architecture:** §D.3 — *"Future semester projections | R must caveat: 'Future semesters are projections that may change.'"* §A System-Prompt rule 23.
- **Bulletin:** No specific citation — this rubric tests behavior under projection, which is system-defined.
- **Marker:** `<unprovenanced — synthetic>` for the *exact phrasing* "may change" / "projection" — these are Architecture-prescribed, not bulletin-quoted. (See "Unprovenanced cases" section below.)

### synth-013 through synth-018 — No-tool-needed cases (6 cases)
These are conversational/meta cases. The expected behavior is **do not invoke any tool, do not produce a tool-required claim**.

- **Architecture:** §9.1 Part 4b — the tool-invocation auditor BLOCKS responses that make claims like "credits remaining" without calling the tool. The inverse case — when no claim is made — should also pass the auditor without a tool call.
- **Forbidden claims rationale:** "I called run_full_audit" tests **tool-call hallucination**. A model that fabricates tool calls is dangerous because it implies grounded output when none was performed. (§D.4 — "non-fabrication.")
- **Per-case bulletin/architecture grounding:**
  - **synth-013** (greeting): pure conversation. No bulletin citation. `<unprovenanced — synthetic>` for the exact text. The behavior tested (don't fabricate tool calls in response to thanks) is bulletin-irrelevant — it's a meta-system property.
  - **synth-014** (recap): same. Conversation-context recall, not a fact lookup. `<unprovenanced — synthetic>`.
  - **synth-015** (meta capability question): same. `<unprovenanced — synthetic>`.
  - **synth-016** (acknowledgement): same. `<unprovenanced — synthetic>`.
  - **synth-017** (out-of-scope: internships): §D.3 — *"Question outside system scope | R must say: 'I don't have data for X yet.' + provide contact."* Wasserman is the bulletin's named resource at `…/student-services/_index.md` (Wasserman Center for Career Development is a standard NYU advising resource).
  - **synth-018** (emotional check-in): §D.3 — out-of-scope. NYU Wellness Exchange / Counseling Services is a standard NYU resource that the agent should refer to for non-academic concerns. `<unprovenanced — synthetic>` for the exact phrasing — the bulletin lists student-services resources but the wellness referral pattern is a system-defined safety behavior, not a bulletin policy.

---

## File 3 — `decomp.json` (10 cases)

Decomposition cases test multi-intent decomposition (§6.5.1 TS-Decomp). Each case has an integer sub-question count and substring markers signaling each is answered.

### decomp-001 — P/F + credit total (2 sub-questions)
- **Architecture:** §6.5.1 TS-Decomp — *"30 multi-intent cases. Grade: fraction of sub-questions answered × fraction correct."*
- **Bulletin (sub-q 1):** `…/academic-policies/_index.md:138` — P/F major restriction. **(sub-q 2):** `…/academic-policies/_index.md:86` — credit accumulation toward 128.

### decomp-002 — Stern transfer: deadline, prereqs, minor portability (3 sub-questions)
- **Bulletin:** `…/admissions/_index.md:63-69` — internal transfer deadlines. `…/academic-policies/_index.md:104` — *"One-half of the courses used to complete the major or the (optional) minor must be taken in the College."* — bears on whether a CAS minor survives a Stern move.

### decomp-003 — Spring plan + graduation track + Honors deadline (3 sub-questions)
- **Bulletin:** `…/academic-policies/_index.md:500` (full-time / planning); `…/academic-policies/_index.md:702` (Honors and Awards section header — drives Honors-track question).
- **Note:** The exact "Honors track declaration deadline" is department-specific. The eval tests that the model **identifies and addresses** the question, not that it produces a specific date — the marker is the substring `Honors`, not a date.

### decomp-004 — Overload: adviser, tuition, GPA risk (3 sub-questions)
- **Bulletin:** `…/academic-policies/_index.md:500` — *"Students may register for more than 18 credits per term with the approval and clearance of their academic adviser."* For Stern: `…/business/academic-policies/_index.md:298` — tuition impact for >18 credits, *"All students taking more than 18 credits in a given semester are subject to extra tuition and fees."*
- **GPA risk** (sub-q 3): `<unprovenanced — synthetic>` for the exact "GPA risk" framing — the bulletin doesn't quantify per-load GPA risk; this tests model judgment, but the marker is just `GPA`, which is bulletin-grounded as a concept (§academic-policies:86).

### decomp-005 — Double major: overlap, graduation, GPA-2.0 (3 sub-questions)
- **Bulletin:** `…/academic-policies/_index.md:124-126` — *"Students may take a double (second) major. The same requirements, including the maintenance of a minimum grade point average of 2.0, apply to the second major as to the first."* And `:126` double-count cap. Three discrete bulletin facts.

### decomp-006 — Transfer credits: major, residency, online distinction (3 sub-questions)
- **Bulletin:** `…/academic-policies/_index.md:140` (major-acceptance via DUS approval); `:148-150` (64-credit residency); `:268-272` (online course rules, 24-credit cap, DUS approval for major).

### decomp-007 — Fall plan + Summer catch-up (3 sub-questions)
- **Architecture:** §7.2 `plan_semester` `term` enum allows summer.
- **Bulletin:** `…/academic-policies/_index.md:292` — *"Students who would like to attend another institution and transfer those credits to NYU must first petition…"* — relevant for summer-elsewhere; the markers test that both terms are addressed.

### decomp-008 — Late withdrawal: transcript, GPA, plan rebuild (3 sub-questions)
- **Bulletin:** `…/academic-policies/_index.md:516` — *"Courses dropped… from the beginning of the third week through the 14th week… will be recorded with a grade of W… (This grade is not calculated in the GPA…)"*. Single bulletin chunk supports sub-q 1 and sub-q 2; sub-q 3 (plan rebuild) is the system's `plan_semester` job.

### decomp-009 — Undeclared: compare CS vs DS + declaration deadline (2 sub-questions)
- **Bulletin:** `…/academic-policies/_index.md:120` — *"Students who have earned 64 or more credits must declare a major. Those with fewer than 64 credits are strongly encouraged to declare a major as early in their academic career as possible."* — declaration deadline is bulletin-grounded.

### decomp-010 — Four-part comprehensive (4 sub-questions)
- **Bulletin:** Sub-q 1 (degree status): `:86`. Sub-q 2 (next term): `:500`. Sub-q 3 (minor): `:130`. Sub-q 4 (graduate course): `:234` — *"Courses may be taken in the New York University Graduate School of Arts and Science. 1000-level graduate courses may be taken as described in the departmental sections of this Bulletin, and 2000-level graduate courses may be taken with written approval of the instructor."*

---

## Unprovenanced cases (synthetic)

The following cases are marked `<unprovenanced — synthetic>` either in whole or in part. They test system-defined behaviors that aren't directly quoted in the bulletin but are required by Architecture or by the Cardinal Rule.

| Case | Why unprovenanced | Why included anyway |
|---|---|---|
| synth-012 (future-projection caveat) | Exact phrasing "projections may change" is Architecture-prescribed (§D.3, §A rule 23), not bulletin text. | Tests §D.3 uncertainty transparency — a Phase-5-blocking behavior (§9.1 v3.2). |
| synth-013 (greeting) | Pure conversation. | Tests §D.4 non-fabrication: model must not fake tool calls in response to social pleasantry. |
| synth-014 (recap) | Pure conversation. | Same as synth-013. |
| synth-015 (meta capability) | Pure conversation. | Same as synth-013. |
| synth-016 (acknowledgement) | Pure conversation. | Same as synth-013. |
| synth-018 (wellness check-in) | Wellness-referral pattern is system-defined safety behavior. | Tests §D.3 out-of-scope handling without bulletin claim fabrication. |
| decomp-003 (Honors-track deadline) | Honors-track declaration deadline is department-specific, not in CAS academic-policies bulletin. | Tests decomposition; marker is `Honors` (substring), not a specific date. |
| decomp-004 sub-q 3 (per-load GPA risk) | Bulletin does not quantify GPA risk by credit load. | Tests that model addresses the question; marker is `GPA` (concept), which is bulletin-grounded. |

All cases marked unprovenanced still test Architecture-mandated behaviors. None invent **factual claims** the model is graded on producing — they grade behaviors (caveat, refer-out, count sub-questions).

---

## Cross-checks

**Tool coverage in TS-Tool (18 cases):**
- `run_full_audit` — 4 cases (tool-001, 002, 003, 018)
- `plan_semester` — 2 cases (tool-004, 005)
- `check_transfer_eligibility` — 2 cases (tool-006, 007)
- `what_if_audit` — 2 cases (tool-008, 009)
- `search_policy` — 5 cases (tool-010 through 014)
- `update_profile` — 3 cases (tool-015, 016, 017)
- **All 6 required tools covered.**

**Cardinal Rules covered in TS-Synthesis (18 cases):**
- Exact-number passthrough (no off-by-one): synth-001
- GPA verbatim (no rounding): synth-002
- Low-confidence adviser caveat: synth-003, synth-009
- F-1 visa caveat: synth-004
- Online-course policy uncertainty: synth-005
- Cross-school override / both-schools cited: synth-006
- Plan-uncertainty surfacing: synth-007
- Near-graduation timeline: synth-008
- Multi-program overlap: synth-010
- GPA-cutoff non-fabrication: synth-011
- Future-projection caveat: synth-012
- No-tool-needed (6 cases): synth-013 through synth-018

**Decomposition cardinality covered in TS-Decomp (10 cases):**
- 2-part: 2 cases (decomp-001, 009)
- 3-part: 7 cases (decomp-002, 003, 004, 005, 006, 007, 008)
- 4-part: 1 case (decomp-010)

---

## Schema-validation note

All cases conform to the field shape declared in `evals/modelBakeoff.ts` (lines 41-75):
- `ToolSelectionCase`: `{id, userMessage, expectedToolName, expectedArgsShape}` — pinned only documented fields. The `expectedArgsShape` is intentionally JSONSchema-like (using `type`, `properties`, `required`, `optional`, `const`, `enum`) — the harness should treat it as a schema fragment, not a literal arg value.
- `SynthesisCase`: `{id, userMessage, frozenToolResults: [{toolName, result}], rubric: {requiredToolNames, requiredCaveats, forbiddenClaims}}`.
- `DecompCase`: `{id, userMessage, subQuestionCount, subQuestionMarkers}`.

The top-level `_meta` field in each JSON file is an additive doc-only key; if the harness's JSON parser is strict, point it at the `cases` array.

---

*End of provenance.*
