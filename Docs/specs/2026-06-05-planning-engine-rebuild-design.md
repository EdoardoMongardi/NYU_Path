# NYU Path — Planning Engine Rebuild: Design

**Date:** 2026-06-05
**Status:** Design (approved in brainstorm; pending spec review → implementation plan)
**Scope:** The course-planning core — engine + advisor surface + experience — for ALL NYU undergraduates (Washington Square + Shanghai + Abu Dhabi), not CAS-only.
**Companion inputs:** `AUDIT_FINDINGS.md` (2026-06-05), the core-philosophy memory, the de-CAS audits, and the Phase 7-B roadmap. Visual mockups for this design live under `.superpowers/brainstorm/` (gitignored).

---

## 1. Problem, in one frame

The philosophy requires planning to be **"deterministic on validity,"** then **"preferred"** among valid plans. That is a **constraint-satisfaction + optimization** problem: *hard constraints define "valid" (the feasible set); soft constraints + an objective define "preferred."* Almost every `PLAN-*` finding is a symptom of the engine not being built that way:

- **Validity isn't actually enforced.** The offerings map is wired empty so terms-offered is never checked (PLAN-1); the validator counts unbound placeholders as satisfiers and null-gates the credit-floor axes (PLAN-4); the **edit path skips the 7-axis validator** and drops the grad goal + coreqs (PLAN-2/3/15). Root cause **RC-4: two divergent plan pipelines of unequal rigor.**
- **The algorithm can't do "valid then preferred."** Greedy single-pass, first-fit, no backtracking (`solver.ts:1191`): it can report *infeasible when a valid plan exists*, produces one plan, and scores workload balance *post-hoc* instead of optimizing it (PLAN-6/7).
- **Advisor behavior is missing though the data exists.** The solver already attaches per-slot rationale, but nothing tells the agent to explain *why*, distinguish locked-vs-movable, or surface risk/trade-offs (PLAN-8/10/15).
- **Chat and sidebar disagree.** The v2 chat route never hydrates the persisted plan/prefs (PLAN-14).
- **Still CAS-coupled at the input layer.** Home school silently defaults to `cas` (CAS-1); inline CAS defaults instead of per-school config (CAS-8); requirement tiering by keyword-matching DPR text instead of the DPR's structured hierarchy (RC-3/HARD-2).

**The spine that fixes most of this generally (not per-case): _validity is a contract._** The `graduationPathValidator` becomes the **single definition of "valid"**; the solver satisfies it **by construction**; **every** edit re-runs the **same** validator; nothing — agent, UI, or stored state — claims "valid" without it.

---

## 2. Decisions locked in this brainstorm

1. **Sequencing: foundation-first.** Fix input correctness before rebuilding the solver — a new solver on CAS-coupled, keyword-matched, unwired inputs would still be wrong for non-CAS students and still mis-report validity.
2. **Solver: a hand-rolled constraint search** (backtracking + forward-checking + branch-and-bound), behind a **solver-agnostic constraint model**, returning **top-K distinct valid plans** ranked by a preference objective. Chosen over an external MILP/CP-SAT optimizer because the problem is tiny (~8 terms × tens of requirements), **explainability is a first-class requirement** (the decision trace *is* the explanation; black-box optimizers fight per-slot "why"), and the deploy target is serverless TS. A **pluggable external backend** is kept for the future FOSE section-packing sub-problem.
3. **Scope: structural now, FOSE phased last.** Build the complete structural engine for all schools/terms; include the cheap near-term FOSE pieces (status, time-conflict, summer/J-term enumeration); defer the heavy live axes (auto-swap, waitlist number, campus, instructor, recitation pairing, section materialization).
4. **Requirement source: ride the DPR; never hand-author; RAG only for qualitative rules.** (See §4.)
5. **Edits are never instant.** Every add/drop/swap/move is a **proposal → verify (valid? + trade-offs) → preview → confirm**. Input via chat + a per-course ⋯ menu (no drag, to avoid an "instant-move" illusion).
6. **Explanations are an open-ended agent, at any scope** — not pre-built routes. (See §6.)
7. **UI: NYU violet**, evolving the existing sidebar (which already has the grid), not a from-scratch rebuild.

---

## 3. Architecture (five layers + deferred FOSE)

```
① Sources of truth  → ② Foundation (correct inputs) → ③ Engine (one pipeline)
                                         → ④ Advisor agent → ⑤ Experience + continuity
                                                                   ⋯ ⑥ FOSE (deferred)
```

- **① Sources of truth.** Parsed DPR (requirements audit, taken/IP, GPA, caps) · the **17,122-course catalog** = descriptions + embeddings for **semantic search only** · the **structured planner facts** in `packages/engine/src/data/*.json` · bulletin RAG · per-school config (11 schools) · student preferences + intended major.
- **② Foundation.** Six normalizers → one typed `SolverInput`. (§5)
- **③ Engine.** One builder → constraint model → search → top-K valid plans → validator-as-contract → rationale recorder. (§7)
- **④ Advisor agent.** Open-ended agent + planning toolbox + honesty rail. (§6)
- **⑤ Experience.** Chat + plan canvas sharing one state; propose→preview→confirm edits; any-scope explainer; onboarding/preference wizard; DB. (§8)
- **⑥ FOSE.** Deferred live-data follow-on. (§9)

**Reuse vs rebuild vs new.** *Reuse:* the validator decomposition, workload-tier classifier, rationale/flex/downstream types, persistence schema, the drag-grid sidebar, the agent loop (pure RAG, no keyword routing), the response validator. *Rebuild:* the greedy search core; the two divergent builders → one. *New:* the requirement model from the DPR hierarchy, the trade-off engine, the engine-introspection/counterfactual tools, the preference compiler, proactive elicitation, the why/locked/risk prompt rules, the onboarding wizard.

---

## 4. Requirement-source strategy (no hand-authoring)

The dependency on hand-authored program rules **dissolves**: NYU's degree-audit already encodes every major's rules and computes them per student — the **DPR is that computation, already structured**.

- **Lane A — declared students (deterministic backbone):** the DPR audit gives unmet requirements + **enumerated candidate courses** + taken/IP/TE + GPA → the solver's hard constraints. No authoring, no RAG. Broad "choose-N / 200-level" groups expand candidates from the **structured catalog** (`courses.json`: dept + course-number-as-level + exclusions).
- **Lane B — switching / undeclared / comparing majors (validated 2026-06-05):** the student runs an Albert **What-If** audit for the intended major and uploads it. **Confirmed: a What-If report *is* a DPR** — same rule IDs (`R1001/10`, `R1680/10`, `R4000/10`…), full course history with grades/units/type, **enumerated candidate courses** (`ECON-UA …`), IP rows, GPA — so it drops straight into Lane A. Needs a minor parser adaptation for the "Career Simulation Report"/"Non-Primary Major" header/labels. Fallback when no What-If is available: a **RAG preview** of the bulletin program page, explicitly marked "preview · verify on declaration," confidence lowered.
- **Lane C — qualitative / policy rules (runtime RAG):** "does P/F count toward my major," double-counting, prereq prose, petition rules, "why/how." RAG with citation + confidence. **Never** defines the core validity skeleton.

**Supersedes** the existing `what_if_audit` tool's authored-clone path (and its `crossProgramAudit` dependency on `data/programs/*.json`) — dead in production anyway. Authored program data becomes an *optional* nice-to-have for richer undeclared previews, never a blocker.

---

## 5. Layer ② — Foundation (the input-correctness contract)

Six normalizers produce **one** Zod-validated `SolverInput` consumed by **both** the initial plan and every edit (collapsing `build.ts` + `planChangeHelpers.ts` — kills RC-4). Fail-closed: malformed input errors loudly, never silently yields a wrong "valid" plan.

| # | Normalizer | What it does | Closes |
|---|---|---|---|
| A | Home-school resolution | Onboarding-**confirmed** home school (DPR proposes, student confirms via `homeSchoolOverride`); underivable → school-agnostic NYU + DPR-only caps, **never** silent "cas" | CAS-1 / RC-1 |
| B | Per-school config | Every cap/floor/suffix from `schoolDefaults` + `data/schools/*.json`; add per-sem credit target + part-time floor to `SchoolConfig`; one school vocabulary | CAS-8 / RC-2 |
| C | **Requirement model** ★ | Typed model from the DPR's **structured requirement-group hierarchy** (ruleId · kind · credits · candidates · status); heavy/easy tier from the **structural role**, not keywords | RC-3 / HARD-2 |
| D | Undeclared / What-If | Detect undeclared/no-major-audit → ask intended major → What-If DPR (deterministic) or RAG-preview (tagged) → same requirement model + confidence tag | (§4) |
| E | Catalog facts | Load `courses.json` (credits, terms, exclusions, repeat), `courses-offerings.json` (+conf), `prereqs.json` (prereq+coreq), `off-catalog-credits.json`; **populate the offerings map** | PLAN-1 |
| F | Student record | No synthetic grades; IP excluded from GPA; read authoritative GPA + required floor; real semesters-completed; carry advisor waivers (+ fingerprint), repeat codes, residency rows; wall-clock current term; thread `graduationTarget` | DPR-1…6 / PLAN-11 |

Plus **de-null-gate the validator** (count only *bound* courses as satisfiers; run major-credit / upper-level / residency / school-core floors) — PLAN-4.

**Data-model correction (important):** the 17,122-course `data/course-catalog/` is descriptions + embeddings (semantic search only); the structured planning facts live in `packages/engine/src/data/*.json`. Exclusions + repeatability come along as bonus validity facts.

---

## 6. Layer ④ — Advisor agent (open-ended, grounded)

**Not** a dispatcher of pre-built explanation routes (that keyword-routing was already removed). **One agent loop** interprets any question — structured or unexpected — and **composes tools** to answer it.

- **Toolbox:** plan introspection (current plan + recorded rationale) · **counterfactual probe** (re-solve with a constraint: "can I / why not / how do I / what if I fail X") · trade-off diff · DPR inspection · catalog inspection · bulletin RAG.
- **Explanations at any scope:** a course, a term, the whole timeline, strategy/what-if, a comparison, or policy — each grounded in a *different composition* of probes + RAG. The canvas click / ⋯ "Explain" is sugar that pre-fills a course-scope question; chat is the real channel.
- **The honesty rail (open-ended ≠ hallucinating):** plan facts come from the **engine** (never guessed); policy facts from **RAG** (cited); if neither grounds it → best partial answer + state the uncertainty + point to the human advisor. The response validator (which already pins GPA) is extended to catch ungrounded **plan** claims.
- **Risk & trade-offs are first-class** (§7.4), surfaced proactively on agent proposals AND student edits, with confidence + verify-with-adviser.

**Unmodeled preferences — a "preference compiler" ladder** (philosophy: "use LLM to adjust as much as possible"):
1. Map to an existing soft field (deterministic) — most "unmodeled" prefs are modeled in disguise.
2. Compile to a **generic constraint primitive** (deterministic) — per-term tier caps, avoid/force co-term pairs, ordering, day/time windows@FOSE — parameterized from NL, no per-pref hard-coding.
3. Fuzzy/qualitative → LLM **re-ranks the top-K valid plans** (only selects among valid; never edits into invalidity). Content prefs ("project-based") use semantic search over the 17k descriptions to tag courses.
4. Implies a specific change → LLM **proposes**, engine **validates** (apply + trade-offs / refuse + why).
Always: persist the compiled preference; explain how it was interpreted + confidence; clarify if ambiguous; if it needs data we lack → say so + verify. An unmodeled preference can never produce an invalid plan or a fabricated claim.

---

## 7. Layer ③ — Engine

### 7.1 Constraint model
- **HARD (defines "valid" — the validator's axes):** requirement coverage by **bound** courses (PLAN-4) · prereqs in earlier terms · coreqs same/earlier term · terms-offered season match (PLAN-1) · per-term credit ceiling · per-term floor (F-1 ≥12 unless RCL / domestic part-time) · graduation ≤ goal target (PLAN-2) · aggregate floors (degree-total · major-credit · upper-level · residency incl. joint-major · school-core) (PLAN-4/DPR-6) · category caps (P/F · outside-home · online) · exclusions / no invalid double-count + repeat handling · taken=locked / IP=fixed-in-term · *(FOSE-light)* no time-conflict / not closed.
- **SOFT (ranks "preferred"):** workload balance — even heavy/easy across terms (default on, PLAN-7) · load-style + per-term light/heavy · time-to-degree · pins · course/content prefs · summer/J-term if opted-in (now enumerated, PLAN-5) · study-abroad/honors · *(FOSE-later)* instructor/mode/campus. **★ An explicit student-specified schedule is the highest-weight soft term** — it overrides claimed prefs but never validity.
- **Priority hierarchy:** ① VALID (hard) → ② EXPLICIT student schedule → ③ STATED prefs (weighted) → ④ DEFAULTS (every unspecified field).

### 7.2 The search (one solve)
Most-constrained-first variable ordering (prereq-depth → flexibility → weight) → best-first candidate `(course, term)` ordering by the objective → forward-check/propagate (prereq windows, credit slack, offering windows, cap usage; prune emptied domains) → **backtrack** on dead-ends → branch-and-bound, keep **top-K distinct valid plans**. Complete at this scale; deterministic via fixed ordering.

### 7.3 Validator-as-contract loop
Initial plan and every edit go through **one builder → one search → one validator**. Edit = apply the change as a constraint → re-solve the rest → validate → **valid?** apply + trade-offs; **invalid?** refuse + explain the binding constraint. The post-hoc validator is defense-in-depth (a "valid" the solver got wrong is a loud bug, never a shipped plan). Kills PLAN-2/3/14.

### 7.4 Trade-off engine (between two valid plans)
Deterministic diff across 8 dimensions — graduation term · requirement coverage · workload/balance · prereq cascades · petitions/approvals · risk/buffer · preference-fit · caps usage — classified ✓/✗/⚠ and ranked by salience. Computed from the structured per-slot fields both plans carry; the **agent then reasons about the diff openly** (relate to goals, RAG for policy context, weigh non-structured risk like burnout, recommend, field follow-ups) — but cannot invent a delta. Fixes PLAN-15's hollow fields.

### 7.5 Whole-degree horizon
The solver always plans **all** future terms to the graduation target (validity is a whole-degree property). "Plan next semester" = the nearest term of the full plan; any near-term edit re-solves the rest. FOSE later enriches only the immediate registration term on top.

---

## 8. Layer ⑤ — Experience + continuity

- **Workspace:** advisor chat (left) + plan canvas (right) sharing **one live state** — also the PLAN-14 fix (v2 route hydrates the persisted plan/prefs like the `/api/plan/*` routes do). Plan-level badges: validity ✓ · confidence · graduation term · trade-off count.
- **Slot states (the IP rule, visible):** 🔒 locked (taken, final) · ◐ IP (fixed in its term) · planned (movable).
- **Edit model — nothing instant:** add/drop/swap/move are **proposals** → engine verifies validity + trade-offs → canvas shows a clearly-marked **preview** (pending, credit deltas shown) + a review card (verdict + ✓/✗/⚠ + Confirm/Cancel/Ask-why) → applies only on **Confirm**. Invalid proposals never reach a preview (red card + binding constraint; canvas untouched). Reuses the existing two-stage `pendingMutationId` + plan-action-bubble machinery. Input via chat + per-course ⋯ menu (no drag).
- **Any-scope explainer:** chat-driven agent answers course/term/timeline/strategy/comparison/policy questions; canvas click is a shortcut.
- **Onboarding/preference wizard:** Upload DPR → **Confirm profile** (home school *proposed + confirmable*; undeclared → intended major → What-If or preview) → Goals (grad term, F-1/domestic) → **Preferences** (workload, summer/J-term, study-abroad/honors, free-text → compiled), every field defaulted/skippable → Plan.
- **DB:** confirm → persist to Neon (keyed by `studentId`); persistence code exists and falls back to file/memory until provisioned.
- **Palette:** NYU violet, light/dark.

---

## 9. Layer ⑥ — FOSE live data (deferred)

Section materialization + richer time-conflict, Albert auto-swap, waitlist number, campus/location, instruction mode, instructor preference, recitation (LEC+RCT) pairing. The deferred **section-packing** sub-problem (sections × meeting-times × recitations) is where a pluggable CP-SAT/MILP backend would earn its keep, behind the same constraint-model interface.

---

## 10. Phasing & exit criteria

- **Phase 0 · Contracts & fixtures (small).** Typed contracts + Zod (`SolverInput`, `RequirementModel`, `CatalogFacts`, `StudentRecord`, `Plan`, `TradeOffDiff`); golden fixtures (sample DPR, What-If DPR, a non-CAS DPR); validity-as-contract test harness. *Done when:* contracts compile · fixtures load · harness rejects an invalid plan.
- **Phase 1 · Foundation.** §5 normalizers + de-null-gated validator + one `SolverInput` builder. *Closes:* CAS-1/8, RC-2/3/4, HARD-2, PLAN-1/4/11, DPR-1…6. *Done when:* unified-builder golden tests pass on CAS + non-CAS + What-If; all 7 validator axes live.
- **Phase 2 · Engine.** Constraint model (solver-agnostic), search, top-K, validator-as-contract loop, rationale recorder, trade-off engine, balance-as-objective, summer/J-term enumeration. *Closes:* PLAN-2/3/5(partial)/6/7/15. *Done when:* completeness + never-invalid + determinism tests; trade-off golden tests.
- **Phase 3 · Advisor agent.** Introspection + counterfactual tools, grounding/graceful-degradation prompt rules, response-validator plan-claim check, preference compiler, proactive elicitation. *Closes:* PLAN-8/9/10, unmodeled-prefs. *Done when:* agent eval cases pass; ungrounded plan claims blocked.
- **Phase 4 · Experience + continuity.** Chat↔sidebar hydration, workspace UI (violet), propose→preview→confirm edit model, any-scope explainer wiring, onboarding wizard, DB wiring. *Closes:* PLAN-14, "wire up DB", "nice UI". *Done when:* chat/sidebar parity tests; e2e confirm→persist. **⚑ Stop-and-ask:** Neon `DATABASE_URL` (+ Resend/secret) before leaving the file/memory fallback.
- **Phase 5 · FOSE (deferred).** §9.

*Dependencies:* 0 → 1 → 2 → {3 · trade-offs}; 4 needs 2 + 3; 5 independent/last. Shippable at each step.

---

## 11. Cross-cutting principles (binding)

- **Validity is a contract** — the validator is the single definition of valid; solver satisfies by construction; every edit re-validates.
- **No invention / cite-or-stop** — plan facts from the engine, policy facts from RAG (cited), else confidence + verify-with-adviser.
- **General fixes only** — no per-case patches, no keyword blacklists (e.g., requirement tiering from the DPR hierarchy, preference handling via a generic compiler).
- **Confidence + verify-with-adviser** whenever a conclusion isn't ~99% grounded.
- **Never silently defer a secret/decision step** — surface stop-and-ask points (Neon DB) explicitly.

---

## 12. Open items / to verify during implementation

- DPR-parser adaptation for the What-If header/labels ("Career Simulation Report", "Non-Primary Major"); the rule-ID family is the same CAS PeopleSoft set (the separate de-CAS work for non-CAS R-IDs still stands).
- Confirm how IP rows render in a What-If report vs a standard DPR.
- Neon `DATABASE_URL` provisioning (Phase 4 stop-and-ask).
- Optional: author program-requirement data for the most-common intended majors to enrich undeclared previews.
- Tie-in with the broader de-CAS audit backlog and Phase 7-B roadmap items where they overlap (home-school confirmation, parser de-CAS).

---

## 13. Findings closed (map)

CAS-1, CAS-8, RC-1/2/3/4/5, HARD-2 → Phase 1 · PLAN-1/4/11, DPR-1…6 → Phase 1 · PLAN-2/3/5(partial)/6/7/15 → Phase 2 · PLAN-8/9/10 → Phase 3 · PLAN-14 → Phase 4 · PLAN-5(heavy)/12/13 → Phase 5.
