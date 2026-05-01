# @nyupath/engine

Core deterministic engine for NYU Path: degree audit, semester planner, prereq graph, equivalence resolver, school configs, RAG corpus, response validator, and the agent loop. Consumed by `apps/web` and `apps/cli`.

## Architecture at a glance

```
                               +------------------+
   /api/onboard upload ──►     │ DPR parser       │ ──► DegreeProgressReport
                               │ (no LLM)         │
                               +------------------+
                                       │
                                       ▼
   /api/chat/v2 ──► ToolSession ──► Agent loop ──► Tool calls ──► Reply
                       │                   ▲                          ▲
                       │                   │                          │
                       │              +─────────+                +────────────────+
                       │              │ Tools   │                │ Response       │
                       │              │ (12)    │                │ validator      │
                       │              +─────────+                │ (Cardinal §2.1)│
                       │                                         +────────────────+
                       │
              ┌────────┼────────┬─────────────┬──────────────┐
              │        │        │             │              │
              ▼        ▼        ▼             ▼              ▼
         student   degreeProgressReport   rag    searchCoursesFn   profileStore
         (profile)   (Phase 7-E pivot)   (corpus)
```

Every numerical claim the agent surfaces traces to a tool result — never LLM inference.

## Phase 7-E doctrine: DPR-first, deterministic engine as fallback

The post-pivot system has two parallel sources of audit truth:

1. **DPR primary path**: `session.degreeProgressReport` is NYU's pre-computed audit, ingested from an Albert Degree Progress Report PDF. The DPR carries every requirement's status, applied courses, GPA, credits, P/F + outside-CAS budget tracking, and time-limit data. The engine reads this object directly; no rule walking, no equivalence resolution, no GPA recomputation.

2. **Authored-rules fallback**: when no DPR is loaded, the engine runs `degreeAudit()` against authored `Program` JSON files (e.g., [data/programs/cas/cas_econ_ba.json](../../data/programs/cas/cas_econ_ba.json)). This path uses the full deterministic stack: `evaluateRule` over the four rule types (`must_take`, `choose_n`, `min_credits`, `min_level`), `equivalenceResolver` for AP/IB/transfer credits, `creditCapValidator` for school caps, `gpaCalculator` for pool-restricted GPAs, `passfailGuard`, etc.

**The fallback is not dead code.** It exists for three reasons:

- **What-if backend**: `what_if_audit` extracts (or will extract — see W3.3 P2) a `Program` spec on-the-fly from bulletin chunks for hypothetical programs the student is considering, then runs the deterministic engine against it.
- **DPR-failure fallback**: when a student's DPR is unavailable or malformed, onboarding routes them through the legacy transcript path, which produces a `StudentProfile` consumed by the same engine.
- **Future independent operation**: a long-term goal is for NYU Path to operate without Albert PDF input (e.g., for prospective students researching majors). The engine + the small set of authored T1/T2 programs + the JIT extraction pipeline form the basis for that mode.

## Tool routing under W3

The three audit-class tools dispatch on `session.degreeProgressReport`:

| Tool | DPR present | DPR absent |
|---|---|---|
| `run_full_audit` | `dprToAuditResults(dpr)` + StandingResult synthesized from `cumulative` block | `degreeAudit(student, program, courses, schoolConfig)` |
| `plan_semester` | Walks `notSatisfiedRequirements(dpr)`, extracts course IDs from descriptions, emits `CourseSuggestion[]` with optional prereq-risk flags | `planNextSemester(student, program, courses, prereqs, opts)` |
| `what_if_audit` (in catalog) | Authored path (same engine call) | Authored path (same engine call) |
| `what_if_audit` (not in catalog) | Returns `kind: "unauthored_program_estimate"` envelope with non-removable disclaimer | Same |

Output shape stays consistent across paths so downstream consumers (the response validator, the chat layer's renderer, eval cases) don't fork.

## DPR module

[src/dpr/](src/dpr/) holds:

- `schema.ts` — Zod-validated `DegreeProgressReport` shape (header, programs, advisor notations, cumulative block, recursive RG → R requirement tree, course history) with helpers (`walkRequirements`, `notSatisfiedRequirements`, `findRequirementById`).
- `parser.ts` — pure regex/walker over text extracted from the Oracle Analytics Publisher PDF. No LLM calls. Normalizes pypdf's U+0387 marker, strips HTML anchors, handles 3-line wrapped course titles, captures `Repeat Code` + `Course Topic` continuation lines, derives `cumulative` metrics from R1001/10, R1001/20, R1001/35, R1680/10, R1680/30, R1680/60.
- `dprToAuditResult.ts` — adapter that converts a parsed DPR into the legacy `AuditResult[]` shape. One AuditResult per declared program; preserves Cardinal Rule §2.1.
- `index.ts` — barrel exports.

The PDF→text wrapper (using `unpdf`) lives in [apps/web/app/api/onboard/route.ts](../../apps/web/app/api/onboard/route.ts) so the engine package itself stays free of PDF-specific dependencies.

## Cardinal Rule §2.1 in code

The agent's response validator ([src/agent/responseValidator.ts](src/agent/responseValidator.ts)) enforces four checks:

1. **Grounding** — every numeric claim in the reply must appear verbatim in some tool result this turn.
2. **Invocation** — claims that require a tool call (e.g., "your GPA is X") must have an actual invocation.
3. **Completeness** — required caveats (F-1 visa, low-RAG-confidence, internal-transfer GPA, online-for-major, what-if disclaimers) must appear when their trigger conditions fire.
4. **Verbatim drift** — when a tool returns `verbatimText` (semi-hardened tools), the reply must include it unchanged. This is what makes the W3.3 disclaimer non-removable.

The rule survives the W3 pivot because:
- DPR fields ARE deterministic tool results (the parser is regex-driven, not LLM-driven).
- The DPR-derived `dprToAuditResults` adapter is a pure transformation.
- The `extractVerbatim` callbacks for `run_full_audit` (GPA) and `what_if_audit` (disclaimer for unauthored estimates) tag their semi-hardened outputs so the validator can enforce them.

## Loop architecture (Phase 7-B Steps 14-20)

The agent loop ([src/agent/agentLoop.ts](src/agent/agentLoop.ts)) implements seven architecture-compliance gaps:

- **State.transition tracking** — every loop iteration emits a `transition` event tagged with reason (`next_turn` | `validation_retry` | `tool_results_compacted` | `session_compacted` | etc.).
- **MAX_TOOL_RESULT_BUDGET** — tool messages older than the 2-most-recent get truncated when the aggregate exceeds 32k chars.
- **Tier-2 conversation auto-compaction** — at ≥80% context pressure, the fallback client summarizes the prefix; the loop swaps in the summary as a system message.
- **Tier-3 graceful termination** — at ≥95%, the loop returns `kind: "context_limit"` with a polite "start a new chat" reply.
- **Validator replay (limit=1)** — the loop calls `validateResponse` on every final reply; on rejection, appends a system message describing the violations and re-runs once.
- **Output-truncation recovery** — when `finishReason === "length"`, the loop doubles `max_tokens` (cap 16k) and re-prompts up to 3 times.
- **Reactive compact** — when the model errors with `context_length_exceeded`, the loop fires Tier-2 compaction once and retries primary.

## Tests

700+ deterministic tests across `tests/eval/`. Highlights:

- `dprParser.test.ts` (21) + `dprToAuditResult.test.ts` (8) — DPR parsing + adapter
- `w3DprToolPaths.test.ts` (13) — DPR-driven tool integration
- `phase4.test.ts` (drift guard) — every quoted bulletin sentence in a policy template must appear verbatim in the source markdown
- `responseValidator` tests — Cardinal Rule §2.1 enforcement
- `loopState.test.ts` + `architectureGapsLoop.test.ts` — Steps 14-20 compliance

Run: `cd /Users/edoardomongardi/Desktop/Ideas/NYU\ Path && npx vitest run`

## Files most likely to evolve

- [src/dpr/parser.ts](src/dpr/parser.ts) — when NYU IT updates Albert's DPR layout (typically annually). Drift-guard test in `dprParser.test.ts` catches silent format changes.
- [src/agent/tools/whatIfAudit.ts](src/agent/tools/whatIfAudit.ts) — when the W3.3 P2 ships LLM-driven JIT bulletin extraction.
- [src/agent/tools/planSemester.ts](src/agent/tools/planSemester.ts) — when FOSE availability gets wired into the DPR plan path (W3.2 P2).

## Files that should rarely change

- [src/audit/degreeAudit.ts](src/audit/degreeAudit.ts) and the rule evaluators — battle-tested deterministic engine; serves as what-if backend + DPR fallback.
- [src/agent/responseValidator.ts](src/agent/responseValidator.ts) — Cardinal Rule §2.1 implementation.
- [src/agent/loopState.ts](src/agent/loopState.ts) — Steps 14-20 architecture-compliance state machine.
