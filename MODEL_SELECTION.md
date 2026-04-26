# NYU Path — Model Selection (Phase-5-prep Bakeoff)

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
