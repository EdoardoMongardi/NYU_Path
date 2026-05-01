# Phase 10 — Architectural Reset: Posture-Driven Agent

**Status:** Planned · 2026-04-29
**Owner:** edoardo (with Claude)
**Scope:** Refactor the agent's three-layer contract (data / tools / system prompt) so that policy questions are answered correctly **in general**, not via per-case rules.
**Predecessor:** Phase 9.5 (commit `9aa41786`) closed three specific bugs by stapling rules onto the system prompt and tool descriptions. Operator review correctly identified this as O(N) tech debt.
**Success criterion:** Phase 10 lands an architecture where adding a new policy or course-range mapping requires **zero changes to the system prompt** and zero changes to a tool description. Verified by replaying the original 16-issue audit + 10 unseen edge cases against the new architecture.

---

## 0. Why this phase exists (the architectural diagnosis)

Two parallel audits ran on 2026-04-29:
1. **claude-code-leak deep dive** — how a state-of-the-art agent (Claude Code CLI) avoids stapling rules. Findings in §0.1.
2. **Our anti-pattern forensic catalog** — every "ALWAYS do X when Y" rule, lookup table, and per-case exception currently in our codebase. Findings in §0.2.

### 0.1 What Claude Code does (summary of audit)

| Layer | Claude Code's pattern | What we copy |
|---|---|---|
| **System prompt** | ~90% posture/principle, ~10% implementation. Reversibility, faithful reporting, "you're a collaborator," `report outcomes faithfully`. **Zero** "if user asks X, do Y" lists. | Strip all per-case rules; keep posture only. |
| **Tool descriptions** | Abstract contracts. State *what the tool does + when to prefer it + when not to use it*. Bash description includes git-safety **protocol** (general steps), not git-edge-case list. | Rewrite our descriptions as contracts. |
| **Tool returns** | Pure data. Bash returns stdout/stderr/exit. Edit returns success/failure. The system prompt does the reasoning about what to do with the result. | Tool returns become **structured envelopes** that *carry their own context flags* (disclaimers, follow-up suggestions, anchors) so the agent renders them by posture, not by per-case prose rules. **This is our key inversion.** |
| **Multi-step enforcement** | TodoWrite + Verification sub-agent. Both teach *philosophy* (completeness is adversarial, not confirmatory) + *enforce structure* (no PASS without command output). | Add a "completeness reviewer" sub-agent variant in the bake-off (§4 Method B). |
| **Sub-agents** | Briefed like colleagues, not handed off. "Never delegate understanding." | Already aligned — no change. |

**The single most important pattern from Claude Code:** *the prompt teaches philosophy; the tool result format enforces it.* The Verification agent's "no PASS without a Command run block" rule is structural, not prose. We can apply the same pattern: when a tool result includes a `disclaimer` field, the agent must surface it; structurally, the system prompt only needs **one** posture rule about that, not N case-rules.

### 0.2 Our current anti-patterns (forensic count)

| Category | Count | Worst offender |
|---|---:|---|
| Hardcoded edge cases | 8 | DPR-loaded state machine duplicated in system prompt + 3 tool validators |
| Lookup tables in prose | 4 | CORE-UA range mapping (lives in 2 files) |
| "ALWAYS do X" rules | 7 | Major-requirement disclaimer (lives in 2 files, slight wording drift) |
| Posture rules (good) | 3 | DPR-loaded result-shape adaptation in `runFullAudit` |

**Top-5 worst by maintenance cost:**
1. Major-requirement grade disclaimer — duplicated `systemPrompt.ts` lines 125–136 + `runFullAudit.ts` lines 108–118 (different wording).
2. Generic-DPR-text → search_policy mandatory follow-up — duplicated `systemPrompt.ts` lines 138–156 + `runFullAudit.ts` lines 98–107.
3. CORE-UA range mapping — duplicated `searchPolicy.ts` lines 51–61 + `systemPrompt.ts` lines 153–156.
4. DPR-loaded routing — enforced in 5+ places (system prompt + 3 tool validators + `runFullAudit` body).
5. School/suffix classification — hardcoded maps in `searchCourses.ts` lines 48–82.

### 0.3 Root-cause statement

We have been adding rules where we should have been adding **fields to tool results**. Every "ALWAYS append disclaimer X when responding to question type Y" should be:
- Tool result includes `disclaimers: [{ text: "...", reason: "..." }]` when applicable.
- System prompt has **one** posture rule: *"When a tool result includes a `disclaimers` array, you MUST surface each disclaimer verbatim in your reply."*

This collapses 7 case-rules into 1 posture rule, and any new disclaimer (a new bulletin policy, a new edge case) becomes a data change in the tool — **not a prompt change**.

The same pattern applies to:
- Suggested follow-ups (`suggestedFollowUps: [{ tool, args, why }]`)
- Bulletin anchors (`anchors: [{ source, quote, relevance }]`)
- Confidence bounds (`confidence: "high" | "medium" | "low" | "uncertain"`)
- CORE-UA mapping → not a prompt rule, just a fact that `search_policy` returns when the query matches.

---

## 1. The three-layer architecture (target state)

```
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 1 — DATA                                                  │
│ Facts live in data files / RAG corpus / school config.         │
│ NO facts in prose. NO lookup tables in tool descriptions.      │
│   • CORE-UA range mapping → facts/coreUaRanges.json            │
│   • School-suffix mapping → schools.config.ts                  │
│   • F-1 floor, OGS, FOSE encoding → schools.config.ts          │
│   • Major grade rules, P/F-for-major → bulletin chunks (RAG)   │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 2 — TOOLS (self-completing contracts)                    │
│ Tool RESULT envelope (every tool returns this shape):          │
│   {                                                             │
│     data: <tool-specific>,                                      │
│     disclaimers: Disclaimer[],         ← carries grade/PF rules│
│     suggestedFollowUps: FollowUp[],    ← carries chaining hint │
│     anchors: BulletinAnchor[],         ← carries sample-plan   │
│     confidence: "high"|"medium"|"low"|"uncertain",             │
│     verbatim: string | null,           ← Cardinal Rule §2.1    │
│   }                                                             │
│ Tool DESCRIPTION = contract (what it does, when to prefer it). │
│ Tool VALIDATOR = enforces routing (already done partially).    │
│ NO "ALWAYS do X" prose in tool descriptions.                   │
└─────────────────────────────────────────────────────────────────┘
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│ LAYER 3 — SYSTEM PROMPT (pure posture)                         │
│ ~120 lines (down from ~280). Sections:                         │
│   1. Identity + role (advisor, not registrar)                  │
│   2. Cardinal rule §2.1 (cite tool results, never invent)      │
│   3. Tool-result rendering posture:                            │
│      • Surface disclaimers verbatim                            │
│      • Surface anchors with their bulletin source              │
│      • Suggest follow-ups when result includes them            │
│      • Render confidence bounds honestly                       │
│   4. Uncertainty posture (defer to adviser when low confidence)│
│   5. Communication style (concise, student-facing tone)        │
│   6. Refusal cascade (out-of-scope, multi-school, future-time) │
│ NO per-case rules. NO "if user asks about X, do Y."            │
└─────────────────────────────────────────────────────────────────┘
```

**The key inversion**: rules currently in the system prompt move to tool result fields; the system prompt collapses to a small set of posture rules about *how to render any tool result*.

---

## 2. Detailed work plan

### Stage 1 — Architectural inventory & test bench (½ day)

**Goal:** before touching code, lock in a regression suite that catches drift.

1.1 **Lock the failing-cases corpus.** Snapshot the original 16-issue conversation (already on disk) + 10 NEW edge cases the system has not seen, e.g.:
   - "Does CORE-UA 800 count for Societies?" (range mapping, unseen number)
   - "Can I use P/F for my CS minor?" (NEW: minor, not major)
   - "Does the 32-credit residency rule apply to my Stern internal-transfer?" (NEW: cross-school)
   - "What's the bulletin's recommended semester for CSCI-UA 480?" (sample-plan)
   - "Does PHIL-UA 5 count for Societies and Social Sciences?" (PHIL wildcard exclusion + range)
   - "Can I take MATH-UA 120 if I already have AP Calc credit?" (transfer credit + prereq)
   - "Is 22 credits in one semester allowed?" (overload, not yet tested)
   - "Does the bulletin allow me to declare a third minor?" (declaration policy)
   - "What grade do I need in MATH-UA 121 for the Math major?" (grade rule, NEW major)
   - "If I take CSCI-UA 480 P/F, does it satisfy the upper-division CS elective?" (composition: PF rule + elective rule)

   Store in `evals/cohorts/phase10_edgeCases.ts`.

1.2 **Baseline measurement.** Run all 26 cases (16 + 10) against current (Phase 9.5) architecture on `claude-haiku-4-5`. Auto-grade + LLM-judge. Record baseline scores. Commit JSON to `evals/results/phase10_baseline.json`.

1.3 **Define pass thresholds.** A case passes if:
   - LLM-judge "correct" verdict: required.
   - Auto-graded "verbatim_drift" violations: 0.
   - Cardinal-rule (numbers from tool, not training data): 0 violations.
   - No hallucinated bulletin policy: 0 violations.

**Deliverable:** `evals/cohorts/phase10_edgeCases.ts` + `evals/results/phase10_baseline.json` + a green/red checklist of the 26 cases on the current architecture.

---

### Stage 2 — Move data out of prose (1 day)

**Goal:** every fact currently in a system-prompt or tool-description string moves to data.

2.1 **CORE-UA range mapping** → `packages/engine/src/data/coreUaRanges.ts`:
   ```ts
   export const CORE_UA_RANGES = [
     { lo: 400, hi: 499, requirement: "Texts and Ideas",
       bulletinSource: "bulletin/cas/college-core-curriculum#texts-and-ideas" },
     { lo: 500, hi: 599, requirement: "Cultures and Contexts", ... },
     { lo: 700, hi: 799, requirement: "Expressive Culture", ... },
     { lo: 800, hi: 899, requirement: "Societies and the Social Sciences", ... },
   ];
   export function classifyCoreUa(catalogNbr: string): { requirement: string; source: string } | null { ... }
   ```
   Wire into `searchPolicy` so when the query mentions any CORE-UA NNN, the result deterministically includes a `coreUaClassification` field. The agent then surfaces it because of posture rule §3 (render tool data faithfully). **No prompt rule needed.**

2.2 **School-suffix mapping** → already in `packages/engine/src/data/schools.config.ts`, but extracted from `searchCourses.ts`. Refactor `searchCourses` to read from the config; remove the inline `SUFFIX_META` and `HOME_SCHOOL_TO_SUFFIX`.

2.3 **F-1 floor, full-time minimum, semester ceiling** → consolidate into `schools.config.ts` per school. Delete the magic constant `F1_FULLTIME_MIN_CREDITS = 12` from `getCreditCaps.ts`.

2.4 **FOSE term-code encoding** → already a function in `searchAvailability.ts`, but undocumented. Move to `packages/engine/src/data/foseTerm.ts` with a unit test demonstrating the rule, and link the test in the doc comment. **No prose memorization needed** — the function IS the source of truth.

2.5 **Major grade rules + P/F-for-major** → these are bulletin facts, not magic strings. Verify the relevant bulletin chunks are indexed in the RAG corpus with `category: "academic_policy"` and tagged so `search_policy` retrieves them when the query touches a major requirement. If chunks are missing, add scrape entries to `data/bulletin-raw/cas/policies/`.

**Deliverable:**
- 4 new data files (`coreUaRanges.ts`, updated `schools.config.ts`, `foseTerm.ts` + test).
- 4 prose lookup tables deleted from `searchPolicy.ts`, `searchCourses.ts`, `getCreditCaps.ts`, `searchAvailability.ts`.
- RAG index re-built with `tools/policy-corpus-embed/`.
- Unit tests proving each data source is the single source of truth (`grep -r "CORE-UA 4XX" packages/engine/src/agent/` returns 0).

---

### Stage 3 — Tool result envelope (1.5 days)

**Goal:** every tool returns a structured envelope. Tool descriptions become contracts.

3.1 **Define the envelope schema** in `packages/engine/src/agent/toolEnvelope.ts`:
   ```ts
   export interface Disclaimer {
     id: string;                    // stable id for dedup
     text: string;                  // verbatim text the agent must surface
     reason: string;                // why this disclaimer applies (for LLM context)
     bulletinSource?: string;       // citation
   }
   export interface SuggestedFollowUp {
     tool: string;                  // e.g., "search_policy"
     args: Record<string, unknown>; // ready-to-call args
     why: string;                   // reason to call (for LLM context)
   }
   export interface BulletinAnchor {
     source: string;                // e.g., "Math/CS BA sample plan of study, semester 7"
     quote: string;                 // verbatim quote, ≤200 chars
     relevance: string;             // why surfaced
   }
   export interface ToolEnvelope<TData> {
     data: TData;
     disclaimers: Disclaimer[];
     suggestedFollowUps: SuggestedFollowUp[];
     anchors: BulletinAnchor[];
     confidence: "high" | "medium" | "low" | "uncertain";
     verbatim: string | null;       // Cardinal Rule §2.1 anchor
   }
   ```

3.2 **Refactor each tool to return the envelope.** Order of refactor (highest-leverage first):
   - `runFullAudit` — emits `disclaimers` for major requirements (rule moved out of system prompt §5b), emits `suggestedFollowUps` when DPR text is generic (rule moved out of system prompt §6).
   - `searchPolicy` — emits `coreUaClassification` as a disclaimer-equivalent when query matches a CORE-UA range; emits `anchors` with the bulletin source.
   - `planSemester` — emits `anchors` from the bulletin sample-plan (sample-plan rule moved out of `planSemester` description).
   - `getCreditCaps`, `getAcademicStanding`, `searchCourses`, `searchAvailability`, `whatIfAudit`, `checkOverlap`, `checkTransferEligibility`, `whoAmI`, `updateProfile` — adapt envelope; mostly just wrap existing returns.

3.3 **Rewrite tool descriptions as contracts.** For each tool, the description after rewrite must:
   - Describe what the tool does in 2–4 sentences.
   - Describe what kind of question it answers.
   - Describe when NOT to use it (delegation hint).
   - **Omit:** any "ALWAYS / NEVER / MANDATORY" rule. Any lookup table. Any per-case exception.

   Example before/after for `searchPolicy`:
   - **Before:** ~150 lines including CORE-UA range mapping, mandatory follow-up clause, "NEVER guess the mapping the other way," etc.
   - **After:** ~30 lines: contract, when to prefer, when not to use, a note that the result envelope carries any applicable disclaimers/anchors.

3.4 **Tool description test.** Add a regression test that fails if any tool description contains `ALWAYS`, `NEVER`, `MANDATORY`, or a string matching `CORE-UA \d`. (Surface bar to make slipping into the anti-pattern uncomfortable.)

**Deliverable:**
- New `toolEnvelope.ts`.
- 12 tool refactors (each returns the envelope).
- 12 tool description rewrites (~150 lines deleted, ~30 lines added per tool on average).
- New regression test enforcing description hygiene.

---

### Stage 4 — System-prompt rewrite + 3-architecture bake-off (2 days)

**This is where I'm genuinely uncertain which composition pattern wins.** Per the operator's instruction ("if you are not sure which pattern can actually resolve, don't guess, just try and test multiple methods"), Stage 4 runs three candidate architectures in parallel and picks the winner empirically.

4.1 **Common base.** All three methods share Stages 1–3 (data extraction + envelope). They differ only in how Layer 3 (system prompt + composition) is structured.

4.2 **Method A — Pure posture system prompt.**
   - System prompt rewritten to ~120 lines of posture only.
   - Single agent loop, no sub-agents.
   - Posture rules:
     1. Cardinal Rule §2.1 (numbers from tool results, never training data).
     2. **Render tool envelopes faithfully:** when a tool returns `disclaimers`, surface each verbatim. When it returns `anchors`, cite the source. When it returns `suggestedFollowUps` and the question is unanswered, call them.
     3. Uncertainty posture: when `confidence === "uncertain"`, say so + recommend adviser.
     4. Refusal cascade (out-of-scope, future-time, multi-school).
     5. Style: concise, student-facing.
   - Tool descriptions are abstract contracts.

4.3 **Method B — Posture + completeness reviewer sub-agent.**
   - Same as Method A.
   - Plus: after the main agent drafts a reply, a `completeness_reviewer` sub-agent runs adversarially: "given the tool results in this turn, did the draft surface all disclaimers, all anchors, all uncertainty bounds? Return a structured PASS/FAIL with reasons."
   - On FAIL, the main agent gets ONE retry with the reviewer's feedback as a system message.
   - Inspired by Claude Code's verification agent (philosophy: "your job is to break it, not confirm it").

4.4 **Method C — Posture + answer-composer sub-agent.**
   - Main agent only orchestrates tool calls.
   - All tool results go to an `answer_composer` sub-agent whose sole job is rendering the final reply from the structured envelopes.
   - The composer's prompt is even simpler: "Given these tool envelopes, write a concise student-facing reply. Surface every disclaimer, every anchor, every uncertainty. Cite numbers verbatim from the envelope's `verbatim` field."
   - Trade-off: extra latency + cost. Benefit: separation of concerns; the orchestrator never sees student text, the composer never sees tool selection.

4.5 **Bake-off harness** (`tools/cohort-eval/runBakeoffPhase10.ts`):
   - Same 26 cases from Stage 1.
   - Run each case against each of {A, B, C, current Phase 9.5 baseline}.
   - Same auto-grader + LLM-judge.
   - Output: `evals/results/phase10_bakeoff.json` + a markdown summary with PASS/FAIL grid.

4.6 **Decision criteria.**
   - **Primary:** % of cases passing (must beat baseline by ≥15pp; an architectural rewrite that ties baseline is not worth the churn).
   - **Secondary:** generalization to the 10 unseen cases (must pass ≥80%).
   - **Tertiary:** latency + cost (Method C will be slowest; only acceptable if it wins primary by ≥10pp).
   - **Tie-breaker:** maintainability — Method A wins on architectural simplicity if scores are within 5pp.

4.7 **Decision point** — operator review the bake-off matrix and pick the winner. If A wins or ties, ship A. If B/C wins by ≥10pp, ship that one. If none beats baseline, **stop and re-examine the diagnosis** — do not ship a regression.

**Deliverable:**
- 3 system-prompt files (`systemPrompt_A.ts`, `systemPrompt_B.ts`, `systemPrompt_C.ts`).
- For B and C: the sub-agent prompts + their wiring in the agent loop.
- Bake-off harness + results JSON + markdown summary.
- Operator decision recorded in this plan.

---

### Stage 5 — Replay + generalization test (½ day)

**Goal:** verify the winner is *architectural*, not just lucky on the 26 cases.

5.1 **Replay the original 16-issue conversation** turn-by-turn against the winning architecture. All 16 issues must be addressed by **emergent** agent behavior (envelope rendering + posture), not by any rule we wrote with the issue in mind. Document each: "Issue #N resolved by: [data file / envelope field / posture rule]".

5.2 **5 fresh adversarial cases** — generated AFTER Stage 4 settled, by a separate Claude session that doesn't know which cases were in the bake-off. These probe corner cases:
   - "I'm a CGA-UA student, does my requirement work like CAS?" (NEW prefix, new school)
   - "What does the bulletin say about CORE-UA 999?" (out-of-range; should defer)
   - "Is there a way to use P/F for the CAS expository writing requirement?" (composition: P/F + non-major requirement)
   - "What if I take CSCI-UA 480 twice?" (repeat-course policy)
   - "Does my dual-degree status change my credit cap?" (NEW status, dual-degree)

5.3 **Run them.** All 5 must pass without prompt edits. If any fails, diagnose: is the failure a missing data file (fixable in Layer 1), a missing envelope field (fixable in Layer 2), or a posture gap (fixable in Layer 3)? Fix the right layer. Re-run. The system prompt should remain ≤120 lines.

**Deliverable:**
- `evals/results/phase10_replay.md` — 16 issues + 5 adversarial cases, each with verdict + which layer resolved it.
- If 21/21 pass without system-prompt edits, Phase 10 is complete.

---

### Stage 6 — Cleanup & ship (½ day)

6.1 Delete the losing 2 system-prompt files. Delete dead helper code from Phase 9.5 (the disclaimers that are now data).

6.2 Update `ARCHITECTURE.md` with the three-layer diagram + the inversion principle. Update `MEMORY.md` (auto-memory) with the "data → envelope → posture" rule so I don't backslide.

6.3 Run full test suite (`pnpm test`). All 762+ tests must still pass. New tests for envelope schema + tool description hygiene must pass.

6.4 Commit: `phase 10 — posture-driven agent architecture (data → envelope → posture)`. Body lists the count: "X lookup tables removed, Y 'ALWAYS' rules deleted, system prompt N → 120 lines, all 21 evals pass."

6.5 Update `MEMORY.md` Phase 10 status entry.

**Deliverable:** clean commit + memory updated + ARCHITECTURE.md updated.

---

## 3. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The envelope refactor breaks 12 tools' existing tests | High | Medium | Refactor one tool at a time; keep tests green per-tool. |
| Tool descriptions get longer than before despite "contract only" goal | Medium | Low | Stage 3.4 regression test enforces hygiene; reviewer agent in CI later. |
| Method A (no sub-agent) doesn't beat baseline | Medium | Medium | Methods B and C are the contingency; bake-off is designed to fail safely. |
| All 3 methods fail to beat baseline | Low | High | Stop and re-examine diagnosis. May indicate the LLM is the bottleneck, not the architecture. |
| Adding `disclaimers` array makes responses verbose / robotic | Medium | Medium | LLM-judge in bake-off catches this; if scores drop on conciseness, adjust posture rule §5 (style). |
| RAG misses major-grade-rule chunks despite Stage 2.5 | Medium | High | Stage 2.5 explicitly verifies retrieval; if chunks missing, add scrape entries before Stage 3. |
| Operator wants to ship sooner than Stage 4 finishes | Low | Medium | Stages 1–3 are independently shippable as a partial improvement; bake-off can be a fast-follow. |
| Method C (composer) slows responses past acceptable latency | High | Medium | Stage 4.6 tertiary criterion already accounts for this. |

---

## 4. Cost & timing estimate

- Engineer time: ~5 days of focused work.
- API cost: bake-off runs 26 cases × 3 methods × 2 grading passes = ~$15 on `claude-haiku-4-5`; replay + adversarial = ~$5. Total ≈ **$20**.
- Risk-adjusted: budget 7 days + $30 to absorb Stage 4 iteration.

---

## 5. Decision log

| Date | Decision | By | Rationale |
|---|---|---|---|
| 2026-04-29 | Run 3-architecture bake-off rather than committing to one | Operator instruction | "If not sure which pattern can resolve, try and test multiple methods or combine them." |
| 2026-04-29 | Move CORE-UA mapping to data file, not RAG-only | Plan | RAG retrieval is probabilistic; for a closed deterministic mapping, a data file is more reliable. RAG still surfaces the bulletin source for citation. |
| 2026-04-29 | Disclaimers as tool-result fields, not prompt rules | Plan + Claude Code audit | Claude Code's verification agent uses structural enforcement ("no PASS without command output"); we apply the same pattern to disclaimers. |
| (open) | Pick winner of Method A/B/C | Operator after Stage 4 | Empirical bake-off result. |

---

## 6. Out of scope (deferred)

- Rewriting the conversation-eval runner to support sub-agent traces (Method B/C will produce more spans; current viewer may need an update — defer to Phase 11 if Method B or C wins).
- Replacing the FOSE term encoding with a date-aware function (current is calendar-derived; envelope already carries the right term — no agent-visible change needed).
- Cohort A launch prep (Resend domain verification, Vercel deploy) — same as before, Phase 10 is a prerequisite improvement.

---

## 7. Acceptance checklist

- [ ] Stage 1 baseline measured and committed (`evals/results/phase10_baseline.json`).
- [ ] Stage 2: 4 lookup tables in prose deleted; 4 data sources of truth landed; `grep` shows zero duplication.
- [ ] Stage 3: 12 tools return `ToolEnvelope`; 12 tool descriptions rewritten as contracts (avg ≤30 lines each); description-hygiene regression test passes.
- [ ] Stage 4: 3 system prompts written; bake-off matrix produced; operator picks winner.
- [ ] Stage 5: 16 original + 5 adversarial cases all pass under the winning architecture, with each issue traced to data/envelope/posture (NOT a prompt rule).
- [ ] Stage 6: losing prompts deleted; ARCHITECTURE.md + MEMORY.md updated; commit landed; full test suite green.

---

## 8. The one-line summary I want to be able to write at the end

> "After Phase 10, adding a new bulletin policy is a data change, not a prompt change. The agent answers correctly because the architecture forces correctness, not because we wrote the answer in advance."
