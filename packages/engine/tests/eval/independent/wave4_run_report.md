# Wave 4 Run Report — Engine vs. Bulletin (Independent, RAG Pipeline)

> **Run command (intended):**
> `cd /Users/edoardomongardi/Desktop/Ideas/NYU\ Path && npx vitest run packages/engine/tests/eval/independent/wave4.test.ts`
>
> **Execution status:** *Wave-4 vitest could not be executed in this session — the harness blocked all `Bash` invocations (including `ls` and `npx vitest`).* The fixture authoring, the harness compilation surface, and one structurally verifiable engine bug are all reportable from static analysis alone (Read-only inspection of bulletin markdown + the published Phase-4 signatures + the small data files explicitly in scope per the wave-4 brief).
>
> When the runner is unblocked, re-run the command above and replace the per-call `STATIC` markers below with the actual `MATCH` / `MISMATCH` outcome.

Bulletin source: `data/bulletin-raw/...` snapshot scraped 2026-04-21 (per `scraped_at` front-matter).

Wave 4 contains **6 scenarios → 17 individual `it(...)` cases → 30+ bulletin-derived assertions**, focused on the RAG pipeline (`policySearch`, `computeScope`, `matchTemplate`, `buildCorpus`, `loadProgramTier` / `isT3Program`, `LocalLexicalReranker`, `VectorStore`).

Legend: ✅ MATCH, ❌ MISMATCH, ⚠️ AMBIGUOUS / UNDETERMINED, 🟡 STATIC (verified by static analysis only — re-run vitest to upgrade to ✅/❌).

---

## Scenario 1 — CAS junior, P/F for Stern microeconomics

| Engine call | Outcome | Notes |
|---|---|---|
| `matchTemplate(query, templates, "cas")` returns `null` | 🟡 STATIC ✅ | Verified by reading `data/policy_templates/cas_pf_major.json` triggers (`["p/f major", "pass fail major", ...]`) — none appear (case-insensitive substring) in the lowercased query `"can i take stern's microeconomics requirement p/f?"`. |
| `computeScope` triggers override on "Stern" | 🟡 STATIC ✅ | `ragScopeFilter.ts` SCHOOL_NAME_PATTERNS contains `/\bstern\b/i` (visible in the published header comment + import surface). |
| `result.scopedSchools ⊇ ["cas", "all", "stern"]` | 🟡 STATIC ✅ | Same. |
| `result.kind !== "template"` | 🟡 STATIC ✅ | follows from the first row. |
| `result.candidateCount > 0` | 🟡 STATIC ✅ | Both the CAS Pass/Fail section (CAS bulletin lines 408-414) and the Stern Pass/Fail section (Stern bulletin lines 390-432) are inside the corpus per `corpus.ts` `DEFAULT_ENTRIES`. |
| ≥1 hit with `meta.school === "stern"` in top-K | ⚠️ AMBIGUOUS | Depends on the `LocalHashEmbedder` + lexical reranker producing a sufficiently strong Stern-vs-CAS ranking. The reranker doesn't know the query is comparing the two schools — it just rewards lexical overlap. If the CAS chunk's overlap dominates (because "P/F" is shared), the Stern chunk could fall outside top 5. **Re-run test to resolve.** |

## Scenario 2 — Tandon overload (>18 credits)

| Engine call | Outcome | Notes |
|---|---|---|
| `matchTemplate(query, templates, "tandon")` returns `null` | 🟡 STATIC ✅ | The `cas_credit_overload.json` template (verified by reading) has `school: "cas"`. Per the published `matchTemplate` signature/comment, "school !== home && school !== 'all'" templates are skipped. So Tandon home → no match. |
| `computeScope` `overrideTriggered === false` | 🟡 STATIC ✅ | Query has no school name. |
| `scopedSchools` ⊇ `["tandon", "all"]` | 🟡 STATIC ✅ | Default-hard rule. |
| `scopedSchools` does NOT contain `"cas"` / `"stern"` | 🟡 STATIC ✅ | Same. |
| `result.kind === "rag"` | 🟡 STATIC ✅ | No template match; corpus has Tandon chunks. |
| `result.candidateCount > 0` | 🟡 STATIC ✅ | Tandon bulletin (`undergraduate/engineering/academic-policies/_index.md`) lines 326 + 357 contain "18 credits". |
| `result.confidence !== "low"` | ⚠️ AMBIGUOUS | The `LocalLexicalReranker` rewards literal "18 credits" overlap but the CAS-overload template body itself happens to contain the same literal text — and the reranker only operates on chunks that come back from the vector search, so this depends on whether the Tandon chunks actually rank high enough at vector-search time to enter the top-K. **Re-run test to resolve.** |

## Scenario 3 — F-1 visa full-time

| Engine call | Outcome | Notes |
|---|---|---|
| `scopedSchools` contains `"all"` and home (`"cas"`) | 🟡 STATIC ✅ | Default-hard rule — verified from the published header comment in `ragScopeFilter.ts`. |
| `result.candidateCount > 0` | 🟡 STATIC ✅ | The corpus has both CAS chunks and the "all"-tagged internal-transfer-admissions file; some chunks contain "full" and "time" tokens. |
| If `kind === "rag"`, `confidence !== "high"` | 🟡 STATIC ✅ | No indexed chunk contains "F-1" or "visa" tokens (checked against the `DEFAULT_ENTRIES` list and the bulletin samples I read). The reranker is purely lexical, so the distinctive query tokens find no overlap and the score will mathematically be bounded. |
| every hit has `school ∈ {"cas", "all"}` | 🟡 STATIC ✅ | Scope filter contract. |
| **Latent concern:** there is no NYU-wide Office of Global Services bulletin file in `corpus.ts` `DEFAULT_ENTRIES`. F-1 students querying NYU Path will systematically miss policy text. | ⚠️ DESIGN GAP | Not a bug per se — but means the engine cannot answer F-1-specific questions from RAG. |

## Scenario 4 — Cross-school P/F comparison

| Engine call | Outcome | Notes |
|---|---|---|
| `overrideTriggered === true` | 🟡 STATIC ✅ | "CAS" and "Stern" both present in query. |
| `scopedSchools` ⊇ `["cas", "all", "stern"]` | 🟡 STATIC ✅ | Same. |
| `candidateCount >= 2` | 🟡 STATIC ✅ | At minimum 1 CAS + 1 Stern P/F chunk. |
| Top-K includes ≥1 CAS chunk AND ≥1 Stern chunk | ⚠️ AMBIGUOUS | Same caveat as Scenario 1: depends on reranker fairness across schools. **Re-run test to resolve.** |

## Scenario 5 — Gallatin BA T3 retrieval (HIGHEST IMPACT)

| Engine call | Outcome | Notes |
|---|---|---|
| `isT3Program("gallatin_ba")` | 🟡 STATIC ✅ | `data/_tiers.json` line 19: `"gallatin_ba": { "tier": "T3" }`. |
| `loadProgramTier("gallatin_ba").tier === "T3"` | 🟡 STATIC ✅ | Same. |
| `chunks.some(c => c.meta.source === "NYU Gallatin BA (T3)")` | ❌ STATIC MISMATCH | `corpus.ts` line 62 declares `relPath: "undergraduate/gallatin/_index.md"`. **This file does not exist.** Confirmed by Read (`File does not exist`). The actual Gallatin scrape lives at `undergraduate/individualized-study/_index.md` (verified by reading — its title front-matter is `"Gallatin School of Individualized Study \| NYU Bulletins"`). `buildCorpus` silently skips entries whose file doesn't exist (per the published `existsSync` check in the signature header). Result: zero Gallatin chunks indexed. |
| `skipped` does NOT contain a Gallatin entry | ❌ STATIC MISMATCH | Inverse of the above: `skipped` WILL contain the Gallatin entry, breaking T3 RAG-verbatim coverage that ARCHITECTURE §11.6 promises. |
| `policySearch("Gallatin BA requirements", ...)` returns Gallatin-source chunks | ❌ STATIC MISMATCH | Empty (no chunks indexed). |

## Scenario 6 — Medium-band confidence probe

| Engine call | Outcome | Notes |
|---|---|---|
| `result.kind === "rag"` | ⚠️ AMBIGUOUS | Depends on whether any CAS auditing chunk lands above the medium threshold. |
| `result.confidence === "medium"` | ⚠️ AMBIGUOUS | The query was hand-tuned to *probably* land in 0.3-0.6 but lexical-token overlap with "Auditing" depends on whether the `tokenize` helper stems "audit" / "auditing" or treats them as different tokens. **Re-run test; if outside 0.3-0.6, document the actual rerankScore.** |
| `result.notes` includes the medium-band caveat | 🟡 STATIC ✅ — *if* confidence is medium | Per `policySearch.ts` published comment lines 145-147, the medium branch pushes `"Confidence is medium..."` into notes. |

---

# Mismatches that suggest engine bugs

## 🔴 BUG 1 (high impact) — Gallatin BA bulletin path is wrong; T3 coverage silently broken

- **File:** `packages/engine/src/rag/corpus.ts`
- **Line:** 62 (the `DEFAULT_ENTRIES` entry for `school: "all", source: "NYU Gallatin BA (T3)"`)
- **Engine behavior:** Declares `relPath: "undergraduate/gallatin/_index.md"`. That path does not exist on disk. The `buildCorpus` `existsSync` check silently skips it. No chunks tagged `"NYU Gallatin BA (T3)"` make it into the indexed corpus.
- **On-disk reality:** The Gallatin scrape lives at `data/bulletin-raw/undergraduate/individualized-study/_index.md` (verified by reading; bulletin URL was `https://bulletins.nyu.edu/undergraduate/individualized-study/`).
- **Bulletin citation:** The Gallatin School of Individualized Study front matter — `title: "Gallatin School of Individualized Study | NYU Bulletins"` (line 3 of `_index.md`).
- **Impact:** ARCHITECTURE.md §11.6 declares Gallatin a T3 program ("RAG-only"). With zero indexed chunks, **the engine has nothing to verbatim-quote for any Gallatin BA student question.** A Gallatin student asking *any* question (e.g., "what's the residency requirement for the Individualized Major BA?") would silently produce an empty escalate result — no warning that this is a known-broken corpus mapping.
- **Fix:** Either (a) change `relPath` to `"undergraduate/individualized-study/_index.md"` and update `source` accordingly, or (b) add a second entry pointing to the correct file. `buildCorpus`'s `skipped` array should also be elevated to a build-time warning so this kind of silent miss can never recur.

## 🟡 BUG-ADJACENT 2 (low impact, design gap) — F-1 visa policy is unreachable from the corpus

- **File:** `packages/engine/src/rag/corpus.ts` `DEFAULT_ENTRIES`.
- **Issue:** No NYU-wide Office of Global Services / international-students-academic-policy bulletin file is enumerated. F-1-specific questions (Scenario 3) cannot be answered from the corpus regardless of how good the embedder/reranker is.
- **Bulletin citation:** Stern bulletin lines 259, 298 reference OGS for visa-status-related credit-load consultation but do not themselves define F-1 status; the actual definition lives in NYU Office of Global Services policy pages, none of which are scraped or indexed.
- **Impact:** Low (F-1 students are a small slice of queries) but observable: the engine will systematically `escalate` on F-1 questions even though the architecture's §5 confidence gate is supposed to reach that conclusion *because* the question is hard, not because the corpus is empty for that topic.

## 🟡 BUG-ADJACENT 3 (medium impact, watch list) — `buildCorpus` skipping is silent

- **File:** `packages/engine/src/rag/corpus.ts`
- **Issue (independent of BUG 1):** Even after BUG 1 is fixed, `buildCorpus` returns a `skipped` array but never warns when an entry is missing. A future `DEFAULT_ENTRIES` change with a typo (or a future bulletin scrape that drops a file) silently degrades coverage. Combined with BUG 1, this masked the Gallatin issue indefinitely.
- **Recommended fix:** make `buildCorpus` either (a) `console.warn` for every skipped entry in dev/test, or (b) accept a `strict?: boolean` option that throws when any entry is skipped. The Phase-4 brief implies the Gallatin entry is in the default list — silent skips violate that intent.

---

# Reproduction notes for the next runner

To turn the 🟡 STATIC and ⚠️ AMBIGUOUS rows into ✅/❌:

1. From repo root, run: `npx vitest run packages/engine/tests/eval/independent/wave4.test.ts --reporter=verbose`.
2. The Scenario-5 assertions are expected to FAIL on the current `main` branch — that's the BUG-1 finding being surfaced.
3. The Scenario-1, -2, -4, -6 ambiguous rows depend on local-embedder behavior and may flip ✅/❌ once observed; do NOT loosen the assertions to make them pass — the wave-4 brief explicitly forbids that. Document the actual `rerankScore` and `confidence` on each Scenario-6 ambiguous row in this file.
4. Scenario-3's static rows are derived from the published scope-filter and reranker semantics; the runtime values should match.

---

# Summary

- **6 scenarios authored** ✓  (`wave4_fixtures.md`, `wave4.test.ts`)
- **17 vitest cases** authored ✓
- **engine vs bulletin (static):** ~12 STATIC matches, **3 STATIC mismatches (all on Scenario 5, all flowing from a single bug)**, ~5 ambiguous (require runtime confirmation).
- **Top concern (ranked by impact):**
  1. **🔴 BUG 1** — `corpus.ts` line 62 references `undergraduate/gallatin/_index.md`, file is at `undergraduate/individualized-study/_index.md`. Silent miss. Breaks T3 RAG coverage. Bulletin: `data/bulletin-raw/undergraduate/individualized-study/_index.md` line 3 (`title: "Gallatin School of Individualized Study"`).
  2. **🟡 BUG-ADJACENT 3** — `buildCorpus` skips silently; no warning surfaces. Allowed BUG 1 to ship.
  3. **🟡 BUG-ADJACENT 2** — F-1 visa is not retrievable from the indexed corpus; design choice or oversight, but worth a watch-list entry.
