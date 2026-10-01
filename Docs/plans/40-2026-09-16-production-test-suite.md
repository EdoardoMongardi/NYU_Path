# Plan 40 — Production test suite, v1 (real CAS CS/Math DPR)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the implementation tasks in this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Investigation stages (1–3) are dispatched per `CLAUDE.md` §3 (one agent per unit + adversarial verification), not executed inline.

**Status:** PLANNED — nothing below is implemented. Written 2026-09-16 on branch `plan/40-production-test-suite` (worktree `~/.config/superpowers/worktrees/NYU_Path/plan-40-production-test-suite`, base `chore/deactivate-fose-live-agent` @ `4e541e4`). Owner: Edoardo. This is a **master plan**: Stage 0 and the investigation stages are fully specified here; the harness build (Stage 5) gets its own implementation plan (plan 41) once the ground-truth stages have produced the case schema's real content.

**Goal:** Build a comprehensive, repeatable production evaluation of the whole NYU Path system — every question a real student could reasonably ask that the system should handle, plus every UI operation — with independently derived ground truth, scored on correctness, quality, UI behavior, and latency, starting with Edoardo's real DPR (`SAA_STD_DS.pdf`, CAS, Computer Science/Math joint major) and extensible to more DPRs.

**Architecture:** Three harness levels over one question bank — L0 engine-in-process (fast, real LLM + real tools), L1 route-level against a production build (`next build --webpack` + `next start`, real SSE, real persistence), L2 browser-driven UI (Playwright). Ground truth is derived from the DPR text + bulletin text + the academic calendar by hand/agents with provenance, never from the system's own output; system output from a headless baseline run is kept separately as a regression baseline. Scoring is layered: deterministic checks → invariant checks on plan JSON → LLM judge with a calibrated rubric → human spot-check.

**Tech Stack:** TypeScript, vitest (existing suite), `tsx` runners under `evals/`, Playwright (`@playwright/test`, new dev dependency), Next.js 16 (webpack build), Neon Postgres (dedicated test identity), the product's own LLM stack (primary `claude-sonnet-4-6`, fallback `gpt-4.1-mini`, OpenAI embeddings, Cohere rerank).

---

## 0. Scope, definitions, non-goals

### 0.1 What "production" means for this suite

| Layer | Production configuration under test | Notes |
|---|---|---|
| Web app | `apps/web`: `npx next build --webpack` then `npx next start` (port 3000), `.env.local` with real keys | Today `next build` FAILS (see §1.2) — Stage 0.1 fixes it. `next dev --webpack` is the fallback for L1/L2 only while Stage 0 is open, and is **not** what we report against. |
| Model | `claude-sonnet-4-6` primary (extended thinking on for the streaming path), `gpt-4.1-mini` fallback | The suite evaluates the product's runtime LLM, not the coding agent. Fallback events are captured as a metric. |
| Retrieval | Real policy corpus (14,273 chunks) + OpenAI embeddings + Cohere rerank; real course-catalog embeddings | Network-dependent; latency includes them. |
| Persistence | Neon (`DATABASE_URL`) with a **dedicated test identity** (allow-listed via `AUTH_TEST_EMAILS`); the always-on `/api/session/delete` route cleans up after each run | The in-memory store is used only for L0 and for offline dry-runs of the harness itself. |
| Live class search (FOSE) | Real `search_availability` / `materialize_sections` calls | Recorded fixtures (`tools/fose-recorder`, `packages/engine/tests/fixtures/fose`) are the deterministic fallback for the regression mode. |
| Date | Real wall clock | Expected answers for date-relative questions are computed at run time (§2.4). |

### 0.2 What is evaluated

1. **Correctness** — the reply's facts match the independently derived ground truth (numbers, requirement names, course codes, policy rules with citations, plan validity, refusal/hedge behavior).
2. **Quality** — adviser-grade behavior per `Docs/core_philosophy.md`: confidence rail present when (and only when) needed, risks/trade-offs stated, no invented facts, "I/my" questions answered from the DPR not just the bulletin, one focused follow-up when context is missing, plain language.
3. **UI behavior** — the workspace renders what the engine produced (plan canvas, review card ✓/⚠/✗, Confirm rail, what-if badge, profile rail), operations do what they claim (propose → preview → confirm; invalid → red card, no Confirm; typed "confirm" intercept), and persistence survives a reload/restore.
4. **Latency** — per turn: time-to-first-SSE-token, total turn time, per-tool `callMs`, validator replays, model fallbacks; reported as p50/p90/max per category.

### 0.3 v1 scope and non-goals

- **In scope (v1):** the real DPR (`SAA_STD_DS.pdf` → redacted fixture `packages/engine/tests/fixtures/dpr_sample.redacted.txt`), the real Albert What-If report (`SAA_STD_DS_WHATIF.pdf`, Economics non-primary major + Policy concentration) for Branch-A what-if flows, and **DPR-independent** questions (general policy for any of the 11 undergrad schools incl. NYU Shanghai / Abu Dhabi, program requirements, course discovery). Both **domestic** and **F-1** variants of the same student (visa status is a non-DPR field the student may set).
- **Out of scope (v1):** other real DPRs (v2 — Stage 7 defines the per-DPR template), FOSE section-scheduling (dormant per `core_philosophy.md`), fixing product defects the suite finds (each becomes its own branch/PR), load testing.

---

## 1. What this session verified (2026-09-15/16)

### 1.1 Repo state used

- Worktree of `chore/deactivate-fose-live-agent` @ `4e541e4` (22 live tools; FOSE tools unregistered). `pnpm install --offline --frozen-lockfile` OK; `packages/engine` and `apps/web` `tsc --noEmit` both green.
- `npx vitest run` in the worktree (no `.env.local`, `DATABASE_URL` unset): **2827 passed, 1 failed, 15 skipped**. The failure is `packages/engine/tests/foundation/builderParity.test.ts:190` asserting `currentTerm !== "2026-fall"` — a date-dependent assertion that broke when the wall clock entered Fall 2026. Another session owns the fix (`fix/builder-parity-clock-timebomb`); this plan does not touch it but Stage 0.6 waits for it.
- Another session switched the main checkout mid-investigation; all work for this plan runs in the worktree (memory note `parallel-sessions-use-worktree`).

### 1.2 Production-readiness blockers found (Stage 0 items)

| # | Finding | Evidence | Consequence for the suite |
|---|---|---|---|
| B1 | **`next build` fails.** `apps/web/app/api/whatif-audit/route.ts` exports `deriveHypotheticalProgram`, `planWhatIfExploration` and two interfaces; Next's route-type check rejects non-route exports. `tsc --noEmit` does not catch it. | `next build --webpack` → `Type error: Route "app/api/whatif-audit/route.ts" does not match the required types of a Next.js Route. "deriveHypotheticalProgram" is not a valid Route export field.` (Turbopack default fails earlier because `next.config.ts` carries a webpack config; the dev script already passes `--webpack`.) | No `next start` possible → no true production L1/L2 runs until fixed. **Stage 0.1.** |
| B2 | **The test suite mutates engine data and can make real LLM calls.** `tools/bulletin-parser/extractCoreqs.ts` loads `.env.local` with `override: true` at import (line 25), and runs `main()` unguarded at module top level (line 422); `extractCoreqs.test.ts:18` imports it. `main()` calls Anthropic per matching course (~69 attempts in the baseline log: "Could not resolve authentication method") and rewrites `packages/engine/src/data/prereqs.json` (no trailing newline → whitespace-only diff when content is identical). `extractPrereqs.ts` and `validatePrereqs.ts` have the same unguarded `main()` (no test imports them today). `extractCourses.ts:292-295` shows the correct guard. | Baseline run left `prereqs.json` modified (mtime inside the vitest window). | With keys present, every `vitest run` spends API calls and can silently change solver data mid-suite. **Stage 0.2** (data freeze is a precondition for any ground-truth comparison). |
| B3 | **Hard-coded chat rate limit: 30 messages/UTC-day per identity**, in-process (`apps/web/lib/rateLimit.ts:19`, `consumeRequest(userId)` at `route.ts:206`), no env override. OTP issue is 5/day per IP. | Code read. | A full run (hundreds of turns) needs an override or identity rotation. **Stage 0.3** adds `NYUPATH_CHAT_DAILY_LIMIT` (default unchanged). |
| B4 | **Login without email is already possible** for allow-listed test emails: `issueOtp` skips Resend and returns the code as `debugCode` (`apps/web/lib/auth/otp.ts:95`; `otpLoginSmoke.test.ts`). | Code read. | The harness logs in once per identity per run via `debugCode`, staying under the 5/day OTP limit. |
| B5 | No browser-level test tooling exists (no Playwright anywhere; UI tests are jsdom render tests). | `grep playwright` over package.json files: none. | **Stage 0.4** adds Playwright. |

### 1.3 Data facts relevant to this DPR (verified in engine data / bulletin mirror)

- `CSCI-UA 421` (Numerical Computing, the one unmet CS requirement): `courses-offerings.json` → `termsOffered: ["spring"]`, confidence `historically_partial`; **no prereq record** in `prereqs.json`. ⇒ the earliest term the planner can place it is **Spring 2027**; whether that is correct vs. the bulletin is a Stage-2 verification item.
- `MATH-UA 251` (Intro to Math Modeling): data says spring-only (`historically_likely`), yet the DPR shows it **in progress in Fall 2026** — a data-vs-reality edge case the suite must exercise (the planner must never "move" an IP course; the agent must not claim it isn't offered in fall).
- `CORE-UA 4xx` in `courses.json`: `400, 402, 403, 404` (`403` flagged `irregular`) — and the U07 skeptic confirmed by grep that the bulletin mirror lists exactly the same four; per-semester topics/sections are what vary. Texts & Ideas expectations name these four and "one course from CORE-UA 400–499".
- Bulletin mirror pages that anchor policy ground truth exist locally: `data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md` (93 KB), `college-core-curriculum/_index.md` (45 KB), `programs/mathematics-computer-science-ba/_index.md` (25 KB), `courses/{csci_ua,math_ua,core_ua}/_index.md`. `data/schools/cas.json` carries cited caps (P/F 32 + 1/term, online 24, AP 32, transfer 64, per-term 18, F-1 floor 12, double-count 2, dean's list 3.65).
- Academic calendar constants (`packages/engine/src/dpr/academicCalendar.ts`): NY Fall add/drop `09-15`, withdraw `11-26`; Spring add/drop `02-04`, withdraw `04-03`; Shanghai/Abu Dhabi differ; some windows deliberately absent (hedge). Run-date determines every "can I still drop X" answer.

### 1.4 DPR headline facts (hand-read from the redacted fixture; full key = Stage 1)

Programs: Undergraduate Career (Fall 2023) · UA-Coll of Arts & Sci (Fall 2024) · Computer Science/Math Major Approved (Fall 2024) — all Not Satisfied. Cumulative: 138.00 units used of 128 (includes 28 in-progress: Spring 2026 = 16, Fall 2026 = 12 ⇒ **110 graded/earned as of 04/27/2026**), GPA 3.402 (≥ 2.0), CAS residency 80/64, major residency 56/36, major GPA 3.333, P/F 4/32 (MATH-UA 233 P, Spring 2025), outside-CAS 14/16 (⇒ only 2 credits of room; any 4-credit UB/UE course breaches), time limit 8 years from matriculation, First-Year Seminar waived (CAS UG Transfer Students group — the student transferred in from Tisch, IMNY-UT/ASPP-UT rows), 32 AP credits as `TE` rows (CSCI-UA 101, MATH-UA 121/122, PHYS-UA 11/12, EAST-UA 204, ECON-UA 2, ELECTIVE CREDIT). Unmet: **CSCI-UA 421** (R1142/20) and **Texts & Ideas CORE-UA 400–499** (R1004/10). Expressive Culture is satisfied only by the **in-progress** CORE-UA 700 (Fall 2026) — so "Am I done with Core?" is conditional on passing it. Repeat codes: MATH-UA 233 `RI`, MATH-UA 333 `R`. The what-if report (prepared 06/05/2026) simulates **Economics Non-Primary Major + Policy Concentration**; its outside-CAS rule reads **Not Satisfied** — the Stage-1 diff must explain why (it likely reflects post-April registration changes).

### 1.5 Capability inventory + question-space survey

Consolidated record: `Docs/audits/2026-09-17-production-test-capability-survey.md` (12 investigation units, each adversarially verified by a skeptic, then a synthesizer and a completeness critic — see Appendix A). The tables below carry the findings that shape the suite; per-unit detail lives in the audit record.

#### 1.5.1 Tool groups A–D (units U01–U04) — verified findings that shape the suite

Coverage: 22 live tools read end-to-end; 96 capabilities and 159 question seeds catalogued; the skeptics refuted 13 investigator claims and flagged 9 seeds whose "ground truth" was circular (derived from the stored plan) — those seeds are re-derived by hand in Stage 3.

**Known-bug watch (the system is wrong today; a case must FAIL until fixed, and each becomes its own issue/PR):**

| # | Behavior today | Where | What the case must assert instead |
|---|---|---|---|
| KB-1 | `run_full_audit` never names **CSCI-UA 421**: the R1142/20 description (238 chars) is dropped by the <220-char renderer rule, and no `search_policy` follow-up fires. | `runFullAudit.ts:443-445, :591-597` | "What's left for my major?" must name CSCI-UA 421 (via `get_program_requirements`/`search_policy` or the requirement text) — never guess a course. |
| KB-2 | Per-program GPA = cumulative GPA for every program (pool = whole transcript); the DPR's own **major GPA 3.333** (R1142/75) is never surfaced — and because the grounding validator rejects any decimal absent from a tool summary (`responseValidator.ts:170-172, 288-334`), the agent **cannot** state 3.333 today even if it knew it. | `dprToAuditResult.ts:63-91`, `runFullAudit.ts:308-335` | "What's my major GPA?": the only compliant reply today is a hedge/defer ("your DPR lists a major GPA — verify with your adviser"); 3.402 presented as the major GPA is a failure. The fix (plan 39 B1: surface R1142/75) is what turns this into a T1 case. |
| KB-3 | `get_academic_standing` emits a false "below 75% pace" warning because AP `TE` rows count as attempted-but-unearned (completionRate 0.745 on a student with no failures). | `academicStanding.ts:144,157,257-276`, `buildSession.ts:82-96` | Standing = good standing; relaying the pace warning is a defect. |
| KB-4 | `Graduation deferred by N term(s)` over-reports: `termDelta` counts 4 season slots/year, so one semester shift prints 2. | `planChangeHelpers.ts` (termDelta), `explainPlanDiff.ts` | Any "deferred by N" claim is checked against the hand-computed semester delta. |
| KB-5 | Chat-path `move` only excludes the course; placement into `toTerm` happens only on the UI route — yet the confirm-bubble template narrates a successful move. Same class: `pin` with `freeze:false` is a total no-op on the chat path; `addTerm` with a fall term is a silent no-op while the template says "Adding 2027-fall to the planning window"; `unbindFreeElective` is always a no-op while its template says the slot returns to placeholder. | `planChangeHelpers.ts:331-355, 421-440`, `explainPlanDiff.ts:180-194` | Cases assert the resulting plan JSON, never the template text; the explanation must not claim an effect the plan does not show. |
| KB-6 | `plan_forward_degree` persists an infeasible draft unconditionally; the Postgres store supersedes every live row with no state filter, so the next request hydrates the draft as the live plan. | `planForwardDegree.ts:150-168`, `scheduleStorePostgres.ts:41-77` | Multi-turn case: after an infeasible override, "show my plan" must still show the last valid plan (Stage 3 defines the DB assertion). (plan 39 / audit fix 3) |
| KB-7 | `confirm_plan_change` / `plan_forward_degree` swallow persist failures and report success (token already consumed on confirm). | `confirmPlanChange.ts:295-307` | Error-path case with a failing store must surface the failure. (audit fix 2) |
| KB-8 | `confirm_section_combination` mutates in-memory slots only — no validator re-run, no store write. | `materializeSections.ts:410-460` | A confirmed section combination must survive `/api/session/restore`; today it will not. (audit fix 4) |
| KB-9 | `search_availability` prints 0/0/0 open/waitlist/closed and no meeting times (live FOSE returns `stat:"A"` for every section); the tool description promises status + meeting times. | `searchAvailability.ts`, `statusHelpers.ts:15-23` | Replies must say "offered, seat availability unknown — confirm in Albert"; asserting open/closed is a failure. |
| KB-10 | RAG scope can never reach NYU Shanghai / Abu Dhabi chunks from a CAS session (no override pattern; `deriveHomeSchool` never yields those ids) although the corpus tags 1548 nyuad + 1258 shanghai chunks. | `ragScopeFilter.ts:46-56`, `buildSession.ts:239-264` | DPR-independent "I'm at NYU Shanghai, …" questions must get a hedge + adviser referral, never a fabricated campus rule; the all-NYU mandate case set documents the gap. |
| KB-11 | `probe_counterfactual`'s withdraw/pass-fail arms accept completed or planned courses (no D-4/D-7 guards, unlike `propose_whatif_assumption`); transforms rewrite history or no-op. | `probeCounterfactual.ts` validateInput | "What if I withdraw from CSCI-UA 310 (completed)?" must be refused/explained, not silently re-solved. |
| KB-12 | A withdraw transform keeps `row.type = "IP"`, so a current-term withdrawn course stays an in-progress assumed-pass slot and is filtered out of the solver's candidates — the re-opened requirement is not re-placed; `newUnmetRequirements` is a plan-vs-plan bound-slot diff that never shows a DPR-leaf re-open. | `buildSolverInput.ts:219-231, 277-290`, `tradeOffEngine.ts:49-53` | Branch-B cases score the cost of a withdrawal from the plan's added slots + hand DPR arithmetic, never from the "newly-unmet" line; Stage 3 decides whether this is a bug or an accepted limit. |
| KB-13 | Add/drop deadline comparison uses a UTC-midnight stamp, so any time after 00:00Z on the deadline day already counts as "past add/drop" (docs/tests say inclusive). | `ipCourseChangeability.ts`, `academicCalendar.ts` | Date-truth functions treat the deadline day itself as ambiguous → the reply must hedge on that day. |
| KB-14 | `get_credit_caps` attaches `suggestedFollowUps` but never renders them; `what_if_audit` prints an `AUDIT_UPLOAD_OFFER:` line that drives the `whatif_audit_request` SSE event (undocumented). | `getCreditCaps.ts:143-223`, `whatIfAudit.ts:157-172`, `route.ts:1027-1035` | Contract cases pin the SSE event; docs get a spec-gap fix. |
| KB-15 | The response validator's "what if" invocation rule requires one of `what_if_audit` / `propose_plan_change` / `simulate_alternatives`; neither `probe_counterfactual` nor `propose_whatif_assumption` satisfies it, so a **correct Branch-B reply** that echoes "what if" gets `missing_invocation` and burns the single replay. | `responseValidator.ts` INVOCATION_RULES; `systemPrompt.ts:484-517` (CORE RULES 15–16) | Branch-B cases assert the tool called AND count validator replays (a replay here is a defect, not the agent's fault). |
| KB-16 | The dropped FOSE engine is still live over HTTP: `POST /api/v2/materialize` → `runMaterializeFeasibleStage` → `materializeFeasible(...)`; the chat route also keeps a dead `propose_section_replan` branch. FOSE deactivation is registry-only. | `apps/web/app/api/v2/materialize/route.ts`; `chat/v2/route.ts:1099-1130` | Route-contract case: the endpoint must be gone (plan 39 D2) or documented as intentionally kept; a UI must never reach it. |
| KB-17 | The bulletin defines drop/withdraw windows in **weeks** ("first two weeks" not on transcript; "3rd–14th week" → W; after that only by petition via the College Advising Center), while the code stamps fixed month-days (add/drop 09-15, withdraw 11-26 for Fall). From a 09-02 start the 14th week ends ≈12-09, so a 2026-12-01 question is "closed" per code but W-eligible per the bulletin. | `academicCalendar.ts:105-109`; `data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md:516-518` | `dateTruth.ts` derives windows from the bulletin's week rule + the published term start, and treats code-vs-bulletin disagreement days as "must hedge". |
| KB-18 | DPR parser: a `Courses Used` table that crosses a page break is cut at the blank line — R1001/20 keeps 8 of 27 rows; only the first status-prefixed line of a requirement is kept (R20488/15's "Student Group Equal CAS UG Transfer Students" is dropped); `Undergraduate Career` and `Policy Concentration Approved` fall to `programType: "Program"`. | `dpr/parser.ts` (row loop, status loop, `parseProgramRow`); `dpr_sample.expected.json` | Stage-1 fact rows mark which facts the parser cannot read; downstream consumers of `coursesUsed` (prereq satisfaction, pool GPAs) get "known-bug watch" cases. |
| KB-19 | `run_full_audit` lists **every** IP row as "CURRENTLY ENROLLED" (Spring 2026 and Fall 2026 alike) and labels all `TE` rows "transfer" (AP test credit indistinguishable from transfer coursework); adviser notations, repeat codes and course topics are parsed but never rendered; the residency label is hard-coded "(CAS)". | `runFullAudit.ts:249-250, 268-275, 381, 465, 475-489` | "What am I taking now?" must distinguish Fall 2026 from the finished-but-ungraded Spring 2026; "Are these transfer courses?" must say test/transfer credit; non-CAS DPRs (Stage 7) will hit the "(CAS)" label. |
| KB-20 | UI: the slot popover offers only Drop / Withdraw / Pass-Fail; `move` / `swap` / `lock` exist as HTTP routes only (no UI trigger); the typed-confirm regex lacks "proceed" although the doc lists it; the 429 body never reaches the student (generic error copy); `agentStatusVerbs` covers 20 of 22 tools; clarifier turns are not persisted in chat history; `forward_materialization_update` has no render surface since Plan 37 G2. | `apps/web/app/chat/workspace/SlotActionPopover.tsx`, `typedConfirmIntercept.ts`, `chatV2Client.ts`, `lib/agentStatusVerbs.ts`, `chat/v2/route.ts` | UI cases target what exists (popover Drop/Withdraw/Pass-Fail, chat-driven moves); route cases cover move/swap/lock over HTTP; docs get spec-gap fixes. |
| KB-21 | **Frozen validator, axis 1 skips partially satisfied leaves**: any unmet leaf with `coursesUsed.length > 0` is trusted ("partial satisfaction; trust DPR"), so R1142/20 (5 of 6 used) is never validated — only the *search's* `requirementCoverage` demands CSCI-UA 421. Solver-only violation kinds (dropped pins, offering/prereq blockers) never flip the validator state, so `feasibility.feasible=false` can coexist with `state: valid-with-trade-offs`. | `graduationPathValidator.ts:173-176, 407-419`; `build.ts:114` | Every plan the system emits is re-checked by the suite's own invariant checker (Stage 3), which treats a partially satisfied leaf as unmet until covered. Changing the frozen axis is an **owner decision** (§9 #7), not a suite task. |
| KB-22 | Credit axes 3/7 double-count in-progress credits: `cumulative.creditsUsed` (138) already includes the 28 IP units and `sem.plannedCredits` re-adds the in-window IP slots (12) → over-count by 12 near the minimum. Axis 6 (`assumptionsExplicit`) can only fail when an assumption for X exists but X is absent from the assumption set — impossible, so it always passes (plan 39 B3′). | `graduationPathValidator.ts` axes 3/6/7; `buildSolverInput.ts` | Stage 3's invariant checker computes credits from the DPR rows (110 earned + IP + planned) independently; a "credits met" verdict that relies on the double count is a failure. |
| KB-23 | **No-DPR turns never reach the v2 agent through the UI**: `page.tsx:785-789` sends them to the legacy `POST /api/chat` (v1) — a one-shot OpenAI completion (temperature 0.6, maxTokens 200, no tools, no validator, no history). The v2 route also tolerates unauthenticated callers (global "anonymous" bucket; no `plan_proposal`, no persistence). | `apps/web/app/chat/page.tsx:785-789`; `chat/v2/route.ts:198-199` | The "no-DPR behavior" category has two variants: UI (v1 path, expect the upload ask only) and direct-API v2 probes; the suite must not assume the CORE-RULE no-DPR block governs the UI path. |
| KB-24 | The invocation auditor's policy-word trigger `(p/f|pass-fail|withdraw|residency|overload|repeat) (rule|policy|limit)` requires `search_policy`, so a correct DPR-only reply ("your P/F limit is 32, you've used 4") gets `missing_invocation` and a replay. Same class as KB-15. | `responseValidator.ts` INVOCATION_RULES (policy trigger) | Cases about DPR counters count replays as defects attributable to the validator, not the agent. |
| KB-25 | An infeasible confirm **consumes** the pending id (no re-stage) so a retry of the same id → 404; the workspace Confirm path discards the 422 body and shows only "Couldn't apply that change — it may have expired or conflicted. Try again from the canvas." (and "Try again" cannot succeed); the P/F guard on `/api/plan/whatif` returns **400**, not the 422 `ui-components.md` documents. | `planActionOrchestrator.ts:991-999`; `reviewCard.ts:250-254`; `planActionRouteHelpers.ts:110-111` | UI cases assert the generic copy today (defect: the failing-axis reason never reaches the student); route cases assert 400 for P/F at `canElect:false`. |
| KB-26 | `/api/onboard` has no `reportKind` guard: a what-if PDF uploaded there is summarized as the real DPR ("Got it! I read your Degree Progress Report…") and refused only at persist by the snapshot-integrity throw. | `apps/web/app/api/onboard/route.ts` | Error-path case: uploading `SAA_STD_DS_WHATIF.pdf` at onboarding must be refused *before* any summary. |
| KB-27 | `agentStatusVerbs` lacks `probe_counterfactual` and `propose_whatif_assumption` (fallback "Working"/"Used a tool") and its "parity" test is a hard-coded 20-name list; `computePlanBadges` (the "Confidence: hedged — verify with your adviser" badge) is unmounted dead code; the typed-confirm "yes" message is never persisted (absent after reload); clarifier token chunks drop newlines. | `apps/web/lib/agentStatusVerbs.ts:15-40`, `tests/agentStatusVerbs.test.ts`; `lib/planBadges.ts`; `page.tsx:770-780`; `chat/v2/route.ts:717` | UI cases must not assert the hedge badge; transcript-restore cases expect the typed "yes" to be missing today. |
| KB-28 | TE (AP) rows satisfy prerequisites but are **not** "taken" for the candidate filter (`meetsGradeThreshold('TE')` is false), so CSCI-UA 101 (already TE-credited toward R1142/20) remains a forward candidate — `computeBlockers` finds it viable in Fall 2026, so "Can I graduate this December?" never surfaces "CSCI-UA 421 is spring-only" as the blocker, and the placeholder rationale text is the generic "not in course catalog or no offering data" regardless of cause. | `gradeComparison.ts:79-88`; `buildSolverInput.ts:232-234`; `search.ts:596-660`; `materializePlan.ts:709-712` | A plan or explanation that proposes an already-credited course, or that gives the generic rationale for CSCI-UA 421, fails; the true blocker (spring-only offering) is Stage-2/3 ground truth. |
| KB-29 | `propose_plan_change` mixes two feasibility sources in one reply: the header/`feasible` flag comes from the 8-axis validator while `consequences` read the **solver's** flag. Observed: header `feasible: false` next to the bullet "Plan remains feasible after mutation." (exclude CSCI-UA 421), and header `feasible: true` next to "Plan is infeasible after mutation" (pin to a wrong-season term). | `proposePlanChange.ts:210-226`; `planChangeHelpers.ts:624-633` | Every propose case asserts the two agree, and that the agent's prose follows the validator, not the bullet. |
| KB-30 | A pin whose term contradicts the offering pattern is **silently not honored** — the proposed plan keeps the course where the solver wants it, `placementRationale` says "slack-balanced placement" rather than "Pinned", and the explanation still promises "The solver will respect this on every future re-plan." Confirming it yields a plan that ignores the pin. | baseline case 5 (`pin CSCI-UA 421 → 2026-fall`) | "Put CSCI-UA 421 in Fall 2026" must be refused with the spring-only reason, never accepted with a promise the engine does not keep. |
| KB-31 | A withdraw / pass-fail of a major course re-opens **GPA leaves** (R1142/75, R1001/20) because the transforms strip the course from every leaf's `coursesUsed` and flip it unsatisfied; `REQUIREMENT_KINDS` has no GPA kind, so each re-opened GPA leaf materializes as a phantom **4-credit critical-path placeholder** (e.g. `[Computer Science/Math Joint Major: GPA] 4cr`) that inflates the term. | `withdrawTransform.ts:93-122`; `passFailTransform.ts:183-201`; `requirementKind.ts:60-63` | Branch-B cases assert no phantom GPA course appears in the counterfactual plan. |
| KB-32 | The re-solve recommends courses the DPR already credits: after re-opening R1142/40 the plan proposes **MATH-UA 121** (grade `TE`, AP credit), and the CSCI-UA 421 slot lists **CSCI-UA 101** (also `TE`) as an alternative. Cause: a literal `"TE"` never satisfies `meetsGradeThreshold`. | `reconcile.ts:88-97`; `gradeComparison.ts:79-88`; baseline §2.4/§2.7 | Any plan or alternative naming an already-credited course fails; the honest re-fill is a retake or a genuinely unmet course. |
| KB-33 | **An all-of requirement is modeled as a pick-one pool.** R1142/20 lists six required CS courses ("6.00 required, 5.00 used, 1.00 needed"), but the engine treats them as interchangeable: in the baseline plan the CSCI-UA 421 slot lists `CSCI-UA 101` as an alternative, and after `fail_completed CSCI-UA 102` the re-solve places **only CSCI-UA 102** while CSCI-UA 421 survives merely as `rationale.consideredAlternatives[1]` / `flexibility.alternativeCourses[1]` — never as a slot. The result is returned `feasible: true`, `state: valid-with-trade-offs`, `conflicts: null` although two of the six courses are now missing. *(Orchestrator-verified directly from the recorded probe output, not only from the unit report.)* | baseline `07_counterfactual_whatif.json` → `probe_fail_completed_CSCI102`; `graduationPathValidator.ts:173-176` | The suite's invariant checker (Stage 3) must fail this plan. This is the clearest candidate for "ships an invalid plan" and belongs in §9 #7's frozen-seam decision. |
| KB-34 | The withdrawn / pass-failed course stays rendered as an `in_progress` slot, so Fall 2026 still shows 16 credits even though the engine's own F-1 hedge computes the post-withdraw 12. A reply saying "withdrawing keeps you at 16 credits" would be wrong. | baseline §2.7 (B-9); `whatIfAssumption.ts:327-343` | Branch-B cases assert the stated post-withdraw credit total matches the hedge's arithmetic. |
| KB-35 | A **domestic** student below 12 credits gets the fixed prefix "Below F-1 full-time floor (8 credits). Domestic student below 12-credit full-time threshold…" — an F-1 claim to a domestic student. | `constraintModel.ts:548`; `materializePlan.ts:911`; `visaValidator.ts:125` | A light-load case for a domestic student must not produce F-1 language; the expected response is a Tier-C adviser/financial-aid clarification. |
| KB-36 | **Prerequisite coverage outside CAS (verified 2026-09-29 against the bulletin itself).** Of courses whose bulletin entry states a real prerequisite, the planner's data records it for CAS 90% (770), Stern 100% (23), Steinhardt 97% (48), Tandon 78% (365), Tisch 72% (96), NYU Abu Dhabi 68% (460) — mostly standing/placement conditions missed at the last three — but **NYU Shanghai 1% (4 of 401), SPS 0% (148), Nursing 0% (15)**. Shanghai writes prerequisites as free text inside the description, often with nicknames ("Prerequisite: ICS or A- in ICP."), so the extractor records an **empty** list; SPS and Nursing were never extracted. This contradicts plan 39's "Shanghai prerequisites are fine", and plan 39 A2's interim warning (fires only when a course has *no record at all*) would **never fire for Shanghai**, the worst-covered school. CAS also loses escape clauses ("…OR any equivalent courses" on CSCI-UA 421). | `packages/engine/src/data/prereqs.json`; `buildSolverInput.ts:301-310`; `tools/bulletin-parser/` | The suite's prerequisite invariant reads the bulletin text for the courses in play, never `prereqs.json`; a Shanghai/SPS/Nursing plan that orders a course before its prerequisite must fail; the A2 warning must also fire on empty records for these schools. Fix = its own plan (§9 #13). |
| KB-37 | `courseSuffixMap.ts` mislabels schools: `-UN` → "Gallatin" (bulletin: Nursing), `-UF` → "Tisch" (bulletin: Liberal Studies), and has no entry for `-UG` (Gallatin) or `-UC` (SPS); `-UP` (Liberal Studies) matches no bulletin course. Only `search_courses` consumes it. | `packages/engine/src/data/courseSuffixMap.ts:32-41` | Course-search cases for Nursing, Gallatin, Liberal Studies and SPS courses assert the correct school label and home/cross-school classification. |
| KB-38 | **Refusals are shipped as empty answers.** Newer Claude models can return HTTP 200 with `stop_reason: "refusal"` and empty content. The block path maps it to `"other"`; the streaming path (the only production path) never sets `finishReason`; no fallback fires (fallback runs only on a thrown error); there is no empty-text guard, so the student gets an empty reply. | `anthropicClient.ts:269-278, 335-350`; `agentLoop.ts:380, 688-708, 930, 992`; `chat/v2/route.ts:1141-1227` | Fixed inside Task 0.8; a degradation case injects a refusal and asserts fallback or an honest message, never an empty bubble. |
| KB-39 | Thinking blocks are never replayed between tool iterations (`LLMMessage` has no field for them), so the model loses its earlier reasoning on every tool call within a turn. It is API-safe — dropping *all* thinking is allowed under the preserved-thinking rules — but costs reasoning continuity. | `llmClient.ts:23-30`; `anthropicClient.ts:148-151, 255-267` | Not a defect to gate on; a candidate quality improvement to measure after the model switch. |

**Expected hedges (accepted limitations — the correct answer is the honest limit):**

| # | Limit | Expected reply behavior |
|---|---|---|
| EH-1 | Time-limit deadline cannot be computed (no matriculation date on the DPR). | "8 years from matriculation"; date deferred to Albert/adviser. |
| EH-2 | Dean's List / honors eligibility is not computed by any tool (`deansListThreshold` unconsumed). | Bulletin-cited policy via `search_policy` + hedge; any per-year GPA labeled as a hand computation. |
| EH-3 | `semesterGPA` is always null; repeat codes, advisor notations, per-term P/F limit, independent-study caps, last-32-in-residence are in no tool's text. | Answer from the course history only; policy explanations hedged and pointed to the bulletin/adviser. |
| EH-4 | F-1 floor prints only when the profile carries `visaStatus="f1"`; the DPR never provides visa status. | Ask/confirm visa status before quoting the 12-credit floor (both variants in the suite). |
| EH-5 | `what_if_audit` never computes hypothetical requirements; program labels are LLM-chosen. | Current numbers + verbatim disclaimer + the What-If upload offer (Branch A); Econ counts only as bulletin-hedged estimates. |
| EH-6 | Registrar windows are typical per-season dates, not the year's official ones; Shanghai spring withdrawal and off-NY summer/J-term windows are absent. | Every window statement carries the typical-deadline hedge + "nothing is official until it shows on a new DPR"; absent windows → "unknown", never "closed". |
| EH-7 | Exact GPA after a hypothetical F is not computed. | Verbatim hedge "The exact new GPA is unknown until grades post …". |
| EH-8 | Per-term P/F limit (CAS: one per term) is not enforced by the 8th axis; course-repeat caps are not modeled. | Reply cites the rule from the bulletin/school config; the engine's silence is not an endorsement. |
| EH-9 | Why-not explanations are axis-level ("Axes failed: <axis>: <reason>"), not course-causal. | The agent never invents a causal chain. |
| EH-10 | FOSE has no data > ~6 months out; IP courses' sections are unknown (no CRNs on the DPR); an empty FOSE result cannot distinguish "not yet published" from "not offered". | Structural plan only for far terms; IP warning text; "may not be offered this term / confirm in Albert". |
| EH-11 | Only the top policy hit is fully reassembled; summaries are capped (policy 6000, program page 12,000, courses 2500, materialize 4000 chars; audit 5000 — the fixture's audit summary is 4459). | The agent must not claim completeness; other DPRs must measure summary length first (KB candidates if truncated). |
| EH-12 | Optimality is never claimed (feasibility-first search); offering confidence tiers make every fixture plan `valid-with-trade-offs`. | "Valid, historically offered — confirm in Albert"; never "optimal". |
| EH-13 | Preferences that need class-time/instructor data are recorded, not enforced (plan 39 C2); soft objectives on unranked dimensions cost zero. | Verbatim recorded-not-enforced phrasing; no claim that the plan changed. |
| EH-14 | The DPR is stale relative to the run date (prepared 04/27/2026; Spring 2026 still IP; the 06/05 what-if snapshot shows outside-CAS 18/16 **Not Satisfied**, 142 credits, GPA 3.481). | "Current" questions surface the prepared date and recommend a fresh DPR; the outside-CAS edge is an owner-confirm fact (Stage 1). |
| EH-15 | Validator blind spots that only an LLM judge can score: hedged Tier-1 numbers, omitted envelope disclaimers, refusal wording, CORE RULE 9–12/15 wording, shortfalls phrased without "N <unit>", and rounding — U05 reads `3.402 → 3.4` as passing grounding by substring, U01's skeptic reads it as blocked; Stage 4 pins this with a unit probe before authoring rounding cases. | The judge rubric owns these dimensions; deterministic checks must not be assumed to catch them. |
| EH-16 | Terminal states have fixed observable text: no-DPR refusal "I can only run an audit from your Albert Degree Progress Report (DPR). Please upload your DPR and try again."; context exhaustion "I'm running out of context for this conversation…" with `modelUsedId` suffixed `:context_limit`; `max_turns` → SSE `error` event with no reply; a validator failure after the single replay ships with `validator_block` and the UI chip "⚠ Could not fully ground this reply."; a fabricated blockquote is stripped with an italic note. | Error-path cases assert these exact observables. |
| EH-17 | Proactive elicitation is deterministic for only three signals (undeclared program, major exploration without an interest, global-campus without study-away intent); a graduation-timeline ask is LLM-only. | Elicitation cases require the append only for the three signals; timeline asks are judged, not asserted. |
| EH-18 | Branch-A what-if explorations are never adoptable in-app (discard only; adopt by declaring in Albert + uploading a new DPR); proposed/what-if scenario tabs are session-only (only "My Plan" persists); the agent sees confirmed plan/profile changes only on the next turn; the profile rail's visa value is client-derived until reload. | UI/multi-turn cases assert these as correct behavior, not defects. |
| EH-19 | `what_if_audit` is the third semi-hardened tool: its REQUIRED DISCLAIMER is `verbatimText` and `checkVerbatim` enforces it; its summary contains "(estimate", so **hedged integer** estimates ("about 8 more courses") pass grounding when adviser-caveated, but decimals never do. | Branch-A/C cases require the disclaimer verbatim + a hedge on any count; a decimal in such a reply is a failure. |
| EH-20 | Run-date facts (as of 2026-09-16, one day past the NY Fall add/drop constant): Fall 2026 IP rows classify `withdraw_pf`, "+ Add course" is hidden on Fall 2026, Spring 2026 rows are `closed` (hedge text ends "nothing changes until it shows on a new DPR" — differs from the other hedges' "nothing is official…"). The two "current term" notions differ: `buildSession.currentSemester.term` = latest IP term (`2026 Fall`) vs `deriveTemporalContext` wall clock (`Fall 2026`, next `Spring 2027`). | Date-truth functions compute all of this from the run date; string assertions use the exact per-window hedge text. |
| EH-21 | Independent unit sums on the fixture: EN 82 + TE 32 = 114 completed + 28 IP = 142, vs the DPR counter 138 — the repeated MPAJZ-UE 71 (A earlier; IP Spring 2026) accounts for the 4. The DPR counter is authoritative for "credits used"; the honest answer to "how many credits do I still need?" is "0 short *if* the 28 in-progress credits pass". | Stage-1 fact rows carry both sums and the reconciliation; replies must not present 138 as graded credit. |
| EH-22 | Texts & Ideas: the catalog pool (CORE-UA 400, 402, 403, 404) equals the bulletin's list exactly; what varies per semester is topics/sections. The 12/16/18-credit rules are cited bulletin facts for CAS (`academic-policies/_index.md:500`), not modeling defaults. | Expected answers cite the four course ids and the bulletin lines; a "longer list exists" hedge is wrong. |
| EH-23 | **No plan on this DPR can ever be `valid-clean`.** `thresholdsMet` resolves to `requires-approval` because `majorCreditMinimum` is null in the validator rules (the DPR's own major-residency counter R1142/80 36/56 is not mapped), and `derivePlanStateFromValidator` also downgrades whenever placeholders exist. Both hold here. | Every plan case expects `valid-with-trade-offs`; a reply claiming the plan is "fully verified" over-claims. The tool header's "(see assumptions)" is misleading — `assumptions` is `[]` — so the agent must name the concrete trade-offs (unbound pool slot; thresholds need adviser sign-off). |
| EH-24 | Per-axis validator verdicts are **not** exposed by `plan_forward_degree`; axis names surface only inside `propose_plan_change.conflicts[].detail` ("Axes failed: `<axis>`: `<reason>`"). | The harness calls `runGraduationPathValidator` directly for axis-level assertions rather than parsing prose. |
| EH-25 | Verbatim what-if strings to assert: every hedge list contains "This is an unverified assumption — verify with your adviser; nothing is official until your next DPR."; a P/F fail adds "A Pass/Fail FAIL in `<course>` counts as 0.0 and will lower your cumulative GPA. The exact new GPA is unknown until grades post — we do not recompute it here. Verify the impact with your adviser."; labels read `Assumes you withdraw from <course> (a "W" — GPA-neutral; the requirement re-opens).` | Branch-B cases assert these verbatim. Whether CAS actually records a P/F failure as an F in the GPA is a Stage-2 bulletin question; until settled the agent's wording must stay hedged. |

**Spec gaps to fix in docs (not test cases):** 37 doc-vs-code divergences recorded in the unit reports (e.g. `what_if_audit.md` output shape, `search_policy.md` explicit-override list, `run_full_audit.md` "credits earned" label meaning "used incl. IP", `materialize_sections.md` O/W-only filter vs O/W/A code, `Docs/index.json` "24-tool surface" label, stale header comments in `policySearch.ts`/`searchCourses.ts`). Filed as a doc-sync task in Stage 4.

#### 1.5.2 Behavioral rules (U05), web/UI operations (U06), planner semantics (U07), DPR ground truth (U08) — verified findings

- **Behavior catalog (U05):** 27 testable behaviors with exact strings — the 16 CORE RULES, the 8 validator checks with their trigger regexes and caveat substrings (`F-1`, `adviser|advisor|consult`), the Tier-2 estimate exemption (hedged **integers** only, never decimals), the clarifier gate, the one-question elicitation append (`ELICITATION_LEAD_IN` marker), compaction tiers (128k assumed window), `maxTurns=10`, `validatorReplayLimit: 1`, fallback model detection via `done.modelUsedId`. Thirteen doc-vs-code drifts recorded (route line numbers, CORE RULE 6's envelope field list, the "25 rules" comment, which validator enforces the `get_credit_caps` verbatim). Harness rule derived: call `validateResponse` **with** `userQuestion`, exactly as the route does, or the verbatim check takes its conservative always-fire path.
- **UI + routes (U06):** 30 user-visible operations catalogued with their network calls and expected UI state; the SSE contract (`plan_proposal`, `whatif_audit_request`, `validator_block`, clarifier stream, `done.finalText`, `error`); HTTP contracts (v2 route `400 awaiting_dpr` without a DPR; `422` never-commit-invalid with the failing axis; `429` chat 30/day and plan-action **60/day**; `/api/plan/whatif` `400 bad_input` for P/F at `canElect:false` schools; always-on `DELETE /api/session/delete`). Only **three** `data-testid`s exist today → Stage 0.4 adds a minimal testid set (tabs, bubbles, tool rows, action buttons, composer). Open: whether OTP login needs Postgres even in in-memory mode (decides Neon vs a session-minting seam), and whether `/api/onboard/refresh-dpr` returns the `dpr` field the client reads.
- **DPR ground truth (U08):** 39 hand-derived seeds and a first fact table (≥80 rows in the unit report) with page/rule provenance; independent derivations pinned: graded/earned credits **110 = 78 graded + 32 test credit** (not 138); catalog year `2024-2025` is a *system inference* from the requirement term "Fall 2024" (independent truth = the term); the outside-CAS counter is 14/16 on the main DPR and **18/16 Not Satisfied** on the 06/05 what-if snapshot (owner-confirm); what-if snapshot totals 142 credits / GPA 3.481 / P/F 8; the CAS program requirement term prints Fall 2023 on the what-if vs Fall 2024 on the main DPR (Albert artefact — owner-confirm). Parser findings feed KB-18/19 and the Stage-1 "systemCanRead" column.
- **Planner semantics (U07):** the 8 axes documented with their exact inputs and the invariant each test can re-derive (requirement coverage, prereq order, offering terms, credit floor/ceiling by visa, graduation ≤ target, IP untouched, no repeats, P/F cap); the solver consumes `courses-offerings.json` gap-filled from `session.courses[].termsOffered` (so a course missing from both is silently "any term" — the plan-39 A2 schools), `prereqs.json` (missing entry = no constraint), and a 200k-node feasibility-first search that never claims optimality. Preference dimensions honored vs recorded: pin / exclude / swap / addTerm / loadStyleOverride change the plan; `setSchedulingPreference`, `addSoftObjective` (unranked dimensions), `allowBelowF1Floor` and `creditTargetPerTerm` are recorded only. Executed scenarios showed: a dropped pin can leave `feasibility.feasible=false` under `state: valid-with-trade-offs`; the J-term year convention differs between the solver (`YYYY-january` sorts after `YYYY-fall`) and the calendar stamping; domestic students get the F-1-worded violation text and no part-time advisory; the double-count advisory is envelope-only. For this fixture the expected valid-plan space is small: CSCI-UA 421 (spring-only) + one CORE-UA 4xx, earliest graduation **Spring 2027**, with F-1 needing the OGS final-term exception or fillers — Stage 3 derives it by hand.
- **Skeptic verdicts so far:** all eight verified units are *partially reliable* — 40 investigator claims refuted, 88 corrected, 120 items the investigators missed were added, and ~45 seeds were flagged **circular** (truth taken from the engine's own output, constants, or tests). Every circular seed is re-derived by hand in Stages 1–3; the harness's data-freeze and provenance rules (§2) exist because of this.

#### 1.5.3 Existing eval assets (U10) — reuse inventory

The repo already holds ~7 eval asset families. The verdict is **reuse the machinery, retire most of the content**: the cases were authored against a 2026-04/05 tool surface and drifted.

| Asset | What it is | Verdict |
|---|---|---|
| `evals/cohort/runner.ts` + `composite.ts` | Conversation runner over `runAgentTurn` + a 4-dimension composite scorer (grounding / completeness / uncertainty / non-fabrication) | **Reuse the shape, not as-is.** `runCohort` passes no `validateResponse` and no replay limit, unlike the route — it scores a *weaker* system than production. The L0 runner must wire the validator exactly as `chat/v2/route.ts` does (incl. `userQuestion` and `forwardSchedule`). |
| `evals/cohorts/cohort_a*.ts` (65 cases, incl. 8 real-DPR cases) | Hand-authored conversation cases with `expectedToolCalls` / `requiredCaveats` / `forbiddenPatterns` | **Content stale, some cases salvageable.** Several expect `plan_semester` (removed from the registry) and the set is locked by a frozen hash, so it cannot be silently corrected — retiring or re-freezing is an explicit step. The 8 real-DPR cases are the closest ancestor of this suite and their expectations are re-derived in Stage 1. |
| `evals/golden/{tool_selection,synthesis,decomp}.json` (46 claimed) | Frozen golden sets for a model bake-off | **Retire.** They pin removed tools (`plan_semester`, `check_transfer_eligibility`, `get_enrollment_status`); `synthesis.json` `_meta` claims 18 cases but the array holds 16. |
| `evals/cohorts/phase10_{edgeCases,adversarial}.ts` | 26 + adversarial cases with `autoChecks` + `judgeRubric` | **Highest-value reuse.** Most probe behaviors that still exist (fabrication, refusals, off-domain, non-existent courses). Re-verify each expectation against the current code before adopting. |
| `tools/cohort-eval/run*.ts` | Live runners (smoke, baseline, adversarial, surrogate) | **Reuse the P0/P1/P2 bug-classification idea; the runners themselves are broken.** `runSmokeW10.ts:289` and `agentLoop.live.test.ts:49` construct `new OpenAIEngineClient({ modelId: DEFAULT_PRIMARY_MODEL })` where `DEFAULT_PRIMARY_MODEL` is the **Anthropic** id `claude-sonnet-4-6` — the call cannot succeed against OpenAI. |
| `packages/engine/tests/eval/judgePrompt.ts` + `cohensKappa.ts` | Claim-level LLM-judge rubric + agreement math | **Reuse.** No κ has ever been computed for the 4-axis rubric judge, and the Phase-10 baseline runner used the *same model* for agent and judge (self-grading) — Stage 6's calibration fixes both. |
| `packages/engine/tests/eval/profiles/*.json` (13 files; README says 12) | Synthetic student profiles | **Reuse for DPR-independent and multi-school cases**; they are not DPRs, so they do not feed the DPR-dependent categories. |

Two items that need action regardless of reuse:

- **PII in eval assets.** `evals/cohorts/bakeoff_25.ts:10` names the real student in a comment, and `tools/cohort-eval/runPhase10Baseline.ts:70` reads the **raw** `SAA_STD_DS.pdf` and slugs `dpr.header.studentName` into `student.id`. The new suite reads only the redacted fixture at L0; L1/L2 upload the real PDF (that is the product path) but must never write a name into a committed artifact. Stage 4 adds a repo-wide redaction check over `evals/prod/**`.
- **`packages/engine/tests/eval/metrics.ts` is dead code**: it imports `./types.js`, which does not exist. Verified harmless — `packages/engine/tsconfig.json` includes only `src`, so it is never typechecked — but it must not be mistaken for a live metrics module (Stage 5 writes its own scoring under `evals/prod/scoring/`).
- **CI scope, verified:** `vitest.config.ts:14` includes `evals/tests/**/*.test.ts`, so the cohort smoke test and its frozen hash **do** run in CI today; retiring stale cohort content therefore touches a CI-enforced fixture.

#### 1.5.4 Headless baseline (U12) — system-computed reference run

A full offline probe ran the real pipeline on the redacted fixture at a pinned clock of 2026-09-16 (scripts + commands recorded in the unit report; reproducible with no API keys). **This is baseline data, not ground truth** — it is what the system produces today, kept for regression diffing.

- **Registry at runtime = 22 tools**, FOSE pair absent — matches the documented state.
- **Temporal context**: `currentTerm "Fall 2026"`, `nextTerm "Spring 2027"`, `enrolledNowTerm "Fall 2026"`; profile derives `homeSchool cas`, `catalogYear 2024-2025`, `declaredPrograms [{computer_science_math, major}]`, `genericTransferCredits 32`.
- **Baseline plan, domestic**: graduation `2027-spring`; that term holds `[placeholder: Texts & Ideas] 4cr`, `CSCI-UA 421 4cr`, and **two 4-credit free-elective placeholders** purely to reach the 16-credit target — only 8 of those credits are actual requirements, and the student already exceeds 128. State `valid-with-trade-offs`, `balanceScore 0.5`, `optimality "best-effort"`, `feasibility.feasible true`.
- **Baseline plan, F-1**: the same two requirement slots but only 8 credits in the final term, carrying the RCL notes; `f1Floor 12`, still `feasible: true` — i.e. the final-term reduced load is surfaced as a note, not a violation.
- **Latency**: every engine-side call is under 60 ms (`parseDpr` 5.1 ms, `run_full_audit` 2.3 ms, validator 3.6 ms, `plan_forward_degree` 58 ms cold / 15–17 ms warm). **End-to-end latency is dominated by LLM turns, not tools** — the suite's latency budgets should be set against model round-trips, and a slow turn points at the model or retrieval, never the solver.
- **Offline feasibility (harness-critical)**: `search_policy` **cannot** run headlessly — the cached corpus is 1536-dim OpenAI embeddings and the local hash embedder is 256-dim, so the bundle fails to load and `validateInput` rejects with "RAG corpus not loaded." Options are a lexical corpus cache regenerated with `LocalHashEmbedder` (a checked-in fixture) or recorded query embeddings; otherwise every policy case is necessarily network-bound. `search_courses` does run offline, but only through the **keyword fallback**, which is not the production semantic path (and which returned 0 matches for "texts and ideas") — so offline course-search results are not representative.
- The probe also confirmed, from real output, the audit never naming CSCI-UA 421 (KB-1), the per-program GPA printing 3.402 for all three programs against the DPR's 3.333 (KB-2), and produced KB-29 … KB-35 above.

#### 1.5.5 Bulletin ground truth (U09) and known gaps (U11)

- **U09 produced the strongest material in the set** — roughly 55 verbatim policy quotes with `file:line` citations across ten topic families (pass/fail; W and withdrawal; residency; per-term load; double counting; repeats; transfer/AP; online; standing, dismissal, leave and graduation; honors), plus the program map for the CS/Math joint major and the College Core. Its skeptic found zero transcription errors. Traps it caught, each of which would have produced a wrong expectation: the CAS **repeat rule does exist** in the bulletin, so an "I couldn't find it" answer is a retrieval failure rather than correct hedging; the withdrawal rule is stated in **weeks, not dates**; the bulletin states **no hard per-term ceiling** (over 18 credits needs adviser approval and clearance), so a flat "no, 18 is the cap" is wrong; the advanced-math elective block is 22 rows, not 20; and Latin-honors cutoffs are percentile-based and live off-corpus. It also refuted a seed asserting honor-society eligibility (3.402 is below the threshold).
- **U11 assembled the known-gap ledger** from plan 39, the 2026-09-15 audit, the frozen manifest and code TODOs, splitting accepted limitations (encode as expected hedges) from open bugs (encode as known-bug watch). Its skeptic corrected the most important one: when a persisted draft is restored, the observable is that **the committed valid plan is gone**, not that the draft is served as the live plan.


---

### 1.6 Decisions recorded 2026-09-30

| Decision | Value | Status |
|---|---|---|
| Product's primary model | `claude-sonnet-5-5`, adaptive thinking with `display: "summarized"`, `output_config.effort: "medium"` | **Decided by the owner** (no comparison run). Rationale: same vendor as today, so no new processor for student records; stronger than Sonnet 4.6 on the public agent benchmarks that include both; $2/$10 vs $3/$15 per M tokens (≈10–13% cheaper per same text after its ~30% larger tokenizer); supported until ≥2027-09-28; Sonnet 4.6's thinking-budget mode is already deprecated. Risks: two days old at decision time; not a one-line switch (Task 0.8). Revisit via the comparison stage if it underperforms. |
| Prompt caching | On: breakpoints on the last tool definition and the system prompt | Decided. Tool definitions are identical for every student (≈12k tokens), so that block is cacheable across all users. |
| Execution tiers | Deterministic / live-API / Claude-plan, per §4.6 | Decided |
| Checkpointing | File-based, per §4.6 | Decided |
| Determinism (§9 #10) | Production settings, report pass rates | Settled: Sonnet 5.5 rejects any temperature other than 1. |
| Owner facts (§9 #6) | F-1 student; graduation target Spring 2027; Fall 2026 registration = CORE-UA 700, MATH-UA 251, MATH-UA 343, MPAJZ-UE 71 (16 credits); unofficial transcript printed 07/29/2026 shows Spring 2026 grades, including **MATH-UA 334 = P**, and the Dean's List for the academic year | Received. Consequences below. |
| Fallback model | `claude-sonnet-4-6` during the transition (replacing gpt-4.1-mini, the weakest model surveyed) | **Decided by the owner.** A cross-vendor fallback is revisited after the comparison (GPT-6.1 Sol is the candidate). |
| Judge calibration | The owner hand-labels ~150 judged replies once, as atomic yes/no criteria (≈3–5 hours); the Opus 5.5 judge must agree with those labels at **κ ≥ 0.6** before its scores count. A different-vendor judge would not remove this step: labels check whether the judge is right, not only whether it is biased. | **Decided by the owner.** Replaces the inconsistent 0.7 / 0.8 thresholds. |
| Model comparison | 30 hard cases × 2 runs on **Sonnet 5.5, Gemini 3.8 Flash, GLM-5.3-Flash, GPT-6.1 Sol** (no Sonnet 4.6 baseline); ≈$17–22 API; scored on owner-verified yes/no checks rather than the Opus judge, to avoid same-vendor bias; the winner becomes the primary model, with Sonnet 5.5 the default until then. Task 0.9. | **Decided by the owner.** |
| Remaining §9 items | Recommendations accepted as listed in §9 | **Decided by the owner.** |

**Consequences of the owner facts for the answer key (Stage 1):**
- **MATH-UA 251 is running** (section 001 on the registration). The catalog marks it spring-only, but the record wins; R1142/70 stays satisfied by an in-progress course.
- **MATH-UA 334 was taken pass/fail.** CAS rule B and the DPR's own RG5076 text both bar pass/fail for the major, so the two-advanced-math requirement (R1142/60) very likely re-opens. Spring 2027 would then need a third course (CSCI-UA 421 + one Texts & Ideas + an advanced math course), which also brings the term to 12 credits and meets the F-1 floor without a reduced-load approval. Confidence: medium — how the audit re-slots MATH-UA 251 / 343 is not knowable from the transcript; confirm with a fresh DPR and the adviser.
- **The fourth Fall 2026 course (MPAJZ-UE 71, 4 credits)** takes outside-CAS credit to 18 of 16, matching the June what-if report's "Not Satisfied".
- **The April DPR fixture is now stale** (it shows MATH-UA 334 in progress and three Fall courses). Stage 1 adds a fresh DPR downloaded from Albert as a second fixture and keeps the April one for stale-record cases. The 334 situation itself becomes a Branch-B what-if case ("I took MATH-UA 334 pass/fail — what does that change?"), which the engine can compute via its pass/fail transform.

## 2. Ground-truth doctrine (binding for every case)

1. **Independence.** The expected answer for a case is derived from primary sources — the DPR text (page + rule id), the bulletin mirror (`file:line`), `data/schools/*.json` (with its `_provenance`), or the academic calendar — and each case carries that provenance. **Never** derive "truth" from the system's reply, tool summary, or plan JSON. The headless baseline (Stage 3.4) is stored separately, labeled `baseline`, and used only for regression diffs.
2. **Three truth classes.** `T1 deterministic` — a specific value or rule (GPA 3.402; "P/F may not be used for major, minor, or Core"). `T2 invariant` — properties any correct answer must satisfy where several answers are valid (every remaining requirement covered; no term over 18 credits; no course placed before its prereqs; F-1 floor; graduation ≤ target; IP courses untouched). `T3 judgment` — quality traits scored by rubric + LLM judge + human calibration (hedging appropriateness, risk/trade-off statements, elicitation, tone).
3. **Rails are part of correctness.** Each case states whether the confidence rail ("confidence + verify with your adviser") is `required`, `optional`, or `forbidden`. Hedging a deterministic DPR number (3.402) is a defect; asserting a bulletin-only estimate without a rail is a defect.
4. **Date-relative truth.** Cases tagged `dateRelative` carry a small pure function `(runDate) → expected` evaluated at run time (current term, next term, add/drop and withdrawal windows per campus, DPR staleness). The suite records the run date and the computed expectation in the report.
5. **Ambiguity is explicit.** Where a human adviser could legitimately answer two ways (e.g. "How many credits have I completed?": 138 per the DPR counter incl. IP, or 110 earned), the key lists every acceptable answer **with the disambiguation the reply must contain** (must say the 28 are in progress). An answer that gives one number with no disambiguation scores partial.
6. **Known limitations are expected behavior.** Where the system is documented not to know something (non-CAS prereq coverage, exact GPA after a hypothetical fail, absent calendar windows, live seat availability), the correct answer is the honest hedge/refusal — asserting a number there is a failure.
7. **The corpus is a snapshot, and that is what we test against.** The bulletin mirror was scraped **2026-04-21** (`academic-policies/_index.md:4`, `college-core-curriculum/_index.md:4`) and the policy embeddings were built **2026-06-04** (14,273 chunks, `text-embedding-3-small`, 1536-dim) — both ~3–5 months old at the run date, predating any Fall-2026 policy change. *(Orchestrator-verified.)* Policy ground truth is therefore derived from **the in-repo scrape**, and every citation row records the scrape date. Two consequences: a suite failure caused by NYU changing a rule since April is a **data-freshness** finding, not an agent failure; and re-scraping before a full run is an owner decision (§9 #8) because it would move the ground truth under the case set.

8. **Verification chain.** Every ground-truth row is produced by one agent/human and adversarially re-derived by a second (per `CLAUDE.md` §3). Rows that depend on Edoardo's real-world situation (visa status, intended graduation term, what he actually registered for after April) are marked `owner-confirm` and confirmed by him before the pilot.

---

## 3. Question-space taxonomy

Produced by the synthesizer over all twelve verified unit reports, then extended by the completeness critic. **56 categories, ~1,050–1,100 cases** at the estimates below. Full detail (subcategories, example questions phrased as a student would, per-category oracles) is in `Docs/audits/2026-09-17-production-test-capability-survey.md`.

### 3.1 The 40 synthesized categories (686 cases)

| # | Category | DPR-dependent | est. | Independent oracle |
|---|---|---|---|---|
| C01 | DPR identity, program & provenance | yes | 12 | DPR-by-hand (p |
| C02 | GPA & grade facts | yes | 22 | DPR-by-hand |
| C03 | Credit accounting | yes | 20 | DPR-by-hand + computed invariant |
| C04 | Requirement status & what remains | yes | 30 | DPR-by-hand |
| C05 | Residency requirements | mixed | 10 | DPR-by-hand (R1001/35 = 80/64; R1142/80 = 56/36, both include in-progress credits) + bulletin citation (AP:100 |
| C06 | DPR-carried budgets: P/F, outside-school, time limit | yes | 16 | DPR-by-hand — and note the DPR ITSELF carries the P/F policy text (R1680/10 description clauses A/B/C: 32-unit |
| C07 | Transcript & course-history queries | yes | 22 | DPR-by-hand + calendar-relative |
| C08 | Academic standing, pace & dismissal risk | yes | 12 | DPR-by-hand (3 |
| C09 | Adviser notations, waivers & exceptions | yes | 6 | DPR-by-hand (p |
| C10 | Bulletin: grading, P/F, withdrawal, repeats, incompletes | no | 26 | Bulletin citation (AP:386, :410, :412, :414 P/F; AP:516, :520, :390 W; AP:222 and :378 repeats — the repeat ru |
| C11 | Bulletin: course load, credit caps, transfer / AP / online | no | 18 | Bulletin citation |
| C12 | Bulletin: majors, minors, double-counting, declaration & internal transfer | mixed | 16 | Bulletin citation |
| C13 | Program & Core requirement pages (Tier-2 whole-page) | no | 16 | Bulletin citation |
| C14 | Honors, Dean's List & awards | mixed | 10 | Bulletin citation (HA:27 Dean's List 3 |
| C15 | Graduation mechanics, application & conferral | mixed | 8 | Bulletin citation |
| C16 | Visa status, F-1 full-time & OGS RCL | mixed | 12 | Bulletin citation (OGS-LR:38 twelve credits; OGS-RCL:9 and :13 RCL permission and the status consequence; OGS- |
| C17 | Cross-school & multi-campus scope | mixed | 12 | Bulletin citation + data-file (data/schools/* |
| C18 | Policy gaps, corpus boundaries & conflicting sources | no | 14 | Bulletin citation of ABSENCE + LLM-judge for the wording |
| C19 | Course catalog: existence, discovery & recommendations | mixed | 18 | Catalog/data-file (course_descriptions |
| C20 | Prerequisites & eligibility | yes | 14 | Bulletin citation of the prereq line (never the prereqs |
| C21 | Course offerings, terms & availability confidence | mixed | 12 | Bulletin 'Typically offered' line (the independent source) + data-file |
| C22 | Forward plan construction & graduation timing | yes | 18 | Computed invariant + DPR-by-hand + bulletin/offerings |
| C23 | Plan explanation, locks & critical path | yes | 10 | Behaviour-probe (provenance) + computed invariant |
| C24 | Plan edits, mutations & the confirm chokepoint | yes | 24 | Computed invariant + behaviour-probe |
| C25 | Preferences: scheduling, load style & soft objectives | mixed | 16 | Behaviour-probe + LLM-judge |
| C26 | Plan alternatives, comparison & selection | yes | 10 | Computed invariant + LLM-judge |
| C27 | Credit floors, part-time & visa-conditioned load | yes | 12 | Bulletin citation (AP:500 12/term minimal full-time; OGS RCL pages) + computed invariant |
| C28 | What-if A: program / major / school change | yes | 12 | Behaviour-probe + DPR-by-hand against the uploaded What-If report |
| C29 | What-if B: current-term withdraw / pass-fail / fail + registration windows | yes | 22 | Bulletin citation + calendar-relative (pinned clock) + DPR-by-hand |
| C30 | What-if C: course-level counterfactuals & why-not | yes | 14 | DPR-by-hand + computed invariant |
| C31 | Sections, meeting times & seat availability | yes | 30 | Behaviour-probe + data absence |
| C32 | Profile edits & DPR-derived read-only fields | yes | 14 | Behaviour-probe |
| C33 | DPR refresh, staleness & re-upload | yes | 10 | Behaviour-probe + DPR-by-hand |
| C34 | Session continuity, memory & no-DPR behaviour | mixed | 18 | Behaviour-probe |
| C35 | Conversation routing: ambiguity, multi-intent, follow-ups & elicitation | mixed | 22 | Behaviour-probe + LLM-judge |
| C36 | Safety & honesty: read-only posture, off-domain, injection, hedging, verbatim discipline | mixed | 34 | Behaviour-probe + LLM-judge |
| C37 | UI: auth & onboarding | mixed | 20 | Behaviour-probe |
| C38 | UI: chat transport, streaming & the plan canvas | yes | 26 | Behaviour-probe |
| C39 | UI: profile rail, session management & error surfaces | mixed | 18 | Behaviour-probe + calendar-relative |
| C40 | Known-defect watch cases (cross-category regression ledger) | mixed | 30 | Per-defect; each watch case carries the independent oracle of its home category |

### 3.2 The 16 categories the completeness critic added (~+370 cases)

| # | Category | est. | Why it was missing |
|---|---|---|---|
| C41 | LLM polish stream | 14 | /api/plan/explain-polish is a SECOND, UNVALIDATED Anthropic model (claude-haiku-4-5-20251001, apps/web/lib/llmPolishPrompt.ts:96; temperature 0.2, rou |
| C42 | Stage-2 section enrichment | 12 | /api/plan/stage2/route.ts:101-104 emits the literal string '[term] open sections exist (N conflict-free combinations).' and :93 emits 'no conflict-fre |
| C43 | The plan_action_bubble UI surface | 16 | a whole chat message kind with 4 states (clean|trade_offs|soft_refusal|hard_refusal, apps/web/lib/planActionBubbleHelpers.ts:64-68), bubbleHasButtons  |
| C44 | Degradation, model fallback, compaction & terminal loop states | 20 | the brief asked for model fallback and compaction; the synthesis mentions neither. 5 non-ok terminal kinds (agentLoop.ts:110-143: max_turns, aborted,  |
| C45 | Long-answer truncation | 8 | LIVE DEFECT CANDIDATE. Route comment: 'the streaming loop has no output-truncation recovery (unlike the block path), so a final answer that exceeds ma |
| C46 | Authorization, tenancy & the unauthenticated admin page | 18 | the synthesis has NO authorization family. apps/web/app/admin/observability/page.tsx:17-19 states in code: 'cohort A runs anonymous-mode (no auth). Th |
| C47 | All-NYU scope — the binding philosophy mandate is 1.5% of the suite | 60 | the binding philosophy mandate is 1.5% of the suite (n≈60) — LARGEST STRATEGIC GAP. CLAUDE.md/core_philosophy.md bind the agent to ALL NYU undergrad i |
| C48 | Cost & token budget — the missing FIFTH score axis | 0 | the missing FIFTH score axis (cross-cutting) — usage:{promptTokens,completionTokens} is produced by both clients (llmClient.ts:36; anthropicClient.ts: |
| C49 | Perceived latency — the suite measures the wrong clock | 0 | the suite measures the wrong clock (cross-cutting) — §5.2/H6 measures TTFB/first-token/done. The UI does NOT reveal answer text as tokens arrive: page |
| C50 | The `thinking` stream as a user-visible, unvalidated surface | 8 | `thinking` is a first-class SSE event (sseStream.ts:17) rendered to the student (page.tsx:186-193,295-304) and NOT passed through validateResponse (th |
| C51 | Pool-slot & free-elective binding — 2 of 22 tools with no category | 14 | 2 of 22 tools with no category (n≈14) — bind_pool_slot and bind_free_elective are registered (registry.ts:93-94) and are the entire Plan-37 slot-edito |
| C52 | Preference FRAMING and the 4-tier fallback, Decision #42 | 16 | C25 covers preference honesty and stops. systemPrompt.ts:188-236 is an un-numbered enforcement block nobody tests: hard-vs-soft classification; 'Hard  |
| C53 | Optional-term semantics, summer/J-term | 8 | verbatim prompt rule with no category (systemPrompt.ts:126-143): an optional term satisfying no remaining requirement is VALID and additive, must be r |
| C54 | Per-axis infeasibility induction, all 8 validator axes | 16 | axes at graduationPathValidator.ts:51-59 (requirementGroupsSatisfied, poolSlotsResolvable, totalCreditsMeetMinimum, thresholdsMet, visaAxesPass, assum |
| C55 | Accessibility, responsive layout & the mobile gap | 14 | the 'UI behaviour' score axis never mentions accessibility, yet the product makes a11y PROMISES nothing verifies: ARIA tabs (workspace/ScheduleWorkspa |
| C56 | Store-mode & environment matrix | 10 | two persistence modes ship (Postgres apps/web/lib/db/*StorePostgres.ts vs in-memory when DATABASE_URL is absent). Rate limiting is an in-process Map t |

### 3.3 Where ground truth is hard, and what replaces it

Four families cannot be scored by a stated fact, and each gets a named substitute rather than an LLM opinion:

1. **Planner output (C22–C27, C30).** Several valid plans exist, so correctness is scored by the Stage-3 invariant checker over the emitted plan JSON — never by echoing the engine's own `state` or `feasible` flag, which KB-21/KB-33 show can be wrong. The independently derived facts for this student are narrow enough to pin the space: the only remaining work is CSCI-UA 421 (spring-only) plus one CORE-UA 4xx, and the credit floor is already met.
2. **Preferences (C25, C52).** Most preferences are recorded, not enforced. The oracle is a behavioural probe — plan JSON before vs after — plus a judge scoring whether the reply told the truth about *when* the preference applies.
3. **Adviser quality (C23, C36).** Judged, with the rubric anchored to concrete artifacts: the slot's recorded rationale must be quoted rather than invented, and the confidence rail must appear exactly where §2 rule 3 requires it.
4. **Retrieval quality (C10–C18).** Scored against the ~55 verbatim bulletin quotes captured in Stage 2, not against a band the reranker produced.

### 3.4 Coverage guarantees the taxonomy must keep

Every one of the 22 registered tools, all 16 CORE RULES, all 8 response-validator checks, all 8 validator axes, every `apps/web/app/api` route, and every chat UI surface maps to at least one category. The critic verified this and found four holes, now closed as C41–C43, C46 and C51: `/api/plan/explain-polish`, `/api/plan/stage2`, the `plan_action_bubble` message kind, the unauthenticated `/admin/observability` page, and the two slot-binding tools.

## 4. Harness architecture

### 4.1 Three levels, one bank

| Level | Driver | What it proves | Speed / cost | Reuse |
|---|---|---|---|---|
| **L0 engine** | In-process `runAgentTurn` / `runAgentTurnStreaming` with the production LLM client + `buildDefaultRegistry()` + a `ToolSession` built exactly as the chat route builds it (DPR loaded, courses/prereqs/offerings/schoolConfig, RAG + course search wired, `validateResponse` with `userQuestion` + `forwardSchedule`, replay limit 1) | Tool routing, tool outputs, validator verdicts, reply text — without the web layer | ~5–20 s/turn; cheapest | `evals/cohort/runner.ts` shape, `RecordingLLMClient` for replay. **Needs `OPENAI_API_KEY`** for the policy corpus (1536-dim) unless a lexical cache fixture is built — see §1.5.4 |
| **L1 route** | HTTP client against `next start`: login (`/api/auth/otp/issue` → `debugCode` → `/api/auth/otp/verify`), `/api/onboard` (DPR PDF upload), `/api/chat/v2` (SSE), `/api/plan/*`, `/api/plan/whatif`, `/api/whatif-audit`, `/api/session/{restore,clear,delete}`, `/api/onboard/refresh-dpr` | Everything L0 proves **plus** the route-level clarifier/elicitation/validator-replay/persistence/hydration behavior, SSE event contract, HTTP status contracts (422 never-commit-invalid, 429 rate limit) | +1–3 s/turn | none — new |
| **L2 browser** | Playwright against `next start`: real DOM — wizard, chat input, slot popover, review card, Confirm rail, what-if upload card, compare view, profile rail | UI renders the engine's state and performs the operations; visual regressions via screenshots | slowest | none — new |

Every case declares the levels it runs at (`levels: ["L0","L1"]`, UI cases `["L2"]`). L1 is the level reported as "production". L0 is the fast inner loop while authoring cases; L2 is run for the UI category plus a sample of chat cases (render parity).

### 4.2 Identities, limits, cleanup

- One **test identity per run per variant** (`domestic`, `f1`), e-mails allow-listed in `AUTH_TEST_EMAILS`; login via `debugCode` (one OTP issue per identity per run; per-IP OTP limit 5/day is never approached).
- Chat limit: set `NYUPATH_CHAT_DAILY_LIMIT` (Stage 0.3) for the harness process; production default stays 30. The plan-action routes have a separate in-process **60/day** cap (`planActionRouteHelpers.ts:38-83`) — Stage 0.3 gives it the same env-override treatment (`NYUPATH_PLAN_ACTION_DAILY_LIMIT`).
- Login: `debugCode` requires the OTP row to be written; U06 left open whether that needs Postgres even in in-memory mode — Stage 5 settles it (if yes, L1/L2 always run against Neon; L0 never needs login).
- After each run: `POST /api/session/delete` for every identity (always-on route), so no test data lingers in Neon.
- **Data freeze:** the harness refuses to start if `git status --porcelain packages/engine/src/data data/schools` is non-empty (guards against B2-style drift), and records the data files' SHA-256 in the run manifest.

### 4.3 Observables the harness asserts on

- **SSE** (`/api/chat/v2`, wire format `event: <kind>` + `data: <JSON incl. kind>`; union in `apps/web/lib/sseStream.ts:13-53`): `tool_invocation_start {toolName,args}` · `tool_invocation_done {toolName,summary?,error?}` (**no `callMs` on the wire** — per-tool timing comes from `GET /api/session/restore` → `chatMessages[].toolInvocations[].callMs`) · `thinking {text}` · `token {text}` (clarifier path = 40-char chunks, no tools) · `forward_schedule_update {schedule}` (may carry `state: infeasible-draft`) · `forward_materialization_update {result}` · `whatif_audit_request {hypotheticalProgram}` (≤1/turn) · `plan_proposal {pendingMutationId, feasible, consequences[], proposedSchedule?, planDiff?}` (≤1/turn, authenticated only) · `validator_block {violations[{kind,detail,caveatId?,number?}]}` · terminal `done {finalText, modelUsedId}` (suffix `:context_limit` on context exhaustion) **or** `error {message}`. Canonical ok-turn order: `[tool_invocation_start, tool_invocation_done, thinking, token]*` → `forward_schedule_update?` → `forward_materialization_update?` → `whatif_audit_request?` → `plan_proposal?` → `validator_block?` → `done`. Harness assertions: exactly one terminal event; no `plan_proposal`/`whatif_audit_request`/`validator_block` after `done`; `done.finalText` equals the token concatenation only when no elicitation append / validator scrub / clarifier occurred (otherwise `finalText` is authoritative); `modelUsedId` starts with the primary model id unless a fallback fired; the elicitation lead-in `To give you better guidance —` appears at most once per turn and never on consecutive turns.
- **HTTP**: status codes on plan routes (200 / 422 infeasible / 429 rate-limit / 4xx bad upload), `pending_mutation` idempotency (double-confirm resolves once).
- **Plan JSON** (`session.forwardSchedule` via `/api/session/restore` or L0): the invariant checker of Stage 3 runs on every plan the system emits.
- **DOM** (L2): review card state (✓/⚠/✗), Confirm button presence/absence, badges (hypothetical / proposed / committed), canvas term contents, profile rail values; screenshots per step.
- **Latency**: `t_first_token`, `t_done`, per-tool `callMs`, `validator_replays`, `fallback_used`; p50/p90/max per category and per level.

### 4.4 Determinism and repetition

The product runs Sonnet with extended thinking at temperature 1 on the streaming path, so replies vary. Each case declares `repetitions` (default 1 for T1 cases at L0; 3 for T3-judged cases and for anything that failed once). The report shows pass rate per case, not a single boolean. A case is **flaky** if its pass rate is strictly between 0 and 1 across ≥3 reps; flaky cases are triaged before being counted.

### 4.5 Run modes

`smoke` (~25 cases, every category, L0+L1, <15 min) · `full` (all cases, all levels) · `regression` (RecordingLLMClient replays of a frozen full run — no LLM cost — to catch engine/route regressions) · `judge-calibration` (human vs LLM-judge agreement on a fixed 40-case sample, Cohen's κ ≥ 0.7 gate, reusing `packages/engine/tests/eval/cohensKappa.ts`).

---

### 4.6 Execution tiers, Claude-plan usage, and file checkpoints (decided 2026-09-30)

| Tier | What runs there | Cases | Cost per full pass |
|---|---|---|---|
| **D — deterministic** | Tool outputs, planner plans, validator verdicts, route and SSE contracts, persistence, authorization, UI flows with a recorded or stubbed model reply, most of the known-defect ledger | ~489 | $0; runs in CI |
| **L — live product (API key)** | Cases whose subject is the model's own behavior: routing, wording, hedging, refusals, synthesis, multi-turn handling | ~431, plus ~60 simulated-student conversations | ≈$100 with Sonnet 5.5 + caching (±50% until adaptive-thinking output is measured); 3 repetitions only for release gates (≈$250–300) |
| **P — Claude plan (Max)** | Judging (Opus 5.5), simulated students (Sonnet 5.5 Claude Code agents talking to the local server over HTTP), triage and reports | all judged cases | ≈25–35% of the weekly allowance per full run, over 2–3 five-hour windows (low–medium confidence; measured in the pilot by a 20-case judge batch and the usage-card delta). A release gate roughly triples the judging share. |

The case split comes from a classifier plus a skeptic over all 56 categories (`Docs/audits/2026-09-17-production-test-capability-survey.md` provenance; run `wf_ae668a92-da8`).

**Policy boundary (verified 2026-09-30).** Tier P is ordinary Claude Code use and draws on the plan's limits. NYU Path's own model calls must stay on the API key: Anthropic's Claude Code legal-and-compliance page prohibits routing requests through Free, Pro or Max plan credentials, and using the `claude` binary as another application's model backend is not covered by any page. It would also not be a production test — `claude -p` executes MCP tools inside its own loop and exposes none of the product's thinking, effort or sampling controls.

**Checkpoints and resume.**
- Every unit of work writes its own result file: `evals/prod/runs/<runId>/<caseId>.product.json`, `.judge.json`, `.sim.json`. A runner skips any case whose file exists, so a run resumes from **any** session, including a scheduled one after a limit reset. (Workflow resume is same-session only and loses in-flight agents; that happened five times during the survey.)
- `evals/prod/runs/<runId>/manifest.json` pins model ids, effort, flags (caching, polish), bulletin snapshot date and the DPR fixture hash; a resumed run refuses to continue if the manifest no longer matches.
- Judge batches stay small (10–20 cases per agent) so a limit hit wastes little.
- Headless `claude -p` jobs stop at a usage limit instead of waiting; scripts detect "You've hit your … limit" and exit cleanly for a later resume. The `claude` CLI refuses to start inside a Claude Code session — run tier-P scripts from a terminal or a fresh session.
- Orchestrate tier P from a **fresh, short session**: this session's 750k-token context made every step expensive in allowance terms.

## 4b. Harness risks that must be settled before authoring (completeness critic)

Five of these invalidate the suite's results if ignored, so they are Stage-0/Stage-5 blockers rather than notes.

| # | Risk | Why it breaks the suite | Resolution |
|---|---|---|---|
| HR-1 | **Production runs at temperature 1.** Extended thinking is on by default on the streaming path and the client then forces `temperature: 1` (`anthropicClient.ts:74-75, :178`). | Any plan for "n runs at temperature 0" is unachievable on the surface we claim to test. | Deep-dive D2 decides the configuration: either accept variance and report pass *rates* (§4.4), or run with `NYUPATH_DISABLE_THINKING=1` and state plainly that the suite measures a non-default configuration. Not both. |
| HR-2 | **A second, unvalidated model rewrites plan explanations.** `/api/plan/explain-polish` runs Haiku over the deterministic `explainPlanDiff` template when the polish flag is on. | Plan-edit categories would score Haiku prose instead of the engine's text, silently, depending on an env flag. | Pin the flag per run mode and record it in the run manifest; author C41 cases for both states. |
| HR-3 | **Circularity has no enforcement.** All twelve skeptics flagged circular seeds; roughly a third of proposed seeds derived "truth" from the system's own output, data files, or validator. | The suite would confirm the system agrees with itself. | D8: the case schema requires a `groundTruthMethod` enum plus a source pointer, and a CI guard fails any case whose source resolves into `packages/engine` or `apps/web`. |
| HR-4 | **The judge is uncalibrated.** Best committed κ is 0.793; the largest round scored κ 0.139 with zero human labels on the live sheet. | Judge scores would be reported as evidence when they are not yet. | Judge scores stay **advisory** until κ ≥ 0.6 against the owner's ~150 labels (§1.6); deterministic checks alone gate pass/fail until then. |
| HR-5 | **Latency budgets would measure an invisible clock.** The UI does not reveal answer text as tokens arrive — reveal is gated on turn completion and then paced at ~220 chars/s (`page.tsx:296-315`). | Time-to-first-token describes something the student never sees; a 2,000-character reply adds roughly nine seconds after `done`. | Report both: transport metrics for diagnosis, and **time-to-first-visible-answer** and **time-to-fully-revealed** as the student-facing numbers. D6 specifies the instrumentation. |
| HR-6 | Rate limits and identity: 30 chat turns/day, 60 plan actions, 10 uploads, in-process and reset on restart, with "anonymous" bucketed globally. | A ~1,050-case suite cannot run under them. | Stage 0.3's env overrides plus per-run identities. |
| HR-7 | **No stable selectors** — 3 `data-testid` attributes in the whole chat UI. | The ~64 UI cases are unwritable. | Stage 0.4's hook PR must land before UI authoring (D7). |
| HR-8 | "A non-ok turn kind is a hard failure" contradicts the degradation family, which exists to *produce* `max_turns`, `model_error_no_fallback` and `context_limit`. | Degradation cases could never pass. | Scope the rule to content categories; degradation cases assert the terminal kind they expect. |
| HR-9 | **Unstated environment matrix**: two persistence modes, two retrieval legs, two thinking states, two polish states, live vs recorded sections, 11 schools. | Results would not be comparable between runs. | The run manifest pins every axis; `regression` mode fixes them all. |
| HR-10 | **The suite's cost is unbudgeted and unmeasurable.** Token `usage` and per-tool `callMs` are both produced and have zero consumers. | ~1,050 cases × repetitions × ~10 turns is a real bill nobody has estimated. | D6 adds cost as a fifth reported axis; §9 #9 asks for a budget before the first full run. |
| HR-11 | The FOSE `srcdb` term-format risk now has two dependents (`materialize_sections` and `/api/plan/stage2`). | Section categories could fail for a format reason rather than a behavioural one. | One live probe in D1 settles the format before authoring C31/C42. |

## 5. Case schema

Cases live under `evals/prod/cases/<category>/<id>.json` (one file per case; no giant arrays) and validate against `evals/prod/caseSchema.ts` (Zod). Shape:

```jsonc
{
  "id": "A-014-credits-completed",
  "category": "A",
  "title": "How many credits have I completed?",
  "levels": ["L0", "L1"],
  "dprDependent": true,
  "setup": {
    "dpr": "SAA_STD_DS",                 // fixture key → PDF for L1/L2, redacted text for L0
    "visaStatus": "domestic",           // or "f1"; the harness runs the declared variants
    "priorTurns": [],                    // multi-turn cases list earlier user/assistant turns
    "preferences": {}                    // schedule preferences pre-set through the normal confirm flow
  },
  "turns": [
    {
      "user": "How many credits have I completed?",
      "expect": {
        "toolsAnyOf": [["run_full_audit"]],
        "mustContainAll": ["138"],
        "mustContainAny": ["in progress", "in-progress", "IP"],
        "mustNotMatch": ["\\b1[0-9]{2}\\s+credits? remaining", "around 1[34]\\d"],
        "rail": "forbidden",              // T1 DPR number: no hedge
        "validator": "clean",             // no violations after replay
        "latencyBudgetMs": { "firstToken": 4000, "done": 25000 }
      }
    }
  ],
  "groundTruth": {
    "truthClass": "T1",
    "answer": "The DPR counts 138.00 units used toward the 128 minimum; 28 of those are in progress (Spring 2026: 16, Fall 2026: 12), so 110 are graded/earned as of the report date 04/27/2026.",
    "acceptable": ["138 with the in-progress caveat", "110 earned + 28 in progress"],
    "provenance": [
      "DPR p.2 R1001/10 'Units: 128.00 required, 138.00 used'",
      "DPR p.2–3 course rows typed IP (2026 Spr ×4, 2026 Fall ×3)"
    ],
    "ownerConfirm": false,
    "dateRelative": null
  },
  "judgeRubric": "Reply must give 138 and explain that 28 are in progress; must not say credits are 'remaining'.",
  "repetitions": 1,
  "tags": ["counter-semantics", "ip-nuance"]
}
```

Date-relative cases replace `dateRelative: null` with the name of a pure function exported from `evals/prod/dateTruth.ts`, e.g. `"fall2026AddDropWindow"`, which returns `{ expectedPhrases, forbiddenPhrases, railRequired }` for the run date using the same calendar constants the product uses **plus** the bulletin's own wording (so a wrong constant in the product is caught, not mirrored).

UI cases (`category: "O"`) add a `ui` block: `{ "steps": [{ "action": "click", "target": "slot:CSCI-UA 421", ...}], "expectDom": [...], "screenshot": true }`. Target vocabulary (U06 DOM-hook inventory; ARIA/text today, `data-testid` after Stage 0.4): landmarks `section[aria-label="Onboarding wizard"]`, `[role=list][aria-label="Wizard steps"]` (`aria-current="step"`), `[role=tablist][aria-label="Scenario tabs"]` → `[role=tab][aria-selected]` (first tab `📌 My Plan`), `[role=tabpanel]`, `[role=region][aria-label="Compare view"]`, `aside[aria-label="Your profile"]`, `section[aria-label="Scenarios"]`, `[aria-label="Student summary"]` + `[role=progressbar]`, `[role=note]` hedge blocks; buttons by accessible name `Sign out`, `Confirm — make this My Plan`, `Cancel`, `Ask why`, `Discard`, `⇄ Compare` (`aria-pressed`), `Close <label>`, `Open scenario: <label>`, `Compare scenario: <label>`, `Compare <label> with My Plan`, `Add a course to <term>` → input `Course to add to <term>` → `Add <course> to <term>` / `Cancel adding a course`, slot popover `[role=menu]` → `[role=menuitem]` `Drop | Withdraw | Pass/Fail` (+ `title` tooltip) + `Close`, `Upload Albert What-If audit for <program>`, `↻ Update DPR`, `Delete my account & data`, `⚠ Clear all data`, wizard `Build my plan` / Back / Skip / Next; wizard form ids `#wizard-home-school`, `#wizard-visa-status`, `#wizard-grad-term`, `#wizard-goals-visa`, `#wizard-workload`, `#wizard-summer`, `#wizard-jterm`, `#wizard-abroad`, `#wizard-honors`, `#wizard-free-text`; status `[role=status][aria-live=polite]` `Thinking` → `Reasoned for <dur>` / `Failed after <dur>`; existing testids `schedule-card-summary`, `whatif-upload-input`, `whatif-upload-spinner`; refusal bubbles `[data-kind="plan_action_bubble"][data-bubble-kind=soft_refusal|hard_refusal]`. Driver notes: the app uses native `window.alert/confirm` for Update DPR / Clear / Delete (handle `dialog` events); layout is desktop-only (viewport ≥ 1280 px); the validator chip text is `⚠ Could not fully ground this reply.`; the 429/400 server copy is **not** shown (generic "Something went wrong on our side…").

---

## 6. Scoring model

1. **Deterministic layer (pass/fail per turn):** tool routing (`toolsAnyOf`), required/forbidden substrings and regexes, numeric grounding (every number in the reply appears in a tool result or the ground truth), rail presence rule, validator verdict, HTTP/SSE contract, plan-invariant checker (T2), latency budget.
2. **Judge layer (0–5 per dimension, T3):** groundedness, completeness vs. ground truth, adviser quality (risk/trade-off, one focused follow-up, no over-hedging), clarity. The judge must be a **different model from the one under test** — the Phase-10 baseline runner graded the agent with its own model id, which is self-grading and its scores are not evidence. Reuse `packages/engine/tests/eval/judgePrompt.ts`'s claim-level rubric shape (generalizing its CAS/CS-specific rules) and `cohensKappa.ts`; no κ has ever been computed for the 4-axis rubric, so Stage 6 computes one before any judge score is trusted (κ ≥ 0.6 against the owner's labels, §1.6).
3. **Human layer:** Edoardo spot-checks every `ownerConfirm` case and a random 10% of judged cases per full run.
4. **Report:** `Docs/reports/<date>-prod-suite-<mode>.md` + JSON — per-category pass rates, judge means, latency percentiles, flaky list, regressions vs. the previous run, and a "system said X / truth is Y / provenance" table for every failure.

---

## 7. Stages

### Stage 0 — Prerequisites (implementation; each task = its own branch + PR per `CLAUDE.md` §4)

#### Task 0.1: Make `next build` pass — move non-route exports out of the what-if-audit route

**Files:**
- Create: `apps/web/lib/whatIfExploration.ts`
- Modify: `apps/web/app/api/whatif-audit/route.ts:30-41, 59-158`
- Modify: `apps/web/tests/whatIfAuditRoute.test.ts:23-27`
- Create: `apps/web/tests/routeExportHygiene.test.ts`
- Docs: `Docs/current-system/web/plan-action-routes.md` (the what-if-audit section), `Docs/index.json` (impl path for the what-if exploration helper)

- [ ] **Step 1: Write the failing hygiene test** (guards every route file, so this class of build break becomes a unit-test failure)

```ts
// apps/web/tests/routeExportHygiene.test.ts
// Next.js rejects any export from app/**/route.ts that is not an HTTP method
// or a route-segment config. `tsc --noEmit` does not check this; `next build`
// does. This test makes the rule executable in vitest.
import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP_API = join(__dirname, "..", "app", "api");
const ALLOWED = new Set([
    "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
    "runtime", "dynamic", "revalidate", "fetchCache", "preferredRegion",
    "maxDuration", "dynamicParams", "generateStaticParams",
]);

function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return routeFiles(p);
        return name === "route.ts" ? [p] : [];
    });
}

describe("route export hygiene (next build contract)", () => {
    for (const file of routeFiles(APP_API)) {
        it(`${relative(APP_API, file)} exports only HTTP handlers + segment config`, async () => {
            const mod = await import(file);
            const bad = Object.keys(mod).filter((k) => !ALLOWED.has(k));
            expect(bad).toEqual([]);
        });
    }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/tests/routeExportHygiene.test.ts`
Expected: FAIL for `whatif-audit/route.ts` with `expected [ 'deriveHypotheticalProgram', 'planWhatIfExploration' ] to deeply equal []` (interfaces are erased at runtime, so only the two functions show).

- [ ] **Step 3: Create the lib module by moving lines 59–158 of the route verbatim**

`apps/web/lib/whatIfExploration.ts` = the doc comment + `WhatIfAuditExploration`, `WhatIfAuditResponse`, `deriveHypotheticalProgram`, `planWhatIfExploration` exactly as they are in `route.ts` lines 59–158, preceded by the imports those symbols reference:

```ts
import {
    loadSchoolConfig,
    planForwardDegreeTool,
    type DegreeProgressReport,
    type ToolSession,
} from "@nyupath/engine";
import type { ForwardSchedule } from "@nyupath/shared";
import { buildStudentProfileFromDpr } from "./buildSession";
```

(If `tsc` reports an unused import after the move, delete that import line in the lib module; if it reports a missing symbol, it was used by the `POST` handler only — keep it in the route.)

- [ ] **Step 4: Rewrite the route's imports and delete the moved block**

Replace `route.ts` lines 30–41 with:

```ts
import { NextRequest, NextResponse } from "next/server";
import { extractText } from "unpdf";
import { parseDpr } from "@nyupath/engine";
import { consumeRequest } from "../../../lib/rateLimit";
import { planWhatIfExploration, type WhatIfAuditResponse } from "../../../lib/whatIfExploration";
```

Delete lines 59–158 (the doc comment, the two interfaces + both functions). Keep `runtime`, `WHATIF_AUDIT_LIMIT_PER_DAY`, `ipFromRequest`, and `POST` unchanged. Re-add any engine import `POST` still needs (run `cd apps/web && npx tsc --noEmit` and follow the errors — expected: none beyond the ones listed).

- [ ] **Step 5: Point the test at the lib module**

`apps/web/tests/whatIfAuditRoute.test.ts` lines 23–27 become:

```ts
import { POST } from "../app/api/whatif-audit/route";
import { planWhatIfExploration, deriveHypotheticalProgram } from "../lib/whatIfExploration";
```

`apps/web/app/chat/buildWhatIfScenarioFromAudit.ts:28-31` only *mentions* the route in a comment (it declares a structural copy of the type on purpose — client bundle); update the comment to name `apps/web/lib/whatIfExploration.ts`.

- [ ] **Step 6: Verify**

Run: `npx vitest run apps/web/tests/routeExportHygiene.test.ts apps/web/tests/whatIfAuditRoute.test.ts` → PASS.
Run: `cd packages/engine && npx tsc --noEmit && cd ../../apps/web && npx tsc --noEmit` → clean.
Run: `cd apps/web && env -u DATABASE_URL npx next build --webpack` → `✓ Compiled successfully`, type check passes, route table printed.
Run: `npx vitest run` (repo root) → no new failures (the pre-existing `builderParity` clock failure aside until Stage 0.6).

- [ ] **Step 7: Docs + commit**

Update `Docs/current-system/web/plan-action-routes.md` (what-if-audit section: helpers now live in `lib/whatIfExploration.ts`) and the matching `Docs/index.json` impl path; grep living docs for `deriveHypotheticalProgram` (`bash tools/check-living-docs.sh deriveHypotheticalProgram`).

```bash
git add apps/web/lib/whatIfExploration.ts apps/web/app/api/whatif-audit/route.ts apps/web/tests/whatIfAuditRoute.test.ts apps/web/tests/routeExportHygiene.test.ts apps/web/app/chat/buildWhatIfScenarioFromAudit.ts Docs/current-system/web/plan-action-routes.md Docs/index.json
git commit -m "fix(web): move what-if exploration helpers out of the route module so next build passes; add route-export hygiene test"
```

#### Task 0.2: Stop the test suite from mutating engine data / calling the LLM on import

**Files:**
- Modify: `tools/bulletin-parser/extractCoreqs.ts:18-26, 388, 422`
- Modify: `tools/bulletin-parser/extractPrereqs.ts` (the top-level `main()` call and its dotenv load) and `tools/bulletin-parser/validatePrereqs.ts` (same)
- Create: `tools/bulletin-parser/importSideEffects.test.ts`
- Docs: `Docs/current-system/surrounding/data-pipeline.md` (note the invoke-directly guard + "importing an extractor never runs it")

- [ ] **Step 1: Write the failing test** (run it in a checkout **without** `.env.local` — e.g. the plan-40 worktree — so the RED run cannot spend API calls)

```ts
// tools/bulletin-parser/importSideEffects.test.ts
// Importing an extractor module must be free of side effects: no data-file
// writes, no LLM client construction, no .env.local injection. The CLI entry
// points run only when invoked directly (`npx tsx tools/bulletin-parser/x.ts`).
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PREREQS = join(__dirname, "..", "..", "packages", "engine", "src", "data", "prereqs.json");
const sha = () => createHash("sha256").update(readFileSync(PREREQS)).digest("hex");

const MODULES = ["./extractCoreqs.js", "./extractPrereqs.js", "./validatePrereqs.js"];

describe("bulletin-parser modules are side-effect-free on import", () => {
    for (const m of MODULES) {
        it(`${m}: importing does not rewrite prereqs.json or override the environment`, async () => {
            const before = { sha: sha(), mtime: statSync(PREREQS).mtimeMs };
            process.env.NYUPATH_SENTINEL = "keep-me";
            await import(m);
            // Give any fire-and-forget promise from an unguarded main() a tick to land.
            await new Promise((r) => setTimeout(r, 250));
            expect(sha()).toBe(before.sha);
            expect(statSync(PREREQS).mtimeMs).toBe(before.mtime);
            expect(process.env.NYUPATH_SENTINEL).toBe("keep-me");
        });
    }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tools/bulletin-parser/importSideEffects.test.ts`
Expected: FAIL for `./extractCoreqs.js` (mtime changes; the console shows the per-course `Could not resolve authentication method` errors), and for `./extractPrereqs.js` / `./validatePrereqs.js` if their `main()` also writes.

- [ ] **Step 3: Guard the entry points** (pattern from `extractCourses.ts:292-295`)

In `extractCoreqs.ts`: add `pathToFileURL` to the `node:url` import (line 21 becomes `import { fileURLToPath, pathToFileURL } from "node:url";`); move the two env lines (25–26: `config({ path: ..., override: true }); delete process.env.ANTHROPIC_BASE_URL;`) to the first lines **inside** `main()`; change line 388 to `writeFileSync(PREREQS_JSON_PATH, JSON.stringify(merged, null, 2) + "\n");`; replace line 422 with:

```ts
// Never on import — extractCoreqs.test.ts imports COREQ_PATTERN from this module.
const invokedDirectly =
    !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch(console.error);
```

Apply the identical guard (and the trailing-newline write) to `extractPrereqs.ts` and `validatePrereqs.ts`.

- [ ] **Step 4: Verify**

Run: `npx vitest run tools/bulletin-parser/` → all PASS, and `git status --porcelain packages/engine/src/data` prints nothing.
Run: `npx tsx tools/bulletin-parser/extractCoreqs.ts --help 2>&1 | head -3` (or without args in the worktree with no key) → the CLI still starts when invoked directly.
Run: `npx vitest run` → suite green (modulo Stage 0.6), and the ~69 `Could not resolve authentication method` lines are gone from the output.

- [ ] **Step 5: Docs + commit**

```bash
git add tools/bulletin-parser/extractCoreqs.ts tools/bulletin-parser/extractPrereqs.ts tools/bulletin-parser/validatePrereqs.ts tools/bulletin-parser/importSideEffects.test.ts Docs/current-system/surrounding/data-pipeline.md
git commit -m "fix(tools): bulletin-parser CLIs run only when invoked directly — vitest no longer rewrites prereqs.json or calls the LLM on import"
```

#### Task 0.3: Env-overridable chat + plan-action rate limits (defaults unchanged)

**Files:**
- Modify: `apps/web/lib/rateLimit.ts:19` (add `resolveDailyLimit`)
- Modify: `apps/web/app/api/chat/v2/route.ts:206`
- Modify: `apps/web/lib/planActionRouteHelpers.ts:38, 63` (`PLAN_ACTION_LIMIT_PER_DAY` → resolved per request)
- Modify: `apps/web/tests/rateLimit.test.ts`, `apps/web/tests/planAddRoute.test.ts:24,107` (keeps using the exported test constant)
- Modify: `.env.example`, `Docs/current-system/web/rate-limit-and-middleware.md`, `Docs/current-system/web/plan-action-routes.md`

- [ ] **Step 1: Failing tests**

Append to `apps/web/tests/rateLimit.test.ts`:

```ts
import { resolveDailyLimit } from "../lib/rateLimit";

describe("resolveDailyLimit", () => {
    it("defaults to 30 when NYUPATH_CHAT_DAILY_LIMIT is unset", () => {
        expect(resolveDailyLimit({})).toBe(30);
    });
    it("honors a positive integer override", () => {
        expect(resolveDailyLimit({ NYUPATH_CHAT_DAILY_LIMIT: "500" })).toBe(500);
    });
    it("ignores non-positive or non-numeric values", () => {
        for (const v of ["0", "-5", "abc", "1.5", ""]) {
            expect(resolveDailyLimit({ NYUPATH_CHAT_DAILY_LIMIT: v })).toBe(30);
        }
    });
    it("resolves the plan-action limit from its own variable with default 60", () => {
        expect(resolveDailyLimit({}, "NYUPATH_PLAN_ACTION_DAILY_LIMIT", 60)).toBe(60);
        expect(resolveDailyLimit({ NYUPATH_PLAN_ACTION_DAILY_LIMIT: "1000" }, "NYUPATH_PLAN_ACTION_DAILY_LIMIT", 60)).toBe(1000);
        expect(resolveDailyLimit({ NYUPATH_PLAN_ACTION_DAILY_LIMIT: "x" }, "NYUPATH_PLAN_ACTION_DAILY_LIMIT", 60)).toBe(60);
    });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/web/tests/rateLimit.test.ts` → FAIL: `resolveDailyLimit is not a function`.

- [ ] **Step 3: Implement**

In `apps/web/lib/rateLimit.ts`, after line 19:

```ts
/** Harness/operator override for a per-student daily limit. The env
 *  value must be a positive integer; anything else (unset, "0", "abc",
 *  "1.5") keeps the production default. Chat uses
 *  `NYUPATH_CHAT_DAILY_LIMIT` (default 30); plan actions use
 *  `NYUPATH_PLAN_ACTION_DAILY_LIMIT` (default 60). */
export function resolveDailyLimit(
    env: NodeJS.ProcessEnv = process.env,
    varName: string = "NYUPATH_CHAT_DAILY_LIMIT",
    fallback: number = DEFAULT_LIMIT,
): number {
    const raw = env[varName];
    if (raw === undefined || !/^\d+$/.test(raw)) return fallback;
    const n = Number(raw);
    return n > 0 ? n : fallback;
}
```

In `apps/web/app/api/chat/v2/route.ts:206`: `const rateCheck = consumeRequest(userId, resolveDailyLimit());` and extend the import on line 66: `import { consumeRequest, resolveDailyLimit } from "../../../../lib/rateLimit";`.

In `apps/web/lib/planActionRouteHelpers.ts`: keep `const PLAN_ACTION_LIMIT_PER_DAY = 60;` (line 38) as the default and the exported `_PLAN_ACTION_LIMIT_PER_DAY_FOR_TESTS`; change line 63 to `const rate = consumeRequest(\`${RATE_BUCKET_PREFIX}:${studentId}\`, resolveDailyLimit(process.env, "NYUPATH_PLAN_ACTION_DAILY_LIMIT", PLAN_ACTION_LIMIT_PER_DAY));` and import `resolveDailyLimit` next to `consumeRequest`.

`.env.example` (Web app section):
```
NYUPATH_CHAT_DAILY_LIMIT=          # per-student chat messages per UTC day (default 30; raise only for the production test harness)
NYUPATH_PLAN_ACTION_DAILY_LIMIT=   # per-student plan-action requests per UTC day (default 60; same caveat)
```

- [ ] **Step 4: Verify** — `npx vitest run apps/web/tests/rateLimit.test.ts apps/web/tests/chatV2Route.test.ts apps/web/tests/planAddRoute.test.ts` → PASS (the plan-action 429 test at `planAddRoute.test.ts:107` still trips at the default 60); both `tsc --noEmit` → clean.

- [ ] **Step 5: Docs + commit** — update `rate-limit-and-middleware.md` (new env var, default unchanged);

```bash
git add apps/web/lib/rateLimit.ts apps/web/app/api/chat/v2/route.ts apps/web/lib/planActionRouteHelpers.ts apps/web/tests/rateLimit.test.ts .env.example Docs/current-system/web/rate-limit-and-middleware.md Docs/current-system/web/plan-action-routes.md
git commit -m "feat(web): env overrides for the chat (30/day) and plan-action (60/day) rate limits — defaults unchanged"
```

#### Task 0.4: Browser test tooling (Playwright) + production launch config

**Files:**
- Modify: `package.json` (root devDependencies: `@playwright/test`), `pnpm-lock.yaml`
- Create: `playwright.config.ts` (root), `evals/prod/ui/smoke.spec.ts`, `.claude/launch.json` entry `web-prod` (`npx next start` in `apps/web`, port 3000)
- Modify: `vitest.config.ts` (exclude `evals/prod/ui/**` so vitest never picks up `.spec.ts` files), `.gitignore` (`playwright-report/`, `test-results/`)
- Docs: root `README.md` (Running it → production mode + UI tests), `Docs/current-system/surrounding/data-pipeline.md` → new section "evaluation harness" (or the new doc created in Stage 5)

- [ ] **Step 1:** `pnpm add -D -w @playwright/test` then `npx playwright install chromium`.
- [ ] **Step 2:** `playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";
export default defineConfig({
    testDir: "evals/prod/ui",
    timeout: 120_000,
    use: { baseURL: process.env.NYUPATH_BASE_URL ?? "http://localhost:3000", trace: "retain-on-failure", screenshot: "only-on-failure" },
    reporter: [["list"], ["html", { open: "never" }]],
});
```

- [ ] **Step 3: Smoke spec (RED until the server runs; GREEN against `next start`)**

```ts
// evals/prod/ui/smoke.spec.ts
import { test, expect } from "@playwright/test";
test("landing + login page render", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/NYU Path/i);
    await page.goto("/login");
    await expect(page.getByRole("textbox")).toBeVisible();
});
```

- [ ] **Step 4 (testids):** add `data-testid` hooks (only three exist today) — `chat-composer`, `chat-send`, `chat-bubble-user`, `chat-bubble-assistant`, `tool-row-<toolName>`, `scenario-tab-<kind>`, `slot-<courseId>`, `slot-action-<action>`, `review-card`, `review-confirm`, `review-cancel`, `review-ask-why`, `whatif-upload-card`, `profile-rail-visa`, `validator-chip` — as pure attribute additions in `apps/web/app/chat/**` (no behavior change), each covered by the existing jsdom render tests asserting the testid is present. Exact component files come from the U06 catalog in the audit record.
- [ ] **Step 5:** build + start (`cd apps/web && npx next build --webpack && npx next start`), then `npx playwright test` → 1 passed. Commit:

```bash
git add package.json pnpm-lock.yaml playwright.config.ts evals/prod/ui/smoke.spec.ts vitest.config.ts .gitignore .claude/launch.json README.md
git commit -m "chore(evals): add Playwright + production launch config for the browser-level harness"
```

#### Task 0.5: Test identities + harness env (doc/config only)

- [ ] Add to `.env.example`: `NYUPATH_HARNESS_EMAILS=` (comma-separated allow-listed identities the harness may use; must also appear in `AUTH_TEST_EMAILS`), `NYUPATH_BASE_URL=`. Document in `Docs/current-system/web/auth-routes.md` how `debugCode` login works for allow-listed emails and that the harness deletes its identities after each run via `/api/session/delete`.
- [ ] Commit: `docs(web): document harness identities + debugCode login`.

#### Task 0.6: Wait for the clock-timebomb fix

`fix/builder-parity-clock-timebomb` (other session) must merge before the suite's CI gate is meaningful; no work here except rebasing this branch afterwards. If it has not merged by Stage 5, add a follow-up: the assertion at `builderParity.test.ts:190` should compare against the calendar-derived current term for a **fixed injected clock**, never the wall clock.

#### Task 0.7: Prompt caching on the Anthropic client (production + tests)

**Files:** Modify `packages/engine/src/agent/clients/anthropicClient.ts` (block path ~:115-134, streaming path ~:179-198), `packages/engine/src/agent/llmClient.ts` (usage type); Test `packages/engine/tests/agent/anthropicCaching.test.ts` (copy the SDK-stub pattern from `anthropicThinking.test.ts:4-68`); Docs `Docs/current-system/engine/llm-clients.md`.

- [ ] **Step 1: Failing test** — for both `complete()` and `streamComplete()`, assert the request body has `system` as an array whose last block is `{ type: "text", text: <prompt>, cache_control: { type: "ephemeral" } }`, and that only the last tool carries `cache_control: { type: "ephemeral" }`. Assert the returned usage exposes `cacheReadTokens` / `cacheWriteTokens` from `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens`.
- [ ] **Step 2: Implement** — `system: [{ type: "text", text: args.system, cache_control: { type: "ephemeral" } }]`; in the tools map add `...(i === arr.length - 1 ? { cache_control: { type: "ephemeral" } } : {})`; extend the usage type with the two optional fields. No other request field changes.
- [ ] **Step 3: Verify** — both `tsc --noEmit` + `npx vitest run`; then one live call per path with `ANTHROPIC_API_KEY` set, called twice within five minutes: the second response must report `cache_read_input_tokens > 0` (record the numbers in the PR).
- [ ] **Step 4: Commit** — `feat(engine): prompt caching on the Anthropic client (tools + system breakpoints)`.

#### Task 0.8: Switch the primary model to claude-sonnet-5-5 (contract verified 2026-09-30)

Not a one-line change: Sonnet 5.5 returns 400 on `thinking.type: "enabled"` with `budget_tokens`, on `thinking.type: "disabled"`, on any `temperature` other than 1 (incl. the 0 the loop sends today), and on forced `tool_choice` (never used here). Sources: platform.claude.com migration guide (Sonnet 4.6 breaking changes), extended-thinking and effort pages, `api/messages/create`.

**Files:** `anthropicClient.ts`, `clients/index.ts:65-68`, root `package.json` (`@anthropic-ai/sdk` ^0.91.1 → ≥0.129.0, which adds `claude-sonnet-5-5` and `between_tools`), `agentLoop.ts` (refusal handling), tests `anthropicThinking.test.ts` (its assertions at :81-83, :102 encode the old contract), `clients.test.ts`, new `anthropicSonnet55.test.ts`; living docs `CLAUDE.md` §Conventions, `README.md` Models, `.env.example`, `Docs/STATUS.md`, `Docs/current-system/engine/llm-clients.md` (run `bash tools/check-living-docs.sh 'claude-sonnet-4-6'` and `'gpt-4.1-mini'`).

- [ ] **Step 1: Failing tests** — a per-model profile: for `claude-sonnet-5-5` the streaming body has `thinking: { type: "adaptive", display: "summarized" }`, `output_config: { effort: "medium" }` (overridable by `NYUPATH_EFFORT`), and **no** `temperature`, `top_p` or `top_k`; the block path likewise sends no temperature; `NYUPATH_DISABLE_THINKING=1` sends `thinking: { type: "between_tools" }`. For `claude-sonnet-4-6` the existing budget behavior is unchanged (it remains the fallback). A streamed response with `stop_reason: "refusal"` throws a typed `ModelRefusalError`; the streaming path sets `finishReason` from `stop_reason`; the loop treats an empty final text as an error rather than a reply. Factory defaults: primary `anthropic` / `claude-sonnet-5-5`, fallback `anthropic` / `claude-sonnet-4-6` (pending §9 #4).
- [ ] **Step 2: Implement** — a small capability table (`BUDGET_THINKING_MODELS = new Set(["claude-sonnet-4-6", "claude-haiku-4-5-20251001"])`; everything else gets the adaptive profile); thread `stop_reason` into the streaming result; throw on refusal so the existing fallback path runs; keep `display: "summarized"` so the chat's thinking stream is not silently emptied (Sonnet 5.5's default is `"omitted"`).
- [ ] **Step 3: Verify** — both `tsc --noEmit` + `npx vitest run`; one live streaming turn on `claude-sonnet-5-5` through `runAgentTurnStreaming` with the fixture DPR (expect tool use + non-empty reply, record tokens and latency); one forced-fallback check.
- [ ] **Step 4:** run the model comparison of Task 0.9 once Tasks 0.7 and 0.8 are merged; Sonnet 5.5 stays the default unless another candidate wins.
- [ ] **Step 5: Commit** — `feat(engine): primary model claude-sonnet-5-5 (adaptive thinking, effort medium, refusal handling)`.

#### Task 0.9: The ~$20 model comparison (decided 2026-10-01)

**Goal:** pick the primary model on evidence from NYU Path's own hardest cases: Sonnet 5.5 vs Gemini 3.8 Flash vs GLM-5.3-Flash vs GPT-6.1 Sol, 30 cases × 2 runs, ≈$17–22.

- [ ] **Step 1: Clients.** Make `OpenAIEngineClient` accept a configurable base URL, API key variable and per-model reasoning setting, so OpenAI-compatible endpoints (Google's Gemini compatibility endpoint; Fireworks' US endpoint for GLM-5.3-Flash) can be called with native tool definitions. Add a Responses-API path for GPT-6.1 Sol, whose tools work only there. Before any spend, verify each vendor's tool calling with one 3-tool smoke call and record the request shape that works. Set reasoning effort explicitly — public scores collapse at low effort (Gemini 3.8 Flash 33.2 at low vs 45.8 at medium on τ³). Unit-test each client with a stubbed SDK, as in Task 0.8.
- [ ] **Step 2: Cases.** Pick 30 cases whose expected answer is already fixed by Stages 1–2 slices: multi-part policy synthesis (the double-counting rule that made Sonnet the default in June, repeat rule, P/F rules, overload), planning dialogue on the fixture (Spring 2027 with the F-1 floor), Branch-B what-ifs (including the MATH-UA 334 pass/fail case), refusals, and one stale-DPR case. Each case gets 3–5 atomic yes/no checks.
- [ ] **Step 3: Run** through the engine-level runner with file checkpoints (§4.6), two runs per model, prompt caching on where the vendor supports it; record tokens, cost and latency per turn.
- [ ] **Step 4: Score.** Deterministic checks first; the owner verifies the yes/no checks on all replies (30 × 4 × 2 ≈ 240 short reviews). Report pass rate, run-to-run agreement, cost per turn and latency per model.
- [ ] **Step 5: Decide** with the owner. A non-Anthropic winner triggers a data-handling review before production: Google's developer API may process data in any country (Vertex offers zero data retention); Fireworks stores nothing for open models; OpenAI keeps abuse logs up to 30 days and the Responses API stores data unless `store=false`. The test itself uses only the redacted fixture.

### Stage 1 — DEEP: the DPR ground-truth key (agents + owner confirm)

**Output:** `evals/prod/groundTruth/SAA_STD_DS.facts.json` (+ a readable `Docs/audits/2026-xx-xx-dpr-ground-truth-SAA_STD_DS.md`) — ≥ 100 rows: `id | fact | value | truthClass | provenance (page + RG/R id) | derivation | systemCanRead (parser field or "gap") | acceptable phrasings | ownerConfirm`.

**Tasks (dispatch per `CLAUDE.md` §3 — one agent per slice, then a skeptic per slice; agents pinned to the worktree path):**
1. Programs/terms/catalog year/transfer status/advisor notation (the internal-transfer story; FYSEM waiver).
2. Cumulative counters and their semantics (138 vs 110; residency 80/64; major residency 56/36; P/F 4/32 and the one-per-term rule; outside-CAS 14/16 → 2-credit headroom; time limit).
3. Every requirement group/leaf with status, counters, courses used, and *why* (e.g. Societies via ECON-UA 1; Expressive Culture via IP CORE-UA 700; QR via MATH-UA 120 shared with the major).
4. Every course row (term, grade, units, type EN/TE/IP, repeat code, topic) — 36 rows — and the C-grade major rule check (MATH-UA 325 C+ counts; CORE-UA 500 C is Core, not major).
5. The what-if report diff (prepared 06/05/2026): programs simulated, requirement tree for Economics + Policy concentration, every row difference vs. the main DPR, and the explanation of the outside-CAS "Not Satisfied" line.
6. Parser coverage: for every fact, which `DegreeProgressReport` field carries it (`parser.ts`/`schema.ts`), and the known gaps (DPR-2/3/4, footer-runs-into-GPA-line per plan 39 B1) → these become "expected hedge" or "known-bug watch" cases.
7. Skeptic pass per slice (re-derive from the PDF text, not from the investigator's table) + a final owner-confirm list for Edoardo (visa status; intended graduation term; whether Fall 2026 registration changed after 04/27; whether MATH-UA 251 is really running in Fall 2026).

**Acceptance:** zero rows sourced from system output; every row has a page/rule citation; skeptic-refuted rows removed or corrected; owner-confirm list answered.

### Stage 2 — DEEP: bulletin/policy ground truth (citation table)

**Output:** `evals/prod/groundTruth/policy.citations.json` + `Docs/audits/2026-xx-xx-policy-ground-truth.md`: `topic | school | rule (verbatim) | source file:line | url | confidence (corpus can cite / cannot) | related DPR fact | example questions`.

**Slices:** (1) CAS academic policies (P/F, W and deadlines by session, residency 64 + last 32, per-term 18 + overload approval, outside-CAS 16, online 24, double-count 2, transfer/AP 32/64, repeat, dean's list 3.65, honors, leave of absence, graduation application, C-grade major rule, time limit); (2) CAS Core Curriculum page (all areas; the concrete CORE-UA 400–499 list; exemptions/substitutions; P/F ban on Core); (3) CS/Math joint major page + CS BA + Math BA + CS minor + Math minor (required/elective lists, the math "advanced courses" list — the bulletin links to the math department site; if the list is not in the mirror, that is a **cannot-cite** topic and the expected behavior is a hedge + pointer); (4) cross-school: Stern, Tandon, Steinhardt, Tisch, Gallatin, LS, SPS, Nursing, Shanghai, Abu Dhabi — P/F, credit caps, F-1 floor, residency — from `data/schools/*.json` + their bulletin pages (all-NYU mandate; also the "I'm a Stern student" DPR-independent phrasing); (5) F-1/OGS (12-credit floor, RCL, final-term exception, summer) from `data/bulletin-raw/ogs/**`; (6) engine data checks for every course a question can name (offerings, prereqs, credits, catalogYearsActive, `irregular` flags) with a list of data-vs-bulletin disagreements; (7) skeptic pass: every citation re-opened; every "cannot cite" claim double-checked by a corpus grep (`policy_chunks.meta.json` sources + `rag/ragScopeFilter.ts` scoping).

**Web verification (per `CLAUDE.md` §5):** only for facts the mirror lacks and a decision depends on (e.g. the math advanced-course list); record the URL + date in the citation row.

### Stage 3 — DEEP: planning ground truth (valid-plan space, invariants, date windows)

**Output:** `evals/prod/groundTruth/planning.SAA_STD_DS.json` + `evals/prod/invariants/planInvariants.ts` (pure functions over `ForwardSchedule`) + the headless **baseline** `evals/prod/baseline/SAA_STD_DS.<date>.json` (labeled, never used as truth).

**Slices:** (1) enumerate the remaining-requirement set by hand (CSCI-UA 421; one CORE-UA 4xx) and the constraints (421 spring-only per data; Core any term; 128 already exceeded; F-1 12-credit floor vs. a 2-course final term — the final-term reduced-load exception must be cited from OGS; per-term ≤ 18; no re-taking; IP courses fixed); derive the **expected valid plan space** for domestic and F-1 (earliest graduation Spring 2027 if 421 runs; what changes if the student adds summer/J-term; what the plan must look like if the student wants 12+ credits in Spring 2027 — fillers must be genuinely optional electives and must not breach outside-CAS 16 or P/F rules); (2) write the invariant checker (T2) — requirement coverage, prereq order, offering terms, credit floor/ceiling per visa variant, graduation ≤ target, IP untouched, no duplicates, P/F cap — each as a pure function with unit tests on synthetic schedules; (3) date semantics as of run date: current/next/enrolled/pre-registered terms; each IP course's window (drop / withdraw / P-F / locked) per `academicCalendar.ts` **and** per the bulletin wording (Spring add/drop first two weeks; W through week 14) → `evals/prod/dateTruth.ts`; (4) preference effects table: which `PlanMutation` kinds and `SchedulePreferences` fields change the plan (pin/move/exclude/swap/addTerm/loadStyleOverride) vs. are recorded only (`setSchedulingPreference`, `addSoftObjective`, per plan 39 C1/C2) → expected honesty phrasing; (5) run the headless baseline (parse → audit → plan for both variants → propose/probe samples) with the exact scripts kept under `evals/prod/baseline/run.ts`, timings recorded; (6) skeptic pass: try to construct a plan the invariants accept but a human adviser would reject (and vice versa) — every counter-example becomes a case.

### Stage 3b — DEEP: the ten critic-mandated investigations

These run alongside Stages 1–3; five are blockers for authoring. Each produces a named artifact under `Docs/reports/` or `Docs/audits/`.

| # | Deep dive | Blocks | Output |
|---|---|---|---|
| D1 | The two undocumented plan-change routes (`/api/plan/explain-polish` — a second Anthropic model rewriting plan explanations; `/api/plan/stage2` — emits seat-availability sentences). Includes the one live probe that settles the FOSE `srcdb` term format. | C24/C25/C30/C31/C41/C42 | A route contract + risk note per route: flag/env gating, status matrix, SSE ordering, the verbatim strings shipped to students. |
| D2 | Determinism configuration: thinking, temperature, and what "production" means for the suite. Run 20 representative cases at n=5 in both configurations. | the whole scoring model | A decision memo + a variance baseline; fixes the configuration for v1. |
| D3 | Authorization, tenancy and PII sweep over every route and page (including the unauthenticated `/admin/observability`, cross-tenant 403, the 10-minute pending-mutation TTL, and `/api/plan/add`'s 422-before-auth ordering). | C46 | An authz matrix (route × {no cookie, wrong tenant, expired id, malformed id} → status) + a PII-in-logs finding list. |
| D4 | Degradation and observability: model fallback, compaction, tool-result truncation, the five non-ok terminal kinds, and the 14 fallback-event kinds (two of which are machine traces of philosophy mandates and make better oracles than judged prose). | C44 | A degradation test plan with an injected-failure harness. |
| D5 | All-NYU expansion: the 11 school configs and the Shanghai / Abu Dhabi corpora (240+ scraped files already in the repo). | C47 | A generated 11×6 school-config matrix, each cell cited to its school's bulletin line, plus a home-school rotation set. |
| D6 | Latency and cost instrumentation — measure what the student experiences and what the run costs. | HR-5, HR-10 | An instrumentation spec + the minimal code PR surfacing token usage, per-tool `callMs` and replay count; five defined metrics. |
| D7 | UI test hooks and accessibility — the prerequisite PR for UI authoring. | HR-7, C55 | A hooks inventory (assertion → selector → exists?) shipped as one code PR, plus an a11y audit. |
| D8 | The anti-circularity mechanism. | HR-3 | The case-file schema's required `groundTruthMethod` + source pointer, and a CI guard that fails any case sourced from engine or web code. |
| D9 | Validator-axis induction and slot binding — eight constructed infeasible scenarios, one per axis, plus the pass-by-default trap in the P/F axis. | C54, the never-ship-invalid promise | Eight scenarios with the expected named axis and student-facing explanation, plus a ~14-case binding set. |
| D10 | Long-answer truncation on the streaming path (no truncation recovery, while thinking reserves 4096 of 5120 max tokens). | C45 | A reproduction or refutation with a measured answer-length distribution and a truncation-detection invariant. |

### Stage 4 — Question bank authoring

- Finalize the taxonomy (§3) from the survey; set per-category targets; author cases in the §5 schema, each with provenance from Stages 1–3; every category gets **edge cases** (counter semantics, IP nuance, data-vs-reality, date boundaries, negations, multi-intent, ambiguous one-liners, adversarial injections, other-school phrasing, "register me for…" refusals, DPR-field change refusals → re-upload, no-DPR session behavior) and **known-limitation cases** (expected hedges).
- Authoring rule (from `evals/cohorts/cohort_a.ts`): every required phrase traces to a source; every forbidden pattern reflects a real failure mode. Reuse per the §1.5.3 verdicts: adopt the phase-10 edge/adversarial cases after re-verifying each expectation, re-derive the 8 cohort-A real-DPR cases from Stage 1, and retire the golden sets that pin removed tools. Retiring cohort content means re-freezing its hash — a deliberate, reviewed step, because `evals/tests/**` runs in CI.
- Add a redaction check over `evals/prod/**` (no real student name, N-number, or email in any committed case or report artifact).
- Adversarial review: a fan-out of skeptics tries to (a) find a case whose expectation the system could satisfy while being wrong, (b) find a case whose expectation forbids a correct answer, (c) find a missing category. Iterate until two consecutive rounds add nothing (loop-until-dry).

### Stage 5 — Harness implementation (own plan: `41-…-production-test-harness.md`)

Interface contracts fixed here so Stage 4 can author against them: `evals/prod/caseSchema.ts` (§5), `evals/prod/runners/{l0,l1,l2}.ts`, `evals/prod/scoring/{deterministic,judge,invariants}.ts`, `evals/prod/report.ts`, CLI `npx tsx evals/prod/run.ts --mode smoke|full|regression|judge-calibration --levels L0,L1 --variant domestic,f1 --cases <glob>`. Plan 41 follows the writing-plans format task-by-task (TDD, one file per responsibility), reusing `evals/cohort/composite.ts`, `packages/engine/tests/eval/judgePrompt.ts`, `cohensKappa.ts`, and `RecordingLLMClient`.

### Stage 6 — Pilot, calibration, baseline report

Smoke run (L0+L1) → fix harness defects → judge calibration (40 cases, human labels by Edoardo, κ ≥ 0.7) → first full run → `Docs/reports/<date>-prod-suite-full.md` → product defects filed as issues (never fixed inside the suite PR).

### Stage 7 — Scale to more DPRs

Per-DPR template: `evals/prod/groundTruth/<DPR>.facts.json` via the Stage-1 slices; category targets re-derived from the DPR's remaining-requirement shape; the invariant checker is DPR-agnostic; policy citations are per school (Stage 2 slice 4 extends as schools appear). The first non-CAS real DPR also unblocks plan 39's A2/A3 validation.

---

## 8. Doc discipline + deliverables

- This plan: `Docs/plans/40-2026-09-16-production-test-suite.md` (point-in-time once merged).
- Investigation record: `Docs/audits/2026-09-17-production-test-capability-survey.md` (written this session; point-in-time record, never retro-edited).
- Each Stage-0 task: its own PR with code + tests + the living-doc updates named in the task; `Docs/STATUS.md` + the `CLAUDE.md` §Current status line gain a "Plan 40 — production test suite: Stage N" entry in the first Stage-0 PR.
- New living doc when Stage 5 lands: `Docs/current-system/surrounding/evaluation-harness.md` (+ `Docs/index.json` rows for `evals/prod/**`).
- `Docs/reports/` receives every pilot/full run report.

## 9. Open decisions for Edoardo (status as of 2026-10-01)

**All decided** — see §1.6 for the full table. Summary: primary model Sonnet 5.5 until the Task 0.9 comparison (Sonnet 5.5 · Gemini 3.8 Flash · GLM-5.3-Flash · GPT-6.1 Sol) picks a winner; fallback Sonnet 4.6; prompt caching; execution tiers and file checkpoints; the owner hand-labels ~150 replies once (κ ≥ 0.6); real Neon with throwaway accounts; F-1 as the primary variant; latency measured as time to first visible answer; three repetitions only for release gates; frozen-seam defects (KB-21/22/33) and the prerequisite-coverage fixes (KB-36/37, incl. plan 39 A2's trigger) each get their own plan; the April bulletin snapshot is kept for v1; ~60 cross-school cases are added now; a fresh DPR becomes the second fixture.

**Still optional:** independent academic advisers checking part of the answer key.

## Appendix A — Investigation provenance

26 agents: 12 subsystem investigators, 12 adversarial skeptics (one per unit), one synthesizer, one completeness critic. Run `wf_cf8d0181-786`, worktree `plan/40-production-test-suite` @ `4e541e4`, 2026-09-16/17.

| Unit | Scope | Skeptic verdict |
|---|---|---|
| U01 | Tools A — audit, standing, credit caps, what-if audit | partially reliable |
| U02 | Tools B — forward planning core | partially reliable |
| U03 | Tools C — counterfactual, what-if assumption, slot binding | partially reliable |
| U04 | Tools D — policy/program/course lookup, profile, sections | partially reliable |
| U05 | Behavioral rules — prompt, validator, clarifier, elicitation, loop | partially reliable |
| U06 | Web app — UI operations, routes, SSE contract, production run | partially reliable |
| U07 | Planner + validator semantics, preferences, temporal windows | partially reliable |
| U08 | DPR ground truth — the fixture and the Albert what-if report | partially reliable |
| U09 | Bulletin / catalog ground-truth source map | partially reliable (strongest material in the set) |
| U10 | Existing eval assets — reuse inventory | partially reliable |
| U11 | Known gaps, deferred items, expected limitations | partially reliable |
| U12 | Headless engine baseline on the fixture | partially reliable (system-computed data, never truth) |

**Every unit came back partially reliable.** Across the twelve, the skeptics refuted 40+ investigator claims, corrected 88+, added 120+ missed items, and flagged roughly a third of all proposed seeds as circular. That is the central methodological result: **no expected answer enters a test case without being re-derived from the DPR text, the bulletin text, or a hand computation** — never from the system's own output, data files, or tests. The consolidated record, with per-unit detail and the full taxonomy, is `Docs/audits/2026-09-17-production-test-capability-survey.md`.
