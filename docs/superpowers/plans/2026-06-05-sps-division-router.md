# SPS Division-Aware Advanced-Standing Cap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an SPS student's DPR is loaded, `get_credit_caps` returns the single advanced-standing cap for their division (64 / 80 / 30) when confidence is high, and otherwise asks the student to confirm their division.

**Architecture:** A pure resolver `resolveSpsDivision(dpr)` reads the student's `Major` program row from the DPR (corroborated by `creditsRequired`) and returns a high- or low-confidence verdict. `get_credit_caps` calls it only for `homeSchool==="sps"` with a DPR loaded, collapsing the three scoped `advanced_standing` config entries to the resolved one (high) or surfacing a "confirm your division" prompt (low). No DPR → unchanged (all three shown as general policy).

**Tech Stack:** TypeScript, Vitest, Zod (existing DPR schema). Spec: `docs/superpowers/specs/2026-06-05-sps-division-router-design.md`.

**Division rule (grounded in the SPS program catalog):**
- Every SPS **associate** (AAS/AA) is DAUS → **30**.
- Among **bachelor's**: Real Estate → Schack, Hospitality → Tisch Center, Sport → Tisch Institute → all **64**; every other bachelor's (the "Applied …" family) is DAUS → **80**.

---

## File Structure

- **Create** `packages/engine/src/dpr/spsDivision.ts` — the resolver + its types + `SPS_DIVISION_OPTIONS`. One responsibility: DPR → division verdict.
- **Modify** `packages/engine/src/dpr/index.ts` — barrel-export the resolver.
- **Modify** `packages/engine/src/agent/tools/getCreditCaps.ts` — call the resolver (SPS+DPR only); add `advancedStandingResolution` to the result; render it in `summarizeResult`.
- **Modify** `packages/engine/src/agent/systemPrompt.ts` — half-sentence noting the SPS cap is division-dependent and needs the DPR.
- **Create** `packages/engine/tests/dpr/spsDivision.test.ts` — resolver unit tests.
- **Modify** `packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts` — integration tests (extends the file added in PR #32).
- **Create** `packages/engine/tests/agent/noDprPolicy.test.ts` — no-DPR policy regression.

---

## Task 1: Resolver module — high-confidence resolution

**Files:**
- Create: `packages/engine/src/dpr/spsDivision.ts`
- Modify: `packages/engine/src/dpr/index.ts`
- Test: `packages/engine/tests/dpr/spsDivision.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/engine/tests/dpr/spsDivision.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveSpsDivision } from "../../src/dpr/spsDivision.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

function dpr(
    programs: Array<{ programType: string; label: string }>,
    creditsRequired: number | null = null,
): DegreeProgressReport {
    return {
        programs: programs.map((p) => ({
            ...p,
            requirementTerm: "Fall 2024",
            requirementStatus: "not_satisfied",
        })),
        cumulative: { creditsRequired },
    } as unknown as DegreeProgressReport;
}

describe("resolveSpsDivision — high confidence", () => {
    const CAREER = { programType: "Undergraduate Career", label: "UC-Sch of Prof Studies" };

    it("Real Estate (BS) → Schack, cap 64", () => {
        const r = resolveSpsDivision(dpr([CAREER, { programType: "Major", label: "Real Estate (BS)" }], 128));
        expect(r.confidence).toBe("high");
        if (r.confidence !== "high") return;
        expect(r.division).toBe("schack");
        expect(r.advancedStandingCap).toBe(64);
    });

    it("Hospitality, Travel and Tourism Management (BS) → Tisch Center, cap 64", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Hospitality, Travel and Tourism Management (BS)" }], 128));
        expect(r.confidence === "high" && r.division).toBe("tisch_center");
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(64);
    });

    it("Sport Management (BS) → Tisch Institute, cap 64", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Sport Management (BS)" }], 128));
        expect(r.confidence === "high" && r.division).toBe("tisch_institute");
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(64);
    });

    it("Leadership and Management Studies (BS) → DAUS bachelor's, cap 80", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Leadership and Management Studies (BS)" }], 128));
        expect(r.confidence === "high" && r.division).toBe("daus");
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(80);
    });

    it("Applied General Studies (BA) → DAUS bachelor's, cap 80", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Applied General Studies (BA)" }], 120));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(80);
    });

    it("Business (AAS) → DAUS associate's, cap 30", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Business (AAS)" }], 60));
        expect(r.confidence === "high" && r.division).toBe("daus");
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(30);
    });

    it("Hospitality Management (AAS) → DAUS associate's, cap 30 (degree-level-first beats the subject token)", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Hospitality Management (AAS)" }], 60));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(30);
    });

    it("Liberal Arts (AA) → DAUS associate's, cap 30", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Liberal Arts (AA)" }], 60));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(30);
    });

    it("supplies the degree level from creditsRequired when the label has no degree token", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Real Estate" }], 128));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(64);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/engine/tests/dpr/spsDivision.test.ts`
Expected: FAIL — `resolveSpsDivision` is not exported / module not found.

- [ ] **Step 3: Write the resolver**

Create `packages/engine/src/dpr/spsDivision.ts`:

```typescript
import type { DegreeProgressReport } from "./schema.js";

export type SpsDivision = "schack" | "tisch_center" | "tisch_institute" | "daus";
export type SpsDegreeLevel = "bachelors" | "associates";

export interface SpsDivisionHigh {
    confidence: "high";
    division: SpsDivision;
    degreeLevel: SpsDegreeLevel;
    advancedStandingCap: 64 | 80 | 30;
    matchedLabel: string;
}
export interface SpsDivisionLow {
    confidence: "low";
    reason: string;
    options: ReadonlyArray<{ label: string; cap: number }>;
}
export type SpsDivisionVerdict = SpsDivisionHigh | SpsDivisionLow;

/** The three distinct advanced-standing caps, shown when we must ask. */
export const SPS_DIVISION_OPTIONS = [
    { label: "Schack Institute / Tisch Center / Tisch Institute — bachelor's", cap: 64 },
    { label: "Division of Applied Undergraduate Studies (DAUS) — bachelor's", cap: 80 },
    { label: "Division of Applied Undergraduate Studies (DAUS) — associate's", cap: 30 },
] as const;

// The three named Schack/Tisch bachelor's subjects. Every other SPS program —
// the "Applied …" bachelor's family AND all associate degrees — is DAUS.
const NAMED_UNIT_SUBJECTS: ReadonlyArray<{ re: RegExp; division: SpsDivision }> = [
    { re: /real estate/i, division: "schack" },
    { re: /hospitalit/i, division: "tisch_center" },
    { re: /sport/i, division: "tisch_institute" },
];

function degreeLevelFromLabel(label: string): SpsDegreeLevel | null {
    if (/\b(a\.?a\.?s\.?|a\.?a\.?)\b/i.test(label) || /\bassociate/i.test(label)) return "associates";
    if (/\b(b\.?s\.?|b\.?a\.?|b\.?f\.?a\.?)\b/i.test(label) || /\bbachelor/i.test(label)) return "bachelors";
    return null;
}

function bandFromCredits(creditsRequired: number | null | undefined): SpsDegreeLevel | null {
    if (typeof creditsRequired !== "number") return null;
    if (creditsRequired <= 66) return "associates";
    if (creditsRequired >= 100) return "bachelors";
    return null;
}

function capFor(division: SpsDivision, level: SpsDegreeLevel): 64 | 80 | 30 {
    if (division !== "daus") return 64; // Schack / Tisch unit bachelor's
    return level === "associates" ? 30 : 80;
}

export function resolveSpsDivision(dpr: DegreeProgressReport): SpsDivisionVerdict {
    // Only the Major row names the student's actual program; the school
    // rollup ("Sch of Prof Studies") and minors must not drive the division.
    const majors = (dpr.programs ?? []).filter((p) =>
        (p.programType ?? "").toLowerCase().includes("major"),
    );
    const creditsRequired = dpr.cumulative?.creditsRequired ?? null;
    const band = bandFromCredits(creditsRequired);

    const resolved: Array<{ division: SpsDivision; degreeLevel: SpsDegreeLevel; label: string }> = [];
    for (const p of majors) {
        const label = p.label;
        const level = degreeLevelFromLabel(label) ?? band;
        if (level === null) continue; // can't determine this program's level
        if (band && degreeLevelFromLabel(label) && band !== level) continue; // label vs credits conflict → drop
        const division: SpsDivision = level === "bachelors"
            ? (NAMED_UNIT_SUBJECTS.find((u) => u.re.test(label))?.division ?? "daus")
            : "daus"; // every SPS associate is DAUS
        resolved.push({ division, degreeLevel: level, label });
    }

    const distinct = resolved.filter(
        (r, i) => resolved.findIndex((o) => o.division === r.division && o.degreeLevel === r.degreeLevel) === i,
    );
    if (distinct.length === 1) {
        const r = distinct[0]!;
        return {
            confidence: "high",
            division: r.division,
            degreeLevel: r.degreeLevel,
            advancedStandingCap: capFor(r.division, r.degreeLevel),
            matchedLabel: r.label,
        };
    }
    return {
        confidence: "low",
        reason: resolved.length === 0
            ? "No SPS Major program with a determinable degree level found in the DPR."
            : "SPS programs resolve to more than one division/level.",
        options: SPS_DIVISION_OPTIONS,
    };
}
```

- [ ] **Step 4: Add the barrel export**

In `packages/engine/src/dpr/index.ts`, append:

```typescript
export {
    resolveSpsDivision,
    SPS_DIVISION_OPTIONS,
} from "./spsDivision.js";
export type {
    SpsDivision,
    SpsDegreeLevel,
    SpsDivisionVerdict,
    SpsDivisionHigh,
    SpsDivisionLow,
} from "./spsDivision.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/engine/tests/dpr/spsDivision.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/dpr/spsDivision.ts packages/engine/src/dpr/index.ts packages/engine/tests/dpr/spsDivision.test.ts
git commit -m "feat(dpr): resolveSpsDivision — high-confidence SPS division → advanced-standing cap"
```

---

## Task 2: Resolver — low-confidence paths

**Files:**
- Modify: `packages/engine/src/dpr/spsDivision.ts` (already handles these; tests lock the behavior)
- Test: `packages/engine/tests/dpr/spsDivision.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/engine/tests/dpr/spsDivision.test.ts`:

```typescript
import { SPS_DIVISION_OPTIONS } from "../../src/dpr/spsDivision.js";

describe("resolveSpsDivision — low confidence (ask the student)", () => {
    it("career row only (no Major) → low, returns the three options", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Undergraduate Career", label: "UC-Sch of Prof Studies" }], 128));
        expect(r.confidence).toBe("low");
        if (r.confidence !== "low") return;
        expect(r.options).toEqual(SPS_DIVISION_OPTIONS);
    });

    it("Major label with no degree token and no creditsRequired → low", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Real Estate" }], null));
        expect(r.confidence).toBe("low");
    });

    it("two Majors in different divisions → low", () => {
        const r = resolveSpsDivision(dpr([
            { programType: "Major", label: "Real Estate (BS)" },
            { programType: "Major", label: "Applied General Studies (BA)" },
        ], 128));
        expect(r.confidence).toBe("low");
    });

    it("label says BS but creditsRequired says associate → conflict dropped → low", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Real Estate (BS)" }], 60));
        expect(r.confidence).toBe("low");
    });
});
```

- [ ] **Step 2: Run test to verify it passes (behavior already implemented in Task 1)**

Run: `npx vitest run packages/engine/tests/dpr/spsDivision.test.ts`
Expected: PASS (all 13 tests). The resolver from Task 1 already produces `low` for these; this task locks the contract.

If any case fails, fix `resolveSpsDivision` (do not weaken the tests) until green.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/tests/dpr/spsDivision.test.ts
git commit -m "test(dpr): lock resolveSpsDivision low-confidence/ask paths"
```

---

## Task 3: `get_credit_caps` — high-confidence integration

**Files:**
- Modify: `packages/engine/src/agent/tools/getCreditCaps.ts`
- Test: `packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts`:

```typescript
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

function spsCtxWithDpr(programLabel: string, creditsRequired: number): ToolUseContext {
    const dpr = {
        programs: [{ programType: "Major", label: programLabel, requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" }],
        cumulative: { creditsRequired },
    } as unknown as DegreeProgressReport;
    return {
        signal: new AbortController().signal,
        session: {
            student: { id: "t", homeSchool: "sps", catalogYear: "2025-2026", declaredPrograms: [], coursesTaken: [] },
            schoolConfig: sps,
            degreeProgressReport: dpr,
        },
    } as unknown as ToolUseContext;
}

describe("get_credit_caps resolves the SPS division from the DPR", () => {
    it("DAUS bachelor's DPR → summary shows the single 80 cap, not all three", async () => {
        const out = await getCreditCapsTool.call({}, spsCtxWithDpr("Applied General Studies (BA)", 120));
        const summary = getCreditCapsTool.summarizeResult!(out as never);
        expect(summary).toContain("80");
        expect(summary.toLowerCase()).toContain("daus");
        // The other two caps are not presented as the student's cap.
        expect(summary).not.toContain("64 credits");
        expect(summary).not.toContain("30 credits");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts -t "single 80"`
Expected: FAIL — summary still lists all three caps (64/80/30).

- [ ] **Step 3: Add the resolution to `call()` and the result type**

In `packages/engine/src/agent/tools/getCreditCaps.ts`:

3a. Add the import near the top (after the existing imports):

```typescript
import { resolveSpsDivision } from "../../dpr/index.js";
```

3b. In `call()`, after `const creditCaps = cfg?.creditCaps ?? [];`, insert:

```typescript
        // SPS spans divisions with different advanced-standing caps (64/80/30).
        // When a DPR is loaded we resolve the student's division; otherwise the
        // three scoped caps are shown as general policy (see summarizeResult).
        type AdvResolution =
            | { status: "resolved"; cap: number; appliesTo: string; matchedLabel: string }
            | { status: "needs_clarification"; options: ReadonlyArray<{ label: string; cap: number }> };
        let advancedStandingResolution: AdvResolution | null = null;
        if (student.homeSchool === "sps" && session.degreeProgressReport) {
            const verdict = resolveSpsDivision(session.degreeProgressReport);
            if (verdict.confidence === "high") {
                const matched = creditCaps.find(
                    (c) => c.type === "advanced_standing" && c.maxCredits === verdict.advancedStandingCap,
                );
                advancedStandingResolution = {
                    status: "resolved",
                    cap: verdict.advancedStandingCap,
                    appliesTo: matched?.appliesTo ?? "",
                    matchedLabel: verdict.matchedLabel,
                };
            } else {
                advancedStandingResolution = { status: "needs_clarification", options: verdict.options };
            }
        }
```

3c. Add the field to the `result` object's type (inside the `const result: { … }` annotation, alongside `crossSchoolCaps`):

```typescript
            advancedStandingResolution: AdvResolution | null;
```

3d. Add it to the `result` literal (alongside `crossSchoolCaps: creditCaps,`):

```typescript
            advancedStandingResolution,
```

3e. In `summarizeResult(out)`, replace the existing advanced-standing cap loop:

```typescript
        for (const cap of out.crossSchoolCaps) {
            const scope = cap.appliesTo ? ` — ${cap.appliesTo}` : "";
            const ceiling = cap.maxCredits !== undefined
                ? `max ${cap.maxCredits} credits`
                : (cap.maxCourses !== undefined ? `max ${cap.maxCourses} courses` : "see policy");
            lines.push(`Credit cap (${cap.type}): ${ceiling}${scope}`);
        }
```

with this version (skips raw `advanced_standing` lines when an SPS resolution is present, then renders the resolution):

```typescript
        const advRes = out.advancedStandingResolution;
        for (const cap of out.crossSchoolCaps) {
            if (cap.type === "advanced_standing" && advRes) continue; // rendered below
            const scope = cap.appliesTo ? ` — ${cap.appliesTo}` : "";
            const ceiling = cap.maxCredits !== undefined
                ? `max ${cap.maxCredits} credits`
                : (cap.maxCourses !== undefined ? `max ${cap.maxCourses} courses` : "see policy");
            lines.push(`Credit cap (${cap.type}): ${ceiling}${scope}`);
        }
        if (advRes?.status === "resolved") {
            lines.push(
                `Advanced-standing cap: ${advRes.cap} credits — ${advRes.appliesTo} (from your DPR program: ${advRes.matchedLabel})`,
            );
        }
```

(The `needs_clarification` branch is added in Task 4.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts -t "single 80"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agent/tools/getCreditCaps.ts packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts
git commit -m "feat(get_credit_caps): resolve SPS division from DPR → single advanced-standing cap"
```

---

## Task 4: `get_credit_caps` — low-confidence clarification + unchanged paths

**Files:**
- Modify: `packages/engine/src/agent/tools/getCreditCaps.ts`
- Test: `packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts`:

```typescript
describe("get_credit_caps SPS division — clarification + unchanged paths", () => {
    it("career-only DPR → summary asks the student to confirm their division (lists all three)", async () => {
        const out = await getCreditCapsTool.call({}, (function () {
            const dpr = {
                programs: [{ programType: "Undergraduate Career", label: "UC-Sch of Prof Studies", requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" }],
                cumulative: { creditsRequired: 128 },
            } as unknown as DegreeProgressReport;
            return {
                signal: new AbortController().signal,
                session: {
                    student: { id: "t", homeSchool: "sps", catalogYear: "2025-2026", declaredPrograms: [], coursesTaken: [] },
                    schoolConfig: sps,
                    degreeProgressReport: dpr,
                },
            } as unknown as ToolUseContext;
        })());
        const summary = getCreditCapsTool.summarizeResult!(out as never);
        const lower = summary.toLowerCase();
        expect(lower).toContain("confirm");
        expect(summary).toContain("64");
        expect(summary).toContain("80");
        expect(summary).toContain("30");
    });

    it("no DPR → still shows all three scoped caps (general policy, status quo)", async () => {
        const out = await getCreditCapsTool.call({}, spsCtx()); // spsCtx() defined earlier in this file (no DPR)
        const summary = getCreditCapsTool.summarizeResult!(out as never);
        expect(summary).toContain("80");
        expect(summary.toLowerCase()).toContain("associate");
        expect(summary.toLowerCase()).not.toContain("confirm");
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts -t "confirm"`
Expected: FAIL — no "confirm" line rendered for the career-only case.

- [ ] **Step 3: Render the clarification branch**

In `summarizeResult`, immediately after the `if (advRes?.status === "resolved") { … }` block added in Task 3, add:

```typescript
        else if (advRes?.status === "needs_clarification") {
            lines.push("Advanced-standing cap depends on your SPS division — confirm which applies:");
            for (const o of advRes.options) {
                lines.push(`  - ${o.label}: ${o.cap} credits`);
            }
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts`
Expected: PASS (all cases — resolved, clarification, no-DPR status quo, and the pre-existing #32 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agent/tools/getCreditCaps.ts packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts
git commit -m "feat(get_credit_caps): SPS low-confidence → ask student to confirm division"
```

---

## Task 5: System-prompt touch

**Files:**
- Modify: `packages/engine/src/agent/systemPrompt.ts`
- Test: `packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts` (prompt-string assertion) — or wherever `buildSystemPrompt` is exercised.

- [ ] **Step 1: Write the failing test**

Append to `packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts`:

```typescript
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

describe("system prompt notes SPS division-dependent caps", () => {
    it("the NO-DPR section mentions that the SPS advanced-standing cap needs the DPR", () => {
        const prompt = buildSystemPrompt({ dprLoaded: false } as never);
        expect(prompt.toLowerCase()).toContain("sps");
        expect(prompt.toLowerCase()).toContain("division");
    });
});
```

Note: if `buildSystemPrompt`'s options type rejects the cast, mirror the minimal options used by the existing `systemPrompt` tests (check `packages/engine/tests/` for a `buildSystemPrompt(` call and copy its options shape). The assertion (prompt mentions SPS + division) is what matters.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts -t "SPS division-dependent"`
Expected: FAIL — prompt has no such sentence.

- [ ] **Step 3: Add the half-sentence**

In `packages/engine/src/agent/systemPrompt.ts`, in the `## NO DEGREE PROGRESS REPORT LOADED` block, change the `get_credit_caps` bullet (the line ending `"and the school's credit caps (`get_credit_caps`)."`) to:

```typescript
            "  and the school's credit caps (`get_credit_caps`). NOTE: for SPS,",
            "  the advanced-standing/transfer cap is division-dependent (Schack/",
            "  Tisch 64, DAUS 80 bachelor's / 30 associate's) — without the DPR you",
            "  can state the general per-division figures but must ask the student",
            "  to upload their DPR for their specific cap.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts -t "SPS division-dependent"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/agent/systemPrompt.ts packages/engine/tests/agent/getCreditCapsSpsDivisions.test.ts
git commit -m "docs(prompt): note SPS advanced-standing cap is division-dependent / needs DPR"
```

---

## Task 6: No-DPR policy regression test

**Files:**
- Create: `packages/engine/tests/agent/noDprPolicy.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/engine/tests/agent/noDprPolicy.test.ts`:

```typescript
// Locks the "no DPR → no personalized answers" policy: the planning/record
// tools must hard-refuse in validateInput when no DPR is loaded.
import { describe, it, expect } from "vitest";
import { getAcademicStandingTool } from "../../src/agent/tools/getAcademicStanding.js";
import { planForwardDegreeTool } from "../../src/agent/tools/planForwardDegree.js";
import type { ToolUseContext } from "../../src/agent/tool.js";

function ctxNoDpr(): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session: {
            student: { id: "t", homeSchool: "sps", catalogYear: "2025-2026", declaredPrograms: [], coursesTaken: [] },
            schoolConfig: null,
            degreeProgressReport: undefined,
        },
    } as unknown as ToolUseContext;
}

describe("no-DPR policy: personalized tools refuse without a DPR", () => {
    it("get_academic_standing refuses", async () => {
        const r = await getAcademicStandingTool.validateInput!({}, ctxNoDpr());
        expect(r.ok).toBe(false);
    });

    it("plan_forward_degree refuses", async () => {
        const r = await planForwardDegreeTool.validateInput!({}, ctxNoDpr());
        expect(r.ok).toBe(false);
    });
});
```

Note: confirm the exact exported tool names by grepping (`grep -rn "export const .*Tool" packages/engine/src/agent/tools/getAcademicStanding.ts packages/engine/src/agent/tools/planForwardDegree.ts`) and adjust the imports if they differ.

- [ ] **Step 2: Run test to verify it passes (policy already enforced)**

Run: `npx vitest run packages/engine/tests/agent/noDprPolicy.test.ts`
Expected: PASS — both tools already refuse without a DPR. (If a tool does NOT refuse, that is a real policy gap — STOP and report it rather than weakening the test.)

- [ ] **Step 3: Commit**

```bash
git add packages/engine/tests/agent/noDprPolicy.test.ts
git commit -m "test(agent): lock no-DPR policy — personalized tools refuse without a DPR"
```

---

## Task 7: Full verification

- [ ] **Step 1: Typecheck + full suite**

Run:
```bash
cd packages/shared && npx tsc --noEmit && cd ../engine && npx tsc --noEmit && cd ../../apps/web && npx tsc --noEmit
cd "$(git rev-parse --show-toplevel)" && npx vitest run
```
Expected: all tsc clean; vitest all green (previous baseline 1,393 + the new tests).

- [ ] **Step 2: Commit any incidental fixes, then stop for review.**

---

## Self-Review (completed by plan author)

**Spec coverage:** Resolver (Tasks 1–2) ✓; get_credit_caps high/low integration (Tasks 3–4) ✓; no-DPR unchanged path (Task 4 status-quo test) ✓; system-prompt touch (Task 5) ✓; no-DPR regression (Task 6) ✓; resolver unit + integration + regression tests all present ✓. The spec's "associate-vs-Tisch-Center" risk is resolved by the degree-level-first rule and explicitly tested (Hospitality AAS → 30).

**Placeholder scan:** No TBD/TODO. Two steps say "behavior already implemented in Task 1 / policy already enforced" — these are deliberate lock-in tests, with explicit "if it fails, fix the code/report" instructions, not placeholders.

**Type consistency:** `resolveSpsDivision` / `SpsDivisionVerdict` / `advancedStandingResolution` / `advancedStandingCap` / `SPS_DIVISION_OPTIONS` used identically across tasks. `appliesTo` matches the field added to `CreditCap` in PR #32.

**Known soft spots flagged for the implementer:** (a) `buildSystemPrompt` options shape in Task 5 — copy from an existing test; (b) exact `*Tool` export names in Task 6 — grep to confirm.
