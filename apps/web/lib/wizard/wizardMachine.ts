// ============================================================
// wizardMachine — Phase 4 Task E5.1 (onboarding/preference wizard SHELL)
// ============================================================
// A PURE, framework-agnostic state machine for the front-of-funnel
// onboarding wizard: a 5-step stepper —
//
//   Upload DPR → Confirm profile → Goals → Preferences → Plan
//
// where EVERY optional field has a sensible default + a Skip, and the
// student can reach a Plan even if they skip every optional field
// (the NO-DEAD-END guarantee). apps/web ships no DOM render harness
// (vitest = node), so ALL the wizard logic lives here and is
// unit-tested directly (apps/web/tests/wizardShell.test.ts); the React
// shell `OnboardingWizard.tsx` is a thin renderer that drives this
// same machine — the established planState.ts / planBadges.ts idiom.
//
// SCOPE (E5.1 = the SHELL + invariant):
//   E5.1 is the stepper + the defaulted / skippable / no-dead-end
//   contract. E5.2–E5.5 flesh out the real step BODIES:
//     E5.2 — home-school propose + confirm (sends body.homeSchool)
//     E5.3 — correcting_data persists
//     E5.4 — goals + preferences → the Phase-3 preference ladder
//     E5.5 — undeclared → intended-major preview (hedged)
//   So `WizardValues` is kept MINIMAL here — placeholder fields with
//   sane defaults. The POINT is the shell, not the field set; later
//   tasks widen `WizardValues` and `DEFAULT_WIZARD_VALUES`. Because
//   every field is defaulted and every optional step is skippable,
//   widening the value set does not break the no-dead-end invariant.
//
// PHILOSOPHY (#1 ALL-NYU, never CAS-only): the wizard collects
// home-school / goals / preferences generically and proposes
// confirmable defaults; it invents no fact and ships no plan — the
// "Plan" step hands off to the existing planning surface, which runs
// the deterministic-on-validity engine.
// ============================================================

// ---------------------------------------------------------------------------
// Step list — the ordered five.
// ---------------------------------------------------------------------------

export type WizardStepId =
    | "upload" // Upload DPR (the data source — reuses /api/onboard)
    | "confirm_profile" // Confirm home school / declared programs (E5.2/E5.3)
    | "goals" // Graduation term, F-1/domestic (E5.4)
    | "preferences" // Workload, summer/J-term, study-abroad/honors, free-text (E5.4)
    | "plan"; // Terminal — hand off to the planning surface

/**
 * The ordered five steps. `upload` is the data source (not "optional"
 * in the skippable sense — it's where the DPR comes in, though the
 * shell still lets a user advance/skip-all past it to a defaults-only
 * Plan, the no-dead-end guarantee). `confirm_profile` / `goals` /
 * `preferences` are the OPTIONAL, skippable steps. `plan` is terminal.
 */
export const WIZARD_STEPS: readonly WizardStepId[] = [
    "upload",
    "confirm_profile",
    "goals",
    "preferences",
    "plan",
] as const;

/** The optional, skippable steps — each has a default + a Skip. */
const OPTIONAL_STEPS: ReadonlySet<WizardStepId> = new Set<WizardStepId>([
    "confirm_profile",
    "goals",
    "preferences",
]);

// ---------------------------------------------------------------------------
// Collected values — every optional field is OPTIONAL on the type and
// DEFAULTED in DEFAULT_WIZARD_VALUES (so nothing is ever undefined at
// rest). E5.2–E5.5 replace these placeholders with the real fields.
// ---------------------------------------------------------------------------

/**
 * Course-load DISTRIBUTION preference (E5.4). This is the load-DISTRIBUTION
 * axis (`balanced`/`frontload`/`backload`) — NOT a per-term load WEIGHT
 * (`light`/`heavy`). The distinction is load-bearing: only these three
 * styles are accepted at the PLAN level by the engine's
 * `loadStyleOverride` apply walk (planChangeHelpers.ts:281-294). Plan-level
 * `light`/`heavy` are REJECTED there as no-ops ("light/heavy are per-term
 * styles; pass a term to apply them"), and the wizard has no per-term UI,
 * so it can only emit plan-level mutations. Load-WEIGHT nuance ("I prefer
 * lighter falls") is covered instead by the free-text box → addSoftObjective.
 */
export type WizardWorkload = "balanced" | "frontload" | "backload";

export interface WizardValues {
    /**
     * Home school confirmation, E5.1 placeholder. E5.2 replaces this
     * with the real propose+confirm (DPR-derived proposal the student
     * confirms or corrects). Default "unconfirmed" means "the DPR's
     * proposed home school stands until the student says otherwise".
     */
    homeSchoolConfirmed: "unconfirmed" | "confirmed" | "corrected";
    /**
     * The confirmed/overridden home-school CODE (e.g. "cas", "stern",
     * "shanghai", "nyuad"), E5.2. The Confirm-profile step PROPOSES the
     * DPR-derived school (`computeHomeSchoolProposal`) and the student
     * confirms or overrides it. Sent as `body.homeSchool` on chat turns.
     *
     * BINDING — NEVER SILENT CAS (core_philosophy.md:4/26): the DEFAULT
     * is the empty string (no home school chosen), NOT "cas". An empty
     * value means "not confirmed yet" — the wizard prompts and nothing
     * is sent until the student picks one, so the engine never silently
     * treats an unknown-school student as CAS.
     */
    homeSchool: string;
    /**
     * Target graduation term, E5.1 placeholder. Default "" = "let the
     * engine infer from the DPR's expected term" (E5.4 wires the real
     * grad-term picker). Empty string is a sane, defined default.
     */
    gradTerm: string;
    /**
     * Visa context. Default "domestic" — the most common case; the
     * student confirms/changes it on the Goals step (E5.4). Defaulted
     * (not undefined) so the no-dead-end path always has a value.
     */
    visa: "f1" | "domestic";
    /**
     * Course-load DISTRIBUTION preference. Default "balanced" — the
     * neutral plan-level load style. The non-default values
     * (`frontload`/`backload`) are the EXACT plan-level-valid domain of
     * the engine's `loadStyleOverride` mutation; E5.4 maps this onto that
     * mutation. The hard solver / validator are never touched — the
     * frozen contract holds.
     */
    workload: WizardWorkload;
    /** Open to summer terms? Default false (opt-in). */
    summer: boolean;
    /** Open to a January (J-term) session? Default false (opt-in). */
    jTerm: boolean;
    /** Interested in study-abroad? Default false (opt-in). */
    studyAbroad: boolean;
    /** Pursuing honors? Default false (opt-in). */
    honors: boolean;
    /** Free-text preferences, compiled later (E5.4). Default "" = none. */
    freeText: string;
}

/**
 * The defaulted value set — EVERY optional field has a defined, sane
 * default so a student who skips everything still reaches a Plan with
 * real values (never undefined). Frozen so it can't be mutated through
 * a leaked reference; `initialWizardState` deep-copies it.
 */
export const DEFAULT_WIZARD_VALUES: WizardValues = Object.freeze({
    homeSchoolConfirmed: "unconfirmed",
    // NEVER SILENT CAS — empty default, never "cas". The Confirm-profile
    // step fills this from the DPR-derived proposal or the student's pick.
    homeSchool: "",
    gradTerm: "",
    visa: "domestic",
    workload: "balanced",
    summer: false,
    jTerm: false,
    studyAbroad: false,
    honors: false,
    freeText: "",
});

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

export interface WizardState {
    /** The current step. */
    step: WizardStepId;
    /** Collected values — defaults applied up front, then overlaid. */
    values: WizardValues;
}

/** A fresh copy of the defaults (never the frozen reference). */
function freshDefaults(): WizardValues {
    return { ...DEFAULT_WIZARD_VALUES };
}

/** Index of a step in WIZARD_STEPS (always found — the type is closed). */
function indexOf(step: WizardStepId): number {
    return WIZARD_STEPS.indexOf(step);
}

// ---------------------------------------------------------------------------
// API.
// ---------------------------------------------------------------------------

/** The starting state: step = "upload", values = a fresh DEFAULT set. */
export function initialWizardState(): WizardState {
    return { step: "upload", values: freshDefaults() };
}

/**
 * True for the OPTIONAL, skippable steps (confirm_profile / goals /
 * preferences) — each has a sensible default and a Skip. False for
 * `upload` (the DPR data source) and `plan` (terminal). The shell uses
 * this to decide whether to render a "Skip" affordance on a step.
 */
export function isOptionalStep(step: WizardStepId): boolean {
    return OPTIONAL_STEPS.has(step);
}

/**
 * Advance one step, merging any provided `patch` into `values`. A no-op
 * on `step` at the terminal "plan". Returns a FRESH state (never
 * mutates the input). The values default already stands for anything
 * the patch doesn't set — so skipping a step (no patch) leaves its
 * field at the default.
 */
export function nextStep(state: WizardState, patch?: Partial<WizardValues>): WizardState {
    const i = indexOf(state.step);
    const nextI = Math.min(i + 1, WIZARD_STEPS.length - 1);
    return {
        step: WIZARD_STEPS[nextI]!,
        values: patch ? { ...state.values, ...patch } : { ...state.values },
    };
}

/**
 * Skip the current step: advance WITHOUT changing any value. That
 * step's field keeps its default (which `initialWizardState` already
 * applied) — so a skipped optional step yields the DEFAULT value, never
 * undefined. Sugar over `nextStep(state)` with no patch, named for the
 * shell's "Skip" button.
 */
export function skipStep(state: WizardState): WizardState {
    return nextStep(state);
}

/**
 * Go back one step. A no-op at the first step ("upload"). Returns a
 * fresh state; values are carried unchanged.
 */
export function prevStep(state: WizardState): WizardState {
    const i = indexOf(state.step);
    const prevI = Math.max(i - 1, 0);
    return {
        step: WIZARD_STEPS[prevI]!,
        values: { ...state.values },
    };
}

/**
 * THE NO-DEAD-END GUARANTEE — jump straight to "plan" with all
 * defaults applied for anything the student didn't set. Any values the
 * student DID set are preserved (overlaid on top of the defaults).
 * From ANY step this reaches `step: "plan"` — so a student can always
 * reach a Plan having configured nothing.
 */
export function skipAll(state: WizardState): WizardState {
    return {
        step: "plan",
        // defaults first, then the student's explicit values on top —
        // so untouched fields stay defaulted (never undefined) and set
        // fields survive.
        values: { ...DEFAULT_WIZARD_VALUES, ...state.values },
    };
}
