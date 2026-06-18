# Workspace Slot-Editor + Action Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a workspace slot-editor with four deterministic, validated actions (add / drop / withdraw / pass-fail) governed by a 3-state per-slot action matrix, enforce per-school Pass/Fail limits as a new 8th validator axis, surface an F-1 full-time-floor warning on withdrawals, delete the now-unmounted sidebar tree, and make visa status a mandatory onboarding choice.

**Architecture:** The 4 actions reuse the EXISTING deterministic propose→preview-as-scenario→confirm pipeline (`proposePlanChange`/`confirmPlanChange` + the what-if path) — no new solver. A pure `slotActionMatrix` module decides which actions a slot allows from its kind + DPR IP-membership + the F3 calendar window + the school's P/F policy; it is enforced BOTH at the engine/route boundary AND used to gate the UI affordance. P/F limits become a real validator axis (the first deliberate extension of the "frozen 7-axis" contract, owner-approved). The withdraw transform gains an F-1-floor advisory. Everything else (the frozen solver/`finalizeForwardSchedule`, R1 = synthetic DPR never written to `parsed_dpr`) is untouched.

**Tech Stack:** TypeScript (strict). `packages/engine` (Zod-validated configs, pure transforms, the 7→8-axis validator, the agent tools). `packages/shared` (the `SchoolConfig`/`PassFailConfig`/`SchedulePreferences`/`ScheduleSlot` types). `apps/web` (Next.js 16 App Router, React 19; the chat page + the `ScheduleView` workspace grid; `/api/plan/*` route handlers). Vitest (+ `@testing-library/react` + jsdom for render tests).

---

## Binding constraints (do NOT violate)

- **R1 guardrail:** a synthetic / what-if DPR is NEVER written to `students.parsed_dpr`; confirming a proposed scenario persists ONLY the `forward_schedule`. The `assertAuthoritativeDpr` guard + its byte-identity test stay green.
- **Frozen solver seam:** `solveForwardSchedule` / `finalizeForwardSchedule` / the search are NOT modified. The validator IS extended (the 8th axis) — this is the one approved frozen-contract change; the design spec (`Docs/specs/2026-06-05-planning-engine-rebuild-design.md`) must be revised to record the new axis (Phase C, last task).
- **No fabricated data / cite-or-hedge:** every P/F limit + every deadline is bulletin-sourced or carries an adviser hedge. A school with no sourced P/F cap defaults to NO limit + the hedge "This program may have a pass/fail limit we don't have on file — confirm with your adviser." Deadlines are TYPICAL per-campus patterns and ALWAYS hedged (never claimed exact).
- **Verify before done:** `cd packages/engine && npx tsc --noEmit`; `cd apps/web && npx tsc --noEmit`; `npx vitest run` (repo root). NEVER `tsc -b`. Stage selectively (never `git add -A`; never `*.pdf` / `.env.local` / `pnpm-lock.yaml`). Commit-message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Branch: create `feat/plan37-slot-editor` off `main` AFTER plan 36 is merged, OR off `feat/plan36-scenarios-ui` if it is not yet merged (confirm with the owner before the first commit).

---

## Cross-cutting design decisions (read before any task)

### D-1. The 3-state model → engine `ScheduleSlot.kind` (already canonical)
| Owner state | Engine `slot.kind` | DPR provenance |
|---|---|---|
| **FINAL** (graded, immutable) | `completed` | a `courseHistory` row with `type` EN/TE + a real letter grade |
| **REGISTERED** (in progress) | `in_progress` | a `courseHistory` row with `type === "IP"` |
| **PLANNED** (agent-planned) | `specific_planned` (bound) or `placeholder` (unbound) | not on the DPR |

### D-2. Allowed actions — ADD is term-level, the other three are per-slot

**ADD is a TERM-level action** (add a NEW course to a term), NOT a per-slot one — so a student WITH registered (IP) courses can still add another course to the current term. It is allowed on:
- a **FUTURE / planned term** → freely (it's a plan).
- the **CURRENT term while it is inside its add/drop window** → allowed + hedged ("typical add/drop deadline for this season; verify — registering a course this late is deadline-gated").
- a current term whose **add/drop window has closed** → NOT allowed (registration for that term is over).
The add course-id is validated against the catalog (Task E3).

**Per-slot actions** (drop / withdraw / pass-fail on an EXISTING course), by state:
| State (`slot.kind`) | drop | withdraw | pass/fail | Notes |
|---|---|---|---|---|
| **FINAL** (`completed`) | ✗ | ✗ | ✗ | immutable — already graded |
| **REGISTERED** (`in_progress`) | window-gated | window-gated | window-gated + school-eligibility | F3 window decides: `future`→change freely · `add_drop`→clean drop (no W) · `withdraw_pf`→withdraw + (P/F where the school allows) · `closed`→none · `unknown`→allowed + hedge |
| **PLANNED** (`specific_planned`/`placeholder`) | ✓ — just removes it from the plan (no deadline; it isn't registered) | ✗ (nothing to withdraw from — drop it) | ✗ (not in progress; you don't pass/fail a plan) | "registering" a planned course in the current term IS the term-level ADD above (deadline-gated); dropping it from the plan is free |

### D-3. Deadlines — reuse `classifyIpChangeability` (no new calendar work)
The F3 classifier (`ipCourseChangeability.ts`) already maps an IP course's term → `future | add_drop | withdraw_pf | closed | unknown` from the per-campus `academicCalendar.ts` (`addDropMonthDay` / `withdrawMonthDay`; P/F election shares the withdraw window). The matrix consumes that window. Deadlines are PER-CAMPUS (ny / shanghai / abudhabi); the NY default's withdraw date (≈ week 14) over-states the window for the week-9 schools (Steinhardt/LS/Nursing/GPH/SPS) — the owner chose NOT to add a per-school overlay, so we KEEP the per-campus model and ALWAYS carry the hedge ("typical NYU deadline for this season; the exact date shifts each year and can be earlier for your school — verify with your adviser/registrar"). For a PLANNED slot in the current term, the same campus/season window gates add/drop (hedged).

### D-4. P/F limits — config field + the enforcement tiers
Add `careerLimitValue: number | null` to `PassFailConfig`. Per-school values (bulletin-sourced; see Task A2). The 8th validator axis (`passFailLimitsRespected`) enforces in tiers:
- **`careerLimitType: "credits"` with a sourced `careerLimitValue`** (CAS 32, Tisch 32, LS 16, SPS 16) → HARD: career P/F credits (DPR-used + plan-elected) > value ⇒ `fail`.
- **`careerLimitType: "courses"` with a sourced value** (Stern 4, Gallatin 4, NYUAD 3) → HARD: count of P/F courses > value ⇒ `fail`.
- **per-term limit** (`perTermLimit` over `perTermUnit` semester/academic_year) → HARD on the elections WE can see (our P/F elections in a term/year); HEDGED for any existing per-term P/F the DPR doesn't expose (the DPR carries only the career total).
- **`careerLimitType: "percent_of_program"`** (Steinhardt 25%, Nursing 25%) → SOFT: `requires-approval` (authority `advisor`) with the note that "25% of program" is unit-ambiguous (courses vs credits) — never a hard `fail`.
- **`careerLimitValue: null`** (Shanghai, anything unsourced) → `assumed-pass` + the "may have a limit we don't have on file — confirm with your adviser" hedge. NEVER blocks.
- **`canElect: false`** (Tandon) → the pass/fail ACTION is disabled for that school entirely (the matrix forbids it before the axis is reached).
Axis is **pass-by-default**: with zero P/F elections and/or `careerLimitValue: null`, it returns `pass`/`assumed-pass`, so existing all-axes-pass fixtures are unaffected.

### D-5. P/F election representation (net-new — the planner doesn't track P/F today)
A pass/fail action only ever targets a REGISTERED (IP) course (per D-2), so it flows through the EXISTING what-if path (`applyPassFailToDpr` on an IP row → synthetic DPR → re-solve). To make the career cap engage, `applyPassFailToDpr` (pass outcome) will INCREMENT the synthetic DPR's `cumulative.passFailUsedUnits` by the course credits (resolving the plan-35 deferral). The 8th axis reads `dpr.cumulative.passFailUsedUnits` (now reflecting the election) vs `careerLimitValue`. For the COURSE-type schools the axis counts P/F `courseHistory` rows (grade `"P"`) instead of units. GPA-of-a-fail stays unquantified (out of scope). No change to the frozen `ScheduleSlot` type is required.

### D-6. F-1 withdraw warning (owner decision: advisory only, no count cap)
When a withdraw what-if drops the CURRENT term below the F-1 full-time floor (`SchoolConfig.f1FullTimeMinCredits ?? 12`) for an F-1 student (and the term is not a registrar-approved final-term exception), `solveWhatIfAssumption` appends a STRONG advisory hedge: "Withdrawing here drops you to N credits — below the 12-credit F-1 full-time floor. This can forfeit your F-1 status unless OGS approves a Reduced Course Load FIRST. Talk to OGS before you withdraw." This is a hedge string, NOT a hard block (the owner chose advisory). No W-count cap (none exists in the bulletin).

### D-7. The IP-membership guard (close the silent no-op)
`proposeWhatIfAssumptionTool.validateInput` will REJECT a withdraw/pass-fail whose target `courseId` is not an `IP` row in the authoritative DPR ("Withdraw / pass-fail applies only to a course you're currently taking (in progress). <course> is <completed / planned> — to remove a planned course, drop it instead."). This makes D-2's "PLANNED → no withdraw/PF" a real engine guard, not a dormant UI gate.

### D-8. The confirm UX for slot-editor actions = the workspace Confirm BUTTON (not a typed "yes")
A slot-editor action is **propose-only** — it NEVER writes the DB by itself. Clicking an action runs the deterministic propose round-trip (`/api/plan/{add,drop}` → `handlePlanActionResult`, or `/api/plan/whatif` → `handleWhatIfResult`), which stages a `pendingMutationId` and surfaces the result as a **proposed scenario** in the workspace (a preview tab + a chat ScheduleCard). The DB commit happens ONLY when the student clicks the existing **"Confirm — make this My Plan"** button on that proposed scenario (`ScheduleWorkspace.tsx` proposed-scenario body → `onConfirmProposed` → `handleWorkspaceConfirm` → `applyReviewConfirm(planStore, planConfirm, pendingMutationId)` → `POST /api/plan/confirm` → persist `forward_schedule` + `confirmProposed`). The editor adds NO new confirm surface and NO new persistence path — it reuses plan 36's commit chokepoint. The slot-editor flow is therefore: **click action → validated proposed scenario (DB untouched) → click "Confirm — make this My Plan" (the only thing that writes the DB).** It must NOT expect or require a typed "yes" (the chat-typed confirm via the agent's `confirm_plan_change` remains available for chat-driven changes, but the editor's own actions land on the button). On the invalid path, the proposed scenario shows red with Confirm-anyway → `force:true` (→ `student-preferred-invalid-draft`), exactly as chat-driven changes do today. R1 holds throughout (only `forward_schedule` persists; `parsed_dpr` untouched).

---

## File structure

**Created**
- `packages/engine/src/agent/forwardSchedule/slotActionMatrix.ts` — pure: `(slot, term, dpr, campus, calendar, passFailConfig, now) → SlotActionMatrix`.
- `packages/engine/src/agent/forwardSchedule/passFailLimitAxis.ts` — pure: `checkPassFailLimits(plan, dpr, passFailConfig) → ValidationResult`.
- `apps/web/app/chat/workspace/SlotActionPopover.tsx` — the workspace slot popover (4 actions, matrix-gated).
- `apps/web/app/chat/workspace/slotActionView.ts` — pure client mapper: matrix → button enabled/disabled + tooltip/hedge.
- `apps/web/lib/courseExists.ts` — pure: validate an add's courseId against the bundled catalog.
- Test files alongside each (paths given per task).

**Modified**
- `packages/shared/src/types.ts` — `PassFailConfig.careerLimitValue`; `ValidatorAxis` += `passFailLimitsRespected`.
- `packages/engine/src/provenance/configSchema.ts` — `careerLimitValue` in `passFailConfigSchema`.
- `data/schools/{cas,tisch,tandon,stern,steinhardt,gallatin,liberal_studies,sps,nursing,shanghai,nyuad}.json` — add `careerLimitValue` + a `careerLimitSourceRef`/note.
- `packages/engine/src/agent/forwardSchedule/passFailTransform.ts` — increment `passFailUsedUnits` on pass.
- `packages/engine/src/agent/forwardSchedule/whatIfAssumption.ts` — F-1 floor advisory.
- `packages/engine/src/agent/tools/proposeWhatIfAssumption.ts` — the IP-membership guard.
- `packages/engine/src/agent/forwardSchedule/graduationPathValidator.ts` — wire the 8th axis.
- `packages/engine/src/agent/forwardSchedule/build.ts` (`finalizeForwardSchedule` caller) + `proposePlanChange.ts` + `confirmPlanChange.ts` — thread `passFailConfig` into the validator args.
- `apps/web/app/chat/workspace/ScheduleView.tsx` — mount the popover (gated on `!readOnly`).
- `apps/web/app/chat/page.tsx` — pass the slot-action handlers + the DPR/campus/config into `ScheduleView`.
- `apps/web/app/api/plan/add/route.ts` — course-existence validation.
- `apps/web/app/chat/wizard/OnboardingWizard.tsx` + `apps/web/lib/wizard/wizardMachine.ts` — visa mandatory.
- Sidebar deletion (Phase G) — relocations + deletions enumerated there.
- `Docs/specs/2026-06-05-planning-engine-rebuild-design.md` + `Docs/current-system/engine/*` — the 8th axis + the matrix.

---

# PART 1 — The slot-editor feature (Phases A–F)

## Phase A — Per-school P/F limit config

### Task A1: Add `careerLimitValue` to the type + Zod schema

**Files:**
- Modify: `packages/shared/src/types.ts:253` (`PassFailConfig`)
- Modify: `packages/engine/src/provenance/configSchema.ts:65` (`passFailConfigSchema`)
- Test: `packages/engine/tests/provenance/passFailConfigSchema.test.ts` (create)

- [ ] **Step 1 — failing test** (`passFailConfigSchema.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { passFailConfigSchema } from "../../src/provenance/configSchema.js";

describe("passFailConfigSchema — careerLimitValue", () => {
    it("accepts a numeric career-limit value", () => {
        const r = passFailConfigSchema.safeParse({ careerLimitType: "credits", careerLimitValue: 32 });
        expect(r.success).toBe(true);
    });
    it("accepts null (no sourced cap → hedge)", () => {
        const r = passFailConfigSchema.safeParse({ careerLimitType: "credits", careerLimitValue: null });
        expect(r.success).toBe(true);
    });
    it("accepts the field being absent (back-compat)", () => {
        const r = passFailConfigSchema.safeParse({ careerLimitType: "credits" });
        expect(r.success).toBe(true);
    });
    it("rejects a non-number, non-null value", () => {
        const r = passFailConfigSchema.safeParse({ careerLimitType: "credits", careerLimitValue: "32" });
        expect(r.success).toBe(false);
    });
});
```

- [ ] **Step 2 — run, expect FAIL** (`careerLimitValue` not in schema): `npx vitest run packages/engine/tests/provenance/passFailConfigSchema.test.ts`

- [ ] **Step 3 — implement.** In `types.ts` add to `PassFailConfig` (right after `careerLimitType`):

```ts
    /** The numeric career P/F cap, in the unit named by `careerLimitType`
     *  (credits | courses | percent). `null` = no cap on file for this
     *  school → the engine hedges ("may have a limit — confirm with your
     *  adviser") and never blocks. Bulletin-sourced; see careerLimitSourceRef. */
    careerLimitValue?: number | null;
    /** Bulletin path/quote backing `careerLimitValue` (provenance; "" when null). */
    careerLimitSourceRef?: string;
```

In `configSchema.ts` `passFailConfigSchema` (after `careerLimitType`):

```ts
    careerLimitValue: z.number().nullable().optional(),
    careerLimitSourceRef: z.string().optional(),
```

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `git add packages/shared/src/types.ts packages/engine/src/provenance/configSchema.ts packages/engine/tests/provenance/passFailConfigSchema.test.ts` then `git commit -m "feat(engine): add PassFailConfig.careerLimitValue (per-school P/F cap; null=hedge)"`.

### Task A2: Populate `careerLimitValue` for all 11 schools from the bulletin

**Files:** Modify each `data/schools/<id>.json` `passFail` block. Test: `packages/engine/tests/data/passFailCareerValues.test.ts` (create).

Bulletin-sourced values (from the deep audit; the source path is for the `careerLimitSourceRef`):

| File | `careerLimitType` | `careerLimitValue` | `careerLimitSourceRef` |
|---|---|---|---|
| `cas.json` | credits | `32` | `bulletin-raw/undergraduate/arts-science/academic-policies/_index.md:410` |
| `tisch.json` | credits | `32` | `bulletin-raw/undergraduate/arts/academic-policies/_index.md:438` |
| `liberal_studies.json` | credits | `16` | `bulletin-raw/undergraduate/liberal-studies/academic-policies/_index.md:205` |
| `sps.json` | credits | `16` | `bulletin-raw/undergraduate/professional-studies/academic-policies/_index.md` (16-credit cap) |
| `stern.json` | courses | `4` | `bulletin-raw/undergraduate/business/academic-policies/_index.md:398` |
| `gallatin.json` | courses | `4` | `bulletin-raw/undergraduate/individualized-study/academic-policies/_index.md:60` |
| `nyuad.json` | courses | `3` | `bulletin-raw/.../abu-dhabi academic-policies` (3-course career) |
| `steinhardt.json` | percent_of_program | `25` | `bulletin-raw/undergraduate/culture-education-human-development/academic-policies/_index.md` (25% of program) |
| `nursing.json` | percent_of_program | `25` | `bulletin-raw/.../nursing academic-policies` (25% of program) |
| `tandon.json` | credits | `null` | `bulletin-raw/undergraduate/engineering/academic-policies/_index.md:218` — no cap; `canElect:false` (cannot elect P/F) |
| `shanghai.json` | credits | `null` | no published career cap on file → hedge |

- [ ] **Step 1 — failing test** (`passFailCareerValues.test.ts`):

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "../../../../data/schools"); // adjust to repo root /data/schools
function pf(id: string) { return JSON.parse(readFileSync(join(DIR, `${id}.json`), "utf8")).passFail; }

describe("per-school P/F career-limit values (bulletin-sourced)", () => {
    it.each([
        ["cas", 32], ["tisch", 32], ["liberal_studies", 16], ["sps", 16],
        ["stern", 4], ["gallatin", 4], ["nyuad", 3],
        ["steinhardt", 25], ["nursing", 25],
    ])("%s has careerLimitValue %i", (id, v) => {
        expect(pf(id).careerLimitValue).toBe(v);
        expect(typeof pf(id).careerLimitSourceRef).toBe("string");
    });
    it.each([["tandon"], ["shanghai"]])("%s has null careerLimitValue (no sourced cap → hedge)", (id) => {
        expect(pf(id).careerLimitValue).toBeNull();
    });
    it("tandon cannot elect P/F", () => { expect(pf("tandon").canElect).toBe(false); });
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `"careerLimitValue": <value>` and `"careerLimitSourceRef": "<path>"` to each school's `passFail` block per the table (use `null` for tandon + shanghai). Do NOT touch any other field.
- [ ] **Step 4 — run, expect PASS;** also `npx vitest run packages/engine` to confirm `validateSchoolConfigBody` still loads every config (the schema now allows the field).
- [ ] **Step 5 — commit:** stage the 11 JSON files + the test; `git commit -m "data(schools): bulletin-sourced P/F careerLimitValue for all 11 schools (null=hedge)"`.

---

## Phase B — The P/F election increments the synthetic DPR

### Task B1: `applyPassFailToDpr` (pass) increments `passFailUsedUnits`

**Files:** Modify `packages/engine/src/agent/forwardSchedule/passFailTransform.ts:226`. Test: extend `packages/engine/tests/agent/passFailTransform.test.ts`.

- [ ] **Step 1 — failing test** (append):

```ts
it("a PASS election increments cumulative.passFailUsedUnits by the course credits", () => {
    const dpr = makeDprWithIpCourse("CSCI-UA 101", 4, /*usedUnits*/ 8); // helper: IP row + cumulative.passFailUsedUnits=8
    const { dpr: next } = applyPassFailToDpr(dpr, "CSCI-UA 101", "pass", "cas");
    expect(next.cumulative.passFailUsedUnits).toBe(12); // 8 + 4
    expect(dpr.cumulative.passFailUsedUnits).toBe(8);   // input untouched (purity)
});
it("a FAIL election does NOT increment passFailUsedUnits (no credit earned)", () => {
    const dpr = makeDprWithIpCourse("CSCI-UA 101", 4, 8);
    const { dpr: next } = applyPassFailToDpr(dpr, "CSCI-UA 101", "fail", "cas");
    expect(next.cumulative.passFailUsedUnits).toBe(8);
});
```

(If `makeDprWithIpCourse` doesn't exist, add it to the test's local fixtures: build a `DegreeProgressReport` with one `courseHistory` row `{ ...id, type:"IP", credits }` and `cumulative.passFailUsedUnits = usedUnits`, `passFailCapUnits = 32`.)

- [ ] **Step 2 — run, expect FAIL** (`passFailUsedUnits` stays 8).
- [ ] **Step 3 — implement** in `applyPassFailToDpr`, inside the `pass` branch, after grade is set to `"P"` and BEFORE returning. Read the elected course's credits from the matched `courseHistory` row; guard for null `passFailUsedUnits`:

```ts
    // D-5: a P/F PASS election consumes career P/F budget. Increment the
    // synthetic DPR's used-units so the career-cap axis (passFailLimitAxis)
    // and the materializePlan cap check engage. FAIL earns no credit → no
    // increment. cumulative is on the cloned (what_if) DPR — never the input.
    if (outcome === "pass") {
        const electedCredits = next.courseHistory.find((r) => rowKey(r) === canonicalizeCourseId(courseId))?.credits ?? 0;
        next.cumulative.passFailUsedUnits = (next.cumulative.passFailUsedUnits ?? 0) + electedCredits;
    }
```

(Import `canonicalizeCourseId` from `../../courseId.js` and reuse the file's existing `rowKey` helper; `next` is the already-cloned `what_if` DPR.)

- [ ] **Step 4 — run, expect PASS.** Then `npx vitest run` (full) — confirm no R1/byte-identity regression (the input DPR is untouched; only the synthetic clone changes).
- [ ] **Step 5 — commit.**

---

## Phase C — The 8th validator axis (`passFailLimitsRespected`)

### Task C1: The pure axis function

**Files:** Create `packages/engine/src/agent/forwardSchedule/passFailLimitAxis.ts`. Test: `packages/engine/tests/agent/passFailLimitAxis.test.ts` (create).

The axis counts career P/F usage from the (possibly synthetic) DPR and compares against the school's cap per D-4.

- [ ] **Step 1 — failing test:**

```ts
import { describe, it, expect } from "vitest";
import { checkPassFailLimits } from "../../src/agent/forwardSchedule/passFailLimitAxis.js";
import type { PassFailConfig } from "@nyupath/shared";

const credits32: PassFailConfig = { careerLimitType: "credits", careerLimitValue: 32 };
const courses4: PassFailConfig  = { careerLimitType: "courses", careerLimitValue: 4 };
const pct25: PassFailConfig     = { careerLimitType: "percent_of_program", careerLimitValue: 25 };
const noCap: PassFailConfig     = { careerLimitType: "credits", careerLimitValue: null };

function dprWithPf(usedUnits: number, pCourses = 0) {
    return {
        cumulative: { passFailUsedUnits: usedUnits, passFailCapUnits: 32, creditsRequired: 128 },
        courseHistory: Array.from({ length: pCourses }, (_, i) => ({ subject: "X", number: `${i}`, grade: "P", type: "EN", credits: 4 })),
    } as any;
}

describe("checkPassFailLimits (8th axis)", () => {
    it("credits cap not exceeded → pass", () => {
        expect(checkPassFailLimits(dprWithPf(28), credits32).status).toBe("pass");
    });
    it("credits cap exceeded → fail", () => {
        const r = checkPassFailLimits(dprWithPf(36), credits32);
        expect(r.status).toBe("fail");
        expect((r as any).reason).toMatch(/32/);
    });
    it("courses cap exceeded (5 P rows > 4) → fail", () => {
        expect(checkPassFailLimits(dprWithPf(0, 5), courses4).status).toBe("fail");
    });
    it("courses cap not exceeded (3 P rows ≤ 4) → pass", () => {
        expect(checkPassFailLimits(dprWithPf(0, 3), courses4).status).toBe("pass");
    });
    it("percent_of_program → requires-approval (unit-ambiguous, never hard fail)", () => {
        expect(checkPassFailLimits(dprWithPf(40), pct25).status).toBe("requires-approval");
    });
    it("null cap → assumed-pass + hedge (never blocks)", () => {
        const r = checkPassFailLimits(dprWithPf(40), noCap);
        expect(r.status).toBe("assumed-pass");
    });
    it("no passFail config → pass (axis is opt-in)", () => {
        expect(checkPassFailLimits(dprWithPf(40), undefined).status).toBe("pass");
    });
});
```

- [ ] **Step 2 — run, expect FAIL** (module missing).
- [ ] **Step 3 — implement** `passFailLimitAxis.ts`:

```ts
import type { ValidationResult, PassFailConfig } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../dpr/schema.js";

/** Count P/F-graded courses on the DPR (grade "P"). */
function countPassFailCourses(dpr: DegreeProgressReport): number {
    return dpr.courseHistory.filter((r) => r.grade === "P").length;
}

/**
 * 8th validator axis — per-school career P/F limit (D-4). Pass-by-default:
 * undefined config or null careerLimitValue never blocks. credits/courses
 * caps are HARD (fail); percent_of_program is SOFT (requires-approval —
 * "25% of program" is unit-ambiguous); null is assumed-pass + hedge.
 */
export function checkPassFailLimits(
    dpr: DegreeProgressReport,
    passFail: PassFailConfig | undefined,
): ValidationResult {
    if (!passFail || passFail.careerLimitValue == null) {
        // No sourced cap → never block; hedge only when the school COULD have one.
        return passFail && passFail.canElect !== false
            ? { status: "assumed-pass", assumption: "This program may have a pass/fail limit we don't have on file.", whatWouldFlipIt: "A published per-program P/F cap, confirmed with your adviser." }
            : { status: "pass", verifiedFrom: "bulletin" };
    }
    const cap = passFail.careerLimitValue;
    if (passFail.careerLimitType === "credits") {
        const used = dpr.cumulative.passFailUsedUnits ?? 0;
        return used > cap
            ? { status: "fail", reason: `Pass/Fail credits used (${used}) exceed your school's ${cap}-credit career limit.` }
            : { status: "pass", verifiedFrom: "bulletin" };
    }
    if (passFail.careerLimitType === "courses") {
        const used = countPassFailCourses(dpr);
        return used > cap
            ? { status: "fail", reason: `Pass/Fail courses used (${used}) exceed your school's ${cap}-course career limit.` }
            : { status: "pass", verifiedFrom: "bulletin" };
    }
    // percent_of_program — unit-ambiguous (courses vs credits); never a hard fail.
    return { status: "requires-approval", authority: "advisor" };
}
```

- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit.**

### Task C2: Wire the axis into the validator + thread the config

**Files:** Modify `packages/shared/src/types.ts` (`ValidatorAxis`); `packages/engine/src/agent/forwardSchedule/graduationPathValidator.ts` (`GraduationPathValidatorArgs` + assembly); the 3 callers (`build.ts`, `proposePlanChange.ts:173`, `confirmPlanChange.ts:192`). Test: extend `packages/engine/tests/agent/graduationPathValidator.test.ts`.

- [ ] **Step 1 — failing test** (append): construct a plan + a synthetic DPR with `passFailUsedUnits: 36` and pass `passFailConfig: { careerLimitType:"credits", careerLimitValue:32 }`; assert `runGraduationPathValidator(...).axisResults.passFailLimitsRespected.status === "fail"` and `.feasible === false`. Also assert that omitting `passFailConfig` yields `passFailLimitsRespected.status === "pass"` and does not change `feasible` for an otherwise-valid plan.

- [ ] **Step 2 — run, expect FAIL** (`passFailLimitsRespected` not a key).
- [ ] **Step 3 — implement.**
  - `types.ts` — add `| "passFailLimitsRespected"` to `ValidatorAxis` (note: `ValidatorAxis` is re-declared in `graduationPathValidator.ts:39` too — update BOTH, or have the engine import the shared one; pick whichever the file already does and keep them identical).
  - `graduationPathValidator.ts` — add `passFailConfig?: PassFailConfig` to `GraduationPathValidatorArgs.programRules` (or as a sibling field; sibling is cleaner). In the `axisResults` object (L600-608) add: `passFailLimitsRespected: checkPassFailLimits(dpr, args.passFailConfig)`. Import `checkPassFailLimits`. `feasible` needs no change (it already does `Object.values(...).some(status==="fail")`).
  - The 3 callers: thread the loaded `SchoolConfig.passFail` through. `finalizeForwardSchedule` already has the DPR + the solver input (which has the home school → load the config via the existing `schoolConfigLoader`); pass `passFailConfig: schoolConfig?.passFail`. In `proposePlanChange.ts:173` + `confirmPlanChange.ts:192`, the session already resolves the school config — pass its `.passFail`.
- [ ] **Step 4 — run the new test + `npx vitest run` (full).** Existing all-axes-pass fixtures must stay green (the axis is pass-by-default when `passFailConfig` is absent — confirm none of the fixtures pass a config that trips it; if a fixture now constructs a config, make its DPR under-cap).
- [ ] **Step 5 — commit.**

### Task C3: Revise the design spec + the engine current-system doc (philosophy #6)

**Files:** Modify `Docs/specs/2026-06-05-planning-engine-rebuild-design.md`; `Docs/current-system/engine/*` (the validator doc). No code/test.

- [ ] **Step 1** — In the design spec, find the "7 axes" / Decision #41 section and add the 8th axis (`passFailLimitsRespected`) with its tiered semantics (D-4) + a note that this is the first deliberate extension of the frozen validator and why (owner-approved). Update any "7 axes" prose to "8 axes". Update the matching `Docs/current-system/engine/` validator doc + its "Last verified" header to today.
- [ ] **Step 2 — commit** (docs only).

---

## Phase D — The slot-action matrix (pure)

### Task D1: `slotActionMatrix.ts`

**Files:** Create `packages/engine/src/agent/forwardSchedule/slotActionMatrix.ts`. Test: `packages/engine/tests/agent/slotActionMatrix.test.ts` (create).

- [ ] **Step 1 — failing test** (representative cases — write all of these):

```ts
import { describe, it, expect } from "vitest";
import { slotActionMatrix } from "../../src/agent/forwardSchedule/slotActionMatrix.js";
import { NYU_ACADEMIC_CALENDAR } from "../../src/dpr/academicCalendar.js";

const cas = { careerLimitType: "credits", careerLimitValue: 32, canElect: true } as any;
const tandon = { careerLimitType: "credits", careerLimitValue: null, canElect: false } as any;

function ipDpr(courseId: string) {
    return { courseHistory: [{ subject: courseId.split(" ")[0], number: courseId.split(" ")[1], type: "IP", grade: "IP", credits: 4 }] } as any;
}

describe("slotActionMatrix (3-state × window)", () => {
    it("FINAL (completed) → all actions forbidden", () => {
        const m = slotActionMatrix({ slot: { kind: "completed", courseId: "X" } as any, term: "2025-fall", dpr: {} as any, campus: "ny", calendar: NYU_ACADEMIC_CALENDAR, passFail: cas });
        expect(m.allowed).toEqual({ add: false, drop: false, withdraw: false, passFail: false });
    });
    it("PLANNED (specific_planned, future term) → drop only", () => {
        const m = slotActionMatrix({ slot: { kind: "specific_planned", courseId: "MATH-UA 121" } as any, term: "2027-fall", dpr: {} as any, campus: "ny", calendar: NYU_ACADEMIC_CALENDAR, passFail: cas, now: new Date("2026-09-01T00:00:00Z") });
        expect(m.allowed.drop).toBe(true);
        expect(m.allowed.withdraw).toBe(false);
        expect(m.allowed.passFail).toBe(false);
    });
    it("REGISTERED (in_progress, current term, in withdraw window) → withdraw + passFail allowed", () => {
        // pick a `now` inside the NY fall withdraw_pf window (after 09-15, before 11-26)
        const m = slotActionMatrix({ slot: { kind: "in_progress", courseId: "CSCI-UA 101" } as any, term: "2026-fall", dpr: ipDpr("CSCI-UA 101"), campus: "ny", calendar: NYU_ACADEMIC_CALENDAR, passFail: cas, now: new Date("2026-10-15T00:00:00Z") });
        expect(m.allowed.withdraw).toBe(true);
        expect(m.allowed.passFail).toBe(true);
        expect(m.perAction.withdraw.hedge).toBeTruthy();
    });
    it("REGISTERED, past withdraw deadline (closed) → no actions", () => {
        const m = slotActionMatrix({ slot: { kind: "in_progress", courseId: "CSCI-UA 101" } as any, term: "2026-fall", dpr: ipDpr("CSCI-UA 101"), campus: "ny", calendar: NYU_ACADEMIC_CALENDAR, passFail: cas, now: new Date("2026-12-20T00:00:00Z") });
        expect(m.allowed.withdraw).toBe(false);
        expect(m.allowed.passFail).toBe(false);
    });
    it("REGISTERED at a school that can't elect P/F (Tandon) → passFail forbidden even in window", () => {
        const m = slotActionMatrix({ slot: { kind: "in_progress", courseId: "CSCI-UA 101" } as any, term: "2026-fall", dpr: ipDpr("CSCI-UA 101"), campus: "ny", calendar: NYU_ACADEMIC_CALENDAR, passFail: tandon, now: new Date("2026-10-15T00:00:00Z") });
        expect(m.allowed.passFail).toBe(false);
        expect(m.perAction.passFail.reason).toMatch(/can't elect|cannot elect/i);
    });
});
```

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** `slotActionMatrix.ts`:

```ts
import type { ScheduleSlot, PassFailConfig } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import { classifyIpChangeability } from "../../dpr/ipCourseChangeability.js";
import type { Campus, AcademicCalendar } from "../../dpr/academicCalendar.js";
import { buildTemporalContext } from "../../dpr/temporalContext.js"; // existing helper that yields DprTemporalContext

export interface SlotActionMatrixArgs {
    slot: ScheduleSlot;
    term: string;
    dpr: DegreeProgressReport;
    campus: Campus;
    calendar: AcademicCalendar;
    passFail?: PassFailConfig;
    now?: Date;
}
export type SlotAction = "add" | "drop" | "withdraw" | "passFail";
export interface SlotActionDecision { reason?: string; hedge?: string; }
export interface SlotActionMatrix {
    state: "final" | "registered" | "planned";
    allowed: Record<SlotAction, boolean>;
    perAction: Record<SlotAction, SlotActionDecision>;
}

function isIpRow(dpr: DegreeProgressReport, slot: ScheduleSlot): boolean {
    const id = (slot as { courseId?: string }).courseId;
    if (!id) return false;
    return dpr.courseHistory.some((r) => `${r.subject} ${r.number}`.trim() === id && r.type === "IP");
}

export function slotActionMatrix(args: SlotActionMatrixArgs): SlotActionMatrix {
    const { slot, term, dpr, campus, calendar, passFail, now } = args;
    const deny = (reason: string): SlotActionMatrix => ({
        state: "final",
        allowed: { add: false, drop: false, withdraw: false, passFail: false },
        perAction: { add: { reason }, drop: { reason }, withdraw: { reason }, passFail: { reason } },
    });

    // FINAL — graded, immutable.
    if (slot.kind === "completed") return deny("This course is finished and graded — it can't be changed.");

    // REGISTERED — an in-progress (IP) course. Window-gated by F3.
    if (slot.kind === "in_progress") {
        const ip = classifyIpChangeability({ ipTerm: term, temporalContext: buildTemporalContext(dpr), campus, calendar, now });
        const inWithdrawPf = ip.window === "withdraw_pf" || ip.window === "unknown" || ip.window === "future";
        const inAddDrop = ip.window === "add_drop" || ip.window === "future";
        const canPf = inWithdrawPf && passFail?.canElect !== false;
        return {
            state: "registered",
            allowed: {
                add: false,
                drop: inAddDrop || inWithdrawPf, // drop pre-deadline; after add/drop a "drop" IS a withdraw
                withdraw: inWithdrawPf,
                passFail: canPf,
            },
            perAction: {
                add: { reason: "This course is already on your registration." },
                drop: { hedge: ip.hedge },
                withdraw: ip.window === "closed" ? { reason: "The withdrawal deadline has passed for this term (typical — verify with your registrar)." } : { hedge: ip.hedge },
                passFail: passFail?.canElect === false
                    ? { reason: "Your school doesn't let you elect pass/fail — only courses already graded pass/fail count." }
                    : ip.window === "closed" ? { reason: "The pass/fail election deadline has passed (typical — verify)." }
                    : { hedge: ip.hedge },
            },
        };
    }

    // PLANNED — specific_planned or placeholder (not on the DPR). Drop freely;
    // never withdraw/pass-fail (it isn't in progress — just drop it).
    return {
        state: "planned",
        allowed: { add: false, drop: true, withdraw: false, passFail: false },
        perAction: {
            add: { reason: "Use “add a course” on the term to add a new course." },
            drop: { hedge: "This is a planned course — dropping it just removes it from your plan." },
            withdraw: { reason: "There's nothing to withdraw from yet — this course is only planned. Drop it instead." },
            passFail: { reason: "You can only elect pass/fail once a course is in progress." },
        },
    };
}
```

(If `buildTemporalContext` is not the exact existing export name, use whatever `whatIfAssumption.ts` / `ipWindowCaveat` use to obtain a `DprTemporalContext` from a DPR — grep `temporalContext` for the real factory and reuse it.)

- [ ] **Step 4 — run, expect PASS** (add a couple more cases for `placeholder` and `add_drop`-window drop).
- [ ] **Step 5 — commit.**

---

## Phase E — Engine/route enforcement

### Task E1: IP-membership guard on withdraw/pass-fail (D-7)

**Files:** Modify `packages/engine/src/agent/tools/proposeWhatIfAssumption.ts` (`validateInput`). Test: extend `packages/engine/tests/agent/proposeWhatIfAssumption.test.ts`.

- [ ] **Step 1 — failing test:** a session whose DPR has `CSCI-UA 101` as a `completed` (graded) row → `proposeWhatIfAssumptionTool.validateInput({ courseId:"CSCI-UA 101", outcome:"withdraw" }, ctx)` returns `{ ok:false }` with a userMessage matching `/in progress|currently taking/i`. A second test: an `IP` row → `{ ok:true }`. A third: a not-on-DPR (planned) course → `{ ok:false }` matching `/planned|drop it instead/i`.

- [ ] **Step 2 — run, expect FAIL** (currently always ok with a DPR).
- [ ] **Step 3 — implement** in `validateInput`, after the existing DPR-presence check:

```ts
    const id = canonicalizeCourseId(input.courseId);
    const row = session.degreeProgressReport.courseHistory.find((r) => canonicalizeCourseId(`${r.subject} ${r.number}`) === id);
    if (!row) {
        return { ok: false, userMessage: `${input.courseId} isn't a course you're currently taking — it looks planned, not in progress. To remove a planned course, drop it instead.` };
    }
    if (row.type !== "IP") {
        return { ok: false, userMessage: `Withdraw and pass/fail apply only to a course you're currently taking (in progress). ${input.courseId} is already completed.` };
    }
```

(Import `canonicalizeCourseId` from `../../courseId.js`.)

- [ ] **Step 4 — run, expect PASS** + `npx vitest run` (no regression: existing what-if tests must target IP rows; fix any fixture that targeted a non-IP course to use an IP row, since that path is now correctly rejected).
- [ ] **Step 5 — commit.**

### Task E2: F-1 floor advisory on withdraw (D-6)

**Files:** Modify `packages/engine/src/agent/forwardSchedule/whatIfAssumption.ts` (`solveWhatIfAssumption`, withdraw branch). Test: extend `packages/engine/tests/agent/whatIfAssumption.test.ts`.

- [ ] **Step 1 — failing test:** an F-1 student (session profile `visaStatus:"f1"`) with a current term at exactly 12 credits including a 4-credit IP course → `solveWhatIfAssumption(session, plan, { courseId, outcome:"withdraw" })` returns `hedges` containing a string matching `/F-1|12-credit|Reduced Course Load|OGS/`. A domestic student → no such hedge.

- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** in the withdraw branch, after the synthetic DPR is built and the term credits are known, compute the post-withdraw term credits for the course's term; if the student is F-1 and the post-withdraw credits `< (schoolConfig.f1FullTimeMinCredits ?? 12)` and it's not a registrar-approved final-term exception, push:

```ts
    hedges.push(
        `Heads up: withdrawing from ${input.courseId} drops that term to ${postCredits} credits — below the ${floor}-credit F-1 full-time floor. ` +
        `This can forfeit your F-1 status unless OGS approves a Reduced Course Load BEFORE you withdraw. Talk to OGS first.`,
    );
```

Read `visaStatus` from `session.student?.visaStatus` / the profile the file already reads; read `floor` from the loaded school config's `f1FullTimeMinCredits` (default 12). Compute `postCredits` from the plan's term for `input.courseId` minus the course credits (or recompute from the synthetic plan's term `plannedCredits`).

- [ ] **Step 4 — run, expect PASS** + full suite.
- [ ] **Step 5 — commit.**

### Task E3: Add-course existence validation

**Files:** Create `apps/web/lib/courseExists.ts`; modify `apps/web/app/api/plan/add/route.ts`. Tests: `apps/web/tests/courseExists.test.ts` (create) + extend the add-route test if one exists.

- [ ] **Step 1 — failing test** (`courseExists.test.ts`): `courseExists("CSCI-UA 101")` → true for a real catalog id; `courseExists("ZZZZ-UA 9999")` → false; canonicalization (`"CSCI-UA 0101"` matches `"CSCI-UA 101"`).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** `courseExists.ts` using the existing catalog loader (`loadCourses` via `apps/web/lib/loadCatalog.ts`, server-side) + `canonicalizeCourseId` (from `@nyupath/engine/client`); return whether the canonical id is in the catalog set. In `add/route.ts`, before building the pin mutation, call it and return a 422 with `{ message: "I couldn't find <id> in the NYU course catalog — check the course number, or ask me to search by name." }` when absent. (This route is SERVER-side, so it may import the loader directly — not the client entry.)
- [ ] **Step 4 — run, expect PASS** + full suite.
- [ ] **Step 5 — commit.**

> **NOTE (FOSE section pick — explicitly OUT of this plan's v1):** picking a specific SECTION (CRN) when adding to the immediate term requires building the never-built FOSE-backed search route (`/api/v2/search-courses`) + a section picker. That is a sizeable sub-feature; this plan ships **structural add with course-existence validation** only. Adding a section picker is a follow-on plan. The slot-editor "add" affordance (Phase F) therefore offers a validated course-id input, and (for the immediate term) surfaces the existing agent-driven `materialize_sections` path as a chat hand-off rather than an inline picker.

---

## Phase F — The workspace slot-editor UI

### Task F1: `slotActionView.ts` — pure matrix→view mapper

**Files:** Create `apps/web/app/chat/workspace/slotActionView.ts`. Test: `apps/web/tests/slotActionView.test.ts` (create).

- [ ] **Step 1 — failing test:** given a `SlotActionMatrix` with `allowed.withdraw=true, perAction.withdraw.hedge="…"`, `slotActionView(matrix)` returns an array of `{ action, label, enabled, tooltip }` with the withdraw entry `enabled:true, tooltip` = the hedge; a forbidden action returns `enabled:false, tooltip` = the `reason`.
- [ ] **Step 2/3 — implement** a pure function mapping the matrix to `{ action: SlotAction; label: string; enabled: boolean; tooltip?: string }[]` with labels `Add` / `Drop` / `Withdraw` / `Pass/Fail`. Disabled buttons carry the `reason` tooltip; enabled buttons carry the `hedge` (if any).
- [ ] **Step 4 — run PASS. Step 5 — commit.**

### Task F2: `SlotActionPopover.tsx` (presentational)

**Files:** Create `apps/web/app/chat/workspace/SlotActionPopover.tsx`. Test: `apps/web/tests/slotActionPopover.render.test.tsx` (jsdom; create).

- [ ] **Step 1 — failing render test:** renders a button per allowed action; a disabled action renders disabled with its tooltip; clicking `Withdraw` calls `onAction("withdraw")`; clicking `Drop` calls `onAction("drop")`. Props: `{ items: ReturnType<typeof slotActionView>; onAction: (a: SlotAction) => void; onClose: () => void }`.
- [ ] **Step 2/3 — implement** a small popover (NYU-violet, consistent with `ScheduleCard`/§9): a vertical list of buttons from `items`; disabled ones get `disabled` + `title={tooltip}` + a muted style; enabled ones `onClick={() => onAction(item.action)}`; an outside-click / ✕ calls `onClose`. No store reads (presentational).
- [ ] **Step 4 — run PASS. Step 5 — commit.**

### Task F3: Mount the popover in `ScheduleView` (committed tab only)

**Files:** Modify `apps/web/app/chat/workspace/ScheduleView.tsx`; `apps/web/app/chat/page.tsx` (pass the matrix inputs + the action handler). Test: extend `apps/web/tests/scheduleView.render.test.tsx`.

The editor is offered ONLY on the COMMITTED plan (the `committed` scenario), never on a read-only proposed/what-if scenario column. `ScheduleView` already receives `readOnly`; when `readOnly === false` AND an `onSlotAction` prop is provided, a slot click opens the popover.

- [ ] **Step 1 — failing render test:** with `readOnly={false}` + an `onSlotAction` spy + a slot-matrix provider that allows `drop`, clicking an `in_progress` slot opens the popover and clicking `Drop` calls `onSlotAction(slot, "drop")`. With `readOnly={true}`, clicking a slot does nothing (no popover).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** restore a controlled `openPopoverKey` in `ScheduleView` (the H6 removal left the `<li>` non-interactive). When `!readOnly` and `onSlotAction` is provided, the `<li>` gets `onClick` → toggles the popover; render `<SlotActionPopover items={slotActionView(matrixFor(slot, sem.term))} onAction={(a) => onSlotAction(slot, sem.term, a)} onClose={…} />`. `matrixFor` comes from a new prop `slotMatrix: (slot, term) => SlotActionMatrix` (computed in `page.tsx` from the committed DPR + campus + calendar + the school's `passFail`, via the engine's `slotActionMatrix`). In `page.tsx`, build `slotMatrix` + an `onSlotAction(slot, term, action)` that dispatches to the existing handlers: `add`/`drop` → `/api/plan/{add,drop}` → `handlePlanActionResult`; `withdraw`/`passFail` → `/api/plan/whatif` (`outcome`) → `handleWhatIfResult`. **Per D-8, `onSlotAction` is PROPOSE-ONLY: it must call exactly the same handlers a chat-driven change uses, so the result lands as a proposed scenario whose ONLY commit is the workspace "Confirm — make this My Plan" button. `onSlotAction` MUST NOT call `planConfirm` / `/api/plan/confirm` / `confirmProposed` directly, and MUST NOT auto-confirm or inject a typed "yes" — committing stays the student's explicit click on the proposed scenario.** The editor adds NO new persistence path; R1 holds.
- [ ] **Step 4 — run the render test + `npx vitest run`.** The committed `ScheduleView` is rendered with `readOnly={false}` + `onSlotAction` in the workspace's committed body; proposed/what-if columns stay `readOnly`. **Add a test asserting `onSlotAction("drop")` triggers the propose path (a `/api/plan/drop` fetch) and does NOT trigger a confirm (`/api/plan/confirm` is never called by the action itself)** — guarding D-8 so an executor can't accidentally wire a slot action straight to a DB write.
- [ ] **Step 5 — commit.**

### Task F4: The "add a course" term affordance

**Files:** Modify `ScheduleView.tsx` (a per-term "+ Add course" control on the committed plan) + `page.tsx`. Test: extend the render test.

- [ ] **Step 1 — failing render test:** an "+ Add course" control renders per term on the committed plan; entering `CSCI-UA 101` + submit calls `onAddCourse(term, "CSCI-UA 101")`; the control is absent when `readOnly`.
- [ ] **Step 2/3 — implement** a minimal inline input (reusing the §9 styles) that calls `onAddCourse(term, courseId)`. In `page.tsx`, `onAddCourse` → `/api/plan/add` (which now validates existence, Task E3) → `handlePlanActionResult("add", …)`. On a 422 (unknown course) show the route's message as an assistant chat line.
- [ ] **Step 4 — run PASS. Step 5 — commit.**

---

# PART 2 — Sidebar deletion (Phase G)

> Independent of Part 1; can be executed before, after, or in parallel by a separate agent. Per the audit, the `sidebar/` tree is NOT deletable wholesale — relocate the 4 live-dep helpers first.

### Task G1: Relocate the shared helpers out of `sidebar/`

**Files:** Move `apps/web/app/chat/sidebar/{slotRenderHelpers.tsx,slotTier.ts,sidebarFormatters.ts}` → `apps/web/app/chat/shared/` (a new neutral dir, since `sidebarFormatters` has 4 consumers: `ScheduleView`, `SummaryCard`, `lib/planBadges`, `lib/explainQuestion`). Move `apps/web/app/chat/sidebar/SummaryCard.tsx` → `apps/web/app/chat/profile/SummaryCard.tsx` (ProfileRail's dir). Repoint every importer.

- [ ] **Step 1** — `git mv` the 3 helper files into `apps/web/app/chat/shared/` and `SummaryCard.tsx` into `apps/web/app/chat/profile/`. Fix the moved files' relative imports (`../chat.module.css` stays correct from `shared/` since it's one level under `chat/`, same depth as `workspace/`; verify).
- [ ] **Step 2** — repoint importers (grep each symbol): `ScheduleView.tsx` (`renderSlotInner`/`slotGradeText`/`slotTierClassName`/`formatTermLabel`/`slotCredits`), `ProfileRail.tsx` (`SummaryCard`), `apps/web/lib/planBadges*`, `apps/web/lib/explainQuestion*`. Update the moved test imports too.
- [ ] **Step 3** — `cd apps/web && npx tsc --noEmit` clean; `npx vitest run` green (no behavior change — pure relocation).
- [ ] **Step 4 — commit:** `git commit -m "refactor(web): relocate shared slot/format helpers + SummaryCard out of the deprecated sidebar tree"`.

### Task G2: Delete the editing subtree + dead libs + their tests

**Files:** Delete `apps/web/app/chat/scheduleSidebar.tsx`, `apps/web/app/chat/sidebar/{TermCard.tsx,SlotRow.tsx,slotPopover.tsx,AddCourseAffordance.tsx,SectionsView.tsx,PriorCreditsCard.tsx,slotState.ts}`, `apps/web/lib/{whatIfSlotControl.ts,groupCoursesByTerm.ts}`, and their tests (`groupCoursesByTerm.test.ts`, `whatIfSlotControl.test.ts`, `ipSlotChangeability.test.ts`, `slotStates.test.ts`, any `scheduleSidebar*`/`SlotRow*`/`TermCard*` tests). The `sidebar/` dir should be empty afterward — remove it.

- [ ] **Step 1** — grep-confirm NONE of the deletion targets are imported by the LIVE tree (`page.tsx`, `workspace/*`, `ProfileRail.tsx`, `shared/*`, `profile/*`). The audit verified this; re-verify with `grep -rn "scheduleSidebar\|sidebar/SlotRow\|whatIfSlotControl\|groupCoursesByTerm\|sidebar/slotState" apps/web/app apps/web/lib | grep -v "/sidebar/\|\.test\."` → expect no live hits.
- [ ] **Step 2** — `git rm` the files + their tests.
- [ ] **Step 3** — `cd apps/web && npx tsc --noEmit` clean; `cd packages/engine && npx tsc --noEmit` clean; `npx vitest run` green (suite count drops by the deleted tests — note the new count).
- [ ] **Step 4** — revise `Docs/current-system/web/ui-components.md`: remove the "Deprecated / unmounted (scheduleSidebar.tsx)" section (now actually gone); update the "Last verified" header.
- [ ] **Step 5 — commit:** `git commit -m "chore(web): delete the unmounted sidebar editing subtree + dead libs/tests (superseded by the workspace slot-editor)"`.

---

# PART 3 — Visa-mandatory onboarding (Phase H)

> Independent small task. The DPR was made mandatory in `b7ded11`; visa is still defaulted+skippable, so an F-1 student who skips gets a no-12cr-floor plan.

### Task H1: Require an explicit visa choice before "Build my plan"

**Files:** Modify `apps/web/lib/wizard/wizardMachine.ts` (track whether visa was explicitly chosen) + `apps/web/app/chat/wizard/OnboardingWizard.tsx` (gate the path to plan on it). Test: extend `apps/web/tests/mountedWizard.render.test.tsx` + `wizardShell.test.ts`.

The wizard's `visa` defaults to `"domestic"`. We need an EXPLICIT choice. Add a `visaChosen: boolean` to `WizardValues` (default `false`), set `true` when the student touches the visa control on `confirm_profile`/`goals`. Gate BOTH "Skip all" and reaching/confirming "plan" on `visaChosen` (mirror the DPR gate shipped in `b7ded11`): the `confirm_profile` step shows the visa `<select>` with a neutral "— select —" placeholder and is NOT skippable until a real choice is made; "Build my plan" is disabled until `visaChosen`.

- [ ] **Step 1 — failing tests:**
  - `wizardShell.test.ts`: `skipAll` from a state where `visaChosen=false` still lands on `plan`, but a new pure helper `canBuildPlan(state, parsedDpr)` returns `false` when `!visaChosen` (and `true` once visa is chosen + DPR present).
  - `mountedWizard.render.test.tsx`: after uploading a DPR (mock) and reaching the plan step WITHOUT choosing visa, "Build my plan" is disabled / shows "Choose your visa status first"; after selecting F-1 on the visa control, it enables.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** add `visaChosen: boolean` to `WizardValues` + `DEFAULT_WIZARD_VALUES` (`false`); the visa `<select>` (both on `confirm_profile` and `goals`) sets `visa` AND `visaChosen:true` on change, with a leading disabled placeholder option `— select your visa status —` shown when `!visaChosen`. Add the pure `canBuildPlan(state, parsedDpr)` helper to `wizardMachine.ts` (`!!parsedDpr && state.values.visaChosen`). In `OnboardingWizard.tsx`, the terminal "Build my plan" button is `disabled={!canBuildPlan(state, parsedDpr)}` with a `title` explaining what's missing; keep the DPR-mandatory "Skip all" gate from `b7ded11`. (`handleWizardReachPlan` already reads `values.visa` — no change there; we're just forcing an explicit value.)
- [ ] **Step 4 — run, expect PASS** + full suite. Update any wizard test that assumed visa defaults silently.
- [ ] **Step 5 — commit:** `git commit -m "fix(web): require an explicit visa-status choice before Build my plan (F-1 floor correctness)"`.

---

# PART 4 — Live-mock fixes (added 2026-06-18 from a real chat-typed test on the sample DPR)

> Root-caused by the triage workflow against the real code. None touches the frozen seam. These are prerequisites for the slot-editor feeling correct, so they sit in this plan. Phase J is a tiny standalone engine bugfix that should land FIRST (Phases C/D/F + the slot-editor "add"/bind action depend on it).

## Phase I — Chat-proposed changes must surface the Confirm button (Issue A)

**Finding (verified):** in a fully chat-typed conversation the agent's `propose_plan_change` NEVER produces a proposed scenario or the workspace "Confirm — make this My Plan" button. The tool is `isReadOnly` and returns the proposed schedule only on its tool output; the v2 route emits NO propose-carrying SSE event (only `forward_schedule_update` on commit, `whatif_audit_request` for Branch-A, and `update_profile`→pendingMutationId); the client's `applyEvent` never calls `setPendingPreview`/`addScenario` from a chat tool result. So the plan-36 scenario+Confirm rail is reachable only from the (unmounted) `/api/plan/*` route path — chat changes fall back to prose + typed-"yes" → `confirm_plan_change`. We want chat proposals to ALSO land on the Confirm button (the deterministic commit chokepoint), matching what the student expects and what D-8 specifies for the slot-editor.

### Task I1: v2 route emits a `plan_proposal` SSE event for a chat propose

**Files:** Modify `apps/web/app/api/chat/v2/route.ts` (after the `whatif_audit_request` block ~`:1026-1035`); reuse the orchestrator's pending store. Add `plan_proposal` to the SSE event union (`apps/web/lib/sseStream.ts` + `apps/web/lib/chatV2Client.ts`). Test: `apps/web/tests/chatV2PlanProposal.test.ts` (create).

- [ ] **Step 1 — failing test:** mock `runAgentTurnStreaming` to return a `propose_plan_change` invocation carrying a feasible `proposedSchedule` + `planDiff` + `consequences`; assert the route emits exactly one `plan_proposal` event `{ kind:"plan_proposal", pendingMutationId, proposedSchedule, planDiff, consequences, feasible:true }` before `done`, and that a turn with NO propose invocation emits none.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** after the agent loop, `const proposeInv = finalResult.invocations.find(i => i.toolName === "propose_plan_change")`. If present and it carried mutations, STAGE those mutations into the SAME pending store the route's confirm path consumes (mirror `planActionOrchestrator.ts:501-521` — `randomUUID()` + `pendingStore.put(studentId, { mutations, … })`) to mint a `pendingMutationId`, and `writer.write({ kind:"plan_proposal", pendingMutationId, proposedSchedule, planDiff, consequences, feasible })`. The tool's output already carries `proposedSchedule`/`planDiff`/`consequences` (no engine recompute). Emit at most once (the last propose of the turn). Add the event to both SSE unions.
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

### Task I2: client renders the chat proposal as a proposed scenario + Confirm button

**Files:** Modify `apps/web/app/chat/page.tsx` `applyEvent` (`:536-664`). Test: extend a page render test (or a focused `applyEvent` unit if extracted).

- [ ] **Step 1 — failing test:** feeding a `plan_proposal` event to the client stages a proposed scenario (`planStore.getActiveScenario().kind === "proposed"` with the event's `pendingMutationId`) and renders the workspace "Confirm — make this My Plan" button.
- [ ] **Step 2/3 — implement:** add `case "plan_proposal":` that builds a `PlanActionRouteResponse`-shaped object from the event (`{ feasible, proposedSchedule, planDiff, consequences, pendingMutationId }`) and calls the EXISTING `handlePlanActionResult`-equivalent path → `planActionSurfaces(...)` → `planStore.setPendingPreview(surfaces.preview)` (feasible) / `setInvalidProposal` (infeasible) + emit the chat ScheduleCard. `handleWorkspaceConfirm` (`:1584`) already commits via `applyReviewConfirm(planStore, planConfirm, scenario.pendingMutationId)` — unchanged. Do NOT route through `forward_schedule_update` (that commits + drops scenarios, `planState.ts:283-305`).
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

### Task I3: reconcile the two confirm chokepoints (no double-commit) + fix stale prompt

**Files:** `packages/engine/src/agent/systemPrompt.ts` (the PREFERENCE_EXTRACTION_RULES confirm step + `:555`); the pending-store confirm path. Test: `apps/web/tests/planProposalNoDoubleCommit.test.ts` (create).

**Why:** today the agent confirms a chat change by calling `confirm_plan_change({ mutations })` on a typed "yes" (a DIFFERENT chokepoint from the UI button's staged `pendingMutationId`). With I1/I2 a Confirm button now also appears — so a mutation could be committed TWICE (button + typed-yes), and `systemPrompt.ts:555` even tells the agent to "call confirm_plan_change with the pendingMutationId," but that tool's input schema has NO `pendingMutationId` param (stale, hallucination-prone).

- [ ] **Step 1 — decide + failing test:** the chosen model — **the surfaced Confirm button is THE confirm for a proposed change; the agent does NOT auto-confirm.** After `propose_plan_change`, the agent's system-prompt step changes from "wait for yes → call confirm_plan_change" to "surface the change as a proposed plan the student can Confirm on the canvas (or say 'confirm'); I will NOT apply it until they do." A typed "confirm" routes to the SAME staged `pendingMutationId` (the route consumes the pending store), so the commit is idempotent — confirming an already-consumed `pendingMutationId` is a no-op. Write a test that proposing once then confirming twice (button then typed) commits exactly once.
- [ ] **Step 2/3 — implement:** make the pending-store confirm idempotent (consume-once: a confirmed `pendingMutationId` is removed; a second confirm returns "already applied"). Update `systemPrompt.ts` PREFERENCE_EXTRACTION_RULES (the confirm step) + delete/fix the `:555` `pendingMutationId`-param line so the agent narrates the canvas Confirm affordance, not a non-existent tool param. (If unifying fully is too large, the MINIMUM is: the system prompt stops the agent from auto-confirming on "yes" when a `plan_proposal` is pending, and the pending store is consume-once.)
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

### Task I4: render only VALID scenarios; invalid what-ifs are chat-only (owner decision)

**Decision (owner, 2026-06-18):** a scenario appears in the workspace as a compare-able tab ONLY when it is `valid-clean` or `valid-with-trade-offs`. An **invalid read-only what-if** is NOT rendered as a workspace tab — the agent explains WHY in chat (with the concrete consequence), as today. An **invalid committable proposed change** shows its red review-card EXPLAINING why it's invalid + what would make it valid, with **NO Confirm and NO "Override anyway"** — an invalid plan is NEVER committed (owner decision 2026-06-18; the `force`/`student-preferred-invalid-draft` path is retired in Phase M). The student adjusts the change until it's valid. Rationale: the workspace holds plans you could adopt or meaningfully compare; an invalid plan is neither — it gets an explanation, not a commit. **PRECONDITION:** only safe once the validity verdict is reliable — Phases J/K/L (the false-invalid bugs) MUST land first, else this rule hides/blocks legitimately-valid changes (e.g. the J-term).

**Files:** the I1/I2 surfacing in `apps/web/app/chat/page.tsx` (the `plan_proposal` case + `handleWhatIfResult`) + `buildWhatIfScenarioFromAudit`. Test: extend the I2 test + a what-if surfacing test.

- [ ] **Step 1 — failing test:** an INVALID what-if result creates NO scenario AND NO invalid card (`planStore.getScenarios()` unchanged, `getScenarioState().invalidProposal === null`); a VALID/trade-offs what-if creates a read-only `kind:"whatif"` scenario; an INVALID proposed result creates the red `invalidProposal` explanation card that carries NO Confirm and NO Override affordance (per Phase M).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** branch the surfacing on `{ kind: proposed|whatif, verdict }`: valid/trade-offs proposed → `setPendingPreview` (scenario + Confirm); valid/trade-offs what-if → `addScenario` (read-only compare tab); invalid proposed → `setInvalidProposal` (red card that EXPLAINS why + what would make it valid, NO Confirm/Override — see Phase M); **invalid what-if → NO workspace surface** (skip `addScenario`/`setInvalidProposal`) — rely on the agent's chat explanation. `planActionSurfaces` already computes the invalid card for `feasible:false`; gate the what-if branch to suppress it.
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

## Phase J — `bind_pool_slot` / `bind_free_elective` must accept an infeasible draft plan (Issue B)

**Finding (verified):** when a plan is infeasible it is stored in `session.studentDraftPlan` (Decision #32), and `forwardSchedule` is `undefined`. `bind_pool_slot` is the ONLY plan-edit tool that keys exclusively on `session.forwardSchedule` (its `validateInput` hard-fails "No forward plan exists in this session" and its `call()` does `session.forwardSchedule!`), so a student CANNOT bind a concrete course (e.g. CORE-UA 402 → Texts & Ideas) to repair an infeasible plan — a chicken-and-egg, since binding is exactly what makes it feasible. The "No forward plan exists" message is literally wrong (a draft exists). `bind_free_elective` shares the defect. NOT FOSE, NOT agent hallucination — the tool's deterministic refusal. This is the root cause behind the test's CORE-UA 402 "doesn't satisfy Texts & Ideas."

### Task J1: accept the draft plan in both bind tools

**Files:** Modify `packages/engine/src/agent/tools/bindPoolSlot.ts` (`validateInput` ~`:245-252`; `call` ~`:268`) + `packages/engine/src/agent/tools/bindFreeElective.ts` (`:175`, `:197`). Test: extend `packages/engine/tests/agent/bindPoolSlot.test.ts`.

- [ ] **Step 1 — failing test:** a session with NO `forwardSchedule` but a `studentDraftPlan` (infeasible) containing a `CORE-UA 400–499` pool placeholder → `bindPoolSlotTool.validateInput({ … })` returns `{ ok:true }` (today `{ ok:false, "No forward plan exists" }`), and `call(...)` binds against the draft plan's slot.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** `validateInput`: `if (!session.forwardSchedule && !session.studentDraftPlan) return { ok:false, … }` (update the message to "I don't have a plan to bind into yet — let me build your forward plan first."). `call`: `const schedule = session.forwardSchedule ?? session.studentDraftPlan!;` (the canonical active-plan accessor used by `proposePlanChange.ts:125` / `confirmPlanChange.ts:148`). Apply the identical two-line change to `bindFreeElective.ts`.
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit:** `git commit -m "fix(engine): bind_pool_slot/bind_free_elective accept the infeasible draft plan (unblocks repairing an infeasible plan by binding a course)"`.

### Task J2: verify the binding STICKS through confirm (investigate-first)

**Files:** read `confirmPlanChange.ts` + `bindPoolSlot.ts` `call()` + the pool-binding → preferences/mutation path. Test: an integration test that binds CORE-UA 402 to the Texts & Ideas leaf on a draft plan, then confirms, and asserts the COMMITTED plan has the leaf satisfied (axis-1 passes).

- [ ] **Step 1 — INVESTIGATE:** `confirm_plan_change` re-runs the solver from `schedulePreferences` (mutations), NOT from the bound preview slot. Determine whether a `bind_pool_slot` binding is persisted as a `pin` (course→term) + a pool-binding the solver honors on re-plan, or whether it is discarded at confirm. Grep how `bindPoolSlot.call` records the choice (a `pin` mutation? a `bindPoolSlot` mutation in `SchedulePreferences`?) and whether `applyMutationsToPreferences` / the solver consume it.
- [ ] **Step 2 — failing integration test** per the finding (the binding must survive confirm).
- [ ] **Step 3 — implement IF needed:** if the binding does not stick, persist it as a `pin` of the chosen course into the requirement's term (the `pin` mutation already flows through propose→confirm + accepts the draft plan) and/or thread a `bindPoolSlot`-kind mutation into `SchedulePreferences` that the solver honors. (Do NOT change the frozen solver/validator — only the preferences/mutation plumbing that feeds it.)
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

> Routing note for the slot-editor (Phase F): the "PLANNED placeholder → pick a concrete course" action and the term-level "add" should express the student's choice through the path that survives confirm (per J2) — likely a `pin` mutation via propose→confirm (which already accepts the draft plan), rather than a bind that gets dropped. Resolve J2 before wiring F's add/bind.

## Phase K — Resolvable placeholders are NOT infeasible; FOSE ≠ requirement satisfaction (Issue C)

**Finding (verified):** the engine's design is ALREADY correct — a RESOLVABLE pool placeholder (a `placeholder` slot carrying a `poolBinding` with `candidates.length > 0`) PASSES axis-1 (`checkRequirementGroupsSatisfied`) and axis-4 (`checkThresholdsMet`) with NO concrete course bound, and `derivePlanStateFromValidator` returns `valid-with-trade-offs` (not infeasible) for resolvable placeholders. Only an EMPTY placeholder (no `poolBinding` / empty candidates) is hard-infeasible. So the user's instinct is right (a "pick the exact course" placeholder should NOT be a hard blocker) — and it already isn't, WHEN the placeholder is resolvable. The test's "infeasible" + "major credits 4 < 36" both trace to the two requirement leaves emitting as EMPTY placeholders (downstream of Issue B's binding failure and/or a missing pool descriptor). The agent's "FOSE has no Spring 2027 sections, so I can't confirm CORE-UA 402 satisfies Texts & Ideas" is a FALSE rationalization — requirement membership is built purely from the catalog (`poolMembersFor`: dept + level range), FOSE-independent; `materialize_sections` is a separate, optional, downstream section-time step that never feeds the validator.

### Task K1: ensure the requirement leaves emit as RESOLVABLE pool placeholders (investigate-first)

**Files:** read `packages/engine/src/agent/forwardSchedule/materializePlan.ts:482-517` (the `POOL-<rId>` placeholder build) + `constraintModel.ts:135-163` (`poolMembersFor`) + the requirement→pool-descriptor derivation in `buildSolverInput.ts` + the DPR requirement schema for R1004/10 (Texts & Ideas) + R1142/20 (CS Required). Test: a fixture test on the failing requirements.

- [ ] **Step 1 — INVESTIGATE the exact failure:** on the sample-DPR fixture (or a synthetic copy of the two leaves), determine whether the Texts & Ideas leaf (`CORE-UA 400–499`) and the CS-Required leaf materialize as (a) a resolvable `POOL-<rId>` placeholder with `poolBinding.candidates.length > 0`, or (b) an EMPTY placeholder. If empty, find WHY: does the leaf carry a `pool` descriptor (`dept:"CORE-UA", levelMin:400, levelMax:499`) reaching `poolMembersFor`, or is it a plain `specific` requirement with empty `candidateCourses`? Is `CORE-UA 402` present in the loaded catalog for the student's catalog year (a catalog-coverage gap also yields empty candidates)?
- [ ] **Step 2 — failing test** capturing the real mechanism (e.g. "the Texts & Ideas leaf materializes with a non-empty `poolBinding.candidates` including CORE-UA 402").
- [ ] **Step 3 — fix the derivation/coverage** (NOT the frozen validator): add/repair the `pool` descriptor for the CORE-UA Texts & Ideas range (and the CS-Required pool) so `poolMembersFor` returns the catalog candidates, OR fill the catalog gap. The resolvable placeholder then auto-passes axes 1+2+4 → the plan is `valid-with-trade-offs`, and "major 4 < 36" clears.
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

### Task K2: system-prompt guardrail — FOSE availability is never a requirement-satisfaction input

**Files:** Modify `packages/engine/src/agent/systemPrompt.ts` (near `:538-539`, the FOSE 6-month note). Test: the existing prompt/eval guards (no new runtime test required; this is prompt text).

- [ ] **Step 1 — implement:** add an explicit rule near the FOSE note: "FOSE section availability governs ONLY `materialize_sections` (meeting times/CRNs for the near term). It is NEVER an input to whether a course satisfies a requirement or whether a plan is feasible. Requirement membership is determined from the catalog (department + course-level range) and is FOSE-independent — do NOT tell a student that missing Spring/far-future FOSE sections mean a course 'can't be confirmed' for a requirement." Remove any prose that implies otherwise.
- [ ] **Step 2 — sanity-run** the gated agent evals if present (`evals/`); commit (prompt-only).

## Phase L — Adding an OPTIONAL term (J-term / summer) of free electives is VALID (J-term test)

**Finding (verified): NO real NYU rule violation.** A J-term of free electives is valid — J-term is optional, NOT needed to graduate, the F-1 full-time floor applies per fall/spring semester (a J-term/winter session does not carry the 12-credit floor), and the per-semester credit ceiling is a fall/spring ceiling. The "infeasible" the test produced is a SOLVER ARTIFACT: opening J-term (`SchedulePreferences.includeJTerm` / a `{kind:"addTerm"}` mutation) let the solver relocate the UNBOUND Texts & Ideas placeholder (a leftover of Issue B's binding failure) into January, where CORE-UA courses are not offered. The offering-pattern constraint is REAL and correct (`course.termsOffered` excludes january for CORE-UA — `packages/shared/src/types.ts:20,717`); the artifact is the solver's freedom to drop a MOVABLE/unbound placeholder into a non-offering term. The correct output: "valid — a J-term is NOT needed for your requirements, but you may take one for interest courses." This dissolves once Issue B binds the requirement (no movable placeholder) + the requirement courses are pinned to their terms; it is NOT a frozen-solver change.

**OWNER REFINEMENT (2026-06-18):** the deeper behavior is that the planner, by default, **distributes the remaining REQUIRED courses across the available terms** — so opening a new term invites the solver to place a requirement into it. That default is correct/normal. BUT a student may EXPLICITLY want a term of **only free electives** (satisfying no requirement), which is **technically valid** and must be allowed — never flagged invalid. So the fix is twofold: (1) when the student designates an added optional term as free-electives (or the remaining requirements are already placeable in their existing terms), the planner must NOT force a requirement into that term — pin the requirements where they belong so the optional term gets only free-elective slots; (2) the agent must then report it VALID with an explicit note: **"This term doesn't satisfy any remaining requirement — it's optional/extra courses you can take for interest."** A term satisfying no requirement is valid; it just isn't *needed*.

### Task L1: confirm additive-J-term is VALID after Issue B + pinning (investigate-first)

**Files:** read the J-term path (`includeJTerm` in `buildSolverInput.ts`; `{kind:"addTerm"}` in `planChangeHelpers.ts`) + the pin layer. Test: an integration test on the sample-DPR shape.

- [ ] **Step 1 — INVESTIGATE (after J1/J2/K1 land):** with the two remaining requirements BOUND (resolvable, not empty placeholders) and pinned to Spring 2027, re-run "add a J-term for free electives." Assert the result is VALID: the requirement courses STAY in Spring 2027 (not relocated), and J-term gets ONLY new free-elective slots. Determine whether opening J-term still relocates a BOUND/pinned course (a deeper solver issue) or whether binding+pinning fully prevents it.
- [ ] **Step 2 — failing test:** the additive-J-term plan is `valid-clean` / `valid-with-trade-offs` (NOT infeasible); the Texts & Ideas + CS-Required courses remain in their original terms.
- [ ] **Step 3 — fix (preferences-layer, NOT the frozen solver):** if any relocation remains, express the requirement courses as `pin`s to their terms (the solver cannot move a pinned course) and make the "add J-term" mutation place ONLY new free-elective placeholder slots into January — never relocate existing slots. Do NOT modify `solveForwardSchedule` / `finalizeForwardSchedule` / the search.
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

### Task L2: agent messaging for optional-term what-ifs + the get_credit_caps verbatim quote

**Files:** `packages/engine/src/agent/systemPrompt.ts`. Test: gated agent evals if present; otherwise prompt-only.

- [ ] **Step 1 — implement:** add a system-prompt rule: when a student proposes an OPTIONAL term (J-term / summer) that is NOT required to satisfy any remaining requirement, report it as VALID and say "this term is optional — you don't need it to graduate, but you can take it for interest courses or a lighter load," rather than framing it as infeasible. Anchor this to the requirement state (if all remaining requirements are already placeable in fall/spring terms, an added optional term is additive + valid). When a term contains ONLY free electives / no requirement-satisfying course, the agent must ALSO state it EXPLICITLY: "this term doesn't satisfy any remaining requirement — it's extra." A term satisfying no requirement is valid; it must NEVER be flagged invalid for that reason alone. ALSO fix the `verbatim_drift` the test hit: when the reply uses `get_credit_caps`, it must QUOTE the tool's text verbatim (e.g. "College of Arts and Science per-semester ceiling: 18 credits. F-1 full-time floor: 12 credits per semester.") rather than paraphrasing the number.
- [ ] **Step 2 — commit** (prompt-only; run gated evals if present).

## Phase M — Never commit an invalid plan: retire the force/override path (owner decision 2026-06-18)

**Decision:** an invalid plan is NEVER committed/persisted. The `force:true` → `student-preferred-invalid-draft` override is retired. An invalid proposed change is EXPLAINED (why + what would make it valid); only `valid-clean` / `valid-with-trade-offs` plans can be confirmed. Aligns the commit path with the core philosophy ("never ship an invalid plan") + I4. **PRECONDITION:** Phases J/K/L (the false-invalid bugs) MUST land first — otherwise a falsely-invalid change becomes un-committable.

### Task M1: the confirm path refuses an infeasible result

**Files:** `apps/web/lib/planActionOrchestrator.ts:652-784` (the `runConfirmStage` + the `force` reclassification `:774-784`); `confirmPlanChange.ts` (Decision #32 routing `:233-242`); the confirm route `force` param. Test: extend the confirm-route + orchestrator tests.

- [ ] **Step 1 — failing test:** confirming a `pendingMutationId` whose re-solved result is infeasible does NOT change `session.forwardSchedule`, does NOT persist a committed schedule, and returns `{ ok:false, reason:<failing-axis explanation> }`; the previously-committed (valid) plan is unchanged. A `force:true` confirm behaves identically (no override commit).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement:** remove the `force` reclassification (`planActionOrchestrator.ts:774-784`) + the `force` param threading. In the confirm path, when the re-solved plan is infeasible, do NOT persist it as the committed `forward_schedule` and do NOT mint a `student-preferred-invalid-draft`; return the failing-axis reason so the caller surfaces the explanation. (Decision #32 may KEEP an in-session `studentDraftPlan` as the agent's working scratchpad for the NEXT edit, but it is NOT the committed plan and is NOT persisted to the DB as committed.) `confirmProposed` (the workspace) + `confirm_plan_change` (the agent) both reject an infeasible result.
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

### Task M2: remove the "Override anyway" UI + agent affordance

**Files:** `apps/web/app/chat/page.tsx` (`handleBubbleOverrideAnyway` `:1472`, the bubble "Override anyway" button + the "⚠ Override applied" message `:1493`); the invalid review-card's override control; `packages/engine/src/agent/systemPrompt.ts` (any "apply/override/force anyway" guidance). Test: render tests + the bubble test.

- [ ] **Step 1 — failing test:** an invalid proposed change renders the red explanation card with Cancel + "Ask why" (and the agent's chat explanation) but NO "Override anyway" / "Confirm" control; `planConfirm` is never invoked with `force:true` from the UI.
- [ ] **Step 2/3 — implement:** delete `handleBubbleOverrideAnyway` + the "Override anyway" button + the override message; the invalid card offers only Cancel / Ask-why (adjust-and-retry). Update the system prompt so that, on an invalid change, the agent explains WHY + what would make it valid + (for a genuine exception) tells the student to confirm with their adviser — it NEVER offers to "apply anyway." Update/retire the tests that asserted the override path.
- [ ] **Step 4 — run PASS + full suite. Step 5 — commit.**

> Net: the committed plan is ALWAYS `valid-clean` or `valid-with-trade-offs`; `student-preferred-invalid-draft` is no longer minted by any confirm (the type may linger for back-compat, but nothing produces it).

---

## Self-review checklist (run before handing off)

**Spec coverage:** ✓ slot-editor + 4 actions (F1–F4) · 3-state matrix engine-enforced (D1 + E1) · P/F 8th validator axis with per-school limits derived from the bulletin for ALL schools, default-no-limit+hedge when unsourced (A1/A2/C1/C2, tier table D-4) · per-action deadlines via the existing F3 windows for IP AND planned-current-term slots, hedged + cautious about per-school divergence (D-3, matrix) · F-1 withdraw warning (E2) · sidebar deletion (G1/G2) · visa-mandatory (H1) · design-spec revision for the frozen-seam change (C3). **Live-mock fixes (Part 4):** chat-proposed changes surface the Confirm button (I1–I3) + only VALID/trade-offs scenarios render as compare tabs, an invalid read-only what-if is CHAT-ONLY, an invalid proposed change shows a red EXPLANATION card with no commit (I4, owner-reversed 2026-06-18) · `bind_*` tools accept the infeasible draft plan (J1–J2) · resolvable placeholders aren't hard-infeasible + FOSE≠requirement-satisfaction (K1–K2) · an OPTIONAL-term (J-term/summer) of free electives is VALID + noted as satisfying no requirement, not infeasible (L1–L2) · NEVER commit an invalid plan — retire the force/"Override anyway" path (M1–M2, owner decision). Grad-term feasibility is explicitly DEFERRED (not in this plan).

**Sequencing:** Phase J (the 2-line bind-on-draft fix) lands FIRST — it's a standalone defect and Phases C/D/F + K depend on bind-on-draft working. Then J2/K1 (the placeholder/binding investigation, which needs the live fixture), then the rest. Phases I + K2 (chat-confirm bridge + the prompt guardrail) are independent and can run in parallel.

**Placeholder scan:** the only deliberately-scoped omission is the FOSE section-picker (called out in the Phase E note as a follow-on, with the v1 behavior — validated structural add — fully specified). No "TBD"/"add validation"/"similar to" placeholders remain.

**Type consistency:** `careerLimitValue`/`careerLimitSourceRef` (A1) used identically in A2/C1. `ValidatorAxis += passFailLimitsRespected` (C2) matches `checkPassFailLimits` (C1). `SlotActionMatrix`/`SlotAction` (D1) consumed unchanged by `slotActionView` (F1) → `SlotActionPopover` (F2) → `ScheduleView` (F3). `canBuildPlan` (H1) defined once. The what-if path (E1/E2) reuses the existing `proposeWhatIfAssumption`/`solveWhatIfAssumption` signatures verbatim.

**Open sub-decisions to confirm with the owner during execution** (each has a chosen default in the plan): REGISTERED absorbs F3's 5-way window (default: yes — matrix uses it) · `placeholder` treated like `specific_planned` for drop (default: yes, drop-only) · shared helpers relocate to `apps/web/app/chat/shared/` (default) · slotState/whatIfSlotControl/groupCoursesByTerm deleted with the subtree (default: yes) · "add" ships structural+existence-validated, FOSE picker deferred (default).

---

## Execution Handoff

**Plan complete and saved to `Docs/plans/37-2026-06-18-slot-editor-actions-and-pf-validation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review (spec + code-quality) between tasks, fast iteration. Best for the engine-heavy Phases A–E.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.

Parts 2 (sidebar deletion) and 3 (visa) are independent and can be dispatched in parallel with Part 1. **Which approach?**
