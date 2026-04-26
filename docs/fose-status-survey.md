# FOSE `stat` Field — Live Survey & Status-Code Recommendation

Survey date: 2026-04-25.
Author: research-only pass; no source code modified.
Target file (do NOT yet edit): `packages/engine/src/api/nyuClassSearch.ts`, filter `getAvailableCourses` / `extractAvailableCourseIds` (line 197).

## Methodology

- **Endpoint surveyed:** `POST https://bulletins.nyu.edu/class-search/api/?page=fose&route=search` (the same call wrapped by `searchCourses` in the engine).
- **Term:** `1258` (Fall 2025), produced by `generateTermCode(2025, "fall")`.
- **Subjects queried:** `CSCI-UA`, `MATH-UA`, `ECON-UA`, `ENGL-UA` — four subjects spanning STEM, social science, and humanities to maximise diversity of section types (lecture / lab / recitation / seminar / independent study).
- **Sample size:** 790 sections aggregated across the four subjects (CSCI-UA 126, MATH-UA 419, ECON-UA 158, ENGL-UA 87). This exceeds the ≥200-section bar by a wide margin.
- **Procedure:** ran a temporary `tsx` script (`/tmp/fose-status-survey.ts`, since deleted) that called `searchCourses` for each subject, grouped results by `r.stat`, counted occurrences, captured 2–3 `(code, title, crn)` examples per distinct value, and dumped the full key-set + auxiliary-field signature for each group. Network calls succeeded.

## Observed status vocabulary

The FOSE `route=search` response keys present on every result row were:

```
code, crn, end_date, hide, instr, isCancelled, key, meetingTimes,
meets, mpkey, no, offsets, rank, schd, srcdb, start_date, stat, title, total
```

**Notably absent** from the search response: `enrl`, `wlst`, `act`, `max`, `wlcap`, `wlactv`, `cap`, `rmstd`. The current code comments and the `FoseSearchResult` interface speculate about open/waitlist/closed semantics, but the search payload does **not** carry any live enrollment counters at all. There is a separate `total` field (string, e.g. `"10"`) which appears to be a section/enrollment cap or a roll-up count, and `offsets` which is an opaque 24-int blob (likely a meeting-time bitmap, not a status signal).

| code | count | examples (`code` "title" crn) | aux-field signature |
|------|-------|-------------------------------|---------------------|
| `A`  | 790   | CSCI-UA 101 "Intro to Computer Science" 10337 / CSCI-UA 101 "Intro to Computer Science" 10338 / CSCI-UA 101 "Intro to Computer Science" 10339 | `isCancelled=""` for every sample; `hide=""`; `total` populated (e.g. `"10"`); `wlst`/`enrl`/`act` keys do not exist on the row |

That is the entire vocabulary observed: **every one of 790 sections returned `stat="A"`** — including the CSCI-UA 101 section that motivated this investigation, plus normal-looking lectures, recitations, labs, and independent-study sections across all four subjects. No row in the survey returned `O`, `W`, or `C`.

Cross-checks attempted to distinguish `A` from `O`:
- `wlst > 0` correlation: not testable — the `wlst` key was never present on any row.
- `isCancelled` field: present on every row, empty string `""` on every row in the sample. A non-empty value is plausibly the real "do not register" signal but was not observed in this term.
- `hide` field: also `""` on every row; likely a catalog-visibility flag.

### Interpretation

The FOSE `route=search` endpoint, as exposed on `bulletins.nyu.edu`, appears to return **catalog-level data only**, not real-time registration state. `stat="A"` most likely means "Active in the catalog" (i.e. the section exists and is published) and is essentially a constant for any non-hidden, non-cancelled row. Live open/waitlist/closed status is not in this payload at all — students get that from Albert (NYU's PeopleSoft registration UI) or possibly from a `route=details` follow-up call (not surveyed here, and not used by the existing filter).

This means the existing comment on line 20 of `nyuClassSearch.ts` (`"O" = open, "W" = waitlist, "C" = closed`) is, for this endpoint, almost certainly wrong or at best inherited from a different deployment of the underlying Leepfrog FOSE software at another university.

## Public documentation

No authoritative public documentation of the FOSE/Leepfrog `stat` codes was found.

Sources consulted:

- [NYU Class Search (bulletins.nyu.edu/class-search/)](https://bulletins.nyu.edu/class-search/) — beta-mode UI; no API reference, no status-code legend.
- [Cornell Class Roster API Details (FA25)](https://classes.cornell.edu/content/FA25/api-details) — Cornell publishes an API for its own class roster system (different software, not FOSE), and notably does **not** document a `stat` field or O/W/C codes.
- [Leepfrog Technologies / CourseLeaf marketing site](https://www.leepfrog.com/courseleaf/) and [Leepfrog User Community (LUC)](https://luc.courseleaf.com/) — describe the CourseLeaf / FOSE product family, but contain no public field-level API reference. Authoritative docs appear to be gated behind the LUC member portal.
- [TorchTech NYU — APIs and feeds at NYU](https://wp.nyu.edu/torchtech/resources/apis-and-feeds-at-nyu/) and [NYU API/Data Portal (MuleSoft Anypoint Exchange)](https://anypoint.mulesoft.com/exchange/portals/nyu-0/) — list NYU-internal APIs but do not include `bulletins.nyu.edu/class-search` or FOSE-field semantics.
- [Schedge API (a1liu)](https://nyu.a1liu.com/api/) and [NYUCourseTracker (tuffstuff9)](https://github.com/tuffstuff9/NYUCourseTracker) — community projects scraping NYU course data; both bypass FOSE (Schedge scrapes the legacy `m.albert.nyu.edu` HTML; NYUCourseTracker drives the Albert UI with Puppeteer), which is itself a strong negative signal that real-time enrollment state is not available from the FOSE endpoint.

Bottom line: there is **no public, authoritative reference** for what `stat` values FOSE returns or what they mean. Any interpretation must come from empirical observation (this survey) plus a registrar/Leepfrog confirmation.

## Recommendation (do NOT yet apply)

The filter at `packages/engine/src/api/nyuClassSearch.ts:197`

```ts
const available = results.filter(r => r.stat === "O" || r.stat === "W");
```

is **silently dropping 100% of FOSE results** for in-survey subjects, because the only value FOSE actually returns on this endpoint is `"A"`. This explains the original report (CSCI-UA 101 disappearing): it isn't an edge case, it's the rule.

Recommended *direction* (pending registrar confirmation — see Open Questions):

1. **Switch from allowlist to blocklist.** Treat the FOSE search response as a **catalog feed**, not a registration-status feed. Drop a section only when the row has a clear "do not show" signal:
   - `r.isCancelled` is truthy / non-empty (registrar-cancelled section), OR
   - `r.hide` is truthy / non-empty (hidden from public catalog), OR
   - `r.stat === "C"` if-and-only-if that ever appears (treat as hard close, conservative).
   Keep `stat === "A"` and any unknown / unseen value (`O`, `W`, anything else) by default. This is the only change that restores the original behaviour the planner expects.
2. **Update the type comment** on `FoseSearchResult.stat` to stop claiming `O / W / C`. Document `A` as the only empirically observed value, and note that real-time open/waitlist/closed state is not present in this endpoint's payload.
3. **Rename / repurpose `extractAvailableCourseIds`.** Given that FOSE-search is catalog-only, the function as named is misleading. Either:
   - rename to `extractOfferedCourseIds` (semantically honest about what FOSE actually tells us — courses that are scheduled to run this term, not courses with open seats), or
   - keep the name and source the open/closed signal from a different feed (Albert / `route=details`) before declaring a section "available".
4. **Do not regress to a pure pass-through.** `isCancelled` and `hide`, although empty in this sample, exist on every row for a reason; they should remain in the blocklist even though the survey didn't catch a positive case.

## Open questions for the registrar / known unknowns

These must be confirmed by a human before the filter change is shipped:

1. **Does FOSE search ever return `O`, `W`, `C`, or other `stat` values at NYU?** The four-subject Fall-2025 survey saw only `A`. It is possible FOSE returns different codes during the active registration window (Fall 2025 registration is closed by 2026-04-25; the term is over). A re-survey during an actively-registering term (e.g. Fall 2026 once it opens) is needed to either confirm "always A" or catch other codes. **High priority — do this before changing the filter.**
2. **Is `total` enrollment, capacity, or seats-remaining?** It looks like a small integer per section, but its semantics aren't documented. If it's seats-remaining, it is the real "available?" signal and should drive the filter (e.g. keep iff `Number(total) > 0`).
3. **What does `isCancelled` actually contain when set?** Empty string vs. `"Y"` vs. `"1"` vs. a date — needs one positive example or a registrar confirmation before the blocklist trusts it.
4. **What is the difference between `hide` and `isCancelled`?** Both are empty across the sample. Likely one is "withdrawn from catalog" and the other is "section cancelled after publication", but order of precedence and exact values are unverified.
5. **Does the `route=details` endpoint expose live enrollment counters (`enrl`, `wlst`, `act`, `max`)?** The current code uses `route=details` for description/prereq HTML; if details also carries seat counts, the planner could fetch them lazily for the small set of candidate sections. Empirically un-surveyed here.
6. **Is the FOSE API a stable contract?** The bulletins page itself states the search tool is "in beta test mode". A registrar / IT contact should confirm whether the JSON shape is committed to or subject to change without notice.
7. **Authoritative Leepfrog reference.** Does NYU's Leepfrog/CourseLeaf account have access to the LUC member documentation that defines `stat` codes? If yes, fetching that doc would replace this empirical guess with a contract.

Until at least #1, #2, #3, and #6 are answered, the filter change above should be staged behind a feature flag or shipped together with logged telemetry that records the distribution of `stat` values seen in production, so a future regression to `O`/`W`/`C`-style payloads is detected immediately rather than silently dropping all sections again.
