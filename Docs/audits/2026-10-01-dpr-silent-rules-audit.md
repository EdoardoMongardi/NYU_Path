# DPR-silent rules audit — can NYU Path know a major's rules from the DPR alone?

**Date:** 2026-10-01 · **Trigger:** the owner asked whether the DPR shows that MATH-UA 352 Numerical Analysis can replace CSCI-UA 421 Numerical Computing in the CAS Computer Science/Math joint major, and noted that if the agent cannot derive this from the DPR, it cannot know every rule of a major. · **Consumer:** plan 40 (`Docs/plans/40-2026-09-16-production-test-suite.md` §1.7, KB-40–KB-50, EH-26–EH-29, C57, Stage 3b D11, §9 #21).

> Point-in-time record. Do not retro-edit. Code citations are against branch `plan/40-production-test-suite` (based on `chore/deactivate-fose-live-agent` @ `4e541e4`) on 2026-10-01.

## 1. Answer in brief

- **The DPR does not indicate the option.** Both DPRs (prepared 04/27/2026 and 10/01/2026) list CSCI-UA 421 inside R1142/20 "Complete the following courses" (6 required, 5 used, 1 needed) with no alternative. MATH-UA 352 appears zero times in either DPR, and neither mentions a DUS excusal.
- **No DPR can carry this kind of rule.** A DPR applies a fixed rule set to the record and shows where courses were placed. A route that depends on a human decision (a DUS excusal, a substitution, a petition) can appear only after it is granted, as an exception or Advisor Notation. The DPR also delegates content outward on its own face: R1142/60 says "please see list on the department website", R1142/70 says "Complete one course by advisement", R1142/30 allows graduate courses "with permission of the department", and the DPR's header says it "should not take the place of consultation".
- **The design already expects this.** `Docs/core_philosophy.md` makes the DPR authoritative only "for the fields it shows" (:7) and sends unstructured rules to the bulletin under the confidence-plus-verify rail (:23, :44). The tier-1/tier-2 split is defined in `Docs/GLOSSARY.md`.
- **What is serious is that tier 2 fails on this exact question, and the failure covers a class of rules.** The bulletin footnote is in the served corpus but both retrieval tools cut it off; the rule's outcome exists only on an un-ingested department page; the prompt tells the model the DPR is complete; the audit text never names CSCI-UA 421; the engine cannot represent an excusal; and the adviser caveat is enforced only on non-high-confidence tier-2 results. Discretion language appears on ~70% of undergraduate program pages (keyword upper bound).

## 2. Method

Workflow `wf_3be5455c-ed8` (9 agents): four investigators (U1 DPR as a rule source; U2 corpus and retrieval; U3 engine and agent behavior; U4 generalization), one adversarial skeptic per unit that re-opened every citation, and a synthesizer acting as completeness critic. Sources: both real DPRs (text extracted with `unpdf`, the library the live upload route uses); the bulletin mirror (scraped 2026-04-21); the CS department page `https://cs.nyu.edu/dynamic/undergraduates/cs-major/computer-science-majors/` as pasted by the owner on 2026-10-01 (not in any repo corpus); engine and web code. Read-only: no tests run, no repo edits. Embeddings cannot run offline, so retrieval ranking was approximated with BM25 plus `LocalLexicalReranker`. The full structured result (claims, evidence, skeptic verdicts) is kept outside the repo in the owner's gstack checkpoints (`2026-10-01-dpr-silent-rules-audit.json`).

## 3. Findings

### 3.1 What the DPR states for the joint major (RG5076 / R1142)

| Rule | Where it lives | On the DPR? |
|---|---|---|
| C-or-better in major courses; P/F banned for the major; 18 courses | RG5076 header (fresh DPR :289-291) | **Stated.** The P/F effect shows after grading: MATH-UA 334 (P) left R1142/60 and R1142/70 reopened. |
| Six required CS courses incl. CSCI-UA 421 | R1142/20 (:292-300) | **Stated**, with no alternative. |
| MATH-UA 352 may lead the DUS to excuse 421, with a substitute upper-level elective | Bulletin fn 3 (procedure only) + CS page fn [1] (outcome) | **Absent.** |
| CS electives: two CSCI-UA 400-499; no independent study; graduate courses with department permission | R1142/30 (:311-313) | Range and ban stated; graduate replacement **points outward** ("permission of the department"). |
| Advanced math electives (two from a list) | R1142/60 (:344-346) | **Points outward** to a math-department URL; no list. The parser also strips that URL (`parser.ts:155-157`). The list itself is in the bulletin mirror (`mathematics-computer-science-ba/_index.md:178-200`). |
| General math elective (MATH-UA ≥ 120, MATH-UA only; Calc vs Math-for-Econ and honors/non-honors exclusions) | R1142/70 (:352-355) | **"By advisement"** only. The ≥ 120 / MATH-UA-only rule is bulletin fn 4 (`:225`); the exclusions are fully stated only on the CS page. Mapping R1142/70 to bulletin fn 4 is an inference by rule name. |
| One course counts in one area only (owner's MATH-UA 251 observation) | — | **Never stated**; visible only in placements (April: 251 in R1142/70; 10/01: 251 in R1142/60). |
| MATH-UA 129 Honors Calculus III as an alternative to 123 | Bulletin `:170`, CS page | **Divergence:** DPR R1142/55 omits 129. |
| Double-count cap with another major/minor | Bulletin `:327` | **Absent.** |
| Spring-only offering of CSCI-UA 421 and MATH-UA 352 | Bulletin course pages (`courses/csci_ua/_index.md:181`, `courses/math_ua/_index.md:462`); `courses-offerings.json` | **Absent.** |

The student's own DPR also applies a substitution it never lists: R1007/10 reads "Complete one course from CORE-UA 600-699" yet uses ECON-UA 1 (parent R1007 allows "an approved departmental course", :207-216).

### 3.2 The true 352 / 421 rule

- Bulletin footnote 3 (`programs/mathematics-computer-science-ba/_index.md:221-222`; same procedure at `programs/computer-science-ba/_index.md:108`): students who take MATH-UA 352 or 358 as one of their mathematics electives must contact the CS director of undergraduate studies **before registering for CSCI-UA 421**. It gives no outcome. The mirror puts a non-breaking space between "MATH-UA" and "352", which defeats literal matching.
- CS department page footnote [1]: "If the student has chosen Numerical Analysis from the Math side, they can be excused by the DUS from the CSCI-UA.421 Numerical Computing requirement and substitute a different upper level elective for it."
- Combined reading (confidence 7/10): the excusal is discretionary, and a substitute upper-level elective is still owed, so the course count does not drop. Questions only the CS DUS can settle: (a) does the excusal apply when 352 fills the general math elective (R1142/70) rather than an advanced slot (R1142/60 is full)? (b) what counts as "a different upper level elective" (CSCI-UA 4xx only, CSCI-GA with permission, a MATH-UA course)? (c) can 352 and the substitute both be taken in Spring 2027? (d) how is the excusal recorded so R1142/20 shows satisfied (exception vs Advisor Notation), and by when? (e) did the 2026-27 catalog change the rule (the mirror is 2025-26)?
- Bulletin vs CS page otherwise agree: the same 22 advanced-math course numbers in 19 slots; five titles differ (251, 262, 263, 353 — the department page's "Linear and Linear Nonlinear Optimization" looks like a typo — and 394).

### 3.3 What NYU Path would answer today (prediction from code; no live transcript)

Routing: Rule 2 (`systemPrompt.ts:348-353`) → `run_full_audit`; Rule 7 (`:391-396`) and Rule 16(C) (`:515-518`) → `search_policy` / `get_program_requirements`; `propose_plan_change` only if a plan exists (`:625-634`).

- **`run_full_audit`** — R1142/20 renders as "Not Satisfied: Complete the following courses:" with no course list: the 238-char description is dropped by the `< 220` rule (`runFullAudit.ts:443`), contradicting the comments at `:57-59` and `:433-434` (already KB-1). The generic-statusText follow-up cannot fire for R1142/20 or R1142/70: four of its five patterns are `^`-anchored (`:591-597`) and DPR statusText starts with `Not Satisfied:` (only the unanchored CORE-UA range pattern matches, e.g. R1004/10); it has no "by advisement" / "department website" pattern, and examines only the first three unsatisfied leaves (`:671`); on the fresh DPR R1142/70 is fourth. Group notes (C rule, P/F) are parsed but never rendered.
- **`get_program_requirements`** — promises "the FULL bulletin page" (`getProgramRequirements.ts:65`) but output is capped at 12,000 chars (`:101`, enforced at `tool.ts:273-277`). The joint-major page renders to ~24.2k chars; the cut falls inside the advanced-math list after MATH-UA 333, so the MATH-UA 352 row (~12.3k), the main-table "CSCI-UA 421 Numerical Computing 3" row (~13.8k) and footnote 3 (~15.0k) are lost. CSCI-UA 421 is visible only in the Honors-program table (~4.0k). Its category preference includes `school_overview` (`:128`), the tag the 3,593 ingested course-description chunks carry, so a course page can be picked as the "program page".
- **`search_policy`** — the joint-major page is 23 chunks; footnote 3 is complete in `cas_mathematics_computer_science_ba_010` (policy_chunks.jsonl line 5183) at char ~3,136. Each printed hit is cut to its first 1,400 chars and only the top 3 print (`searchPolicy.ts:175-176`), and the "FULL SECTION … read this for the complete rule" block is capped at 3,000 chars (`:151-155`) while the section is ~6.9k with the footnote at ~6.1k. Only `_011` (676 chars) would show the footnote's tail, without its subject. Footnote markers are bare digits with no anchor in the scraped page ("Numerical Analysis 3"), and the chunker's token-window split (`chunker.ts:181`) flattens oversized sections, so a definition shares a chunk with its row only by chance; the page also has a second, unrelated footnote 3 in the Sample Plan (`:290-291`). Under the lexical proxy `_010` ranks 1st in BM25 but ties at 0.467 after reranking and lands 5th; under production Cohere bands a top score below 0.3 returns `escalate` and prints no hits at all (`policySearch.ts:139-155`). Both RAG tools need `OPENAI_API_KEY` (`apps/web/lib/policyRagSetup.ts:44-48`).
- **Predicted reply:** "421 is required by your DPR; 352 counts as a math elective; check with your adviser", at best with "contact the CS DUS". It misses that the DUS can excuse 421, that a substitute elective is then owed, that 352 would fill the open R1142/70, and that both courses are Spring-only so Spring 2027 is the only window.
- **Validator:** the response validator checks invocations, verbatim quotes, identity drift, quantitative shortfall, plan claims and attribution, but nothing checks a substitution or excusal claim; the adviser caveat is required only when a tier-2 tool returned non-high confidence (`responseValidator.ts:494-507`). Core-philosophy point 4's rail depends on model compliance here.

### 3.4 Engine modeling

- No representation of a waiver or excusal: `PlanMutationSchema` kinds (`planChangeHelpers.ts:75-133`) are pin, exclude, swap, move, unpin, addTerm, loadStyleOverride, free-elective and pool-slot binding, scheduling preferences and soft objectives. The `Assumption` union has only IP completion, LLM-ranked alternative and heuristic mapping. `requiresPetition` covers prerequisite permission only. `update_profile` refuses adviser approvals.
- Advisor Notations are parsed and copied onto `session.student` (`apps/web/lib/buildSession.ts:145-156`, whose comment promises tools use them) but no engine tool, prompt block or solver reads them; the "DPR-3 dropped advisorNotations" comment at `apps/web/app/api/chat/v2/route.ts:623-625` is stale. A granted DUS excusal recorded only as a notation would be invisible.
- R1142/20 candidates come from the course IDs in its description minus courses taken (`buildSolverInput.ts:284-290`), so 352 can never satisfy it; a swap pinning 352 counts toward nothing (`solver.ts:263-267`). CSCI-UA 101 (TE) survives as an alternative because TE is not in `GRADE_ORDER` (already KB-28). The planner knows 421 is spring-only (`constraintModel.ts:273`).
- R1142/70 ("by advisement") yields no candidates and becomes an empty placeholder (`buildSolverInput.ts:698-723`).
- The frozen validator skips partially used leaves (already KB-21, `graduationPathValidator.ts:173-176`) and its failure reason names only the first failing leaf (`:197-201`), so it cannot explain that 421 is still owed. *(Scratch-run specifics — the validator blaming R1004/10, the infeasible-draft state — were not reproduced by the skeptics; treat as unverified.)*
- No course-data relationship between CSCI-UA 421 and MATH-UA 352 (`courses.json` exclusions and cross-lists empty).

### 3.5 Parser findings on runtime-shaped input

The live upload extracts with `unpdf` (`mergePages: false`) and joins pages with `"\n"` (`apps/web/app/api/onboard/route.ts:124-128`), so each page's "Page N of M" runner is glued to the next content line. `stripPageFooterPrefix` (`parser.ts:684-692`) runs only on course rows and section titles (`:418`, `:692`), not on status lines, counters or the "Courses Used" sentinel (`:490-541`). Simulated effects: on the fresh DPR R1142/70 loses its counter and the RG5001 status line fails `startsWith('Satisfied:')`; on the April DPR R1142/70 loses MATH-UA 251 from `coursesUsed`. Course-history continuation rows ("Course Topic:", "Repeat Code:") lose their leading spaces and fail the 5-space check (`parser.ts:696`), dropping repeat codes. The redacted fixture is pypdf-shaped, so the existing tests cannot see any of this; `Docs/current-system/engine/dpr.md` §12.6 says the collision is handled. *(Simulation only — confirm with a real upload.)*

### 3.6 Scale across NYU (keyword scan, upper bound)

Over all 427 undergraduate program pages in `data/bulletin-raw/undergraduate/*/programs/*/_index.md` (script in Appendix A):

- 297 pages (70%) contain discretion language (DUS / program-head approval, permission, petition, substitution, "by advisement", excused/waive, consult/contact the department); 171 pages (40%) have it inside a Program Requirements section (301 units, 274 distinct).
- 124 of 761 footnotes (16%) on 77 pages are discretionary; 952 discretion units in total (677 distinct).
- "by advisement": 178 hits on 65 pages (189 on 66 by raw grep) — Steinhardt 36 pages, CAS 12, SPS 11, Tisch 2, Silver 2, Stern 1, Tandon 1.
- Outward references: 164 units on 85 pages; 256 pages link a "Department Website" whose content is off-corpus and unmeasured.

| School | pages | with discretion | in requirements | units | distinct | discretionary footnotes |
|---|---|---|---|---|---|---|
| CAS | 164 | 130 | 72 | 451 | 359 | 81 |
| Steinhardt | 53 | 50 | 36 | 245 | 108 | 5 |
| Tandon | 38 | 27 | 22 | 55 | 54 | 25 |
| SPS | 21 | 21 | 18 | 67 | 50 | 2 |
| Tisch | 23 | 16 | 7 | 27 | 24 | 5 |
| Stern | 6 | 4 | 2 | 8 | 8 | 0 |
| Gallatin | 2 | 1 | 1 | 25 | 24 | 0 |
| Shanghai | 42 | 33 | 4 | 49 | 27 | 2 |
| Abu Dhabi | 59 | 7 | 1 | 10 | 9 | 0 |
| Liberal Studies | 5 | 4 | 4 | 7 | 7 | 2 |
| Silver | 5 | 4 | 4 | 8 | 7 | 2 |
| Nursing, Wagner, GPH, Dentistry | 9 | 0 | 0 | 0 | 0 | 0 |

Caveats: matching is noisy in both directions (Steinhardt "academic advisement" boilerplate, attendance "excused"; phrasings like "approved courses" are missed); Shanghai hits are mostly one repeated minors sentence. A hand-labelled sample is needed to bound precision (plan 40 D11). Runtime reachability limits the all-NYU picture further: a CAS session cannot retrieve Shanghai or Abu Dhabi chunks at all (KB-10).

Representative rules: "Students may substitute up to two social science courses taken in other departments with the approval of the director of undergraduate studies" (CAS Sociology); "approval by the Computer Science Program Head is required for it to count as a CS elective" (NYUAD CS); "a substitution may be approved for APSY-UE 10 pending program review" (Steinhardt); "with adviser's permission a technical elective related to BMS major at another school" (Tandon); "Major Elective Credits (by advisement) … 60" (SPS Applied General Studies).

### 3.7 Kinds of rules a DPR cannot carry, or shows only after the fact

1. Discretionary excusals and substitutions (DUS / program head / adviser) — absent until granted.
2. Permission rules whose text is on the DPR but whose decision is not (R1142/30 graduate replacement).
3. Outward references (R1142/60 department list; Core "approved departmental course"; Core exemption/substitution links).
4. "By advisement" slots with no candidate list (R1142/70).
5. Offering patterns (Spring-only).
6. Sequence exclusions (Calculus vs Math for Economics) and honors/non-honors duplicates — shown only as per-row OR alternatives.
7. Prerequisite grade floors and escape clauses (e.g. 352 needs C in Calc III and Linear Algebra).
8. Double-count caps and shared-course approvals.
9. Placement-only rules (one course, one area).

Carried by the DPR (tier-1, deterministic): grade minimums, the P/F ban and budget, outside-school and residency caps, the time limit.

### 3.8 Design stance

- `Docs/core_philosophy.md` anticipates an incomplete DPR (:7, :23, :41, :44) but does not say how to treat rules whose source is a department website or whose outcome is a human decision.
- The design spec over-claims: §4 says the DPR encodes every major's rules and Lane A gets "enumerated candidate courses … No authoring, no RAG" (`Docs/specs/2026-06-05-planning-engine-rebuild-design.md:57, :59`); Lane C (`:61`) puts petition rules in RAG and bars them from validity, so a granted substitution that changes which course satisfies a leaf has no representation. The only substitution field, `mathSubstitutionPool` / `maxMathSubstitutions` (`provenance/configSchema.ts:198-199`), has no consumer.
- The system prompt says the opposite of the truth: the DPR "carries every requirement's status … It is the SOURCE OF TRUTH for every question about the student's current state" (`systemPrompt.ts:538-543`). Prompt Rules 3 and 4 still point to search_policy's removed "CURATED TEMPLATES" and a `< 0.3` threshold that differs from the tool's bands (`systemPrompt.ts:354-361` vs `searchPolicy.ts:97-120`); Rule 16(C) routes a course swap to `what_if_audit`, whose own description reserves it for program changes (`whatIfAudit.ts:91-100`).

### 3.9 Consequence for the owner (Spring 2027)

The fresh DPR leaves CSCI-UA 421 (R1142/20), one MATH-UA ≥ 120 elective (R1142/70) and Texts & Ideas (R1004/10); R1142/60 is full with MATH-UA 333 and 251 (251 must finish C or better). The owner has no spare upper-level elective: CSCI-UA 472 and 473 are both used in R1142/30, and CSCI-UA 4 is a catalog-4 course in General Electives.

- **421 path:** CSCI-UA 421 + any MATH-UA ≥ 120 + Texts & Ideas — 12 credits, no approval needed, prerequisites met.
- **352 path:** MATH-UA 352 (fills R1142/70) + a DUS-approved substitute upper-level elective + Texts & Ideas — also 12 credits, but only if the DUS grants the excusal and it is recorded. "Math elective + 352 + Texts & Ideas" leaves R1142/20 open unless the DUS accepts a math course as the substitute (unconfirmed).
- Both CSCI-UA 421 and MATH-UA 352 are typically Spring-only, so Spring 2027 is the only window. Recommended: the 421 path unless the CS DUS confirms (a)-(e) in writing before Spring 2027 registration. F-1: keep the final term full-time.
- Separate DPR flag for the CAS adviser: R1680/30 (outside-CAS credit, 18 used vs 16) shows Not Satisfied; the owner's reading is that the excess simply does not count.

## 4. Skeptic corrections (do not repeat the uncorrected forms)

- Bulletin fn 3 text is at `_index.md:222` (marker at 221). The parser anchor strip is `parser.ts:155-157` (normalizeText spans 150-178); a skeptic's "154-156" was itself off by one (caught by the plan-40 verification pass).
- Not every follow-up pattern is `^`-anchored (the CORE-UA range pattern matches anywhere); the claim holds for R1142/20 and R1142/70, and R1142/70 is also excluded by `slice(0, 3)`.
- The bulletin also bans double-counting across the Calc and Math-for-Econ sequences (fn 2, `:219`) and lets one course count toward both regular and honors electives (`:121`); nothing says whether a course can fill both R1142/60 and R1142/70.
- `get_program_requirements` does show CSCI-UA 421 within its cap (Honors table only); footnote 3 is at ~15,030, MATH-UA 352 at ~12,287.
- Advisor Notations ARE copied onto `session.student`; they are unused, not dropped.
- The runtime RAG is the precomputed `data/policy-corpus/policy_chunks.jsonl` (14,273 chunks, embedded 2026-06-04), gated on `OPENAI_API_KEY`, not a live `corpus.ts` build.
- "By advisement" count is 178 on 65 pages (189 on 66 by raw grep), not 177.
- Four schools had zero discretion hits of any kind (Nursing, Wagner, GPH, Dentistry; 9 pages), not three.
- Calling R1142/70 "adviser discretion" is unproven: the bulletin gives an objective rule (MATH-UA ≥ 120), so "by advisement" may label an open pool.
- Plan 40 was not silent on the case: §1.6 recorded that the substitution needs DUS approval; it lacked a case, EH row, KB row and oracle.

## 5. Doc-vs-code divergences (spec gaps; fix in the owning PR)

- `Docs/current-system/engine/dpr.md` §12.6 (and :255) says the page-footer collision is handled; code strips it only from course rows and titles. Stale parser line cites in dpr.md (normalizeText, requirement-group parsing, footer strip).
- `Docs/current-system/engine/rag.md:65` and `corpus.ts:12-14` say `courses/` is excluded; the walk (`corpus.ts:155-170`) ingests `undergraduate/*/courses/` (3,593 chunks tagged `school_overview`, `corpus.ts:145`). `rag.md:126` says sourceLine stays correct; `chunker.ts:205` deletes the CDATA block, so joint-major citations point ~43 lines early (sourceLine 99 vs raw line 142).
- `Docs/current-system/tools/search_policy.md:147` says FULL SECTION gives "the complete rule"; `:247` and the code cap it at 3,000 chars.
- `Docs/current-system/tools/get_program_requirements.md:152` promises the complete requirements block; the 12,000-char cap cuts whole program pages.
- Design spec §4 over-claim (above); prompt Rules 3/4 and 16(C) stale (above); `buildSession.ts` comment promises notation use that no code implements.

## 6. Recommendations

| # | Action | Where | When |
|---|---|---|---|
| R1 | Answer the owner now (§3.9) | — | done 2026-10-01 |
| R2 | Turn the findings into test cases: a new category for rules the DPR does not state, expected-hedge rows for discretionary substitutions, "by advisement" slots, outward references and off-corpus outcomes, and known-bug rows for each defect | plan 40 (C57, EH-26–29, KB-40–50) | plan 40 Stages 1–4 |
| R3 | Add an unpdf-shaped redacted fixture (the live upload shape) next to the pypdf-shaped one, with an expected parse | `packages/engine/tests/fixtures/`, plan 40 Stage 1 | plan 40 |
| R4 | Add a prompt rule: the DPR shows placements, not discretionary routes; for "can X replace Y", "by advisement" or "see department website", consult the bulletin footnotes, say approval is possible but unverified, name who decides and what is still owed, attach confidence + verify. Soften the "carries every requirement" sentence; fix stale Rules 3/4 and 16(C) | `systemPrompt.ts:538-543`, Rules 3/4/7/11/16 | own plan |
| R5 | Make tier-2 retrieval footnote-aware: segment or raise the `get_program_requirements` cap (requirements + footnotes first); attach footnote definitions to the chunks bearing their markers; make FULL SECTION truthful or uncapped for requirement sections; keep course-description chunks out of program-page selection | `getProgramRequirements.ts:101,128`, `searchPolicy.ts:151-176`, `chunker.ts`, `corpus.ts` | own plan |
| R6 | `run_full_audit`: always render the missing course IDs of a required-list leaf (description IDs minus courses used); render group notes (C, P/F); strip the status prefix before the follow-up patterns, add "by advisement" and "department website" patterns, drop the `slice(0, 3)` limit | `runFullAudit.ts:420-450, 591-681` | own plan |
| R7 | Parser: strip "Page N of M" before status, counter and "Courses Used" checks (or globally in `normalizeText`); keep anchor hrefs as text; accept unindented continuation rows | `parser.ts:150-178, 490-541, 696` | own plan |
| R8 | Surface Advisor Notations verbatim to the model (so a granted excusal is visible); fix the stale route comment | `buildSession.ts:145-156`, `route.ts:623-625`, `runFullAudit.ts` | own plan |
| R9 | Model a DUS or adviser excusal as an explicit pending-approval assumption (authority named), never as a satisfier, outside the frozen validator seam | `packages/shared/src/types.ts` Assumption union, `planChangeHelpers.ts` | later (own plan) |
| R10 | Owner decision: ingest the department requirement pages the DPR and bulletin point to (cs.nyu.edu, math.nyu.edu, …) as a separate, dated, lower-authority corpus tier with conflict handling against the bulletin; add a philosophy clause on department-site and human-decided rules | `tools/bulletin-scraper`, `data/policy-corpus`, `Docs/core_philosophy.md` | owner decision before plan 40 Stage 2 closes C57 |
| R11 | Reconcile the living docs in §5 | `Docs/current-system/engine/dpr.md`, `rag.md`, `tools/search_policy.md`, `tools/get_program_requirements.md` | with the R5–R7 fixes |
| R12 | A response-validator check that a substitution or excusal claim carries the confidence + verify rail and names the deciding office, regardless of retrieval confidence | `responseValidator.ts:494-507` | own plan |
| R13 | Treat TE and other transfer/test grades as taken when building candidates (KB-28) | `gradeComparison.ts:38-58`, `buildSolverInput.ts:232` | own plan |

TE-as-taken (KB-28), the validator's partial-leaf skip (KB-21) and the all-of-as-pick-one model (KB-33) already have plan-40 rows; this audit adds evidence to them.

## 7. Not verified (completeness critic)

- No live run of the real upload path; footer-collision losses are simulated.
- Production retrieval ranking (OpenAI embeddings + Cohere) for the owner's wording was not probed.
- No end-to-end agent transcript; §3.3 is a prediction from tool outputs and the prompt.
- The meaning of "a different upper level elective", whether the excusal applies when 352 fills R1142/70, how a granted excusal appears on a refreshed DPR, and whether the 2026-27 catalog changed the rule — only the CS DUS or a post-approval DPR can settle these.
- Spring-only offering is "historically_partial"; actual Spring 2027 sections were not checked.
- The R1680/30 overage and F-1 final-term rules were not analysed against OGS sources.
- The discretion-scan precision and recall were not hand-validated.

## Appendix A — discretion scan (re-runnable)

Run from any directory: `python3 scan_discretion.py <repo-root>` (the NYU_Path clone root). It writes `scan_summary.json` and `scan_hits.jsonl` next to the script. The requirements-section figures come from filtering `scan_hits.jsonl` on `section == "requirements"`.

```python
#!/usr/bin/env python3
"""Count discretion / outside-source rule text across NYU undergrad program pages.

Unit of counting = one cleaned non-empty markdown line (paragraph, list item,
table row or footnote ':' line) after stripping YAML front matter, the CDATA
JS block, nav bullets ('+ [', '- [', '* [' anchors) and link targets.
"""
import glob, json, os, re, sys
from collections import defaultdict, Counter

ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'
BASE = os.path.join(ROOT, 'data/bulletin-raw/undergraduate')
SCHOOL = {
    'arts-science': 'CAS', 'business': 'Stern', 'engineering': 'Tandon',
    'culture-education-human-development': 'Steinhardt', 'arts': 'Tisch',
    'individualized-study': 'Gallatin', 'professional-studies': 'SPS',
    'nursing': 'Nursing', 'shanghai': 'Shanghai', 'abu-dhabi': 'Abu Dhabi',
    'liberal-studies': 'Liberal Studies', 'global-public-health': 'GPH',
    'social-work': 'Silver (Social Work)', 'public-service': 'Wagner',
    'dentistry': 'Dentistry',
}
# Family D: human discretion
D = {
    'dus': re.compile(r'director of undergraduate stud|\bDUS(es)?\b|director of (the )?(program|major|minor)\b|program head|head of the [a-z ]*program', re.I),
    'permission': re.compile(r'\bpermission\b', re.I),
    'approval': re.compile(r'\bapprov(al|ed by)\b|with the approval', re.I),
    'petition': re.compile(r'\bpetition', re.I),
    'advisement': re.compile(r'\badvisement\b', re.I),
    'excused': re.compile(r'\bexcus(ed|e)\b', re.I),
    'waive': re.compile(r'\bwaiv(e|ed|er|ers)\b', re.I),
    'substitut': re.compile(r'substitut', re.I),
    'consult': re.compile(r'\bconsult(ation)? with|\bin consultation\b|\bconsult (their|your|the|an?)\b', re.I),
    'contact_dept': re.compile(r'contact (the|their|your) (department|program|adviser|advisor|director)', re.I),
}
# Family O: outward references (rule content lives elsewhere)
O = {
    'website': re.compile(r'\bweb ?site\b|\bweb ?page\b', re.I),
    'see_list_elsewhere': re.compile(r'(list|lists) (of [a-z ]+ )?(is|are) (available|maintained|posted|published)|(see|consult|check) the (department|program|departmental)', re.I),
}
FENCE_START = re.compile(r'^//<!\[CDATA\[')
FENCE_END = re.compile(r'^//\]\]>')
LINK = re.compile(r'\[([^\]]*)\]\([^)]*\)')
NAV = re.compile(r'^\s*[+*-]\s*\[')
COURSE_ROW = re.compile(r'^\|\s*(or\s+|and\s+|&\s+)?[A-Z]{2,8}-[A-Z]{2,3}\s*\d')


def clean_lines(path):
    with open(path, encoding='utf-8') as f:
        txt = f.read()
    if txt.startswith('---'):
        end = txt.find('\n---', 3)
        txt = txt[end + 4:]
    out, in_js, sec = [], False, 'pre'
    for raw in txt.split('\n'):
        if raw.startswith('## '):
            h = raw[3:].strip().lower()
            sec = 'requirements' if 'requirement' in h or 'curriculum' in h else ('policies' if 'polic' in h else ('sample' if 'sample' in h or 'plan of study' in h else 'other'))
        if FENCE_START.match(raw.strip()):
            in_js = True; continue
        if in_js:
            if FENCE_END.match(raw.strip()):
                in_js = False
            continue
        if NAV.match(raw):
            continue
        line = LINK.sub(r'\1', raw).strip()
        if not line or line.startswith('#'):
            continue  # headings are labels, not rules
        if line == 'Department Website':
            continue  # sidebar link label, counted separately
        if COURSE_ROW.match(line):
            continue  # plain course rows: a match there is a course title
        out.append((sec, line))
    return out


def main():
    pages = sorted(glob.glob(os.path.join(BASE, '*/programs/*/_index.md')))
    per_school = defaultdict(lambda: {'pages': 0, 'pagesD': 0, 'pagesO': 0, 'pagesDorO': 0,
                                      'unitsD': 0, 'unitsO': 0, 'footnotesTotal': 0, 'footnotesD': 0,
                                      'footnotesO': 0, 'pagesFootnoteD': 0, 'kw': Counter()})
    text_freq = Counter()
    hits = []
    for p in pages:
        rel = os.path.relpath(p, ROOT)
        sch = SCHOOL.get(rel.split('/')[3], rel.split('/')[3])
        s = per_school[sch]; s['pages'] += 1
        pd = po = pfd = False
        for sec, ln in clean_lines(p):
            is_fn = ln.startswith(':')
            if is_fn:
                s['footnotesTotal'] += 1
            kd = [k for k, rx in D.items() if rx.search(ln)]
            ko = [k for k, rx in O.items() if rx.search(ln)]
            if kd:
                s['unitsD'] += 1; pd = True
                for k in kd: s['kw'][k] += 1
                if is_fn: s['footnotesD'] += 1; pfd = True
            if ko:
                s['unitsO'] += 1; po = True
                for k in ko: s['kw']['O:' + k] += 1
                if is_fn: s['footnotesO'] += 1
            if kd or ko:
                text_freq[ln] += 1
                hits.append({'file': rel, 'school': sch, 'section': sec, 'footnote': is_fn, 'D': kd, 'O': ko, 'text': ln[:400]})
        s['pagesD'] += pd; s['pagesO'] += po; s['pagesDorO'] += (pd or po); s['pagesFootnoteD'] += pfd
    distinct = defaultdict(set)
    for h in hits:
        if h['D']:
            distinct[h['school']].add(h['text'])
    out = {sch: {**{k: v for k, v in s.items() if k != 'kw'}, 'kw': dict(s['kw']),
                 'distinctUnitsD': len(distinct[sch])} for sch, s in per_school.items()}
    tot = Counter()
    for s in out.values():
        for k in ('pages', 'pagesD', 'pagesO', 'pagesDorO', 'unitsD', 'unitsO', 'footnotesTotal', 'footnotesD', 'footnotesO', 'pagesFootnoteD', 'distinctUnitsD'):
            tot[k] += s[k]
    out['TOTAL'] = dict(tot)
    od = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(od, 'scan_summary.json'), 'w') as f: json.dump(out, f, indent=1)
    with open(os.path.join(od, 'scan_hits.jsonl'), 'w') as f:
        for h in hits: f.write(json.dumps(h) + '\n')
    hdr = ['school', 'pages', 'pagesD', 'pagesFootnoteD', 'unitsD', 'distinctUnitsD', 'footnotesTotal', 'footnotesD', 'pagesO', 'unitsO']
    print('\t'.join(hdr))
    for sch in sorted(out, key=lambda k: (k == 'TOTAL', -out[k]['pages'])):
        print('\t'.join(str(out[sch].get(h, sch)) if h != 'school' else sch for h in hdr))
    print('\nTop repeated matching lines (boilerplate check):')
    for t, c in text_freq.most_common(12):
        print(c, '|', t[:160])


if __name__ == '__main__':
    main()
```
