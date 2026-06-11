# Phase 12.9.5 — Offering Confidence Enrichment

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

## Architectural principle (read first)

**Plan with available data + sensible defaults; ask the student only when input would change a trade-off.**

The planner ALWAYS ships a plan. Defaults are concrete answers, not "unknown" gaps. Validators distinguish verified-pass from assumed-pass from requires-approval — the plan ships in all three cases, but the agent's surfacing language differs per axis (Decision #40 — `ValidationResult` 4-state union, defined in Phase 13).

For Phase 12.9.5 specifically: confidence-tier classification is the deterministic, conservative side of this principle. We assign a tier to every offering using the historical signal we have; we never leave entries `unknown`. Phase 13's solver consumes the tier to decide *whether to flag a trade-off*, not whether to ship the plan.

**Before implementing:** read `docs/PHASE_PLANS_README.md` (full 43-decision canonical list + cross-phase execution order + pre-flight verification table). The pre-flight checks must pass before the first code change in this phase.

---

**Goal:** Enrich `packages/engine/src/data/courses-offerings.json` with a per-course `confidence` tier so Phase 13's constraint solver can reason about which scheduled offerings are reliable vs. risky. Without this, the solver treats all `termsOffered` entries as deterministic facts — but historical bulletin offerings don't guarantee future availability, and the agent cannot honestly tell a student "your plan assumes X is offered in Spring 2027" with calibrated confidence.

**Status:** This is a small data-prep phase (~½–1 day) that runs **after** Phase 12.9 (bulletin embeddings, optional) and **before** Phase 13 (constraint solver). It implements **Decision #29** (Offering confidence tiers). Pure regex + statistical work; no LLM calls.

**Prerequisites:**
- **Phase 12.7** complete (full undergrad bulletin scrape — supplies the bulletin description text used in the restriction pass).
- **Phase 12.8** complete (`packages/engine/src/data/courses-offerings.json` populated with `termsOffered` arrays — this phase ENRICHES those entries with the new `confidence` field; it does not create them).
- **`tools/scrapers/full_catalog.json` (or equivalent)** populated with at least 4 same-season terms of historical FOSE data so the frequency pass has signal. If the historical window is shorter, every course defaults to `historically_partial` per Decision #29's tier-assignment rule (a safe under-confident default).

**Required by:**
- **Phase 13** — the constraint solver's forward-feasibility screen (Decision #27) and offering-risk impact (Decision #39) both consume `OfferingEntry.confidence`. Without this phase, those fields are undefined and the solver cannot distinguish reliable from risky offerings.

**Architecture:** Two-pass enrichment over the existing `courses-offerings.json`:
1. **Frequency pass:** classify each course's historical FOSE termsOffered pattern (from `course_catalog_full.json`) into confidence tiers based on appearance rate in the last 4 same-season terms.
2. **Restriction pass:** scan the course's bulletin description text for permission / restriction signals and override the tier where applicable.

**Tech stack:** Pure TypeScript regex + statistics over existing data. No LLM, no API calls. Output: new `confidence` field on each entry in `courses-offerings.json`.

**Out of scope:**
- Real-time FOSE availability checks (Phase 15's job; promotes courses to `confirmed` tier as their term approaches)
- Seat-availability modeling
- Per-section restrictions (only per-course)
- Departmental enrollment caps

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `tools/bulletin-parser/extractOfferingConfidence.ts` | **Create** | Two-pass classifier: frequency (from `course_catalog_full.json`'s historical termsOffered) + restriction (from bulletin description text). Augments existing `courses-offerings.json` entries with `confidence` field. |
| `packages/engine/src/data/courses-offerings.json` | **Modify** | Each entry gains `confidence: ConfidenceTier` field. Existing fields untouched. |
| `packages/shared/src/types.ts` | **Modify** | Add `ConfidenceTier` union; extend `OfferingEntry` interface. |
| `packages/engine/tests/data/offeringConfidence.test.ts` | **Create** | Vitest suite asserting tier assignment for representative courses (high-frequency CS courses → `historically_likely`; rare seminars → `irregular`; permission-only → `permission_only`). |

---

## Locked design decisions

This phase implements **Decision #29** from the canonical list in `docs/PHASE_PLANS_README.md`. Restated here:

> **Course offering data carries a confidence tier; not all `termsOffered` entries are equally reliable.**
>
> Each `OfferingEntry` in `courses-offerings.json` carries:
> ```typescript
> confidence:
>   | "historically_likely"   // appeared in ≥75% of last 4 same-season terms
>   | "historically_partial"  // 25–75%
>   | "irregular"             // <25%
>   | "permission_only"       // bulletin says "permission of department" / "consent of instructor required for enrollment"
>   | "restricted"            // bulletin restricts to certain majors/years/campuses
>   | "confirmed"             // ONLY set at runtime by Phase 15's FOSE materializer when the actual section is in FOSE for the upcoming term
> ```
>
> Phase 13's solver penalizes scheduling courses with low-confidence offerings into critical-path slots (high `downstreamImpact`); the agent surfaces "this plan assumes X is offered in Spring 2027 — historically likely but unconfirmed" so the student knows the risk.

---

## Task 1: Define `ConfidenceTier` type + extend `OfferingEntry`

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: Add `ConfidenceTier` to shared types**

```typescript
/**
 * Phase 12.9.5 — confidence tier for a course's term-offering pattern.
 *
 * Used by Phase 13's solver to penalize scheduling low-confidence courses
 * into critical-path slots, and by the agent to honestly surface
 * scheduling risk to students. Phase 15's FOSE materializer promotes
 * courses to `confirmed` when their actual section lands in FOSE.
 */
export type ConfidenceTier =
    | "historically_likely"
    | "historically_partial"
    | "irregular"
    | "permission_only"
    | "restricted"
    | "confirmed";
```

- [ ] **Step 2: Extend `OfferingEntry`**

Find the existing interface for entries in `courses-offerings.json` (likely defined inline somewhere in the engine; if not, add it formally to `types.ts`):

```typescript
export interface OfferingEntry {
    termsOffered: ("fall" | "spring" | "summer" | "january")[];
    rawLine: string;
    inferred: boolean;
    /** Phase 12.9.5: classified confidence in this offering pattern. */
    confidence: ConfidenceTier;
}
```

- [ ] **Step 3: Type-check**

```bash
cd packages/shared && npx tsc --noEmit && cd ../engine && npx tsc --noEmit
```

Expected: zero new errors. The `confidence` field is optional at first to avoid breaking existing consumers; flip to required once Task 2 has populated all entries.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): ConfidenceTier + OfferingEntry.confidence (Phase 12.9.5)"
```

---

## Task 2: Frequency-pass classifier

**Files:**
- Create: `tools/bulletin-parser/extractOfferingConfidence.ts`

The first pass classifies each course's offering pattern from historical FOSE data in `course_catalog_full.json`. NYU's FOSE term codes encode (century × year × season): e.g. `1244 = Spring 2024`, `1248 = Fall 2024`, `1254 = Spring 2025`. The last digit is the season (`4=Spring`, `6=Summer`, `8=Fall`).

Algorithm:
1. Load `data/course-catalog/course_catalog_full.json` — get `termsOffered: ["1244", "1248", ...]` per course.
2. Group historical terms by season (Spring/Summer/Fall/Winter).
3. For each season, count how many of the last-4 same-season terms the course was offered in.
4. Compute the strongest season's appearance rate.
5. Assign tier:
   - ≥75% (3-of-4 or 4-of-4) → `historically_likely`
   - 25–75% (1-of-4 or 2-of-4) → `historically_partial`
   - <25% (0-of-4 in last 4 same-season) → `irregular`

Edge case: courses with fewer than 4 historical same-season terms (newer courses) → if appearance rate ≥ 50% of available history → `historically_partial`; else `irregular`. New courses (1 historical term) default to `historically_partial` if that one term shows up; else `irregular`.

- [ ] **Step 1: Write the frequency classifier**

```typescript
/**
 * Phase 12.9.5 — Offering Confidence Enrichment (frequency pass).
 *
 * Classifies each course's historical FOSE termsOffered pattern into a
 * confidence tier based on appearance rate in the last 4 same-season
 * terms. Restriction pass (Task 3) overrides this for permission-only
 * and major-restricted courses.
 *
 * Run: pnpm tsx tools/bulletin-parser/extractOfferingConfidence.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");

const FOSE_CATALOG_PATH = join(
    REPO_ROOT,
    "packages/engine/src/data/course_catalog_full.json",
);
const OFFERINGS_PATH = join(
    REPO_ROOT,
    "packages/engine/src/data/courses-offerings.json",
);

type Season = "spring" | "summer" | "fall" | "winter";

const SEASON_BY_LAST_DIGIT: Record<string, Season> = {
    "2": "winter", "4": "spring", "6": "summer", "8": "fall",
};

function classifyByFrequency(historicalTerms: string[]): "historically_likely" | "historically_partial" | "irregular" {
    // Group historical terms by season.
    const bySeason: Record<Season, string[]> = {
        spring: [], summer: [], fall: [], winter: [],
    };
    for (const code of historicalTerms) {
        const lastDigit = code.slice(-1);
        const season = SEASON_BY_LAST_DIGIT[lastDigit];
        if (season) bySeason[season].push(code);
    }

    // For each season, compute appearance rate over the last 4 same-season terms.
    let bestRate = 0;
    for (const season of ["spring", "summer", "fall", "winter"] as const) {
        const terms = bySeason[season].sort(); // chronological by code
        const last4 = terms.slice(-4);
        const denominator = Math.min(4, last4.length);
        if (denominator === 0) continue;
        const rate = last4.length / denominator;
        bestRate = Math.max(bestRate, rate);
    }

    // Edge case: very sparse history → less confident.
    if (historicalTerms.length === 0) return "irregular";
    if (historicalTerms.length < 4 && bestRate < 0.5) return "irregular";
    if (bestRate >= 0.75) return "historically_likely";
    if (bestRate >= 0.25) return "historically_partial";
    return "irregular";
}

interface FoseCatalogEntry {
    courseId: string;
    termsOffered: string[];
}

function buildFrequencyMap(): Map<string, "historically_likely" | "historically_partial" | "irregular"> {
    const entries: FoseCatalogEntry[] = JSON.parse(readFileSync(FOSE_CATALOG_PATH, "utf-8"));
    const out = new Map<string, ReturnType<typeof classifyByFrequency>>();
    for (const e of entries) {
        out.set(e.courseId, classifyByFrequency(e.termsOffered));
    }
    return out;
}
```

- [ ] **Step 2: Smoke-test on representative courses**

```typescript
// Add to extractOfferingConfidence.ts (under main()):
function smokeTest() {
    const map = buildFrequencyMap();
    const samples = [
        "CSCI-UA 101",      // expect "historically_likely" — runs every term
        "CSCI-UA 102",      // expect "historically_likely"
        "MATH-UA 121",      // expect "historically_likely"
        "EXPOS-UA 1",       // expect "historically_likely"
        "ANTH-UA 9070",     // study-abroad, less frequent — expect "historically_partial" or "irregular"
        "PHYS-UA 135",      // less frequent — expect "irregular" or "historically_partial"
    ];
    for (const c of samples) console.log(`  ${c}: ${map.get(c) ?? "(not in catalog)"}`);
}
```

Run: `pnpm tsx tools/bulletin-parser/extractOfferingConfidence.ts --smoke`

Adjust thresholds if smoke results don't match intuition.

---

## Task 3: Restriction-pass classifier (override frequency)

**Files:**
- Modify: `tools/bulletin-parser/extractOfferingConfidence.ts`

Some courses have permission-only or major-restricted enrollment that overrides the frequency tier (a course offered every fall but only with department permission is NOT `historically_likely` for planning — it's `permission_only`).

Detection: scan the bulletin chunk for the course (in `data/bulletin-raw/courses/<dept>_<sfx>/_index.md`) for restriction signals.

- [ ] **Step 1: Define restriction patterns**

```typescript
const PERMISSION_PATTERNS: RegExp[] = [
    /permission of (?:the )?department/i,
    /permission of (?:the )?instructor/i,
    /consent of (?:the )?(?:instructor|department)/i,
    /by application only/i,
    /requires? (?:departmental )?application/i,
    /enrollment by permission/i,
];

const RESTRICTED_PATTERNS: RegExp[] = [
    /restricted to (?:[A-Z][a-z]+ )?(?:majors|students)/i,
    /open only to (?:[A-Z][a-z]+ )?(?:majors|students)/i,
    /reserved for (?:[A-Z][a-z]+ )?(?:majors|students)/i,
    /limited to (?:students in )?[A-Z][a-z]+/i,
    /honors students only/i,
];
```

- [ ] **Step 2: Implement restriction classifier**

```typescript
function classifyByRestriction(courseId: string): "permission_only" | "restricted" | null {
    // Find the course's bulletin chunk.
    const m = courseId.match(/^([A-Z][A-Z0-9]*)-([A-Z]+) /);
    if (!m) return null;
    const [, dept, sfx] = m;
    const path = join(REPO_ROOT, `data/bulletin-raw/courses/${dept.toLowerCase()}_${sfx.toLowerCase()}/_index.md`);
    let content: string;
    try {
        content = readFileSync(path, "utf-8");
    } catch {
        return null;
    }

    // Find the chunk for this specific course.
    const chunkRe = new RegExp(
        `\\*\\*${courseId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\*\\*.*?(?=\\*\\*[A-Z][A-Z0-9]*-[A-Z]+ \\S+\\*\\*|$)`,
        "s",
    );
    const chunkMatch = chunkRe.exec(content);
    if (!chunkMatch) return null;
    const chunk = chunkMatch[0];

    for (const pat of PERMISSION_PATTERNS) {
        if (pat.test(chunk)) return "permission_only";
    }
    for (const pat of RESTRICTED_PATTERNS) {
        if (pat.test(chunk)) return "restricted";
    }
    return null;
}
```

- [ ] **Step 3: Combine the two passes**

```typescript
function main() {
    const offerings = JSON.parse(readFileSync(OFFERINGS_PATH, "utf-8")) as Record<string, OfferingEntry>;
    const freqMap = buildFrequencyMap();

    let augmented = 0;
    const tierCounts: Record<string, number> = {};

    for (const [courseId, entry] of Object.entries(offerings)) {
        // Restriction pass takes precedence over frequency.
        const restrictionTier = classifyByRestriction(courseId);
        const frequencyTier = freqMap.get(courseId) ?? "irregular";
        const finalTier = restrictionTier ?? frequencyTier;

        entry.confidence = finalTier;
        tierCounts[finalTier] = (tierCounts[finalTier] ?? 0) + 1;
        augmented++;
    }

    writeFileSync(OFFERINGS_PATH, JSON.stringify(offerings, null, 2));
    console.log(`Augmented ${augmented} entries with confidence tiers.`);
    for (const [tier, count] of Object.entries(tierCounts).sort(([, a], [, b]) => b - a)) {
        console.log(`  ${tier}: ${count}`);
    }
}

main();
```

- [ ] **Step 4: Run + spot-check**

```bash
pnpm tsx tools/bulletin-parser/extractOfferingConfidence.ts
```

Expected output:
```
Augmented ~7,963 entries with confidence tiers.
  historically_likely:  ~5,500  (~70%)
  historically_partial: ~1,200  (~15%)
  irregular:            ~900    (~11%)
  permission_only:      ~250    (~3%)
  restricted:           ~100    (~1%)
```

Numbers should roughly match — high-frequency intro courses dominate `historically_likely`; permission-only seminars and honors-track courses fill the smaller tiers.

Spot-check 5 entries against bulletin truth:
- A high-volume intro course (`CSCI-UA 101`) → expect `historically_likely`
- A study-abroad course (`ANTH-UA 9070`) → expect `historically_partial` or `irregular`
- A seminar with department permission → expect `permission_only`
- An honors-only course → expect `restricted`
- A new course → expect `historically_partial` or `irregular`

If spot-checks reveal pattern misses (e.g. a real permission-only course classified as `historically_likely`), iterate on the regex patterns.

---

## Task 4: Vitest regression suite

**Files:**
- Create: `packages/engine/tests/data/offeringConfidence.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OFFERINGS = JSON.parse(
    readFileSync(
        join(__dirname, "../../src/data/courses-offerings.json"),
        "utf-8",
    ),
);

describe("Phase 12.9.5 — offering confidence", () => {
    it("every entry has a confidence tier", () => {
        const valid = new Set([
            "historically_likely", "historically_partial", "irregular",
            "permission_only", "restricted", "confirmed",
        ]);
        for (const [courseId, entry] of Object.entries(OFFERINGS) as [string, any][]) {
            expect(valid.has(entry.confidence), `${courseId} has invalid confidence: ${entry.confidence}`).toBe(true);
        }
    });

    it("intro CS courses are historically_likely", () => {
        for (const courseId of ["CSCI-UA 101", "CSCI-UA 102", "MATH-UA 121", "EXPOS-UA 1"]) {
            const entry = OFFERINGS[courseId];
            expect(entry, `${courseId} not in offerings`).toBeDefined();
            expect(entry.confidence).toBe("historically_likely");
        }
    });

    it("tier distribution is sane (no tier dominates 100%)", () => {
        const counts: Record<string, number> = {};
        for (const entry of Object.values(OFFERINGS) as any[]) {
            counts[entry.confidence] = (counts[entry.confidence] ?? 0) + 1;
        }
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        expect(counts.historically_likely).toBeGreaterThan(total * 0.4);
        expect(counts.historically_likely).toBeLessThan(total * 0.95);
    });

    it("no entries have 'confirmed' tier (confirmed is set at runtime by Phase 15)", () => {
        // Phase 12.9.5 should NEVER write "confirmed" — that's Phase 15's FOSE materializer's job.
        for (const [courseId, entry] of Object.entries(OFFERINGS) as [string, any][]) {
            expect(entry.confidence, `${courseId} has confirmed tier set at static-data time`).not.toBe("confirmed");
        }
    });
});
```

Run:
```bash
pnpm vitest run packages/engine/tests/data/offeringConfidence.test.ts
```

All tests must pass.

---

## Task 5: Commit + push

- [ ] **Step 1: Stage**

```bash
git add tools/bulletin-parser/extractOfferingConfidence.ts \
        packages/engine/tests/data/offeringConfidence.test.ts \
        packages/shared/src/types.ts
git add -f packages/engine/src/data/courses-offerings.json
```

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(parser): offering confidence enrichment (Phase 12.9.5; Decision #29)

Each entry in courses-offerings.json gains a `confidence` tier classifying
whether the course's historical FOSE termsOffered pattern is reliable
enough to schedule against. Phase 13's solver penalizes scheduling
low-confidence offerings into critical-path slots; the agent surfaces
"this plan assumes X is offered, historically likely but unconfirmed"
to students.

Two-pass classifier:
- Frequency: ≥75% appearance in last 4 same-season terms → historically_likely;
  25-75% → historically_partial; <25% → irregular.
- Restriction: bulletin chunks matching "permission of department" or
  major-restriction patterns override to permission_only / restricted.

Tier distribution (~7,963 entries):
- historically_likely:  ~70%
- historically_partial: ~15%
- irregular:            ~11%
- permission_only:      ~3%
- restricted:           ~1%

The 'confirmed' tier is reserved for Phase 15's FOSE materializer and
is never set at static-data time.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Push**

```bash
git push
```

---

## Self-review notes

- **Phase 13 dependency:** Phase 13's solver reads `OfferingEntry.confidence` during candidate ranking (penalty for `irregular` / `permission_only` slots in critical-path placements). If this phase ships incomplete (some entries missing `confidence`), Phase 13 falls back to treating missing values as `historically_partial`.
- **Phase 15 interaction:** Phase 15's FOSE materializer promotes a course's `confidence` to `confirmed` at materialization time when the actual section is in FOSE. This is a runtime override; the static `courses-offerings.json` is never written with `confirmed`.
- **Tuning:** Initial thresholds (75%, 25%) and pattern regexes are calibrated empirically. Phase 13's first 5–10 student plans may surface false-positive `irregular` or `permission_only` classifications; iterate on patterns then.
- **No engine impact:** this phase ships data + types only. No solver code changes; Phase 13 reads the new field once it lands.
