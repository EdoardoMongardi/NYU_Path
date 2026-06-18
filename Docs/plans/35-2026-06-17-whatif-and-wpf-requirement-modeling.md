# Plan 35 — What-If taxonomy + W / Pass-Fail requirement-satisfaction modeling

> Drafted 2026-06-17. **Status: COMPLETE (implemented 2026-06-18 on `feat/plan35-whatif-wpf`, subagent-driven TDD + spec/quality review; suite 2229+ passed, engine+web tsc clean, frozen contract untouched).** As-built: **G0** parser `reportKind` flag + snapshot-integrity guard (`assertAuthoritativeDpr` — only a real `dpr` may reach `students.parsed_dpr`); **G1** pure DPR transforms `applyWithdrawalToDpr` / `applyPassFailToDpr` (per-school `pfEligibility` over the existing `SchoolConfig.passFail`; W universal, P/F school-specific, defer/unknown→hedge); **G2** read-only `probe_counterfactual` withdraw/pass-fail arms (+ F3 window caveat + verify rail); **G3** confirmable what-if: `propose_whatif_assumption` tool + `/api/plan/whatif` + confirm persists ONLY the `forward_schedule` (R1: `parsed_dpr` byte-unchanged, tested) + the canvas badge + F3-gated IP slot control; **G4** Branch-A `/api/whatif-audit` upload → labeled NON-committed exploration (never writes `parsed_dpr`) + parser `Page N of M` section-title hardening; **G5** CORE RULE 15 reword (§6) + CORE RULE 16 router; **G6** docs + philosophy. Resolves the long-deferred follow-on from Phase 4 (`Docs/plans/34-*`): "W / pass-fail → requirement-satisfaction engine modeling (does a W satisfy requirement R; does P/F satisfy a letter-grade major rule)." Every claim below was verified against the real `NYU_Path` (underscore) code at HEAD `d5e757c` by a 15-agent investigation + adversarial verification + a 2-agent bulletin gap-fill; load-bearing facts carry `file:line` cites.
>
> **Scope grew (owner-directed):** the owner re-framed this as the unifying **what-if architecture** — three branches, of which W/P-F is one. This plan designs all three but implements Branch B (W/P-F) in full and Branch A (program-change upload) as a thin deterministic path; Branch C already exists.

**North-star unchanged** (`Docs/core_philosophy.md`): DPR is the authoritative source of truth; never invent a fact or trust an unverified claim as a recorded fact; not-~99%-grounded conclusions carry a confidence level + "verify with your adviser"; deterministic-on-validity then preferred; ALL NYU undergrad (NY + Shanghai + Abu Dhabi). The **frozen engine contract** (`finalizeForwardSchedule` `build.ts:64` · the 7-axis `runGraduationPathValidator` `graduationPathValidator.ts:595` · `solveForwardSchedule` `solver.ts:190` / `searchBestPlan` `search.ts:706` / `searchTopKPlans` `search.ts:773`) is **not modified** — every change edits the DPR **input** or adds a read-only classifier, exactly as F3 did.

---

## 1. The problem, in one breath

A student says (or clicks a UI control): *"I withdrew / I'll take this course pass-fail"*, or *"what if I add an Economics major?"*. Today the engine **trusts the DPR's requirement-satisfaction status verbatim and never recomputes it from grades** (`graduationPathValidator.ts:161` `// trust DPR for now`; `schema.ts:308`), so it cannot answer "does this W re-open requirement R?" or "does this P/F still count toward my major?" — it can only hedge in prose (CORE RULE 15 + the `WITHDRAW_PF_HEDGE`, `ipCourseChangeability.ts:128`). This plan makes those consequences **computed** (deterministically where policy is universal, hedged where it is genuinely school-specific), surfaced as an **assumed-fact what-if plan the student can confirm on the canvas**, with the DPR remaining the only thing that turns an assumption into a fact.

---

## 2. How it works today (verified — the seams we build on)

- **Requirement satisfaction is TRUSTED from the DPR, never recomputed from grades** on the production path. The unmet set is `notSatisfiedRequirements()` = `walkRequirements(...).filter(r => r.status !== "satisfied")` (`schema.ts:308`); the status string is parsed verbatim from the registrar PDF (`parser.ts:441-456`); both the solver (`buildSolverInput.ts:235`) and validator Axis-1 (`graduationPathValidator.ts:99,161`) consume it; the audit too (`dprToAuditResult.ts:121`). **Adversarially confirmed.**
- **A per-course grade is typed upstream but dropped at the solver boundary.** `DPRCourseRow.grade` (`schema.ts:38`), `CourseTaken.grade`/`gradeMode` (`packages/shared/src/types.ts:514,521`). It is consumed **once** as a pass/fail gate — `if (row.grade && meetsGradeThreshold(row.grade,"D")) coursesTaken.add(key)` (`buildSolverInput.ts:204`) — then discarded; the solver sees only `coursesTaken: Set<string>` + `coursesInProgress: Map<string,{term}>` (`types.ts:47,55`). `gradeMode` has **zero non-test readers**.
- **The one place satisfaction IS recomputed from a grade is the read-only probe.** `applyFailedCourseToDpr` (`failCourseTransform.ts:59-118`) deep-clones the DPR, sets the matched `courseHistory` rows to `"F"`, strips the course from each leaf's `coursesUsed[]`, decrements the counter, flips `status → not_satisfied`, and feeds the synthetic DPR back through the **unchanged** pipeline. Sole caller: `probe_counterfactual` arm B (`probeCounterfactual.ts:186`). **It models FAIL only — no W or P/F variant. This is the template for Branch B.**
- **IP courses are counted OPTIMISTICALLY (assumed-pass), flagged.** Placed fixed `source:'ip'` (`solver.ts:225-253`), credits count, satisfy no bound requirement; when an IP course is the only cover for an unmet leaf, Axis-1 returns `status:'assumed-pass'` (`graduationPathValidator.ts:195`). **This is the precedent that makes a student W/P-F claim philosophically no different from the default assumption.**
- **Draft vs committed is already separated.** `PlanState` 4-union (`packages/shared/src/types.ts:1016`); draft states go to `ToolSession.studentDraftPlan`; `forwardSchedule` is written only when valid (`tool.ts:125-134`); the web overlay mirrors it (`planState.ts:52-85`). Propose→preview→confirm stages mutations in the durable `pending_mutations` table; `confirm_plan_change` re-solves the full pipeline + persists.
- **DPR snapshot + plan are stored separately.** `students.parsed_dpr` (`schema.ts:40`, written by the v2 route `route.ts:510` + `refresh-dpr` step 3 `route.ts:140` + `profileStorePostgres.ts:42`); the plan in `forward_schedules` (supersede-then-insert, `scheduleStorePostgres.ts:41-52`). **A new DPR upload fingerprints → re-parses → re-persists → supersedes the schedule** (`refresh-dpr/route.ts`). This is the owner's "the next DPR overwrites = no risk" safety net — **verified real.**
- **The Albert What-If audit already parses as a DPR.** `parser.ts:189-214` recognizes the `Degree Progress Report What-If Report` / `Career Simulation Report` title and parses it; `whatIfParse.test.ts` (green) confirms it surfaces the hypothetical Economics requirements + ECON-UA candidates + IP rows + `notSatisfiedRequirements > 0`. **The parser does NOT yet expose a `reportKind` flag** — so today a what-if upload would silently overwrite the real DPR (a bug Branch A must prevent).
- **The What-If audit is FIELD-COMPLETE vs a normal DPR — verified 2026-06-17 against the REAL PDFs** (`SAA_STD_DS.pdf` vs `SAA_STD_DS_WHATIF.pdf`, run through the exact `unpdf`→`parseDpr` upload path; PDFs gitignored as PII). Every field the engine consumes is present and populated in the what-if parse: `header.studentName`; `programs` (incl. the home-school label `UA-Coll of Arts & Sci` — so `deriveHomeSchool` still works); the FULL `cumulative` block (creditsRequired/Used 128/142, cumulativeGpa 3.481/2, residency 64/80, passFailUsed/Cap 8/32, outsideHomeUsed/Cap 18/16, timeLimitYears 8, `residencyAll`); `requirementGroups` (12, with **more** leaves — 38 vs 33 — reflecting the hypothetical major, `notSatisfied` 10 vs 2); full `courseHistory` (38 rows, 34 graded). **There is NO missing-crucial-data risk** — the what-if is structurally a complete DPR for the hypothetical scenario.
- **Caveat correction (real-PDF check):** the parser emits **14 non-fatal warnings on BOTH** the normal and the what-if PDF — the `Could not parse course row` warnings (the course-table header line + `Course Topic:` / `Repeat Code:` continuation lines) are a **pre-existing, benign baseline on every DPR**, NOT a what-if regression, and drop no course/requirement data. The **only** genuinely what-if-specific artifact in the real sample is **one** `Page N of M` prefix leaking into the `R1103 Policy Concentration` section title (the parent group then defaults to "satisfied" while its child leaves keep their real statuses). Branch A hardens that one title-leak (G4.3); the `Course Topic:`/`Repeat Code:` capture is the pre-existing DPR-3/DPR-4 parser gap (out of scope here).
- **The current `what_if_audit` tool is a read-only RAG ESTIMATE** for hypothetical programs, no file ingest (`whatIfAudit.ts:1-20`). It becomes Branch C's fallback.

---

## 3. The unifying what-if architecture (owner-designed, verified sound)

Every "what-if" the student raises routes to exactly one of three branches by **what kind of change it is** and **whether NYU can produce a deterministic artifact for it**:

| Branch | Trigger | Mechanism | Determinism |
|---|---|---|---|
| **A — Program change** (declare/switch major, add minor, change school) | student asks; agent asks them to run Albert's What-If audit + upload the PDF | parse the What-If PDF as a **synthetic DPR** (`parser.ts:189`), plan against it as a **what-if** (never overwrite the real snapshot) | **Deterministic** — Albert computed the hypothetical program's requirement satisfaction |
| **B — Grade-outcome change** (withdraw / pass-fail / [fail]) on a **current-term IP** course | student claims it (chat or a slot control) within the verified add/drop·withdraw window (F3 `classifyIpChangeability`) | transform the **current** DPR in-memory (`applyWithdrawalToDpr` / `applyPassFailToDpr`), re-plan through the frozen pipeline | **Deterministic for W (universal) + per-school P/F where sourced; hedged otherwise** |
| **C — Anything else** ("what if I take X instead of Y", open-ended policy hypotheticals) | student asks | existing `what_if_audit` (program estimate) / `probe_counterfactual` (course swap) / `simulate_alternatives` + bulletin RAG | **Estimate** — confidence-disclaimed |

The agent's router (a CORE RULE + tool descriptions) classifies the question and picks the branch. **This plan builds A (thin) + B (full); C exists.**

### 3.1 Sidebar canvas + confirm semantics (owner-decided 2026-06-17)

**Binding principle: a plan may be CONFIRMED as the student's committed plan only if it is grounded in a real DPR.** Both branches may *render* on the right-sidebar canvas (reusing the `PendingPreview` overlay), but they differ on whether **Confirm** persists:

- **Branch B (W / P-F) → renders on the canvas AND is confirmable.** The assumed course is *already the student's real enrollment* (the real DPR shows it IP); only its *outcome* is assumed, and the declared program is unchanged + real. Confirm persists the `forward_schedule`, labeled "assumes you withdraw / take P-F <course>." The next real DPR reconciles it via the normal re-plan-and-supersede flow. (Matches owner decision Q2.)
- **Branch A (program change) → renders on the canvas as a labeled, read-only EXPLORATION, NOT confirmable as the committed plan.** The whole program is hypothetical and **no registrar fact backs it**, so confirming it would let a hypothetical masquerade as the real plan. It is badged "What-if: hypothetical <program> — not your committed plan," and the CTA is *"to make this real, declare it in Albert and upload your new DPR"* → then the normal flow makes it the committed plan. (v2 MAY persist it as a separate, clearly-tagged what-if artifact distinct from the committed `forward_schedule`; v1 keeps it transient.)

Both branches obey the R1 guardrail: the synthetic/transformed DPR is **never** written to `students.parsed_dpr`. The student's F2 read-only identity fields (home school, declared programs, catalog year, grades) always continue to derive from the **stored real DPR**, never from a what-if.

---

## 4. Ground truth — per-school W and P/F policy (all 11 undergrad schools, cited)

Verified against `data/bulletin-raw/undergraduate/<school>/academic-policies/_index.md` (Shanghai's P/F lives in the `/grading/` subpage). **This appendix is the source the per-school config encodes — cite-or-hedge; never invent.**

### Withdrawal (W) — UNIVERSAL: no credit · no GPA weight · satisfies NOTHING → re-open + retake/equivalent
Confirmed across CAS (`arts-science…:310,516`), Stern (`business…:113`), Tandon (`engineering…:216`), Gallatin (`individualized…:394`), Liberal Studies (`liberal-studies…:262`), SPS (`professional-studies…:597`), Tisch (`arts…:377`), Shanghai (`shanghai/.../grading…:104`), Abu Dhabi (`abu-dhabi…:519` "GPA-neutral… you also don't earn credits"); Steinhardt inferred (medium — no verbatim no-credit line). **Procedural divergence only** (W-window length, approval path, attempt caps — e.g. NYUAD counts a W as 1 of max 2 attempts `:350`; Nursing single-sequence-withdrawal-once `:335`). **⇒ The W half is safe to model deterministically everywhere.**

### Pass/Fail — NOT universal (a CAS-only rule would be WRONG for ≥2 schools)
| School | P earns credit | P → GPA | P satisfies major/minor | P satisfies core/gen-ed | F → GPA | Cap | Source (file:line) |
|---|---|---|---|---|---|---|---|
| CAS | yes | no | **No** | **No** (FL carve-out¹) | **yes (0.0)** | 32 cr | arts-science 386,138,414,94 |
| **Stern** | yes | no | **YES** (BS-Business concentrations, BPE, BTE) | n/a | yes (F kept) | 4 courses, ≤1/yr | business 401,398,430 |
| **Steinhardt** | yes | no | **no stated bar** ("any course") | not barred | no GPA weight on P | ≤25% of program | culture-ed 453,455 |
| Tisch | elective only | no | **No** | **No** | (A–F only weighted) | 32 cr | arts 441,438 |
| Tandon | free-elective only | no | **No** | No | — | — | engineering 218 |
| Liberal Studies | — | no | **No** ("not for any required course") | No | — | — | liberal-studies 205 |
| Gallatin | yes (P) | no | **Minor: DEFERS to dept**; core/seminars/Senior-Project banned | core: banned | — | — | individualized 430,423 |
| Global Public Health | — | — | **DEFERS to home school** | defers | defers | defers | global-public-health 77,85 |
| SPS | yes | no | electives only (named prefixes excluded) | not stated | **yes (0.0)** | 16 cr + ≤1/sem | professional-studies 452,456,459 |
| Nursing | yes | no | **No** (sciences/nursing-prereqs/sequence barred; cohort-seminar is a mandatory-P/F grad req²) | **No** (CORE-UA barred) | **yes (0.0)** | ≤25% of program | nursing 233,239,211 |
| Shanghai | yes | no | **No** ("must be A–F"; lang carve-out³) | **No** | **yes (0.0)** | 32 cr, 1/term | shanghai/grading 142,186,188,190 |
| Abu Dhabi | yes (toward 128 only) | no | **No** (E/Q/X/J/Colloquium excluded; 2nd-yr+, fall/spr only) | **No** (first core attempt letter-only) | **yes (0.0)** | 3 courses lifetime | abu-dhabi 299,301,307,293 |

¹ CAS: earlier foreign-language-sequence courses MAY be P/F; only the Core-satisfying Intermediate-II level needs a letter grade (`arts-science…:94`).
² Nursing: the cohort seminar is *required* to be P/F and *is* a graduation requirement — a positive P/F-satisfies-a-requirement case.
³ Shanghai: Chinese-through-Intermediate-II + EAP cannot be P/F; a P won't satisfy a language prerequisite.

**Two corrections to the original assumption** (worth stating to any student): (a) **P/F-toward-major is school-specific** — Stern *allows* it, Steinhardt has no bar, Gallatin/GPH defer; (b) **a P/F *fail* is NOT GPA-neutral** — at CAS/Stern (and the GPA tables of SPS/Nursing/Shanghai/NYUAD) a fail counts as **0.0**, unlike a W. Only a **W** is GPA-neutral.

**Dominant default (8/11): P/F satisfies electives only, not major/minor/core.** Exceptions to encode explicitly: **Stern = allowed**, **Steinhardt = allowed**, **Gallatin-minor / GPH = defer → hedge**.

---

## 5. Owner decisions (this session)

1. **Q1 — Determinism: FULLY deterministic incl. P/F.** Compute the W consequence (universal) *and* the P/F consequence per-school from sourced policy; **fail safe to a hedge** where the school defers (Gallatin minor, GPH) or where `requirementKind` can't classify the leaf (all non-CAS today — see §7 risk).
2. **Q2 — Surface: assumed-fact what-if, re-planned, confirmable on the canvas.** Treat the claim as an assumed fact, directly re-plan, render it on the canvas for the student to **Confirm** (persisting the resulting `forward_schedule`), exactly as a normal proposal — *because the engine already plans on the assumed-pass-IP assumption, this is consistent, not novel.* The DPR remains authoritative; the next DPR re-plans + supersedes. **Guardrail (binding):** the synthetic/transformed DPR is **never** written to `students.parsed_dpr`.
3. **Q3 — P/F-fail GPA: skip exact computation, hedge qualitatively.** We cannot know the exact new GPA (other current-term IP grades aren't posted), so state only "a fail counts 0.0 and will lower your GPA — exact effect unknown until grades post." (No new planned-course grade field this pass.)

---

## 6. Philosophy refinement (philosophy #5) — APPROVED by owner 2026-06-17

**Current** `core_philosophy.md` (IP-window paragraph) + CORE RULE 15: *"any current-term change the student CLAIMS to have made is an UNVERIFIED assumption: the agent may plan around it only as a clearly-marked draft / what-if … but never records it as fact and never invents the resulting status or grade."*

**Proposed refinement** (additive — keeps "never a fact"): allow the assumed claim to drive a **confirmable** plan, because confirming a plan ≠ recording a fact.

> A student's claimed current-term grade-outcome change (withdraw / pass-fail / fail) is an **assumption**, in exactly the same sense that every in-progress course is already assumed to pass. The agent MAY compute the requirement/credit consequence of that assumption and let the student **confirm the resulting plan** — but (i) the plan is **explicitly labeled** as assuming the claim ("this plan assumes you withdraw X / take Y pass-fail — not yet reflected on your DPR"), (ii) the assumption is **never written back into the DPR snapshot** (the DPR stays authoritative; the agent never fabricates the resulting grade/status), and (iii) the conclusion carries the confidence rail + "verify with your adviser; nothing is official until your next DPR re-plans it." When a corrected DPR is uploaded, the normal re-plan-and-supersede flow replaces the assumption with fact.

**APPROVED 2026-06-17** — G6.1 lands this exact wording into `core_philosophy.md` + CORE RULE 15. Implementation is unblocked.

---

## 7. Risks & mitigations (verified)

- **R1 — DPR-snapshot corruption (highest).** If a synthetic/transformed DPR ever reaches `students.parsed_dpr`, the agent has fabricated registrar facts (violates CORE RULE 14 + philosophy). *Mitigation:* the transform output is in-memory only; only `forward_schedules` persists (write a test asserting `parsed_dpr` is byte-unchanged after a confirmed what-if). The existing probe is already this-safe (read-only).
- **R2 — `requirementKind` classifies only CAS** (`requirementKind.ts:37-44` documents this; off-CAS → `'unknown'`). A per-requirement "letter-grade-required / P-OK" gate is unreliable off-CAS. *Mitigation:* drive the P/F gate from **per-school policy** (the §4 data) at the *requirement-category* level, and **fail safe to hedge** when the leaf can't be classified — never emit a confident off-CAS verdict where data is thin.
- **R3 — Stern/Steinhardt false-negative.** A hardcoded CAS "P/F never counts" rule would wrongly re-open a Stern advisee's major leaf. *Mitigation:* the per-school config (§4) returns *allowed* for Stern/Steinhardt → the transform does **not** re-open those leaves.
- **R4 — Branch A overwrite.** An uploaded What-If PDF parses as a DPR and would overwrite the real snapshot. *Mitigation:* expose `reportKind: "dpr" | "what_if"` from the parser; route a `what_if` upload to a **what-if plan**, never `persistStudent`/`parsed_dpr`.
- **R5 — Window plausibility.** A claimed W/P-F is only actionable inside the registrar window (F3). *Mitigation:* gate *actionability* (not the requirement truth) on `classifyIpChangeability`; inherit its hedge where the campus/season window is absent (Shanghai spring withdrawal, non-NY summer/J-term).
- **R6 — `gradeMode` is unread / coarse `passFail.countsForMajor`.** *Mitigation:* enrich the per-school P/F policy (allowed-scope, carve-outs, caps) as data; the transform reads it.

---

## 8. Engine-touch justification (the frozen-contract exception)

Like F3, this is **additive + input-editing**, not a contract change:
- NEW pure transforms `applyWithdrawalToDpr` / `applyPassFailToDpr` (siblings of `failCourseTransform.ts`) — edit a cloned DPR, feed the unchanged solver/validator.
- NEW per-school P/F-policy data + a small pure `pfEligibility(school, requirementCategory)` helper (cite-or-hedge).
- NEW read-only `probe_counterfactual` arms + (Branch A) a parser `reportKind` flag + an upload route branch.
- Agent CORE RULE 15 reworded (§6) + a what-if **router** rule.
`finalizeForwardSchedule` / `runGraduationPathValidator` / the solver entries are **untouched** (assert via diff in the verification gate).

---

## 9. Tasks (subagent-driven TDD; RED-before-GREEN; per-task gates in §10)

### G0 — Foundations & guardrail
- **G0.1** Parser: expose `report.reportKind: "dpr" | "what_if"` (set `"what_if"` when the title/subtitle matched the What-If/Career-Simulation variant at `parser.ts:189-214`). *Test:* the what-if fixture → `reportKind:"what_if"`; a normal DPR → `"dpr"`.
- **G0.2** Snapshot-integrity guard: a single chokepoint that forbids persisting a DPR whose `reportKind==="what_if"` (or any synthetic transform output) to `students.parsed_dpr`. *Test:* attempting to persist a what-if/synthetic DPR throws; a real DPR persists.

### G1 — Branch B engine: the two transforms + per-school P/F policy
- **G1.1** `applyWithdrawalToDpr(dpr, courseId)` — clone; strip from every leaf's `coursesUsed[]`; decrement counter; flip `status→not_satisfied`; **do NOT set grade (GPA-neutral)**; drop from `coursesTaken` (the D-gate already excludes W). *Test:* a current-term IP course that covers an otherwise-satisfied leaf → that leaf re-opens; GPA counters untouched; idempotent; unknown courseId → no-op + flag.
- **G1.2** Per-school P/F policy data + `pfEligibility(school, requirementCategory) → "counts" | "elective_only" | "defer" | "unknown"` from §4 (cite the bulletin line; Stern/Steinhardt=counts, CAS/Tisch/Tandon/LS/SPS/Nursing/Shanghai/NYUAD=elective_only, Gallatin-minor/GPH=defer). *Test:* table-driven per school; unsourced/`requirementKind='unknown'` → `"unknown"`.
- **G1.3** `applyPassFailToDpr(dpr, courseId, outcome: "pass" | "fail")` — **pass:** keep in `coursesTaken` (credit), and re-open ONLY the major/minor/core leaves where `pfEligibility !== "counts"`; leave electives satisfied; **fail:** behave like `applyFailedCourseToDpr` (re-open) + mark the GPA hedge. Where `pfEligibility` ∈ {`defer`,`unknown`} → DO NOT re-open; attach a hedge. *Test:* CAS major leaf re-opens on pass; Stern major leaf does NOT; elective stays; defer/unknown → no re-open + hedge present.

### G2 — Branch B surface: read-only probe arms (lands value with zero contract risk)
- **G2.1** Add `kind: "withdraw" | "pass_fail"` arms to `probe_counterfactual` (still `isReadOnly:true`) calling G1.1/G1.3, re-solving the frozen pipeline, returning the computed diff + the §6 hedge + the F3 window caveat. *Test:* withdraw arm re-opens + re-plans a retake; pass arm (CAS) re-opens major; pass arm (Stern) does not; nothing persisted.

### G3 — Branch B confirmable plan (the canvas-confirm model, Q2)
- **G3.1** A `whatIfAssumption` marker on the proposed plan (label text + the assumed course/outcome) carried on the preview overlay (`planState.PendingPreview`) and the review card; Confirm persists **only** the `forward_schedule` (reuse `confirm_plan_change`), never the DPR. *Test (web):* confirming a what-if plan writes `forward_schedules` and leaves `parsed_dpr` byte-identical (the R1 guard test); the label renders.
- **G3.2** Optional slot control on a current-term IP slot ("assume: withdraw / pass-fail") gated by F3 `classifyIpChangeability` window (`withdraw_pf`/`add_drop`). *Test:* control shows only inside the window; outside → the hedge, no control.

### G4 — Branch A: program-change what-if upload (thin, deterministic)
- **G4.1** Upload route accepts a What-If PDF (reuse the `/api/onboard` extract+parse), detects `reportKind:"what_if"` (G0.1), plans against it as a **labeled read-only what-if EXPLORATION** rendered on the sidebar canvas (badge "What-if: hypothetical <program> — not your committed plan"; **no Confirm-as-committed** — §3.1), and **never** calls `persistStudent`/writes `parsed_dpr` (G0.2 guard). The CTA points the student to declare-in-Albert + upload-a-real-DPR to make it the committed plan. *Test:* uploading the what-if fixture renders a hypothetical-program plan on the canvas labeled non-committed; `parsed_dpr` byte-unchanged; no `forward_schedule` is persisted as the committed plan from a what-if upload.
- **G4.2** Agent routing: a major/minor/school-change question → ask the student to upload the Albert What-If audit (Branch A); a course-swap/open question → Branch C estimate. *Test:* router classification eval.
- **G4.3** Parser robustness for What-If reports (verified field-complete, but a few extra warnings): strip a `Page N of M` prefix that lands on a section-header line (so a parent group isn't mis-defaulted), and attach `Course Topic:` / `Repeat Code:` continuation lines + skip a stray course-table header row. *Test:* parsing the what-if fixture yields **0** `Could not parse course row` warnings and no `Page N of M`-prefixed section title; cumulative + courseHistory counts unchanged. (Field-completeness itself is already verified — §2.)

### G5 — Agent voice + router
- **G5.1** Rework CORE RULE 15 to the §6 wording (assumption-may-drive-a-confirmable-plan; never a DPR fact; confidence rail). *Test:* `systemPrompt.test.ts` asserts the new rule for all home schools.
- **G5.2** A CORE RULE / tool-description router for the 3 branches. *Test:* branch-selection eval.

### G6 — Docs + philosophy (philosophy #6)
- **G6.1** On owner sign-off (§6), update `Docs/core_philosophy.md` (IP-window paragraph) with the refinement.
- **G6.2** Revise `Docs/current-system/engine/dpr.md` (requirement model: add the transform layer + the what-if branches), `Docs/current-system/tools/what_if_audit.md` (+ probe arms + Branch A), `Docs/current-system/engine/system-prompt.md` (CORE RULE 15 v2 + router). Mark this plan COMPLETE; update memory.

---

## 10. Verification gates (per task)
Subagent-driven TDD; RED-before-GREEN; full `vitest` green at repo root; `cd packages/engine && npx tsc --noEmit` + `cd apps/web && npx tsc --noEmit` (3× when engine touched); **0 `.js` shadows**; a **diff assertion** that `build.ts` / `graduationPathValidator.ts` / `solver.ts` / `search.ts` frozen entries are unchanged; the **R1 snapshot-integrity test** (parsed_dpr byte-unchanged after any what-if confirm) is a launch gate; scoped commits with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer; branch off `main` → PR → merge; preserve `pnpm-lock.yaml`; never `git add -A`.

---

## 11. Sequencing & scope notes
- **Order:** G0 → G1 → G2 (ship read-only probe value first, zero risk) → G3 (canvas-confirm, needs §6 sign-off) → G4 (Branch A) → G5 → G6. G2 is a clean intermediate release if the owner wants to validate before G3.
- **In scope:** W (all schools, deterministic), P/F pass+fail requirement re-open (per-school, hedged where defer/unknown), the canvas-confirm assumption model, Branch A upload, the router, the §6 philosophy refinement.
- **DEFERRED (own follow-on, NOT this plan):** exact GPA recomputation of a hypothetical fail (needs a planned-course grade field + wiring the unused `gpaCalculator.ts`; Q3 = skip+hedge); attempt-cap modeling (NYUAD 2-attempt, Nursing sequence); per-requirement `requirementKind` classification beyond CAS (`requirementKind.ts:37-44`); composed what-ifs (Branch A ∘ Branch B, e.g. "withdraw X *and* add a major"); sourcing the absent F3 calendar windows (Shanghai spring withdrawal, non-NY summer/J-term).

---

## Appendix A — files this plan touches (all additive / input-editing)
`packages/engine/src/dpr/parser.ts` (+`reportKind`) · `schema.ts` · NEW `withdrawTransform.ts` / `passFailTransform.ts` (siblings of `failCourseTransform.ts`) · NEW `pfEligibility.ts` + per-school P/F data (`data/schools/*.json#passFail` enrich) · `agent/tools/probeCounterfactual.ts` (+arms) · `agent/systemPrompt.ts` (CORE RULE 15 v2 + router) · `apps/web/app/api/onboard/*` (Branch A branch + guard) · `apps/web/app/chat/planState.ts` + review card + `slotState.ts` (whatIfAssumption label/control) · `apps/web/lib/db/*` (guard only — no schema change) · docs in `Docs/current-system/*` + `Docs/core_philosophy.md`. **Frozen:** `build.ts`, `graduationPathValidator.ts`, `solver.ts`, `search.ts`, `constraintModel.ts` coverage logic.
