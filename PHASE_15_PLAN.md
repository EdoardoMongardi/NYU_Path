# Phase 15 — Live Section Materialization (FOSE) + Time-Conflict Detection

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the structural multi-semester plan from Phase 13/14 and, for the IMMEDIATE term the student is about to register for, query live FOSE for each planned course → check open sections → detect time conflicts between sections → enumerate conflict-free combinations → return concrete `{course + section CRN + meeting time + instructor}` bundles the student can register against. Per-call data-availability gating: each FOSE query checks whether real availability data is present, partial, or empty, and gracefully degrades. Instructor names are always surfaced (the student picks based on their own preferences — no RateMyProfessor integration; that path is dropped).

**Architecture:** A new "section-materialization" layer. `materialize_sections` is a dedicated tool (NOT folded into `plan_forward_degree`) that takes a target term + a list of structural-plan courses for that term, runs a per-call FOSE query, and returns one of three states:

1. **`full`** — FOSE has real availability data with meeting times. Compute conflict-free section combinations; return concrete bundles with instructor names.
2. **`partial`** — FOSE has course listings but meeting times are absent or sparse (typical right before registration opens). Return what's available + a note explaining that section-level data isn't ready yet.
3. **`unavailable`** — FOSE returns nothing for the term (typical for terms 1+ years out). Skip the materialization; tell the student section data is only available closer to registration.

The agent calls `materialize_sections` AFTER `view_forward_plan`. Phase 13/14's structural plan remains the source of truth for the multi-semester view; section materialization is the additive concrete-section layer for the immediate term only.

**Tech Stack:** TypeScript, vitest. Engine: `packages/engine/src/agent/sectionMaterialization/`. Web: `apps/web/app/chat/scheduleSidebar.tsx` (extension).

**Prerequisites:**
- **Phase 13** complete (multi-semester planner with `forwardSchedule` on `ToolSession`).
- **Phase 14** complete (preferences + alternatives — these compose with Phase 15 cleanly: preferences shape the structural plan, FOSE materializes the concrete sections).

**Out of scope:**
- RateMyProfessor / instructor-rating overlay. Decision: SKIPPED. Reasons: ToS violation risk (RMP Section 6 explicitly prohibits scraping; documented C&D enforcement); poor data density at NYU CS faculty (most have <10 ratings); top wrappers are 2+ years stale. Instructor name string IS surfaced for the student to make their own choice.
- NYU CourseEvalPro / Albert internal evaluations (NetID-gated, NYU-policy risk).
- Time-of-day preferences ("no Friday classes") — Phase 16+ if requested.
- Drag-to-reorder section combinations.
- Server-side caching of FOSE responses to a database (Phase 16+; Phase 15 uses in-memory TTL cache only).

---

## Locked design decisions (Phase 15)

| # | Decision | Behavior |
|---|---|---|
| 16 | Per-call data-availability gate | Each `materialize_sections` invocation checks FOSE response shape: full data vs. course-listings-without-times vs. empty. NOT a static window; we don't assume "registration opens April 20"; we check live each time. |
| 17 | Instructor names always surfaced | FOSE returns `instr` (string) per section. We thread it through to the UI. Student picks a section based on (open status + meeting time + instructor name). No instructor-rating overlay. |
| 18 | Time-conflict detection | Two sections conflict if any of their `MeetingPattern`s overlap on the same day. Conflict-free combinations are enumerated combinatorially; if the count exceeds a cap (e.g. 50), return the top-K by some heuristic and tell the student. |
| 19 | Course-swap on FOSE-unavailable | If a structural-plan course has zero open sections for the target term, the materializer asks the structural solver for an alternative legal placement (i.e. swap to a different unmet-requirement course) and defers the original to a later term. The structural plan persists; only the immediate-term placement gets adjusted. |
| 20 | FOSE TTL cache | In-memory cache, 5-minute TTL per `(termCode, keyword)` query. Reduces FOSE load + improves latency on repeated queries within one session. No persistence. |

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tools/fose-recorder/recordFixtures.ts` | **Create** | One-off script: hits live FOSE for ~30-50 representative queries, saves raw responses. Run once before designing the parser. |
| `packages/engine/tests/fixtures/fose/` | **Create (directory)** | Real FOSE response fixtures. Used by parser + materializer tests. |
| `packages/engine/src/agent/sectionMaterialization/types.ts` | **Create** | `MeetingPattern`, `SectionView`, `MaterializedSemester`, `MaterializationResult` types. |
| `packages/engine/src/agent/sectionMaterialization/parseMeetingTimes.ts` | **Create** | Pure parser: `hours` HTML string → `MeetingPattern[]` with `{day, startMin, endMin}`. |
| `packages/engine/src/agent/sectionMaterialization/conflictDetection.ts` | **Create** | Pure helper: `conflicts(a: MeetingPattern[], b: MeetingPattern[]): boolean` + `enumerateConflictFreeCombinations(...)`. |
| `packages/engine/src/agent/sectionMaterialization/foseAvailabilityGate.ts` | **Create** | Inspects a FOSE response sample to classify state: `full` / `partial` / `unavailable`. |
| `packages/engine/src/agent/sectionMaterialization/materialize.ts` | **Create** | Orchestrator: pulls FOSE, gates on availability, swaps unavailable courses, enumerates combinations, builds the result. |
| `packages/engine/src/agent/sectionMaterialization/foseCache.ts` | **Create** | 5-minute TTL in-memory cache for FOSE responses. |
| `packages/engine/src/agent/tools/materializeSections.ts` | **Create** | Two-step tool: `propose_section_combination` (read-only, returns combinations) + `confirm_section_combination` (applies — pins the chosen combination to the schedule). |
| `packages/engine/src/agent/registry.ts` | **Modify** | Register the new tool(s). |
| `apps/web/app/chat/scheduleSidebar.tsx` | **Modify** | For the IMMEDIATE term, render concrete section cards (CRN + meeting times + instructor) instead of the structural slot list. Combination-picker UI when multiple options are valid. |
| `apps/web/app/chat/chat.module.css` | **Modify** | Section-card styles, combination-picker styles. |
| `packages/engine/tests/agent/parseMeetingTimes.test.ts` | **Create** | Parser tests against real fixtures. |
| `packages/engine/tests/agent/conflictDetection.test.ts` | **Create** | Conflict-detection unit tests. |
| `packages/engine/tests/agent/materialize.test.ts` | **Create** | Orchestrator integration tests. |
| `packages/engine/src/agent/tools/searchAvailability.ts` | **Modify (cleanup)** | Phase-13/14 audit found a duplicate at `packages/engine/src/tools/searchAvailability.ts`. Delete the dead one and confirm the agent registry references the canonical path. |

---

## Task 0: Record real FOSE fixtures

**Files:**
- Create: `tools/fose-recorder/recordFixtures.ts`
- Create: `packages/engine/tests/fixtures/fose/` directory + ~30-50 JSON files

The existing repo has zero real FOSE response samples. The `hours` field is documented as "formatted HTML" but its actual structure is unknown. Without real samples, the parser is designed blind. This task hits FOSE once with varied queries and commits the raw responses as test fixtures.

- [ ] **Step 1: Define the query matrix**

The fixtures must span:
- Schools: CAS (-UA), Stern (-UB), Tandon (-UY), Tisch (-UT), Steinhardt (-UE), Gallatin (-UF), Abu Dhabi (-UH), Shanghai (-SHU)
- Course types: typical lecture, lab+lecture composite (BIOL-UA 11), language sequence (FREN-UA 1-4), multi-meeting (e.g. M/W/F + Tu/Th), online/asynchronous, J-term, summer-only
- Term: a current/registered term (most data) + one near-future term (partial) + one far-future term (empty) — the gate-state cases

- [ ] **Step 2: Write the recorder**

Create `tools/fose-recorder/recordFixtures.ts`:

```typescript
/**
 * Phase 15 Task 0 — One-off recorder for FOSE fixtures.
 *
 * Run: pnpm tsx tools/fose-recorder/recordFixtures.ts
 *
 * Hits live FOSE for ~30-50 representative queries; saves each raw
 * response as JSON under packages/engine/tests/fixtures/fose/.
 * Used by parseMeetingTimes.ts + materialize.ts as ground-truth for
 * test fixtures — without this we'd be designing the parser blind.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { searchCourses, generateTermCode } from "../../packages/engine/src/api/nyuClassSearch";

const FIXTURE_DIR = path.resolve(__dirname, "../../packages/engine/tests/fixtures/fose");

interface Query {
    keyword: string;
    year: number;
    term: "spring" | "summer" | "fall";
    label: string; // file-safe label, e.g. "csci-ua-101_2026-fall"
}

// Query matrix — span schools, formats, term states.
const QUERIES: Query[] = [
    // --- Current/active term (most data expected) ---
    { keyword: "CSCI-UA 101", year: 2026, term: "fall", label: "csci-ua-101_2026-fall" },
    { keyword: "CSCI-UA 421", year: 2027, term: "spring", label: "csci-ua-421_2027-spring" },
    { keyword: "MATH-UA 121", year: 2026, term: "fall", label: "math-ua-121_2026-fall" },
    { keyword: "BIOL-UA 11", year: 2026, term: "fall", label: "biol-ua-11_2026-fall" },     // lab+lecture
    { keyword: "FREN-UA 1", year: 2026, term: "fall", label: "fren-ua-1_2026-fall" },       // language
    { keyword: "ECON-UA 1", year: 2026, term: "fall", label: "econ-ua-1_2026-fall" },
    { keyword: "CORE-UA 400", year: 2026, term: "fall", label: "core-ua-400_2026-fall" },
    { keyword: "HIST-UA 1", year: 2026, term: "fall", label: "hist-ua-1_2026-fall" },
    { keyword: "MUS-UA 1", year: 2026, term: "fall", label: "mus-ua-1_2026-fall" },
    { keyword: "STERN-UB 1", year: 2026, term: "fall", label: "stern-ub-1_2026-fall" },
    { keyword: "MGMT-UB 1", year: 2026, term: "fall", label: "mgmt-ub-1_2026-fall" },
    { keyword: "FIN-UB 1", year: 2026, term: "fall", label: "fin-ub-1_2026-fall" },
    { keyword: "TISCH-UT", year: 2026, term: "fall", label: "tisch-ut_2026-fall" },         // department-wide
    { keyword: "MUED-UE", year: 2026, term: "fall", label: "mued-ue_2026-fall" },
    { keyword: "GALLATIN-UF", year: 2026, term: "fall", label: "gallatin-uf_2026-fall" },
    { keyword: "CSCI-UY 1114", year: 2026, term: "fall", label: "csci-uy-1114_2026-fall" }, // Tandon
    { keyword: "CSCI-SHU", year: 2026, term: "fall", label: "csci-shu_2026-fall" },         // Shanghai
    { keyword: "CSCI-UH", year: 2026, term: "fall", label: "csci-uh_2026-fall" },           // Abu Dhabi

    // --- Partial / pre-registration term (course list but maybe no times) ---
    { keyword: "CSCI-UA 101", year: 2027, term: "spring", label: "csci-ua-101_2027-spring" },
    { keyword: "MATH-UA 121", year: 2027, term: "spring", label: "math-ua-121_2027-spring" },

    // --- Far-future term (expected empty) ---
    { keyword: "CSCI-UA 101", year: 2028, term: "fall", label: "csci-ua-101_2028-fall" },
    { keyword: "MATH-UA 121", year: 2028, term: "spring", label: "math-ua-121_2028-spring" },

    // --- Summer + J-term (sparse data — most dept don't run them) ---
    { keyword: "CSCI-UA 101", year: 2026, term: "summer", label: "csci-ua-101_2026-summer" },
    { keyword: "MATH-UA 121", year: 2026, term: "summer", label: "math-ua-121_2026-summer" },

    // --- Multi-meeting / lab patterns ---
    { keyword: "CHEM-UA 125", year: 2026, term: "fall", label: "chem-ua-125_2026-fall" },     // chem with lab
    { keyword: "PHYS-UA 11", year: 2026, term: "fall", label: "phys-ua-11_2026-fall" },       // physics with lab

    // --- Edge case: empty result expected for non-existent course ---
    { keyword: "ZZZZZ-UA 9999", year: 2026, term: "fall", label: "nonexistent_2026-fall" },
];

async function main() {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
    let success = 0, failed = 0;
    for (const q of QUERIES) {
        const termCode = generateTermCode(q.year, q.term);
        try {
            const results = await searchCourses(termCode, q.keyword);
            const fixture = {
                query: q,
                termCode,
                recordedAt: new Date().toISOString(),
                resultCount: results.length,
                results,
            };
            const outPath = path.join(FIXTURE_DIR, `${q.label}.json`);
            fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2) + "\n");
            console.log(`  ✓ ${q.label} (${results.length} sections)`);
            success++;
        } catch (e) {
            console.error(`  ✗ ${q.label}: ${e instanceof Error ? e.message : e}`);
            failed++;
        }
        // Be polite to FOSE.
        await new Promise(r => setTimeout(r, 250));
    }
    console.log(`\nSuccess: ${success}, Failed: ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Run the recorder**

```bash
pnpm tsx tools/fose-recorder/recordFixtures.ts
```

Expected: ~25-30 successful captures (some queries will return empty for far-future terms — those are valid fixtures showing the empty case).

- [ ] **Step 4: Inspect the fixtures**

```bash
ls packages/engine/tests/fixtures/fose/ | head -30
cat packages/engine/tests/fixtures/fose/csci-ua-101_2026-fall.json | jq '.results[0]'
cat packages/engine/tests/fixtures/fose/biol-ua-11_2026-fall.json | jq '.results[0:3] | map({code, hours, instr, stat})'
```

Document the actual `hours` format you see. Common patterns to look for:
- `"MoWe 9:30am - 10:45am"`
- `"TuTh 11:00 AM - 12:15 PM"`
- `"Mo 6:00pm - 8:00pm<br>We 6:00pm - 8:00pm"` (multi-meeting separated by HTML)
- `"Online (Asynchronous)"` / `"TBA"` / `""` (empty)
- Lab + lecture composite often has both patterns concatenated

Capture any unusual variants in a comment at the top of `parseMeetingTimes.ts` (Task 1).

- [ ] **Step 5: Commit fixtures**

```bash
git add tools/fose-recorder/recordFixtures.ts packages/engine/tests/fixtures/fose/
git commit -m "data(fose): fixture recorder + ~30 real FOSE response samples"
```

---

## Task 1: Time-pattern parser

**Files:**
- Create: `packages/engine/src/agent/sectionMaterialization/parseMeetingTimes.ts`
- Create: `packages/engine/src/agent/sectionMaterialization/types.ts`
- Create: `packages/engine/tests/agent/parseMeetingTimes.test.ts`

Turn FOSE's `hours` HTML string into structured `MeetingPattern[]` with `{day, startMin, endMin}` so the conflict detector can reason about it.

- [ ] **Step 1: Define types**

Create `packages/engine/src/agent/sectionMaterialization/types.ts`:

```typescript
export type DayOfWeek = "M" | "Tu" | "W" | "Th" | "F" | "Sa" | "Su";

export interface MeetingPattern {
    day: DayOfWeek;
    /** Minutes since midnight (e.g. 9:30 AM = 570). */
    startMin: number;
    /** Minutes since midnight (e.g. 10:45 AM = 645). */
    endMin: number;
}

export type ParseResult =
    | { kind: "ok"; patterns: MeetingPattern[] }
    | { kind: "asynchronous" }      // online / async / TBA / no time
    | { kind: "unparseable"; raw: string };

export interface SectionView {
    courseId: string;     // "CSCI-UA 421"
    title: string;
    crn: string;
    credits: string;       // FOSE returns string
    instructor: string;    // raw `instr` from FOSE — surfaced verbatim to student
    status: string;        // "O"|"W"|"C"|"A"... opaque per FOSE
    meetingPatterns: MeetingPattern[];
    /** True when patterns is empty AND parse said "asynchronous" — distinguishes
     *  from "we just couldn't parse." */
    isAsynchronous: boolean;
    /** Raw `hours` string for debugging / display. */
    rawHours: string;
}

export interface MaterializedSemester {
    term: string;
    /** Per-course bundles. Each course has zero or more SectionViews
     *  (zero = unavailable; >0 = available). */
    courses: Array<{
        courseId: string;
        title: string;
        sections: SectionView[];
    }>;
    /** All conflict-free combinations across the courses (cross-product
     *  filtered for time conflicts). Capped at MAX_COMBINATIONS. */
    combinations: Array<{
        sections: SectionView[];   // one per course
        weeklyHours: number;       // total weekly meeting time
    }>;
    /** When combinations.length === MAX_COMBINATIONS and there are more,
     *  this is the truncation note. */
    combinationsTruncated: boolean;
}

export type AvailabilityState = "full" | "partial" | "unavailable";

export interface MaterializationResult {
    state: AvailabilityState;
    /** Populated when state === "full". */
    semester?: MaterializedSemester;
    /** Populated when state === "partial" — courses are listed but meeting
     *  times are missing. The student sees a warning + the structural plan
     *  remains the source of truth until registration data is ready. */
    partialCourses?: Array<{ courseId: string; title: string; sections: SectionView[] }>;
    /** Always populated: explanation for the student. */
    message: string;
}
```

- [ ] **Step 2: Write the parser test (TDD)**

Create `packages/engine/tests/agent/parseMeetingTimes.test.ts`. Use the actual fixture format you observed in Task 0 Step 4. Sample structure:

```typescript
import { describe, it, expect } from "vitest";
import { parseMeetingTimes } from "../../src/agent/sectionMaterialization/parseMeetingTimes";

describe("parseMeetingTimes", () => {
    it("parses 'MoWe 9:30am - 10:45am' as two MeetingPatterns", () => {
        const out = parseMeetingTimes("MoWe 9:30am - 10:45am");
        expect(out.kind).toBe("ok");
        if (out.kind === "ok") {
            expect(out.patterns.length).toBe(2);
            expect(out.patterns[0]).toEqual({ day: "M", startMin: 570, endMin: 645 });
            expect(out.patterns[1]).toEqual({ day: "W", startMin: 570, endMin: 645 });
        }
    });

    it("parses 'TuTh 11:00 AM - 12:15 PM' (mixed case + AM/PM)", () => {
        const out = parseMeetingTimes("TuTh 11:00 AM - 12:15 PM");
        expect(out.kind).toBe("ok");
        if (out.kind === "ok") {
            expect(out.patterns).toEqual([
                { day: "Tu", startMin: 660, endMin: 735 },
                { day: "Th", startMin: 660, endMin: 735 },
            ]);
        }
    });

    it("parses multi-meeting separated by <br>", () => {
        const out = parseMeetingTimes("Mo 6:00pm - 8:00pm<br>We 6:00pm - 8:00pm");
        expect(out.kind).toBe("ok");
        if (out.kind === "ok") expect(out.patterns.length).toBe(2);
    });

    it("classifies 'Online (Asynchronous)' as asynchronous", () => {
        expect(parseMeetingTimes("Online (Asynchronous)")).toEqual({ kind: "asynchronous" });
    });

    it("classifies 'TBA' as asynchronous", () => {
        expect(parseMeetingTimes("TBA")).toEqual({ kind: "asynchronous" });
    });

    it("classifies empty string as asynchronous", () => {
        expect(parseMeetingTimes("")).toEqual({ kind: "asynchronous" });
    });

    it("returns unparseable for unrecognized format", () => {
        const out = parseMeetingTimes("¯\\_(ツ)_/¯");
        expect(out.kind).toBe("unparseable");
    });

    it("strips HTML before parsing", () => {
        const out = parseMeetingTimes('<span class="x">MoWe 9:30am - 10:45am</span>');
        expect(out.kind).toBe("ok");
    });

    // Real-fixture-driven tests: load actual FOSE fixtures from
    // packages/engine/tests/fixtures/fose/ and verify the parser
    // doesn't crash on any of them, AND classifies them sensibly
    // (no fixture should produce "unparseable" — if any do, we
    // missed a real-world format and need to extend the regex).
    it("handles every real FOSE fixture without crashing", () => {
        const fixtureDir = path.resolve(__dirname, "../fixtures/fose");
        for (const file of fs.readdirSync(fixtureDir)) {
            const data = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), "utf8"));
            for (const section of data.results ?? []) {
                const result = parseMeetingTimes(section.hours ?? "");
                // All fixtures should classify cleanly. If any return
                // "unparseable", investigate the fixture's `hours`
                // and extend the parser.
                expect(result.kind).not.toBe("unparseable");
            }
        }
    });
});
```

- [ ] **Step 3: Run test to verify failure**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/parseMeetingTimes.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement the parser**

Create `packages/engine/src/agent/sectionMaterialization/parseMeetingTimes.ts`. Adapt the regex to match the real fixture formats from Task 0:

```typescript
import type { MeetingPattern, DayOfWeek, ParseResult } from "./types.js";

const DAY_TOKENS: Array<{ token: string; day: DayOfWeek }> = [
    { token: "Mo", day: "M" },
    { token: "Tu", day: "Tu" },
    { token: "We", day: "W" },
    { token: "Th", day: "Th" },
    { token: "Fr", day: "F" },
    { token: "Sa", day: "Sa" },
    { token: "Su", day: "Su" },
];

const ASYNC_PATTERNS = [
    /\bonline\b.*\basynchronous\b/i,
    /\basync\b/i,
    /^\s*tba\s*$/i,
    /^\s*$/,
];

function timeToMinutes(t: string): number | null {
    const m = t.match(/^(\d{1,2}):(\d{2})\s*([ap])m?$/i);
    if (!m) return null;
    let h = parseInt(m[1]!, 10);
    const min = parseInt(m[2]!, 10);
    const ampm = m[3]!.toLowerCase();
    if (ampm === "p" && h < 12) h += 12;
    if (ampm === "a" && h === 12) h = 0;
    return h * 60 + min;
}

function stripHtml(s: string): string {
    return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeDays(daysStr: string): DayOfWeek[] {
    const out: DayOfWeek[] = [];
    let cursor = 0;
    while (cursor < daysStr.length) {
        let matched = false;
        for (const { token, day } of DAY_TOKENS) {
            if (daysStr.startsWith(token, cursor)) {
                out.push(day);
                cursor += token.length;
                matched = true;
                break;
            }
        }
        if (!matched) cursor++;
    }
    return out;
}

const MEETING_RE = /^([A-Za-z]+)\s+(\d{1,2}:\d{2}\s*[ap]m?)\s*-\s*(\d{1,2}:\d{2}\s*[ap]m?)\s*$/i;

function parseSingleMeeting(s: string): MeetingPattern[] | null {
    const m = MEETING_RE.exec(s.trim());
    if (!m) return null;
    const days = tokenizeDays(m[1]!);
    const start = timeToMinutes(m[2]!);
    const end = timeToMinutes(m[3]!);
    if (days.length === 0 || start == null || end == null) return null;
    return days.map(day => ({ day, startMin: start, endMin: end }));
}

export function parseMeetingTimes(raw: string): ParseResult {
    const stripped = stripHtml(raw);
    if (ASYNC_PATTERNS.some(p => p.test(stripped))) return { kind: "asynchronous" };

    // Multi-meeting separator: <br> in raw HTML → spaces post-strip.
    // Try to split on " ; " or look for repeated "<day-pattern> <time-range>"
    // segments. For initial implementation, split on multiple-space gaps
    // that look like meeting-pattern boundaries.
    const parts = raw.split(/<br\s*\/?>/i).map(stripHtml).filter(Boolean);
    const partsToTry = parts.length > 1 ? parts : [stripped];

    const allPatterns: MeetingPattern[] = [];
    let anyMatched = false;
    for (const part of partsToTry) {
        const matched = parseSingleMeeting(part);
        if (matched) {
            allPatterns.push(...matched);
            anyMatched = true;
        }
    }
    if (anyMatched) return { kind: "ok", patterns: allPatterns };
    return { kind: "unparseable", raw: stripped };
}
```

Adapt the regex + day tokens to the actual fixture format. If a fixture produces `"unparseable"`, extend the parser until it doesn't.

- [ ] **Step 5: Run tests to verify pass**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/parseMeetingTimes.test.ts
```

Expected: all PASS, including the real-fixture coverage test.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/sectionMaterialization/parseMeetingTimes.ts packages/engine/src/agent/sectionMaterialization/types.ts packages/engine/tests/agent/parseMeetingTimes.test.ts
git commit -m "feat(engine): parseMeetingTimes — FOSE hours string → structured MeetingPattern[]"
```

---

## Task 2: Conflict-detection helper

**Files:**
- Create: `packages/engine/src/agent/sectionMaterialization/conflictDetection.ts`
- Create: `packages/engine/tests/agent/conflictDetection.test.ts`

Pure helpers: `conflicts(a, b)` returns true iff any pair of patterns overlap; `enumerateConflictFreeCombinations(courses)` returns all conflict-free cross-products.

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/agent/conflictDetection.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { conflicts, enumerateConflictFreeCombinations } from "../../src/agent/sectionMaterialization/conflictDetection";
import type { MeetingPattern, SectionView } from "../../src/agent/sectionMaterialization/types";

const A = { day: "M", startMin: 540, endMin: 600 } as MeetingPattern;  // M 9-10
const B = { day: "M", startMin: 570, endMin: 615 } as MeetingPattern;  // M 9:30-10:15 (overlaps A)
const C = { day: "M", startMin: 600, endMin: 660 } as MeetingPattern;  // M 10-11 (touches A, no overlap)
const D = { day: "Tu", startMin: 540, endMin: 600 } as MeetingPattern; // Tu 9-10 (different day)

describe("conflicts", () => {
    it("returns true when patterns overlap on the same day", () => {
        expect(conflicts([A], [B])).toBe(true);
    });
    it("returns false when patterns abut without overlap", () => {
        expect(conflicts([A], [C])).toBe(false);
    });
    it("returns false when patterns are on different days", () => {
        expect(conflicts([A], [D])).toBe(false);
    });
    it("returns false for empty pattern arrays (asynchronous)", () => {
        expect(conflicts([], [A])).toBe(false);
        expect(conflicts([], [])).toBe(false);
    });
    it("checks every pair (e.g. multi-meeting course)", () => {
        const patternsA: MeetingPattern[] = [A, D];
        const patternsB: MeetingPattern[] = [{ day: "Tu", startMin: 555, endMin: 615 }]; // overlaps D
        expect(conflicts(patternsA, patternsB)).toBe(true);
    });
});

function fakeSection(courseId: string, patterns: MeetingPattern[], suffix = ""): SectionView {
    return {
        courseId,
        title: courseId,
        crn: `${courseId}-${suffix}`,
        credits: "4",
        instructor: "Prof X",
        status: "O",
        meetingPatterns: patterns,
        isAsynchronous: patterns.length === 0,
        rawHours: "",
    };
}

describe("enumerateConflictFreeCombinations", () => {
    it("returns the cross-product when no sections conflict", () => {
        const out = enumerateConflictFreeCombinations([
            { courseId: "X", title: "X", sections: [fakeSection("X", [A]), fakeSection("X", [C])] },
            { courseId: "Y", title: "Y", sections: [fakeSection("Y", [D])] },
        ]);
        // 2 X sections × 1 Y section = 2 combinations.
        expect(out.length).toBe(2);
    });

    it("filters out combinations where any pair conflicts", () => {
        const out = enumerateConflictFreeCombinations([
            { courseId: "X", title: "X", sections: [fakeSection("X", [A])] },
            { courseId: "Y", title: "Y", sections: [fakeSection("Y", [B])] }, // conflicts with A
        ]);
        expect(out.length).toBe(0);
    });

    it("handles courses with multiple sections + multiple options", () => {
        // X has sections that overlap Y option 1; X has sections compatible with Y option 2.
        const out = enumerateConflictFreeCombinations([
            { courseId: "X", title: "X", sections: [fakeSection("X", [A])] },
            { courseId: "Y", title: "Y", sections: [
                fakeSection("Y", [B], "1"), // conflicts
                fakeSection("Y", [D], "2"), // compatible
            ] },
        ]);
        expect(out.length).toBe(1);
    });

    it("caps the output at MAX_COMBINATIONS and reports truncated", () => {
        // 5 courses × 5 sections each = 3125 combinations; check the cap kicks in.
        // (Exact MAX_COMBINATIONS is implementation-defined; e.g. 50.)
        const courses = Array.from({ length: 5 }, (_, i) => ({
            courseId: `C${i}`,
            title: `C${i}`,
            sections: Array.from({ length: 5 }, (_, j) => fakeSection(`C${i}`, [{ day: "Sa", startMin: i * 100 + j * 20, endMin: i * 100 + j * 20 + 10 }])),
        }));
        const out = enumerateConflictFreeCombinations(courses);
        expect(out.length).toBeLessThanOrEqual(50);
    });
});
```

- [ ] **Step 2: Implement**

Create `packages/engine/src/agent/sectionMaterialization/conflictDetection.ts`:

```typescript
import type { MeetingPattern, SectionView } from "./types.js";

const MAX_COMBINATIONS = 50;

function patternsOverlap(a: MeetingPattern, b: MeetingPattern): boolean {
    if (a.day !== b.day) return false;
    return a.startMin < b.endMin && b.startMin < a.endMin;
}

export function conflicts(a: MeetingPattern[], b: MeetingPattern[]): boolean {
    for (const pa of a) {
        for (const pb of b) {
            if (patternsOverlap(pa, pb)) return true;
        }
    }
    return false;
}

interface CourseBundle {
    courseId: string;
    title: string;
    sections: SectionView[];
}

interface Combination {
    sections: SectionView[];
    weeklyHours: number;
}

function weeklyHoursOf(sections: SectionView[]): number {
    let total = 0;
    for (const s of sections) {
        for (const p of s.meetingPatterns) {
            total += (p.endMin - p.startMin) / 60;
        }
    }
    return total;
}

export function enumerateConflictFreeCombinations(courses: CourseBundle[]): Array<Combination & { truncated?: boolean }> {
    if (courses.length === 0) return [];
    const out: Combination[] = [];
    const truncated = { value: false };
    function recurse(idx: number, picked: SectionView[]) {
        if (out.length >= MAX_COMBINATIONS) {
            truncated.value = true;
            return;
        }
        if (idx === courses.length) {
            out.push({ sections: [...picked], weeklyHours: weeklyHoursOf(picked) });
            return;
        }
        const c = courses[idx]!;
        if (c.sections.length === 0) {
            // Course has no sections — skip; the materializer will surface this as unavailable.
            recurse(idx + 1, picked);
            return;
        }
        for (const s of c.sections) {
            // Conflict-check against everything already picked.
            const conflictsWithPrior = picked.some(prior => conflicts(prior.meetingPatterns, s.meetingPatterns));
            if (!conflictsWithPrior) {
                recurse(idx + 1, [...picked, s]);
            }
            if (out.length >= MAX_COMBINATIONS) return;
        }
    }
    recurse(0, []);
    if (truncated.value) {
        // Annotate the LAST combination so the caller knows the list is truncated.
        // (Or carry a separate flag in MaterializedSemester — see Task 3.)
    }
    return out;
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/conflictDetection.test.ts
git add packages/engine/src/agent/sectionMaterialization/conflictDetection.ts packages/engine/tests/agent/conflictDetection.test.ts
git commit -m "feat(engine): time-conflict detection + conflict-free combination enumerator"
```

---

## Task 3: FOSE availability gate (per-call data-state classification)

**Files:**
- Create: `packages/engine/src/agent/sectionMaterialization/foseAvailabilityGate.ts`
- Create: `packages/engine/tests/agent/foseAvailabilityGate.test.ts`

Per locked decision #16: each `materialize_sections` call inspects FOSE's response to classify state. NOT a static window assumption. The gate classifies into `full` / `partial` / `unavailable` based on what FOSE actually returns.

- [ ] **Step 1: Define the gate semantics**

Inputs: a sample of FOSE responses for the target term (multiple keywords combined).

Outputs:
- `unavailable`: zero sections returned across all sample queries → FOSE has no data for this term.
- `partial`: sections returned but >50% of them have empty/TBA `hours` → registration likely opens soon, course catalog is up but section schedule isn't.
- `full`: sections returned AND ≥50% have parseable `hours` → registration is ready.

The 50% threshold is heuristic; tunable based on real-fixture observations.

- [ ] **Step 2: Test + implement**

Create `foseAvailabilityGate.test.ts` with cases driven by the recorded fixtures from Task 0:
- The 2026-fall fixtures should classify as `full`
- The 2027-spring fixtures (if registration hasn't opened) should classify as `partial`
- The 2028-fall fixtures should classify as `unavailable`

Adjust the threshold based on what the fixtures actually look like.

```typescript
// packages/engine/src/agent/sectionMaterialization/foseAvailabilityGate.ts
import type { AvailabilityState } from "./types.js";
import { parseMeetingTimes } from "./parseMeetingTimes.js";

interface FoseSection {
    hours?: string;
}

export function classifyAvailability(sections: FoseSection[]): AvailabilityState {
    if (sections.length === 0) return "unavailable";
    let withTimes = 0;
    for (const s of sections) {
        const parsed = parseMeetingTimes(s.hours ?? "");
        if (parsed.kind === "ok" || parsed.kind === "asynchronous") {
            withTimes++;
        }
    }
    const ratio = withTimes / sections.length;
    if (ratio >= 0.5) return "full";
    return "partial";
}
```

- [ ] **Step 3: Run tests + commit**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/foseAvailabilityGate.test.ts
git add packages/engine/src/agent/sectionMaterialization/foseAvailabilityGate.ts packages/engine/tests/agent/foseAvailabilityGate.test.ts
git commit -m "feat(engine): FOSE per-call availability-state classifier"
```

---

## Task 4: FOSE TTL cache

**Files:**
- Create: `packages/engine/src/agent/sectionMaterialization/foseCache.ts`
- Create: `packages/engine/tests/agent/foseCache.test.ts`

Simple in-memory `Map<key, { value; expiresAt }>` with 5-minute TTL. Key is `${termCode}|${keyword}`. Used by the materializer to avoid hammering FOSE on repeat queries.

Standard cache implementation; tests cover hit, miss, expiry. Commit.

---

## Task 5: Section enumeration + combination generator (the orchestrator)

**Files:**
- Create: `packages/engine/src/agent/sectionMaterialization/materialize.ts`
- Create: `packages/engine/tests/agent/materialize.test.ts`

Orchestrator: takes a list of structural-plan course IDs for a target term + the FOSE search function, runs availability check, swaps unavailable courses, builds the combination list.

- [ ] **Step 1: Implement the orchestrator**

```typescript
// packages/engine/src/agent/sectionMaterialization/materialize.ts
import { searchCourses } from "../../api/nyuClassSearch.js";
import { parseMeetingTimes } from "./parseMeetingTimes.js";
import { enumerateConflictFreeCombinations } from "./conflictDetection.js";
import { classifyAvailability } from "./foseAvailabilityGate.js";
import { foseCache } from "./foseCache.js";
import type { SectionView, MaterializationResult } from "./types.js";

interface MaterializeArgs {
    termCode: string;
    courseIds: string[];
    /** When a course has zero open sections, swap with a structural-plan-legal alternative.
     *  The orchestrator calls this hook (provided by the caller) to ask the structural solver
     *  for an alternative. Returns null when no alternative exists (defer to next term). */
    swapHook: (failedCourseId: string) => Promise<string | null>;
}

export async function materializeSections(args: MaterializeArgs): Promise<MaterializationResult> {
    // 1. Pull FOSE for each course.
    const courseBundles: Array<{ courseId: string; title: string; sections: SectionView[]; foseRaw: any[] }> = [];
    for (const courseId of args.courseIds) {
        const cacheKey = `${args.termCode}|${courseId}`;
        let raw = foseCache.get(cacheKey);
        if (!raw) {
            raw = await searchCourses(args.termCode, courseId);
            foseCache.set(cacheKey, raw);
        }
        // Filter to exact-code matches (FOSE keyword search is substring).
        const exact = raw.filter((r: any) => r.code === courseId);
        const sections: SectionView[] = exact.map((r: any) => {
            const parsed = parseMeetingTimes(r.hours ?? "");
            return {
                courseId,
                title: r.title ?? courseId,
                crn: r.crn ?? "",
                credits: r.credits ?? "4",
                instructor: r.instr ?? "",
                status: r.stat ?? "",
                meetingPatterns: parsed.kind === "ok" ? parsed.patterns : [],
                isAsynchronous: parsed.kind === "asynchronous",
                rawHours: r.hours ?? "",
            };
        });
        courseBundles.push({ courseId, title: exact[0]?.title ?? courseId, sections, foseRaw: exact });
    }

    // 2. Classify the overall availability state.
    const allFose = courseBundles.flatMap(c => c.foseRaw);
    const state = classifyAvailability(allFose);

    if (state === "unavailable") {
        return {
            state,
            message: `FOSE has no data for ${args.termCode}. Section-level info is only available closer to registration. Showing structural plan only.`,
        };
    }

    if (state === "partial") {
        return {
            state,
            partialCourses: courseBundles.map(c => ({ courseId: c.courseId, title: c.title, sections: c.sections })),
            message: `Course listings exist for ${args.termCode}, but meeting times aren't fully published yet. Registration likely opens soon — come back later for sections + times.`,
        };
    }

    // 3. Full data: handle unavailable courses (zero open sections) via swap.
    const finalBundles: Array<{ courseId: string; title: string; sections: SectionView[] }> = [];
    for (const bundle of courseBundles) {
        const openSections = bundle.sections.filter(s => s.status === "O" || s.status === "W");
        if (openSections.length === 0) {
            // Swap: ask the structural solver for an alternative.
            const alt = await args.swapHook(bundle.courseId);
            if (!alt) {
                // No alternative — defer; surface in message.
                continue;
            }
            // Re-pull FOSE for the alternative course.
            const altRaw = await searchCourses(args.termCode, alt);
            const altExact = altRaw.filter((r: any) => r.code === alt);
            const altSections: SectionView[] = altExact.map((r: any) => {
                const parsed = parseMeetingTimes(r.hours ?? "");
                return {
                    courseId: alt,
                    title: r.title ?? alt,
                    crn: r.crn ?? "",
                    credits: r.credits ?? "4",
                    instructor: r.instr ?? "",
                    status: r.stat ?? "",
                    meetingPatterns: parsed.kind === "ok" ? parsed.patterns : [],
                    isAsynchronous: parsed.kind === "asynchronous",
                    rawHours: r.hours ?? "",
                };
            });
            const altOpen = altSections.filter(s => s.status === "O" || s.status === "W");
            if (altOpen.length > 0) {
                finalBundles.push({ courseId: alt, title: altExact[0]?.title ?? alt, sections: altOpen });
            }
        } else {
            finalBundles.push({ courseId: bundle.courseId, title: bundle.title, sections: openSections });
        }
    }

    // 4. Enumerate conflict-free combinations.
    const combos = enumerateConflictFreeCombinations(finalBundles);

    return {
        state: "full",
        semester: {
            term: args.termCode,
            courses: finalBundles,
            combinations: combos,
            combinationsTruncated: combos.length >= 50, // matches MAX_COMBINATIONS
        },
        message: combos.length > 0
            ? `Found ${combos.length} conflict-free section combinations for ${args.termCode}. Pick one to confirm.`
            : `Found courses but no conflict-free combinations exist. Some courses may have meeting-time conflicts that can't be resolved.`,
    };
}
```

- [ ] **Step 2: Tests** — drive the orchestrator with mocked `searchCourses` returning fixture data + a mocked swapHook. Assert the three states surface correctly.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/src/agent/sectionMaterialization/materialize.ts packages/engine/tests/agent/materialize.test.ts
git commit -m "feat(engine): materializeSections orchestrator (FOSE + conflicts + swap-on-unavailable)"
```

---

## Task 6: `materialize_sections` tool (two-step)

**Files:**
- Create: `packages/engine/src/agent/tools/materializeSections.ts`
- Modify: `packages/engine/src/agent/registry.ts`

The tool follows the `update_profile` two-step pattern:

1. `materialize_sections` (read-only): runs the orchestrator, returns the combinations + state. Each combination has a `proposalId`.
2. `confirm_section_combination` (write): student picks a `proposalId`; the tool pins the chosen combination's CRNs into `session.forwardSchedule.semesters[targetTerm].slots` (replacing placeholder/specific_planned with concrete-section slots that include CRN + meeting time + instructor).

Implement, test, register, commit.

---

## Task 7: Sidebar UI extension

**Files:**
- Modify: `apps/web/app/chat/scheduleSidebar.tsx`
- Modify: `apps/web/app/chat/chat.module.css`

For the IMMEDIATE term (the first non-locked semester in `forwardSchedule`), render a "Sections" view instead of the structural slot list when materialization data is available. Show:
- Each course with its sections (CRN + meeting times + instructor)
- Currently-selected combination highlighted
- Picker UI to switch between conflict-free combinations
- "Apply combination" button that triggers `confirm_section_combination`

When `state === "partial"` or `"unavailable"`, fall back to the structural slot rendering with a banner explaining why.

Implement, smoke-test, commit.

---

## Task 8: Cleanup duplicate `searchAvailability.ts`

**Files:**
- Delete: `packages/engine/src/tools/searchAvailability.ts` (the dead duplicate)
- Verify: `packages/engine/src/agent/tools/searchAvailability.ts` is the registered version

The Phase 13/15 audit found two files with the same name; only one is in the registry. Delete the dead one.

- [ ] **Step 1: Confirm dead-code status**

```bash
grep -rln "from.*tools/searchAvailability" packages/engine/src/ apps/web/
grep -rln "from.*agent/tools/searchAvailability" packages/engine/src/ apps/web/
```

If only the `agent/tools/` path is imported, the other is dead.

- [ ] **Step 2: Delete + commit**

```bash
git rm packages/engine/src/tools/searchAvailability.ts
git commit -m "chore(engine): remove duplicate searchAvailability.ts (dead code)"
```

If anything still references the old path, update those imports first.

---

## Task 9: Manual browser verification + push

- [ ] **Step 1: Refresh dev server**

`http://localhost:3001`.

- [ ] **Step 2: Verification scenarios**

1. **Active registration term:** ask the agent to plan + materialize for the current term being registered. Expected: sidebar shows section combinations with CRN + meeting times + instructor names. Picker UI to pick one. Confirm → schedule updates with concrete CRNs.
2. **Pre-registration partial:** ask for a term that's listed in FOSE but doesn't have meeting times yet. Expected: agent surfaces the partial-state message ("registration opens soon — come back later"). Sidebar shows the structural slot view + the partial-state banner.
3. **Far-future term:** ask for a term 1+ years out. Expected: agent surfaces unavailable-state message. Sidebar shows structural slots only.
4. **Course with zero open sections:** find a closed course in the current term + ask for a plan that includes it. Expected: orchestrator swaps to a structural-plan-legal alternative; defers original to next term; sidebar reflects.
5. **Time-conflict resolution:** request a plan with two courses that have only-conflicting sections. Expected: orchestrator returns zero combinations + explanation. Agent surfaces alternatives.
6. **Combinations cap:** 4-5 courses each with 5 sections (250+ raw combos). Expected: orchestrator caps at 50, sidebar shows "and N more conflict-free combinations not listed."
7. **Instructor visibility:** every section card displays the instructor name string verbatim. (No rating overlay.)

- [ ] **Step 3: Push**

```bash
git push
```

- [ ] **Step 4: Tear-off note**

```
Phase 15 (live FOSE section materialization + time conflicts) shipped:
- Per-call data-availability gate (full / partial / unavailable) — no
  static window assumptions; each call inspects FOSE response shape.
- Time-pattern parser turns FOSE `hours` HTML strings into structured
  MeetingPattern[] with day + startMin + endMin.
- Conflict-detection helper + conflict-free combination enumerator
  (capped at 50).
- Swap-on-unavailable: courses with zero open sections trigger the
  structural solver to find an alternative; original deferred to next term.
- materialize_sections two-step tool (propose → confirm).
- Sidebar renders concrete sections (CRN + meeting time + instructor)
  for the immediate term; falls back to structural view when
  partial/unavailable.
- 5-minute TTL cache reduces FOSE load.

Decision: RateMyProfessor / instructor-rating overlay SKIPPED. ToS
risk + poor data density at NYU + 2-year-stale wrappers. Instructor
NAME is surfaced verbatim per section so the student picks based on
their own preferences. Revisit only if/when RMP situation changes
or NYU exposes evaluation data via a sanctioned channel.

Cleanup: removed duplicate packages/engine/src/tools/searchAvailability.ts
(dead code; agent registry uses packages/engine/src/agent/tools/).
```

---

## Self-review notes

**Per-call gate is load-bearing.** Don't assume registration windows by date. Each FOSE response is the source of truth for "is data ready?"

**Three states must all be testable:** the recorded fixtures from Task 0 must include at least one example of each state — full (current term), partial (pre-reg), unavailable (far-future).

**Instructor surfacing:** `SectionView.instructor` is the raw FOSE `instr` string. Multi-instructor sections render as concatenated names (whatever FOSE returns). No transformation.

**Cap at 50 combinations:** 5-course × 5-section terms can produce thousands of combinations. The cap keeps the UI scannable. If real-world usage shows the cap is too aggressive, it's a one-line tune.

**Two-step UX matters:** the agent shouldn't pin combinations behind the student's back. `materialize_sections` returns options; the student picks; `confirm_section_combination` applies. This mirrors `update_profile`'s flow and respects locked decision #13 (student-confirmation = highest authority).
