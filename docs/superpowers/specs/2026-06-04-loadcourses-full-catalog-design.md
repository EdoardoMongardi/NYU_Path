# Step 8d — `loadCourses` → full undergraduate catalog

**Date:** 2026-06-04
**Status:** Design approved; PR-1 pending implementation
**Branch:** `feat/loadcourses-full-catalog` (from `main` @ #23 merge)

## Problem

`loadCourses()` returns an 85-course hand-curated stub
(`packages/engine/src/data/courses.json`). The forward-schedule solver builds
its `courseCatalog` (a `Map<id, {title, credits}>`) from this. When a
DPR-referenced candidate course is absent (`solver.ts:891-897`), the solver
**abandons placing a real course and emits a placeholder** — which, with only 85
courses, is almost always. Result: plans full of unnamed placeholder slots.

## Verified facts (the design rests on these)

- The in-repo raw bulletin `data/bulletin-raw/courses/<subject>/_index.md`
  carries structured per-course fields in a consistent format:
  `**<CODE>**  **<TITLE>**  **(<N> Credits)**`, plus a `**Typically offered*…*`
  line, `**Grading:** …`, and `**Repeatable for additional credit:** Yes/No`.
- **Credit coverage: 17,101 / 17,122 (99.9%)** of the semantic-search catalog
  (`data/course-catalog/course_descriptions.json`) carry explicit bulletin
  credits. (An initial 91.5% reading was a regex bug — a course-code pattern
  that disallowed digit-bearing subject prefixes like `REAL1-UC`, `TCHT1-UC`,
  `GLOB1-…`. The digit-tolerant pattern recovers them.)
- Only **21** courses are truly credit-less (9 graduate `-G*`, the rest scattered
  format anomalies) — negligible, and out of undergrad scope anyway.
- **Undergrad scope = 8,531 courses** (school segment matches `U[A-Z]` or `SHU`).
  Excluded: 6,886 graduate `-G*`; 1,684 professional/continuing (`LW` law, `MD`
  med, `DN` dental, `ML`, `CS`/`NY`/`NA`/`NE`/`NI` continuing-ed, all ≥9000-level).
- Credits: `4` (7,443), `3`, `2`, `1`, `1.5`; **392 undergrad variable-credit**
  (`1-4`, `0-3`, `2-4`); **211 undergrad 0-credit** (labs/recitations).
- Prereqs are **already parsed** → `prereqs.json` (7,083 entries). The new parser
  **skips prereqs**.
- Established precedent: `tools/bulletin-parser/extractOfferings.ts` already
  parses this markdown into a committed `packages/engine/src/data/courses-offerings.json`.
  New work follows the same conventions (dir-matcher, unpadded course-id form,
  pure regex / no LLM).
- `Course` fields the bulletin lacks: `crossListed` (only consumer is
  `equivalenceResolver.ts`, reduced post-8b), `exclusions` (no solver consumer —
  the `planChangeHelpers` matches are a different preferences type),
  `catalogYearsActive` (no consumers). `departments` (used by
  `creditCapValidator` CSCI detection) is **derivable from the code prefix**.

## Scope

**PR-1 (this spec): catalog expansion.** PR-2 (stacked, separate spec):
solver pin-path softening.

## Design — PR-1

### 1. `tools/bulletin-parser/extractCourses.ts` (new)

Follows `extractOfferings.ts`. Pure regex, no LLM.

- **Glob:** `data/bulletin-raw/courses/*/_index.md`, all subject dirs (dir-matcher
  `^[a-z][a-z0-9]*_<suffix>$` already tolerates `real1_uc` etc.).
- **Header regex (digit-tolerant):** captures CODE / TITLE / credits from
  `**<CODE>**  **<TITLE>**  **(<N|range> Credits)**`.
- **Per-course parse → `Course`:**
  - `id` — canonical unpadded bulletin form (e.g. `CSCI-UA 101`).
  - `title`.
  - `credits` — **max** of a range (`1-4` → 4); single value otherwise.
  - `creditsMin` / `creditsMax` — always set (equal when not a range).
  - `termsOffered` — reuse the offerings "Typically offered" term parser.
  - `departments` — derived from the code prefix (e.g. `CSCI-UA` → `["CSCI-UA"]`).
  - `grading` — from `**Grading:** …`.
  - `repeatableForCredit` — boolean from `**Repeatable for additional credit:** Yes/No`.
  - prereqs — **skipped** (in `prereqs.json`).
- **Scope filter:** undergrad only — school segment matches `U[A-Z]` or `SHU`.
  Excludes grad `G*` + professional schools.
- **Overlay:** for the ~85 codes present in the current curated stub, preserve
  their `crossListed` / `exclusions` / `catalogYearsActive`. Bulletin-absent
  fields default to `[]` (and a default `catalogYearsActive` range).
- **Output:** writes `packages/engine/src/data/courses.json` (the tracked
  artifact `loadCourses()` already reads — transparent to all consumers). Source
  markdown stays gitignored/local; regenerated JSON is committed (same pattern as
  `prereqs.json` / `courses-offerings.json`).
- **Run:** `npx tsx tools/bulletin-parser/extractCourses.ts`. Logs counts +
  what was dropped (grad/professional/anomalies) — no silent truncation.

### 2. `Course` type extension (`packages/shared/src/types.ts`)

Add optional, backward-compatible fields:

```ts
creditsMin?: number;
creditsMax?: number;
grading?: string;             // e.g. "CAS Graded", "UC SPS Graded"
repeatableForCredit?: boolean;
```

The solver still reads `credits`. Extras are recorded for future use. The 85-stub
(and any other producer) omitting them stays valid.

### 3. `loadCourses()`

No signature change — still reads `courses.json`; the artifact is just larger.
Update the doc comment to note the catalog is now bulletin-sourced (~8.5k undergrad).

### 4. Tests

- **Parser unit** (`tools/bulletin-parser/extractCourses.test.ts`): fixture
  markdown block → expected `Course` — covers a fixed-credit course, a
  variable-credit course (`credits === creditsMax`), grading, repeatable,
  department-from-code, and the digit-prefix case (`REAL1-UC`).
- **Catalog coverage** (`packages/engine/tests/eval/…`): `loadCourses()` returns
  ~8,531 courses; spot-checks `CSCI-UA 101` credits = 4; a known variable course's
  `creditsMax`; `REAL1-UC` present; **no `-G*` leaks**; every course `credits >= 0`
  and the non-zero-credit majority `> 0`.
- **Cohort A re-freeze:** if any frozen cohort case output shifts (the larger
  catalog can change which courses bind vs placeholder), re-freeze via
  `npx tsx tools/cohort-freeze/freeze.ts freeze a --note "8d full catalog"`.

### 5. Verification

`cd packages/engine && npx tsc --noEmit`; `cd apps/web && npx tsc --noEmit`;
`npx vitest run` from repo root; then the live RAG rig
(`tools/live-rag-test.ts`) as a smoke check that planner-touching paths still
answer.

## Out of scope (→ PR-2)

Solver pin-path softening (`solver.ts:778-786`): replace the hard
`"Pinned course not in catalog"` violation with resolve-on-demand credits, else
place with student-confirmed credits + a "verify in Albert" caveat. Auto-planning
stays catalog-only. PR-2 depends on PR-1's full catalog as its credit-resolution
source.

## Risks / notes

- **Variable-credit `max` policy** may overstate credits toward graduation for the
  392 range courses; `creditsMin`/`creditsMax` are retained so a later UI/solver
  refinement can disambiguate. Accepted for PR-1.
- **Artifact size:** ~8.5k structured records (no descriptions — those stay in
  `course_descriptions.json`, single source of truth). Expected well under the
  13 MB semantic dump.
- The 21 truly credit-less courses are dropped from the auto-catalog; if ever
  pinned, PR-2's resolve-or-ask path handles them.
