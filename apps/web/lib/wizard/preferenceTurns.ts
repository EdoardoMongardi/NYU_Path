// ============================================================
// preferenceTurns (Phase 4 Task E5.4) — pure CHAT-TURN builder that
// maps the wizard's Goals + Preferences inputs onto the EXISTING
// Phase-3 preference ladder, reached via the SAME injection rail every
// other client pref edit uses today.
// ============================================================
// TRANSPORT (CRITICAL — name the rail, don't bypass it): the wizard
// does NOT import engine internals and does NOT add a new
// `/api/preferences/*` route. It reaches the ladder by INJECTING A CHAT
// TURN that asks the agent to call `propose_plan_change` /
// `confirm_plan_change` — EXACTLY mirroring `handleProposeLoadStyle`
// (page.tsx:628-631):
//     addMessage('user', text) → handleSendV2(text)
// The agent loop then compiles + applies the mutation via the existing
// `applyMutationsToPreferences` (engine planChangeHelpers.ts) and
// persists via `persistPreferences`. This module is the PURE
// turn-builder half: NO engine import, node-testable; the React
// handler (`handleApplyWizardPreferences`, page.tsx) is the thin
// consumer that injects each returned turn.
//
// LADDER MAPPING — each non-default input → ONE turn naming an
// EXISTING `PlanMutationSchema` kind (planChangeHelpers.ts):
//   - free-text   → an `addSoftObjective` mutation (SOFT-only
//                   `GenericSoftConstraint`, :130). Passed VERBATIM to
//                   the agent's GENERIC compiler — NOT keyword-matched
//                   into a canned phrase (general-fixes-only, §11) — and
//                   explicitly framed as a PREFERENCE / NOT a hard
//                   requirement so the agent uses the SOFT-only
//                   primitive (the D6.4 invariant: never smuggle a hard
//                   constraint into a soft objective).
//   - workload    → a `loadStyleOverride` mutation (:104). Mirrors
//                   `handleProposeLoadStyle` EXACTLY, including its
//                   PLAN-LEVEL-VALID enum domain
//                   (`frontload`/`backload`). See the WORKLOAD NOTE.
//   - summer / J-term / study-abroad / honors toggles →
//                   an `addSoftObjective` mutation (SOFT-only), with
//                   honest "openness / interest" framing. See the
//                   TOGGLES NOTE.
//
// WORKLOAD NOTE (plan-level domain — do NOT regress to light/heavy):
// the wizard's workload field is the load-DISTRIBUTION axis
// (`balanced`/`frontload`/`backload`), NOT a per-term load WEIGHT
// (`light`/`heavy`). The engine's `loadStyleOverride` apply walk REJECTS
// plan-level `light`/`heavy` as a NO-OP (planChangeHelpers.ts:286-290:
// "light/heavy are per-term styles; pass a term to apply them") and only
// accepts `balanced`/`frontload`/`backload` at the plan level
// (:281-294). The wizard has no per-term UI, so it can only ever emit a
// plan-level mutation — hence it must use the plan-level-valid domain.
// This mirrors `handleProposeLoadStyle` (page.tsx), whose entire domain
// is `"balanced" | "frontload" | "backload"`. Load-WEIGHT nuance
// ("I prefer lighter falls") rides the free-text box → addSoftObjective.
//
// TOGGLES NOTE (no invented fields, no dead checkbox): the engine's
// `SchedulingPreferences` (SchedulingPreferencesSchema, :50-66) carries
// ONLY `avoidDays` / `avoidTimeWindows` / `preferTimeWindows` /
// `desiredFreeDay` / `avoidConsecutiveLongBlocks` — there is NO
// `allowSummer` / `allowJTerm` / `studyAbroad` / `honors` field, and
// studyAbroad/honors have no deterministic primitive at all. Aiming a
// `setSchedulingPreference` mutation at a non-existent field produces a
// garbage / rejected mutation — a checkbox that does nothing is worse
// than omitting it. So each toggle (when true) routes through the SAME
// SOFT-objective rail the free-text box uses (`addSoftObjective`), with
// honest "I'm open to / interested in …" framing: these ARE honest soft
// preferences (an openness, not a deterministic "add this term"), they
// stay SOFT-only (the D6.4 invariant), and they never ship a dead action.
// ============================================================

import type { WizardValues } from "./wizardMachine";

/**
 * Build the chat-turn message(s) that ask the AGENT to compile + apply
 * the wizard's Goals + Preferences via `propose_plan_change` (the
 * existing ladder rail). Returns ONE entry per NON-DEFAULT preference;
 * an EMPTY array when every preference is at its default (the student
 * skipped everything — nothing to apply).
 *
 * The React handler injects each returned turn SEQUENTIALLY via
 * `addMessage('user', text) → handleSendV2(text)` (awaiting each so the
 * agent's propose/confirm loop applies them one at a time).
 *
 * NO engine import: this is the pure turn-builder; the agent loop owns
 * the actual mutation/apply/persist.
 */
export function buildPreferenceTurns(values: WizardValues): string[] {
    const turns: string[] = [];

    // ---- workload → loadStyleOverride (mirror handleProposeLoadStyle) ----
    // "balanced" is the neutral default — emit nothing. "frontload" /
    // "backload" are the non-default wizard workloads; both are the
    // PLAN-LEVEL-VALID `loadStyle` enum members the engine's apply walk
    // accepts WITHOUT a term (planChangeHelpers.ts:281-294). We must use
    // this domain — plan-level "light"/"heavy" are silently REJECTED as
    // no-ops (:286-290), and the wizard has no per-term UI. See the
    // WORKLOAD NOTE above. Mirrors `handleProposeLoadStyle` EXACTLY.
    if (values.workload && values.workload !== "balanced") {
        const style = values.workload; // "frontload" | "backload"
        turns.push(
            `Please propose a ${style} load style for my schedule — call propose_plan_change with loadStyle="${style}".`,
        );
    }

    // ---- structured toggles → addSoftObjective (SOFT-only, honest framing) ----
    // No `setSchedulingPreference` field exists for any of these (and
    // studyAbroad/honors have no deterministic primitive at all), so each
    // toggle routes through the SAME SOFT-objective rail the free-text box
    // uses — an honest "openness / interest" preference, never a dead
    // checkbox aimed at a non-existent field. SOFT-only (D6.4): each turn
    // names addSoftObjective and disavows a hard requirement. Only emitted
    // when the student opted IN. See the TOGGLES NOTE above.
    if (values.summer) {
        turns.push(
            `I'm open to using summer terms in my plan if it helps me stay on track. ` +
                `Please call propose_plan_change to add this as a SOFT objective (addSoftObjective) — ` +
                `it is a preference, not a hard requirement.`,
        );
    }
    if (values.jTerm) {
        turns.push(
            `I'm open to using January-term (J-term) sessions in my plan if it helps me stay on track. ` +
                `Please call propose_plan_change to add this as a SOFT objective (addSoftObjective) — ` +
                `it is a preference, not a hard requirement.`,
        );
    }
    if (values.studyAbroad) {
        turns.push(
            `I'm interested in study-away / study-abroad opportunities where they fit in my plan. ` +
                `Please call propose_plan_change to add it as a SOFT objective (addSoftObjective) — ` +
                `it is a preference, not a hard requirement.`,
        );
    }
    if (values.honors) {
        turns.push(
            `I'd like to pursue honors coursework / an honors track where it fits in my plan. ` +
                `Please call propose_plan_change to add it as a SOFT objective (addSoftObjective) — ` +
                `it is a preference, not a hard requirement.`,
        );
    }

    // ---- free-text → addSoftObjective (SOFT-only, VERBATIM) ----
    // The student's phrase is handed to the agent's GENERIC compiler
    // VERBATIM (no keyword rewrite — general-fixes-only §11) and explicitly
    // framed as a SOFT objective / PREFERENCE / NOT a hard requirement, so
    // the agent routes it through `addSoftObjective` (the SOFT-only
    // `GenericSoftConstraint`) and can never smuggle a hard constraint in
    // (the D6.4 invariant). Blank / whitespace-only → no turn.
    const freeText = values.freeText?.trim();
    if (freeText) {
        turns.push(
            `I have a scheduling preference: "${values.freeText}". ` +
                `Please call propose_plan_change to add it as a SOFT objective (addSoftObjective) — ` +
                `it is a preference, not a hard requirement.`,
        );
    }

    return turns;
}
