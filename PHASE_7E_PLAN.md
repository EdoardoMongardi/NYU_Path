# Phase 7-E — DPR-First Pivot: Path to Cohort-A End-to-End

**Status**: planning, awaiting user sign-off on Section 8 questions before Workstream 1 begins.
**Author**: Claude (Phase 7-E planner) + Edoardo (decisions).
**Last updated**: 2026-04-27.
**Branch**: main (currently at `51e25a75`).

---

## 0. Premise and Locked Decisions

### 0.1 Why this phase exists

The original Phase 7-B/C/D roadmap assumed we would author per-program structured rule files for every NYU undergraduate program (~200 programs). That assumption was challenged after the discovery that NYU's Albert SIS already exposes a fully-computed Degree Progress Report (DPR) for every active student. Replicating NYU's audit engine programmatically is not necessary if we can ingest its output directly.

This phase pivots the architecture: **the DPR becomes the canonical audit source for the student's current program(s); the existing deterministic rule engine is preserved as the backend for hypothetical-program what-ifs and as a fallback path**.

### 0.2 Locked decisions (DO NOT re-litigate without explicit user input)

1. **Single passive upload only**: the student uploads exactly one PDF on onboarding — their Albert Degree Progress Report. The unofficial transcript is **redundant** (DPR's Course History block contains every course with grade, units, type, and repeat code). Existing transcript-parsing code is kept inactive as a fallback for the rare "DPR unavailable" case.

2. **The student never operates Albert tooling beyond view+download**. No What-If form. No Academic Planner. No DegreeWorks pages. No browser extension. The agent reasons over the DPR + bulletin + course catalog + FOSE; the student talks to the agent in natural language.

3. **Cardinal Rule §2.1 (no synthesized numerical claims) is preserved**. Numbers in the reply come from the DPR (deterministic) or from the just-in-time-extracted-and-deterministically-audited what-if pipeline. The LLM does wording, not arithmetic.

4. **Just-in-time bulletin extraction handles hypothetical programs**. When the student asks "what if I switched to X," the system extracts X's rules from the bulletin on-the-fly via LLM, validates against a Zod schema, runs `degreeAudit()` against the student's transcript-from-DPR, and surfaces the result with a non-removable disclaimer.

5. **The deterministic rule engine stays in the codebase**. Used by: (a) just-in-time what-if backend, (b) DPR-failure fallback, (c) future independent operation (a long-term goal where NYU Path runs without Albert PDF input).

6. **The disclaimer plumbing already exists**: Step 15's `outputMode: "semi_hardened"` + `extractVerbatim()` + the validator's `verbatim_drift` check enforces non-removable disclaimer text. Reused unchanged for what-if disclaimers.

7. **Cohort-A target**: 10 NYU undergraduates (assumed CAS-only unless user confirms otherwise per Section 8).

### 0.3 What this phase explicitly drops from the prior roadmap

| Prior roadmap item | Status in 7-E |
|---|---|
| Step 23 — promote 4 more T2 programs (cas_history, cas_math, cas_psychology, cas_politics + Tandon) | **Dropped**. Programs not authored ahead-of-time anymore. |
| Step A self-audit pipeline (probes + cross-LLM extraction) | **Dropped**. Not needed without bulk authoring. |
| The "200-NYU-program structured-authoring effort" | **Dropped**. The DPR + just-in-time extraction handle this. |
| Step 23b — author 8 more templates (17→25) ahead of measurement | **Deferred**. Wait for Step 25 surrogate run to identify which templates are actually high-traffic. May end up adding 3, 5, or 8 — informed by data, not speculation. |

### 0.4 What this phase explicitly preserves

- Phases 0–6 engine work (degree audit, planner, prereq graph, equivalence resolver, school configs, credit-cap validator, P/F guard, GPA calculator, academic standing).
- Phase 7-A engineering ceiling (12/12 §7.1 tools, refusal cascade, file-backed session persistence).
- Phase 7-B Steps 1–3 (OGS scrape, Stern equivalencies scrape, course-catalog Postgres dump + OpenAI re-embed + semantic search wiring).
- Phase 7-B Steps 7–11 (Postgres + Drizzle adapters + email-OTP auth — dormant until ops provisions DATABASE_URL/RESEND_API_KEY/SECRET_KEY).
- Phase 7-B Steps 12–13 (OpenAI embedder + Cohere reranker, both live).
- Phase 7-B Steps 14–20 (LoopState, transitions, MAX_TOOL_RESULT_BUDGET, Tier-2/Tier-3, validator replay limit=1, output-truncation recovery, reactive compact, outputMode/verbatimText 3-layer).
- Templates (17), policy RAG corpus (636 chunks), course catalog (17,122), FOSE wrapper.

---

## 1. Verified Repo State (baseline for the diff)

Commit on main: `51e25a75`. Tests: **667 passing / 12 skipped (679 total)** across 52 test files. TypeScript clean for `packages/engine` and `apps/web`.

### 1.1 Active runtime components

| Component | Location | Status |
|---|---|---|
| Agent loop (orchestrator) | `packages/engine/src/agent/agentLoop.ts` | Live; LoopState + transitions + Tier-2/3 + validator replay all wired. |
| Response validator | `packages/engine/src/agent/responseValidator.ts` | Live; 4 checks (grounding, invocation, completeness, verbatim). |
| Tool registry + 12 tools | `packages/engine/src/agent/registry.ts` + `tools/` | Live; `runFullAuditTool`, `planSemesterTool`, `whatIfAuditTool`, `searchPolicyTool`, `searchCoursesTool`, `searchAvailabilityTool`, `getAcademicStandingTool`, `getCreditCapsTool`, `checkOverlapTool`, `checkTransferEligibilityTool`, `updateProfileTool`, `confirmProfileUpdateTool`. |
| Policy RAG | `packages/engine/src/rag/` + `apps/web/lib/policyRagSetup.ts` | Live; OpenAI embedder + Cohere reranker; 636-chunk JSONL cache. |
| Course catalog semantic search | `apps/web/lib/courseCatalogSearch.ts` + `packages/engine/src/agent/tools/semanticCourseSearch.ts` | Live; 17,122 OpenAI-embedded courses. |
| FOSE wrapper | `packages/engine/src/api/nyuClassSearch.ts` + `searchAvailability` tool | Live. |
| Templates fast-path | `preLoopDispatch` in `agent/templateMatcher.ts` | Live; 17 templates. |
| Onboarding (transcript-only) | `apps/web/app/api/onboard/route.ts` | Live; `unpdf` + `gpt-4o-mini` parses Albert unofficial transcript into `TranscriptData`. |
| v2 chat route (SSE) | `apps/web/app/api/chat/v2/route.ts` | Live; injects `student`, `profileStore`, conditional `rag` and `searchCoursesFn` into `ToolSession`. |
| Cohort gate + recovery mode | `packages/engine/src/cohort/gate.ts` | Live. |
| Session store | `packages/engine/src/persistence/sessionStore.ts` + `apps/web/lib/db/sessionStorePostgres.ts` | Live (in-memory / file-backed); Postgres adapter dormant. |
| Profile store | `packages/engine/src/persistence/profileStore.ts` + `apps/web/lib/db/profileStorePostgres.ts` | Live (in-memory); Postgres adapter dormant. |
| Observability sink | `packages/engine/src/observability/fallbackLog.ts` | Live; emits `transition`, `validator_replay`, `tool_results_compacted`, `session_compacted`, `context_limit_terminate`, `output_truncation_recovery`, `reactive_compact`. |

### 1.2 Dormant components (activate when env is provisioned)

| Component | Activation gate |
|---|---|
| PostgresSessionStore / PostgresProfileStore / PostgresCohortStore | `DATABASE_URL` env var |
| Email-OTP auth (`/api/auth/otp/issue`, `/api/auth/otp/verify`) | `RESEND_API_KEY` + `SECRET_KEY` env vars |

### 1.3 Authored programs on disk

- `data/programs/cas/cas_econ_ba.json` (T2, 200 lines)
- `data/programs/_candidates/cas_philosophy_ba.json` (T2 candidate, not promoted, 193 lines)
- Engine-bundled: `cas_core` and `cs_major_ba` in `packages/engine/src/data/programs.json`

These stay as **what-if fixtures** under the pivot.

### 1.4 Cached corpora on disk (gitignored, regenerable)

- `data/policy-corpus/policy_chunks.jsonl` (636 chunks, OpenAI-embedded)
- `data/policy-corpus/policy_chunks.meta.json`
- `data/course-catalog/course_descriptions.json` (17,122 courses)
- `data/course-catalog/course_embeddings_openai.jsonl` (17,122 vectors, 523 MB)
- `data/course-catalog/course_embeddings_openai.meta.json`

---

## 2. Architectural Diff (Before → After)

### 2.1 New canonical input artifact

**Before**: student uploads Albert unofficial transcript; agent uses authored `Program` JSON files for audit.

**After**: student uploads Albert Degree Progress Report (DPR); agent reads structured `DegreeProgressReport` for current-program audit; deterministic engine + just-in-time bulletin extraction handle what-ifs.

### 2.2 ToolSession field changes

Adding to `packages/engine/src/agent/tool.ts`:

```ts
export interface ToolSession {
  // ... existing fields (student, courses, prereqs, programs, schoolConfig,
  //                     transferIntent, pendingMutations, rag, profileStore)

  /**
   * Phase 7-E: parsed DPR. When present, run_full_audit, plan_semester,
   * and what_if_audit (current-program path) read from this. When absent,
   * tools fall back to the authored-program path.
   */
  degreeProgressReport?: import("../dpr/schema.js").DegreeProgressReport;
}
```

### 2.3 Tool primary-path changes

| Tool | Before (primary path) | After (primary path) | Fallback |
|---|---|---|---|
| `run_full_audit` | `degreeAudit(student, program, courses, schoolConfig)` over authored rules | Read directly from `session.degreeProgressReport` | Authored-rules path if DPR is missing |
| `plan_semester` | `planNextSemester` over authored `Program.rules` + prereqs | Read remaining from DPR; intersect with prereqs + FOSE + course catalog | Authored-rules path if DPR is missing |
| `what_if_audit` | Required authored `Program` for the hypothetical major | Just-in-time extract rules from bulletin → `degreeAudit` against DPR's Course History → return with non-removable disclaimer | Authored-rules path if hypothetical program is in `data/programs/` cache |

### 2.4 Onboarding flow change

**Before**:
```
POST /api/onboard
  body: { transcriptPdf }
  → unpdf + gpt-4o-mini → TranscriptData
  → returns parsedData
  → client calls /api/chat/v2 with parsedData in body
```

**After**:
```
POST /api/onboard
  body: { dprPdf }
  → unpdf + dpr-parser (no LLM) → DegreeProgressReport
  → returns parsedData (= DegreeProgressReport)
  → client calls /api/chat/v2 with parsedData in body
  → v2 route injects degreeProgressReport into ToolSession
```

(Optional fallback path retained: if the DPR parser fails, the route still accepts a transcript via the existing `unpdf` + `gpt-4o-mini` path. The student sees a "couldn't read your DPR — try uploading your transcript instead?" message.)

---

## 3. Workstream Breakdown

Each workstream lists: **goals**, **deliverables**, **acceptance gate**, **effort**.

### W1 — DPR Parser and Schema (4 days)

**Goal**: turn the verified Oracle Analytics Publisher PDF format (9-page DPR with predictable Requirement Group / Requirement / Course History conventions) into a typed object.

**Deliverables**:
- W1.1 — `packages/engine/src/dpr/schema.ts`: Zod schema for `DegreeProgressReport`. Top-level: `header`, `programs[]`, `advisorNotations[]`, `cumulative`, `requirementGroups[]`, `courseHistory[]`. Recursive `RequirementGroup → Requirement` tree with `status: "satisfied" | "not_satisfied" | "overall_not_satisfied"`, counters (`{kind: "units" | "courses" | "gpa", required, used, needed?}`), `coursesUsed[]`. (~250 lines)
- W1.2 — `packages/engine/src/dpr/parser.ts` (NOTE: located in the engine package, not `tools/dpr-parser/`, because the engine's runtime tools also need to invoke it on session restore — keeping the parser inside the engine's package boundary). TypeScript module. Uses a stateful regex walker over the raw text extracted from the DPR PDF (the PDF→text wrapper using `unpdf.extractText` lives in `tools/dpr-parser/runParser.ts` as W2.1's responsibility). Identifies section boundaries (`RGNNNNN`, `RNNNN/NN`, status keywords, counter formats, table headers). No LLM calls. (~600 lines)
- W1.3 — `packages/engine/tests/fixtures/dpr_sample.redacted.txt`: PII-redacted text-extracted version of user's sample DPR. Plus `dpr_sample.expected.json` (deterministic golden output, parsedAt + parseDurationMs excluded). Text + JSON instead of PDF + JSON because the PDF binary doesn't belong in git and the parser's contract is text-in / JSON-out.
- W1.4 — Round-trip test (`tests/eval/dprParser.test.ts`, 21 cases): every section header type, every counter format (`units / courses / gpa`), every type code (`EN / TE / IP`), every repeat code (`RI / R`), edge cases (multi-line course topics, advisor notations, ELECTIVE CREDIT special row, empty optional sections, missing-status info-only sections). Golden parse against the redacted fixture.
- W1.5 — `packages/engine/src/dpr/dprToAuditResult.ts`: adapter producing the existing `AuditResult` shape from a DPR + a target program ID. Lets the legacy `degreeAudit()` consumers (tests, what-if comparison) keep working without rewrites. 8 unit tests.
- W1.6 — Drift-guard test in `tests/eval/dprParser.test.ts` (folded into the parser test file): every section header (RG/R id) the parser claims to recognize must appear verbatim in the source text; every parsed counter value must appear with PeopleSoft's exact precision (`.toFixed(3)` for GPA, `.toFixed(2)` for units/courses); every Course History row's subject + catalogNbr must appear in source. Catches silent format changes the next time NYU IT updates Albert.
- W1.7 — Engine barrel exports the DPR module (`packages/engine/src/index.ts` + `packages/engine/src/dpr/index.ts`).

**Acceptance gate**: `npx vitest run packages/engine/tests/eval/dprParser.test.ts packages/engine/tests/eval/dprToAuditResult.test.ts` is green (29 tests); the user's sample DPR parses to a `DegreeProgressReport` whose `cumulative.cumulativeGpa === 3.402`, `cumulative.creditsUsed === 138`, `cumulative.passFailUsedUnits === 4`, `cumulative.outsideHomeUsedUnits === 14` (final field names — the original plan draft used `gpaCompleted` / `passFailUsed` / `outsideCASUsed`; the schema uses the more explicit `*Units` suffix), every requirement matches the source PDF.

**W1 status**: ✅ DONE 2026-04-27. Commit pending. Suite: 696 passing / 12 skipped (708 total), up from 667. Independent reviewer audited and signed off (PASS on all 9 claim categories: schema correctness, parser values, drift guard via injection test, edge case coverage, §2.1 compliance, TypeScript clean, fixture hygiene, plan acceptance gates). 6 P2 nits captured for opportunistic W2/W3 cleanup — none block ship.

### W2 — Onboarding Flow Update (0.75 day)

**Goal**: switch primary onboarding artifact from transcript to DPR; keep transcript path as fallback.

**Deliverables**:
- W2.1 — `apps/web/app/api/onboard/route.ts` accepts `{ dprPdf }` (multipart upload). Calls `dpr-parser`. Returns `parsedData: { kind: "dpr", report: DegreeProgressReport }`. On parser failure, returns `{ kind: "dpr_parse_failed", suggestion: "try transcript fallback" }`.
- W2.2 — Onboarding UI ([apps/web/app/](apps/web/app/)): drag-and-drop or file-picker for one PDF. Before-and-after summary screen showing parsed values: name, programs, GPA, credits, expected grad term, top-3 not-satisfied requirements.
- W2.3 — Validation: file size cap, MIME type check, parser failure fallback UX.
- W2.4 — Update [apps/web/lib/buildSession.ts](apps/web/lib/buildSession.ts): add `buildSessionFromDpr(report: DegreeProgressReport)` that produces a `StudentProfile` from the DPR's header + cumulative blocks. Existing `buildStudentProfileV2` stays as the fallback transcript path.

**Acceptance gate**: a fresh user can drop the sample DPR PDF onto the onboarding page and reach the chat with `session.degreeProgressReport` populated. The chat shows their name + program in the header.

### W3 — Tool Refactor (3.25 days)

**Goal**: rewire the audit/planner/what-if tools to read from `session.degreeProgressReport` (primary) with authored-rules fallback.

**Deliverables**:

#### W3.1 — `run_full_audit` (0.5 day)
- Refactor [packages/engine/src/agent/tools/runFullAudit.ts](packages/engine/src/agent/tools/runFullAudit.ts) to check `session.degreeProgressReport` first.
- New summarizer: list every "Not Satisfied" requirement with its remaining counter and option pool (when present in DPR). GPA + credits read from DPR cumulative block.
- `outputMode: "semi_hardened"` retained; `extractVerbatim` now reads `session.degreeProgressReport.cumulative.gpaCompleted` directly.
- Fallback: if `session.degreeProgressReport` is undefined and `session.programs` is present, use the legacy path.

#### W3.2 — `plan_semester` (1 day)
- Refactor [packages/engine/src/agent/tools/planSemester.ts](packages/engine/src/agent/tools/planSemester.ts).
- Primary path: read `session.degreeProgressReport.requirementGroups[].not_satisfied[]` + each requirement's option pool.
- For each not-satisfied requirement:
  - Look up option pool courses in `session.searchCoursesFn` to get titles/descriptions.
  - Walk `session.prereqs` to filter to courses the student qualifies to take.
  - Call `searchAvailability` (FOSE) to filter to ones open in the target term.
  - Score by impact (downstream dependencies, credit-toward-graduation, prereq-unblocking).
- Combine into a ranked plan with the existing `SuggestionEntry[]` shape.
- Fallback: legacy `planNextSemester` against authored programs.

#### W3.3 — `what_if_audit` (1.5 days)
- Refactor [packages/engine/src/agent/tools/whatIfAudit.ts](packages/engine/src/agent/tools/whatIfAudit.ts).
- Routing logic:
  1. If hypothetical `programId` exists in `data/programs/<school>/` → use authored rules + existing `whatIfAudit()` (deterministic).
  2. If `programId` exists in `data/programs/_cache/` → use cached extracted rules + `degreeAudit()` (deterministic from cache).
  3. Otherwise → call `extractProgramJustInTime()`:
     - LLM (gpt-4o-mini, low temp) reads bulletin chunk for that program (via `searchPolicyTool`'s store).
     - Emits a candidate `Program` JSON.
     - Validate against the existing `programBodySchema` (Zod).
     - On success: cache to `data/programs/_cache/<programId>.json` with `_meta.extractedAt`, `_meta.confidenceScore` (heuristic), `_meta.bulletinSourceHash`.
     - Run `degreeAudit()` against the student's transcript-from-DPR-Course-History.
- Disclaimer: the result includes `verbatimText: "This estimate is based on AI-extracted requirements from NYU's bulletin. Verify with an academic adviser before applying for an internal transfer or program change."` (consumed by the existing Step 15 verbatim-drift validator).
- Compare-with-current: when `compareWithCurrent: true`, diff against the DPR's current-program audit results.

#### W3.4 — Tool registry + ToolSession (0.25 day)
- Add `degreeProgressReport?: DegreeProgressReport` to `ToolSession` in [packages/engine/src/agent/tool.ts](packages/engine/src/agent/tool.ts).
- v2 route injects from `parsedData`.
- Engine barrel exports the new types.

**Acceptance gate**: with the sample DPR loaded, the agent can answer:
1. "What's my GPA?" → quotes 3.402 verbatim from DPR.
2. "What requirements am I missing?" → lists CSCI-UA 421 + Texts & Ideas (CORE-UA 400-499) from DPR's not-satisfied blocks.
3. "Plan my next semester" → returns a plan that respects prereqs + DPR remaining + FOSE.
4. "What if I switched to Stern Finance?" → triggers just-in-time extraction (or uses cached if available), returns an estimate with the disclaimer verbatim. Validator passes.

### W4 — Engine Compatibility / Adapter (0.75 day)

**Goal**: keep deterministic-engine path alive without making it primary.

**Deliverables**:
- W4.1 — `packages/engine/src/dpr/dprToAuditResult.ts`: adapter (already listed in W1.5; included here for clarity).
- W4.2 — `packages/engine/README.md`: architecture note explaining "DPR-first; authored Program rules are the what-if substrate + DPR-failure fallback".
- W4.3 — Confirm `degreeAudit()`, `evaluateRule()`, `creditCapValidator()`, `equivalenceResolver()`, `prereqGraph` all stay in main with their existing test coverage. Do not delete.

**Acceptance gate**: deterministic engine still passes its existing test suite.

### W5 — Test Migration (3.25 days)

**Goal**: migrate existing audit/planner/what-if tests to mock `session.degreeProgressReport` instead of `session.programs` + `session.courses`.

**Deliverables**:
- W5.1 — Test helper `tests/helpers/mkDpr.ts` that constructs `DegreeProgressReport` fixtures with shape options: `satisfied | not_satisfied | overall_not_satisfied`, in-progress courses, transfer credits, P/F usage, repeat codes, custom counters. (~200 lines)
- W5.2 — Migrate tests:
  - `runFullAudit.test.ts` (in `phase7Tools.test.ts`): rewrite to use `mkDpr()`. ~10 cases.
  - `planSemester.test.ts`: rewrite. ~8 cases.
  - `whatIfAudit.test.ts`: split into authored-program path tests (existing) + just-in-time path tests (new).
  - `auditFollowups.test.ts`, `final.test.ts`, `crossProgramAudit.test.ts`, `expanded.test.ts`: migrate where they exercise the audit/planner stack.
- W5.3 — `tests/eval/dprParser.test.ts` (W1.4 + W1.6, ~15 cases).
- W5.4 — `tests/eval/whatIfJustInTime.test.ts` (NEW, ~5 cases): exercises the just-in-time bulletin extraction + deterministic audit path with a mocked LLM client. Validates: extraction-success path, schema-validation-failure path, cache-hit path, disclaimer-presence path, audit-vs-DPR-comparison path.
- W5.5 — `tests/eval/dprDisclaimer.test.ts` (NEW, ~3 cases): asserts the verbatim disclaimer appears in what-if replies and the `verbatim_drift` validator catches paraphrased versions.
- W5.6 — Re-run full vitest suite. Target: ~700 tests passing (up from 667). All TypeChecks clean.

**Acceptance gate**: `npx vitest run` returns green; Phase 7-B Steps 14–20 tests still pass; all DPR-pivot-specific tests pass.

### W6 — Cohort-A Eval Cases (DPR-driven, 2 days)

**Goal**: rewrite the 50-case cohort-A eval set to exercise DPR-driven flow.

**Deliverables**:
- W6.1 — Author 40 new cases in `evals/cohorts/cohort_a.ts` (current 10 starter cases get reviewed for DPR-compatibility; most need minor rewording). Domain breakdown:
  - 8 audit reads (graduation tracking, GPA, credits)
  - 8 remaining-requirement queries
  - 6 plan-next-semester suggestions
  - 4 P/F-budget + outside-CAS-budget questions
  - 8 hypothetical major switches (4 to authored programs, 4 to JIT-extracted)
  - 4 hypothetical minor adds
  - 6 policy questions (RAG-only path, no DPR involvement)
  - 3 onboarding edge cases (parser failure, partial upload, mismatched studentId)
  - 3 cross-school transfer scenarios
- W6.2 — Each case includes: `userMessage`, `dprFixture` (a `mkDpr()` config), `expectedToolCalls` (e.g., `["run_full_audit", "search_policy"]`), `assertions` (regex-matchers against the reply, e.g., `/3\.402/`, `/CSCI-UA 421/`).
- W6.3 — Verify each case's `assertions` are achievable by the current pipeline before freeze.

**Acceptance gate**: ~85% of cohort-A cases pass against `gpt-4.1-mini` v2 route with the DPR pivot. Documented per-case in `evals/cohorts/cohort_a.results.md`.

### W7 — Eval-Set Freeze (Step 24, 0.5 day)

**Goal**: per ARCHITECTURE §12.6.5 line 4127, "eval cases are frozen when added." Make any future edit a deliberate, reviewable PR.

**Deliverables**:
- W7.1 — Move case data from `evals/cohorts/cohort_a.ts` → `evals/cohorts/A.json`.
- W7.2 — Add `_meta` block: `{ frozenAt, caseCount, sourceHash }` (sha256 of canonical-JSON-stringified cases).
- W7.3 — `cohort_a.ts` becomes a Zod-validated loader: reads JSON, validates against `cohortCaseSchema`, recomputes hash, asserts match. Hash mismatch fails CI.

**Acceptance gate**: `npx vitest run evals/tests/cohortA.test.ts` is green. Manual edit of `A.json` without updating hash fails CI on next run.

### W8 — Persona-Surrogate Run (Step 25, 1 day, ~$3-5 in tokens)

**Goal**: produce the first measured composite number for cohort A.

**Deliverables**:
- W8.1 — Update `evals/cohort/personaSurrogate.ts` to feed DPR-driven cases (each case provides a `dprFixture`; the surrogate runner spins up the v2 route flow with that DPR injected).
- W8.2 — Run against live `gpt-4.1-mini` on the now-frozen 50-case cohort A.
- W8.3 — Output: `evals/cohort/results/cohort_a_surrogate_<datetime>.json` with per-case verdicts + composite score.
- W8.4 — Commit `MODEL_SELECTION.md` update with the composite + the §12.6.5 "upper bound" caveat ("real cohort A may score lower because real students ask off-distribution questions").

**Acceptance gate**: composite score recorded; if ≥0.90, cohort A is unblocked; if <0.90, per-case failures categorized + remediation triaged before cohort A.

### W9 — Bakeoff (Step 22, 1.75 days, ~$10-15 in tokens)

**Goal**: re-validate that `gpt-4.1-mini` is still the right `DEFAULT_PRIMARY_MODEL` after the DPR pivot.

**Deliverables**:
- W9.1 — Author 84 bakeoff cases (32 TS-Tool + 32 TS-Synthesis + 20 TS-Decomp) — DPR-driven. Reuse `mkDpr()` helpers from W5.1.
- W9.2 — Run against `gpt-4.1-mini`, `gpt-4o-mini`, `claude-haiku-4.5`, `claude-sonnet-4.6`. Cost: ~$10-15.
- W9.3 — Aggregate per-model verdicts. If a different model wins, swap `DEFAULT_PRIMARY_MODEL` in [packages/engine/src/agent/clients/index.ts](packages/engine/src/agent/clients/index.ts) and document.

**Acceptance gate**: bakeoff results committed at `evals/bakeoff/results.md`; `DEFAULT_PRIMARY_MODEL` decision documented.

### W10 — Real-User Pilot Prep (3.25 days)

**Goal**: make the system safe to put in front of 10 real NYU students.

**Deliverables**:
- W10.1 — Privacy posture: ephemeral DPR processing (process in memory; never persist the raw PDF; opt-in localStorage for parsed JSON only). Document in `PRIVACY.md`. Include FERPA-compliance note.
- W10.2 — Onboarding tutorial: 3-screen walkthrough showing where to find DPR + how to save as PDF. Screenshots from the actual Albert UI.
- W10.3 — Persistent disclaimer: footer banner on the chat: "AI advising assistant. Not a substitute for an academic adviser. Verify all decisions with NYU advising before acting."
- W10.4 — Session-summary persistence wiring (Phase 7-A P-9 carry, already wired but unverified at scale): smoke-test that `summariesAsPriorMessage` actually prepends across multiple turns of one student's day.
- W10.5 — Per-student rate limit: 30 messages/day default (configurable). Cohort-A cost guard.
- W10.6 — Observability dashboard: simple read-only HTML page rendering `fallback_log.jsonl` events grouped by event-kind. For cohort-B precondition per §12.6.5 daily review.
- W10.7 — Cohort-A user-facing docs: 1-pager (`docs/cohort_a_users.md`) explaining what the system does, what it doesn't, when to ignore it.
- W10.8 — Smoke test: 5 personas (you + 4 synthetic) walk the full flow once. Capture every bug. Fix P0/P1 before launch.

**Acceptance gate**: 5 smoke-test personas complete the full flow without P0/P1 bugs; FERPA posture documented.

### W12 — Auth Activation (NEW, decided 2026-04-27, ~2 days + ops time)

**Goal**: turn on the dormant Phase 7-B Steps 7-11 adapters (Postgres + Resend OTP) so cohort A logs in with their NYU email and the system maintains real per-student state across sessions.

**Status of the adapters in main**: already built and tested in commit `7d0e5c4e`. They activate the moment three env vars are set. No new engineering for the adapters themselves — only ops provisioning + smoke test + UI wiring.

**Deliverables**:

#### W12.1 — Ops provisioning (USER ACTION REQUIRED, ~30 min)

The user signs up for two services and generates one secret. Cannot be automated.

| Service | Why | What you do |
|---|---|---|
| **Neon Postgres** (https://neon.tech) | Per locked-decision #1 in `nyupath_phase7b_roadmap.md`. Free tier covers cohort A → B scale. | (1) Sign up with `edoardo.mongardi18@gmail.com`. (2) Create a project (name suggestion: `nyupath-cohort-a`). (3) Copy the connection string — looks like `postgresql://user:pass@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require`. (4) Add to `.env.local` as `DATABASE_URL=...`. |
| **Resend** (https://resend.com) | Per locked-decision #2. Free tier: 100 emails/day, plenty for cohort A. | (1) Sign up with the same email. (2) Verify a sender domain or use Resend's `onboarding@resend.dev` test sender to start. (3) Generate an API key. (4) Add to `.env.local` as `RESEND_API_KEY=re_...`. |
| **JWT signing secret** | Used by the OTP token issuer. | Run `openssl rand -hex 32` in your terminal. Add output to `.env.local` as `SECRET_KEY=...`. |
| (Optional) **Admin emails list** | Lets specific accounts override cohort assignments | Add `ADMIN_EMAILS=edoardo.mongardi18@gmail.com` to `.env.local` if you want admin-tier override during cohort A. |

**Acceptance gate**: `.env.local` has all three (or four) variables set; `npx drizzle-kit push` against `DATABASE_URL` succeeds.

#### W12.2 — Schema migration (~0.25 day)

Run the existing Drizzle migrations against Neon to create the `students`, `session_summaries`, `audit_log`, `cohort_assignments`, `otp_tokens` tables. Migrations live in `apps/web/drizzle/migrations/`.

```bash
cd apps/web && npx drizzle-kit push
```

**Acceptance gate**: tables exist in Neon; `\dt` from `psql $DATABASE_URL` lists them.

#### W12.3 — Onboarding UI: email-OTP gate (~0.5 day)

Wire the existing `/api/auth/otp/issue` and `/api/auth/otp/verify` routes to the onboarding flow. The first screen the student sees becomes:

1. "Enter your `@nyu.edu` email" → calls `/api/auth/otp/issue`.
2. "Check your inbox for a 6-digit code" → calls `/api/auth/otp/verify` with the code.
3. On success: receives a JWT, stores in an httpOnly cookie, proceeds to DPR upload.

[apps/web/lib/auth/otp.ts](apps/web/lib/auth/otp.ts) already implements the issue/verify logic. Only the UI components need authoring.

**Acceptance gate**: a real student can enter their NYU email, receive a code in their inbox, type it in, and proceed to upload their DPR.

#### W12.4 — Per-student session persistence (~0.25 day)

Wire the v2 chat route to read `userId` from the JWT cookie (instead of the current `body.userId ?? "anonymous"`) and pass it to `defaultSessionStore` + `defaultProfileStore`. The Postgres adapter activates automatically once `DATABASE_URL` is set.

**Acceptance gate**: a student logs in, uploads their DPR, has a chat conversation, closes the browser, opens it again 24 hours later, logs back in with a fresh OTP, and sees their prior conversation summary loaded as a system message.

#### W12.5 — Cohort assignment via admin UI (~0.5 day)

Build a simple admin-only page at `/admin/cohorts` that lists all students and lets admins (matched against `ADMIN_EMAILS`) assign them to a cohort (`alpha` / `limited`). Required for cohort A so we can route specific students through the cohort gate.

Backend already exists (`packages/engine/src/cohort/gate.ts` + `apps/web/lib/db/cohortStorePostgres.ts`). Only the admin UI needs authoring.

**Acceptance gate**: admin can view the student list and toggle cohort assignment; the change is reflected in the student's next chat session.

#### W12.6 — Auth smoke test (~0.25 day)

End-to-end test: 5 personas (one is you, four are synthetic NYU emails using Gmail+ aliases or Resend test addresses) walk through email → OTP → DPR upload → chat → logout → login → resume chat. Capture every bug.

**Acceptance gate**: zero P0/P1 bugs; smoke-test report committed at `evals/auth_smoke_test.md`.

**Workstream W12 total: ~2 days of engineering + ~30 min of ops by the user.**

---

### W11 — Independent Reviewer Audit (Step 26, 1.25 days)

**Goal**: independent verification of the pivot.

**Deliverables**:
- W11.1 — Spawn a reviewer agent (existing `code-reviewer` subagent or `claude-opus` direct) with a Phase 7-E-specific prompt: verify (a) DPR parser correctness on the sample, (b) tool refactor preserves Cardinal Rule §2.1, (c) just-in-time extraction has the disclaimer wired, (d) cohort-A cases are frozen with hash check, (e) surrogate run was actually executed, (f) all Phase 7-B Steps 14-20 still operate.
- W11.2 — Reviewer report at `evals/reviewer/phase_7e_audit.md`: PASS/FAIL per claim with evidence cited.
- W11.3 — Address P0/P1 findings before launch.

**Acceptance gate**: reviewer report committed; P0/P1 findings closed.

---

## 4. End-to-End Acceptance Definition

Phase 7-E is "ready for cohort-A real-user end-to-end test" when ALL of the following are true:

1. ✅ Workstreams W1–W12 acceptance gates met.
2. ✅ A new student signs in via NYU email + OTP, uploads their DPR, and reaches the chat.
3. ✅ The agent answers all 50 cohort-A cases correctly under live `gpt-4.1-mini`.
4. ✅ Composite ≥ 0.90 on the persona surrogate (W8). If <0.90 but ≥0.85, document per-case failures + manual triage acceptable.
5. ✅ Validator catches 100% of injected ungrounded numbers in adversarial test cases.
6. ✅ Disclaimer appears verbatim on every just-in-time-extracted what-if reply (W5.5).
7. ✅ Session summaries persist across page reloads (W10.4).
8. ✅ Smoke test (W10.8) clean.
9. ✅ Reviewer audit (W11) PASS.
10. ✅ FERPA posture (W10.1) documented.
11. ✅ Auth flow (W12): student logs in with NYU email + OTP, session persists across logout/login, admin can assign cohorts.

---

## 5. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Albert DPR format changes (NYU IT push) | Medium | High | Drift-guard test (W1.6) catches it on next CI run; parser is one focused module; ~half-day to update. |
| Just-in-time extraction misreads bulletin (silently wrong what-if) | Medium | Medium | Disclaimer is non-removable; cached extractions can be promoted to authored programs after human spot-check; cohort-A cases include adversarial what-if cases (W5.4). |
| DPR parser fails on a non-CAS school's variant format | Medium (if cohort A is mixed) | Medium | Transcript fallback path retained (W2.1); document parser limits in `PRIVACY.md`. |
| Cohort-A surrogate composite <0.90 | Low | High | Per-case failure triage; if <0.85, defer cohort A and remediate; if 0.85-0.90, document risk + proceed with smaller pilot (3-5 students). |
| User uploads PDF with PII not redacted | High | Medium (FERPA) | Onboarding UI explicitly says "your name and N-number stay in the file; we process locally and don't persist the raw PDF"; ephemeral processing per W10.1. |
| Cost spike from JIT extraction (multiple what-ifs per session) | Low | Low | JIT extraction caches per-program; second student asking about Stern Finance hits the cache for free. Per-student rate limit (W10.5). |
| Tier-3 graceful termination fires too aggressively under heavy DPR + RAG load | Low | Low | DPR is ~5k tokens; RAG retrieval is ~3k tokens; well under 80% of 128k window. Monitor in observability (W10.6); raise window estimate if false positives. |

---

## 6. What Becomes Inactive / Repurposed (detail)

### 6.1 Deprioritized but kept

| Component | New role |
|---|---|
| `data/programs/cas/cas_econ_ba.json` | What-if fixture |
| `data/programs/_candidates/cas_philosophy_ba.json` | What-if fixture (may never promote) |
| Engine-bundled `cas_core` + `cs_major_ba` programs | What-if fixtures |
| `degreeAudit()` engine | Backend for just-in-time what-if + DPR-failure fallback + future independent operation |
| `evaluateRule()` and 4 rule evaluators | Same as `degreeAudit()` |
| `creditCapValidator` | Used by planner; otherwise sidelined |
| `gpaCalculator`, `passfailGuard`, `spsEnrollmentGuard`, `academicStanding` | Sidelined for current-program audits (DPR has these); preserved for fallback |
| `equivalenceResolver` | Sidelined for current-program (DPR shows TE rows); used by what-if when bulletin says "or equivalent" |
| `prereqGraph` | Still actively used by the refactored planner |
| `priorityScorer` + `semesterPlanner` + `graduationRisk` | Refactored to read DPR remaining; scoring + scheduling kept |
| `Rule[]` schema in `shared/types.ts` | Used by what-if for extracted rules |
| `apps/web/lib/buildSession.ts` (`buildStudentProfileV2`) | Inactive in DPR-first onboarding; kept as transcript-fallback path |
| Existing transcript-parsing inside `/api/onboard` (`unpdf` + `gpt-4o-mini`) | Inactive in DPR-first onboarding; kept as fallback |

### 6.2 Inactive in main, never invoked at runtime in 7-E

| Component | Activation gate |
|---|---|
| Postgres adapters (Phase 7-B Steps 7-11) | `DATABASE_URL` |
| Email-OTP auth | `RESEND_API_KEY` + `SECRET_KEY` |
| Playwright scraper | One-shot tool |
| Policy-corpus embed tool | One-shot tool |
| Course-catalog embed tool | One-shot tool |
| Rerank calibration tool | Diagnostic |

### 6.3 Dropped (never built, planned only)

| Item | Reason |
|---|---|
| Step A self-audit pipeline (probes + cross-LLM extraction enhancement) | Not needed without bulk authoring |
| Step 23 (4 more T2 programs) | Not needed without bulk authoring |
| Step 23b (templates 17→25 ahead of measurement) | Deferred until Step 25 reveals which templates are high-value |
| Browser extension (Tier 2 of prior pivot proposal) | Not needed when student only uploads one file 3-4×/year |
| Agentic browser auto-navigation (Tier 3 of prior pivot proposal) | TOS-fraught + credential-handling risk; not needed |
| The "200 NYU programs structured authoring" plan | Eliminated by DPR pivot |

### 6.4 Future cleanup (after cohort-A validates DPR-only flow)

These get **removed** in cohort-B prep, not in Phase 7-E:

- `tools/program-extractor/extract.ts`, `promote.ts`, `prompt.md` — entire offline extraction CLI
- `data/programs/_candidates/` workflow
- Transcript parser code path in `/api/onboard`
- `buildStudentProfileV2` in `buildSession.ts`
- ~600 lines of code total

Trigger for cleanup: cohort A runs 4 weeks, DPR-failure rate <2%, no fallback invocations needed.

---

## 7. Timeline Summary

| Workstream | Days | Critical-path? |
|---|---|---|
| W1 — DPR parser + schema | 4 | Yes |
| W2 — Onboarding flow update | 0.75 | Yes (after W1) |
| W3 — Tool refactor | 3.25 | Yes (after W1) |
| W4 — Engine compatibility | 0.75 | Parallel with W3 |
| W5 — Test migration | 3.25 | Parallel with W3, completes after W3 |
| W6 — Cohort-A eval cases | 2 | After W5 |
| W7 — Eval-set freeze | 0.5 | After W6 |
| W8 — Persona-surrogate run | 1 | After W7 |
| W9 — Bakeoff | 1.75 | Parallel with W8 |
| W10 — Real-user pilot prep | 3.25 | Parallel with W6-W9 |
| W12 — Auth activation (NEW) | 2 | Parallel with W6-W10 (depends only on user ops setup) |
| W11 — Reviewer audit | 1.25 | After W10 + W12 |
| **Total (linear)** | **~23.75 days** | |
| **Total (with aggressive parallelization)** | **~17-19 days** | |

Realistic calendar with one operator: **~4-5 weeks** if linear; **~3-3.5 weeks** with parallelization.

API-token budget across W8 + W9: **~$15-25 total**. Resend + Neon free tiers cover cohort A with $0 ongoing cost.

---

## 8. Things Needing User Decision (BLOCKING — answer before W1 starts)

Per the user's `feedback_no_skip_or_delay` rule, these are stop-and-ask items, not defaults-and-proceed.

| # | Decision | Default if user prefers | Impact |
|---|---|---|---|
| 1 | **Cohort-A composition**: CAS-only (your school) or mixed across NYU undergrad schools? | CAS-only | Affects W1.3 (parser fixtures from non-CAS schools) and W6 (case domains) |
| 2 | **DPR samples from non-CAS undergrad schools** (Tisch, Tandon, Steinhardt, Gallatin, Liberal Studies, Stern, SPS): can you provide one redacted sample from each, or build CAS-only first? | Build CAS-only first; iterate | Same as #1 |
| 3 | **Privacy posture**: ephemeral DPR processing only (process in memory, never persist raw PDF), OR opt-in persistent localStorage of parsed DPR JSON? | Ephemeral by default; opt-in persistence | Affects W10.1 + ferpa documentation |
| 4 | **Cohort-A pilot size**: 10 (per §12.6.5 floor) or smaller (3-5) for a faster first signal? | 10 | Affects launch readiness threshold |
| 5 | **Pilot launch date target**: end of Phase 7-E (~4 weeks) or earlier with reduced scope? | End of Phase 7-E | Affects whether we can defer W9 (bakeoff) |
| 6 | **Budget approval for surrogate + bakeoff** (~$15-25 total in API tokens) | Proceed | Required for W8 + W9 |
| 7 | **Auth posture for cohort A**: ~~anonymous mode~~ → **DECIDED 2026-04-27**: real auth required so we can exercise auth functionality end-to-end. Adds workstream W12 below. | — | Adds W12 (~2 days) + ops setup of Neon + Resend |

---

## 9. After Phase 7-E

Once Phase 7-E lands, the next blockers are:

- **Cohort-A execution (real users)**: 10 NYU undergrads use the system for ~2-4 weeks. We watch the observability dashboard daily, log issues, fix as they come up.
- **Cohort-A composite measurement (real)**: same surrogate methodology run on real conversation transcripts (not surrogate). Compare to surrogate composite. Confirms the §12.6.5 4134 "upper bound" assumption.
- **Cohort-B preconditions (per §12.6.5)**: documented daily fallback-log review; validated session-store at scale; legal/FERPA review if scaling beyond 10 students.

After cohort A validates:

- Future cleanup: remove transcript parser path + program-extractor offline CLI + candidates workflow.
- Optional: build the browser extension Tier 2 to remove the 3-4×/year manual DPR re-upload friction. ~5-7 days.
- Future: explore Stellic API integration when CAS migrates (2026-2027). NYU IT engagement required.
- Long-term: if NYU Path is to operate independently of Albert PDFs (e.g., for prospective students researching majors before enrolling), the deterministic engine + program extraction pipeline preserved in this phase becomes the basis. The cs_major_ba T1, cas_econ_ba T2, plus any cached just-in-time extractions accumulated during cohort A become the seed corpus.

---

## 10. Operational Notes

### 10.1 Branch + commit strategy

- Work on main directly per the project's existing pattern (no feature branch).
- One commit per workstream completion (W1, W2, ...).
- After W11 PASS: tag the release as `phase_7e_cohort_a_ready`.

### 10.2 Memory hygiene

- Update `~/.claude/projects/-Users-edoardomongardi/memory/nyupath_phase7b_roadmap.md` to mark steps 21-26 as superseded by this Phase 7-E plan.
- Update `MEMORY.md` index entry pointing to this plan as the canonical next-steps document.

### 10.3 Where this plan lives

This file (`PHASE_7E_PLAN.md`) is committed to the repo root for review + revision. It is the single source of truth for the pivot scope. Any deviation from this plan is a deliberate decision recorded in commit messages.

---

## 11. Sign-off

Before W1 begins, this plan needs:

- [ ] User answers Section 8 questions 1-6 (question 7 is decided 2026-04-27 → real auth via W12)
- [ ] User confirms Phase 7-E scope matches expectations
- [ ] User confirms timeline + budget (~4-5 weeks, ~$15-25 in API tokens, $0 ongoing infrastructure cost on free tiers)
- [ ] User has provisioned `DATABASE_URL` (Neon), `RESEND_API_KEY` (Resend), `SECRET_KEY` (`openssl rand -hex 32`) per W12.1

After sign-off, the next concrete action is W1.1: write `packages/engine/src/dpr/schema.ts` with the `DegreeProgressReport` Zod schema, using the user's redacted sample DPR as the reference fixture.

W12.1 (ops setup) can begin in parallel with W1 — the user provisions Neon + Resend while engineering work starts on the parser. They converge at W12.2 (schema migration).
