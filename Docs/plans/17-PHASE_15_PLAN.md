# Phase 15 — Live Section Materialization (FOSE) + Time-Conflict Detection

> ✅ **IMPLEMENTED & COMPLETE (verified against code 2026-06-19).** Tasks 0–7 shipped: the live FOSE client + `search_availability` + meeting-time parsing + availability gate + TTL cache + `conflictDetection` + scheduling-preference filter + the `materialize.ts` orchestrator + `materialize_sections`/`confirm_section_combination`. **Stale-but-harmless:** Task 1's `rawHours` schema was superseded during implementation — real FOSE uses `meets` + `meetingTimes` (the code adapted; see `sectionMaterialization/types.ts` header). **NOT done (deferred, by design):** the Decision-#19 `swapHook` is stubbed → no cross-term re-plan/swap cascade; that + the section-picker UI are the next **FOSE re-plan phase** (see the post-37 FOSE plan).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Architectural principle (read first)

**Plan with available data + sensible defaults; ask the student only when input would change a trade-off.**

The planner ALWAYS ships a plan. Defaults are concrete answers, not "unknown" gaps. Validators distinguish verified-pass from assumed-pass from requires-approval (Decision #40 — `ValidationResult` 4-state union, defined in Phase 13). The plan ships in all three cases; the agent's surfacing language differs per axis.

For Phase 15 specifically: this phase **promotes** axes from `assumed-pass` (Phase 13's default) to verified `pass`/`fail` once FOSE supplies the missing data. The two principal promotions are:
1. **Offering confidence**: a structural-plan course's `confidence` tier promotes from `historically_likely` / `historically_partial` / `irregular` (Phase 12.9.5) to `confirmed` once FOSE shows an actual section in the upcoming term (Decision #29 extension).
2. **F-1 online/in-person axes**: `visaValidator.onlineLimitSatisfied` + `inPersonMinimumSatisfied` promote from `{ status: "assumed-pass", assumption: "all sections in-person" }` to verified `pass`/`fail` based on each section's `meetingPattern.location` / format flag (Decision #34 extension).

Phase 15 also implements **Decision #43 — scheduling preferences** (time/day filters): `materialize_sections` reads the `SchedulingPreferences` object defined-but-unused at Phase 14 and applies hard `strict: true` filters BEFORE Decision #18's combination enumeration; soft `strict: false` entries deboost section ranking. When a strict filter eliminates all sections of a course, the existing Decision #19 cascade fires (clean superset — same code path, new trigger). New `visaValidator` axis `schedulingPreferenceSatisfied` returns a `ValidationResult` per Decision #40.

The **section-level extension of Decision #44** (top-K conflict-free combination summaries for unmodeled intra-term preferences — "back-to-back vs. gaps," "hardest class first thing in the morning") is **OPTIONAL — STRETCH**, not a Phase 15 acceptance gate. Schema slot `MaterializedTermAlternatives[]` is reserved on the materialize result so the implementation is non-breaking to add later; Phase 14's `compare_plan_alternatives` tool already dispatches on schema variant. Ship the implementation only if it cleanly fits the `materialize.ts` orchestrator without re-architecting; defer otherwise.

When FOSE is `unavailable` (term too far out), Phase 15 leaves the plan in its Phase-13/14 state — `valid-with-trade-offs` if any axis was `assumed-pass`. **Phase 15 never changes the plan-shipping rule** (which is locked in Phase 13's Decisions #32 + #40). It only changes the validator metadata available to the agent.

**Before implementing:** read `docs/PHASE_PLANS_README.md` (full 46-decision canonical list + cross-phase execution order + pre-flight verification table). The pre-flight checks must pass before the first code change in this phase.

---

**Goal:** Take the structural multi-semester plan from Phase 13/14 and, for the IMMEDIATE term the student is about to register for, query live FOSE for each planned course → check open sections → detect time conflicts between sections → enumerate conflict-free combinations → return concrete `{course + section CRN + meeting time + instructor}` bundles the student can register against. Per-call data-availability gating: each FOSE query checks whether real availability data is present, partial, or empty, and gracefully degrades. Instructor names are always surfaced (the student picks based on their own preferences — no RateMyProfessor integration; that path is dropped).

**Architecture:** A new "section-materialization" layer. `materialize_sections` is a dedicated tool (NOT folded into `plan_forward_degree`) that takes a target term + a list of structural-plan courses for that term, runs a per-call FOSE query, and returns one of three states:

1. **`full`** — FOSE has real availability data with meeting times. Compute conflict-free section combinations; return concrete bundles with instructor names.
2. **`partial`** — FOSE has course listings but meeting times are absent or sparse (typical right before registration opens). Return what's available + a note explaining that section-level data isn't ready yet.
3. **`unavailable`** — FOSE returns nothing for the term (typical for terms 1+ years out). Skip the materialization; tell the student section data is only available closer to registration.

The agent calls `materialize_sections` AFTER `view_forward_plan`. Phase 13/14's structural plan remains the source of truth for the multi-semester view; section materialization is the additive concrete-section layer for the immediate term only.

**Tech Stack:** TypeScript, vitest. Engine: `packages/engine/src/agent/sectionMaterialization/`. Web: `apps/web/app/chat/scheduleSidebar.tsx` (extension).

**Prerequisites:**
- **Phase 13** complete (multi-semester planner with `forwardSchedule` on `ToolSession`). **Specifically required from Phase 13:**
  - `ValidationResult` 4-state union (Decision #40) — Phase 15 promotes axes from `assumed-pass` to verified `pass`/`fail` and emits the new `ValidationResult` shape
  - `packages/engine/src/dpr/visaValidator.ts` with `onlineLimitSatisfied` + `inPersonMinimumSatisfied` axes returning `assumed-pass` pre-Phase-15 — Phase 15 supplies the FOSE-derived `meetingPattern.location` data that lets these axes promote to verified
  - `OfferingEntry.confidence` field on `courses-offerings.json` (from Phase 12.9.5) — Phase 15 promotes a course's confidence to `confirmed` at runtime when FOSE shows an actual section (Decision #29 extension)
  - `ScheduleSlot.confidence` on each slot (Decision #39) — Phase 15's UI surfaces the runtime-promoted `confirmed` tier in place of the static historical tier
- **Phase 14** complete (preferences + alternatives — these compose with Phase 15 cleanly: preferences shape the structural plan, FOSE materializes the concrete sections). **Specifically required from Phase 14:** the `propose_plan_change` mutation array (Decision #23) — Phase 15's course-swap-on-FOSE-unavailable cascade (Decision #19) dispatches `swap` mutations through this tool.

**Required by:**
- No subsequent phase plans within this scope. (Phase 16 — RateMyProfessor / instructor-rating overlay — was explicitly DROPPED; see README.)

**Out of scope:**
- RateMyProfessor / instructor-rating overlay. Decision: SKIPPED. Reasons: ToS violation risk (RMP Section 6 explicitly prohibits scraping; documented C&D enforcement); poor data density at NYU CS faculty (most have <10 ratings); top wrappers are 2+ years stale. Instructor name string IS surfaced for the student to make their own choice.
- NYU CourseEvalPro / Albert internal evaluations (NetID-gated, NYU-policy risk).
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
| 34 (extension) | Online/in-person checks promote from `assumed-pass` to verified `pass`/`fail` | Phase 13 ships visaValidator with `onlineLimitSatisfied` + `inPersonMinimumSatisfied` returning `{ status: "assumed-pass", assumption: "all sections in-person", whatWouldFlipIt: "if any section is online and total online credits would exceed 3 (F-1 limit)" }` per Decision #40. Phase 15 fills in real verification: parses each FOSE section's `meetingPattern.location` / format flag (online / in-person / hybrid), threads through to `visaValidator`. After Phase 15: those two axes return verified `{ status: "pass", verifiedFrom: "FOSE" }` or `{ status: "fail", reason: "<concrete violation>" }`. Plan state can re-evaluate from `valid-with-trade-offs` to `valid-clean` once all axes are verified. If the only available section is online and would push the student over F-1 cap → axis returns `fail` → materializer flags + proposes a section swap (Decision #19 cascade). |
| 43 | Scheduling preferences (time/day filters) — first-class | `SchedulingPreferences` schema in shared types (defined Phase 14 Task 1, consumed Phase 15). Phase 15's `materialize_sections` applies the filter BEFORE Decision #18's combination enumeration. `strict: true` per entry → HARD filter (eliminates sections); `strict: false` → soft deboost in section ranking. When a strict filter eliminates all sections of a course, **Decision #19's course-swap cascade fires** (clean superset; new trigger, no new code path). New `PlanMutation` kinds `setSchedulingPreference` / `clearSchedulingPreference` (defined-but-unused at Phase 14; Phase 15 is the first reader). Validator axis `schedulingPreferenceSatisfied` returns a `ValidationResult` per Decision #40: `pass` when all materialized sections honor strict constraints; `fail` when an unsatisfiable strict filter has no swap candidate. **The `strict` field is INDEPENDENT from Decision #42's hard-vs-soft constraint framing** — `strict: true` says the FILTER is hard, not that the student framed the preference as non-negotiable for tier-routing purposes (usually correlated but not coupled at the schema level). |
| 44 (extension, OPTIONAL — STRETCH, not a Phase 15 acceptance gate) | Top-K section-combination summaries for unmodeled intra-term preferences | Decision #18's enumeration of conflict-free combinations naturally produces multiple options. The same top-K pattern can extend to this layer: emit the top-K combinations (k=5) as `MaterializedTermAlternatives[]` for the LLM to compare when the student states an unmodeled intra-term preference (back-to-back vs. gaps, "I prefer my hardest class first thing in the morning," etc.). Phase 14's `compare_plan_alternatives` tool dispatches on the schema variant (structural vs. section-level). **Schema slot is reserved either way** (so it's not a breaking change to add later); the tool dispatch and the eval cases are only required if the stretch task ships. Ship the implementation only if it cleanly fits the `materialize.ts` orchestrator without re-architecting; defer otherwise. Most students don't articulate intra-term preferences; Tier D handles the residual long tail. |
| 29 (extension) | Promote offerings to `confirmed` tier at materialization | Decision #29 (Phase 12.9.5) classifies offerings as `historically_likely` / `historically_partial` / `irregular` / `permission_only` / `restricted` based on static historical data. The `confirmed` tier is reserved for runtime — Phase 15's FOSE materializer promotes a course's confidence to `confirmed` when the actual section lands in FOSE for the upcoming term. This is a runtime override of the static classification; the underlying `courses-offerings.json` is unchanged. The agent surfaces "X is confirmed for Spring 2027 (FOSE shows N open sections)" instead of "historically likely but unconfirmed" once the term enters the FOSE window. |

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
| `packages/engine/src/agent/sectionMaterialization/applySchedulingPreferences.ts` | **Create (REQUIRED)** | Pure helper per Decision #43. Filters strict-true entries (drops sections), computes soft-rerank weights, surfaces "no surviving sections" so `materialize.ts` can dispatch Decision #19's existing course-swap cascade. |
| `packages/engine/tests/agent/applySchedulingPreferences.test.ts` | **Create (REQUIRED)** | Strict-filter drops, soft-rerank, all-eliminated triggers #19 cascade, ValidationResult shapes per #40, integration with `setSchedulingPreference` / `clearSchedulingPreference` mutations. |
| `packages/engine/src/agent/sectionMaterialization/materialize.ts` | **Create** | Orchestrator: pulls FOSE, gates on availability, **applies SchedulingPreferences (Decision #43, REQUIRED) BEFORE combination enumeration**, swaps unavailable courses, enumerates combinations, builds the result. **Section-level Decision #44 dispatch (top-K `MaterializedTermAlternatives[]`) is OPTIONAL — STRETCH** (see stretch task at the bottom of this plan); the schema slot is reserved either way so the implementation is non-breaking to add later. |
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

## Task 5: Apply SchedulingPreferences in materialize_sections (Decision #43)

**Files:**
- Create: `packages/engine/src/agent/sectionMaterialization/applySchedulingPreferences.ts`
- Create: `packages/engine/tests/agent/applySchedulingPreferences.test.ts`
- Modify: `packages/engine/src/agent/sectionMaterialization/materialize.ts` (Task 6 below — wire the new helper)
- Modify: `packages/engine/src/dpr/visaValidator.ts` (add `schedulingPreferenceSatisfied` axis)
- Modify: `packages/engine/tests/dpr/visaValidator.test.ts` (cover the new axis)

This task implements **Decision #43 — scheduling preferences** as a first-class FOSE-time filter + ranking signal. Phase 14's Task 1 ships the `SchedulingPreferences` type defined-but-unused; this is its first reader. The filter is applied BEFORE Decision #18's combination enumeration (cheaper) and triggers Decision #19's existing course-swap cascade when an unsatisfiable strict filter eliminates all sections of a course (clean superset — same code path, new trigger location).

**Schema reminder (defined in Phase 14 Task 1; restated here for the implementer):**

```typescript
type Day = "M" | "Tu" | "W" | "Th" | "F" | "Sa" | "Su";

interface SchedulingPreferences {
    avoidDays?: Array<{ day: Day; strict: boolean }>;
    avoidTimeWindows?: Array<{ days: Day[]; startMin: number; endMin: number; strict: boolean }>;
    preferTimeWindows?: Array<{ days: Day[]; startMin: number; endMin: number; weight: number }>;
    desiredFreeDay?: { day: "any" | Day; strict: boolean };
    avoidConsecutiveLongBlocks?: boolean;
}
```

`strict: true` per entry → HARD filter (drops sections). `strict: false` → soft deboost in section ranking. The `strict` field is INDEPENDENT from Decision #42's hard-vs-soft constraint framing — `strict: true` says the FILTER is hard, not that the student framed the preference as non-negotiable for tier-routing purposes.

- [ ] **Step 1: Write the failing tests**

Create `packages/engine/tests/agent/applySchedulingPreferences.test.ts`:

```typescript
// Test cases (sketch — implementer fills in fixtures):
//
// (a) strict-true Friday filter drops Friday sections:
//     prefs = { avoidDays: [{ day: "F", strict: true }] }
//     → all sections meeting on Friday are removed; non-Friday sections remain.
//
// (b) soft preferTimeWindows reranks but doesn't drop:
//     prefs = { preferTimeWindows: [{ days: ["M","W"], startMin: 540, endMin: 720, weight: 1.0 }] }
//     → Mon/Wed-morning sections rank higher; non-matching sections still in pool.
//
// (c) all sections eliminated by a strict filter triggers Decision #19 cascade:
//     a course's only sections all meet on Friday + prefs.avoidDays Friday strict
//     → applySchedulingPreferences reports the course as "no sections survive";
//        materialize_sections invokes Decision #19's swap path (same code path
//        as the existing "FOSE returned zero open sections" trigger).
//
// (d) ValidationResult shapes correct per Decision #40:
//     visaValidator.schedulingPreferenceSatisfied returns
//     - { status: "pass", verifiedFrom: "FOSE" } when all sections honor strict;
//     - { status: "fail", reason: "<concrete violation>" } when a strict filter
//       has no swap candidate.
//
// (e) integration with setSchedulingPreference / clearSchedulingPreference
//     mutations via propose_plan_change: setting a strict pref then
//     re-materializing reflects the filter; clearing restores all sections.
```

- [ ] **Step 2: Implement `applySchedulingPreferences.ts`**

Pure helper. Signature:

```typescript
export interface ApplyResult {
    surviving: SectionView[];
    rerankWeights: Map<string, number>;  // sectionId → soft-rank multiplier
    eliminatedByStrict: Array<{ sectionId: string; reason: string }>;
}

export function applySchedulingPreferences(
    sections: SectionView[],
    prefs: SchedulingPreferences | undefined,
): ApplyResult;
```

Behavior:
1. If `prefs` undefined or empty → return `{ surviving: sections, rerankWeights: empty, eliminatedByStrict: [] }`.
2. For each strict entry (`avoidDays.strict=true`, `avoidTimeWindows.strict=true`, `desiredFreeDay.strict=true`): drop sections whose meeting patterns intersect.
3. For each soft entry (`avoidDays.strict=false`, `avoidTimeWindows.strict=false`, `preferTimeWindows`, `avoidConsecutiveLongBlocks`): compute a per-section rank multiplier in [0, 1]; aggregate via product into `rerankWeights`.
4. Surviving sections retain their structural metadata; ranking happens downstream in `materialize.ts`.

- [ ] **Step 3: Wire into `materialize.ts`** (Task 6 — this step lands as part of Task 5's commit)

In the orchestrator:
1. Read `session.schedulePreferences?.schedulingPreferences` (defined in Phase 14 Task 1; first read here).
2. Call `applySchedulingPreferences(sections, prefs)` BEFORE Decision #18's `enumerateConflictFreeCombinations` step (filter first → cheaper enumeration over fewer sections).
3. If a course's surviving section count is 0 due to strict filter, dispatch Decision #19's existing course-swap cascade (same code path as "FOSE returned zero open sections" — the swap helper takes a "course unavailable in target term" signal regardless of root cause).
4. Pass `rerankWeights` into the conflict-free-combination ranking (multiply per-combination score by Π section-weight for sections in the combination).

- [ ] **Step 4: Extend `visaValidator.ts` with `schedulingPreferenceSatisfied` axis**

New axis returns `ValidationResult` per Decision #40:
- `{ status: "pass", verifiedFrom: "FOSE" }` when all materialized sections honor the strict constraints.
- `{ status: "fail", reason: "<concrete violation>" }` when an unsatisfiable strict filter has no swap candidate (Decision #19 cascade exhausted).
- `{ status: "assumed-pass", assumption: "no scheduling preferences set", whatWouldFlipIt: "if the student adds a strict avoidDay or avoidTimeWindow" }` when `session.schedulePreferences?.schedulingPreferences` is absent.

Stage 6d (per Decision #34 invariant) consumes this axis alongside the existing F-1 axes.

- [ ] **Step 5: Run tests + commit**

```bash
node_modules/.bin/vitest run packages/engine/tests/agent/applySchedulingPreferences.test.ts packages/engine/tests/agent/materialize.test.ts packages/engine/tests/dpr/visaValidator.test.ts
git add packages/engine/src/agent/sectionMaterialization/applySchedulingPreferences.ts packages/engine/src/agent/sectionMaterialization/materialize.ts packages/engine/src/dpr/visaValidator.ts packages/engine/tests/agent/applySchedulingPreferences.test.ts packages/engine/tests/dpr/visaValidator.test.ts
git commit -m "feat(engine): apply scheduling preferences in materialize_sections (Decision #43)"
```

This task is **REQUIRED** (not optional). It's the Phase-15 consumer of the Phase-14-defined `SchedulingPreferences` type.

---

## Task 6: Section enumeration + combination generator (the orchestrator)

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

## Task 7: `materialize_sections` tool (two-step)

**Files:**
- Create: `packages/engine/src/agent/tools/materializeSections.ts`
- Modify: `packages/engine/src/agent/registry.ts`

The tool follows the `update_profile` two-step pattern:

1. `materialize_sections` (read-only): runs the orchestrator, returns the combinations + state. Each combination has a `proposalId`.
2. `confirm_section_combination` (write): student picks a `proposalId`; the tool pins the chosen combination's CRNs into `session.forwardSchedule.semesters[targetTerm].slots` (replacing placeholder/specific_planned with concrete-section slots that include CRN + meeting time + instructor).

Implement, test, register, commit.

---

## Task 8: Sidebar UI extension

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

## Task 9: Cleanup duplicate `searchAvailability.ts`

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

## Task 10: Manual browser verification + push

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

## Task 11 (STRETCH — OPTIONAL): Section-level top-K extension (Decision #44 section extension)

> **Status: OPTIONAL — NOT a Phase 15 acceptance gate.** Schema-slot reservation in shared types is REQUIRED (so adding the implementation later is non-breaking); the tool dispatch and the eval cases are only required if this stretch task ships.

**Files (only if shipped):**
- Modify: `packages/shared/src/types.ts` — add `MaterializedTermAlternatives[]` field on the materialize result (REQUIRED schema slot reservation, regardless of whether implementation ships)
- Modify: `packages/engine/src/agent/sectionMaterialization/materialize.ts` — emit top-K combination summaries
- Modify: `packages/engine/src/agent/tools/comparePlanAlternatives.ts` (Phase 14 Task 7) — dispatch on schema variant (structural vs. section-level)
- Modify: `packages/engine/tests/agent/comparePlanAlternatives.test.ts` — add section-level fixtures

This task implements the **section-level extension of Decision #44**. Phase 13 emits structural-plan top-K via `ForwardSchedule.alternativeCandidates`; this task extends the same pattern to the section-combination level so the LLM can do Tier-B comparative judgment when the student articulates an unmodeled intra-term preference (back-to-back vs. gaps, "I prefer my hardest class first thing in the morning," etc.).

**Schema slot reservation (REQUIRED — even if implementation defers):**

```typescript
// packages/shared/src/types.ts — add to MaterializationResult or equivalent
interface MaterializedTermAlternatives {
    combinationIndex: number;
    backToBackCount: number;
    longestGapMin: number;
    earliestStartMin: number;
    latestEndMin: number;
    daysUsed: Day[];
    weeklyHours: number;
    topDiffsFromWinner: Array<{ aspect: string; change: string }>;
}

// On the materialize result:
materializedTermAlternatives?: MaterializedTermAlternatives[];  // ≤5; reserved
```

Reserving the field NOW (even if the implementation defers) ensures adding the stretch later is non-breaking.

**Implementation criteria:**

Ship the implementation only if it cleanly fits the `materialize.ts` orchestrator without re-architecting. Defer otherwise. Most students don't articulate intra-term preferences; Tier D handles the residual long tail cheaply via Phase 14's `HEURISTIC_MAPPING` Assumption (soft constraints only — never for hard-framed time/day constraints, which Decision #43 covers via Tier A).

If shipped:
1. After `enumerateConflictFreeCombinations` returns, compute the top-K (k=5) by a heuristic (default: combinations with the most distinct days used, then fewest back-to-back blocks).
2. For each retained combination, populate `MaterializedTermAlternatives` summary fields.
3. Extend `comparePlanAlternativesTool` to dispatch on schema variant: when the input names a section-level dimension (e.g. `"backToBackCount"`, `"longestGapMin"`), read `materializedTermAlternatives` instead of `forwardSchedule.alternativeCandidates`.
4. Extend the Phase 14 eval suite with ≥5 section-level Bucket-B fixtures.

If deferred: leave the schema slot in place; `comparePlanAlternativesTool` returns the "no alternatives available" indicator for section-level dimensions until the orchestrator emission lands.

---

## Self-review notes

**Per-call gate is load-bearing.** Don't assume registration windows by date. Each FOSE response is the source of truth for "is data ready?"

**Three states must all be testable:** the recorded fixtures from Task 0 must include at least one example of each state — full (current term), partial (pre-reg), unavailable (far-future).

**Instructor surfacing:** `SectionView.instructor` is the raw FOSE `instr` string. Multi-instructor sections render as concatenated names (whatever FOSE returns). No transformation.

**Cap at 50 combinations:** 5-course × 5-section terms can produce thousands of combinations. The cap keeps the UI scannable. If real-world usage shows the cap is too aggressive, it's a one-line tune.

**Two-step UX matters:** the agent shouldn't pin combinations behind the student's back. `materialize_sections` returns options; the student picks; `confirm_section_combination` applies. This mirrors `update_profile`'s flow and respects locked decision #13 (student-confirmation = highest authority).

**Solver-contract isolation (gates the future Phase 15.5 MIP migration; see README's "Phase 15.5 (DEFERRED)" stub):** Reviewer must verify that NO Phase 15 module — `materialize.ts`, `applySchedulingPreferences.ts`, `parseMeetingTimes.ts`, `conflictDetection.ts`, `foseAvailabilityGate.ts`, `materializeSections.ts` tool, modified `visaValidator.ts` for axes promotion + `schedulingPreferenceSatisfied` — imports stage-internal types from Phase 13's solver. The Decision #19 swap cascade dispatches `swap` mutations through Phase 14's `propose_plan_change`, NOT through direct solver internals. Reviewer's check: `grep -rn "from .*solver/\(types\|stages\|internal\)" packages/engine/src/agent/sectionMaterialization/` returns zero matches. After Phase 15 ships, the README's deferred Phase 15.5 stub becomes actionable: collect production replay data on Decision #27 forward-feasibility false-positives/negatives, Decision #41 graduationPathValidator rejection rate, Stage-7 latency. Author the `PHASE_15_5_PLAN.md` only with that evidence in hand.
