# Phase 12.7 — Bulletin Scrape Extension (All Undergraduate Schools)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-run the existing `bulletin-scraper` so every NYU undergraduate school has full course-bulletin coverage in `data/bulletin-raw/courses/`. Phase 13's prereq + offering parser depends on this data being complete; today coverage is fragmented (CAS = 51 dept dirs ~ 2,603 courses; Stern undergrad = 10 dirs ~ 5% of 223 courses; Tandon = 35 dirs ~ partial; etc.).

**Architecture:** Pure data work. Re-run the existing Python BFS scraper (`tools/bulletin-scraper/scrape_bulletin.py`) with an explicit per-school prefix allowlist for all undergrad schools, parse-validate the output against the 17K-course Postgres dump (`data/course-catalog/course_descriptions.json`), commit the new markdown files. No engine changes, no UI changes.

**Tech Stack:** Python (existing scraper), `requests` + `markdownify`. Output: markdown + raw HTML files under `data/bulletin-raw/courses/<DEPT>_<SCHOOL_CODE>/`.

**Out of scope:**
- Graduate-school bulletins (different audience; NYU Path is undergrad-focused)
- Silver School of Social Work undergrad (different population, low cross-listing volume)
- Bulletin pages that live on standalone subdomains (e.g. `stern.nyu.edu`'s separate bulletin) — only `bulletins.nyu.edu` is in scope
- Parsing the markdown (Phase 12.8 handles that)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tools/bulletin-scraper/scrape_bulletin.py` | **Modify** | Add a `--prefix` allowlist mechanism (or extend the existing one) to scope BFS to the configured undergrad schools. |
| `tools/bulletin-scraper/UNDERGRAD_SCHOOLS.md` | **Create** | One-page reference: school code → bulletin URL prefix → expected course count. Used to QA the scrape's completeness. |
| `tools/bulletin-scraper/verify_coverage.py` | **Create** | Post-scrape audit: walks `data/bulletin-raw/courses/`, compares parsed course IDs to the 17K-course `course_descriptions.json`, prints missing-courses report per school. |
| `data/bulletin-raw/courses/` | **Modify** | New `<DEPT>_<SCHOOL_CODE>/` subdirectories will appear; existing ones may gain new course markdown files. |

---

## Task 1: Audit current scraper logic + identify expansion points

**Files:**
- Read-only: `tools/bulletin-scraper/scrape_bulletin.py`

The existing scraper is BFS over `bulletins.nyu.edu`. It already has skip-rules for `/class-search/`, `/search/`, `/archive/`. We need to confirm whether it has a positive prefix allowlist (which sections to crawl) or just negative skip-rules (everything that's not skipped).

- [ ] **Step 1: Read the scraper end-to-end**

```bash
wc -l tools/bulletin-scraper/scrape_bulletin.py
cat tools/bulletin-scraper/scrape_bulletin.py
```

Note the current `BASE_URL`, the skip-list, the BFS frontier rules, and how the output directory is computed from URL paths.

- [ ] **Step 2: Identify the school-routing logic**

Search for any path-prefix logic:

```bash
grep -n "courses\|undergraduate\|graduate\|cas\|stern\|tisch\|tandon" tools/bulletin-scraper/scrape_bulletin.py
```

Note: NYU's bulletin URL structure is roughly `bulletins.nyu.edu/undergraduate/<school>/courses/<dept>/`. So the path segment immediately under `/undergraduate/` is the school slug. List the slugs we expect:

| School | Bulletin slug (best-guess; verify in browser) | Course-suffix |
|---|---|---|
| College of Arts & Science | `cas` | -UA |
| Stern undergrad | `stern` | -UB |
| Tandon | `tandon` | -UY |
| Steinhardt | `steinhardt` | -UE |
| Gallatin | `gallatin` | -UF |
| Tisch | `tisch` | -UT |
| Abu Dhabi | `abu-dhabi` | -UH |
| Shanghai | `shanghai` | -SHU |

If any slug doesn't resolve to a real bulletin section, browser-verify with `curl -I https://bulletins.nyu.edu/undergraduate/<slug>/`. Update the table.

- [ ] **Step 3: Note the output convention**

Find the function that writes a scraped page to disk. The existing 51 CAS dept dirs follow `data/bulletin-raw/courses/<DEPT>_UA/<NUMBER>/`. The new dirs should follow the same pattern; verify by reading the path-mapping code.

- [ ] **Step 4: Document findings in a notes file**

Write a short scratch file (don't commit it — for your own reference during Tasks 2-4):

```
# Scraper audit notes
- BASE_URL: <found value>
- Skip-rules: <list>
- Output convention: data/bulletin-raw/courses/<DEPT>_<SCHOOL>/<NUMBER>/index.md
- Current undergrad coverage: CAS 51, Steinhardt 45, Shanghai 49, Abu Dhabi 44, Tandon 35, Gallatin 31, Tisch 20, Stern 10
```

No commit yet.

---

## Task 2: Add explicit per-school prefix allowlist

**Files:**
- Modify: `tools/bulletin-scraper/scrape_bulletin.py`
- Create: `tools/bulletin-scraper/UNDERGRAD_SCHOOLS.md`

The existing scraper relies on negative skip-rules. We add a positive allowlist so the BFS frontier only enqueues URLs whose paths start with one of the configured undergrad-school prefixes. This keeps the run focused and makes coverage auditable.

- [ ] **Step 1: Define the allowlist constant**

In `scrape_bulletin.py`, near the existing BASE_URL / skip-list constants, add:

```python
# Phase 12.7 — explicit per-school prefix allowlist for undergrad
# bulletin coverage. Only URL paths starting with one of these
# prefixes are enqueued onto the BFS frontier. Keeps the scrape
# focused on undergrad schools and makes coverage auditable.
UNDERGRAD_SCHOOL_PREFIXES = [
    "/undergraduate/college-of-arts-and-science/",
    "/undergraduate/stern-school-of-business/",
    "/undergraduate/tandon-school-of-engineering/",
    "/undergraduate/steinhardt-school-of-culture-education-and-human-development/",
    "/undergraduate/gallatin-school-of-individualized-study/",
    "/undergraduate/tisch-school-of-the-arts/",
    "/undergraduate/abu-dhabi/",
    "/undergraduate/shanghai/",
]
```

The exact slug strings MUST match what `bulletins.nyu.edu` actually serves. Browser-verify each with a curl HEAD or by visiting the URL. If a slug differs (e.g. `arts-science` instead of `college-of-arts-and-science`), update the constant.

- [ ] **Step 2: Wire allowlist into BFS frontier**

Find the function that decides whether a URL gets enqueued (probably `should_visit(url)` or inline in the BFS loop). Add the prefix check:

```python
def should_visit(url: str) -> bool:
    """Return True if the URL belongs to an in-scope undergrad section."""
    parsed = urlparse(url)
    if parsed.netloc != BASE_NETLOC:
        return False
    if any(parsed.path.startswith(skip) for skip in SKIP_PREFIXES):
        return False
    # Phase 12.7 — positive allowlist: only undergrad sections.
    if not any(parsed.path.startswith(allow) for allow in UNDERGRAD_SCHOOL_PREFIXES):
        return False
    return True
```

If the existing BFS logic is structured differently (e.g. inline skip checks in the loop body), adapt the integration point. The principle: when a URL would be enqueued, gate it on the prefix allowlist.

- [ ] **Step 3: Document the schools in `UNDERGRAD_SCHOOLS.md`**

Create `tools/bulletin-scraper/UNDERGRAD_SCHOOLS.md`:

```markdown
# NYU Path — Undergraduate Schools in Bulletin Scrape

This file is the source of truth for which schools' bulletins are
in scope for the NYU Path scrape. Phase 12.7 expanded coverage from
CAS-only to all undergrad schools; the planner's prereq + offering
parser (Phase 12.8) consumes the resulting markdown.

| School | Bulletin slug | Course-suffix | Expected courses (17K dump) |
|---|---|---|---|
| College of Arts & Science | college-of-arts-and-science | -UA | 2,603 |
| Stern School of Business (undergrad) | stern-school-of-business | -UB | 223 |
| Tandon School of Engineering | tandon-school-of-engineering | -UY | 526 |
| Steinhardt School of Culture, Education & Human Development | steinhardt-school-of-culture-education-and-human-development | -UE | 860 |
| Gallatin School of Individualized Study | gallatin-school-of-individualized-study | -UF | 46 |
| Tisch School of the Arts | tisch-school-of-the-arts | -UT | 979 |
| NYU Abu Dhabi | abu-dhabi | -UH | 1,089 |
| NYU Shanghai | shanghai | -SHU | 798 |

**Total expected:** ~7,124 undergrad courses.

**Out of scope:**
- Graduate programs (different audience)
- Silver School of Social Work undergrad (different population)
- Course-search live database (`/class-search/` — covered by `searchAvailability` tool at runtime)

**Re-running the scrape:**
```bash
cd tools/bulletin-scraper
python3 scrape_bulletin.py
```
```

- [ ] **Step 4: Commit (allowlist + docs only — no scrape data yet)**

```bash
git add tools/bulletin-scraper/scrape_bulletin.py tools/bulletin-scraper/UNDERGRAD_SCHOOLS.md
git commit -m "data(scraper): undergrad-school prefix allowlist + coverage docs"
```

---

## Task 3: Run the scrape

**Files:**
- Generated: many new files under `data/bulletin-raw/courses/<DEPT>_<SCHOOL>/`

This is a single `python3 scrape_bulletin.py` run. Expect 1-2 hours of passive runtime depending on rate-limiting. Re-runs are idempotent: existing markdown files are overwritten only if the source page changed.

- [ ] **Step 1: Dry-run first**

If the scraper has a `--dry-run` or similar flag, use it to preview the URLs that would be visited without writing files:

```bash
cd tools/bulletin-scraper
python3 scrape_bulletin.py --dry-run 2>&1 | head -100
```

Expected: a flat list of URLs, all matching one of the 8 school prefixes. Spot-check 5-10 to confirm they're real undergrad-bulletin pages.

If the scraper doesn't have a dry-run, modify it temporarily to print enqueued URLs without fetching, run, restore.

- [ ] **Step 2: Execute the full scrape**

```bash
cd tools/bulletin-scraper
python3 scrape_bulletin.py 2>&1 | tee scrape.log
```

Expected: progress output showing each URL fetched, output path written. Total runtime: 1-2 hours. The scraper is BFS so progress is roughly proportional to the school sizes (CAS finishes first since it's the most dense).

If the scraper rate-limits or errors out partway, restart it; it should resume from where it left off (existing files won't be re-fetched if the scraper is well-behaved).

- [ ] **Step 3: Inspect output**

```bash
ls data/bulletin-raw/courses/ | wc -l   # Total dept dirs
ls data/bulletin-raw/courses/ | sort | head -30
ls data/bulletin-raw/courses/ | grep "_UB$" | wc -l   # Stern dept count
ls data/bulletin-raw/courses/ | grep "_UY$" | wc -l   # Tandon dept count
```

Compare to the per-school expected dept counts. If a school is dramatically undercount (e.g. Stern at 5 dirs when we expect ~15-20), investigate: maybe the slug was wrong, maybe BFS hit a dead end.

- [ ] **Step 4: Spot-check 5 random new course markdown files**

Pick 5 newly-scraped course directories (e.g. one each from Stern, Tandon, Tisch, Steinhardt, Abu Dhabi). Verify each contains:
- An `index.md` with a course-description, `Prerequisites:` line (when applicable), and `Typically offered ... terms` line.
- A raw HTML fallback (the existing scraper saves both).

If any are malformed, the scraper hit a different page template — investigate before continuing to Task 4.

- [ ] **Step 5: Commit the scrape data**

The new markdown + HTML files are large in aggregate. Stage them in chunks per school to keep the commit history readable:

```bash
git add data/bulletin-raw/courses/*_UB
git commit -m "data(bulletin): Stern undergrad course bulletins (full coverage)"

git add data/bulletin-raw/courses/*_UY
git commit -m "data(bulletin): Tandon course bulletins (full coverage)"

git add data/bulletin-raw/courses/*_UE
git commit -m "data(bulletin): Steinhardt course bulletins (full coverage)"

git add data/bulletin-raw/courses/*_UT
git commit -m "data(bulletin): Tisch course bulletins (full coverage)"

git add data/bulletin-raw/courses/*_UF
git commit -m "data(bulletin): Gallatin course bulletins (full coverage)"

git add data/bulletin-raw/courses/*_UH
git commit -m "data(bulletin): Abu Dhabi course bulletins (full coverage)"

git add data/bulletin-raw/courses/*_SHU
git commit -m "data(bulletin): Shanghai course bulletins (full coverage)"

git add data/bulletin-raw/courses/*_UA
git commit -m "data(bulletin): CAS course bulletins (re-scraped for freshness)"
```

If any school has zero new files (already complete), skip its commit.

---

## Task 4: Coverage verification

**Files:**
- Create: `tools/bulletin-scraper/verify_coverage.py`

Compare the scraped course IDs against the 17K-course Postgres dump (`data/course-catalog/course_descriptions.json`). Any course present in the dump but missing from `data/bulletin-raw/courses/` is a coverage gap.

- [ ] **Step 1: Write the verification script**

Create `tools/bulletin-scraper/verify_coverage.py`:

```python
#!/usr/bin/env python3
"""
Phase 12.7 — Bulletin-coverage audit.

Walks data/bulletin-raw/courses/ to build the set of course IDs we
have markdown for. Loads data/course-catalog/course_descriptions.json
to get the ground-truth set of all courses (per the nyucourses
Postgres dump). Reports:
  - per-school: scraped vs. expected
  - missing courses (in dump but not scraped)
  - extra dirs (scraped but not in dump — usually OK; some courses
    may have been removed from the dump or renamed).

Run: python3 verify_coverage.py
"""

import json
import re
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BULLETIN_DIR = REPO_ROOT / "data" / "bulletin-raw" / "courses"
DUMP_PATH = REPO_ROOT / "data" / "course-catalog" / "course_descriptions.json"

# Match school suffix: -UA, -UB, -UE, -UF, -UH, -UI, -UT, -UY, -SHU.
# Exclude grad: -G* and undergraduate Silver UI (out of scope).
ALLOWED_SUFFIXES = {"UA", "UB", "UE", "UF", "UH", "UT", "UY", "SHU"}

COURSE_ID_RE = re.compile(r"^([A-Z]{2,5})-(UA|UB|UE|UF|UH|UI|UT|UY|SHU|G[A-Z]?)\s+(\d{1,4})$")

def parse_course_id(course_id: str):
    m = COURSE_ID_RE.match(course_id.strip())
    if not m:
        return None
    return m.group(1), m.group(2), m.group(3)

def scraped_course_ids() -> set[str]:
    """Walk data/bulletin-raw/courses/ and return all scraped course IDs."""
    out = set()
    if not BULLETIN_DIR.exists():
        print(f"WARNING: {BULLETIN_DIR} not found")
        return out
    for dept_dir in BULLETIN_DIR.iterdir():
        if not dept_dir.is_dir():
            continue
        # Dept-dir names look like "CSCI_UA" or "CORE_UA".
        m = re.match(r"^([A-Z]{2,5})_(UA|UB|UE|UF|UH|UT|UY|SHU)$", dept_dir.name)
        if not m:
            continue
        dept, school = m.group(1), m.group(2)
        for course_dir in dept_dir.iterdir():
            if not course_dir.is_dir():
                continue
            num = course_dir.name
            out.add(f"{dept}-{school} {num}")
    return out

def dump_course_ids() -> set[str]:
    """Load all course IDs from the 17K-course Postgres dump."""
    with open(DUMP_PATH) as f:
        data = json.load(f)
    out = set()
    for entry in data:
        cid = entry.get("courseCode") or entry.get("course_code")
        if not cid:
            continue
        parsed = parse_course_id(cid)
        if not parsed:
            continue
        dept, school, num = parsed
        if school not in ALLOWED_SUFFIXES:
            continue
        out.add(f"{dept}-{school} {num}")
    return out

def main():
    scraped = scraped_course_ids()
    dump = dump_course_ids()

    by_school_scraped: dict[str, set[str]] = defaultdict(set)
    by_school_dump: dict[str, set[str]] = defaultdict(set)
    for cid in scraped:
        school = cid.split("-", 1)[1].split(" ", 1)[0]
        by_school_scraped[school].add(cid)
    for cid in dump:
        school = cid.split("-", 1)[1].split(" ", 1)[0]
        by_school_dump[school].add(cid)

    schools = sorted(set(by_school_scraped) | set(by_school_dump))
    print(f"{'School':10s}  {'Scraped':>10s}  {'In dump':>10s}  {'Missing':>10s}  {'Coverage':>10s}")
    print("-" * 60)
    total_scraped = total_dump = total_missing = 0
    for school in schools:
        s = len(by_school_scraped.get(school, set()))
        d = len(by_school_dump.get(school, set()))
        m = len(by_school_dump.get(school, set()) - by_school_scraped.get(school, set()))
        cov = f"{(s / d * 100):.1f}%" if d > 0 else "n/a"
        total_scraped += s
        total_dump += d
        total_missing += m
        print(f"{school:10s}  {s:>10d}  {d:>10d}  {m:>10d}  {cov:>10s}")
    print("-" * 60)
    print(f"{'TOTAL':10s}  {total_scraped:>10d}  {total_dump:>10d}  {total_missing:>10d}")
    print()

    # Sample 10 missing courses per school for spot-checking.
    print("Sample missing courses (10 per school):")
    for school in schools:
        missing = sorted(by_school_dump.get(school, set()) - by_school_scraped.get(school, set()))[:10]
        if not missing:
            continue
        print(f"  -{school}: {', '.join(missing[:10])}")

if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run the verification**

```bash
python3 tools/bulletin-scraper/verify_coverage.py
```

Expected output: per-school table showing >=90% coverage for in-scope schools. Missing courses are usually:
- Cross-listed courses (one canonical home, listed under another school)
- Rarely-offered courses that the bulletin omits but the registrar still tracks
- Courses removed from the catalog since the dump was taken

- [ ] **Step 3: Investigate gaps**

For any school with <80% coverage:
- Sample 5 missing course IDs.
- Check if their bulletin URLs resolve. If yes → BFS missed them; investigate why.
- If the URLs 404, those courses aren't in the bulletin (probably removed). Ignore.

If a school is consistently <70% coverage, the BFS may have a depth limit hitting before the dept's course list is fully traversed. Bump the BFS depth limit and re-run.

- [ ] **Step 4: Commit the verifier**

```bash
git add tools/bulletin-scraper/verify_coverage.py
git commit -m "data(scraper): coverage-audit script (scraped vs. 17K dump)"
```

- [ ] **Step 5: Push**

```bash
git push
```

---

## Self-review notes

**Coverage targets:** ≥90% per school against the 17K dump is the bar. <80% coverage on any school blocks Phase 12.8 (the parser needs the data).

**Idempotency:** the scrape is re-runnable. Phase 12.8's parser will run on whatever's in `data/bulletin-raw/courses/` at parse time.

**No engine impact:** zero changes to `packages/engine/`, `apps/web/`, or `data/programs/`. Pure data prep.

**Scope discipline:** undergrad only, `bulletins.nyu.edu` only. Stern's separate `stern.nyu.edu` bulletin (if one exists) is out of scope; if it has data the main bulletin doesn't, that's a Phase 14+ concern.

**Verifier resilience:** if `data/course-catalog/course_descriptions.json` is moved or renamed, the verifier script's `DUMP_PATH` constant must be updated. Document this in the script header.
