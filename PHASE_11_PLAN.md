# Phase 11 — Verification + Clarification (post-Phase-10 reliability layer)

**Status:** Planned · 2026-04-30
**Owner:** edoardo (with Claude)
**Predecessor:** Phase 10 + F1-F5 (commits `abac5de1` + `02b3324f`).
**Reference repo:** `/Users/edoardomongardi/Desktop/claude-code-leak` — direct file/line citations throughout. Read those passages BEFORE implementing the matching stage; this plan is a roadmap, not a substitute.

---

## 0. Why this phase exists

Phase 10 + F1-F5 closed the architecture (data → envelope → posture). Operator self-testing on the real DPR found that:

- The architecture is correct; the remaining quality gaps are not "missing rules" — they're **missing safety nets**.
- The most dangerous failure class isn't "agent says wrong thing once and student notices." It's **"agent says wrong thing confidently and student trusts it."** That's Class E (confidently-wrong) from the failure-surface analysis.
- Three patterns from `claude-code-leak` that we have NOT yet adopted are explicitly designed for this class: (1) mandatory independent verification, (2) gated clarification on ambiguous input, (3) read-only specialist sub-agents.

Phase 11 imports those patterns. Each stage is independently shippable, deterministic where possible, and measurable against the existing 26-question + 5-adversarial benches.

### What Phase 11 does NOT do

Confirmed out-of-scope after the analysis:
- **No standalone query rewriter.** Claude Code does not have one; see `prompts.ts` (no rewriter module exists). We don't either.
- **No TodoWrite-style decomposition.** Coding tasks have 5-50 step workflows; advising queries are 1-3 step. Reference: `TodoWriteTool/prompt.ts` (designed for "complex multi-step tasks ≥3 distinct steps") — our queries rarely meet that bar.
- **No web-search tool.** Closed-domain (CAS bulletin + DPR + FOSE + catalog) is the right scope. Opening the web invites hallucination from blog posts.
- **No blanket pre-loop normalization.** We use **gated** clarification only.

---

## 1. The Phase 11 design — three safety-net layers + one clarifier

```
┌────────────────────────────────────────────────────────────────┐
│ INPUT-SIDE  (before agent loop runs)                          │
│   Stage 3 — Multi-intent enumerator (deterministic detector)  │
│   Stage 4 — Gated clarifier sub-agent (LLM, only when ambig.) │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│ AGENT LOOP  (Phase 10 architecture, unchanged)                │
└────────────────────────────────────────────────────────────────┘
                              ↓
┌────────────────────────────────────────────────────────────────┐
│ OUTPUT-SIDE (before reply streams to user)                    │
│   Stage 1 — Deterministic blockquote-attribution verifier     │
│   Stage 2 — Deterministic plan-feasibility verifier           │
│   Stage 5 — LLM policy-answer verifier (gated, fires after S1)│
│   Stage 6 — Session claim-ledger (cross-turn drift) — DEFERRED│
└────────────────────────────────────────────────────────────────┘
```

The architectural rule (from Phase 10): no new prose case-rules in the system prompt. All new logic lives in tools, validators, or sub-agents. Posture rules in `systemPrompt.ts` change only to wire the new layers, not to enumerate cases.

---

## 2. Stage 1 — Deterministic blockquote-attribution verifier

**Goal:** catch fabricated bulletin quotes (Class E) without an LLM call.

**Pattern source:** `claude-code-leak/verificationAgent.ts:81-128` — the "every PASS must include the executed command's output" rule. We apply the same evidence-required pattern to bulletin quotes: every `> "..."` blockquote attributed to "the bulletin" / "CAS bulletin" / "§..." MUST appear (substring-match) in some `search_policy` chunk this turn. No match → fabrication.

**File to create:** `packages/engine/src/agent/verifiers/blockquoteAttribution.ts`

```ts
// Pseudo-shape
export interface BlockquoteVerdict {
  ok: boolean;
  fabrications: Array<{
    quote: string;          // the offending text
    attribution: string;    // e.g., "CAS bulletin §Internal Transfer Students"
    chunkSearched: number;  // how many RAG chunks we checked
  }>;
}

export function verifyBlockquoteAttribution(
  assistantText: string,
  invocations: ToolInvocation[],
): BlockquoteVerdict
```

**Implementation:**
1. Extract every blockquote (`>`-prefixed lines) and italic-formatted policy quote (`*"..."*`) from `assistantText`.
2. For each, check whether the quoted substring (whitespace-normalized) appears in any RAG chunk surfaced by `search_policy` invocations this turn.
3. If not, push to `fabrications`.
4. Wire into `responseValidator.ts:validateResponse` as a fifth check (alongside grounding / invocations / completeness / verbatim). New violation kind: `"fabricated_attribution"`.

**Reference passage in claude-code-leak (read before implementing):**
- `verificationAgent.ts:81-128` — exact "VERDICT: PASS / FAIL / PARTIAL" output schema with command-run blocks. Mirror the structure.
- `verificationAgent.ts:93-100` — the bad-example block ("Reading code is not verification"). Same applies here: "describing the bulletin says X" without a chunk substring is not verification.

**Files to modify:**
- `packages/engine/src/agent/responseValidator.ts` — add a `checkAttribution(ctx)` function and export the new violation kind.
- `apps/web/app/api/chat/v2/route.ts` and `packages/engine/src/agent/agentLoop.ts` — surface the new violation in the existing `validatorReplayLimit=1` retry pipeline. (No new wiring; the existing replay machinery handles it.)

**Acceptance:**
- Add 3 fabrication-trigger fixtures to `evals/cohorts/phase10_edgeCases.ts` (e.g., re-run the T8 Stern-transfer fabrication case).
- Verifier should fire `fabricated_attribution` on each. Replay should produce a non-fabricated reply.
- 776/788 unit tests stay green. New tests at `packages/engine/tests/eval/blockquoteVerifier.test.ts`.

**Cost:** ~50 lines of code. No LLM call. **Ship first** — highest leverage, lowest risk.

---

## 3. Stage 2 — Deterministic plan-feasibility verifier

**Goal:** catch impossible / over-credit / sequence-violating plans before they reach the user.

**Pattern source:** `claude-code-leak/verificationAgent.ts:27-40` — strategy adaptation per change-type ("Backend: start server → curl endpoints → verify response shapes"). We adapt: per `plan_semester` output type, the verifier runs a fixed checklist of feasibility checks.

**File to create:** `packages/engine/src/agent/verifiers/planFeasibility.ts`

```ts
export interface PlanFeasibilityVerdict {
  ok: boolean;
  violations: Array<{
    kind:
      | "exceeds_semester_ceiling"  // schoolConfig.maxCreditsPerSemester
      | "below_f1_floor"            // schoolConfig.f1FullTimeMinCredits
      | "prereq_chain_broken"       // session.prereqs check
      | "duplicate_in_target_term"  // course already in IP rows
      | "uses_completed_course";    // course already in courseHistory
    detail: string;
    courseId?: string;
  }>;
}

export function verifyPlanFeasibility(
  output: PlanSemesterOutput,
  session: ToolSession,
): PlanFeasibilityVerdict
```

**Checks (deterministic, all from existing data):**
1. **Ceiling:** `creditsAlreadyInTarget + plannedCredits ≤ schoolConfig.maxCreditsPerSemester`.
2. **F-1 floor:** if visa is F1, `creditsAlreadyInTarget + plannedCredits ≥ schoolConfig.f1FullTimeMinCredits`.
3. **Prereq chain:** for each suggestion's `courseId`, walk `session.prereqs`. Every prereq must be in `dpr.courseHistory` with `type ∈ {EN, TE}` (completed) OR in `IP` rows for an EARLIER term than `targetSemester`.
4. **No duplicate in target term:** suggestion's `courseId` must not already be in `alreadyRegisteredForTarget`.
5. **No completed course re-suggested:** suggestion's `courseId` must not be in `dpr.courseHistory` as `EN` (already passed).

**Pattern source for "evidence-not-narrative":** `verificationAgent.ts:101-128` — every check should attach the actual data ("CSCI-UA 211 found in transcript: Grade A, Spring 2023"). Same here: violations attach the deterministic data they used.

**Files to modify:**
- `packages/engine/src/agent/tools/planSemester.ts` — call `verifyPlanFeasibility` at end of `call()`, attach violations to envelope's `disclaimers` (or new `feasibilityIssues` field). The agent then surfaces them per Phase 10 posture rule.
- `packages/engine/tests/agent/planFeasibility.test.ts` — new test file.

**Acceptance:**
- Add 4 plan-feasibility fixtures: over-ceiling plan, below-F1 plan, broken-prereq plan, duplicate-of-IP plan.
- Verifier surfaces each violation. Agent's reply includes the warning verbatim from the envelope (Phase 10 posture rule).

**Cost:** ~80 lines + tests. No LLM call. Ship after Stage 1.

---

## 4. Stage 3 — Multi-intent enumeration (deterministic detector)

**Goal:** prevent the "user asked two questions, agent answered one" failure mode.

**Pattern source:** `claude-code-leak/AgentTool/prompt.ts:99-113` — the "brief the agent like a smart colleague who just walked in" pattern. The relevant insight is that good agents *enumerate* what they were asked to do before doing it. We adopt the enumeration step deterministically, no LLM.

**File to create:** `packages/engine/src/agent/verifiers/multiIntentDetector.ts`

```ts
export interface MultiIntentReport {
  isMultiIntent: boolean;
  detectedSubQuestions: string[];
  signals: Array<"multiple_question_marks" | "coordinating_conjunction" | "compound_what_if">;
}

export function detectMultiIntent(userMessage: string): MultiIntentReport
```

**Detection heuristics (all deterministic):**
1. ≥ 2 `?` marks separated by ≥ 5 words.
2. Coordinating conjunction (`and|also|plus|then`) joining two distinct intent verbs (`what is X AND can I Y` shape).
3. "What if" appearing ≥ 2 times.
4. Two distinct first-person verbs ("can I … should I", "what's my … can I").

**Wiring:**
- `apps/web/app/api/chat/v2/route.ts` — call `detectMultiIntent(body.message)` before agent loop. If `isMultiIntent`, prepend a system message: `"The user's message contains multiple distinct questions: [list]. Address each one in your reply."`
- This is a **system message addition** (data-driven from the detector), NOT a per-case rule in the static system prompt. The static prompt stays unchanged.

**Reference passages:**
- `AgentTool/prompt.ts:99-113` — briefing pattern (give the sub-agent the full context, including ruled-out approaches). Same here: tell the agent what was detected.
- `prompts.ts:291-310` — example of injecting context-dependent guidance dynamically (the "tools provided" section is gated on `enabledTools`). We inject the multi-intent hint the same way.

**Acceptance:**
- Add 5 multi-intent fixtures (e.g., "What's my GPA and can I add a Math minor?", "Can I drop CSCI-UA 480 AND retake it next semester?").
- Each fixture asserts the agent's reply addresses both sub-questions (auto-graded by keyword presence).

**Cost:** ~40 lines + 1-line route wiring. No LLM call. Ship after Stage 2.

---

## 5. Stage 4 — Gated clarifier sub-agent

**Goal:** for genuinely ambiguous queries (Class A, ~25-30% of expected traffic), ask one clarifying question before guessing.

**Pattern source:** `claude-code-leak/exploreAgent.ts:67-74` — the disallowed-tools pattern for read-only sub-agents:

```ts
disallowedTools: [
  AGENT_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
],
```

We apply the same shape: a clarifier sub-agent with **no tool access**, whose only output is a clarifying question.

**File to create:** `packages/engine/src/agent/clarifier.ts`

```ts
export interface AmbiguityReport {
  ambiguous: boolean;
  signals: Array<"ultra_short" | "pronoun_no_antecedent" | "vague_subject">;
}

export function detectAmbiguity(userMessage: string, history: LLMMessage[]): AmbiguityReport;

/** When ambiguous, run the clarifier and return its question. */
export async function askClarification(
  client: LLMClient,
  userMessage: string,
  history: LLMMessage[],
  studentContext: { homeSchool: string; declaredPrograms: string[] },
): Promise<string>;
```

**Detection heuristics (deterministic gate):**
1. Message has ≤ 4 tokens (after stop-word removal).
2. Pronoun ("it", "that", "this") with no clear antecedent in last 2 turns.
3. Subject verb missing ("a minor?", "next semester?").

**Clarifier prompt (modeled on `exploreAgent.ts` but adapted for advising):**
```
You are a clarification specialist for an academic-advising agent.
Your only job: when the student's message is ambiguous, ask ONE concise
clarifying question that would let the main agent answer correctly.

You have NO tools. You CANNOT answer the student's question.
You may ONLY emit: "Could you clarify: [one question]?"

If the message is actually clear, emit exactly: "CLEAR" (the gate is wrong).

Examples of ambiguous messages and the right clarifier:
- "what about a minor?" → "Could you clarify: which minor are you considering, and are you asking about declaring it or about its requirements?"
- "can I take that next semester?" → "Could you clarify: which course do you mean by 'that'?"
```

**Wiring:**
- `apps/web/app/api/chat/v2/route.ts` — before agent loop, run `detectAmbiguity`. If true, run `askClarification`. If output is not "CLEAR", stream it as the agent's reply (no full agent loop this turn). Costs ≈ $0.0003 (haiku, ~200 tokens).
- The gate makes this fire on ≈10-15% of traffic. Pure cost: ≈ $0.00003 per turn averaged.

**Reference passages:**
- `exploreAgent.ts:67-74` — disallowed-tools pattern.
- `AgentTool/prompt.ts:80-96` — when to fork a sub-agent vs do work inline. Apply: clarifier is a fork where "the intermediate output isn't worth keeping in your context."
- `prompts.ts:443-461` — `getSystemPrompt` shows that prompts can be conditionally simplified (the `CLAUDE_CODE_SIMPLE` path returns a minimal prompt). The clarifier is similarly minimal.

**Acceptance:**
- Add 6 ambiguity fixtures (3 ambiguous, 3 clear). Detector must classify correctly.
- For ambiguous fixtures, the clarifier returns a question that the operator (judging) accepts as reasonable.
- For clear fixtures, the clarifier returns "CLEAR" and the agent loop runs as normal.

**Cost:** ~80 lines + 1 LLM call on ambiguous turns only. Ship after Stage 3 once gate accuracy is measured.

---

## 6. Stage 5 — LLM policy-answer verifier (semantic)

**Goal:** beyond Stage 1's substring fabrication check, catch the case where the agent *paraphrased* a bulletin chunk but the chunk is from the **wrong school** or **wrong context** (the "school-mismatch" failure).

**Pattern source:** `claude-code-leak/verificationAgent.ts` (the entire file, but especially):
- Lines 10-12 — anti-avoidance posture: "you have two documented failure patterns. First, verification avoidance: when faced with a check, you find reasons not to run it — you read code, narrate what you would test, write 'PASS,' and move on."
- Lines 50-51 — "Test suite results are context, not evidence." Adapt: "RAG retrieval is context, not evidence — verify the chunk's `school` and `section` metadata match the question's scope."
- Lines 63-72 — adversarial probes mandatory.
- Lines 81-128 — structured output (`### Check / Query run / Evidence / Result`).
- Lines 14-20 — read-only role: "You are STRICTLY PROHIBITED from … modifying any files."

**File to create:** `packages/engine/src/agent/verifiers/policyAnswerVerifier.ts`

The verifier is invoked **only when** Stage 1's blockquote check passes (substring match found) but additional semantic confirmation is wanted. Gate criteria:
- The reply contains a policy claim (`/\b(?:policy|bulletin|rule)\b/i`).
- The reply attributes to a specific school's bulletin (`/\b(CAS|Stern|Tandon|Tisch|Steinhardt|Gallatin|Liberal Studies)\b/`).
- The student's home school differs from the cited school OR the cited school doesn't appear in the search_policy result chunks' metadata.

When the gate fires, run a haiku call with the `verificationAgent.ts`-style prompt:

```
You are a policy-answer verifier for an academic-advising agent. You have
two documented failure patterns:
1. Avoidance: you read the chunk, say "looks consistent," and pass it.
2. School-mismatch: you confirm the rule exists somewhere without checking
   it applies to THIS student's school.

CRITICAL: You are READ-ONLY. You do NOT answer the student. You only verify.

== INPUT ==
- Student's home school: {homeSchool}
- Student's question: {userQuestion}
- Agent's reply: {assistantText}
- RAG chunks retrieved this turn: [{chunk.school, chunk.section, chunk.text}, ...]

== REQUIRED CHECKS ==
For each policy claim in the reply:
1. Find the supporting RAG chunk by substring match.
2. Verify chunk.school matches the student's home school OR an explicitly-
   referenced different school in the question.
3. Verify chunk.section is topically aligned (e.g., a P/F claim should
   come from a §Pass/Fail or §Grading section, not §Withdrawal).

== OUTPUT FORMAT ==
### Check: [policy claim]
**Chunk found:** [chunk.school / chunk.section]
**Result: PASS** (or FAIL with reason)

End with: VERDICT: PASS | FAIL | PARTIAL
```

**Wiring:**
- `packages/engine/src/agent/agentLoop.ts` — after the final assistant text is produced AND Stage 1 has passed, run the gate. If the gate fires, run the verifier. If `VERDICT: FAIL`, push a violation through the existing `validatorReplayLimit=1` pipeline. The agent retries once with the verifier's findings appended as a system message.

**Reference passages:**
- `verificationAgent.ts:14-20` — read-only "STRICTLY PROHIBITED" framing. Mirror it.
- `verificationAgent.ts:42-49` — strategy adaptation per change type. Mirror with "policy-claim type: P/F, residency, transfer, etc."
- `prompts.ts:390-395` — the contract pattern ("you cannot self-assign PARTIAL"). Mirror: "the agent's own claim that the policy is right is not evidence; only the verifier assigns a verdict."

**Acceptance:**
- Add 4 school-mismatch fixtures (e.g., agent quotes Stern bulletin to a CAS student about a CAS-only policy).
- Verifier fires `VERDICT: FAIL` on each.
- Replay produces a corrected reply that either (a) cites the correct chunk or (b) defers to adviser.

**Cost:** ~120 lines + 1 LLM call on ~5-10% of turns (gate-narrowed). Ship after Stages 1-4 are stable. **Optional** if Stage 1 + F4 prove sufficient at cohort A scale.

---

## 7. Stage 6 — Session claim-ledger (DEFERRED)

**Goal:** prevent multi-turn drift where turn 4 cites "the policy I quoted earlier" but the earlier reference was wrong.

**Pattern source:** Claude Code does not have an exact analog. The closest is the conversation-history persistence in `apps/web/lib/db/store.ts` (our existing pattern) plus the verification-agent's evidence-required posture (`verificationAgent.ts:81-128`).

**Sketch:**
- Every time the agent surfaces a verbatim bulletin quote, log `{turn, quote, sourceChunkId}` in a session-scoped ledger.
- On future turns, when the agent's reply contains "as I mentioned earlier" / "the policy I cited" / similar, check the ledger.
- If the agent now references a non-existent prior claim (or one with a different `sourceChunkId`), flag.

**Status:** Deferred until cohort A produces ≥ 1 documented multi-turn drift case. Building this proactively is speculative; cost/benefit unclear without live data.

---

## 8. Acceptance gates for the whole phase

Each stage ships independently. Phase 11 is "complete" when:

- [ ] Stage 1 deterministic blockquote verifier landed; new fabrication fixtures pass.
- [ ] Stage 2 plan-feasibility verifier landed; new feasibility fixtures pass.
- [ ] Stage 3 multi-intent detector landed; multi-intent fixtures pass.
- [ ] Stage 4 clarifier sub-agent landed; ambiguity gate accuracy ≥ 80% (operator judges).
- [ ] Stage 5 — operator decision after S1-S4 results: ship if S1's deterministic check leaves measurable Class E gaps; defer otherwise.
- [ ] Stage 6 deferred until cohort A live data justifies it.
- [ ] All 776+ unit tests green.
- [ ] 26-question Phase 10 bench: overall pass rate ≥ 65% (no regression).
- [ ] 5-case adversarial probe: 5/5 still passes (no regression).
- [ ] New: 18 Phase 11 fixtures across S1/S2/S3/S4 — all pass.

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stage 4 clarifier asks unnecessary questions on clear queries | Medium | Medium | Gate accuracy is measured before ship; operator-tunable thresholds |
| Stage 5 verifier produces false-positive FAIL on correct answers | Medium | High | Conservative fallback (when verifier output is ambiguous, treat as PASS); start with optional/observe-only mode for first 100 turns |
| Stage 1 substring check too brittle (curly vs straight quotes) | Low | Low | Whitespace + smart-quote normalization in the matcher |
| Stage 2 prereq check is wrong because `session.prereqs` graph is stale | Medium | Medium | Document the staleness assumption; verifier disclaimer in envelope says "based on currently-loaded prereq graph" |
| Adding 4 verifiers slows the response noticeably | Low | Medium | All deterministic stages add < 50ms; only S4/S5 add an LLM call, both gated |
| New violation kinds confuse the existing replay loop | Low | High | Each new kind goes through the existing `validatorReplayLimit=1` pipeline; tested against the existing `chatV2Route.test.ts` |

---

## 10. Cost & timing

- Stages 1-3: ~1 day total. All deterministic.
- Stage 4: ~½ day. Gate + clarifier prompt + tests.
- Stage 5: ~1 day. Verifier prompt + gate + retry wiring.
- Stage 6: deferred (no scope here).

API cost at cohort A pilot scale (10 students × ~30 turns/student/month):
- Stages 1-3: $0 (deterministic).
- Stage 4: ~$0.001/month (10-15% of 300 turns × $0.0003).
- Stage 5: ~$0.005/month (5-10% of 300 turns × $0.001).

**Total marginal cost: ~$0.006/month at cohort A scale.** Negligible.

---

## 11. Decision log

| Date | Decision | By | Rationale |
|---|---|---|---|
| 2026-04-30 | Skip TodoWrite-style decomposition | Operator + Phase-11 analysis | `TodoWriteTool/prompt.ts` is for ≥3-step workflows; advising queries don't meet that bar. |
| 2026-04-30 | Skip blanket query rewriter; use gated clarifier | Operator | Claude Code has no rewriter (`prompts.ts` shows none). Gate-and-ask is cheaper and more honest. |
| 2026-04-30 | Skip web-search tool | Operator | Closed-domain RAG is correct for academic advising; web invites hallucination. |
| 2026-04-30 | S1 (deterministic blockquote) is highest priority | Plan | Catches Class E (confidently-wrong) for ~30 lines of code, no LLM cost. |
| 2026-04-30 | S6 deferred until cohort A live data | Plan | No observed multi-turn drift yet; building proactively is speculative. |

---

## 12. Files added in Phase 11 (preview)

```
packages/engine/src/agent/
  verifiers/
    blockquoteAttribution.ts          # Stage 1
    planFeasibility.ts                # Stage 2
    multiIntentDetector.ts            # Stage 3
    policyAnswerVerifier.ts           # Stage 5 (optional)
  clarifier.ts                        # Stage 4

packages/engine/tests/
  agent/
    blockquoteVerifier.test.ts
    planFeasibility.test.ts
    multiIntentDetector.test.ts
    clarifier.test.ts

evals/cohorts/
  phase11_fixtures.ts                 # 18 new cases (S1+S2+S3+S4)

tools/cohort-eval/
  runPhase11Bench.ts                  # bench runner
```

Files modified:
```
packages/engine/src/agent/responseValidator.ts    # Stage 1 wiring + new violation kind
packages/engine/src/agent/tools/planSemester.ts   # Stage 2 wiring (envelope feasibility field)
apps/web/app/api/chat/v2/route.ts                 # Stages 3 + 4 pre-loop wiring
packages/engine/src/agent/agentLoop.ts            # Stage 5 post-loop wiring (gated)
ARCHITECTURE.md                                   # add §3.1.2 Phase-11 verification layer
MEMORY.md                                         # phase-11 status entry
```

---

## 13. The one-line summary I want to write at the end

> "After Phase 11, fabricated bulletin quotes are caught by data, ambiguous queries are clarified before guessing, and multi-intent compounds get both halves answered. None of these are 'if user asks X' rules — they're structural safety nets that fire on the failure shape, not the failure case."

---

## Appendix A — claude-code-leak file/line index used in this plan

For implementer convenience, here are every passage referenced above with brief notes:

| Path in `claude-code-leak/` | Lines | What's there | Used in stage |
|---|---|---|---|
| `prompts.ts` | 291-310 | Tool routing rules in system prompt (the "use Grep not grep" pattern) | (Phase 10, no new use) |
| `prompts.ts` | 374-380 | Threshold-based delegation (≥ 3 queries → spawn Explore agent) | S4 (gate analogy) |
| `prompts.ts` | 390-395 | Verification contract — "your own checks do NOT substitute" | S1, S5 |
| `prompts.ts` | 443-461 | `getSystemPrompt` + `CLAUDE_CODE_SIMPLE` minimal mode | S4 (minimal-prompt analogy) |
| `verificationAgent.ts` | 10-12 | Anti-avoidance: "you have two documented failure patterns" | S5 |
| `verificationAgent.ts` | 14-20 | Read-only "STRICTLY PROHIBITED" framing | S5 |
| `verificationAgent.ts` | 27-40 | Strategy adaptation per change-type | S2 |
| `verificationAgent.ts` | 42-49 | Strategy adaptation continued | S5 |
| `verificationAgent.ts` | 50-51 | "Test results are context, not evidence" | S5 |
| `verificationAgent.ts` | 63-72 | Adversarial probes mandatory | S5 |
| `verificationAgent.ts` | 81-128 | Structured output: `### Check / Command run / Result / VERDICT` | S1, S2, S5 |
| `verificationAgent.ts` | 93-100 | Bad-example: "Reading code is not verification" | S1 |
| `verificationAgent.ts` | 101-128 | Evidence-required output format | S2 |
| `exploreAgent.ts` | 67-74 | `disallowedTools` for read-only sub-agents | S4 |
| `AgentTool/prompt.ts` | 80-96 | When to fork a sub-agent | S4 |
| `AgentTool/prompt.ts` | 99-113 | Briefing pattern ("smart colleague who just walked in") | S3 |
| `TodoWriteTool/prompt.ts` | (whole) | TodoWrite — referenced as NOT-adopted | §0 |
| `systemPromptSections.ts` | 20-38 | Modular cacheable prompt sections | (background reading) |

**Implementer rule:** before writing code for a stage, open the cited passages and read them. The exact wording of Claude Code's prompts is doing structural work; paraphrasing tends to lose the point.
