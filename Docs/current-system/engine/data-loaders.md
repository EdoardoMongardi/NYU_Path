# Data Loader Subsystem

> Last verified against code: 2026-06-13 (doc-sync pass: corrected §7 ToolSession/catalog/schoolConfig route.ts line citations).

## Purpose

The engine needs a handful of reference datasets to do its job: the full undergraduate course catalog, prerequisite rules, term-offering history, off-catalog credit values, and the per-school policy configs. All of that lives in JSON files on disk. This subsystem is the small set of functions that read those files and hand the data back as typed objects the planner and tools consume.

It is much smaller than it once was. The pre-rebuild data layer carried a dozen loaders (programs, catalog-year, transfers, tiers, departments) plus several static lookup tables (exam equivalencies, CORE-UA ranges, course-suffix accessibility). Most of those modules have been **deleted** — the engine no longer authors per-program rule files or runs a deterministic rule engine; it reads the student's DPR as the authoritative tier and the bulletin RAG corpus as a cited fallback. What remains is the bundled catalog loaders in `dataLoader.ts` plus the school-config loader.

```mermaid
flowchart LR
    Disk[JSON files on disk] --> Read[readFileSync + JSON.parse]
    Read --> Validate[validate _meta + body<br/>school config only]
    Validate --> Memory[typed objects for engine]
```

---

## 1. Overview

The data loader subsystem is the engine's bridge between on-disk JSON and the in-memory objects the planner and tools consume. There is no boot routine and no singleton cache **inside the engine** — each loader call performs a fresh `readFileSync` + `JSON.parse`. The web app caches the catalog at module scope (`apps/web/lib/loadCatalog.ts`), but the engine loaders themselves are stateless and re-entrant.

### Entry point

`packages/engine/src/dataLoader.ts` is the canonical import surface (`@nyupath/engine` re-exports `loadCourses`, `loadPrereqs`, `loadSchoolConfig`). It defines exactly four read functions and re-exports the school-config loader:

| Function | File read | Returns |
|---|---|---|
| `loadCourses()` | `packages/engine/src/data/courses.json` | `Course[]` |
| `loadPrereqs()` | `packages/engine/src/data/prereqs.json` | `Prerequisite[]` |
| `loadOfferings()` | `packages/engine/src/data/courses-offerings.json` | `Map<courseId, { termsOffered, confidence }>` |
| `loadOffCatalogCredits()` | `packages/engine/src/data/off-catalog-credits.json` | `Map<courseId, { title, credits }>` |
| `loadSchoolConfig` / `loadSchoolConfigStrict` | re-exported from `data/schoolConfigLoader.ts` | see §4 |

All four bundled loaders resolve their files from `__dirname/data` (`dataLoader.ts:17-18`) — i.e. the engine's own `src/data/` directory. They do **no** provenance or shape validation; the bundled JSON is trusted and cast straight to the shared types.

### Two on-disk roots

| Root | Resolved from | Contents |
|---|---|---|
| `packages/engine/src/data/` | `__dirname/data` in `dataLoader.ts:17-18` | Bundled datasets: `courses.json`, `prereqs.json`, `courses-offerings.json`, `off-catalog-credits.json`, `course_catalog_full.json` (raw extract, unused by these loaders) |
| `<repo>/data/` | `__dirname/../../../../data` in `schoolConfigLoader.ts:27-28` | Per-school configs under `data/schools/`, plus `data/programs/`, `data/bulletin-raw/`, `data/course-catalog/`, `data/policy-corpus/` (the latter four are consumed by the RAG/corpus build, not by these loaders) |

> **Known limitation — no caching in the engine.** Every engine loader re-reads its file on each call. Request-lifetime caching is the caller's responsibility; the web app does this in `apps/web/lib/loadCatalog.ts` (module-scope cache of `loadCourses()` + `loadPrereqs()`).

---

## 2. Bundled catalog loaders (`dataLoader.ts`)

### `loadCourses()` (dataLoader.ts:20-23)

**File:** `packages/engine/src/data/courses.json` — **8,558 undergraduate course entries**.

**Output:** `Course[]` (shared type). Each entry carries `id`, `title`, `credits`, `departments`, `crossListed`, `exclusions`, `termsOffered`, `catalogYearsActive`, and the rebuild-era fields **`creditsMin` / `creditsMax`** (variable-credit courses), **`grading`** (e.g. `"FAS Graded"`), and **`repeatableForCredit`** (boolean). No normalization — the JSON is cast directly.

### `loadPrereqs()` (dataLoader.ts:25-28)

**File:** `packages/engine/src/data/prereqs.json` — **7,083 entries**.

**Output:** `Prerequisite[]`. Each entry is `{ course, prereqGroups, coreqs }` — note both prerequisites **and corequisites** are carried per course. Cast directly, no validation.

### `loadOfferings()` (dataLoader.ts:36-44)

**File:** `packages/engine/src/data/courses-offerings.json` — **7,963 entries**.

**Output:** `Map<string, { termsOffered: Season[]; confidence: ConfidenceTier }>` where `Season = "fall" | "spring" | "summer" | "january"`.

This wiring is load-bearing for the planner: the forward solver consults it via `SolverInput.offerings` and `SolverInput.offeringConfidence` to enforce terms-offered (`dataLoader.ts:30-35` comment). `confidence` is the rebuild-era confidence tier (shared type `ConfidenceTier`, `packages/shared/src/types.ts:700-706`): `historically_likely`, `historically_partial`, `irregular`, `restricted`, `permission_only`, `confirmed`. The dataset as shipped uses the first five (no `confirmed` rows today).

### `loadOffCatalogCredits()` (dataLoader.ts:53-61)

**File:** `packages/engine/src/data/off-catalog-credits.json` — **8,570 entries** (graduate/professional courses outside the undergraduate planning catalog, keyed by courseId, e.g. `ACCT-GB 2103`).

**Output:** `Map<string, { title: string; credits: number }>`.

**Purpose (the softened pin path):** this exists solely to resolve an explicit student **pin** of an off-catalog course. When a student pins a graduate course the undergrad catalog doesn't carry, the solver uses this map to place it with real credits plus a "verify in Albert" caveat instead of silently dropping it (`dataLoader.ts:46-52` comment). Generated by `tools/bulletin-parser/extractCourses.ts`.

---

## 3. School config loader (`data/schoolConfigLoader.ts`)

**File it reads:** `<repo>/data/schools/<schoolId>.json` (`schoolConfigLoader.ts:49`).

### `loadSchoolConfigStrict(schoolId, opts?)` (schoolConfigLoader.ts:44-115)

Discriminated-union loader — the only loader in the subsystem that validates.

**Output shape:**
```
{ ok: true,  config: SchoolConfig, meta: Meta, path }
| { ok: false, reason: "not_found",    schoolId, path }
| { ok: false, reason: "parse_error",  schoolId, path, error }
| { ok: false, reason: "invalid_meta", schoolId, path, errors }
| { ok: false, reason: "invalid_body", schoolId, path, errors }
```

**Validation pattern:**

1. `existsSync` check → `not_found` (schoolConfigLoader.ts:51-53).
2. `readFileSync` in try/catch → `parse_error` (schoolConfigLoader.ts:55-66).
3. `JSON.parse` in try/catch → `parse_error` (schoolConfigLoader.ts:68-79).
4. `validateFileWithMeta` from `provenance/schema.ts` validates the top-level `_meta` block → `invalid_meta` (schoolConfigLoader.ts:81-90).
5. Strip `_meta`, `_provenance`, `_notes` (schoolConfigLoader.ts:93-94).
6. **Zod body validation** via `validateSchoolConfigBody` from `provenance/configSchema.ts` → `invalid_body` (schoolConfigLoader.ts:98-107). This catches field-name typos and shape drift that the bare cast used to miss.
7. On success, return the typed `SchoolConfig`, the parsed `Meta`, and the source path.

### `loadSchoolConfig(schoolId, opts?)` (schoolConfigLoader.ts:125-145)

Convenience wrapper: returns `config` on success, or `null` on any failure after logging a single-line JSON warning to `console.warn` under the `[school_config]` tag. Built for the "CAS fallback" pattern — but note (see §3a) the de-CAS work means most engine modules now read shared defaults from `data/schoolDefaults.ts` rather than `CAS_DEFAULTS`.

### 3a. The eleven school configs (post-8e shape)

There are now **11 config files** in `data/schools/`: `cas`, `gallatin`, `liberal_studies`, `nursing`, `nyuad`, `shanghai`, `sps`, `steinhardt`, `stern`, `tandon`, `tisch`. (Pre-rebuild only `cas`, `stern`, `tandon` existed — a frequent source of stale "only three configs" claims in older docs.)

The post-8e body shape carries:

- **`completionRatePolicy`** — `{ goodStandingThreshold, dismissalThreshold?, dismissalAfterSemesters?, basis }`. Present in 7 of 11 configs (absent in `nursing`, `steinhardt`, `stern`, `tandon`).
- **`creditCaps`** — array of cap entries `{ type, maxCredits, label, ... }`. Present in all 11. SPS divisions carry an **`appliesTo`** field that scopes a cap to a named division (e.g. `"Division of Applied Undergraduate Studies (DAUS) — bachelor's"`) — this is how the same cap `type` (`advanced_standing`) can have different ceilings per SPS division.
- **`doubleCounting`** — present in **exactly four** configs: `cas`, `shanghai`, `nyuad`, `sps` (added by PR #41). The other seven omit it.
- Registration constants `maxCreditsPerSemester`, `f1FullTimeMinCredits`, plus `residency`, `passFail`, `transferCreditLimits`, `maxCourseRepeats`, `deansListThreshold`, `overloadRequirements`, and `spsPolicy` where relevant.

**Deleted in 8e** (do not expect these on any config): `overallGpaMin`, `degreeType`, `auditMode`, `lifecycle`. The DPR carries the per-student equivalents (e.g. `cumulativeGpaRequired`), so the config no longer authors them.

---

## 4. Shared registration defaults (`data/schoolDefaults.ts`)

Not a JSON loader — a constants module added by the de-CAS work (Phase E). NYU Path serves all undergraduate schools, and most per-school caps a student needs already live on their DPR (`creditsRequired`, `cumulativeGpaRequired`, `residencyRequired`, `passFailCapUnits`, `outsideHomeCapUnits`, `timeLimitYears`). Only two registration constants are genuinely not in the DPR and are near-universal, so they live here as shared defaults:

- `DEFAULT_PER_SEMESTER_CEILING = 18`, `DEFAULT_F1_FULLTIME_MIN_CREDITS = 12`.
- `DEFAULT_CREDIT_TARGET_PER_SEMESTER = 16`, `DEFAULT_DOMESTIC_PARTTIME_FLOOR = 8`.
- `PER_SEMESTER_CEILING_OVERRIDES` — a **sparse** override map, **empty today** (a school that genuinely differs gets an entry here rather than a whole authored config file).
- `perSemesterCeilingFor(homeSchool)` resolves the override or the default.
- `SCHOOL_DISPLAY_NAMES` + `schoolDisplayName(homeSchool)` — full user-facing school names (falls back to a generic `"NYU"` when the school is unknown rather than asserting CAS). Consumed by the system prompt and `get_credit_caps`.

---

## 5. Remaining static-data modules in `data/`

Two pure helper modules survive the rebuild. Neither reads a JSON file.

### `data/foseTerm.ts` — NYU class-search term codec

The single source of truth for NYU's 4-digit class-search term-code format. Term-digit table: `spring → 4`, `summer → 6`, `fall → 8`. Encoded code is `"1" + (year % 100, zero-padded) + termDigit`.

- `encodeFoseTerm(year, term)` — validates year in `[2000, 2099]` and a known term; throws `RangeError` otherwise.
- `decodeFoseTerm(code)` — accepts only `/^1\d{2}[468]$/`, else `null`; year is `2000 + yy`.
- `foseTermLabel(code)` — renders e.g. `"Fall 2026"` or `null`.

Consumed by the class-search/availability path (section materialization's FOSE gate).

### `data/courseSuffixMap.ts` — course accessibility classifier

Static lookup tables plus `classifyCourseAccessibility(courseId, homeSchool?)`. Maps the suffix after the dash in a course id (the `UA` in `CSCI-UA 101`) to school metadata `{ school, undergrad, globalSite }`, and classifies a course as `home` / `cross_school` / `global_site` / `graduate` / `unknown` relative to the student's home school. `HOME_SCHOOL_TO_SUFFIX` is the inverse direction (cas, stern, tandon, steinhardt, tisch, gallatin, ls). Used by the course-search tools to label results.

> **Known limitations — modules deleted in the rebuild.** The following loaders and static tables documented in the pre-rebuild version of this file **no longer exist** and have no replacement under `data/`:
> - `data/programLoader.ts`, `data/catalogYearLoader.ts` (`loadProgramFromDataDir`, `resolveProgramFile`, `applicableCatalogYear`) — the engine no longer loads per-program rule JSON for a deterministic audit. (`apps/web` does its own catalog-year handling against the DPR.)
> - `data/transferLoader.ts` (`loadTransferRequirements`, `loadNyuInternalTransferPolicy`) — gone with the `check_transfer_eligibility` tool.
> - `data/tierLoader.ts` (`loadProgramTier`, `isT3Program`) — the T1/T2/T3 tier switch is gone; the DPR-first / RAG-fallback doctrine replaced it.
> - `data/departmentLoader.ts` (`loadDepartmentConfig`) — the precedence-reducer stub was removed.
> - `data/examEquivalencies.ts` (`resolveExamCredit`, `EXAM_GENERAL_RULES`) and `data/coreUaRanges.ts` (`classifyCoreUa`, etc.) — both removed; exam-credit and CORE-UA classification are no longer engine concerns.
> - The `resolveFact` precedence reducer in `dataLoader.ts` is also gone.
> If you need the program/requirement source of truth today, it is the parsed DPR (`packages/engine/src/dpr/`) plus the bulletin RAG corpus (`packages/engine/src/rag/`), not a program loader.

---

## 6. On-disk data inventory

**`packages/engine/src/data/` (bundled, read by `dataLoader.ts`)**

| File | Entries | Loader |
|---|---|---|
| `courses.json` | 8,558 | `loadCourses` |
| `prereqs.json` | 7,083 | `loadPrereqs` |
| `courses-offerings.json` | 7,963 | `loadOfferings` |
| `off-catalog-credits.json` | 8,570 | `loadOffCatalogCredits` |
| `course_catalog_full.json` | (raw extract) | none — staging input, not loaded at runtime |

**`<repo>/data/` (read outside this subsystem)**

- `schools/` — 11 `<schoolId>.json` configs for `schoolConfigLoader`.
- `programs/`, `bulletin-raw/`, `course-catalog/`, `policy-corpus/` — consumed by the RAG corpus build and `apps/web`, not by the loaders documented here.

---

## 7. How the catalog reaches a tool

The engine loaders are stateless; the wiring into a live session happens in the web app.

1. `apps/web/lib/loadCatalog.ts` calls `loadCourses()` + `loadPrereqs()` once at module scope and caches the result (`getCatalog()`).
2. The chat route builds the `ToolSession` at `apps/web/app/api/chat/v2/route.ts:291`, attaching `{ courses, prereqs }` from `getCatalog()` (route.ts:307) and `schoolConfig` from `loadSchoolConfig(student.homeSchool)` (route.ts:306) onto it. `schoolConfig` is resolved at route.ts:240-246 and `getCatalog()` at route.ts:251-257 (see [session-state.md](./session-state.md)).
3. `loadOfferings()` and `loadOffCatalogCredits()` feed the forward solver's input (`buildSolverInput`), not the session bag.

Because the engine loaders don't cache, all request-lifetime caching lives at the web layer. The school config is loaded per request (cheap — one small file); the catalog is module-cached because it is large.
