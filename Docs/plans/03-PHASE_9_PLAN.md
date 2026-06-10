# Phase 9 Plan — Bulletin Curriculum into RAG + Audit/RAG Bridge

**Status:** Plan only. Not started.
**Date authored:** 2026-04-28
**Predecessors:** Phase 7-E (DPR pivot), Phase 8 (architectural cleanup + 5-model bake-off → claude-haiku-4-5 primary), Phase 8 follow-ups (calendar-aware temporal context, transfer-eligibility senior + DPR-credit fixes).

---

## 1. Why this exists

After Phase 8 the operator ran a real conversation against their actual DPR (`SAA_STD_DS.pdf`, joint Math/CS BA, Spring 2026 in session, Fall 2026 pre-registered, Spring 2027 grad target). The session surfaced **16 distinct issues**, of which the dominant root cause is **a curriculum data gap, not a reasoning gap**.

**Concrete diagnostic** (`data/policy-corpus/policy_chunks.jsonl`):
- `2,713` `_index.md` files exist under `data/bulletin-raw/`
- `864` of those are program pages (BA / BS / minor curricula — the pages that actually list which courses each major requires)
- `405` are course-catalog descriptions
- **The current policy RAG indexes 12 distinct sourcePaths.** Of those 12, **exactly one program page is included: `economics-ba`.** Every other CAS program page — including `mathematics-computer-science-ba` — is unindexed.

The downstream effect: when the DPR says "Computer Science: Required Courses — Complete the following courses:" (a deliberately terse PeopleSoft string), the agent has no source for "the following courses" because the bulletin program page that lists them isn't in the RAG. The agent either guesses, hedges, or punts to "ask your adviser." Same gap explains:
- "(1 Math course)" placeholder in the Spring 2027 plan
- Treating "CORE-UA 400" as a specific course instead of a 400-499 range
- Failing to surface "C-or-better required for major" + "no P/F for major" rules
- Fabricating "MATH-UA 251 + 343 likely satisfy CS/Math joint major" without bulletin evidence

This phase closes the gap.

## 2. Goals + non-goals

### Goals
- Push the curriculum-question quality from "guesses + hedges" to "bulletin-cited specific course names"
- Reuse existing infrastructure (`policySearch`, embedder, reranker, JSONL chunker, validator) — no new tools unless Stage 4 says we need one
- Keep `Cardinal Rule §2.1` (every claim traces to a tool result) intact while broadening what tool results can return
- Re-run the operator's exact session and verify the 16 issues drop substantially
- Cost ≤ $1 in API for the entire phase

### Non-goals
- **No per-major authored rules in the engine.** That's the "infinite work" Phase 7-E walked away from. Bulletin pages stay as markdown; the agent reads them via RAG.
- **No new bulletin scrape.** `data/bulletin-raw/` already has the data from a prior crawl.
- **No structured `get_program_requirements` tool YET.** That's deferred to Stage 4 (Path B) and only fires if Stage 3 grading says RAG-only isn't sufficient.
- **No model swap.** claude-haiku-4-5 stays primary.
- **No new validator rules.** The four we have suffice; we may *loosen* one (verbatim_drift on the GPA suffix).
- **No new templates.** Templates remain a candidate source via `search_policy` post-Phase-8.

## 3. Scope of the bulletin pages to ingest

Three categories, in priority order:

| Category | Path glob | Count | Why ingest |
|---|---|---:|---|
| **A. CAS undergraduate programs** | `data/bulletin-raw/undergraduate/arts-science/programs/*/_index.md` | 110ish | The majors and minors a CAS student would be in. Highest-priority; covers Math, CS, the joint, plus all the other CAS BAs/BSes. |
| **B. CAS College Core Curriculum + academic policies** | `data/bulletin-raw/undergraduate/arts-science/college-core-curriculum/_index.md` + `arts-science/academic-policies/_index.md` (already indexed) | 2 | The Core defines Texts and Ideas, Cultures and Contexts, Expressive Culture, etc. Without it the agent can't say "CORE-UA 4XX = Texts and Ideas, CORE-UA 7XX = Expressive Culture." |
| **C. Other-school program pages (selective)** | `data/bulletin-raw/undergraduate/{arts,business,engineering,liberal-studies,individualized-study,abu-dhabi,shanghai}/programs/*/_index.md` | ~750 | For what-if questions ("what if I switched to Stern Finance?"). Lower priority; cohort A is CAS-only by current intent, but cross-school what-ifs are common. |
| **D. Course catalog pages (selective)** | `data/bulletin-raw/undergraduate/arts-science/courses/csci_ua/_index.md`, `math_ua/_index.md`, `core_ua/_index.md`, `expos_ua` (already indexed) | ~10-15 | Course-level descriptions. Useful for "what is CSCI-UA 421?" type questions. |

**Stage 1 ingests A + B (≈112 files).** Stages 2 + 3 measure whether that's enough. Categories C + D are optional Stage 5+ if needed.

Token estimate: ~112 files × ~3-5k tokens each ≈ ~450k input tokens. At OpenAI text-embedding-3-small ($0.02/1M), embed cost ≈ **$0.01**. Trivial.

## 4. Workstream — six stages

### Stage 1 — Ingest bulletin program + core-curriculum pages

**Effort:** 2-3 hours
**Risk:** Low (additive; pre-existing `policy_chunks.jsonl` stays valid even if Stage 1 fails)
**Closes:** Issues 1, 7, 8, 11 (curriculum-not-known)
**Cost:** ~$0.01-0.05 in OpenAI embed

#### What ships
1. **Locate the existing corpus-builder script.** If one exists at `tools/policy-corpus-builder/` (or similar), extend it. If not, write a new minimal ingest at `tools/policy-corpus-builder/ingestBulletinPrograms.ts`.
2. **The script must:**
   - Walk `data/bulletin-raw/undergraduate/arts-science/programs/*/_index.md` and `data/bulletin-raw/undergraduate/arts-science/college-core-curriculum/_index.md`
   - Strip frontmatter + obvious boilerplate (the `<![CDATA[...]]>` block, navigation tabs, JS snippets) — these eat token budget without helping retrieval
   - Chunk to ~800-1200 tokens with ~10% overlap (matches the existing chunker's settings)
   - Tag chunk metadata with: `school: "cas"`, `category: "program" | "core_curriculum"`, `programLabel: "Mathematics and Computer Science (BA)"` (extracted from the markdown's first H1), `sourcePath: <relative path>`, `year: "2025-2026"`, `chunkId: "<programLabel>_NNN"`
   - Embed via `OpenAIEmbedder` (text-embedding-3-small, 1536 dims) — same dim as current corpus
   - Append to `data/policy-corpus/policy_chunks.jsonl` (don't replace; the policy + admissions chunks stay)
   - Update `data/policy-corpus/policy_chunks.meta.json` with the new total count + provenance
3. **Don't break existing chunks.** Append-only. Re-embed verification: load the corpus via `loadPolicyCorpusFromCache`, run a `policySearch("CS major required courses")` — top hit should be the new CS bulletin page, not the old academic-policies page.

#### Acceptance
- [ ] `policy_chunks.jsonl` grows from 636 → ≥1500 chunks
- [ ] Distinct `sourcePath` count grows from 12 → ≥110
- [ ] Probe queries return the right program page in the top-3 hits:
  - `"computer science and mathematics required courses"` → top hit = `mathematics-computer-science-ba/_index.md`
  - `"texts and ideas core curriculum"` → top hit = `college-core-curriculum/_index.md`
  - `"economics minor requirements"` → top hit = `economics-minor` (if indexed) or honest "no match"
- [ ] All 754+ existing tests still pass (no regression in policy_chunks shape)
- [ ] No prompt-injection or HTML/CSS leaks in the indexed text (visual spot-check on 5 random chunks)

#### Files touched
- New: `tools/policy-corpus-builder/ingestBulletinPrograms.ts`
- Modified: `data/policy-corpus/policy_chunks.jsonl` (append-only)
- Modified: `data/policy-corpus/policy_chunks.meta.json` (count update)
- New (optional): a small README at `tools/policy-corpus-builder/README.md` documenting the ingest

#### Open question to decide before Stage 1 ships
- **Should we also ingest `data/bulletin-raw/undergraduate/arts-science/courses/csci_ua/_index.md` etc. as category D?** My recommendation: no for Stage 1; revisit if Stage 3 says course-level questions miss. Easy to add later.

---

### Stage 2 — System-prompt nudge for generic-DPR-text → search_policy

**Effort:** 30-45 min
**Risk:** Low (one prompt edit + one tool-description update)
**Closes:** Issues 1, 6, 7, 8, 11 (when paired with Stage 1's RAG content)

#### What ships
1. **Add a core rule to the system prompt** (`packages/engine/src/agent/systemPrompt.ts`):
   > **6. GENERIC DPR REQUIREMENT TEXT IS A FOLLOW-UP SIGNAL.** When `run_full_audit` returns a requirement whose `statusText` is generic — "Complete the following courses:", "Complete the requirements outlined below.", a course range like "CORE-UA 400-499", or any phrase that doesn't name specific courses — that is a HINT that the bulletin page has the detail. Call `search_policy` with the program label + "required courses" / "elective list" / the course range, then quote the bulletin's actual list back to the student. Do NOT guess specific course codes from training data.
2. **Update `run_full_audit`'s description** to spell out the same handoff:
   > "When this tool returns an unsatisfied requirement whose status text is generic (e.g., 'Complete the following courses:' without listing them), the bulletin program page has the actual list. Call `search_policy` with the program name + 'required courses' to fill the gap."
3. **Update `search_policy`'s description** to advertise that it now indexes program pages, not just academic policies.

#### Acceptance
- [ ] Re-run a test question ("what specific courses do I need?") and confirm the agent now does both `run_full_audit` AND `search_policy` in sequence
- [ ] Existing tests still pass (the prompt change is additive)
- [ ] No regression in W10.8 5-persona smoke

---

### Stage 3 — Re-run the operator's full conversation + grade

**Effort:** 30 min
**Risk:** None (verification only)

#### What ships
1. Run the operator's exact 13-turn conversation from the prior session (DPR upload, "what course do I still need to take", "what is CSCI-UA 421", "Plan next semester (Fall 2026)", etc.) live against `localhost:3001/api/chat/v2` with `claude-haiku-4-5` primary post-Stage-1 + Stage-2.
2. Capture each turn's tools called + final text.
3. Grade each issue from yesterday's audit (16 items) — fixed / partial / unchanged.

#### Decision fork
- **If 12+ of 16 issues are FIXED:** Stage 1 + 2 are sufficient. Skip Stage 4 (no Path B). Proceed straight to Stage 5.
- **If 8-11 of 16 issues are FIXED:** RAG retrieval works but is unreliable. Triage:
  - If failures are "wrong program page returned" → Stage 4 (structured tool).
  - If failures are "chunked too aggressively, important sentence missing" → re-chunk with different boundary settings (Stage 1.5).
- **If <8 of 16 issues are FIXED:** retrieval is broken. Stop and triage before any further work.

---

### Stage 4 (CONDITIONAL) — Structured `get_program_requirements` tool

**Effort:** 4-6 hours (a full day if the bulletin format has surprises)
**Risk:** Medium (introduces a parser that has to track bulletin format changes year-over-year)
**Fires only if Stage 3 fails the ≥12/16 threshold**

#### What would ship if needed
- A typed Zod schema for `ProgramRequirements`: `{programId, programLabel, requiredCourses[], electiveLists[], minCreditsForCAS, gradePolicy: "C-or-better-for-major" | etc., notes[]}`
- A markdown parser that reads `data/bulletin-raw/.../mathematics-computer-science-ba/_index.md` and produces a `ProgramRequirements` object
- A new tool `get_program_requirements(programLabel)` that lazily parses on first call
- Tests over the joint Math/CS BA + Economics BA + a minor (covers majority of bulletin format variations)

#### Why this is the fallback, not Stage 1
- It locks in a parser that has to track bulletin format changes
- Most bulletin pages have idiosyncratic formatting; a single parser is brittle
- RAG handles format drift gracefully (just re-embed)
- Don't pay the maintenance cost unless the simpler approach actually fails

---

### Stage 5 — Mechanical cleanup (independent of the curriculum work)

**Effort:** 1.5-2 hours
**Risk:** Low

These are bugs surfaced in yesterday's audit but unrelated to the data gap. Bundle them into one commit.

#### What ships
1. **`search_availability` term code:** investigate why the agent constructed `1259` for Fall 2026 when [generateTermCode](packages/engine/src/api/nyuClassSearch.ts) correctly returns `1268`. Likely the agent invented the code; the tool description should make the term-code mapping explicit so the model passes the right value. Fix:
   - Make `searchAvailability` accept BOTH a term-code string AND a (year, term) tuple
   - When given (year, term), call `generateTermCode` internally — agent never sees the raw 4-digit code
   - Update tool description to encourage the (year, term) form
2. **Per-program rule dedup in `run_full_audit` summary:** the Phase 8 dedup walker fixed `notSatisfiedRequirements`, but the per-program iteration in `summarizeResult` (`audits[].rules.filter((r) => r.status !== "satisfied")`) still surfaces both R1004 + R1004/10. Apply the same prefix-dedup to the per-program rendering OR drop the per-program block when `dprUnsatisfiedRequirements` is present (it has the deduped truth already).
3. **Loosen the `extractVerbatim` GPA fingerprint:** today it requires the literal string `Cumulative GPA: 3.402 (from your Degree Progress Report).` — the agent often writes `Cumulative GPA: 3.402` without the suffix. Result: the validator fires `verbatim_drift` on every audit-using turn, surfacing a ⚠ banner to the student. Fix: change `extractVerbatim` to return the looser substring `Cumulative GPA: 3.402` — the substring match still pins the number, drops the noisy banner.
4. **Strengthen the temporal-block guidance for `preRegisteredTerms`:** in the operator's session, the agent didn't initially consult `preRegisteredTerms: ["Fall 2026"]` and tried to plan Fall 2026 as if empty. Fix: add an explicit rule in the temporal block: "BEFORE planning a term in `preRegisteredTerms`, list what the student is already registered for in that term and only suggest courses that fill remaining gaps."

#### Acceptance
- [ ] `search_availability` for Fall 2026 returns real sections (not "no sections found in 1259")
- [ ] `run_full_audit` summary lists 3 distinct unmet requirements, not 4
- [ ] No `verbatim_drift` warning in the operator's re-run conversation
- [ ] When asked "plan Fall 2026" the agent first acknowledges the 3 already-registered courses and only proposes additions

---

### Stage 6 — Final re-run + commit + reviewer

**Effort:** 1 hour

#### What ships
1. One final live re-run of the operator's exact conversation
2. Side-by-side grade vs. yesterday: 16 issues × {pre-Phase-9, post-Phase-9}
3. Commit each stage as separate commits (single-stage rollback option)
4. Spawn an independent reviewer agent on the Phase 9 commit set (same pattern as Phase 8 W11 reviewer)

#### Acceptance
- [ ] ≥12 of 16 issues from yesterday FIXED; remaining ones documented + scoped to a future phase
- [ ] All 754+ unit tests pass
- [ ] W10.8 5-persona smoke still PASS at P0=0
- [ ] Operator-facing sanity: the same questions that confused the agent yesterday now produce bulletin-cited specific course names (CSCI-UA 421, etc.) without guessing

---

## 5. Sequencing + estimate

```
Day 1 (4-5 hours, ~$0.10):
  Stage 1 — bulletin ingest (2-3 hrs)
  Stage 2 — system-prompt nudge (30-45 min)
  Stage 3 — re-run + grade (30 min)
   → Decision fork:
     ≥12/16 fixed → skip Stage 4, jump to Stage 5
     8-11/16     → triage; possibly Stage 1.5 (re-chunk) or Stage 4
     <8/16       → stop; triage retrieval

Day 2 (2 hours, $0):
  Stage 5 — mechanical cleanup (term code, dedup, verbatim, temporal)

Day 3 (1 hour, $0):
  Stage 6 — final re-run + commit + reviewer pass
```

If Stage 4 fires (worst case), add a full day. Otherwise total is **~7-8 hours of focused work for ≥12/16 issue closures.**

---

## 6. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Bulletin chunks contain HTML/CSS noise that pollutes retrieval | Medium | Medium | Strip the standard `<![CDATA[…]]>` block + navigation menus before chunking. Visual spot-check 5 random chunks. |
| R2 | RAG returns wrong program page (e.g., "Computer Science (BA)" vs "Mathematics and Computer Science (BA)" — they sound alike) | Medium | High | Add `programLabel` to chunk metadata + raise it as a reranker bias signal. If still flaky, fall back to Stage 4 (structured tool). |
| R3 | Embed call fails / OpenAI returns 5xx | Low | Low | Re-run; the embedder has retry already. Cost is trivial enough to redo from scratch if needed. |
| R4 | Bulletin pages contain stale 2024-2025 content while the student is on the 2025-2026 catalog | Low | Medium | The current bulletin scrape's frontmatter shows `scraped_at: 2026-04-21` and `year: "2025-2026"` — fresh enough. Document the staleness in `policy_chunks.meta.json`. |
| R5 | Stage 5's `verbatim_drift` loosen makes the validator weaker | Low | Medium | Only loosen the GPA fingerprint (`Cumulative GPA: <num>` substring); other verbatim-required fields (the §6.4 disclaimer) keep their literal-text requirement. |
| R6 | Stage 4 fires and bulletin format varies more than expected | Medium | Medium | Start with the joint Math/CS page (the case the operator hit). If the parser handles it, expand only as needed. Keep RAG as primary; structured tool is a refinement. |
| R7 | New chunks crowd out policy chunks at the reranker stage (top-K too small) | Medium | Low | Increase `topKVector` from 20 → 30 + `topKRerank` from 5 → 7 to give the reranker more candidates to work with. Cohere rerank cost: still pennies per call. |

---

## 7. Decision points needing operator input

These are the places the plan stops and asks before proceeding:

1. **Before Stage 1 starts:** confirm the scope — Categories A + B only (CAS programs + core curriculum), or also include C (other-school programs)? My recommendation: A + B only. Cohort A is CAS-focused.
2. **Before Stage 3 grading:** what's the threshold for declaring success? My recommendation: ≥12 of 16 issues FIXED + 0 NEW issues introduced. Operator's call.
3. **At the Stage 3/4 fork:** if Stage 3 gives 8-11/16, decide: re-chunk with different parameters (a half-day) vs. write the structured tool (a full day).
4. **Before Stage 5's verbatim_drift loosen:** confirm the trade-off (less brittle vs. less strict on the GPA fingerprint specifically).

---

## 8. Things explicitly NOT in Phase 9

- **No new tools** unless Stage 4 fires.
- **No model swap.** claude-haiku-4-5 stays primary.
- **No new policy templates.**
- **No subagent / Task delegation.**
- **No bulletin re-scrape.** Use existing `data/bulletin-raw/`.
- **No catalog re-embed for the course-search side.** That's a separate concern from policy RAG.
- **No new validator rules.** We're loosening one; not adding any.
- **No automatic bulletin-version bumping.** The 2025-2026 scrape stays authoritative until manual refresh.

---

## 9. Acceptance criteria (rolled up)

Phase 9 ships when ALL of these are true:

- [ ] `policy_chunks.jsonl` indexes ≥110 distinct sourcePaths (vs. 12 today)
- [ ] Probe queries against the joint Math/CS page, the CS BA page, the Math BA page, and the College Core Curriculum page each return the right page in the top-3 RAG hits
- [ ] Operator's 13-turn conversation re-runs with ≥12 of 16 issues from yesterday's audit FIXED
- [ ] No new issues introduced (no regressions on the 25-question Phase 8 bake-off)
- [ ] `verbatim_drift` no longer fires on standard audit turns
- [ ] `search_availability` for Fall 2026 returns real sections
- [ ] All unit tests + W10.8 smoke + cohort_a frozen eval pass
- [ ] Independent reviewer pass

---

## 10. Backout plan

Each stage is a separate commit. Rollback is per-stage:
- Stage 1 rollback: revert the corpus-builder commit + delete the appended chunks (operator can re-run with a smaller scope)
- Stage 2 rollback: revert the system-prompt edit; tool descriptions stay
- Stage 5 fixes are independent and per-bug

Worst-case backout: revert all Phase 9 commits, ship cohort A on Phase 8 + the calendar/transfer fixes as-is. The agent's degree-question quality remains at "75% A-grade with curriculum gap" — usable, not great.

---

## 11. Author's note on philosophy

Phases 7-E and 8 leaned heavily on **the DPR is the source of truth for the student's state**. Phase 9 makes the parallel claim: **the bulletin is the source of truth for the major's structure**. Both are NYU-published; both are already in the repo as raw data; both should be available to the agent as facts to cite, not as things to guess.

The previous attempt to encode major requirements as authored rules (Phase 1-4) created an infinite-work problem. RAG over the bulletin sidesteps it: the bulletin's natural language is structured enough for the agent to extract the relevant sentence, and citing it back to the student keeps Cardinal Rule §2.1 intact.

If RAG retrieval over the bulletin pages turns out to be unreliable (Stage 3 fork), Stage 4's structured tool is the fallback — but only as a last resort, since structured parsers create their own maintenance debt. The bet is that retrieval is good enough for the curriculum side, just as it has been for the policy side.
