// ============================================================
// wizardPreferences (Phase 4 Task E5.4) — the Goals + Preferences
// wizard steps → the Phase-3 preference ladder, reached via a
// CHAT-TURN injection (NO engine import in the wizard, NO new route).
// ============================================================
// apps/web ships NO DOM render harness (no @testing-library/react,
// no jsdom — vitest runs in node), so the turn-building logic is
// extracted into the pure, framework-agnostic, ENGINE-IMPORT-FREE
// helper `apps/web/lib/wizard/preferenceTurns.ts` and unit-tested
// here directly. The React handler in page.tsx
// (`handleApplyWizardPreferences`) is a thin consumer: it builds the
// turn(s) here, then for each one `addMessage('user', text)` →
// `handleSendV2(text)` — EXACTLY the `handleProposeLoadStyle`
// injection pattern (page.tsx:628-631). There is NO new
// `/api/preferences/*` route; the injected turns run through the
// normal agent loop, which compiles + applies them via the EXISTING
// ladder (`propose_plan_change` → `applyMutationsToPreferences`).
//
// TRANSPORT (the binding constraint this test guards): each generated
// turn names `propose_plan_change` and maps to an EXISTING ladder
// `kind`:
//   - free-text → an `addSoftObjective` mutation (SOFT-only
//     `GenericSoftConstraint`) — passed VERBATIM through the generic
//     compiler, never keyword-rewritten (general-fixes-only, §11), and
//     explicitly framed as a PREFERENCE / NOT a hard requirement
//     (the D6.4 SOFT-only invariant — a hard constraint must never be
//     smuggled into a soft objective).
//   - workload (non-default) → a `loadStyleOverride` request mirroring
//     `handleProposeLoadStyle` EXACTLY, including its PLAN-LEVEL-VALID
//     enum domain (`loadStyle="frontload"|"backload"`). Plan-level
//     `light`/`heavy` are NOT used — the engine rejects them as no-ops.
//   - summer / J-term / study-abroad / honors toggles → an
//     `addSoftObjective` request with honest "openness / interest"
//     framing. There is NO `setSchedulingPreference` field for any of
//     them (and study-abroad/honors have no deterministic primitive at
//     all), so a `setSchedulingPreference` mutation would aim at a
//     non-existent field — a dead checkbox. The SOFT-objective rail (the
//     same generic compiler the free-text box uses) is the honest route.
//
// SOFT-only application coverage NOTE: `PlanMutationSchema` /
// `applyMutationsToPreferences` are NOT exported from the
// `@nyupath/engine` barrel (`packages/engine/src/index.ts`), so this
// web test CANNOT build + parse + apply a real mutation here. That the
// `addSoftObjective` mutation lands SOFT-only in `prefs.softObjectives[]`
// (and adds NO hard pin/exclude/cap) is covered by the engine's
// existing Phase-3 D6 tests (e.g.
// `packages/engine/tests/agent/forwardSchedule/genericConstraint.test.ts`
// and `proposePlanChange.test.ts`). This test therefore stays focused
// on the TURN-BUILDER — it asserts the free-text turn requests a SOFT
// objective ONLY and never asks for a hard constraint.
// ============================================================

import { describe, it, expect } from "vitest";
import { DEFAULT_WIZARD_VALUES, type WizardValues } from "../lib/wizard/wizardMachine";
import { buildPreferenceTurns } from "../lib/wizard/preferenceTurns";

// ---------------------------------------------------------------------------
// Helpers — start from the frozen defaults and overlay one preference.
// ---------------------------------------------------------------------------

function withValues(patch: Partial<WizardValues>): WizardValues {
    return { ...DEFAULT_WIZARD_VALUES, ...patch };
}

// ---------------------------------------------------------------------------
// free-text → SOFT objective request (verbatim, general compiler).
// ---------------------------------------------------------------------------

describe("buildPreferenceTurns — free-text → SOFT objective", () => {
    const FREE_TEXT = "I prefer lighter falls";

    it("emits a turn containing the free-text VERBATIM (general compiler, not keyword-rewritten)", () => {
        const turns = buildPreferenceTurns(withValues({ freeText: FREE_TEXT }));
        const freeTextTurn = turns.find((t) => t.includes(FREE_TEXT));
        expect(freeTextTurn).toBeDefined();
        // VERBATIM: the exact student phrase is present, not paraphrased
        // into a canned "frontload"/"light fall" keyword patch.
        expect(freeTextTurn).toContain(FREE_TEXT);
    });

    it("names propose_plan_change AND addSoftObjective / 'soft objective'", () => {
        const turns = buildPreferenceTurns(withValues({ freeText: FREE_TEXT }));
        const freeTextTurn = turns.find((t) => t.includes(FREE_TEXT))!;
        expect(freeTextTurn).toContain("propose_plan_change");
        expect(
            freeTextTurn.includes("addSoftObjective") ||
                /soft objective/i.test(freeTextTurn),
        ).toBe(true);
    });

    it("explicitly frames the free-text as a PREFERENCE / NOT a hard requirement (D6.4 SOFT-only)", () => {
        const turns = buildPreferenceTurns(withValues({ freeText: FREE_TEXT }));
        const freeTextTurn = turns.find((t) => t.includes(FREE_TEXT))!;
        // Says it is a preference / soft objective …
        expect(/preference|soft objective/i.test(freeTextTurn)).toBe(true);
        // … and explicitly NOT a hard requirement.
        expect(/not a hard requirement|not a hard constraint/i.test(freeTextTurn)).toBe(true);
    });

    it("does NOT keyword-rewrite the free-text into a canned phrase", () => {
        // A free-text mentioning a topic the agent could be tempted to
        // pattern-match (e.g. "no 8am classes") must pass through VERBATIM,
        // not be patched into a SchedulingPreferences avoidTimeWindow shape
        // by the turn-builder. The builder hands the raw phrase to the
        // agent's generic compiler.
        const raw = "no 8am classes and keep my Fridays free";
        const turns = buildPreferenceTurns(withValues({ freeText: raw }));
        const turn = turns.find((t) => t.includes(raw));
        expect(turn).toBeDefined();
        expect(turn).toContain(raw);
        // The builder did NOT smuggle a structured avoid/prefer field name.
        expect(turn).not.toContain("avoidTimeWindows");
        expect(turn).not.toContain("desiredFreeDay");
    });

    it("ignores blank / whitespace-only free-text (no empty soft objective)", () => {
        expect(buildPreferenceTurns(withValues({ freeText: "" }))).toEqual([]);
        expect(buildPreferenceTurns(withValues({ freeText: "   " }))).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// workload → loadStyle request (mirrors handleProposeLoadStyle EXACTLY).
// ---------------------------------------------------------------------------

describe("buildPreferenceTurns — workload → loadStyleOverride", () => {
    // WHY frontload/backload (NOT light/heavy): the wizard can only emit a
    // PLAN-LEVEL loadStyleOverride (it has no per-term UI), and the engine's
    // apply walk REJECTS plan-level `light`/`heavy` as silent no-ops
    // ("light/heavy are per-term styles; pass a term to apply them",
    // planChangeHelpers.ts:286-290). Only `balanced`/`frontload`/`backload`
    // apply plan-level. So the wizard's workload axis IS the load-DISTRIBUTION
    // axis, and these assertions pin that plan-level-valid domain so the gap
    // can't silently regress back to a no-op light/heavy mapping.
    it("frontload workload → a turn mirroring handleProposeLoadStyle (loadStyle=\"frontload\")", () => {
        const turns = buildPreferenceTurns(withValues({ workload: "frontload" }));
        const loadTurn = turns.find((t) => t.includes('loadStyle="frontload"'));
        expect(loadTurn).toBeDefined();
        expect(loadTurn).toContain("propose_plan_change");
        // Mirrors the exact template shape of handleProposeLoadStyle.
        expect(loadTurn).toContain('load style');
    });

    it("backload workload → loadStyle=\"backload\"", () => {
        const turns = buildPreferenceTurns(withValues({ workload: "backload" }));
        expect(turns.some((t) => t.includes('loadStyle="backload"'))).toBe(true);
    });

    it("default workload (balanced) emits NO load-style turn", () => {
        const turns = buildPreferenceTurns(withValues({ workload: "balanced" }));
        expect(turns.some((t) => t.includes("loadStyle="))).toBe(false);
    });

    it("never emits a plan-level light/heavy loadStyle (would be a silent no-op)", () => {
        // Exhaustively over the wizard's whole workload domain: no generated
        // turn may carry plan-level light/heavy, which the engine rejects.
        for (const workload of ["balanced", "frontload", "backload"] as const) {
            const turns = buildPreferenceTurns(withValues({ workload }));
            expect(turns.some((t) => t.includes('loadStyle="light"'))).toBe(false);
            expect(turns.some((t) => t.includes('loadStyle="heavy"'))).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// toggles → setSchedulingPreference-style request.
// ---------------------------------------------------------------------------

describe("buildPreferenceTurns — structured toggles → addSoftObjective", () => {
    // Each toggle routes through the SOFT-objective rail with honest
    // "openness / interest" framing — NOT a setSchedulingPreference mutation
    // aimed at a field that does not exist (a dead checkbox). These pin that
    // honest routing.
    it("summer=true → an addSoftObjective propose_plan_change turn mentioning summer", () => {
        const turns = buildPreferenceTurns(withValues({ summer: true }));
        const summerTurn = turns.find((t) => /summer/i.test(t));
        expect(summerTurn).toBeDefined();
        expect(summerTurn).toContain("propose_plan_change");
        expect(/addSoftObjective|soft objective/i.test(summerTurn!)).toBe(true);
        // Honest "open to" framing, kept SOFT (not a hard requirement).
        expect(/open to/i.test(summerTurn!)).toBe(true);
        expect(/not a hard requirement|not a hard constraint/i.test(summerTurn!)).toBe(true);
    });

    it("jTerm=true → an addSoftObjective turn mentioning J-term / January", () => {
        const turns = buildPreferenceTurns(withValues({ jTerm: true }));
        const jTurn = turns.find((t) => /j-?term|january/i.test(t));
        expect(jTurn).toBeDefined();
        expect(jTurn).toContain("propose_plan_change");
        expect(/addSoftObjective|soft objective/i.test(jTurn!)).toBe(true);
        expect(/not a hard requirement|not a hard constraint/i.test(jTurn!)).toBe(true);
    });

    it("studyAbroad=true → an addSoftObjective turn mentioning study abroad", () => {
        const turns = buildPreferenceTurns(withValues({ studyAbroad: true }));
        const turn = turns.find((t) => /study[ -]?abroad|study[ -]?away/i.test(t));
        expect(turn).toBeDefined();
        expect(turn).toContain("propose_plan_change");
        expect(/addSoftObjective|soft objective/i.test(turn!)).toBe(true);
        // Honest "interested in" framing, kept SOFT.
        expect(/interested in/i.test(turn!)).toBe(true);
        expect(/not a hard requirement|not a hard constraint/i.test(turn!)).toBe(true);
    });

    it("honors=true → an addSoftObjective turn mentioning honors", () => {
        const turns = buildPreferenceTurns(withValues({ honors: true }));
        const turn = turns.find((t) => /honors/i.test(t));
        expect(turn).toBeDefined();
        expect(turn).toContain("propose_plan_change");
        expect(/addSoftObjective|soft objective/i.test(turn!)).toBe(true);
        expect(/not a hard requirement|not a hard constraint/i.test(turn!)).toBe(true);
    });

    it("NO toggle turn aims at setSchedulingPreference or a fabricated schema field", () => {
        // The engine's SchedulingPreferences has NO allowSummer / allowJTerm /
        // includeSummer / includeJTerm / studyAbroad / honors field, so a
        // setSchedulingPreference mutation would be a garbage / rejected
        // mutation. Assert across ALL toggles at once that no generated turn
        // names setSchedulingPreference or any of those invented fields.
        const turns = buildPreferenceTurns(
            withValues({ summer: true, jTerm: true, studyAbroad: true, honors: true }),
        );
        expect(turns.length).toBe(4);
        for (const turn of turns) {
            expect(turn).not.toMatch(/setSchedulingPreference/i);
            expect(turn).not.toMatch(/allowSummer|allowJTerm|includeSummer|includeJTerm/i);
            // No fabricated studyAbroad/honors schema FIELD reference (these
            // are mentioned only as natural-language interests, never as a
            // "set scheduling preference field" patch).
            expect(turn).not.toMatch(/scheduling preference (?:field|to)/i);
        }
    });

    it("toggles left false emit no turn", () => {
        const turns = buildPreferenceTurns(
            withValues({ summer: false, jTerm: false, studyAbroad: false, honors: false }),
        );
        expect(turns).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// all-defaults → empty array (nothing to apply when everything skipped).
// ---------------------------------------------------------------------------

describe("buildPreferenceTurns — all defaults", () => {
    it("returns an empty array when every preference is at its default", () => {
        expect(buildPreferenceTurns({ ...DEFAULT_WIZARD_VALUES })).toEqual([]);
    });

    it("returns one turn per non-default preference", () => {
        const turns = buildPreferenceTurns(
            withValues({ workload: "frontload", summer: true, freeText: "I like mornings" }),
        );
        // exactly: 1 load-style + 1 summer + 1 free-text = 3.
        expect(turns).toHaveLength(3);
        expect(turns.some((t) => t.includes('loadStyle="frontload"'))).toBe(true);
        expect(turns.some((t) => /summer/i.test(t))).toBe(true);
        expect(turns.some((t) => t.includes("I like mornings"))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// SOFT-only invariant (D6.4): NO generated turn asks the agent to add a
// HARD constraint disguised as a soft objective. The free-text turn must
// request a soft objective ONLY.
// ---------------------------------------------------------------------------

describe("buildPreferenceTurns — SOFT-only invariant (D6.4)", () => {
    it("no generated turn frames the free-text as a HARD requirement", () => {
        const turns = buildPreferenceTurns(
            withValues({
                freeText: "I really need lighter falls",
                workload: "frontload",
                summer: true,
                honors: true,
            }),
        );
        const freeTextTurn = turns.find((t) => t.includes("I really need lighter falls"))!;
        // The free-text turn requests a SOFT objective and disavows a hard
        // requirement — it must NOT ask the agent to add a pin/exclude or a
        // hard constraint for the preference phrase.
        expect(/not a hard requirement|not a hard constraint/i.test(freeTextTurn)).toBe(true);
        // The free-text turn never asks for a hard `pin`/`exclude` mutation
        // (those are the HARD ladder kinds; the SOFT phrase must not route there).
        expect(freeTextTurn).not.toMatch(/\bpin\b/i);
        expect(freeTextTurn).not.toMatch(/\bexclude\b/i);
    });
});
