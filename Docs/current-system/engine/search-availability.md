# Class Search and Availability

> Last verified against code: 2026-06-10 (post planning-engine rebuild, PRs #35-#41).

## Purpose

NYU has a public class-search system called FOSE, and this subsystem talks to it. When the agent needs to know "what sections of CSCI-UA 101 are offered this fall" or "is this course actually on the published schedule," the `search_availability` tool sends the query, parses the response, and hands back the sections it finds. The work is split into two files: a thin HTTP client (`nyuClassSearch.ts`) and the agent-facing tool wrapper (`searchAvailability.ts`). There is no longer any prediction or guessing layer — the tool reports exactly what FOSE returns, and says so honestly when FOSE returns nothing.

```mermaid
flowchart LR
    Query[Course + Term] --> Resolve[Resolve term code<br/>year+term -> 4-digit]
    Resolve --> FOSE[POST to NYU FOSE search]
    FOSE --> Slice[Take first 25 rows]
    Slice --> Result[Sections + open/waitlist/closed status]
```

---

## 1. What changed since the old doc

The earlier version of this doc described an `availabilityPredictor.ts` module that, for terms NYU hadn't published yet, predicted "likely / uncertain / probably-not" from a course's history of past offerings (`predictAvailability`, `predictAvailabilityBatch`, `isTermPublished`, `getSeason`, `CatalogEntryWithTerms`, etc.).

**That module no longer exists.** `packages/engine/src/api/` contains only `nyuClassSearch.ts`. There is no prediction tree, no `isTermPublished` FOSE probe, and no `AvailabilityConfidence` / `AvailabilityResult` types anywhere in the engine. `search_availability` is now a pure pass-through of the live FOSE response. The honest "we don't have data yet" answer is produced naturally: when FOSE has not published a term, the search returns zero rows and the tool's summary says so. (Section-level "full / partial / unavailable" classification still exists, but it lives in the [section-materialization](section-materialization.md) subsystem's `foseAvailabilityGate.ts`, not here.)

---

## 2. The `search_availability` tool

**File:** `packages/engine/src/agent/tools/searchAvailability.ts`

This is the only live consumer of FOSE in the agent's tool registry (see [tool-registry](tool-registry.md)). It is read-only (`isReadOnly: true`) and caps its rendered output at 2500 chars.

### Input schema

The tool accepts two equivalent ways to name a term plus a required keyword (`searchAvailability.ts:46-52`):

| Field | Type | Notes |
|---|---|---|
| `year` | int 2000–2099, optional | Preferred form — paired with `term`. |
| `term` | `"spring" \| "summer" \| "fall"`, optional | Preferred form — paired with `year`. |
| `termCode` | 4-digit string, optional | Fallback form — the raw FOSE code. |
| `keyword` | string, min length 2, required | Course-code prefix (`"CSCI-UA"`) or full code (`"CSCI-UA 101"`). |

`validateInput` (`searchAvailability.ts:55-67`) rejects the call unless **either** `termCode` **or** both `year` and `term` are present. The description steers the model toward the `year + term` form because most models typo the raw FOSE encoding from training data; the tool computes the code itself via `generateTermCode(year, term)` (`searchAvailability.ts:79-80`).

### Call behavior

`call` (`searchAvailability.ts:71-99`):

1. Resolves the FOSE term code: uses `input.termCode` if given, otherwise `generateTermCode(input.year!, input.term!)`.
2. Picks the search function: `session.searchAvailabilityFn` if a test injected one, otherwise the live `searchCourses` from `nyuClassSearch.ts` (`searchAvailability.ts:74-75`).
3. Calls `searchCourses(resolvedTermCode, keyword)`, then **slices to the first 25 results** (`searchAvailability.ts:82`).
4. Returns `{ termCode, keyword, totalReturned, totalAvailable, sections[] }`, where each section is a projection of the FOSE row: `code`, `title`, `crn`, `stat`, `statLabel`, `instr`, `credits`, `hours`.

`totalAvailable` is the full count before the 25-row cap; `totalReturned` is the capped count. The deprecated `hours` field is still passed through (it is always `undefined` on real FOSE responses — see §3).

### Summary rendering

`summarizeResult` (`searchAvailability.ts:100-127`) groups the returned sections by course code and, per course, reports counts of open / waitlist / closed and up to two representative sections (status label, CRN, credits, instructor). When zero sections come back it emits "No sections found. The course may not be offered this term, or the keyword may be too narrow." — this is the honest no-data path that replaced the old prediction logic.

`statLabel` (`searchAvailability.ts:130-135`) maps `"O" → open`, `"W" → waitlist`, `"C" → closed`, and passes anything else through verbatim.

---

## 3. The FOSE client

**File:** `packages/engine/src/api/nyuClassSearch.ts`

The thin HTTP layer over NYU's public Leepfrog/FOSE API. Uses the global `fetch` directly — no client wrapper, no shared retry layer.

### Types

- **`FoseSearchResult`** (`nyuClassSearch.ts:24-63`) — one search row. Required: `key`, `code`, `title`, `crn`, `srcdb`, `stat`. Optional: `schd` (section type — `LEC`/`LAB`/`RCT`/`TUT`/`SEM`/`IND`), `no` (section number), `meets` (human string), `meetingTimes` (structured JSON string), `instr`, `credits`, and the **deprecated** `hours`. The field set was verified against 27 recorded fixtures (514 rows) under `packages/engine/tests/fixtures/fose/`; fields observed but unused (`mpkey`, `start_date`, `end_date`, `offsets`, `total`, `hide`, `isCancelled`, `rank`) are intentionally omitted per the no-invention rule.
- **`FoseSearchResponse`** — `{ results, totalCount, srcdb }`.
- **`FoseDetailResponse`** — open-shape detail object with optional `description`, `clssnotes`, legacy `classnotes`, `hours_html`, `hours`, `registration_restrictions`, plus an index signature for raw passthrough.
- **`TermOption`** — `{ code, label, year, term }` where `term` is `spring`/`summer`/`fall`.

### Functions

| Function | Shape | Notes |
|---|---|---|
| `generateTermCode(year, term)` | `(number, season) -> string` | Delegates to `encodeFoseTerm` in `../data/foseTerm.js` (the single source of truth for the encoding). |
| `getRecentTermOptions()` | `() -> TermOption[]` | Calendar sweep: `currentYear-1 .. currentYear+1`, one option per season (spring, summer, fall) per year. No publication awareness. |
| `searchCourses(termCode, keyword)` | `-> Promise<FoseSearchResult[]>` | POSTs to the FOSE search endpoint. |
| `getCourseDetails(termCode, crn)` | `-> Promise<FoseDetailResponse>` | POSTs to the FOSE details endpoint with key `crn:${crn}`. |
| `fetchTermCourses(termCode)` | `-> Promise<{ csci, math }>` | Convenience: two parallel `searchCourses` calls for `CSCI-UA` and `MATH-UA`. |
| `extractAvailableCourseIds(results)` | `-> string[]` | Keeps only `stat === "O"` or `"W"`, dedupes by course code. |
| `extractAllCourseIds(results)` | `-> string[]` | Dedupes every course code regardless of status. |

The FOSE API base is `https://bulletins.nyu.edu/class-search/api/` (`nyuClassSearch.ts:144`).

### Request shapes

`searchCourses` (`nyuClassSearch.ts:153-175`) POSTs to `?page=fose&route=search` with body `{ other: { srcdb: termCode }, criteria: [{ field: "keyword", value: keyword }] }`. On a non-2xx response it throws `Error("FOSE search failed: <status> <statusText>")`; on success it returns `data.results ?? []`.

`getCourseDetails` (`nyuClassSearch.ts:184-203`) POSTs to `?page=fose&route=details` with body `{ srcdb, key: "crn:" + crn }`. Throws on non-2xx.

> **Note on the deprecated `hours` field.** The FOSE search endpoint never returns an `hours` field on search rows (verified across all 27 fixtures). The optional slot survives only because `search_availability` still reads `r.hours` into its output shape; in practice it is always `undefined`. Remove the slot once the tool stops reading it.

---

## 4. Term-code encoding

The encoding rule lives in `packages/engine/src/data/foseTerm.ts` (`encodeFoseTerm`); `generateTermCode` is a legacy wrapper around it. The format is `1{lastTwoDigitsOfYear}{4=spring,6=summer,8=fall}` — e.g. Fall 2026 = `1268`, Spring 2027 = `1274`. The tool's input description spells this out so the model can fall back to `termCode` correctly, but the `year + term` form is preferred precisely so the model never has to type the code.

---

## 5. Inputs / outputs

| Function / tool | Input | Output |
|---|---|---|
| `search_availability` | `year+term` or `termCode`, plus `keyword` | `{ termCode, keyword, totalReturned, totalAvailable, sections[] }` (sections capped at 25) |
| `searchCourses` | `termCode`, `keyword` | `FoseSearchResult[]`, or throws on non-2xx |
| `getCourseDetails` | `termCode`, `crn` | `FoseDetailResponse`, or throws on non-2xx |
| `fetchTermCourses` | `termCode` | `{ csci, math }` |
| `generateTermCode` | `year`, `term` | 4-digit FOSE term code |
| `getRecentTermOptions` | none | `TermOption[]` for three years × three seasons |
| `extractAvailableCourseIds` | `FoseSearchResult[]` | deduped open/waitlist course codes |
| `extractAllCourseIds` | `FoseSearchResult[]` | deduped all course codes |

---

## 6. Edge cases / failure modes

- **Term not published.** FOSE returns zero rows, `search_availability` returns an empty `sections` array, and the summary tells the agent the course may not be offered (or the keyword is too narrow). There is no prediction fallback.
- **Missing input.** `validateInput` rejects a call with neither `termCode` nor a complete `year + term` pair, returning a `userMessage` that explains both forms.
- **Non-2xx FOSE response.** `searchCourses` / `getCourseDetails` throw an `Error` carrying the status code and text; the tool framework surfaces the throw.
- **Missing `results` key.** `searchCourses` returns `[]` via the `data.results ?? []` guard.
- **Keyword too broad.** FOSE keyword search is substring-based, so unrelated codes can leak into results; `extractAvailableCourseIds` / `extractAllCourseIds` dedupe by code, which collapses multiple sections of one course into a single entry. Callers needing section-level data (e.g. [section materialization](section-materialization.md)) re-filter to exact-code matches themselves.

---

## 7. Where it's consumed

- **`search_availability`** is the agent's canonical "is this course offered next term?" tool. The system prompt instructs the agent to call it before recommending a specific section.
- **`searchCourses`** is also the default FOSE search function for the [section-materialization](section-materialization.md) orchestrator, which pulls per-course sections, filters to exact codes, and enumerates conflict-free combinations.
- **`encodeFoseTerm` / `generateTermCode`** is the single encoding source shared by both the tool and the materializer.

> **Known limitations.** Future-term availability is no longer estimated. If NYU hasn't published a term, the tool returns nothing rather than a "likely / uncertain" guess — by design, to avoid asserting availability the system cannot verify. Planner-level "will this course probably be offered" reasoning now comes from the static offerings data in `packages/engine/src/data/` (e.g. `courses-offerings.json`), consumed by the forward planner, not from a live FOSE probe.
