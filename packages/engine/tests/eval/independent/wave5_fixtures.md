---
title: Independent (Bulletin-only) Test Fixtures — Wave 5 (Phase 5: agent loop, system prompt, template matcher, response validators)
author: independent-fixtures-author wave 5 (no engine source read beyond barrel exports + LLMClient interface + RecordingLLMClient header per the wave-5 brief)
date: 2026-04-26
inputs:
    - ARCHITECTURE.md §2.1 (Cardinal Rule), §3.2 (template matcher → agent loop), §5.5 (curated templates / 5-step gate),
      §6.1-6.4 (agent loop), §7.1-7.2 (tool registry, validateInput), §9.1 Part 4a/4b/4c (validators), §9.1 Part 9 (launch-blocking gates),
      Appendix A (system prompt 25 rules), Appendix D §D.1-D.5 (correctness)
    - data/policy_templates/cas_pf_major.json (id, school, source, body verbatim)
    - data/transfers/cas_to_stern.json (Stern internal-transfer fixture, gpaNote, "32 credits" minimum)
    - data/bulletin-raw/undergraduate/business/admissions/_index.md L121-138 (internal-transfer requirements, March 1, 32 credits, GPA-not-published)
    - data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md L138 (P/F major prohibition)
    - data/bulletin-raw/undergraduate/arts-science/college-core-curriculum/_index.md (CAS Core baseline)
    - packages/engine/src/agent/index.ts (barrel exports)
    - packages/engine/src/agent/llmClient.ts (LLMClient interface)
    - packages/engine/src/agent/recordingClient.ts (RecordingLLMClient — including the matcher schema + assistantTurnIndex + latestToolResultContains semantics)
    - MODEL_SELECTION.md (winner is gpt-4.1-mini; the agent loop is tested via RecordingLLMClient — no model API call)
---

# Independent (Bulletin-only) Test Fixtures — Wave 5

> **Coverage target:** Phase-5 deliverables — `runAgentTurn`, `preLoopDispatch` (template matcher 5-step gate, §5.5), `validateResponse` (the three launch-blocking validators in §9.1 Part 9 — grounding, invocation auditor, completeness checker), `RecordingLLMClient`, the system prompt's 25 rules.
>
> **Authoring constraint:** No agent-module source body was read other than the barrel `index.ts`, the `LLMClient` interface, and the `RecordingLLMClient` header (its match-schema is verbatim from its own file's documented surface). Predictions are derived from ARCHITECTURE.md, the bulletin, and the published types.
>
> **Inferred but explicitly cited APIs (per index.ts barrel):**
> - `runAgentTurn(opts: AgentTurnOptions): Promise<ChatTurnResult>` returns `ToolInvocation[]` per the exported `ToolInvocation` type — the test asserts each invocation surfaces `error?: string` for validateInput rejections (per §7.2 / `Tool.ts` L489-492 — error messages flow back to LLM via `is_error: true`).
> - `preLoopDispatch(message, profile, history, ...): PreLoopResult` returns either `{ kind: "template", match: { template: { id, school, body, ... } } }` or `{ kind: "fallthrough" }` (per §5.5 5-step gate; types from `PreLoopResult` export name).
> - `validateResponse(response, ctx): ValidatorVerdict` returns `{ ok: boolean, violations: Violation[] }` where `Violation` has `kind: ViolationKind` and (for caveats) `caveatId: string`. The kinds covered: `ungrounded_number`, `missing_invocation`, `missing_caveat` — these names follow §9.1 Part 4a/4b/4c naming and are the minimum the validator must surface for the assertions in this wave to be testable. **If the actual `ViolationKind` literal differs, the tests fail and the run report logs that literal as a documentation/code mismatch — that is itself a wave-5 finding.**
>
> **Key fact about `RecordingLLMClient`:** its `match` schema (verbatim from `recordingClient.ts` L27-37) supports `userMessageEquals`, `userMessageContains`, `latestToolResultContains`, `assistantTurnIndex`. The order of recordings IS the matching order; first recording whose match-clause matches wins. `assistantTurnIndex` counts the assistant messages already in the message stream BEFORE this completion — so the first assistant turn is index `0`, the second is index `1`, etc.

Each scenario below specifies the bulletin/architecture fact under test, the recording fixture (or session shape) used to drive it, and the bulletin-predicted assertions for the engine's reply. The vitest harness in `wave5.test.ts` mirrors these assertions verbatim.

---

## Scenario 1 — Cardinal Rule §2.1 violation: synthesized GPA without `run_full_audit`

**Bulletin / architecture references:**

- ARCHITECTURE.md §2.1 — *"The LLM NEVER computes. It orchestrates tools that compute. Every number a student sees (GPA, credits remaining, completion rate) comes from a deterministic tool."*
- ARCHITECTURE.md §9.1 Part 4a (grounding) — *"Ungrounded numbers (GPA/credits not from a tool)."*
- ARCHITECTURE.md §9.1 Part 4b (invocation audit) — *"GPA (cumulative or per-major) → required tool: `get_academic_standing`. If missing → block + re-prompt."*
  Note the §9.1 Part 4b table specifies `get_academic_standing` for GPA. Architectural §6.4 Part 4b code excerpt requires `run_full_audit` for "credits or requirements." For a GPA-only claim, both readings give a `missing_invocation` violation when neither tool is called. The brief asks us to predict BOTH violations (`run_full_audit` AND `get_academic_standing` not called), and to assert that AT LEAST ONE `missing_invocation` violation surfaces. That is the bulletin-supportable invariant; whether the engine emits one violation or two is an implementation detail and we predict ≥1.
- Appendix A System Prompt rule #1 — *"NEVER compute numbers yourself. Every number must come from a tool result."*

**Recording fixture (RecordingLLMClient input — single recording matched on first user message):**

```jsonc
{
  "match": { "userMessageContains": "what is my GPA" },
  "completion": {
    "text": "Hi! Based on your transcript, your GPA is 3.42 — you're doing well. Let me know if you'd like to plan next semester.",
    "toolCalls": [],
    "latencyMs": 0
  }
}
```

**Session shape:** CAS junior with declared `cs_major_ba`, transcript has graded courses (so `validateInput` for `run_full_audit` would succeed if it were called — that proves the violation is truly the agent skipping the tool, not an upstream gate). Crucially, `toolCalls` is empty: the model returns text directly. The agent loop completes the turn after this recording is consumed.

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `runAgentTurn(...).toolInvocations` | `[]` (the recorded completion has no tool calls) | recording fixture above |
| `runAgentTurn(...).reply` (final assistant text) | contains `"3.42"` (the model's ungrounded number) | recording fixture |
| `validateResponse(reply, ctx).ok` | `false` | §9.1 Part 4a + 4b |
| `validateResponse(...).violations` includes a violation with `kind === "ungrounded_number"` | `true` | §9.1 Part 4a — number-without-tool detection |
| `validateResponse(...).violations` includes a violation with `kind === "missing_invocation"` | `true` | §9.1 Part 4b — GPA claim made without `get_academic_standing` (or `run_full_audit`) being called |

**Why this is a TWO-violation case, not just one:** §9.1 Part 4a (grounding) catches "the number 3.42 has no source"; §9.1 Part 4b (invocation auditor) catches "the response discusses GPA but `get_academic_standing` was never called." These are independent checks per the architecture's explicit framing of why 4b exists ("validateInput() only fires when a tool IS called. It cannot catch the case where the LLM decides to answer from training data WITHOUT calling any tool"). Both should fire on this recording.

---

## Scenario 2 — F-1 visa caveat omission (completeness checker, §9.1 Part 4c)

**Bulletin / architecture references:**

- ARCHITECTURE.md §9.1 Part 4c (completeness checker) — pseudocode lines 1979-1981:
  ```
  if (profile.visaStatus === 'F-1' && !response.toLowerCase().includes('f-1')
      && responseTouchesCourseLoad(response)) {
    missedCaveats.push('Student is F-1 but response does not mention visa-related enrollment constraints.');
  }
  ```
- Appendix D §D.2 — *"F-1 enrollment constraints: required mention if `P.visaStatus === 'F-1'` AND Q touches course load, credits, or enrollment."*
- Appendix A System Prompt rule #19 — *"BEFORE calling `plan_semester`, check profile for REQUIRED fields: `visaStatus`..."* implies F-1 is high-stakes context that must be addressed.

**Recording fixture** (the model's reply DROPS the student to 9 credits — directly touches course load — without mentioning F-1):

```jsonc
{
  "match": { "userMessageContains": "drop to 9 credits" },
  "completion": {
    "text": "Sure — dropping one of your courses leaves you at 9 credits this term, which is a manageable workload. Let me know which course you'd like to drop.",
    "toolCalls": [],
    "latencyMs": 0
  }
}
```

**Session shape:** student profile has `visaStatus: "F-1"`, current term planned at 12 credits. The validator context (`ctx.profile`) carries this. The user query explicitly mentions "drop to 9 credits" — so `responseTouchesCourseLoad(response)` returns true (the response uses "9 credits" / "workload").

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `runAgentTurn(...).reply` | contains "9 credits" but NOT "F-1" or "F1" or "visa" | recording fixture |
| `validateResponse(reply, { profile: F-1, ... }).ok` | `false` | §9.1 Part 4c |
| `violations` contains a `missing_caveat` violation with `caveatId === "f1_visa"` | `true` | §9.1 Part 4c — the named caveat for F-1 omissions. The architectural pseudocode (line 1980) names the caveat "Student is F-1 but response does not mention visa-related enrollment constraints", but the canonical caveat ID for the F-1 case is `f1_visa` (matches the §5.5 template name `f1_fulltime.md` family). **If the engine names this caveat differently (e.g., `f1_visa_omitted`, `visa_constraint`, `f1_enrollment`), wave 5 reports the literal as a finding — the bulletin/§9.1 Part 4c is silent on the exact ID, so the literal is undetermined and we accept any ID containing "f1" or "visa" as the bulletin-supportable answer.** |

**Caveat-ID predicate (relaxed to the bulletin-supportable invariant):** at least one violation has `kind === "missing_caveat"` AND its `caveatId` lower-cased contains `"f1"` OR `"visa"`. This avoids over-fitting to a specific naming convention while still asserting the validator routes through the right deterministic branch.

---

## Scenario 3 — Internal-transfer GPA-not-published caveat omission

**Bulletin / architecture references:**

- ARCHITECTURE.md §7.2 `check_transfer_eligibility` `prompt()` body, line 1559-1560: *"NOTE: GPA requirements are NOT published by most schools — always caveat this."*
- ARCHITECTURE.md §7.2 `check_transfer_eligibility` `summarizeResult`, line 1615: tool result includes `"${result.gpaNote}"` where `gpaNote = "Minimum GPA for internal transfer is not published. Contact the target school's admissions office."` (line 1604).
- `data/transfers/cas_to_stern.json` line 128: `"Minimum GPA for internal transfer is not published. Contact the target school's admissions office."`
- Bulletin: `data/bulletin-raw/undergraduate/business/admissions/_index.md` lines 121-138 — defines the internal-transfer requirements with no published GPA threshold.
- ARCHITECTURE.md §9.1 Part 4c style invariant: the completeness checker should fire when a student's transfer eligibility reply is given without the GPA-not-published caveat, because the tool result EXPLICITLY contains this caveat in its summarizeResult and the model dropped it.

**Recording fixture** (two recordings — first turn the model calls the tool; second turn it produces a reply that omits the GPA caveat):

```jsonc
// Turn 1 — model issues the tool call after seeing the user question.
{
  "match": { "userMessageContains": "transfer to Stern" },
  "completion": {
    "text": "",
    "toolCalls": [
      { "id": "call-1", "name": "check_transfer_eligibility", "args": { "targetSchool": "stern" } }
    ],
    "latencyMs": 0
  }
}
// Turn 2 — after the tool result, the model writes a reply that mentions deadlines
// and prereqs but DROPS the GPA-not-published caveat. Match by latestToolResultContains
// so this fires after the tool result is appended to the message stream.
{
  "match": { "latestToolResultContains": "Transfer eligibility" },
  "completion": {
    "text": "Good news — you're on track for a junior-year transfer to Stern. The application deadline is March 1, and you've completed all five required prerequisite categories: calculus, writing, statistics, financial accounting, and microeconomics. Submit by March 1 to be considered for the next fall.",
    "toolCalls": [],
    "latencyMs": 0
  }
}
```

**Session shape:** CAS junior with completed prereq courses (`MATH-UA 121`, `EXPOS-UA 1`, `MATH-UA 235`, `ACCT-UB 1` (or via transfer credit, but for simplicity use `ECON-UA 18` for stats and add `ACCT-UB 1` as a CAS-allowed cross-school credit), `ECON-UA 2`). 64+ credits completed. The agent loop runs `check_transfer_eligibility` on turn 1, gets a tool result whose `summarizeResult` includes the literal `"Minimum GPA for internal transfer is not published"` (per §7.2 + `cas_to_stern.json` line 128), then on turn 2 emits a reply text that omits "GPA" and "not published".

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `runAgentTurn(...).toolInvocations.length` | `1` (the `check_transfer_eligibility` call from turn 1) | recording turn 1 |
| `runAgentTurn(...).toolInvocations[0].name` | `"check_transfer_eligibility"` | recording turn 1 |
| `runAgentTurn(...).reply` | contains `"March 1"` (and other tool-grounded facts) but omits both `"GPA"` and `"not published"` (case-insensitive) | recording turn 2 |
| `validateResponse(reply, { profile, toolResults, ... }).ok` | `false` | §9.1 Part 4c |
| `violations` contains a `missing_caveat` whose `caveatId` lower-cased contains `"transfer"` AND (`"gpa"` OR `"published"` OR the literal architectural id `"internal_transfer_gpa_note"`) | `true` | §9.1 Part 4c — the internal-transfer GPA caveat is the dominant missed-caveat for this query class. **If the engine omits this check entirely (validator returns `ok: true`), wave 5 reports it as the highest-priority finding: the architecture explicitly says the validator must catch tool-result-supplied caveats that the model drops.** |

**Caveat-ID predicate (relaxed to the bulletin-supportable invariant):** at least one violation has `kind === "missing_caveat"` AND its `caveatId` lower-cased contains either `"transfer"` AND (`"gpa"` OR `"published"`), OR the literal `"internal_transfer_gpa_note"`. This is the canonical wording in the brief.

---

## Scenario 4 — Template fast-path wins over agent loop (P/F major, CAS)

**Bulletin / architecture references:**

- ARCHITECTURE.md §3.2 + §5.5 — template matcher runs BEFORE the agent loop. If all 5 gate steps pass, the curated body is served directly without LLM synthesis.
- `data/policy_templates/cas_pf_major.json`:
  - `"id": "cas_pf_major"` (line 10)
  - `"school": "cas"` (line 11)
  - `"triggerQueries": ["p/f major", "pass fail major", "pass/fail my major", "pass-fail in my major", "p/f for major"]` (lines 14-20)
  - `"body"` includes the verbatim phrase `"32 credits"` (in the line "The career P/F cap is 32 credits, and you may elect at most one P/F per term (line 410).") and a verbatim quote from CAS bulletin L138.
- Bulletin: `data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md` line 138: *"No course to be counted toward the major or minor may be taken on a Pass/Fail basis."*

**Session shape:** CAS sophomore (`homeSchool: "cas"`, no transfer intent flag, conversation history empty so the §5.5 step-2 context-safety gate passes). User message: `"Can I take a major course P/F?"`.

**Why each of the 5 §5.5 gate steps passes:**

| Step | Predicate | Result |
|---|---|---|
| 1. Query similarity | Lower-cased query is `"can i take a major course p/f?"`. The `triggerQueries` include `"p/f major"` and `"p/f for major"` — substring `"p/f"` and `"major"` are both present, and the canonical phrasing `"p/f for major"` is conceptually close. **Bulletin-prediction: at least one trigger matches.** Note that exact substring matching against `"p/f major"` would NOT hit (the query doesn't contain the literal substring `"p/f major"` because of the words "a … course" between them). The wave-5 brief asserts the engine's matcher is good enough to fire on this phrasing; if it doesn't, the test fails and we surface the matcher's narrowness as a finding. The brief explicitly predicts `match.template.id === "cas_pf_major"` so we ASSERT it. |
| 2. Context safety | Conversation history is empty / contains no context-dependent references | passes |
| 3. School check | Template `school === "cas"` matches `profile.homeSchool === "cas"` | passes |
| 4. Applicability check | Template has no `applicability` field; default applicable | passes |
| 5. Freshness check | Template `lastVerified === "2026-04-26"` (today). 12-month window: passes | passes |

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `preLoopDispatch("Can I take a major course P/F?", profile_cas, [], ...).kind` | `"template"` | §5.5 + `cas_pf_major.json` triggers |
| `result.match.template.id` | `"cas_pf_major"` | brief + template `id` field |
| `result.match.template.school` | `"cas"` | template `school` field |
| `result.match.template.body` contains `"32 credits"` | `true` | verbatim from template `body` |
| `result.match.template.body` contains `"No course to be counted toward the major"` | `true` | verbatim quote from CAS bulletin L138 in template `body` |

**Failure mode if `preLoopDispatch` returns `"fallthrough"`:** the matcher is too narrow on substring-trigger matching and loses the fast-path for one of the most common CAS questions. That's a wave-5 finding.

---

## Scenario 5 — Cross-school override admits Stern, but cas_pf_major template MUST NOT fire

**Bulletin / architecture references:**

- ARCHITECTURE.md §5.5 step-3 (school check) — *"Same question has different answers per school"*; even when the user is a CAS student, a question that explicitly compares CAS to Stern is OUT OF SCOPE for a CAS-only template.
- ARCHITECTURE.md §5.5 step-4 (applicability check) — for templates with `applicability.excludeIfPrograms`, the template is skipped if cross-school context applies. The wave-5 brief calls this out: a CAS-only template firing on a Stern-comparison question would deliver a curated CAS answer to a question that explicitly asks about Stern, which is wrong.
- The engine's correct behavior: fall through to the agent loop (so RAG can pull in Stern chunks via `computeScope` override per Wave 4 Scenario 1).
- Note: the existing `cas_pf_major.json` does NOT have an `applicability` field. The wave-5 brief expects step 1 (query similarity) to NOT fire on `"How does Stern's pass-fail differ?"` because none of the `triggerQueries` (which are all CAS-major phrased) substring-match this query. **The bulletin-supportable invariant is that the template matcher MUST NOT serve the CAS template here, regardless of which step blocks it.**

**Session shape:** Same CAS sophomore as Scenario 4. User message: `"How does Stern's pass-fail differ?"`. Conversation history empty.

**Why each gate step's outcome:**

| Step | Predicate | Result |
|---|---|---|
| 1. Query similarity | Lower-cased query: `"how does stern's pass-fail differ?"`. None of the CAS template's `triggerQueries` (`"p/f major"`, `"pass fail major"`, etc.) appear as substrings — the literal phrases require the word "major" or "p/f" + "major" together; the query has `"pass-fail"` but no `"major"` token. **Bulletin-prediction: NO match.** | fail |
| 2-5 | Don't run if step 1 already fails | n/a |

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `preLoopDispatch("How does Stern's pass-fail differ?", profile_cas, [], ...).kind` | `"fallthrough"` | §5.5 step 1 — none of the cas_pf_major triggers match this query |
| `result.match` | `undefined` (no template was matched) | derived from `kind === "fallthrough"` |
| Sanity: `preLoopDispatch(...).kind` for `"Can I P/F a major course?"` (Scenario-4 control) | `"template"` | confirms the matcher CAN fire on a CAS query, so the failure on the Stern-comparison query is genuinely about scope, not a global matcher bug |

**Failure mode if `preLoopDispatch` returns `"template"` here:** a CAS student asking a cross-school comparison question would receive a CAS-only answer that pretends Stern's policy doesn't matter — exactly the §5.5 cross-school-conflict failure the architecture warns about. That's a wave-5 finding.

---

## Scenario 6 — Tool input validation rejection surfaced to model

**Bulletin / architecture references:**

- ARCHITECTURE.md §7.2 `search_policy.validateInput` (lines 1381-1386):
  ```
  validateInput(input) {
    if (input.query.length < 5) {
      return { valid: false, message: "Query too short. Provide a specific policy question." }
    }
    return { valid: true }
  }
  ```
  Note the brief's prediction is for a Zod `z.string().min(2)` rejection, but the architectural validateInput uses `length < 5`. **Both interpretations agree that an empty query (`""`) MUST be rejected.** The brief predicts the rejection-message text contains "validation failed" — that's the wording style §9.1 Part 1 uses for tool-contract errors ("Errors become messages the LLM can reason about"). The exact literal might be "Query too short" (architecture) or "validation failed: query length" (Zod default). The bulletin-supportable invariant is: the first turn surfaces an error message that the second turn's recorded match-clause can reliably substring-match.
- ARCHITECTURE.md §6.1 / `Tool.ts` L489-492 — *"validateInput() is called BEFORE call(). It returns `{ valid: true }` or `{ valid: false, message }`. The error message goes directly into the tool_result as `is_error: true`, so the LLM sees it and can adapt."*
- ARCHITECTURE.md §9.1 Part 1 + Part 2 (standardized tool contracts + input validation) — both are launch-blocked at Phase 1, so by Phase 5 they're guaranteed-on.

**Recording fixture** (two recordings — first turn the model issues `search_policy({ query: "" })`; second turn it sees the validation-failed error and recovers gracefully):

```jsonc
// Turn 1 — model issues the malformed tool call
{
  "match": { "userMessageContains": "policy" },
  "completion": {
    "text": "",
    "toolCalls": [
      { "id": "call-1", "name": "search_policy", "args": { "query": "" } }
    ],
    "latencyMs": 0
  }
}
// Turn 2 — model recovers after seeing the validation error.
// Match-clause uses latestToolResultContains so the test can verify the
// error message reached the model. The substring "validation failed" is the
// brief's predicted token. If the engine emits "Query too short" instead,
// the test FAILS — but that failure is itself the documented wave-5 finding,
// because the brief asserted "validation failed" as the bulletin-supportable
// boundary error message.
{
  "match": { "latestToolResultContains": "validation failed" },
  "completion": {
    "text": "Sorry — could you tell me which policy you'd like me to look up? For example, P/F rules, credit caps, or transfer prerequisites?",
    "toolCalls": [],
    "latencyMs": 0
  }
}
```

**Session shape:** any CAS student profile with sufficient context. User message: `"Look up a policy for me"` (intentionally vague to motivate the empty query — though this only matters as a substring-anchor for the turn-1 match-clause).

**Bulletin-predicted outcomes:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `runAgentTurn(...).toolInvocations[0].name` | `"search_policy"` | recording turn 1 |
| `runAgentTurn(...).toolInvocations[0].args.query` | `""` | recording turn 1 |
| `runAgentTurn(...).toolInvocations[0].error` (or equivalent error field) | non-empty string containing `"validation failed"` (case-insensitive substring) | brief's predicted boundary; rejected by validateInput per §7.2 |
| `runAgentTurn(...).reply` | the second-turn assistant text — contains `"Sorry"` and `"policy"` and an offer to clarify | recording turn 2 |
| `runAgentTurn(...).turnCount` (or equivalent) | `>= 2` (two LLM completions) | two recordings consumed |

**Why turn-2's `latestToolResultContains: "validation failed"` is the load-bearing assertion:** it proves end-to-end that the tool's `validateInput` rejection was passed back to the LLM as a message the LLM could reason about (per §9.1 Part 1 invariant). If the engine surfaces the error under a different literal (e.g., "Query too short.") the second recording's match-clause never fires and the test will throw `RecordingLLMClient: no recording matched`. That throw IS the test's failure signal — it both surfaces the discrepancy AND proves the message wasn't routed.

---

# Summary of Bulletin-derived predictions across the 6 scenarios

| Scenario | What it tests | Predicted validator outcome |
|---|---|---|
| 1 | Cardinal Rule §2.1 — synthesized GPA without `run_full_audit` | `ok: false`, ≥1 `ungrounded_number` violation, ≥1 `missing_invocation` violation |
| 2 | F-1 caveat omission (response touches course load) | `ok: false`, ≥1 `missing_caveat` violation with `caveatId` referencing F-1/visa |
| 3 | Internal-transfer GPA-not-published caveat omission (tool said it, model dropped it) | `ok: false`, ≥1 `missing_caveat` violation referencing transfer-GPA |
| 4 | CAS template fast-path wins on a clean CAS P/F-major query | `kind: "template"`, `template.id === "cas_pf_major"`, body contains "32 credits" + bulletin verbatim |
| 5 | Cross-school override does NOT fire CAS-only template | `kind: "fallthrough"` |
| 6 | `search_policy` validateInput rejection surfaces to model | `toolInvocations[0].error` contains "validation failed"; turn-2 reply was generated AFTER seeing that error |

# Caveat-ID literal protocol

Where the brief specifies a caveat ID (e.g., `f1_visa`, `internal_transfer_gpa_note`), the test uses a **substring predicate** rather than equality, because the architecture document is silent on the canonical IDs and the engine's source-of-truth must be discovered at runtime. The brief's literals are used as predicted defaults; if the engine names them differently, the test still passes if the literal it does emit covers the expected concept (substring of `"f1"|"visa"` for Scenario 2; substring of `"transfer"` plus `"gpa"|"published"` for Scenario 3, OR the canonical `internal_transfer_gpa_note`). This avoids over-fitting and keeps the assertions bulletin-supportable rather than implementation-fitted.
