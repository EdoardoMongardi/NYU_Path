# Section Materialization Subsystem

> Last verified against code: 2026-06-20 (Phase 38 — the FOSE Phase-0 engine slice AND Phase E integration landed: the multi-component free-pairing model, the two-state waitlist-backup rule, the `materialize_feasible` read-only tool, the agent-curation guardrails, the escalation bridge + bounded outer loop, and the agent reachability + `/api/v2/materialize` route + `propose_section_replan` proposal wiring; see §8c. The legacy `materialize_sections` 11-step path below is UNCHANGED except the internal `isOpenStatus` helper was renamed to `isAvailableStatus`/moved to `statusHelpers.ts` — behavior identical). Prior: 2026-06-19 (FOSE-prep audit); 2026-06-10 (planning-engine rebuild, PRs #35-#41).

## TL;DR

The multi-term planner says "take Intro to CS next fall" but doesn't tell you which lecture, with which professor, meeting at which time. This subsystem bridges that gap. It hits NYU's live class-search to find every section available for each course on your plan, then figures out which combinations of sections actually fit together without scheduling conflicts. Imagine you've got three classes and each has four time slots; this code is the thing that finds every conflict-free pick of one section per course. It also respects student preferences like "no early morning classes" or "keep Fridays open," and if a strict preference wipes out all the sections of a course, it asks the planner for a backup course. NYU only publishes section data about six months ahead of time, so sometimes the answer is "we don't have data yet" — and this subsystem reports that honestly instead of guessing.

```mermaid
flowchart LR
    Plan[Plan: Courses for One Term] --> Fetch[Fetch Live Sections from NYU]
    Prefs[Time Preferences] --> Filter[Filter Sections]
    Fetch --> Filter
    Filter --> Combos[Find Conflict-Free Combinations]
    Combos --> Ranked[Ranked Schedule Options]
```

---

## 1. Overview

Section materialization is the engine subsystem that turns a structural plan (a list of course IDs for a particular term, e.g. `["CSCI-UA 101", "MATH-UA 121"]` for Fall 2026) into actual, schedulable course sections — each with a Course Registration Number (CRN), an instructor, a concrete meeting pattern (e.g. Mon/Wed 9:30–10:45 AM), and a section identifier.

The structural plan tells you *what* to take; section materialization tells you *which specific sections* you can actually register for, and which combinations of sections fit together without time conflicts.

The subsystem lives under `packages/engine/src/agent/sectionMaterialization/` and is composed of seven internal modules. The orchestrator (`materialize.ts`) is the entry point; the other six are pure helpers it composes in sequence. The two agent-facing tools that drive it — `materialize_sections` (read-only staging) and `confirm_section_combination` (the write) — live in `packages/engine/src/agent/tools/materializeSections.ts` (see [tool-registry](tool-registry.md)).

Data source: NYU's FOSE (Full Online Schedule of Events) search API, accessed through `searchCourses` in `packages/engine/src/api/nyuClassSearch.ts` (the same client documented in [search-availability](search-availability.md)). FOSE only publishes section-level data roughly six months out from the term, so the subsystem has to gracefully report when it has no data, partial data, or full data for the target term.

---

## 2. Types

All shared types live in `packages/engine/src/agent/sectionMaterialization/types.ts`.

### DayOfWeek (`types.ts:16`)
A 7-string union: `"M" | "Tu" | "W" | "Th" | "F" | "Sa" | "Su"`.

### MeetingPattern (`types.ts:24-25`, re-exported from `@nyupath/shared`)
Pseudo-shape:
- `day: DayOfWeek`
- `startMin: number` — minutes since midnight
- `endMin: number` — minutes since midnight

### ParseResult (`types.ts:27-30`)
A discriminated union describing the outcome of parsing FOSE meeting-time strings:
- `{ kind: "ok", patterns: MeetingPattern[] }` — successfully parsed
- `{ kind: "asynchronous" }` — definitive "no meeting time" (online, async, TBA, "Does Not Meet")
- `{ kind: "unparseable", raw: string }` — present but couldn't make sense of it

### SectionView (`types.ts:32-74`)
The materialized view of one FOSE section. Pseudo-shape:
- `courseId: string` — e.g. `"CSCI-UA 421"`
- `title: string`
- `crn: string` — Course Registration Number
- `credits: string` — FOSE returns credits as a string
- `instructor: string` — surfaced verbatim from FOSE `instr`
- `status: string` — `"O"` open, `"W"` waitlist, `"C"` closed, `"A"` pre-reg active
- `meetingPatterns: MeetingPattern[]`
- `isAsynchronous: boolean` — true when patterns is empty AND parser said "asynchronous"
- `rawMeets: string` — original FOSE `meets` string, kept for display/debug
- `meetingTimes?: string` — raw FOSE JSON
- `schd?: string` — section type: `"LEC"`, `"LAB"`, `"RCT"`, `"TUT"`, `"SEM"`, `"IND"`
- `section?: string` — section number from FOSE `no` field (e.g. `"002"`)

### MaterializedSemester (`types.ts:76-100`)
The output bundle when materialization succeeds. Pseudo-shape:
- `term: string` — term code, e.g. `"1268"`
- `courses: Array<{ courseId, title, sections: SectionView[] }>` — per-course section bundles
- `combinations: Array<{ sections: SectionView[], weeklyHours: number }>` — every conflict-free pick, one section per course, capped at MAX_COMBINATIONS
- `combinationsTruncated: boolean` — true when the cap was hit

### AvailabilityState (`types.ts:102`)
A 3-state enum: `"full" | "partial" | "unavailable"`. Reflects how much usable section data FOSE returned for the requested term.

### SchedulingPreferenceCheck (`types.ts:118-121`)
A precomputed verdict the materializer hands to the visa-validator's scheduling axis. Discriminated union:
- `{ kind: "absent" }` — no prefs provided, OR FOSE state is partial/unavailable so there was nothing to verify against
- `{ kind: "satisfied" }` — prefs provided AND at least one combination survives the strict filter
- `{ kind: "violated", reason: string }` — strict pref wiped all sections of some course AND the swap cascade ran out of alternatives

### MaterializationResult (`types.ts:123-145`)
The top-level return shape. Pseudo-shape:
- `state: AvailabilityState`
- `semester?: MaterializedSemester` — populated when `state === "full"`
- `partialCourses?: Array<{ courseId, title, sections: SectionView[] }>` — populated when `state === "partial"`
- `message: string` — always populated, plain-English explanation for the student
- `schedulingPreferenceCheck?: SchedulingPreferenceCheck`

---

## 3. FOSE Cache

`packages/engine/src/agent/sectionMaterialization/foseCache.ts`

A simple TTL cache for raw FOSE query results, deduplicating identical `(termCode, keyword)` lookups across a single materialization run and across rapid successive runs.

- Default TTL: 5 minutes (`DEFAULT_TTL_MS = 5 * 60 * 1000`, `foseCache.ts:15`).
- Key shape: `"${termCode}|${keyword}"` via static `FoseCache.keyFor` (`foseCache.ts:48-50`).
- Storage: an in-memory `Map<string, { value, expiresAt }>` (`foseCache.ts:30`).
- Eviction: lazy — entries are checked for expiry only on `get`. If `now() >= expiresAt`, the entry is deleted and `undefined` returned (`foseCache.ts:60-64`).
- Clock injection: the constructor accepts a `now: () => number` function (`foseCache.ts:39`) so tests can advance time without faking timers.
- `size()` walks the store and counts only non-expired entries (`foseCache.ts:89-98`).

The orchestrator holds a module-level singleton `DEFAULT_CACHE` (`materialize.ts:63`) shared across production calls; tests inject their own `FoseCache` via `MaterializeArgs.cache`.

---

## 4. FOSE Availability Gate

`packages/engine/src/agent/sectionMaterialization/foseAvailabilityGate.ts`

FOSE publishes section-level data on a rolling window — typically not until ~6 months before the term starts. The gate classifies, per call, whether FOSE has enough data to actually materialize sections, by inspecting the response.

`classifyAvailability(sections)` (`foseAvailabilityGate.ts:49-62`) takes a flat array of FOSE rows (the union across all courses for that term) and applies these rules:

| Condition | State |
|-----------|-------|
| `sections.length === 0` | `"unavailable"` |
| `<50%` of sections have a `ParseResult.kind` of `"ok"` or `"asynchronous"` | `"partial"` |
| `>=50%` of sections are parseable | `"full"` |

Key nuance: `"asynchronous"` counts as parseable because it's a *definitive* answer ("this section has no meeting time, it's online/async"), not a data gap. The gate is only trying to distinguish "FOSE knows what's happening" from "FOSE is still loading".

`FoseSection` (`foseAvailabilityGate.ts:30-38`) is the gate's minimal view: just `meets?: string` and `meetingTimes?: string` — both optional because FOSE sometimes omits them. The gate delegates the parseability check to `parseMeetingTimes`.

---

## 5. Parse Meeting Times

`packages/engine/src/agent/sectionMaterialization/parseMeetingTimes.ts`

Turns FOSE's two meeting-time fields into structured `MeetingPattern[]` instances.

### Input fields
- `meets` — human-readable string, e.g. `"MoWeFr 10:00am-11:15am"`, `"TR 8-9:15a"`, `"Does Not Meet"`.
- `meetingTimes` — structured JSON string, e.g. `[{"meet_day":"0","start_time":"930","end_time":"1045"}, ...]`.

### Day index mapping (`parseMeetingTimes.ts:25-33`)
FOSE encodes the day of the week as a string index `"0"`–`"6"`:

| Index | Day |
|-------|-----|
| `"0"` | `M` (Mon) |
| `"1"` | `Tu` (Tue) |
| `"2"` | `W` (Wed) |
| `"3"` | `Th` (Thu) |
| `"4"` | `F` (Fri) |
| `"5"` | `Sa` (Sat) |
| `"6"` | `Su` (Sun) |

### `hhmmToMinutes(s)` (`parseMeetingTimes.ts:50-67`)
Converts a 3-or-4 char 24h time string to minutes since midnight:
- `"800"` → 480 (8:00 AM)
- `"930"` → 570 (9:30 AM)
- `"1045"` → 645 (10:45 AM)
- `"1400"` → 840 (2:00 PM)

Rejects non-digit strings, strings of wrong length, and minute values >=60. Returns `null` on failure.

### `parseMeetingTimes(rawMeets, meetingTimesJson?)` (`parseMeetingTimes.ts:143-160`)
Strategy:

1. If `meetingTimesJson` is present and non-empty, try to parse it as JSON. Each entry must have `meet_day`, `start_time`, `end_time` as strings; `meet_day` must map via `DAY_INDEX_MAP`; both time strings must parse. If everything checks out, return `{ kind: "ok", patterns }`.
2. If the JSON path returns null (empty, `"[]"`, malformed, unknown day index, or bad time), fall back to async detection against `rawMeets`. Async regexes (`parseMeetingTimes.ts:36-43`) match any of: `"Does Not Meet"`, `"asynchronous"`, `"async"`, `"TBA"`, empty/whitespace-only, `"online"`. If matched, return `{ kind: "asynchronous" }`.
3. Otherwise return `{ kind: "unparseable", raw: rawMeets }`.

Note: "Does Not Meet" sections have `meetingTimes: "[]"` AND `meets: "Does Not Meet"`, so the JSON path returns null, and step 2's async detector catches them.

---

## 6. Conflict Detection

`packages/engine/src/agent/sectionMaterialization/conflictDetection.ts`

Pure helpers that decide whether two sections time-conflict, and enumerate every conflict-free combination across a set of courses.

### Interval semantics
Half-open `[startMin, endMin)`. Two patterns conflict iff `a.day === b.day` AND `aStart < bEnd` AND `bStart < aEnd` (`conflictDetection.ts:21-24`). A boundary touch (`aEnd === bStart`) is NOT a conflict — sections that meet back-to-back on the same day are allowed.

### `patternsOverlap(a, b)` (internal, `conflictDetection.ts:21-24`)
The core pairwise overlap check on two `MeetingPattern` instances.

### `conflicts(a, b)` (`conflictDetection.ts:30-37`)
True iff ANY pattern in array `a` overlaps ANY pattern in array `b`. Asynchronous sections have empty pattern arrays, so they never conflict with anything.

### `MAX_COMBINATIONS` (`conflictDetection.ts:14`)
`50`. Hard cap on the combination enumeration to prevent combinatorial blowup.

### `enumerateConflictFreeCombinations(courses, cap)` (`conflictDetection.ts:85-140`)
Recursive backtracking algorithm:

- For each course in order, try each section.
- Before recursing, prune: skip any section that conflicts with the already-picked stack.
- A course with zero sections is silently skipped (the resulting combination just doesn't include that course; the orchestrator surfaces this elsewhere).
- When `out.length` hits the cap (default 50), the recursion sets a `hitCap` flag and exits early.

Each emitted combination carries:
- `sections: SectionView[]` — one section per non-empty course.
- `weeklyHours: number` — sum of `(endMin - startMin) / 60` over every pattern in every picked section, rounded to 2 decimal places (`conflictDetection.ts:60-69`).

Returns `{ combinations, truncated }` where `truncated` reflects whether the cap was hit.

---

## 7. Apply Scheduling Preferences

`packages/engine/src/agent/sectionMaterialization/applySchedulingPreferences.ts`

Filters and reranks a flat pool of sections against a `SchedulingPreferences` object (defined in `@nyupath/shared`). Applied to the union of all open sections across all courses in one pass *before* combination enumeration — it's cheaper to filter sections than to filter combinations.

### Two pass model
- **Strict pass** — a `strict: true` entry HARD filters: sections matching the constraint are dropped and recorded in `eliminatedByStrict` with a human-readable reason.
- **Soft pass** — a `strict: false` entry SOFT deboosts: sections matching get a multiplicative penalty in `(0, 1]`. Sections without any soft contribution are omitted from `rerankWeights` (the implicit default is 1.0).

### Preference types supported
From the `SchedulingPreferences` shape (read inline against `applySchedulingPreferences.ts`):

| Preference | Strict effect | Soft effect |
|------------|---------------|-------------|
| `avoidDays[]` (each entry: `{ day, strict }`) | Drop section if any meeting is on that day | Multiply by `AVOID_DAYS_SOFT_PENALTY` (0.7) per match |
| `avoidTimeWindows[]` (`{ days[], startMin, endMin, strict }`) | Drop section if any meeting on those days overlaps the window | Multiply by `AVOID_TIMEWINDOW_SOFT_PENALTY` (0.7) per match |
| `preferTimeWindows[]` (`{ days[], startMin, endMin, weight }`) | (always soft) | Multiply by `PREFER_BOOST_BASE + PREFER_BOOST_PER_WEIGHT * weight` (1.0 + 0.5×weight) per match |
| `desiredFreeDay: { day, strict }` (day may be `"any"`) | Drop section that meets on the resolved free day | n/a |
| `avoidConsecutiveLongBlocks: boolean` | (always soft) | Multiply by `LONG_BLOCK_SOFT_PENALTY` (0.7) if back-to-back chain of >=2 patterns on the same day spans >=180 min |

Constants live at `applySchedulingPreferences.ts:67-73`.

### `desiredFreeDay: "any"` resolution
`resolveDesiredFreeDay` (`applySchedulingPreferences.ts:256-280`) — when the user says "give me any free day", the function picks the weekday Monday–Friday on which the FEWEST sections in the pool meet. Ties broken in favor of earlier weekdays (`M < Tu < W < Th < F`).

### Async sections pass through
Sections with `isAsynchronous: true` have an empty `meetingPatterns` array, so every day/time-based filter is vacuously satisfied — they survive the strict pass and get a soft multiplier of 1.0.

### `isPrefsEmpty(prefs)` (`applySchedulingPreferences.ts:193-201`)
Exported predicate: true when ALL of `avoidDays`, `avoidTimeWindows`, `preferTimeWindows` are empty/undefined AND `desiredFreeDay` is undefined AND `avoidConsecutiveLongBlocks` is falsy. The orchestrator reuses this when computing the `SchedulingPreferenceCheck` verdict so the filter behavior and the verdict agree on what "empty" means.

### `ApplyResult` (`applySchedulingPreferences.ts:29-48`)
Pseudo-shape:
- `surviving: SectionView[]` — sections that passed every strict filter, in input order
- `rerankWeights: Map<string, number>` — keyed by `section.crn`, values are the product of every soft multiplier that applied to that section (omitted when the product is 1.0)
- `eliminatedByStrict: Array<{ sectionId: string, reason: string }>` — one entry per dropped section, where `sectionId` is the CRN

---

## 8. Materialize Pipeline

`packages/engine/src/agent/sectionMaterialization/materialize.ts`

The orchestrator. Composes every other module in this subsystem. Public entry point: `materializeSections(args: MaterializeArgs)` (`materialize.ts:228`).

### `MaterializeArgs` (`materialize.ts:67-94`)
Pseudo-shape:
- `termCode: string` — e.g. `"1268"`
- `courseIds: string[]` — structural plan for that one term
- `swapHook: (failedCourseId, reason) => Promise<string | null>` — callback the structural solver provides; when a course wipes, the orchestrator asks the hook for a structural alternative
- `schedulingPreferences?: SchedulingPreferences` — optional, from `session.schedulePreferences?.schedulingPreferences`
- `searchFn?: (termCode, keyword) => Promise<unknown[]>` — test-injectable; defaults to `searchCourses` from `nyuClassSearch.ts`
- `cache?: FoseCache<unknown[]>` — test-injectable; defaults to the module-level `DEFAULT_CACHE`

### The 11-step pipeline (`materialize.ts:228-448`)

**Step 1 — Per-course fetch + map** (`materialize.ts:241-258`).
For each course ID, call `fetchAndMapCourse` (`materialize.ts:198-219`). That helper:
- Hits the cache via `cache.get(termCode, courseId)`; on miss, calls `searchFn(termCode, courseId)`, populates the cache, and proceeds.
- Filters the raw FOSE rows down to exact-code matches (`r.code === courseId`) — FOSE keyword search is substring, so unrelated rows can leak in.
- Maps each surviving row through `mapFoseToSectionView` (`materialize.ts:104-123`) — pure projection from `FoseSearchResult` to `SectionView`, calling `parseMeetingTimes` along the way.

**Step 2 — Classify availability** (`materialize.ts:260-262`).
Flatten the raw rows across all courses into one array and feed it to `classifyAvailability`.

**Step 3 — State branching** (`materialize.ts:264-293`).
- `state === "unavailable"`: return immediately with a message and `schedulingPreferenceCheck: { kind: "absent" }`.
- `state === "partial"`: return immediately with `partialCourses` populated (so the UI can show what's known so far), the same `"absent"` verdict, and a warning message that registration data isn't fully published yet.
- Otherwise: proceed.

**Step 4 — Open-section filter** (`materialize.ts:295-314`).
For each course, keep only sections with `status === "O"` or `status === "W"` (open or waitlist; the shared `isAvailableStatus` helper in `statusHelpers.ts` — Phase 38 renamed it from the old in-file `isOpenStatus`, which conflated the two; behavior is identical: both O and W stay in the pool). Track `openCountBeforePrefs` per course so the swap step can later distinguish "no open sections at all" from "strict prefs wiped the open sections".

**Step 5 — Apply scheduling preferences** (`materialize.ts:316-318`).
Flatten all open sections across all courses into one union pool. Call `applySchedulingPreferences(unionOpen, prefs)` once on the union — this returns `{ surviving, rerankWeights, eliminatedByStrict }`.

**Step 6 — Re-bucket survivors** (`materialize.ts:320-324`).
Run `bucketSectionsByCourse` (`materialize.ts:134-145`) to split `applyResult.surviving` back into per-course arrays, preserving the input course order.

**Step 7 — Swap cascade** (`materialize.ts:326-396`).
For each course:
- If it has surviving sections, push it to `finalBundles` and continue.
- Otherwise determine the reason: `"unavailable"` if `openCountBeforePrefs === 0`, else `"scheduling-prefs-eliminated"`.
- Call `swapHook(courseId, reason)`. If it returns null, record a drop and continue.
- If it returns an alternative course ID, re-run steps 1, 4, 5 on the alternative (one attempt only — no recursion).
- If the alt survives, push it to `finalBundles` (the alt's `rerankWeights` are dropped here — see in-code comments at `materialize.ts:356-377` for the deferred Phase-16 audit).
- If the alt also produces zero survivors, record a drop with the alt ID attached.

**Step 8 — Enumerate combinations** (`materialize.ts:398-401`).
Feed `finalBundles` into `enumerateConflictFreeCombinations`. Get back `{ combinations, truncated }`.

**Step 9 — Rank by rerank-weight product** (`materialize.ts:403-412`).
Run `rankCombinationsByScore` (`materialize.ts:170-187`). Each combination's score is the product `Π section.crn → rerankWeights.get(crn) ?? 1` (`scoreCombination`, `materialize.ts:154-163`). Sort descending; ties preserve enumeration order via a decorate-sort-undecorate to guarantee stability.

**Step 10 — Compute the scheduling-preference verdict** (`materialize.ts:414-418`).
`computeSchedulingPreferenceCheck` (`materialize.ts:467-487`):
- Prefs undefined OR empty (via `isPrefsEmpty`) → `{ kind: "absent" }`.
- Any dropped course with `reason === "scheduling-prefs-eliminated"` → `{ kind: "violated", reason: "All sections of {courseId} were eliminated..." }`.
- Otherwise → `{ kind: "satisfied" }`. (No conflict-free combinations existing is NOT a violation — that's a time-conflict issue, not a strict-pref one.)

**Step 11 — Build the result** (`materialize.ts:420-447`).
Assemble the `MaterializationResult` with `state: "full"`, the populated `semester` (term, course bundles, ranked combinations, truncation flag), a message that mentions the count of conflict-free combinations and any dropped courses, and the verdict.

---

## 8b. The two-step tool contract

**File:** `packages/engine/src/agent/tools/materializeSections.ts`

The orchestrator above is driven by a `materialize_sections` / `confirm_section_combination` tool pair that mirrors the `update_profile` / `confirm_profile_update` two-step write (Architecture §7.2).

- **`materialize_sections`** (`isReadOnly: true`) takes a single `targetTerm` (solver format, e.g. `"2026-fall"`), validates that the term exists in `session.forwardSchedule` and is not locked, then builds the FOSE keyword list from **`specific_planned` slots only**. Placeholder slots (no concrete course yet) and `in_progress` (IP) slots are skipped — IP courses are pinned to a CRN in Albert that the DPR doesn't carry, so the tool appends an honest caveat that the proposed combinations can't conflict-check against them. It calls the orchestrator, then **stages** each conflict-free combination into `session.pendingMaterializations` under a deterministic `proposalId` (`prop_<term>_<1-indexed>`) and returns the proposal list. It does **not** mutate the schedule.
- **`confirm_section_combination`** (the write) looks up a `proposalId`, walks the target semester's `specific_planned` slots, and adds the concrete-section fields (`crn`, `meetingPatterns`, `instructor`, `schd`, `sectionNumber`) in-place. The pending entry is consumed on success, so confirming the same id twice is rejected.

> **Known limitation — swap cascade is stubbed at the tool layer.** The orchestrator's Step-7 swap cascade is fully implemented, but the `swapHook` the `materialize_sections` tool passes in always returns `null` (`materializeSections.ts:198-201`). Wiring it into the structural solver's swap path is deferred (marked Phase 16 in-code). In practice this means a wiped course surfaces cleanly in the result's `dropped` list with no alternative offered.

---

## 8c. The feasible-candidate path — `materialize_feasible` (Phase 38)

> **😴 DORMANT (parked 2026-06-21) — the code below is LIVE but FOSE work is paused pending an external API.** Everything in §8c/§8d is implemented, merged to local `main` (`c667262`), tested, and reachable. It is NOT disabled — it still delivers time-conflict feasibility, multi-component free-pairing, the cross-term re-plan, and requirement validity. BUT the public FOSE API never exposes live open/waitlist/closed (only `stat:"A"` = offered/seat-unknown — see the seat-status note below), so the availability-aware features are dormant + hedged. Resuming (real seat data, the **E2** visual picker, **E5** backup grad-validity) is **blocked on an official NYU live-enrollment API** (pursued via NYU IT). Until then, no further FOSE work — see `Docs/plans/38-...md` (Status banner) + `CLAUDE.md` (Current status).

A second, parallel entry point added in Phase 38 (plan `38-2026-06-19-fose-section-scheduling-replan.md`, §2 ①–③ + §2.5). Where `materialize_sections` (§8/§8b) picks ONE section per course and stages combinations for the legacy sidebar, `materialize_feasible` models **multi-component courses** (lecture + recitation/lab), enforces a **graduation-safe waitlist rule**, and returns a **schema-validated, pre-ranked candidate set** that an agent ranks/curates over — the agent never enumerates or judges validity itself (the §2.5 hybrid boundary). The legacy path is untouched.

### Free-pairing multi-component model (`componentGrouping.ts`)
`groupByComponent(courseId, title, sections)` buckets a course's live sections by normalized `schd` (LEC / RCT / LAB / TUT …; a missing `schd` defaults to `LEC`). `enumerateCourseSelections` then produces one *course selection* per cartesian combination of one section from each component group, dropping internally-clashing pairs (a LEC overlapping its own chosen RCT).

> **Why free-pairing (not bound-pairing).** A 2026-06-20 live probe of the FOSE detail endpoint disproved the earlier "`all_sections` gives the LEC→recitation registration group" finding — `all_sections` returns the SAME flat section list for every section queried and encodes no LEC↔RCT linkage. The FOSE API exposes no pairing anywhere. So the model is "any RCT may pair with any LEC, all blocks conflict-checked" + a HEDGE that Albert may restrict pairings (verify in Albert). This is conservative, never graduation-invalid.

### Feasible enumeration + the two-state waitlist backup (`feasibleSchedules.ts`)
`enumerateFeasibleSchedules(courses, opts)` enumerates schedules (one selection per course) keeping only those where **every component block of every course is mutually conflict-free** (reuses `conflicts`). A `"W"` (waitlist) section keeps a candidate feasible ONLY under the **§2①(d) two-state rule**: there must be a SPECIFIC OPEN backup section `B` that is (i) the same course + same component (Albert auto-swap, graduation-trivial), (ii) conflict-free with the REST of the schedule (the candidate minus that one `W`'s own blocks) **and** with every other chosen backup (the all-backups-registered state must itself be schedulable), and (iii) graduation-valid — for a different-course backup this is delegated to an injected `backupResolver` (the deferred Phase A/B/C escalation; default = same-course only). No valid backup ⇒ the `W` candidate is dropped.

Enumeration runs in **two passes** so the `MAX_COMBINATIONS` cap never drops an all-open candidate in favor of a waitlist one (the binding *open ≻ waitlist* invariant must survive truncation): pass 1 enumerates all-open candidates over open-only groups; pass 2 fills the remaining cap with waitlist-containing candidates.

### Pre-rank (`candidatePreRank.ts`)
`preRankCandidates(candidates, rerankWeights?)` orders best-first with `preScore = -waitlistCount + softTerm`, where `softTerm = softProduct/(softProduct+1) ∈ [0,1)` is the Decision-#43 soft-preference product (clamped to 0 for any non-positive/non-finite product, so the integer waitlist penalty always dominates — open ≻ waitlist holds regardless of soft weights). Stable on ties.

### Status helpers (`statusHelpers.ts`) + the seat-status reality
`isAvailableStatus` (O | W | **A** — the keep-in-pool filter), `isOpenStatus` (O only), `isWaitlistStatus` (W only).

> **CRITICAL (verified 2026-06-20): the public FOSE API never returns O/W/C.** Every live section — including past terms — reads `stat:"A"` (Active/offered), and there is no seat/waitlist count anywhere. Live open/waitlist/closed lives only in authenticated Albert/PeopleSoft (no public endpoint; out of scope to authenticate). So `"A"` = **offered, seat status UNKNOWN**, and it is **usable for time-conflict feasibility** (`isAvailableStatus` includes it; the two-pass enumerator's first tier is "non-waitlist" = O+A, so all-`A` live data still produces candidates). The orchestrator attaches a **seat-status hedge** ("these sections exist and fit together; verify open/waitlist/closed in Albert"), the candidate `status` carries `"O"|"W"|"A"`, and the pre-rank never claims "open" for an `A` candidate. The O/W/C machinery (G1/G2/G3 + the §2①(d) waitlist backup) is retained + correct but **dormant** unless real seat status is supplied (e.g. the student reads it off Albert). The §2.6 elicit-or-hedge pattern is the path to real status.

### Already-registered (IP) course conflicts (`ipSections.ts`)
The near term may hold courses the student is already registered for (IP slots); the DPR carries the course but not the section/time. `materialize_feasible` accepts `ipSections` (the student-supplied CRNs — looked up live in FOSE — or meeting times); `resolveIpSectionsToBlocks` turns them into `occupiedBlocks` that the enumerator conflict-checks every candidate against, so the remaining courses avoid the student's actual registered times. Any IP course whose section is unknown is named in an **elicit-or-hedge** note (ask for its CRN/times, else verify against Albert). Same pattern as the seat-status hedge.

### Orchestrator + tool (`materializeFeasible.ts`, `tools/materializeFeasible.ts`)
`materializeFeasible(args)` runs: fetch+map (reuses `fetchAndMapCourse`) → `classifyAvailability` (early-return on unavailable/partial) → filter to O|W → `applySchedulingPreferences` → group by component → enumerate → pre-rank → build the **UI-complete candidate views** (`candidateId`, `courses[{code,title,components[{schd,crn,no,meets,meetingBlocks,instr,status,capacity}]}]`, `hasWaitlist`, `waitlistCrns`, `openFallbacks[{forCrn,fallbackCrn}]`, `weeklyHours`, `preScore`, `preRankReason`). The result also carries **`unavailableCourses`** — any requested course with no open/waitlist section (all closed, or strict-pref-wiped); these are omitted from candidates and surfaced with a hedge so the term is never presented as complete when it isn't. Cite-or-hedge notes (free-pairing, waitlist-queue-length-unknown) ride in `hedges`.

The `materialize_feasible` tool is **read-only** (stages nothing, mutates no session state), exposes the result Zod schema as its `outputSchema` (a new optional `Tool` field), and re-validates its own output against that schema before returning. `FoseSearchResult.total` (capacity) and `SectionView.capacity` were added to feed the candidate views — capacity only, NOT an enrolled/waitlist count (FOSE exposes none).

### Agent-curation guardrails (`agentCuration.ts`)
`agentSelectionSchema` forces the agent's top-5 selection into `{picked:[{candidateId,why}](≤5), more:[candidateId]}`. `validateAgentSelection` rejects any candidateId the tool never returned (no fabrication) and any duplicate across picked+more (no double-surfacing). `deterministicTop5` is the fallback order when no model curation runs. `revalidatePick` re-asserts section feasibility on the chosen candidates (conflict-free, O|W, waitlist-tag consistent, every waitlist section has a recorded backup) before any confirm. `paginate` is the top-5 / see-more cursor.

### Escalation bridge — `sectionReplanBridge.ts` (Phase A, built)
When the student rejects every feasible schedule (or none is feasible), `classifySectionFailure` turns the `materialize_feasible` signals (`candidateCount` + `unavailableCourses` + an explicit rejection list) into a typed failure (`hard-conflict` / `course-wipe` / `soft-rejection`); `generateResolutionLadder` emits ordered cheapest-first plan-mutation batches (rung 1 within-term swap → rung 2 cross-term `move` → rung 3 bounded multi-course move); `validateResolutionCandidates` runs each batch through the EXACT propose-path chain (`makeFrozenSeamEvaluator` = resolveBindMutations → applyMutationsToPreferences → buildSolverInputWithRulesFromSession → solveForwardSchedule → finalizeForwardSchedule) and keeps only `validatorResult.feasible` re-plans, ranked by disruption (fewest moves → unchanged graduation term → cheaper rung); A4 returns an honest no-op (`{resolutions:[], reason}`) carrying the validator's binding constraint. The frozen engine is CALLED, never modified.

### Bridge supporting pieces (built)
- **Within-term swap finder** (`withinTermSwap.ts`, Phase B) — `findWithinTermAlternatives` (pure, DI) + `makeLeafSiblingsResolver` (same-requirement-leaf siblings from `buildConstraintContext` + `poolMembersFor`, READ-only) feed rung 1's `withinTermAlternatives`; the live-FOSE "offered+open" check is injected by the caller.
- **SOFT-rejection preferences** (Phase D) — `SchedulingPreferences.rejectInstructor` / `rejectSection` strict-drop in `applySchedulingPreferences`; a rejection that wipes a course flows through `unavailableCourses` → the bridge.
- **Waitlist strategy** (Phase G) — `willingToWaitlist` (G2: `false` ⇒ open-only filter ⇒ waitlist-only course → `unavailableCourses` → bridge) + `buildAutoSwapAdvice` (G3: deterministic open-backup + Albert auto-swap copy naming the verified CRNs, hedge when unverified).

### Integration & reachability — Phase E (built)
The green engine is now wired end-to-end:
- **E0 reachability** (`systemPrompt.ts`) — the agent is routed to call `materialize_feasible` for near-term section feasibility ("can I take these next term?") and to curate the top ~5 over its VERIFIED candidates (the §2.5 boundary: rank tool-returned `candidateId`s, never enumerate/judge), and to call `propose_section_replan` when there's no feasible candidate / the student rejects all.
- **E1 route** (`apps/web/app/api/v2/materialize/route.ts` → `handleMaterializeRoute` → `runMaterializeFeasibleStage`) — read-only; returns the Phase-0.3 candidate set + `unavailableCourses` + hedges. R1: never persists, never writes `parsed_dpr` (test-verified).
- **E4 bounded outer loop** (`runSectionReplanLoop` in `sectionReplanBridge.ts` + `buildSectionReplanLoopDeps` in `sectionReplanWiring.ts`) — materialize near-term → on failure classify + escalate via the ladder → re-materialize the NEW near-term → bounded (cap=2; past the cap → honest no-op). The wiring composes `materializeFeasible` + the bridge + the within-term finder + the frozen-seam evaluator; missing FOSE data (state ≠ "full") is treated as "can't check", not a failure.
- **E3 escalation proposal** (`propose_section_replan` tool + the chat-v2 route block) — the agent calls the tool (narration + recommended mutations); the route re-derives the re-plan server-side (`runSectionReplanStage`) and stages a VALID one through the EXISTING `runProposeStage` → `plan_proposal` SSE → Confirm chokepoint (no new UI; invalid → the existing red card; no-op → no SSE). R1: staging ≠ committing — nothing is written until the student clicks Confirm, and never to `parsed_dpr`.

> **Deferred:** **E2** the visual top-5 section picker (its own follow-up mockup plan, after owner sign-off — builds against the working `materialize_feasible` + E1 route + the Phase-0.3 schema, zero rework). **E5** different-course backup graduation-validity (`backupResolver` injection point exists in `feasibleSchedules.ts`; same-course backups cover the common path; wire only when needed). The live-FOSE `isOfferedAndOpen` check (rung-1 within-term swap) is injected by the wiring.

---

## 9. Pipeline diagram

```mermaid
flowchart TD
    Start([materializeSections args]) --> S1[Step 1: per-course<br/>fetchAndMapCourse<br/>cache + searchFn]
    S1 --> S2[Step 2: classifyAvailability<br/>on union of raw rows]
    S2 --> Decision{state?}
    Decision -- unavailable --> EarlyU[Return: state=unavailable<br/>schedCheck=absent]
    Decision -- partial --> EarlyP[Return: state=partial<br/>partialCourses populated<br/>schedCheck=absent]
    Decision -- full --> S4[Step 4: filter to<br/>status=O or W<br/>per course]
    S4 --> S5[Step 5: applySchedulingPreferences<br/>on union of open sections<br/>strict + soft passes]
    S5 --> S6[Step 6: bucketSectionsByCourse<br/>survivors -> per-course]
    S6 --> S7{Step 7: any course<br/>with 0 survivors?}
    S7 -- yes --> Swap[swapHook -> alt courseId<br/>re-run steps 1+4+5 on alt<br/>one attempt only]
    Swap --> S8
    S7 -- no --> S8[Step 8: enumerateConflictFreeCombinations<br/>backtracking, capped at MAX_COMBINATIONS=50]
    S8 --> S9[Step 9: rankCombinationsByScore<br/>product of rerankWeights<br/>stable sort desc]
    S9 --> S10[Step 10: computeSchedulingPreferenceCheck<br/>absent / satisfied / violated]
    S10 --> S11[Step 11: assemble<br/>MaterializationResult<br/>state=full + semester + message + verdict]
    S11 --> Done([MaterializationResult])

    subgraph Helpers["Pure helpers used in pipeline"]
        H1[parseMeetingTimes]
        H2[classifyAvailability]
        H3[FoseCache]
        H4[applySchedulingPreferences]
        H5[enumerateConflictFreeCombinations]
        H6[mapFoseToSectionView]
    end

    S1 -.uses.-> H3
    S1 -.uses.-> H6
    H6 -.calls.-> H1
    S2 -.uses.-> H2
    H2 -.calls.-> H1
    S5 -.uses.-> H4
    S8 -.uses.-> H5
```
