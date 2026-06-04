# @nyupath/engine

Core engine for NYU Path: DPR parser + audit adapter, forward-schedule solver, prereq graph, equivalence resolver, school configs, RAG corpus, response validator, and the agent loop. Consumed by `apps/web`.

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

## DPR-first / two-tier doctrine

After the rule-engine decommission, the engine has two sources of truth:

1. **Tier 1 — DPR (deterministic)**: `session.degreeProgressReport` is NYU's pre-computed audit, ingested from an Albert Degree Progress Report PDF. It carries every requirement's status, applied courses, GPA, credits, P/F + outside-home budget tracking, and time-limit data. `run_full_audit` reads this directly; `plan_forward_degree` consumes `dpr.requirementGroups` to build the solver's unmet-requirements set. No authored rule walking, no on-disk program JSON, no GPA recomputation.

2. **Tier 2 — bulletin RAG (estimates)**: `search_policy`, `get_program_requirements`, and `what_if_audit` answer hypothetical/program-shape questions from the embedded NYU bulletin corpus. Responses are confidence-banded, cited, and carry an adviser caveat — they are estimates, never audit-grade verdicts.

The legacy "authored-rules fallback" (`degreeAudit`, `evaluateRule`, `crossProgramAudit`, the engine `whatIfAudit`, the planner library, `programs.json`) has been removed. The DPR + RAG are the only paths.

## Audit-class tool surface

| Tool | Source | Output |
|---|---|---|
| `run_full_audit` | DPR | `dprToAuditResults(dpr)` + StandingResult synthesized from `cumulative` block |
| `plan_forward_degree` | DPR + `schoolConfig` | `solveForwardSchedule` over the DPR's unmet requirements + prereq map |
| `what_if_audit` | DPR + RAG | `unauthored_program_estimate` envelope with non-removable disclaimer; the LLM follows up via `search_policy` |
| `search_policy` / `get_program_requirements` | RAG | Confidence-banded, cited bulletin excerpts |

Output shape stays consistent across tools so downstream consumers (the response validator, the chat layer's renderer, eval cases) don't fork.

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
- [src/agent/forwardSchedule/solver.ts](src/agent/forwardSchedule/solver.ts) — when the forward-schedule heuristics evolve.
- [src/rag/](src/rag/) — when the bulletin corpus, embedder, or reranker changes.

## Files that should rarely change

- [src/agent/responseValidator.ts](src/agent/responseValidator.ts) — Cardinal Rule §2.1 implementation.
- [src/agent/loopState.ts](src/agent/loopState.ts) — Steps 14-20 architecture-compliance state machine.
