# NYU Path — Model Selection & Cohort A Composite Measurement

> **Phase 8 B5 update — 2026-04-28:** Production primary swapped to **`anthropic:claude-haiku-4-5-20251001`** based on the Phase-8 25-question bake-off (post-architectural-cleanup). Fallback stays `openai:gpt-4.1-mini`. Full bake-off comparison at [tools/cohort-eval/results/bakeoff_phase8_summary.md](tools/cohort-eval/results/bakeoff_phase8_summary.md). See "Phase 8 bake-off" section below.

> **Phase 7-E W8 update — 2026-04-28:** Cohort A surrogate composite **0.936**, §12.6.5 0.90 gate **PASSED** (surrogate, upper-bound). See "Phase 7-E W8" section below. The Phase-5-prep bakeoff content from 2026-04-26 is preserved for archival reference; W9 (re-validation against the 84-case bakeoff post-DPR-pivot) is pending.

---

## Phase 8 bake-off — claude-haiku-4-5 selected as primary

Run: `tools/cohort-eval/runBakeoffPhase8.ts` against the operator's real DPR (`SAA_STD_DS.pdf`), 25 questions covering AUDIT/PLAN/WHATIF/POLICY + 5 EDGE cases. Architecture: post-Phase-8 (Workstream A landed — preLoopDispatch demoted, system prompt trimmed, tool descriptions enriched, run_full_audit IP courses, search_courses excludeCompleted, exact-id catalog fast path).

| Model | Composite | Floor | Auto-pass | Median latency | 4-week pilot $ |
|---|---:|---:|---:|---:|---:|
| **claude-haiku-4-5** ✓ chosen | 4.42 | 2.25 | **92%** | 5.1s | $26 |
| claude-sonnet-4-6 | **4.54** | 2.25 | 88% | 14.9s | $79 |
| gpt-4.1-mini (prior primary) | 4.00 | 2.50 | 88% | **5.3s** | **$3** |
| gpt-4.1 | 3.95 | 1.75 | 88% | 21.5s | $46 |
| gpt-5 | 1.55 | 1.25 | 4% | 0.6s | $47 |

**Selection rationale:**
- claude-haiku-4-5 has the highest auto-pass rate (92% — every other model 88% or worse)
- Composite 4.42 is essentially tied with sonnet's 4.54 (Δ=0.12 within judge noise) at one third of sonnet's cost
- 5.1s median latency is essentially tied with the cheaper gpt-4.1-mini's 5.3s
- Wins Q18 ("P/F per semester") with composite 5.0 — the only model that correctly extracted "one P/F election per term" from the bulletin via `search_policy`. Every other model claimed no per-semester limit exists (a real bug)
- $26 for the 4-week pilot is comfortably affordable

**Fallback:** kept as `openai:gpt-4.1-mini` (the prior primary). Cheap, fast, decent quality. Fires when the primary errors mid-turn.

**gpt-5 deferred to Phase 9:** Catastrophic 1.55 composite + 4% auto-pass rate. Returns empty responses on most questions. Almost certainly a client-implementation issue — gpt-5 is a reasoning model that needs `reasoning_effort` parameter or the new Responses API; our `OpenAIEngineClient` sends standard chat completions. Not a model-quality verdict.

**Per-question matrix:** See [tools/cohort-eval/results/bakeoff_phase8_summary.md](tools/cohort-eval/results/bakeoff_phase8_summary.md). Three system-level gaps remain (every model scored low):
- Q14 (early graduation Fall 2026) — temporal reasoning still partial across all models
- Q15 (CSCI-UA 421 in summer) — sonnet wins (4.25); other models fall below 3.0
- Q18 (P/F per semester) — only haiku scored 5.0; should consider whether a dedicated `cas_pf_per_term` template is worth authoring

**Bake-off cost:** ~$8 in OpenAI + Anthropic tokens (5 models × 25 questions × ~3-15 tool round-trips each + judge).

**Reproduce:**
```bash
set -a && source .env.local && set +a
npx tsx tools/cohort-eval/runBakeoffPhase8.ts \
    [--models gpt-4.1-mini,gpt-4.1,gpt-5,claude-sonnet-4-6,claude-haiku-4-5-20251001]
```

---

## Phase 7-E W8 — Cohort A surrogate measurement

**Headline: 0.936 composite, §12.6.5 0.90 gate PASS (surrogate, upper-bound).**

The surrogate composite is an *upper bound* per ARCHITECTURE.md §12.6.5 line 4134 — real students ask off-distribution questions the cohort doesn't cover, multi-intent follow-ups, and edge cases the persona surrogate can't simulate. A real-cohort composite of 0.85–0.92 is the realistic expectation given the 0.936 surrogate.

### Run metadata

- **Date**: 2026-04-28
- **Cohort version**: cohort_a frozen at sha256:a053d1c17e857a788d624ce2e1bb09175baa504f8fd7a3cc931f95c04b6a971d (65 cases: 10 legacy + 47 DPR-driven + 8 real-DPR-backed)
- **Agent model**: `openai:gpt-4.1-mini`
- **Persona model**: `anthropic:claude-haiku-4-5-20251001` (different family per LLM-as-judge best practice)
- **Run duration**: 322.9 s
- **API spend (estimated)**: ~$3 OpenAI + ~$1 Anthropic + ~$0.05 Cohere

### Per-dimension breakdown

| Dimension | Score |
|---|---|
| Grounding (numbers traced to tool results) | 0.968 |
| Completeness (required caveats present) | 0.853 |
| Uncertainty (hedges when unknown) | 0.987 |
| Non-fabrication (no synthesized data) | 1.000 |

Non-fabrication at 1.000 is the load-bearing result: across all 65 cases, the agent never invented a number that wasn't in some tool result. Cardinal Rule §2.1 holds end-to-end after the W3 pivot to DPR-primary tool routing.

### Per-domain composite

| Domain | n | mean composite |
|---|---|---|
| legacy-f1 | 1 | 0.688 |
| legacy-pf | 2 | 0.738 |
| whatif-minor | 4 | 0.781 |
| transfer | 3 | 0.850 |
| pf-outside-cas | 4 | 0.912 |
| whatif-major | 8 | 0.912 |
| real-DPR | 8 | 0.912 |
| plan-semester | 6 | 0.921 |
| audit-reads | 8 | 1.000 |
| remaining-reqs | 8 | 1.000 |
| policy-rag | 6 | 1.000 |
| legacy-cs / -transfer / -econ / -low-conf / -cardinal / -cross-school | 7 | 1.000 |

### Iteration history (caught + fixed in flight)

| Run | Change | Composite | Notes |
|---|---|---|---|
| 1–3 | n/a (broken) | 0.000 | Bug #1: Zod-v4 schema converter; bug #2: discriminated-union root |
| 4 | Live cohort runs | **0.835** | Below 0.90; agent calls fallback tools that don't see DPR data |
| 5 | DPR-aware system prompt | **0.883** | Closer; but `run_full_audit` summary doesn't surface residency/P-F/outside-CAS budgets |
| 6 | Enrich `run_full_audit` output with `dprCumulative` + `dprUnsatisfiedRequirements` | **0.936** | **PASS** the 0.90 gate |

### Production-blocking bugs caught + fixed

1. **Zod-v4 schema converter** — pre-W8 used Zod-v3 pattern matching; v4 reorganized internals. Every tool's input schema collapsed to `{type:"object"}`, OpenAI rejected the entire tool list. Switched to Zod-v4 native `toJSONSchema()`. Never caught before W8 because all unit tests use `RecordingLLMClient` which doesn't validate schemas.

2. **Discriminated-union root** — `update_profile`'s `z.discriminatedUnion(...)` produces top-level `oneOf`. OpenAI's Functions API requires top-level `type: "object"`. Fixed by wrapping non-object root schemas in a permissive object envelope.

3. **DPR routing absent from system prompt** — agent didn't know `session.degreeProgressReport` existed and called `get_academic_standing` (which doesn't see the DPR) when asked about GPA. Returned "GPA 0.00." Fixed by adding `dprLoaded` flag to `buildSystemPrompt`.

4. **Audit output dropped DPR budget fields** — `run_full_audit`'s summary surfaced GPA + total credits but not residency / P-F / outside-CAS counters. Fixed by adding `dprCumulative` + `dprUnsatisfiedRequirements` to the audit output.

### Caveats

- Surrogate composite is an upper bound; real cohort A will likely score 0.85–0.92.
- The persona-surrogate (claude-haiku-4-5) is itself an LLM and biased toward producing well-formed user messages.
- The composite measures process correctness + Cardinal-Rule compliance, NOT advisor-truth. The DPR is the source of truth by design.

### Next gates

1. **W9 — Bakeoff** (pending, ~$10-15): re-validate `gpt-4.1-mini` against `gpt-4o-mini` / `claude-haiku-4-5` / `claude-sonnet-4-6` on 84 frozen cases.
2. **W10 — Pilot prep**: privacy posture, onboarding tutorial, persistent disclaimer banner, per-student rate limit, observability dashboard.
3. **W11 — Independent reviewer audit**.
4. **W12 — Auth activation** (BLOCKED on user provisioning Neon + Resend + SECRET_KEY).

---

## Phase-5-prep Bakeoff (archival, 2026-04-26)

**Run date:** 2026-04-26
**Posture:** Phase-5-prep bakeoff (Option A per ARCHITECTURE.md §12.6 row 5).
**Architecture spec:** §6.5.1 — composite AgentScore = `0.4·tsTool + 0.4·tsSynthesis + 0.2·tsDecomp`, gated at AgentScore ≥0.85, P50 latency ≤2500ms, within 5% of the top scorer.
**Eval-set:** independent agent-authored, bulletin-grounded (`evals/golden/`):
- 18 tool-selection cases — all 6 tools represented
- 18 synthesis cases — Cardinal Rules + F-1 caveat + cross-school override
- 10 decomposition cases — 2/3/4-part questions
- Provenance documented in `evals/golden/eval_set_provenance.md`
- Authored under relaxed minimums; Phase 5 proper must re-run with full §6.5.1 50/50/30 case counts before sealing the model choice.

## Result table

| Model              | AgentScore | TS-Tool | TS-Synth | TS-Decomp | P50 latency | Cost / 1k turns | Gate: ≥0.85 | Gate: ≤2500 ms | Within 5% of top |
| ------------------ | ---------: | ------: | -------: | --------: | ----------: | --------------: | ----------: | -------------: | ---------------: |
| Claude Opus 4.7    |  **0.868** |   0.861 |    0.808 |     1.000 |     5651 ms |       **$31.45** |     ✅ pass |       ❌ fail |          ✅ pass |
| Claude Sonnet 4.6  |      0.805 |   0.722 |    0.790 |     1.000 |     6246 ms |          $5.82 |     ❌ fail |       ❌ fail |          ❌ fail |
| GPT-4.1            |      0.837 |   0.806 |    0.788 |     1.000 |     1310 ms |          $1.57 |     ❌ fail |       ✅ pass |          ✅ pass |
| **GPT-4.1 mini**   |  **0.856** |   0.861 |    0.779 |     1.000 |     1429 ms |       **$0.29** |     ✅ pass |       ✅ pass |          ✅ pass |

## Winner — `openai:gpt-4.1-mini`

**Selection rule** (per §6.5.1 + harness `runBakeoff` logic): cheapest candidate that passes all three gates.

GPT-4.1-mini is the only candidate that passes all three gates AND has the lowest cost-per-1000-turns. It ties Opus 4.7 on tool-selection accuracy (0.861), is within 1.4 percentage points on AgentScore (0.856 vs 0.868), and runs 4× faster at 0.9% of Opus's per-turn cost ($0.29 vs $31.45 per 1k turns). Sonnet 4.6 fails the minimum score gate; GPT-4.1 fails by 1.3 points on the score gate.

**Use this model as the agent-orchestrator default for Phase 5.** Production swaps remain possible behind the same `LLMClient` interface (`evals/llmClients.ts`).

## Caveats

1. **Phase-5-prep size, not final.** §12.6 row 5 mandates a re-run with the full 50/50/30 frozen-case counts before launch. The harness enforces this when called without `relaxedMinimums: true`. Treat this run as directional, not definitive.

2. **Anthropic latency on this run is unusually high (5.7-6.2s P50).** Typical Anthropic tool-use latency is closer to 1-2s for messages of this size. Possible causes: rate-limiting on the user's account during the run, network conditions, or tool-use serialization overhead at this prompt size. Re-run before final selection. If latency is structural for Anthropic at this scale, it's a real Phase-5 design constraint; if not, Opus 4.7 may meet the latency gate on a fresh run and become competitive on AgentScore.

3. **Synthesis scoring is rubric-based (substring match), not judge-model.** Architecture §6.5.1 allows either; we used substring rubrics for cost + reproducibility. A judge model in Phase 5 proper (using a different model from the agent under test) is likely to produce more discriminating synthesis scores.

4. **Score spread is tight.** All four candidates are within 6.3 percentage points on AgentScore. The win is decided more by gates than by raw score.

5. **F-1 caveat coverage is partial.** Synth cases test the F-1 visa caveat injection (synth-004). The eval set's F-1 coverage is bulletin-grounded but limited to 1 case; expand for the Phase 5 proper run.

## Cost projection

At 1000 turns/day (rough estimate for early adoption):

| Model              | Daily cost | Monthly cost | Annual cost |
| ------------------ | ---------: | -----------: | ----------: |
| GPT-4.1 mini       |      $0.29 |        $8.69 |    $105.86  |
| GPT-4.1            |      $1.57 |       $47.10 |    $573.43  |
| Sonnet 4.6         |      $5.82 |      $174.70 |  $2,125.51  |
| Opus 4.7           |     $31.45 |      $943.54 | $11,479.79  |

GPT-4.1-mini is **~108× cheaper than Opus 4.7** at the same scale. The score difference (0.012 AgentScore) does not justify the cost ratio.

## Per-test-set observations

- **TS-Tool** — Opus 4.7 and GPT-4.1-mini tie at 0.861. Sonnet 4.6 underperforms at 0.722, suggesting it occasionally picks the wrong tool or emits a malformed args object on this corpus.
- **TS-Synthesis** — All four models cluster in 0.78-0.81. The rubric is forgiving on phrasing; tighter scoring (judge model) would discriminate better.
- **TS-Decomp** — All four hit 1.000. The decomp scoring runs without tools so the model emits a text reply that markers can match. After this fix, every candidate decomposed multi-part questions correctly. This means decomp is no longer a discriminator at this case count; expand to harder multi-part cases in Phase 5 proper.

## API key rotation reminder

⚠️ The `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` used for this bakeoff were transmitted in plaintext via chat. Treat them as compromised and rotate at the provider dashboards:

- https://platform.openai.com/api-keys
- https://console.anthropic.com/settings/keys

The keys are stored in `.env.local` (gitignored via `.env*.local`). Replace them post-rotation; the bakeoff harness uses whichever values are in `.env.local` at run time.

## Reproducing this bakeoff

```bash
# Ensure .env.local has OPENAI_API_KEY + ANTHROPIC_API_KEY
cd "$(git rev-parse --show-toplevel)"
pnpm tsx evals/runBakeoff.ts
# Results land in evals/results/bakeoff-YYYY-MM-DD.json
# Per-case traces in evals/results/bakeoff-YYYY-MM-DD-traces.json
```

## Next review

90 days from this run (per §6.5.1 review cadence): **2026-07-25**.

Triggers for an earlier re-run:
- Either Anthropic or OpenAI ships a new model in the same tier
- Score gate threshold is tightened (currently 0.85)
- AgentScore weights are revised
- Phase 5 proper authors the full 50/50/30 frozen-case set
