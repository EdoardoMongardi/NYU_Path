# Phase 8 Plan — Architectural Cleanup + Five-Model Bake-off

**Status:** Plan only. Not started.
**Date authored:** 2026-04-28
**Predecessor:** Phase 7-E shipped + W12 auth landed + 5 P0 + 5 P1 follow-ups. The 20-question quality sweep against the operator's real DPR returned 65% A/B-grade, 35% C/D/F-grade. This phase closes the gap.

---

## 1. Why this exists

The 20-question sweep ([prior session notes]) surfaced 7 categorized bugs:

| # | Bug | Root cause class |
|---|---|---|
| B1 | `run_full_audit` summary omits in-progress courses | Tool-output completeness |
| B2 | "Elective I haven't taken" routed to `plan_semester` instead of `search_courses` | Routing / negation queries |
| B3 | Pre-loop template dispatcher hijacks DPR-grounded questions | Architectural — pre-loop gate prevents agent reasoning |
| B4 | Template misroute on shallow keyword overlap (e.g. "double-counting" matched for cross-school) | Architectural — keyword router can't pattern-match like an LLM |
| B5 | `notSatisfiedRequirements` walker double-counts when parent + leaf both `not_satisfied` | Data-shape dedup |
| B6 | No template for "P/F per semester" → agent claims no per-term limit exists | Architectural — infinite-template-author problem |
| B7 | `search_courses` doesn't find CSCI-UA 421 (a real course) | Catalog data gap |

Triage:
- **B3 / B4 / B6 are architectural.** They stem from `preLoopDispatch` ([packages/engine/src/agent/templateMatcher.ts](packages/engine/src/agent/templateMatcher.ts)) running BEFORE the agent loop and short-circuiting the model. The Claude-Code source review (recovered-src/src/) confirmed this pattern is exactly what Claude Code avoids.
- **B1 / B5 are tool/data shape.** No agent-design change fixes these — the structured output the LLM consumes is missing the field.
- **B2 / B7 are tool capability + data.** Need a small new tool flag + a catalog ingest re-run.

Phase 8 splits into two parallel workstreams:
- **Workstream A (Architecture cleanup, 5 stages, ~6-8 hours):** Demote dispatcher; fix tool outputs; add `excludeCompleted` flag; trim system prompt; audit catalog.
- **Workstream B (Five-model bake-off, ~2 hours):** Compare gpt-4.1-mini / gpt-4.1 / gpt-5 / claude-sonnet-4-6 / claude-haiku-4-5 on the same question set after Stage 1 lands. Pick the production primary.

Both workstreams converge into one final go/no-go on cohort-A live launch.

---

## 2. Goals + non-goals

### Goals
- Push the 20-question sweep score from 65% A/B → ≥85% A/B
- Eliminate the long-tail authoring problem (no new templates needed for new question variants)
- Pick the right primary model for cohort A (cost ≤ $200 for the full 4-week pilot)
- Preserve every safety property already in place (Cardinal Rule §2.1, verbatim disclaimer enforcement, fallback chain, validator-replay)
- Re-grade against the same 20 questions + 5 new edge cases for direct before/after comparison

### Non-goals
- No new policy templates authored (Phase 8 is about removing the template-as-router pattern, not adding more)
- No subagents / Task delegation (NYU Path is single-thread per student)
- No MCP / external integrations
- No streaming-UI rewrites
- No Postgres performance optimization (cohort A volume is trivial)
- No new validator rules (the four we have suffice; we may *tighten* one)

---

## 3. Workstream A — Architecture cleanup

### Stage A1: Demote the template dispatcher (highest leverage)

**Effort:** 3-4 hours
**Closes:** B3, B4, B6 + improves long-tail variety
**Risk level:** Medium — touches the canonical request flow

**What ships:**

1. Delete the call to `preLoopDispatch` from [apps/web/app/api/chat/v2/route.ts:368](apps/web/app/api/chat/v2/route.ts) (the early-return branch). Templates are no longer a router.
2. Modify [packages/engine/src/agent/tools/searchPolicy.ts](packages/engine/src/agent/tools/searchPolicy.ts) to include relevant `PolicyTemplate` candidates **alongside** RAG chunks in its result set. Templates keep their `lastVerified` + `source` metadata. The agent reads both and decides what to quote.
3. Trim [packages/engine/src/agent/systemPrompt.ts](packages/engine/src/agent/systemPrompt.ts) Appendix-A 25 rules to ~5-7 core rules:
   - Cardinal Rule §2.1 (every number from a tool result)
   - DPR-loaded routing block (when DPR is present, prefer `run_full_audit`)
   - Verbatim policy quotes (when answering policy questions, quote bulletin verbatim where possible)
   - For hypotheticals, call `what_if_audit` and surface the canonical disclaimer
   - "I/my/me" heuristic: if the user references themselves, the reply MUST cite DPR data, not just bulletin policy
4. Move tool-specific routing guidance from the system prompt into each tool's `description` field (Claude-Code pattern). The model reads tool schemas + descriptions during function-calling and routes from there.
5. Keep `runTemplateMatcherOnly` as the **recovery-mode** fallback for the `cohortConfig.evalGateFailing` path (template-only mode for cohort users on a degraded gate). Recovery mode still uses templates as a hard router because in that mode we deliberately want zero LLM behavior.

**Acceptance:**
- [ ] All existing tests pass (754 / 766)
- [ ] 5-persona smoke ([tools/cohort-eval/runSmokeW10.ts](tools/cohort-eval/runSmokeW10.ts)) still PASS at P0=0
- [ ] Re-run 20-question sweep on `gpt-4.1-mini` (same model as today) — Q4, Q6, Q19 should now consult the DPR / answer the right question. Compare grades against today's baseline. Goal: at least these 3 questions move ≥1 grade level.
- [ ] No template responses appear with stale `lastVerified` dates (>180 days). Add a CI check that scans `data/policy-corpus/templates.json` for staleness.

**Rollback:**
- Single-commit revert restores the dispatcher
- `templateMatcher.ts` stays in tree (kept for recovery mode); no hard delete

**Open question to decide before starting:**
- Should the trimmed system prompt also drop the explicit `dprLoaded` mandatory routing rules (lines 111-143 of systemPrompt.ts)? **My recommendation: KEEP them.** Those rules are the load-bearing fix for the "agent calls get_academic_standing instead of run_full_audit" bug class. They're routing rules that prevent a known wrong path, not author-specific keyword matchers.

---

### Stage A2: Fix `run_full_audit` output completeness

**Effort:** 30-45 min
**Closes:** B1 + materially improves Q14 (early-graduation analysis)
**Risk level:** Low — additive only

**What ships:**

1. Edit [packages/engine/src/agent/tools/runFullAudit.ts](packages/engine/src/agent/tools/runFullAudit.ts):
   - Add to output type:
     ```ts
     dprInProgressCourses?: Array<{
         term: string;
         courseId: string;        // "CSCI-UA 473"
         courseTitle: string;
         units: number;
     }>;
     ```
   - In the DPR-primary path (lines 109-130), populate via `dpr.courseHistory.filter(c => c.type === "IP")`
   - In `summarizeResult`, render a "CURRENTLY ENROLLED" section grouped by term

2. Add a new system-prompt nudge (in the trimmed prompt from A1): "When the student asks 'what am I taking now / this semester / am I enrolled in X', surface `dprInProgressCourses` from the audit output."

**Acceptance:**
- [ ] Q8 ("Am I currently enrolled in any classes?") returns a list (CSCI-UA 4, CSCI-UA 473, MATH-UA 334, MPAJZ-UE 71, CORE-UA 700, MATH-UA 251, MATH-UA 343)
- [ ] Q10 ("What math classes am I currently registered for?") returns MATH-UA 334 (Spring 2026), MATH-UA 251 + MATH-UA 343 (Fall 2026)
- [ ] Q14 ("Could I graduate one semester early?") explicitly references the user's current Fall 2026 enrollment in its reasoning
- [ ] No regression in cohort-A frozen eval set (re-run [tools/cohort-eval/runSurrogateW8.ts](tools/cohort-eval/runSurrogateW8.ts) — composite ≥0.90)

---

### Stage A3: Dedup the requirement walker

**Effort:** 15-20 min
**Closes:** B5 + improves Q3, Q9, Q14
**Risk level:** Low

**What ships:**

1. Edit [packages/engine/src/dpr/schema.ts](packages/engine/src/dpr/schema.ts) `notSatisfiedRequirements`:
   - When iterating, drop a parent group if all its `not_satisfied` leaf children are already in the result set (or, simpler: drop any node where a descendant with the same root rId-prefix is also unmet)
   - Or, two-pass: collect leaves, then drop parents whose rId is a prefix of any included leaf
2. Add a unit test that constructs a DPR with R1004 (parent) + R1004/10 (leaf) both `not_satisfied` and asserts the result includes only R1004/10

**Acceptance:**
- [ ] Q3 lists 3 distinct unmet requirements, not 4
- [ ] Q9 plan no longer mentions "Texts & Ideas" twice
- [ ] Existing DPR tests still pass

---

### Stage A4: `search_courses` `excludeCompleted` flag

**Effort:** 1 hour
**Closes:** B2
**Risk level:** Low

**What ships:**

1. Edit [packages/engine/src/agent/tools/searchCourses.ts](packages/engine/src/agent/tools/searchCourses.ts):
   - Add `excludeCompleted: z.boolean().optional()` to input schema
   - When `excludeCompleted: true` AND `session.degreeProgressReport` is present:
     - Build a set of `courseId`s the student has completed (`type === "EN"` or `type === "TE"` from courseHistory + appliedCourses across requirements)
     - Filter `matches` to exclude any whose `courseId` is in the completed set
   - Render in `summarizeResult` with a "(filtered: N hidden because already completed)" note
2. Add tool-description guidance: "Use `excludeCompleted: true` when the student asks for electives / suggestions / 'haven't taken' queries."
3. Update the trimmed system prompt with a one-line nudge: "For 'electives / haven't taken / new courses' queries, call `search_courses` with `excludeCompleted: true`."

**Acceptance:**
- [ ] Q11 ("Suggest a CS elective I haven't taken yet") returns a real CSCI-UA elective (not CORE-UA 400)
- [ ] If the student has completed CSCI-UA 102 / 201 / 202 / 310, those don't appear in the result set
- [ ] No regression in existing search_courses tests

---

### Stage A5: Catalog data audit + reindex

**Effort:** 1-2 hours (data work, not code)
**Closes:** B7 + any other catalog gaps surfaced by the sweep
**Risk level:** Low

**What ships:**

1. Run a verification script against the local catalog:
   ```bash
   npx tsx -e "
   import { createSemanticCourseSearchFn } from '@nyupath/engine';
   // ... probe these expected courses:
   const must_exist = ['CSCI-UA 421', 'CSCI-UA 480', 'CSCI-UA 473', 'MATH-UA 343', 'CORE-UA 400', 'CORE-UA 500'];
   for (const c of must_exist) { /* search and assert */ }"
   ```
2. For any missing course, re-run the catalog ingestion ([data/course-catalog/](data/course-catalog/)) and re-embed
3. Add a CI smoke test: 10 known-good NYU course codes must be findable via `search_courses`

**Acceptance:**
- [ ] Q15 ("CSCI-UA 421 in summer") finds the course in the catalog
- [ ] All 10 known-good probe codes return ≥1 match

---

### Stage A6: Re-grade against the 20-question sweep

**Effort:** 30 min
**Risk level:** None (verification only)

After A1-A5 land, re-run the same 20-question sweep used today (with `gpt-4.1-mini` as the agent) and grade against the same rubric. Goal: ≥85% A/B-grade questions.

If the score is below 85%, identify which bug categories aren't fixed and decide: (a) add a small targeted fix, (b) accept the bug for cohort A and document, or (c) revert Stage A1 and re-think.

---

## 4. Workstream B — Five-model bake-off

### B1: Question set freeze

The bake-off uses **25 questions** = the original 20 from today's sweep + 5 new edge cases:

| # | Category | Question | What it tests |
|---|---|---|---|
| 1-20 | Same as today's sweep | (see PHASE_7E_PLAN.md / sweep transcript) | Direct before/after comparison |
| 21 | EDGE: off-domain | "What's the weather like in NYC today?" | Refusal politeness; should NOT call any academic tool |
| 22 | EDGE: multi-intent | "What's my GPA and can I add a Math minor?" | Two-tool sequence (run_full_audit + what_if_audit); both must surface |
| 23 | EDGE: typo | "whts the dropp dedline" | Correction + bulletin lookup |
| 24 | EDGE: follow-up | (after Q23) "and what about for an F-1 student?" | Context retention across turns |
| 25 | EDGE: refusal | "Can you change my major to Stern Finance for me?" | Should refuse (no write to Albert) without sounding curt |

The 25-question set lives at [evals/cohorts/bakeoff_25.ts](evals/cohorts/bakeoff_25.ts) (to be created in Stage B2).

### B2: Bake-off harness

**File:** `tools/cohort-eval/runBakeoffPhase8.ts`

A new runner that:
- Accepts a `--models` flag (comma-separated model ids)
- For each model: instantiates the right client (OpenAIEngineClient or AnthropicEngineClient with the right modelId)
- Runs all 25 questions sequentially through the **post-A1** v2 pipeline (real DPR, real RAG, real catalog, validator wired)
- Records per-question: tools invoked, validator events, full assistant text, latency, token counts (input + output if available)
- Writes one JSON per model: `tools/cohort-eval/results/bakeoff_phase8_<model>_<stamp>.json`
- Writes a comparison table at `tools/cohort-eval/results/bakeoff_phase8_summary.md`

Models to test:

| ID | Family | Approx in/out per 1M | Role expectation |
|---|---|---|---|
| `gpt-4.1-mini` | OpenAI | $0.15 / $0.60 | Baseline (current production) |
| `gpt-4.1` | OpenAI | $2 / $8 | Same family, ~10x stronger reasoning |
| `gpt-5` | OpenAI | $1.25 / $10 | Frontier routing/instruction-following |
| `claude-sonnet-4-6` | Anthropic | $3 / $15 | Best verbatim discipline + paraphrase resistance |
| `claude-haiku-4-5` | Anthropic | $1 / $5 | Anthropic fast tier; useful as fallback |

If `gpt-5` access is unavailable at run time, fall back to `gpt-4o` ($2.50 / $10) or proceed with 4 models.

### B3: Grading methodology

Two grades per question per model:

**Grade #1: Auto-checked correctness (deterministic)**
A small grader script ([tools/cohort-eval/gradeBakeoff.ts](tools/cohort-eval/gradeBakeoff.ts), to be created) checks each response against ground-truth assertions. Examples:

| Q | Auto-check |
|---|---|
| Q1 GPA | response contains "3.402" |
| Q2 Credits | response contains "138" AND "128" |
| Q4 P/F | response contains "4" AND "32" |
| Q7 Outside-CAS | response contains "14" AND "16" |
| Q8 Currently enrolled | response contains ≥3 of: "CSCI-UA 4", "CSCI-UA 473", "MATH-UA 334", "MPAJZ-UE 71", "CORE-UA 700", "MATH-UA 251", "MATH-UA 343" |
| Q10 Math classes | response contains "MATH-UA 334" AND ("MATH-UA 251" OR "MATH-UA 343") |
| Q11 CS elective | response contains a "CSCI-UA" code AND does NOT contain "CORE-UA" |
| Q12-Q15 What-ifs | response contains the canonical §6.4 disclaimer fragment "Verify with an academic adviser" |
| Q16 Withdrawal | response mentions "14th week" OR "third week" |
| Q17 F-1 | response contains "12 credits" OR "12-credit" |
| Q18 P/F per semester | response mentions "one" P/F election per term (NOT "no per-semester limit") |
| Q21 Off-domain | response does NOT call any tool AND mentions polite refusal/redirect |
| Q22 Multi-intent | tools_invoked includes BOTH `run_full_audit` AND `what_if_audit` |

Each auto-check returns pass / fail / partial.

**Grade #2: Qualitative LLM-judge**
A separate `claude-haiku-4-5` instance reads each (question, response, ground-truth-snippet) tuple and scores 1-5 on:
- **Correctness** (does it match the ground truth?)
- **Completeness** (does it answer everything the user asked?)
- **Quality** (is it well-organized, professional, helpful?)
- **Safety** (no fabricated numbers, appropriate caveats, no overconfidence on Tier-3)

Avg the four sub-scores → composite per-question grade.

The judge model (haiku) is intentionally NOT in the candidate set — different model family from the candidates so we don't get self-grading inflation.

### B4: Per-model cost budget

Estimated tokens per question: ~3k input (system prompt + DPR + history + user message) + ~500 output → 3.5k total. 25 questions × ~3 tool round-trips × 3.5k ≈ 260k tokens per model run.

Per-run cost estimate:

| Model | Cost |
|---|---|
| gpt-4.1-mini | ~$0.20 |
| gpt-4.1 | ~$2 |
| gpt-5 | ~$2 |
| claude-sonnet-4-6 | ~$3 |
| claude-haiku-4-5 | ~$1 |
| **Total bake-off** | **~$8** + LLM-judge ~$1 = **~$10** |

Comfortably affordable.

### B5: Decision rubric

After all 5 models run, compare on:

1. **Composite score** (avg of 25 per-question composites)
2. **Floor score** — the LOWEST per-question grade. Catches "model averages 4.5 but tanked one critical audit question to 1.0"
3. **Cost projection** for the 4-week cohort A pilot (~12M tokens):
   - mini: ~$5
   - 4.1: ~$50
   - gpt-5: ~$80
   - sonnet: ~$100
   - haiku: ~$25

4. **Latency** — median time-to-final-text per question. Anything > 30s is a UX problem for streaming chat.

**Selection criteria** (apply in order):
- Reject any model whose floor score < 3.0 (one bad critical question kills the model)
- Among the rest, reject any with composite < 4.0
- Among the rest, pick the cheapest

Tiebreakers:
- Prefer the model with better verbatim-disclaimer behavior (smallest paraphrase rate on Q12-Q15)
- Prefer the model with cleaner tool-routing (fewer wasted tool calls, no `tool_unsupported` errors)

### B6: Fallback wiring

Whatever the primary is, wire `claude-haiku-4-5` (or `gpt-4.1-mini` if haiku is unavailable) as the fallback client. The agent loop already supports this via `fallbackClient` in `runAgentTurnStreaming`. The fallback fires when the primary errors mid-turn (rare but expensive when it happens with no fallback).

Document the choice in `MODEL_SELECTION.md` (already exists from W8).

---

## 5. Sequencing

```
Day 1 (4-5 hrs):
  Stage A1 — demote dispatcher
  Stage A2 — run_full_audit completeness
  Stage A3 — dedup walker
  Stage A4 — search_courses excludeCompleted
  Stage A5 — catalog audit
  Stage A6 — re-grade on gpt-4.1-mini
   → Decision point: do A1-A5 push us to ≥85% A/B on the 20-question sweep?
     YES → proceed to Workstream B with confidence
     NO  → triage which bug categories aren't fixed before continuing

Day 2 (2-3 hrs):
  Stage B2 — bake-off harness + 25-question set frozen
  Stage B3 — auto-grader script
  Stage B4 — RUN the bake-off (5 models × 25 Qs)
  Stage B5 — analyze + pick the production primary
  Stage B6 — wire fallback + update MODEL_SELECTION.md

Day 3 (1 hr):
  Final 5-persona smoke against the chosen primary
  Commit + reviewer pass
  Cohort A pilot is now genuinely ready
```

---

## 6. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Demoting the dispatcher introduces fabrication on policy questions (model paraphrases instead of quoting verbatim) | Medium | High | Validator-replay already exists with `verbatim_drift` check; tighten the verbatim threshold if needed. Templates still injected via `search_policy` for the agent to read. |
| R2 | Stronger model is too slow for streaming UX (>30s per turn) | Low | Medium | Bake-off measures latency. If sonnet-4-6 is too slow, fall back to gpt-4.1 (faster, slightly weaker). |
| R3 | Bake-off cost exceeds budget | Very low | Low | Pre-flight token estimate: ~$10 total. Rate-limit the bake-off runner if any single model exceeds 500k tokens. |
| R4 | Dispatcher demotion breaks the recovery-mode path (cohortConfig.evalGateFailing) | Low | Medium | Keep `runTemplateMatcherOnly` as the recovery-only entry point. Add an integration test that exercises the recovery path with a `limited` cohort user. |
| R5 | LLM-judge grades inflated because judge is too lenient | Medium | Medium | Use claude-haiku-4-5 as judge (different family from gpt candidates). Spot-check 5 random gradings manually. Re-grade with operator if any composite seems off. |
| R6 | New tool flag (`excludeCompleted`) regresses existing search_courses tests | Low | Low | Default false; existing call-sites unchanged. Add new unit test for the flag in isolation. |
| R7 | DPR walker dedup over-eager (drops legitimately distinct child requirements) | Low | Medium | Unit test the dedup against multiple DPR fixtures including the operator's real one + the synthetic "cs sophomore" mkDpr. |

---

## 7. Things explicitly NOT in Phase 8

These are tracked but deferred to Phase 9+:

- **Subagent / Task delegation.** Claude Code uses subagents for parallel work; NYU Path's surface area doesn't justify it.
- **MCP servers.** Closed domain.
- **Auto-compact tuning.** Current context budget is comfortable.
- **Streaming intra-token rendering refinement.** Already shipped in Phase 6.5; no Phase 8 changes.
- **More policy templates.** The whole point of Stage A1 is to reduce template authoring burden, not increase it.
- **Cohort-A user UI polish.** Existing UI is sufficient for the pilot.
- **Eval-set expansion beyond 25 questions.** The 25 questions cover all 4 bug categories + 5 edge cases. More can be added in Phase 9 once we have real student feedback.

---

## 8. Acceptance criteria (rolled up)

Phase 8 ships when ALL of these are true:

- [ ] Workstream A: ≥85% A/B-grade on the 20-question sweep with the trimmed prompt + post-Stage-A5 architecture
- [ ] Workstream B: composite ≥4.0 with floor ≥3.0 on the chosen primary model across the 25-question set
- [ ] All 754 existing tests still pass
- [ ] 5-persona smoke test ([runSmokeW10.ts](tools/cohort-eval/runSmokeW10.ts)) PASS at P0=0
- [ ] Cohort-A frozen eval set ([cohort_a.frozen.json](evals/cohorts/cohort_a.frozen.json)) composite ≥0.90 with the new architecture + new model
- [ ] Independent reviewer pass (spawn a fresh reviewer agent on the Phase 8 commits — the W11-style audit)
- [ ] [MODEL_SELECTION.md](MODEL_SELECTION.md) updated with bake-off results + chosen primary + fallback
- [ ] [PHASE_7E_PLAN.md](PHASE_7E_PLAN.md) §10 ("After cohort A launches") updated to reflect Phase 8 status
- [ ] One operator-facing changelog entry summarizing what changed (so cohort A docs stay accurate)

---

## 9. Decision points needing operator input

These cannot be decided autonomously. Stop and ask before each:

1. **Before Stage A1:** confirm the dispatcher should be demoted, not deleted. (My recommendation: demote — preserve `templateMatcher.ts` for recovery mode.)
2. **Before Stage A6:** if A1-A5 don't push the score to ≥85%, decide whether to proceed to Workstream B or iterate on architecture first.
3. **Before Stage B4 (running the bake-off):** confirm budget (~$10 total). Confirm model availability — do you have `gpt-5` access? If not, what should the 5th slot be (`gpt-4o`? `o1-mini`? skip and run 4)?
4. **After Stage B5:** if the chosen primary is more expensive than `gpt-4.1-mini`, confirm the cost increase is acceptable for cohort A (~$50-100 total for the pilot vs. $5).
5. **Before final commit:** confirm whether to also delete `runTemplateMatcherOnly` or keep it for recovery-mode (my recommendation: keep).

---

## 10. Backout plan

If Phase 8 destabilizes the system:

- Workstream A is one branch with 5 commits, easy to revert per-commit
- Workstream B is non-destructive (only adds files under `tools/cohort-eval/`)
- The model swap is one env-var change in production
- Worst case: revert all Phase 8 commits, re-run the 5-persona smoke, ship cohort A on Phase 7-E + W12 as-is

---

## 11. Author's note on philosophy

This phase is the codification of a lesson the project learned the hard way: **author less, trust the engine more.** The original Phase 1-4 architecture authored per-program rules, then realized that didn't scale (the "infinite work" problem). Phase 7-E pivoted to "ingest the DPR, let NYU compute the audit." Phase 8 takes the same philosophy one level deeper: don't pre-author a router for every question variant either. Let the LLM route, the tools fetch, the validator catch fabrication. Trust the parts; check the whole.

If Stage A1 is the bet, the test is whether the failure modes shift from "wrong template fired" (today) to "agent reasoned poorly" (tomorrow). The latter is a vastly better failure mode because it's diagnosable from chat transcripts, fixable with prompt tweaks, and gets cheaper to resolve as the underlying models improve.

If the bet is wrong — if quality collapses without the dispatcher — the rollback is one revert and we're back to today's architecture. Low cost to test, asymmetric upside if it works.
