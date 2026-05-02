#!/usr/bin/env python3
"""
verify_coverage.py — Phase 12.7 / Phase 12.8 coverage gate.

What this script verifies
-------------------------
For each of the 8 in-scope NYU undergraduate course-suffixes (UA, UB, UE, UF,
UH, UT, UY, SHU), this script checks that every department-prefix appearing in
the live Postgres course dump has a corresponding scraped bulletin page on
disk. If yes, Phase 12.8's parser has a complete data substrate to work
against. If no, the missing prefixes block Phase 12.8 and must be scraped
first.

On-disk layout (LOCKED for Phase 12.8 parser; do not assume otherwise)
----------------------------------------------------------------------
Bulletins live at:

    data/bulletin-raw/courses/<dept>_<suffix>/_index.md
    data/bulletin-raw/courses/<dept>_<suffix>/_index.html

There is ONE page per department, listing all courses inline. There are NO
per-course subdirectories anywhere in the tree — bulletins.nyu.edu does not
publish per-course pages at the /courses/ route. (Richer per-course pages
exist at /search/?P=… but were deliberately skipped during scrape because BFS
over them explodes into >247k URLs.)

Directory names are lowercase, with the dept and suffix joined by a single
underscore. Department names can contain digits (e.g. `cwrg1_uc`, `bas01_dn`).
The regex that recognizes a valid dept-dir is therefore digit-tolerant:

    ^[a-z][a-z0-9]*_(ua|ub|ue|uf|uh|ut|uy|shu)$

Postgres dump shape
-------------------
DUMP_PATH (`data/course-catalog/course_descriptions.json`) is a DICT, not a
list, with two keys:
    - `_meta` — provenance (source DB, dump timestamp, source hash)
    - `courses` — list of course records, each with a `courseCode` field in
      the camelCase form `"<DEPT>-<SUFFIX> <NUMBER>"` (single space,
      uppercase suffix, e.g. `"CSCI-UA 60"`, `"INTM-SHU 140T-A"`).

If the dump file ever moves or its top-level shape changes, update DUMP_PATH
and the loader in `load_pg_depts()` accordingly. This script is the gate for
Phase 12.8 — if it exits non-zero, the parser cannot proceed.

Exit codes
----------
0 — every Postgres dept-prefix has a scraped bulletin page (coverage complete
    at dept-prefix granularity for all 8 suffixes). Phase 12.8 may proceed.
1 — at least one suffix has missing dept-prefixes. Output lists exactly which
    ones. Re-scrape the missing pages before running Phase 12.8's parser.

Usage
-----
    python3 tools/bulletin-scraper/verify_coverage.py
    echo "exit=$?"
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# Resolve paths relative to this file so the script runs correctly regardless
# of the caller's cwd.
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
COURSES_DIR = REPO_ROOT / "data" / "bulletin-raw" / "courses"
DUMP_PATH = REPO_ROOT / "data" / "course-catalog" / "course_descriptions.json"

# Eight undergraduate course-suffixes in scope. Lowercase here for alignment
# with the on-disk directory naming convention; uppercase form is used when
# matching Postgres courseCode strings.
IN_SCOPE_SUFFIXES = ("ua", "ub", "ue", "uf", "uh", "ut", "uy", "shu")

# Disk directory pattern: lowercase dept (digit-tolerant) + underscore +
# in-scope suffix. Out-of-scope suffixes (graduate ones like _gx, _md, _lw
# etc.) are silently skipped.
DISK_DIR_RE = re.compile(
    r"^([a-z][a-z0-9]*)_(" + "|".join(IN_SCOPE_SUFFIXES) + r")$"
)

# Postgres courseCode pattern. Loose on the trailing portion so that
# multi-segment numbers like `INTM-SHU 140T-A` and `EAP-SHU 101-20A` are
# captured. Placeholder rows like `PHYS-UH -` (course number missing) are
# correctly excluded — they are not real courses and must not contribute to
# the dept-prefix set.
PG_CODE_RE = re.compile(
    r"^([A-Z][A-Z0-9]*)-(UA|UB|UE|UF|UH|UT|UY|SHU) [0-9]"
)


def load_disk_depts() -> dict[str, set[str]]:
    """Walk data/bulletin-raw/courses/ and return {suffix: {dept, ...}}.

    A directory only counts if it (a) matches DISK_DIR_RE and (b) actually
    contains an `_index.md` file — empty stub directories are skipped.
    Department names are stored uppercase to align with Postgres comparison.
    """
    out: dict[str, set[str]] = {s: set() for s in IN_SCOPE_SUFFIXES}
    if not COURSES_DIR.is_dir():
        print(
            f"ERROR: bulletin courses dir not found: {COURSES_DIR}",
            file=sys.stderr,
        )
        sys.exit(2)
    for child in COURSES_DIR.iterdir():
        if not child.is_dir():
            continue
        m = DISK_DIR_RE.match(child.name)
        if not m:
            # Out-of-scope suffix, or a non-conforming directory name. Skip.
            continue
        if not (child / "_index.md").is_file():
            # Empty stub or partial scrape — does not count as coverage.
            continue
        dept, suffix = m.group(1).upper(), m.group(2)
        out[suffix].add(dept)
    return out


def load_pg_depts() -> dict[str, set[str]]:
    """Load Postgres dump and return {suffix: {dept, ...}} for in-scope rows.

    Top-level is `{"_meta": {...}, "courses": [...]}`. Each course has a
    `courseCode` of the form `"<DEPT>-<SUFFIX> <NUMBER>"`. The regex captures
    dept (group 1) and suffix (group 2), lowercased here to align with the
    disk dict's keys.
    """
    out: dict[str, set[str]] = {s: set() for s in IN_SCOPE_SUFFIXES}
    if not DUMP_PATH.is_file():
        print(f"ERROR: dump not found: {DUMP_PATH}", file=sys.stderr)
        sys.exit(2)
    with DUMP_PATH.open(encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or "courses" not in data:
        print(
            "ERROR: dump shape unexpected — expected dict with 'courses' key",
            file=sys.stderr,
        )
        sys.exit(2)
    for entry in data["courses"]:
        code = entry.get("courseCode", "")
        m = PG_CODE_RE.match(code)
        if not m:
            continue
        dept, suffix = m.group(1), m.group(2).lower()
        out[suffix].add(dept)
    return out


def main() -> int:
    disk_depts = load_disk_depts()
    pg_depts = load_pg_depts()

    # Per-suffix coverage table.
    print()
    header = (
        f"{'suffix':<8} {'pg-depts':>9} {'disk-depts':>11} "
        f"{'missing':>8} {'extras':>7} {'coverage%':>10}"
    )
    print(header)
    print("-" * len(header))

    total_pg = 0
    total_disk = 0
    total_missing = 0
    total_extras = 0
    total_intersect = 0

    missing_by_suffix: dict[str, set[str]] = {}
    extras_by_suffix: dict[str, set[str]] = {}

    for suffix in IN_SCOPE_SUFFIXES:
        pg = pg_depts[suffix]
        disk = disk_depts[suffix]
        missing = pg - disk
        extras = disk - pg
        intersect = pg & disk
        coverage = (len(intersect) / len(pg) * 100.0) if pg else 100.0

        missing_by_suffix[suffix] = missing
        extras_by_suffix[suffix] = extras

        total_pg += len(pg)
        total_disk += len(disk)
        total_missing += len(missing)
        total_extras += len(extras)
        total_intersect += len(intersect)

        print(
            f"{suffix.upper():<8} {len(pg):>9} {len(disk):>11} "
            f"{len(missing):>8} {len(extras):>7} {coverage:>9.1f}%"
        )

    print("-" * len(header))
    total_cov = (total_intersect / total_pg * 100.0) if total_pg else 100.0
    print(
        f"{'TOTAL':<8} {total_pg:>9} {total_disk:>11} "
        f"{total_missing:>8} {total_extras:>7} {total_cov:>9.1f}%"
    )

    # Missing dept blocker section.
    print()
    print("MISSING DEPTS (Phase 12.8 blocker if any):")
    any_missing = False
    for suffix in IN_SCOPE_SUFFIXES:
        missing = missing_by_suffix[suffix]
        if missing:
            any_missing = True
            depts = ", ".join(sorted(missing))
            print(f"  {suffix.upper()}: {depts}")
    if not any_missing:
        print("  none — coverage complete")

    # Extras (informational).
    print()
    print("EXTRAS (informational):")
    print(
        "  Note: bulletin lists more depts than Postgres has live rows for in"
    )
    print(
        "  some suffixes. Acceptable — bulletin enumerates all dept programs;"
    )
    print(
        "  Postgres only carries depts with currently-active course offerings."
    )
    any_extras = False
    for suffix in IN_SCOPE_SUFFIXES:
        extras = extras_by_suffix[suffix]
        if extras:
            any_extras = True
            depts = ", ".join(sorted(extras))
            print(f"  {suffix.upper()}: {depts}")
    if not any_extras:
        print("  none")

    print()
    return 1 if any_missing else 0


if __name__ == "__main__":
    sys.exit(main())
