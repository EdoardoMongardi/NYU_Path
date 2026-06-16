// ============================================================
// wizardShell (Phase 4 Task E5.1) — onboarding/preference wizard
// SHELL: a 5-step stepper (Upload DPR → Confirm profile → Goals →
// Preferences → Plan) where EVERY optional field has a sensible
// default + a Skip, and the user can reach a plan even if they skip
// every optional field (NO dead-end).
// ============================================================
// apps/web ships NO DOM render harness (no @testing-library/react,
// no jsdom — vitest runs in node), so the wizard's STATE MACHINE is
// extracted into the pure, framework-agnostic module
// `apps/web/lib/wizard/wizardMachine.ts` and unit-tested here
// directly. The React shell `OnboardingWizard.tsx` is a thin renderer
// that drives this same machine (Skip / Back / "Skip all" buttons +
// step indicator) — exactly the planState.ts / planBadges.ts idiom.
//
// E5.1 is the SHELL + the defaulted / skippable / no-dead-end
// invariant. E5.2–E5.5 flesh out the step bodies (the real
// home-school propose+confirm, the correction, goals + preferences,
// the undeclared→intended-major preview). So `WizardValues` is kept
// minimal here — placeholders with sane defaults — and the POINT of
// the test is: 5 steps render, each optional field is defaulted +
// skippable, and "Skip all" reaches "plan" with defaults applied.
//
// Coverage:
//   - WIZARD_STEPS is exactly the ordered five.
//   - initialWizardState() starts at "upload" with DEFAULT_WIZARD_VALUES.
//   - DEFAULT_WIZARD_VALUES has a (non-undefined) default for every
//     optional field.
//   - isOptionalStep: true for confirm_profile / goals / preferences;
//     false for upload (the data source) and plan (terminal).
//   - nextStep / skipStep advance through the sequence; nextStep merges
//     a provided patch; skipStep leaves values untouched (the default
//     stands).
//   - prevStep goes back and is a no-op at "upload".
//   - NO DEAD-END: skipAll(initialWizardState()) AND skipAll() from
//     EACH step reach step === "plan" with DEFAULT_WIZARD_VALUES
//     applied — a user can reach Plan having set nothing.
//   - skipping an optional step yields the DEFAULT value (not
//     undefined / missing).
// ============================================================

import { describe, it, expect } from "vitest";
import {
    WIZARD_STEPS,
    DEFAULT_WIZARD_VALUES,
    initialWizardState,
    isOptionalStep,
    nextStep,
    skipStep,
    prevStep,
    skipAll,
    type WizardStepId,
    type WizardState,
} from "../lib/wizard/wizardMachine";

// ---------------------------------------------------------------------------
// Step list.
// ---------------------------------------------------------------------------

describe("WIZARD_STEPS — the ordered five", () => {
    it("is exactly upload → confirm_profile → goals → preferences → plan", () => {
        expect([...WIZARD_STEPS]).toEqual([
            "upload",
            "confirm_profile",
            "goals",
            "preferences",
            "plan",
        ]);
    });

    it("has 5 steps", () => {
        expect(WIZARD_STEPS).toHaveLength(5);
    });
});

// ---------------------------------------------------------------------------
// Initial state + defaults.
// ---------------------------------------------------------------------------

describe("initialWizardState + DEFAULT_WIZARD_VALUES", () => {
    it("starts at the upload step", () => {
        expect(initialWizardState().step).toBe("upload");
    });

    it("starts with the default values (defaults applied up front)", () => {
        expect(initialWizardState().values).toEqual(DEFAULT_WIZARD_VALUES);
    });

    it("has a non-undefined default for every optional field", () => {
        const v = DEFAULT_WIZARD_VALUES as unknown as Record<string, unknown>;
        const keys = Object.keys(v);
        expect(keys.length).toBeGreaterThan(0);
        for (const k of keys) {
            expect(v[k], `default for "${k}" must be defined`).not.toBeUndefined();
        }
    });

    it("does not share a mutable reference across calls (each call is fresh)", () => {
        const a = initialWizardState();
        const b = initialWizardState();
        expect(a).not.toBe(b);
        expect(a.values).not.toBe(b.values);
        // Mutating one does not leak into the other or into the frozen default.
        (a.values as unknown as Record<string, unknown>).__probe = 1;
        expect((b.values as unknown as Record<string, unknown>).__probe).toBeUndefined();
        expect((DEFAULT_WIZARD_VALUES as unknown as Record<string, unknown>).__probe).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// isOptionalStep — confirm_profile / goals / preferences are skippable.
// ---------------------------------------------------------------------------

describe("isOptionalStep", () => {
    it("is true for the three optional steps", () => {
        expect(isOptionalStep("confirm_profile")).toBe(true);
        expect(isOptionalStep("goals")).toBe(true);
        expect(isOptionalStep("preferences")).toBe(true);
    });

    it("is false for upload (the data source) and plan (terminal)", () => {
        expect(isOptionalStep("upload")).toBe(false);
        expect(isOptionalStep("plan")).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// nextStep / skipStep advance; prevStep goes back.
// ---------------------------------------------------------------------------

describe("nextStep advances through the sequence", () => {
    it("walks upload → confirm_profile → goals → preferences → plan", () => {
        let s = initialWizardState();
        const seen: WizardStepId[] = [s.step];
        for (let i = 0; i < WIZARD_STEPS.length - 1; i++) {
            s = nextStep(s);
            seen.push(s.step);
        }
        expect(seen).toEqual([
            "upload",
            "confirm_profile",
            "goals",
            "preferences",
            "plan",
        ]);
    });

    it("is a no-op at the terminal plan step", () => {
        let s = initialWizardState();
        for (let i = 0; i < 10; i++) s = nextStep(s);
        expect(s.step).toBe("plan");
        expect(nextStep(s).step).toBe("plan");
    });

    it("merges a provided patch into values", () => {
        const s0 = initialWizardState();
        const patch = { workload: "heavy" } as Partial<typeof DEFAULT_WIZARD_VALUES>;
        const s1 = nextStep(s0, patch);
        expect(s1.step).toBe("confirm_profile");
        expect((s1.values as unknown as Record<string, unknown>).workload).toBe("heavy");
        // Other defaults survive the merge.
        expect(s1.values).toMatchObject(
            // every default key still present
            Object.fromEntries(
                Object.entries(DEFAULT_WIZARD_VALUES).filter(([k]) => k !== "workload"),
            ),
        );
    });

    it("does not mutate the input state (returns a fresh state)", () => {
        const s0 = initialWizardState();
        const s1 = nextStep(s0, { workload: "light" } as Partial<typeof DEFAULT_WIZARD_VALUES>);
        expect(s1).not.toBe(s0);
        expect(s0.step).toBe("upload");
        expect((s0.values as unknown as Record<string, unknown>).workload).toBe(DEFAULT_WIZARD_VALUES.workload);
    });
});

describe("skipStep advances applying that step's defaults (values untouched)", () => {
    it("advances one step and leaves values equal to the defaults", () => {
        const s0 = initialWizardState(); // upload
        const s1 = skipStep(s0); // → confirm_profile, default still in place
        expect(s1.step).toBe("confirm_profile");
        expect(s1.values).toEqual(DEFAULT_WIZARD_VALUES);
    });

    it("skipping an optional step yields the DEFAULT value (not undefined)", () => {
        // Advance to preferences, then skip it.
        let s = initialWizardState();
        s = skipStep(s); // confirm_profile
        s = skipStep(s); // goals
        s = skipStep(s); // preferences
        expect(s.step).toBe("preferences");
        const skipped = skipStep(s); // → plan, preferences left at default
        expect(skipped.step).toBe("plan");
        expect(skipped.values.workload).toBe(DEFAULT_WIZARD_VALUES.workload);
        expect(skipped.values.workload).not.toBeUndefined();
    });
});

describe("prevStep goes back and is a no-op at upload", () => {
    it("steps backward through the sequence", () => {
        let s = initialWizardState();
        s = nextStep(s); // confirm_profile
        s = nextStep(s); // goals
        expect(prevStep(s).step).toBe("confirm_profile");
        expect(prevStep(prevStep(s)).step).toBe("upload");
    });

    it("is a no-op at the first (upload) step", () => {
        const s = initialWizardState();
        expect(prevStep(s).step).toBe("upload");
    });
});

// ---------------------------------------------------------------------------
// NO DEAD-END — skipAll reaches "plan" with defaults from EVERY step.
// ---------------------------------------------------------------------------

describe("skipAll — the no-dead-end guarantee", () => {
    it("from the initial state reaches plan with DEFAULT_WIZARD_VALUES applied", () => {
        const reached = skipAll(initialWizardState());
        expect(reached.step).toBe("plan");
        // A user who set NOTHING still lands on Plan with sane defaults.
        expect(reached.values).toEqual(DEFAULT_WIZARD_VALUES);
    });

    it("reaches plan from EVERY step (no step is a dead-end)", () => {
        // Build a state at each step, then assert skipAll lands on plan.
        let s: WizardState = initialWizardState();
        for (const step of WIZARD_STEPS) {
            // fast-forward to `step`
            let cur = initialWizardState();
            while (cur.step !== step) cur = nextStep(cur);
            const reached = skipAll(cur);
            expect(reached.step, `skipAll from "${step}" must reach plan`).toBe("plan");
            s = reached;
        }
        expect(s.step).toBe("plan");
    });

    it("preserves values the user DID set while applying defaults for the rest", () => {
        // User sets workload on step 1, then skips everything else.
        const s0 = initialWizardState();
        const s1 = nextStep(s0, { workload: "heavy" } as Partial<typeof DEFAULT_WIZARD_VALUES>);
        const reached = skipAll(s1);
        expect(reached.step).toBe("plan");
        // their explicit value survives…
        expect(reached.values.workload).toBe("heavy");
        // …and the untouched fields are still defaulted (never undefined).
        for (const [k, def] of Object.entries(DEFAULT_WIZARD_VALUES)) {
            if (k === "workload") continue;
            expect((reached.values as unknown as Record<string, unknown>)[k]).toBe(def);
        }
    });

    it("is idempotent once on plan", () => {
        const reached = skipAll(initialWizardState());
        expect(skipAll(reached).step).toBe("plan");
        expect(skipAll(reached).values).toEqual(reached.values);
    });
});
