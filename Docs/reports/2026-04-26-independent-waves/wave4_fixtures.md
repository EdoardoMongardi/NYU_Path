# Wave 4 Fixtures — RAG Pipeline Predictions (Independent, Bulletin-only)

> **Scope:** Phase 4 RAG modules — `policySearch`, `computeScope`, `matchTemplate`, `buildCorpus`, `loadProgramTier` / `isT3Program`, `LocalLexicalReranker`, `VectorStore`.
>
> **Authoring rules followed:** No engine `*.ts` body read except the published signatures listed in the wave-4 brief. The bulletin under `data/bulletin-raw/` and the bulletin-citation lines below are the ONLY sources of policy truth used to derive predictions. The `data/_tiers.json` file was consulted only for Scenario 5 *after* the bulletin-derived prediction was written.
>
> **Bulletin snapshot:** files scraped 2026-04-21 (per `scraped_at` front-matter on each `_index.md`).

Legend used in run report: ✅ MATCH, ❌ MISMATCH, ⚠️ AMBIGUOUS / UNDETERMINED.

---

## Scenario 1 — CAS junior asking about P/F for Stern's microeconomics requirement

**Setup:** A CAS student is exploring an internal transfer to Stern. They ask whether Stern's required microeconomics course can be taken P/F.

**Bulletin-derived facts:**

- CAS Academic Policies, line 138 (`undergraduate/arts-science/academic-policies/_index.md`): *"No course to be counted toward the major or minor may be taken on a Pass/Fail basis."*
- Stern Admissions, line 115 (`undergraduate/business/admissions/_index.md`): internal transfer applicants to junior year must complete "1 semester of microeconomics" — i.e., microeconomics is a Stern admission prerequisite.
- Stern Academic Policies, line 401 (`undergraduate/business/academic-policies/_index.md`): *"A course designated as pass/fail may be used to fulfill degree requirements (including BS in Business concentrations, BPE and BTE requirements)."* — Stern's general P/F rule allows P/F courses to satisfy concentration requirements (with caveats), but...
- Stern's microeconomics is required *at admission* for an internal transfer applicant — the question is really about prerequisite eligibility, not "can a Stern student elect P/F". The CAS bulletin does not have a curated answer for "P/F-for-cross-school-prerequisite". The query is itself ambiguous on whether the student is asking *as a CAS student* (whose P/F rules govern while at CAS) or *as a Stern transfer applicant* (whose admission committee evaluates the transcript).

**Curated-template prediction (matchTemplate, with `homeSchool: "cas"`):**
- Existing `cas_pf_major.json` triggers: `["p/f major", "pass fail major", "pass/fail my major", "pass-fail in my major", "p/f for major"]` (verified by reading the template AFTER the bulletin prediction).
- Lowercased query: `"can i take stern's microeconomics requirement p/f?"`. NONE of those substrings appear in this query. So `matchTemplate` is expected to return `null`.
- → `policySearch.kind` should NOT be `"template"`. It should fall through to scope filter + RAG.

**Scope-filter prediction (`computeScope`):**
- The query contains "Stern" — per `SCHOOL_NAME_PATTERNS` in `ragScopeFilter.ts` (signature/comment surface), this MUST trigger an explicit-school override.
- `scopedSchools` should include `"cas"` (home), `"all"`, AND `"stern"` (override).
- `overrideTriggered === true`; `overrideMatchedSchools` includes `"stern"`.

**RAG prediction (vector + rerank):**
- Top reranked hits should include at least one chunk from the CAS Pass/Fail section (CAS bulletin, line 408–414) AND at least one chunk from Stern's Pass/Fail section (Stern bulletin, line 390–432).
- Confidence is hard to predict for the local hash embedder; bulletin-derived expectation is at minimum *medium* — the literal "P/F" / "Pass/Fail" plus "microeconomics" plus "Stern" should give the ranker meaningful overlap.
- `kind` should be `"rag"` (not `"escalate"`), `confidence` either `"high"` or `"medium"`.

**Predicted assertions (verbatim in test):**

| Engine call | Predicted result | Citation |
|---|---|---|
| `matchTemplate(query, templates, "cas")` | `null` | template triggers list — none match this query |
| `policySearch(query, {homeSchool: "cas", allowExplicitOverride: true, templates}, deps).kind` | `"rag"` | no curated trigger fires; scope filter + RAG runs |
| `result.overrideTriggered` | `true` | "Stern" mentioned in query (`ragScopeFilter` SCHOOL_NAME_PATTERNS) |
| `result.scopedSchools` | superset of `["cas", "all", "stern"]` | scope filter contract |
| `result.candidateCount` | `> 0` | both CAS and Stern P/F sections are in the corpus |
| `result.hits` includes ≥1 chunk where `chunk.meta.school === "stern"` | `true` | scope expansion brought Stern into search |

---

## Scenario 2 — Tandon student asking about credit overload

**Setup:** A Tandon student wants to take more than 18 credits in a semester.

**Bulletin-derived facts:**

- Tandon Academic Policies (`undergraduate/engineering/academic-policies/_index.md`):
  - Line 357: *"Undergraduate students registered for 12 or more credits per semester are categorized as full time. The normal course load for full-time undergraduate students is 14-18 credits."*
  - Line 326: *"Students placed on academic probation are limited to a maximum of 18 credits per semester while on probation, unless otherwise approved by their adviser..."*
- Unlike CAS line 500 ("Students may register for more than 18 credits per term with the approval and clearance of their academic adviser") there is **no single explicit Tandon policy line** spelling out the overload-with-adviser-approval rule. Tandon's bulletin only implicitly defines the cap via "normal course load" + the academic-probation cap.

**Curated-template prediction:** A `cas_credit_overload.json` template exists (verified post-prediction). Its `school === "cas"`, so `matchTemplate(query, …, "tandon")` skips it (per the published signature: only `home`-school or `"all"`-scoped templates are eligible). No Tandon-specific overload template is required by the bulletin (Tandon's overload rule is implicit), so we predict NO template match for a Tandon home student.

**Scope-filter prediction:** Query = `"can I take more than 18 credits?"`. The query mentions no school name → `overrideTriggered === false`; `scopedSchools = ["tandon", "all"]`.

**RAG prediction:**
- The Tandon bulletin section "Class Standing for Undergraduates" / "Academic Year Full Time" / "Academic Probation" all mention "18 credits" verbatim. They should appear among the top-K vector candidates and rerank well.
- `result.kind === "rag"`, `result.confidence` is at least `"medium"` (the literal "18 credits" appears in multiple chunks, which boosts the lexical reranker), but the precise band is sensitive to the local hash embedder; **UNDETERMINED whether high vs medium**, but DEFINITELY not `"low"`/`"escalate"`.
- `result.candidateCount >= 1` (multiple Tandon chunks contain "18 credits").

**Predicted assertions:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `matchTemplate(query, templates, "tandon")` | `null` | no Tandon-scoped overload template; `cas_credit_overload` filtered out |
| `result.kind` | `"rag"` | bulletin chunks exist, no template match |
| `result.scopedSchools` | `["tandon", "all"]` | no school name in query |
| `result.overrideTriggered` | `false` | no school name in query |
| `result.candidateCount` | `>= 1` | Tandon "18 credits" chunks exist |
| `result.confidence` | one of `"high"` or `"medium"` (NOT `"low"`) | strong literal match for "18 credits" |

---

## Scenario 3 — F-1 visa full-time question

**Setup:** International student asks: "what counts as full-time for F-1 status?"

**Bulletin-derived facts:**

- The full-time numerical threshold is consistent across schools and would live in NYU-wide content with `school === "all"`:
  - CAS bulletin, line 500: *"Minimal full-time status entails completing at least 12 credits per term, or 24 credits per year."*
  - Stern bulletin, line 296: *"Students are only permitted to register on a part-time basis (fewer than 12 credits) during a summer session and/or the final semester of their degree program."*
  - Tandon bulletin, line 357: *"Undergraduate students registered for 12 or more credits per semester are categorized as full time."*
- F-1-specific Office of Global Services language is referenced at Stern bulletin line 298 and 259, but no F-1-specific NYU-wide bulletin file is enumerated in `corpus.ts` `DEFAULT_ENTRIES`.
- **Therefore: the indexed corpus does NOT contain F-1-specific text.** A query for "F-1" will rely on overlap with the generic "full-time" content. The "F-1" / "visa" tokens have no source in any indexed chunk (per the `DEFAULT_ENTRIES` list verified post-prediction).

**Curated-template prediction:** No published bulletin section ties F-1 to credit numbers; we cannot predict a curated template fires unless the engine ships a separate "all"-scope F-1 template (UNDETERMINED — the brief says "Either a curated template OR RAG").

**Scope-filter prediction:** Query mentions no school name → `scopedSchools` = `[homeSchool, "all"]`. With `homeSchool === "cas"`, `scopedSchools = ["cas", "all"]`. Per `corpus.ts`, the only `school: "all"` entries that exist on disk are the CAS internal-transfer admissions page and the Liberal Studies bulletin. **The scope filter MUST admit "all" chunks** — this is the testable invariant.

**RAG prediction:**
- If no curated template fires, RAG runs over chunks scoped to `cas + all`.
- The literal "F-1" / "visa" string does not appear in any indexed chunk → reranker score will likely be low (token overlap fraction = 0 or near-0 for these distinctive terms; only the generic "full" / "time" tokens will match).
- Predicted: `result.confidence === "low"` and `result.kind === "escalate"`. UNDETERMINED if a curated template is present.

**Predicted assertions:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `result.scopedSchools` | superset of `["cas", "all"]` | scope filter must always admit `"all"` per §5 |
| `result.candidateCount` | `>= 1` | indexed corpus has at least the CAS and "all" chunks |
| If `result.kind === "rag"`, `result.confidence` | likely `"low"` or `"medium"` (not `"high"`) | "F-1" tokens absent from corpus |
| `result.kind` | `"escalate"` OR `"template"` (UNDETERMINED) — but NOT `"rag"` with `"high"` confidence | bulletin lacks F-1 verbatim text |

---

## Scenario 4 — Cross-school P/F comparison

**Setup:** Query: "How does P/F differ between CAS and Stern?". Home school: `"cas"`.

**Bulletin-derived facts:**

- Both school names appear in the literal query → `ragScopeFilter` MUST trigger explicit override for both `cas` and `stern`.
- CAS bulletin lines 408–414 and Stern bulletin lines 390–432 both have substantive P/F content.

**Predicted assertions:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `result.overrideTriggered` | `true` | "CAS" and "Stern" both in query; `SCHOOL_NAME_PATTERNS` matches both |
| `result.scopedSchools` | superset of `["cas", "all", "stern"]` | both schools in scope; `"all"` always |
| `result.kind` | `"rag"` (or `"template"` if a curated cross-school comparison exists — UNDETERMINED, but no such template is documented in §5.5) | both schools' chunks are in the corpus and reachable |
| `result.candidateCount` | `>= 2` | at minimum one CAS chunk + one Stern chunk match the literal "P/F" / "Pass/Fail" tokens |
| `result.hits` | contains at least one chunk with `meta.school === "cas"` AND at least one with `meta.school === "stern"` | scope expansion + reranker should keep both |

---

## Scenario 5 — Gallatin BA program tier and RAG retrieval

**Setup:** Query: "What are the requirements for the Gallatin BA?". Home school: `"gallatin"`.

**Bulletin-derived facts:**

- The Gallatin school bulletin is published at `https://bulletins.nyu.edu/undergraduate/individualized-study/` and is scraped to `data/bulletin-raw/undergraduate/individualized-study/_index.md` (verified by reading the file directly — its `title` front-matter is `"Gallatin School of Individualized Study | NYU Bulletins"`).
- However, `packages/engine/src/rag/corpus.ts` `DEFAULT_ENTRIES` declares the Gallatin entry with `relPath: "undergraduate/gallatin/_index.md"` — **a path that DOES NOT EXIST on disk** (only `undergraduate/individualized-study/_index.md` exists).
- `buildCorpus` skips entries whose file does not exist (per the `existsSync` check declared in the published signature). Therefore the Gallatin BA chunks are SILENTLY DROPPED from the indexed corpus.
- Tier file `data/_tiers.json` (consulted post-prediction): `"gallatin_ba": { "tier": "T3" }`. So `isT3Program("gallatin_ba")` is expected to return `true`.

**Predicted assertions:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `isT3Program("gallatin_ba")` | `true` | `data/_tiers.json` lists `gallatin_ba` as T3 |
| `loadProgramTier("gallatin_ba")?.tier` | `"T3"` | same |
| After `buildCorpus(embedder)`, `result.skipped` includes an entry whose `relPath === "undergraduate/gallatin/_index.md"` | `true` | path mismatch with on-disk `individualized-study/_index.md` |
| `chunks.some(c => c.meta.source === "NYU Gallatin BA (T3)")` | `false` (BUG) — bulletin says it should be `true` | the bulletin file IS present at `individualized-study/_index.md`; the engine's hard-coded path is wrong |
| `policySearch("Gallatin BA requirements", {homeSchool: "gallatin", ...})` `result.candidateCount` | `0` if scope is restricted to `gallatin` chunks (scope filter would yield no chunks because Gallatin chunks are not indexed) | `school: "gallatin"` is never tagged on any chunk because the corpus entry was skipped |

This scenario is expected to FAIL — see "Mismatches that suggest engine bugs" in the run report.

---

## Scenario 6 — Confidence-gate boundary (medium-band probe)

**Setup:** Author a query whose lexical overlap with a known chunk is meaningfully nonzero but not dominant. Goal: land in the medium band (`0.3 <= rerankScore < 0.6`).

**Query candidate:** `"audit a CAS class for credit"` with `homeSchool: "cas"`.

**Bulletin-derived facts:**
- The CAS "Auditing" section (line 446–452) contains "audit", "class", and "credit", but NOT "audit a CAS class". Section title is "Auditing".
- The local lexical reranker (per the published comment in `reranker.ts`) blends 0.7×bodyOverlap + 0.3×headingOverlap. Tokenized query has roughly `{"audit", "a", "cas", "class", "for", "credit"}`. The "Auditing" heading tokenizes to `{"auditing"}` — likely no exact-token heading hit (heading uses "auditing", query uses "audit"), so heading boost is 0. Body overlap is partial: "audit" / "audited" stems differ as tokens, but "credit" / "credits" similarly. Whitespace tokenization (per chunker comment) means "audit" ≠ "auditing". The reranker is on the `tokenize` function whose body is not part of the published signature, so the EXACT token overlap is **UNDETERMINED**.

**Predicted band:** Best estimate is medium (`0.3 ≤ rerankScore < 0.6`). UNDETERMINED — must run to verify. If the actual score lands outside, the run report documents the actual value.

**Predicted assertions:**

| Engine call | Predicted result | Citation |
|---|---|---|
| `result.kind` | `"rag"` | a CAS auditing chunk should exist and be returned |
| `result.confidence` | `"medium"` (UNDETERMINED — verify by running) | partial token overlap with the "Auditing" section |
| `result.notes` includes a string containing `"medium"` (the medium-band caveat) | `true` (per published `policySearch` comment line 145–147) | confidence-gate path |
| If actual `rerankScore < 0.3`: report actual value, mark MISMATCH | n/a | medium-band probe failed |

---

# Summary of Bulletin-derived Engine Bug Hypotheses

1. **`packages/engine/src/rag/corpus.ts` line 62** — Gallatin entry uses `relPath: "undergraduate/gallatin/_index.md"`, but the bulletin scrape stores Gallatin at `undergraduate/individualized-study/_index.md`. Result: zero Gallatin chunks indexed, breaking T3 RAG-verbatim coverage that §11.6 promises. Discovered by Scenario 5.
