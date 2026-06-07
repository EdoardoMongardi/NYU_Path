# Double-Counting: Cited Data + Advisory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Revive a small, bulletin-cited per-school double-counting limit dataset (CAS, SPS, NYU Abu Dhabi, NYU Shanghai) and surface it to multi-program students as a *cited advisory* on plan generation and plan edits — without any solver/validator enforcement.

**Architecture:** Three layers. (1) **Data** — a redesigned `DoubleCountingConfig` (a `cap?` model and a `floor?` model, since NYU Shanghai is hybrid) stored on `SchoolConfig`, authored from each school's bulletin academic-policies page with a `sourceRef`. (2) **Detector** — pure functions over the DPR (`countDeclaredPrograms`, `detectSharedCourses`) that need no cross-program attribution. (3) **Advisory** — a pure `buildDoubleCountAdvisory(dpr, schoolConfig)` that returns a `Disclaimer` (quantified when a config exists, generic otherwise), surfaced via the existing tool-envelope `Disclaimer` channel on `plan_forward_degree` and via `consequences[]` on `propose_plan_change` / `confirm_plan_change`.

**Tech Stack:** TypeScript pnpm monorepo (`@nyupath/shared` + `@nyupath/engine`), Zod for config validation, Vitest for tests.

---

## What this is and is NOT (read before coding)

This increment was scoped through extended design review. The locked decisions:

- **NO solver/validator enforcement.** A generated plan structurally cannot share a course (`PlacedCourse.satisfiesRId` is single-valued — `constraintModel.ts:49-59`), so a ceiling is a no-op on generated plans; on a real DPR Albert has already enforced the cap; and there is **no rId→program attribution** in the data model (`dpr.requirementGroups` is flat), so an *accurate* cross-program count cannot be computed. Therefore we do **not** add a validator axis, a hard constraint, or any enforcement. Do not re-introduce `check_overlap` / `crossProgramAudit`.
- **Data is cited, never invented.** Only the four schools whose bulletins state a clear rule get structured data. The other seven (Stern, Tandon, Tisch, Steinhardt, Gallatin, Liberal Studies, Nursing) get **no** config entry — multi-program students there receive a *generic* advisory (no number), matching the owner's "vague → assume 0 + generic side-note" decision.
- **Declared-student sharing already works** via the DPR (`coursesUsed` is per-leaf and faithfully preserved). We add nothing there.
- **The advisory is advisory.** It never flips `feasible`, never blocks an edit. It is a cited heads-up that double-counting may shorten the plan, surfaced through the sanctioned `Disclaimer` "rules-as-data" channel (`toolEnvelope.ts:32-50`).

## CRITICAL infra rules (will silently corrupt work if ignored)

- **NEVER run `tsc -b`** — it re-emits `.js`/`.d.ts` shadow artifacts that vitest runs *instead of* the `.ts` source. Typecheck ONLY with `--noEmit`:
  `pnpm exec tsc -p packages/shared/tsconfig.json --noEmit && pnpm exec tsc -p packages/engine/tsconfig.json --noEmit`
- After each task verify zero shadows (must print nothing):
  `find packages/engine/src packages/shared/src -name '*.js' | while read js; do { [ -f "${js%.js}.ts" ] || [ -f "${js%.js}.tsx" ]; } && echo "$js"; done`
  `rm` any that appear.
- **`@nyupath/shared` is consumed as a build artifact by the engine.** After editing `packages/shared/src/types.ts`, rebuild shared so the engine sees the new type: `pnpm --filter @nyupath/shared build` (this is a declared dependency build, NOT `tsc -b` on engine). If the repo's shared package is consumed directly from source (check `packages/engine` path mapping), this is a no-op — run it anyway; it is safe.
- Tests: `pnpm exec vitest run "<substr>"` for a slice; `pnpm exec vitest run` for the full suite. **Confirm the baseline before starting** (last known ≈ 1646 passed / 9 skipped — verify, don't assume).
- **Scoped commits only** (`git add <explicit files>`, NEVER `git add -A` — pre-existing leftovers like `D .agent/rules`, `M pnpm-lock`, untracked desktop files must stay untouched).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch off `main`; **don't push/merge unless the owner asks**; present finishing options when done.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/shared/src/types.ts` | `DoubleCountingConfig` type + `SchoolConfig.doubleCounting` | Modify (replace orphan type at 305-331; add member at 428-430) |
| `packages/engine/src/provenance/configSchema.ts` | Zod atom + wire into body schema | Modify (replace atom at 93-111; add field at 149) |
| `data/schools/{cas,sps,nyuad,shanghai}.json` | The cited limit data | Modify (add `doubleCounting`) |
| `packages/engine/tests/provenance/doubleCountingSchema.test.ts` | Schema-shape unit test | Create |
| `packages/engine/tests/eval/schoolConfigsAll.test.ts` | All-configs guard | Modify (drop absence assertion; add positive ones) |
| `packages/engine/src/agent/forwardSchedule/doubleCountAdvisory.ts` | Detector + advisory builder (pure) | Create |
| `packages/engine/tests/forwardSchedule/doubleCountAdvisory.test.ts` | Detector/advisory unit tests | Create |
| `packages/engine/src/agent/tools/planForwardDegree.ts` | Attach advisory as a `Disclaimer` | Modify |
| `packages/engine/src/agent/tools/proposePlanChange.ts` | Push advisory into `consequences[]` | Modify |
| `packages/engine/src/agent/tools/confirmPlanChange.ts` | Push advisory into `consequences[]` | Modify |
| `packages/engine/tests/agent/doubleCountAdvisoryWiring.test.ts` | Tool-wiring tests | Create |

---

### Task 1: Redesign `DoubleCountingConfig` (type + Zod atom) and wire it back into `SchoolConfig`

**Files:**
- Modify: `packages/shared/src/types.ts:305-331` (replace orphan interface) and `:428-430` (add member)
- Modify: `packages/engine/src/provenance/configSchema.ts:93-111` (replace atom) and `:149` (wire in)
- Test: `packages/engine/tests/provenance/doubleCountingSchema.test.ts` (create)

- [ ] **Step 1: Write the failing schema test**

Create `packages/engine/tests/provenance/doubleCountingSchema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateSchoolConfigBody } from "../../src/provenance/configSchema.js";

// Minimal valid body the loader accepts; we only vary `doubleCounting`.
function bodyWith(doubleCounting: unknown) {
    return {
        schoolId: "test",
        name: "Test School",
        courseSuffix: ["-UA"],
        residency: { type: "suffix_based", suffix: "-UA" },
        doubleCounting,
    };
}

describe("doubleCounting config schema (cap + floor models)", () => {
    it("accepts a cap-model config (CAS-shape)", () => {
        const r = validateSchoolConfigBody(bodyWith({
            cap: { majorToMajor: 2, majorToMinor: 2, minorToMinor: 2 },
            noTripleCounting: true,
            requiresApproval: true,
            sourceRef: "arts-science/academic-policies/_index.md:126",
        }));
        expect(r.ok).toBe(true);
    });

    it("accepts a floor-model config (NYUAD-shape)", () => {
        const r = validateSchoolConfigBody(bodyWith({
            floor: { minDistinctCreditsPerMajor: 30, minUniqueCoursesPerMinor: 2 },
            noTripleCounting: true,
            requiresApproval: true,
            sourceRef: "abu-dhabi/academic-policies/_index.md:146",
        }));
        expect(r.ok).toBe(true);
    });

    it("accepts a hybrid cap+floor config (Shanghai-shape)", () => {
        const r = validateSchoolConfigBody(bodyWith({
            cap: { majorToMajor: 2 },
            floor: { minUniqueCreditsPerMinor: 12 },
            noTripleCounting: true,
            requiresApproval: true,
            sourceRef: "shanghai/academic-policies/_index.md:122",
        }));
        expect(r.ok).toBe(true);
    });

    it("rejects a config missing required noTripleCounting/requiresApproval/sourceRef", () => {
        const r = validateSchoolConfigBody(bodyWith({ cap: { majorToMajor: 2 } }));
        expect(r.ok).toBe(false);
    });

    it("accepts a body with no doubleCounting field at all (optional)", () => {
        const body = bodyWith(undefined);
        delete (body as Record<string, unknown>).doubleCounting;
        expect(validateSchoolConfigBody(body).ok).toBe(true);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run doubleCountingSchema`
Expected: FAIL — the current `schoolConfigBodySchema` has no `doubleCounting` field, and `.passthrough()` accepts ANYTHING under that key, so the "rejects … missing required" case fails (the bad object passes through). This proves the field is not yet validated.

- [ ] **Step 3: Replace the orphan type in `packages/shared/src/types.ts`**

Replace the entire interface at lines 305-331 (`export interface DoubleCountingConfig { … }`) with:

```ts
/**
 * Per-school double-counting limit, authored from the school's bulletin
 * academic-policies page. Two complementary models — a school may use one
 * or BOTH (NYU Shanghai uses a course CAP for majors and a credit FLOOR for
 * minors). Surfaced to multi-program students as a CITED advisory; NOT
 * enforced by the solver/validator (cross-program attribution is not modeled
 * — see docs/superpowers/plans/2026-06-07-double-count-data-advisory.md).
 */
export interface DoubleCountingConfig {
    /**
     * CAP model — maximum number of courses that may be SHARED (double-counted)
     * across two programs. Omit a pair the school does not express as a course cap.
     */
    cap?: {
        /** Max courses shared between two majors. */
        majorToMajor?: number;
        /** Max courses shared between a major and a minor. */
        majorToMinor?: number;
        /** Max courses shared between two minors. */
        minorToMinor?: number;
    };
    /**
     * FLOOR model — minimum coursework each program must keep UNIQUE (the
     * inverse of a cap; it bounds sharing indirectly). Used by NYU Abu Dhabi
     * and NYU Shanghai (minors).
     */
    floor?: {
        /** Min credits each major must keep distinct from any other program. */
        minDistinctCreditsPerMajor?: number;
        /** Min courses each minor must keep unique to that minor. */
        minUniqueCoursesPerMinor?: number;
        /** Min credits each minor must keep unique to that minor. */
        minUniqueCreditsPerMinor?: number;
    };
    /** Triple-counting (one course → three programs) is never permitted. */
    noTripleCounting: boolean;
    /** Sharing always requires explicit department/DUS approval (never automatic). */
    requiresApproval: boolean;
    /** Bulletin nuance (e.g. Shanghai "Core courses exempt; stricter depts may differ"). */
    note?: string;
    /** Provenance — the bulletin-raw `path:line` this limit was read from. */
    sourceRef: string;
}
```

- [ ] **Step 4: Add the member back to `SchoolConfig`**

In `packages/shared/src/types.ts`, the `SchoolConfig` interface has this tombstone at lines 428-430:

```ts
    // Step 8e — overallGpaMin removed: the GPA floor is per-student and comes
    // from the DPR (`dpr.cumulative.cumulativeGpaRequired`). doubleCounting
    // removed: double-counting is answered from the DPR + RAG (no authored rule).
    residency: ResidencyConfig;
```

Replace it with:

```ts
    // Step 8e — overallGpaMin removed: the GPA floor is per-student and comes
    // from the DPR (`dpr.cumulative.cumulativeGpaRequired`).
    /**
     * Re-introduced 2026-06-07 (data + advisory only, NO enforcement): per-school
     * double-counting limit, cited to the bulletin. Present only for schools whose
     * bulletin states a clear rule (CAS, SPS, NYUAD, Shanghai); absent elsewhere.
     */
    doubleCounting?: DoubleCountingConfig;
    residency: ResidencyConfig;
```

- [ ] **Step 5: Replace the Zod atom in `configSchema.ts`**

Replace the entire `doubleCountingConfigSchema` definition at lines 93-111 with:

```ts
const doubleCountingConfigSchema = z.object({
    cap: z.object({
        majorToMajor: z.number().optional(),
        majorToMinor: z.number().optional(),
        minorToMinor: z.number().optional(),
    }).optional(),
    floor: z.object({
        minDistinctCreditsPerMajor: z.number().optional(),
        minUniqueCoursesPerMinor: z.number().optional(),
        minUniqueCreditsPerMinor: z.number().optional(),
    }).optional(),
    noTripleCounting: z.boolean(),
    requiresApproval: z.boolean(),
    note: z.string().optional(),
    sourceRef: z.string(),
}).strict();
```

> Note: use `.strict()` (not `.passthrough()`) on this atom so the "rejects missing required" test actually fails a malformed object. The OUTER `schoolConfigBodySchema` keeps `.passthrough()` for `_meta` etc.; the nested atom is strict.

- [ ] **Step 6: Wire the atom into `schoolConfigBodySchema`**

In `configSchema.ts`, the body schema has this tombstone at line 149:

```ts
    courseSuffix: z.array(z.string()),
    // Step 8e — overallGpaMin + doubleCounting removed (GPA floor → DPR; double-counting → DPR+RAG).
    residency: residencyConfigSchema,
```

Replace with:

```ts
    courseSuffix: z.array(z.string()),
    // Step 8e — overallGpaMin removed (GPA floor → DPR).
    // 2026-06-07 — doubleCounting re-introduced (cited data + advisory only).
    doubleCounting: doubleCountingConfigSchema.optional(),
    residency: residencyConfigSchema,
```

- [ ] **Step 7: Run the schema test to verify it passes**

Run: `pnpm exec vitest run doubleCountingSchema`
Expected: PASS (all 5 cases).

- [ ] **Step 8: Typecheck + shadow check**

Run: `pnpm --filter @nyupath/shared build` then
`pnpm exec tsc -p packages/shared/tsconfig.json --noEmit && pnpm exec tsc -p packages/engine/tsconfig.json --noEmit`
Expected: no errors. Then run the shadow-check one-liner (must print nothing).

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/types.ts packages/engine/src/provenance/configSchema.ts packages/engine/tests/provenance/doubleCountingSchema.test.ts
git commit -m "feat(engine): re-introduce DoubleCountingConfig schema (cap+floor models)

Cited data + advisory only — no solver/validator enforcement.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Author the four cited JSON configs and update the all-configs guard

**Files:**
- Modify: `data/schools/cas.json`, `data/schools/sps.json`, `data/schools/nyuad.json`, `data/schools/shanghai.json`
- Modify: `packages/engine/tests/eval/schoolConfigsAll.test.ts:58` (drop) + the "carries real school-specific values" test (add positive assertions)

- [ ] **Step 1: Update the failing guard test first**

In `packages/engine/tests/eval/schoolConfigsAll.test.ts`, DELETE line 58:

```ts
            expect(c.doubleCounting).toBeUndefined();
```

Then, inside the `it("carries real school-specific values (not flattened to CAS defaults)", …)` block, immediately AFTER the existing `expect(get("steinhardt").passFail?.careerLimitType)...` line (currently line 51), ADD:

```ts
        // doubleCounting — re-introduced 2026-06-07, cited per school.
        // CAS + SPS use the CAP model; NYUAD uses the FLOOR model; Shanghai is HYBRID.
        const cas = get("cas").doubleCounting;
        expect(cas?.cap?.majorToMinor).toBe(2);
        expect(cas?.noTripleCounting).toBe(true);
        const sps = get("sps").doubleCounting;
        expect(sps?.cap?.majorToMajor).toBe(2);
        // Provenance proves SPS is bulletin-sourced, not a CAS copy.
        expect(sps?.sourceRef).toContain("professional-studies");
        const nyuad = get("nyuad").doubleCounting;
        expect(nyuad?.floor?.minDistinctCreditsPerMajor).toBe(30);
        expect(nyuad?.cap).toBeUndefined(); // floor-only — structurally NOT CAS
        const shanghai = get("shanghai").doubleCounting;
        expect(shanghai?.cap?.majorToMajor).toBe(2);
        expect(shanghai?.floor?.minUniqueCreditsPerMinor).toBe(12); // hybrid
        // The 7 schools with no clear bulletin rule carry NO config (no invention).
        for (const s of ["stern", "tandon", "tisch", "steinhardt", "gallatin", "liberal_studies", "nursing"]) {
            expect(get(s).doubleCounting, `${s} must have no authored doubleCounting`).toBeUndefined();
        }
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run schoolConfigsAll`
Expected: FAIL — the four configs don't yet have `doubleCounting` (all the new `expect(...).toBe(...)` lines fail).

- [ ] **Step 3: Add `doubleCounting` to `data/schools/cas.json`**

Insert this key immediately after the `residency` block (after line 24's closing `},`, before `"creditCaps"`):

```json
  "doubleCounting": {
    "cap": { "majorToMajor": 2, "majorToMinor": 2, "minorToMinor": 2 },
    "noTripleCounting": true,
    "requiresApproval": true,
    "note": "Up to two courses may be shared between two majors, a major and a minor, or two minors, with both DUSs' written approval; some departments set a stricter limit (one shared course, or none). No course may be triple-counted.",
    "sourceRef": "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md:126"
  },
```

- [ ] **Step 4: Add `doubleCounting` to `data/schools/sps.json`**

Insert immediately after the `residency` block (after line 23's `},`, before `"creditCaps"`):

```json
  "doubleCounting": {
    "cap": { "majorToMajor": 2, "majorToMinor": 2, "minorToMinor": 2 },
    "noTripleCounting": true,
    "requiresApproval": true,
    "note": "Up to two courses may be shared between two majors, a major and a minor, or two minors, only if the academic departments consider it appropriate; some departments are stricter. No course may be triple-counted.",
    "sourceRef": "data/bulletin-raw/undergraduate/professional-studies/academic-policies/_index.md:611"
  },
```

- [ ] **Step 5: Add `doubleCounting` to `data/schools/nyuad.json`**

Insert immediately after the `residency` block (after line 24's `},`, before `"creditCaps"`):

```json
  "doubleCounting": {
    "floor": { "minDistinctCreditsPerMajor": 30, "minUniqueCoursesPerMinor": 2 },
    "noTripleCounting": true,
    "requiresApproval": true,
    "note": "Uniqueness-floor model: each of two majors must include at least 30 credits not counted toward the other; each minor must include at least 2 courses unique to it. No single course may count for more than one Core category, and certain Core categories cannot also count toward a major or minor.",
    "sourceRef": "data/bulletin-raw/undergraduate/abu-dhabi/academic-policies/_index.md:146"
  },
```

- [ ] **Step 6: Add `doubleCounting` to `data/schools/shanghai.json`**

Insert immediately after the `residency` block (after line 24's `},`, before `"creditCaps"`):

```json
  "doubleCounting": {
    "cap": { "majorToMajor": 2 },
    "floor": { "minUniqueCreditsPerMinor": 12 },
    "noTripleCounting": true,
    "requiresApproval": true,
    "note": "No more than two courses may be double-counted between two majors unless otherwise specified in the major section; a minor must include at least 12 credits unique to it. Core Curriculum courses are exempt from double-counting limits, but no single course may satisfy more than two requirements.",
    "sourceRef": "data/bulletin-raw/undergraduate/shanghai/academic-policies/_index.md:122"
  },
```

- [ ] **Step 7: Run the guard test to verify it passes**

Run: `pnpm exec vitest run schoolConfigsAll`
Expected: PASS (every `doubleCounting` assertion + the 7-school absence loop).

- [ ] **Step 8: Sanity-check JSON validity + shadow check**

Run: `node -e "for (const s of ['cas','sps','nyuad','shanghai']) JSON.parse(require('fs').readFileSync('data/schools/'+s+'.json','utf8'))"`
Expected: no output (all parse). Then run the shadow-check one-liner.

- [ ] **Step 9: Commit**

```bash
git add data/schools/cas.json data/schools/sps.json data/schools/nyuad.json data/schools/shanghai.json packages/engine/tests/eval/schoolConfigsAll.test.ts
git commit -m "feat(data): author cited double-count limits for CAS/SPS/NYUAD/Shanghai

CAS+SPS cap model, NYUAD floor model, Shanghai hybrid. Other 7 schools
intentionally left absent (no clear bulletin rule). sourceRef cites bulletin-raw.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Detector + advisory builder (pure functions)

**Files:**
- Create: `packages/engine/src/agent/forwardSchedule/doubleCountAdvisory.ts`
- Test: `packages/engine/tests/forwardSchedule/doubleCountAdvisory.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `packages/engine/tests/forwardSchedule/doubleCountAdvisory.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { DegreeProgressReport, SchoolConfig } from "@nyupath/shared";
import {
    countDeclaredPrograms,
    detectSharedCourses,
    buildDoubleCountAdvisory,
} from "../../src/agent/forwardSchedule/doubleCountAdvisory.js";

function row(subject: string, catalogNbr: string) {
    return { term: "2025 Fall", subject, catalogNbr, courseTitle: "X", grade: "A", units: 4, type: "EN" };
}
function leaf(rId: string, coursesUsed: ReturnType<typeof row>[]) {
    return { rId, title: rId, status: "satisfied" as const, statusText: "", coursesUsed };
}
function makeDpr(programs: { programType: string; label: string }[], leaves: ReturnType<typeof leaf>[]): DegreeProgressReport {
    return {
        _meta: { parserVersion: "1.0.0", parsedAt: "t", sourceFingerprint: "sha256:x", sourcePdfPageCount: 1, parseDurationMs: 1, warnings: [] },
        header: { studentName: "S", preparedDate: "01/01/2026" },
        programs: programs.map((p) => ({ ...p, requirementTerm: "Fall 2024", requirementStatus: "satisfied" as const })),
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128, creditsUsed: 64, cumulativeGpa: 3.5, cumulativeGpaRequired: 2,
            residencyRequired: 64, residencyUsed: 32, passFailUsedUnits: 0, passFailCapUnits: 32,
            outsideHomeUsedUnits: 0, outsideHomeCapUnits: 16, timeLimitYears: 8,
        },
        requirementGroups: [{ rgId: "RG1", title: "root", status: "satisfied", statusText: "", children: leaves }],
        courseHistory: [],
    };
}
function schoolConfig(doubleCounting?: SchoolConfig["doubleCounting"], name = "College of Arts and Science"): SchoolConfig {
    return { schoolId: "cas", name, courseSuffix: ["-UA"], residency: { type: "suffix_based", suffix: "-UA" }, doubleCounting } as SchoolConfig;
}

const CAS_DC: SchoolConfig["doubleCounting"] = {
    cap: { majorToMajor: 2, majorToMinor: 2, minorToMinor: 2 },
    noTripleCounting: true, requiresApproval: true,
    sourceRef: "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md:126",
};
const NYUAD_DC: SchoolConfig["doubleCounting"] = {
    floor: { minDistinctCreditsPerMajor: 30, minUniqueCoursesPerMinor: 2 },
    noTripleCounting: true, requiresApproval: true,
    sourceRef: "data/bulletin-raw/undergraduate/abu-dhabi/academic-policies/_index.md:146",
};

describe("countDeclaredPrograms", () => {
    it("counts majors+minors+concentrations, ignoring Career/Program rows", () => {
        const dpr = makeDpr(
            [{ programType: "Undergraduate Career", label: "UA" }, { programType: "Program", label: "UA-CAS" },
             { programType: "Major", label: "Economics" }, { programType: "Minor", label: "CS" }],
            [],
        );
        expect(countDeclaredPrograms(dpr)).toBe(2);
    });
});

describe("detectSharedCourses", () => {
    it("flags a course appearing in two requirement leaves", () => {
        const dpr = makeDpr([{ programType: "Major", label: "M" }], [
            leaf("R1", [row("ECON-UA", "1")]),
            leaf("R2", [row("ECON-UA", "1"), row("MATH-UA", "121")]),
        ]);
        const r = detectSharedCourses(dpr);
        expect(r.sharedCourseCount).toBe(1);
        expect(r.sharedCourseIds).toEqual(["ECON-UA 1"]);
    });
    it("returns 0 when no course is reused across leaves", () => {
        const dpr = makeDpr([{ programType: "Major", label: "M" }], [
            leaf("R1", [row("ECON-UA", "1")]),
            leaf("R2", [row("MATH-UA", "121")]),
        ]);
        expect(detectSharedCourses(dpr).sharedCourseCount).toBe(0);
    });
});

describe("buildDoubleCountAdvisory", () => {
    const twoPrograms = [{ programType: "Major", label: "Economics" }, { programType: "Minor", label: "CS" }];

    it("returns null for a single-program student", () => {
        const dpr = makeDpr([{ programType: "Major", label: "Economics" }], []);
        expect(buildDoubleCountAdvisory(dpr, schoolConfig(CAS_DC))).toBeNull();
    });

    it("returns a QUANTIFIED cited disclaimer for a multi-program CAS student", () => {
        const dpr = makeDpr(twoPrograms, []);
        const d = buildDoubleCountAdvisory(dpr, schoolConfig(CAS_DC));
        expect(d).not.toBeNull();
        expect(d!.id).toBe("double_count_advisory");
        expect(d!.text).toContain("up to 2");
        expect(d!.text.toLowerCase()).toContain("double-count");
        expect(d!.text).toContain("adviser");
        expect(d!.bulletinSource).toBe(CAS_DC!.sourceRef);
    });

    it("describes the FLOOR model for a multi-program NYUAD student", () => {
        const dpr = makeDpr(twoPrograms, []);
        const d = buildDoubleCountAdvisory(dpr, schoolConfig(NYUAD_DC, "NYU Abu Dhabi"));
        expect(d!.text).toContain("30");
        expect(d!.text).toContain("unique");
        expect(d!.bulletinSource).toBe(NYUAD_DC!.sourceRef);
    });

    it("returns a GENERIC (uncited) disclaimer for a multi-program student at a school with no config", () => {
        const dpr = makeDpr(twoPrograms, []);
        const d = buildDoubleCountAdvisory(dpr, schoolConfig(undefined, "NYU Tisch"));
        expect(d).not.toBeNull();
        expect(d!.text.toLowerCase()).toContain("double-count");
        expect(d!.text).toContain("adviser");
        expect(d!.bulletinSource).toBeUndefined(); // no invention — no cite
    });

    it("returns null when schoolConfig is null and student is single-program", () => {
        const dpr = makeDpr([{ programType: "Major", label: "M" }], []);
        expect(buildDoubleCountAdvisory(dpr, null)).toBeNull();
    });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run doubleCountAdvisory`
Expected: FAIL — module `doubleCountAdvisory.ts` does not exist yet ("Cannot find module").

- [ ] **Step 3: Implement `doubleCountAdvisory.ts`**

Create `packages/engine/src/agent/forwardSchedule/doubleCountAdvisory.ts`:

```ts
/**
 * Double-counting ADVISORY (data + advisory only — NO enforcement).
 *
 * Pure functions that surface a CITED heads-up to multi-program students that
 * double-counting may let them satisfy two programs with fewer total courses.
 * Quantified from the school's bulletin-cited `doubleCounting` config when one
 * exists; otherwise a generic (uncited) note. Never asserts a number we cannot
 * cite, never flips feasibility. See
 * docs/superpowers/plans/2026-06-07-double-count-data-advisory.md.
 */

import type { DegreeProgressReport, SchoolConfig } from "@nyupath/shared";
import type { Disclaimer } from "../toolEnvelope.js";
import { walkRequirements } from "../../dpr/schema.js";

/** Count major/minor/concentration programs in the DPR (the multi-program
 *  signal that makes cross-program double-counting relevant). Career/Program
 *  rollup rows are ignored. */
export function countDeclaredPrograms(dpr: DegreeProgressReport): number {
    const kinds = new Set(["major", "minor", "concentration"]);
    return dpr.programs.filter((p) => kinds.has(p.programType.trim().toLowerCase())).length;
}

/** Courses that appear in ≥2 requirement leaves' `coursesUsed` — a coarse,
 *  attribution-free signal that Albert has applied a course to more than one
 *  requirement. NOT a cross-program claim (we cannot attribute rIds to
 *  programs); used only to enrich the advisory text. */
export function detectSharedCourses(dpr: DegreeProgressReport): {
    sharedCourseCount: number;
    sharedCourseIds: string[];
} {
    const leafCount = new Map<string, number>();
    for (const req of walkRequirements(dpr.requirementGroups)) {
        const seen = new Set<string>();
        for (const r of req.coursesUsed) {
            const id = `${r.subject} ${r.catalogNbr}`.trim();
            if (seen.has(id)) continue; // dedupe within a single leaf
            seen.add(id);
            leafCount.set(id, (leafCount.get(id) ?? 0) + 1);
        }
    }
    const sharedCourseIds = [...leafCount.entries()]
        .filter(([, n]) => n >= 2)
        .map(([id]) => id)
        .sort();
    return { sharedCourseCount: sharedCourseIds.length, sharedCourseIds };
}

/** Build the double-count advisory `Disclaimer` for a multi-program student,
 *  or null when it does not apply (fewer than 2 programs). Quantified + cited
 *  when the school has a `doubleCounting` config; generic + uncited otherwise. */
export function buildDoubleCountAdvisory(
    dpr: DegreeProgressReport,
    schoolConfig: SchoolConfig | null | undefined,
): Disclaimer | null {
    const programCount = countDeclaredPrograms(dpr);
    if (programCount < 2) return null;

    const schoolName = schoolConfig?.name ?? "your school";
    const dc = schoolConfig?.doubleCounting;
    const { sharedCourseCount } = detectSharedCourses(dpr);
    const sharedNote = sharedCourseCount > 0
        ? ` (your DPR already applies ${sharedCourseCount} course${sharedCourseCount === 1 ? "" : "s"} to more than one requirement)`
        : "";

    // Generic (no cited config): honest, number-free.
    if (!dc) {
        return {
            id: "double_count_advisory",
            text:
                `You're pursuing ${programCount} programs${sharedNote}. Double-counting some courses across them ` +
                `may be possible with department approval and could shorten your plan — confirm the specifics with your adviser.`,
            reason: `Student is pursuing ${programCount} programs; ${schoolName} publishes no clear double-count limit, so this is a generic heads-up.`,
        };
    }

    // Quantified (cited config).
    const clauses: string[] = [];
    if (dc.cap) {
        const caps: string[] = [];
        if (dc.cap.majorToMajor != null) caps.push(`up to ${dc.cap.majorToMajor} between two majors`);
        if (dc.cap.majorToMinor != null) caps.push(`up to ${dc.cap.majorToMinor} between a major and a minor`);
        if (dc.cap.minorToMinor != null) caps.push(`up to ${dc.cap.minorToMinor} between two minors`);
        if (caps.length) clauses.push(`you may share (double-count) ${caps.join(", ")} course(s) across programs`);
    }
    if (dc.floor) {
        const floors: string[] = [];
        if (dc.floor.minDistinctCreditsPerMajor != null) floors.push(`each major must keep at least ${dc.floor.minDistinctCreditsPerMajor} credits unique to it`);
        if (dc.floor.minUniqueCreditsPerMinor != null) floors.push(`each minor must keep at least ${dc.floor.minUniqueCreditsPerMinor} credits unique to it`);
        if (dc.floor.minUniqueCoursesPerMinor != null) floors.push(`each minor must keep at least ${dc.floor.minUniqueCoursesPerMinor} course(s) unique to it`);
        if (floors.length) clauses.push(floors.join("; "));
    }
    const approval = dc.requiresApproval ? " Sharing is never automatic — it needs approval from both departments." : "";
    const triple = dc.noTripleCounting ? " No course may count toward three programs." : "";

    return {
        id: "double_count_advisory",
        text:
            `You're pursuing ${programCount} programs${sharedNote}. At ${schoolName}, ${clauses.join("; ")}. ` +
            `${approval}${triple} This can reduce how many courses you need — confirm which specific courses are eligible with your adviser.`,
        reason: `Student is pursuing ${programCount} programs; ${schoolName}'s bulletin double-count policy applies.`,
        bulletinSource: dc.sourceRef,
    };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run doubleCountAdvisory`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + shadow check**

Run: `pnpm exec tsc -p packages/engine/tsconfig.json --noEmit`
Expected: no errors. Then the shadow-check one-liner.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/forwardSchedule/doubleCountAdvisory.ts packages/engine/tests/forwardSchedule/doubleCountAdvisory.test.ts
git commit -m "feat(engine): double-count advisory detector + builder (pure, no enforcement)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Surface the advisory on `plan_forward_degree` (as a `Disclaimer`)

**Files:**
- Modify: `packages/engine/src/agent/tools/planForwardDegree.ts`
- Test: `packages/engine/tests/agent/doubleCountAdvisoryWiring.test.ts` (create; covers Tasks 4 + 5)

This mirrors the established envelope pattern in `run_full_audit` (`runFullAudit.ts:113` output `disclaimers?`, derived in `call`, rendered in `summarizeResult`).

- [ ] **Step 1: Write the failing wiring test (plan tool portion)**

Create `packages/engine/tests/agent/doubleCountAdvisoryWiring.test.ts`. (Reuse the DPR/schoolConfig builders from Task 3's test by copying the `row`/`leaf`/`makeDpr`/`schoolConfig`/`CAS_DC` helpers into this file — keep them local; do NOT export test helpers from src.)

```ts
import { describe, expect, it } from "vitest";
import { planForwardDegreeTool } from "../../src/agent/tools/planForwardDegree.js";
// ... copy row/leaf/makeDpr/schoolConfig/CAS_DC helpers from Task 3's test file ...

// Build a minimal session a plan tool accepts. The exact AgentSession shape is
// large; construct the fields the tool reads: degreeProgressReport, student,
// schoolConfig. Cast through `unknown` to the tool's session param type.
function makeSession(dpr: ReturnType<typeof makeDpr>, schoolConfig: ReturnType<typeof schoolConfig>) {
    return {
        degreeProgressReport: dpr,
        student: { id: "s1", homeSchool: "cas" },
        schoolConfig,
    } as unknown as Parameters<typeof planForwardDegreeTool.call>[1]["session"];
}

describe("plan_forward_degree double-count advisory", () => {
    const twoPrograms = [{ programType: "Major", label: "Economics" }, { programType: "Minor", label: "CS" }];

    it("attaches a cited double-count disclaimer for a multi-program student and renders it", async () => {
        const dpr = makeDpr(twoPrograms, []);
        const out = await planForwardDegreeTool.call(
            { },
            { session: makeSession(dpr, schoolConfig(CAS_DC)) } as Parameters<typeof planForwardDegreeTool.call>[1],
        );
        expect(out.disclaimers?.some((d) => d.id === "double_count_advisory")).toBe(true);
        const summary = planForwardDegreeTool.summarizeResult!(out);
        expect(summary).toContain("double-count");
    });

    it("attaches NO double-count disclaimer for a single-program student", async () => {
        const dpr = makeDpr([{ programType: "Major", label: "Economics" }], []);
        const out = await planForwardDegreeTool.call(
            { },
            { session: makeSession(dpr, schoolConfig(CAS_DC)) } as Parameters<typeof planForwardDegreeTool.call>[1],
        );
        expect(out.disclaimers?.some((d) => d.id === "double_count_advisory") ?? false).toBe(false);
    });
});
```

> If `planForwardDegreeTool.call` / `summarizeResult` are not directly callable in isolation (e.g. `buildTool` wraps them), adapt by invoking through the tool's public surface the other tool tests use — check an existing tool test (e.g. `runFullAudit` test) for the exact invocation pattern and mirror it. The assertions (a disclaimer with `id === "double_count_advisory"` is present for 2 programs, absent for 1) stay the same.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run doubleCountAdvisoryWiring`
Expected: FAIL — `out.disclaimers` is undefined (the tool doesn't emit it yet).

- [ ] **Step 3: Add the import + output field + derivation + render in `planForwardDegree.ts`**

Add to the imports (after line 16, `import type { ForwardSchedule } …`):

```ts
import type { Disclaimer } from "../toolEnvelope.js";
import { renderEnvelopeMeta } from "../toolEnvelope.js";
import { buildDoubleCountAdvisory } from "../forwardSchedule/doubleCountAdvisory.js";
```

Add a field to `PlanForwardDegreeOutput` (after `summary: string;`, line 49):

```ts
    /** Phase 10 envelope — advisory disclaimers (e.g. double-counting heads-up
     *  for multi-program students). Surfaced verbatim by summarizeResult. */
    disclaimers?: Disclaimer[];
```

In `call`, replace the final `return { schedule, storedIn, summary };` (line 164) with:

```ts
        const advisory = buildDoubleCountAdvisory(dpr, session.schoolConfig);
        const disclaimers = advisory ? [advisory] : undefined;
        return { schedule, storedIn, summary, ...(disclaimers ? { disclaimers } : {}) };
```

Replace `summarizeResult` (lines 166-168) with:

```ts
    summarizeResult(output) {
        const env = renderEnvelopeMeta({ disclaimers: output.disclaimers });
        return env ? `${output.summary}\n\n${env}` : output.summary;
    },
```

> `session.schoolConfig` is the loaded `SchoolConfig` (see `getCreditCaps.ts:60`); when absent, `buildDoubleCountAdvisory` still emits the generic advisory for multi-program students.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run doubleCountAdvisoryWiring`
Expected: the two `plan_forward_degree` cases PASS.

- [ ] **Step 5: Typecheck + shadow check**

Run: `pnpm exec tsc -p packages/engine/tsconfig.json --noEmit` then the shadow-check one-liner. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/agent/tools/planForwardDegree.ts packages/engine/tests/agent/doubleCountAdvisoryWiring.test.ts
git commit -m "feat(engine): surface double-count advisory on plan_forward_degree

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Surface the advisory on `propose_plan_change` + `confirm_plan_change` (via `consequences[]`)

**Files:**
- Modify: `packages/engine/src/agent/tools/proposePlanChange.ts`
- Modify: `packages/engine/src/agent/tools/confirmPlanChange.ts`
- Test: extend `packages/engine/tests/agent/doubleCountAdvisoryWiring.test.ts`

The edit tools surface `consequences: string[]` (rendered in `summarizeResult`), not an envelope. Push the advisory text there for multi-program students. Use the SAME helper (DRY) and take its `.text`.

- [ ] **Step 1: Add the failing test cases (edit tools portion)**

Append to `packages/engine/tests/agent/doubleCountAdvisoryWiring.test.ts`:

```ts
import { proposePlanChangeTool } from "../../src/agent/tools/proposePlanChange.js";

describe("propose_plan_change double-count advisory", () => {
    const twoPrograms = [{ programType: "Major", label: "Economics" }, { programType: "Minor", label: "CS" }];

    it("includes a double-count consequence for a multi-program student", async () => {
        // A plan must already exist in session for propose to run. Build one first
        // via plan_forward_degree (same session), then propose a no-op-ish mutation.
        const dpr = makeDpr(twoPrograms, []);
        const session = makeSession(dpr, schoolConfig(CAS_DC));
        await planForwardDegreeTool.call({}, { session } as Parameters<typeof planForwardDegreeTool.call>[1]);
        const out = await proposePlanChangeTool.call(
            { mutations: [{ kind: "set_load_style", loadStyle: "balanced" }] as never },
            { session } as Parameters<typeof proposePlanChangeTool.call>[1],
        );
        expect(out.consequences.some((c) => c.toLowerCase().includes("double-count"))).toBe(true);
    });
});
```

> The exact `mutations` shape must be a valid `PlanMutation` — open `planChangeHelpers.ts` `PlanMutationSchema` and pick the simplest variant (e.g. a load-style or a set-preference mutation). Replace the placeholder mutation above with a real one and drop the `as never`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run doubleCountAdvisoryWiring`
Expected: the new propose case FAILS (no double-count consequence yet).

- [ ] **Step 3: Wire the advisory into `proposePlanChange.ts`**

Add to imports (after line 25, `import { explainPlanDiff } …`):

```ts
import { buildDoubleCountAdvisory } from "../forwardSchedule/doubleCountAdvisory.js";
```

In `call`, immediately AFTER the line `const consequences = deriveConsequences(diff, proposedSchedule, noOpConsequences);` (line 169), add:

```ts
        const dcAdvisory = buildDoubleCountAdvisory(dpr, session.schoolConfig);
        if (dcAdvisory) consequences.push(dcAdvisory.text);
```

> `consequences` is a `const` bound to an array; `.push` mutates it in place (allowed). It is returned at line 197.

- [ ] **Step 4: Wire the advisory into `confirmPlanChange.ts`**

Add to imports (after line 25, the `planChangeHelpers` import block):

```ts
import { buildDoubleCountAdvisory } from "../forwardSchedule/doubleCountAdvisory.js";
```

In `call`, immediately AFTER the line `const consequences = deriveConsequences(diff, newSchedule, noOpConsequences);` (line 190), add:

```ts
        const dcAdvisory = buildDoubleCountAdvisory(dpr, session.schoolConfig);
        if (dcAdvisory) consequences.push(dcAdvisory.text);
```

> Place it BEFORE the existing `if (!validatorResult.feasible …) { … consequences.push(…) }` block (line 202) so both notes coexist. `consequences` is returned at line 220.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run doubleCountAdvisoryWiring`
Expected: all cases PASS (plan + propose).

- [ ] **Step 6: Full suite + typecheck + shadow check**

Run: `pnpm exec vitest run` (expect baseline + new tests, all green, 0 unexpected failures).
Run: `pnpm exec tsc -p packages/shared/tsconfig.json --noEmit && pnpm exec tsc -p packages/engine/tsconfig.json --noEmit` (clean).
Run the shadow-check one-liner (prints nothing).

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/agent/tools/proposePlanChange.ts packages/engine/src/agent/tools/confirmPlanChange.ts packages/engine/tests/agent/doubleCountAdvisoryWiring.test.ts
git commit -m "feat(engine): surface double-count advisory on plan-change tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Exit criteria

- New `DoubleCountingConfig` (cap + floor) type + Zod atom; all four configs (CAS/SPS/NYUAD/Shanghai) carry cited `doubleCounting`; the other seven carry none.
- `schoolConfigsAll.test.ts` no longer asserts absence and now pins the four schools' values + the seven absences.
- `buildDoubleCountAdvisory` returns: quantified+cited disclaimer (config present), generic+uncited disclaimer (no config), or null (single program).
- `plan_forward_degree` surfaces the disclaimer in its result + summary; `propose_plan_change` / `confirm_plan_change` surface it in `consequences[]`.
- NO validator axis, NO hard constraint, NO `check_overlap` revival. `feasible` is never affected.
- Full suite green; both `--noEmit` typechecks clean; 0 shadows; scoped commits only.

## Optional follow-ons (NOT in scope — surface to owner)

- **`view_forward_plan`**: re-derive + render the same disclaimer when re-displaying a stored plan (mirror Task 4; requires reading `viewForwardPlan.ts` first).
- **SPS/Shanghai bulletin re-verification**: values are authored from an LLM bulletin sweep (spot-check confidence). A human pass against the live bulletin would upgrade `_meta.verifiedBy`.
- **Edit-tool noise gating**: currently the advisory fires on every multi-program edit; could gate on "the diff touches a course in the shared set" if it proves noisy.

## Self-review notes (done by plan author)

- **Spec coverage:** clear-school enforcement→*data*; vague-school "assume 0 + generic side-note"→generic advisory + solver already 0-shares; cited number→`bulletinSource`/`sourceRef`; plan + edit surfaces→Tasks 4+5. ✓
- **No enforcement:** confirmed no validator/constraint changes; solver untouched. ✓
- **Type consistency:** `DoubleCountingConfig.cap/floor/noTripleCounting/requiresApproval/sourceRef` used identically in type (Task 1), Zod (Task 1), JSON (Task 2), tests (Tasks 1-5), and builder (Task 3). `buildDoubleCountAdvisory(dpr, schoolConfig)` signature identical across Tasks 3/4/5. Disclaimer `id` `"double_count_advisory"` identical across builder + tests. ✓
- **Cite-or-stop:** generic advisory carries NO `bulletinSource` (no invented number); quantified carries the config `sourceRef`. ✓
