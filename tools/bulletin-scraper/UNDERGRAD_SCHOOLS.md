# NYU Path — Undergraduate Bulletin Coverage

This file is the source of truth for which NYU schools' undergraduate
bulletins are in scope for NYU Path's RAG / planner data layer, and it
documents the on-disk layout that Phase 12.8's parser is committed to read
against. Any future scrape, parse, or coverage-audit work should start here.

## On-disk layout (LOCKED for Phase 12.8 parser)

Bulletins live at:

```
data/bulletin-raw/courses/<dept>_<suffix>/_index.md
data/bulletin-raw/courses/<dept>_<suffix>/_index.html
```

There is **ONE page per department**, and that page lists all courses for
the department inline. There are **NO per-course subdirectories** anywhere
in the tree. bulletins.nyu.edu does not publish per-course pages at the
`/courses/` route — the per-dept page is the granular unit. (Richer
per-course pages do exist at `/search/?P=…` but were deliberately skipped
during scrape because BFS over them explodes into >247k URLs and adds no
useful data not already on the dept page.)

Directory names are lowercase, with the department code and the
school-suffix joined by a single underscore. Department names can contain
digits (e.g. `cwrg1_uc`, `bas01_dn`). The recognizer regex is therefore
digit-tolerant:

```
^[a-z][a-z0-9]*_(ua|ub|ue|uf|uh|ut|uy|shu)$
```

## Schools in scope

The eight undergraduate schools below are the data substrate for NYU Path's
forward planner and RAG layer. School slugs were curl-verified against
`bulletins.nyu.edu/undergraduate/<slug>/` on 2026-05-02. Dept-prefix counts
were produced by `verify_coverage.py` on the same date.

| School | Bulletin slug (under `/undergraduate/`) | Course-suffix | Postgres dept-prefixes | Disk dept-dirs |
|---|---|---|---|---|
| College of Arts and Science (CAS) | `arts-science` | `UA` | 51 | 51 |
| Stern School of Business | `business` | `UB` | 10 | 10 |
| Steinhardt School of Culture, Education, and Human Development | `culture-education-human-development` | `UE` | 45 | 45 |
| Gallatin School of Individualized Study | `individualized-study` | `UF` | 29 | 31 |
| NYU Abu Dhabi | `abu-dhabi` | `UH` | 37 | 44 |
| Tisch School of the Arts | `arts` | `UT` | 19 | 20 |
| Tandon School of Engineering | `engineering` | `UY` | 24 | 35 |
| NYU Shanghai | `shanghai` | `SHU` | 43 | 49 |

Disk dept-dir counts equal or exceed Postgres dept-prefix counts in every
suffix. The "extras" (disk has, Postgres does not) are bulletin-listed
departments whose course rows aren't currently live in the Postgres dump.
That's expected and acceptable — see "Coverage status" below.

## Out of scope

The following are intentionally NOT covered by this data substrate:

- **Graduate course-suffixes.** `_g*`, `_md`, `_ml`, `_dn`, `_lw`, `_ny`,
  `_na`, `_ne`, `_ni`, `_uc`, `_ud`, `_ug`, `_cs`, `_un` etc. exist on disk
  (the bulletin scraper indiscriminately captured them) but they are not
  undergraduate-major-program data and the planner does not consume them.
  Phase 12.8's parser must filter to the eight in-scope suffixes only.
- **Standalone subdomain bulletins.** `stern.nyu.edu`'s separate bulletin
  duplicates content already in `bulletins.nyu.edu/undergraduate/business/`
  and is not re-scraped.
- **Live registrar widgets.** `bulletins.nyu.edu/class-search/` and
  `bulletins.nyu.edu/search/` provide live section data, not curriculum
  structure. They're handled at runtime by the engine's `searchAvailability`
  tool against FOSE; there is no offline scrape of them.

## Coverage status (as of 2026-05-02)

**100% at dept-prefix granularity for all 8 schools.** Verified by:

```
python3 tools/bulletin-scraper/verify_coverage.py
```

Exit code is 0; every Postgres dept-prefix has a corresponding scraped
`<dept>_<suffix>/_index.md` page on disk. Phase 12.8 may proceed.

The verifier reports "extras" — bulletin pages on disk for which Postgres
currently has no live course rows. These are real departments listed by
the school but with no active course offerings in the snapshot dump
(typical for cross-listed-only departments, recently-renamed programs,
or programs that only offer non-credit work). Extras do not count against
coverage and are surfaced informationally only.

## Phase 12.8 parser instruction

The Phase 12.8 parser must:

1. Walk `data/bulletin-raw/courses/<dept>_<suffix>/_index.md`, filtered to
   the eight in-scope suffixes (`ua`, `ub`, `ue`, `uf`, `uh`, `ut`, `uy`,
   `shu`).
2. Split each `_index.md` file into per-course chunks. Each course chunk is
   delimited by a heading line like:

   ```
   **CSCI-UA 60**  **Database Design and Implementation**  **(4 Credits)**
   ```

   That bold-bold-bold pattern is consistent across the corpus and is the
   safe split anchor.
3. Within each chunk, extract inline metadata. The fields known to appear
   inline (where present) include:
   - `**Prerequisites:**` followed by free-form prose with course codes.
   - `**Typically offered**` followed by term descriptors
     (Fall, Spring, Summer, Annually, etc.).
   - Free-text course description.

The parser must NOT attempt to read per-course subdirectories — they do not
exist. The dept page is the only granular source, and the heading-split is
the only way to reach the per-course unit.

## Re-running the scrape (only if needed)

The scrape is currently fresh as of 2026-04-21. Phase 13 does not require
fresher data than that, so a re-run is generally unnecessary.

If a re-run is needed (e.g. to pick up new departments after a bulletin
update):

1. `tools/bulletin-scraper/scrape_bulletin.py` has `/courses/` listed in its
   `SKIP_SUBSTRINGS` (around line 74) — added there once the initial scrape
   was complete to prevent BFS from re-walking the entire tree on idempotent
   re-runs. Remove that entry to allow re-scraping.
2. `.scrape_progress.json` currently shows `queue=0` (scrape exhausted).
   Delete or reset that file so the scraper restarts from the seed URLs.
3. Run the scraper. It will re-fetch dept pages and update `_index.md` in
   place.

After any re-scrape, re-run `verify_coverage.py` and confirm exit 0 before
proceeding to parsing.

## History note

The original `PHASE_12_7_PLAN.md` scoped four tasks: (1) audit, (2) build an
allowlist of school+suffix combinations, (3) re-scrape under the expanded
allowlist, (4) verify coverage. The audit (Task 1) found two surprises that
re-scoped the rest of the work:

- The plan assumed the on-disk layout was per-course subdirectories
  (`<DEPT>_<SCHOOL>/<NUMBER>/index.md`). The actual layout is one page per
  department (`<dept>_<suffix>/_index.md`), with all courses inline. No
  per-course subdirectory has ever existed in this tree.
- Coverage at the dept-prefix granularity was already 100% across all eight
  in-scope schools. No additional scraping was needed.

Tasks 2 and 3 were therefore obviated. Only Task 4 (the verifier) shipped,
plus this layout-locking document and a pre-flight checklist row in
`docs/PHASE_PLANS_README.md` so the next executor doesn't repeat the
per-course-subdir assumption.

The original `PHASE_12_7_PLAN.md` is left intact as a historical record per
the project convention that plans drift from real repo state and the code
adapts to the repo, not the other way around.
