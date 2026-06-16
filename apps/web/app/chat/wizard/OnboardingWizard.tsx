"use client";

// ============================================================
// OnboardingWizard — Phase 4 Task E5.1 (wizard SHELL, thin renderer)
// ============================================================
// A THIN React renderer over the pure `wizardMachine` state machine
// (apps/web/lib/wizard/wizardMachine.ts). All the step / skip / back /
// skip-all / defaults / no-dead-end logic lives in that node-tested
// module; this component only renders the current step, a step
// indicator (1/5 … 5/5), and the Back / Skip / "Skip all → see my
// plan" affordances — the established planState.ts / scheduleSidebar
// idiom (logic pure + tested, component thin).
//
// SCOPE (E5.1 = the SHELL):
//   Each step BODY here is a minimal placeholder ("coming next") so
//   the SHELL — stepper, Skip on each optional step, Back, Skip-all,
//   defaults, no dead-end — is real and wired to the machine. E5.2–E5.5
//   flesh out the real bodies:
//     E5.2 — home-school propose + confirm
//     E5.3 — correcting_data persists
//     E5.4 — goals + preferences → the Phase-3 preference ladder
//     E5.5 — undeclared → intended-major preview (hedged)
//   The Upload step REUSES the existing /api/onboard DPR-PDF parse
//   endpoint (the same call the chat page's handleFileUpload makes).
//
// INTEGRATION (minimal-scope, deferred deep cutover — E5.1 note):
//   This is a NEW component added ALONGSIDE the existing chat-page
//   `onboardingStep` flow and welcome/drag-drop upload — nothing is
//   ripped out. A full cutover (showing the wizard on first visit and
//   handing the collected values + parsed DPR off to the chat after
//   the "Plan" step) is incremental and left to a follow-on. For E5.1
//   the component is self-contained and accepts optional callbacks so
//   a parent can wire it in later without changing the shell.
// ============================================================

import { useCallback, useMemo, useRef, useState } from "react";
import type { DegreeProgressReport } from "@nyupath/engine";
import {
    WIZARD_STEPS,
    initialWizardState,
    isOptionalStep,
    nextStep,
    prevStep,
    skipStep,
    skipAll,
    type WizardState,
    type WizardStepId,
    type WizardValues,
} from "../../../lib/wizard/wizardMachine";
import {
    SCHOOL_OPTIONS,
    computeHomeSchoolProposal,
    type HomeSchoolProposal,
} from "../../../lib/wizard/homeSchool";
import styles from "./wizard.module.css";

// ---------------------------------------------------------------------------
// Props — all optional so the shell is self-contained for E5.1 and a
// parent can wire callbacks in later (deep integration is deferred).
// ---------------------------------------------------------------------------

export interface OnboardingWizardProps {
    /**
     * Called when the wizard reaches the terminal "plan" step. The
     * parent (the chat page, in a later cutover) takes the collected
     * `values` (+ any parsed DPR) and hands off to the planning
     * surface. No-op if omitted — the shell still reaches Plan.
     */
    onReachPlan?: (values: WizardValues, dpr: DegreeProgressReport | null) => void;
    /**
     * Called when the student dismisses the wizard (e.g. "I'll use the
     * chat instead"). No-op if omitted.
     */
    onDismiss?: () => void;
}

const STEP_TITLES: Record<WizardStepId, string> = {
    upload: "Upload your DPR",
    confirm_profile: "Confirm your profile",
    goals: "Your goals",
    preferences: "Your preferences",
    plan: "Your plan",
};

const STEP_SUBTITLES: Record<WizardStepId, string> = {
    upload: "Upload your Albert Degree Progress Report (PDF) to get started.",
    confirm_profile: "We proposed your home school and programs — confirm or correct them.",
    goals: "Graduation term and visa status. Every field is optional.",
    preferences: "Workload, summer/J-term, study-abroad, honors — all optional.",
    plan: "That's everything we need. Let's build your plan.",
};

export default function OnboardingWizard({ onReachPlan, onDismiss }: OnboardingWizardProps) {
    const [state, setState] = useState<WizardState>(initialWizardState);
    const [uploadBusy, setUploadBusy] = useState(false);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const [parsedDpr, setParsedDpr] = useState<DegreeProgressReport | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const stepIndex = WIZARD_STEPS.indexOf(state.step);
    const totalSteps = WIZARD_STEPS.length;
    const onPlan = state.step === "plan";

    // E5.2 — the DPR-derived home-school proposal for the Confirm-profile
    // step. `needsPrompt` (no school indicator in the DPR) means the wizard
    // PROMPTS with NO default pre-selected — never silently CAS. The student
    // confirms the proposal or overrides it; either way `values.homeSchool`
    // is set explicitly (the default is the empty string, NOT "cas").
    const homeSchoolProposal: HomeSchoolProposal | null = useMemo(
        () => (parsedDpr ? computeHomeSchoolProposal(parsedDpr) : null),
        [parsedDpr],
    );
    // The currently-selected home-school code on the Confirm-profile step:
    // the student's explicit pick if any, else the proposed school. Empty
    // string = nothing selected (the prompt is unanswered).
    const selectedHomeSchool = state.values.homeSchool || homeSchoolProposal?.proposed || "";

    const setHomeSchool = useCallback((code: string) => {
        setState((s) => ({ ...s, values: { ...s.values, homeSchool: code } }));
    }, []);

    // E5.3 — visa-status correction. The Confirm-profile step lets the
    // student CORRECT their F-1 / domestic status; the value is sent as
    // `body.visaStatus` on chat turns and the v2 route persists it when it
    // CHANGES an already-persisted profile (the same persist path
    // confirm_profile_update / the E5.2 home-school correction use), so the
    // correction survives the next turn (and is read back by E1.2).
    const setVisa = useCallback((visa: WizardValues["visa"]) => {
        setState((s) => ({ ...s, values: { ...s.values, visa } }));
    }, []);

    // E5.4 — Goals + Preferences setters. These set the matching
    // `WizardValues` fields; the actual ladder application is deferred to
    // the chat page's `handleApplyWizardPreferences` (wired via
    // `onReachPlan`), which builds the chat turns with `buildPreferenceTurns`
    // and injects them through the existing propose_plan_change rail. The
    // wizard itself imports NO engine internals and adds NO route.
    const setGradTerm = useCallback((gradTerm: string) => {
        setState((s) => ({ ...s, values: { ...s.values, gradTerm } }));
    }, []);
    const setWorkload = useCallback((workload: WizardValues["workload"]) => {
        setState((s) => ({ ...s, values: { ...s.values, workload } }));
    }, []);
    const setFreeText = useCallback((freeText: string) => {
        setState((s) => ({ ...s, values: { ...s.values, freeText } }));
    }, []);
    const toggle = useCallback(
        (key: "summer" | "jTerm" | "studyAbroad" | "honors") => {
            setState((s) => ({ ...s, values: { ...s.values, [key]: !s.values[key] } }));
        },
        [],
    );

    // ---- transitions (thin wrappers over the pure machine) ----
    const advance = useCallback(() => {
        setState((s) => {
            const ns = nextStep(s);
            if (ns.step === "plan") onReachPlan?.(ns.values, parsedDpr);
            return ns;
        });
    }, [onReachPlan, parsedDpr]);

    const skip = useCallback(() => {
        setState((s) => {
            const ns = skipStep(s);
            if (ns.step === "plan") onReachPlan?.(ns.values, parsedDpr);
            return ns;
        });
    }, [onReachPlan, parsedDpr]);

    const back = useCallback(() => setState((s) => prevStep(s)), []);

    const skipEverything = useCallback(() => {
        setState((s) => {
            const ns = skipAll(s);
            onReachPlan?.(ns.values, parsedDpr);
            return ns;
        });
    }, [onReachPlan, parsedDpr]);

    // ---- DPR upload — REUSES the existing /api/onboard endpoint ----
    // Same shape as the chat page's handleFileUpload: POST a multipart
    // form with the file under the "dpr" field; the deterministic
    // parser returns parsedData on success.
    const handleFile = useCallback(
        async (file: File) => {
            if (!file.name.toLowerCase().endsWith(".pdf")) {
                setUploadError("Please upload a PDF (your Degree Progress Report).");
                return;
            }
            setUploadBusy(true);
            setUploadError(null);
            try {
                const formData = new FormData();
                formData.append("dpr", file);
                const res = await fetch("/api/onboard", { method: "POST", body: formData });
                const data = (await res.json()) as {
                    message?: string;
                    // /api/onboard returns the parsed DPR wrapped in the
                    // canonical discriminated onboarding shape.
                    parsedData?: { kind: "dpr"; report: DegreeProgressReport };
                };
                if (!res.ok) {
                    setUploadError(data?.message ?? "Upload failed. Please try again.");
                    return;
                }
                if (data.parsedData?.report) setParsedDpr(data.parsedData.report);
                // Advance past Upload once the DPR parses.
                advance();
            } catch {
                setUploadError("I had trouble processing that file. Please try again.");
            } finally {
                setUploadBusy(false);
            }
        },
        [advance],
    );

    const onFileInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
        },
        [handleFile],
    );

    return (
        <section className={styles.wizard} aria-label="Onboarding wizard">
            {/* Step indicator — 1/5 … 5/5 + a progress rail. */}
            <header className={styles.header}>
                <div className={styles.stepDots} role="list" aria-label="Wizard steps">
                    {WIZARD_STEPS.map((s, i) => (
                        <span
                            key={s}
                            role="listitem"
                            className={
                                i === stepIndex
                                    ? `${styles.dot} ${styles.dotActive}`
                                    : i < stepIndex
                                      ? `${styles.dot} ${styles.dotDone}`
                                      : styles.dot
                            }
                            aria-current={i === stepIndex ? "step" : undefined}
                        />
                    ))}
                </div>
                <span className={styles.stepCount}>
                    Step {stepIndex + 1}/{totalSteps}
                </span>
            </header>

            {/* Current step body. */}
            <div className={styles.body}>
                <h2 className={styles.title}>{STEP_TITLES[state.step]}</h2>
                <p className={styles.subtitle}>{STEP_SUBTITLES[state.step]}</p>

                {state.step === "upload" && (
                    <div className={styles.stepBody}>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="application/pdf,.pdf"
                            className={styles.hiddenInput}
                            onChange={onFileInputChange}
                        />
                        <button
                            type="button"
                            className={styles.primaryBtn}
                            disabled={uploadBusy}
                            onClick={() => fileInputRef.current?.click()}
                        >
                            {uploadBusy ? "Reading your DPR…" : "Choose DPR PDF"}
                        </button>
                        {uploadError && <p className={styles.error}>{uploadError}</p>}
                        {parsedDpr != null && !uploadError && (
                            <p className={styles.ok}>DPR read. Continue when ready.</p>
                        )}
                    </div>
                )}

                {state.step === "confirm_profile" && (
                    // E5.2 — home-school PROPOSE + confirm. We PROPOSE the
                    // DPR-derived home school and let the student CONFIRM or
                    // OVERRIDE it across all 11 schools + NYU Shanghai +
                    // Abu Dhabi. When the DPR carries no school indicator
                    // (`needsPrompt`) we render an explicit prompt with NO
                    // default pre-selected — NEVER silently CAS.
                    <div className={styles.stepBody}>
                        {homeSchoolProposal?.needsPrompt ? (
                            <p className={styles.placeholder}>
                                We couldn&apos;t determine your home school from your DPR. Please
                                select it below so your plan uses the right requirements and credit
                                caps.
                            </p>
                        ) : (
                            <p className={styles.subtitle}>
                                Based on your DPR we proposed your home school below. Confirm it, or
                                pick a different one.
                            </p>
                        )}
                        <label className={styles.fieldLabel} htmlFor="wizard-home-school">
                            Home school
                        </label>
                        <select
                            id="wizard-home-school"
                            className={styles.select}
                            value={selectedHomeSchool}
                            onChange={(e) => setHomeSchool(e.target.value)}
                        >
                            {/* Placeholder option — present (and selected) only when
                                nothing has been chosen yet, so we never default to CAS. */}
                            <option value="" disabled>
                                Select your home school…
                            </option>
                            {SCHOOL_OPTIONS.map((opt) => (
                                <option key={opt.code} value={opt.code}>
                                    {opt.label}
                                </option>
                            ))}
                        </select>

                        {/* E5.3 — visa-status correction. Sent as
                            body.visaStatus; the v2 route persists a CHANGE so
                            it survives the next turn (read back by E1.2). */}
                        <label className={styles.fieldLabel} htmlFor="wizard-visa-status">
                            Visa status
                        </label>
                        <select
                            id="wizard-visa-status"
                            className={styles.select}
                            value={state.values.visa}
                            onChange={(e) => setVisa(e.target.value as WizardValues["visa"])}
                        >
                            <option value="domestic">Domestic / not on an F-1 visa</option>
                            <option value="f1">F-1 visa (full-time enrollment required)</option>
                        </select>
                    </div>
                )}

                {state.step === "goals" && (
                    // E5.4 — Goals: target graduation term + F-1/domestic.
                    // Visa is also editable on Confirm-profile (E5.3); Goals
                    // ECHOES the same `values.visa` (one source of truth, no
                    // duplicate persistence) so the student can set it here
                    // too. Grad term is a free-form term box (e.g. "2027
                    // Spring"); empty = let the engine infer from the DPR.
                    <div className={styles.stepBody}>
                        <label className={styles.fieldLabel} htmlFor="wizard-grad-term">
                            Target graduation term
                        </label>
                        <input
                            id="wizard-grad-term"
                            type="text"
                            className={styles.textInput}
                            placeholder="e.g. Spring 2027 — leave blank to infer from your DPR"
                            value={state.values.gradTerm}
                            onChange={(e) => setGradTerm(e.target.value)}
                        />

                        {/* Echoes the SAME values.visa as Confirm-profile —
                            one source of truth, no duplicate persistence. */}
                        <label className={styles.fieldLabel} htmlFor="wizard-goals-visa">
                            Visa status
                        </label>
                        <select
                            id="wizard-goals-visa"
                            className={styles.select}
                            value={state.values.visa}
                            onChange={(e) => setVisa(e.target.value as WizardValues["visa"])}
                        >
                            <option value="domestic">Domestic / not on an F-1 visa</option>
                            <option value="f1">F-1 visa (full-time enrollment required)</option>
                        </select>
                    </div>
                )}

                {state.step === "preferences" && (
                    // E5.4 — Preferences: workload, summer/J-term/study-abroad/
                    // honors toggles, and a free-text box. Each maps onto the
                    // EXISTING Phase-3 ladder via a chat-turn injection the
                    // chat page builds with `buildPreferenceTurns` and runs
                    // through `propose_plan_change` (NO engine import here, NO
                    // new route). Every field is defaulted + the step is
                    // skippable, so this never blocks the path to Plan.
                    <div className={styles.stepBody}>
                        <label className={styles.fieldLabel} htmlFor="wizard-workload">
                            Course-load distribution
                        </label>
                        <select
                            id="wizard-workload"
                            className={styles.select}
                            value={state.values.workload}
                            onChange={(e) =>
                                setWorkload(e.target.value as WizardValues["workload"])
                            }
                        >
                            {/* Plan-level load-DISTRIBUTION styles — the EXACT
                                domain the engine's loadStyleOverride accepts
                                plan-level (balanced/frontload/backload). NOT
                                light/heavy, which are per-term-only no-ops at
                                the plan level (see preferenceTurns WORKLOAD
                                NOTE). Per-term WEIGHT nuance rides the free-text
                                box → addSoftObjective. */}
                            <option value="balanced">Balanced (default)</option>
                            <option value="frontload">Front-load — heavier early terms</option>
                            <option value="backload">Back-load — heavier later terms</option>
                        </select>

                        <fieldset className={styles.toggleGroup}>
                            <legend className={styles.fieldLabel}>I&apos;m open to…</legend>
                            <label className={styles.toggleRow} htmlFor="wizard-summer">
                                <input
                                    id="wizard-summer"
                                    type="checkbox"
                                    checked={state.values.summer}
                                    onChange={() => toggle("summer")}
                                />
                                <span>Summer terms</span>
                            </label>
                            <label className={styles.toggleRow} htmlFor="wizard-jterm">
                                <input
                                    id="wizard-jterm"
                                    type="checkbox"
                                    checked={state.values.jTerm}
                                    onChange={() => toggle("jTerm")}
                                />
                                <span>A January (J-term) session</span>
                            </label>
                            <label className={styles.toggleRow} htmlFor="wizard-abroad">
                                <input
                                    id="wizard-abroad"
                                    type="checkbox"
                                    checked={state.values.studyAbroad}
                                    onChange={() => toggle("studyAbroad")}
                                />
                                <span>Study-abroad</span>
                            </label>
                            <label className={styles.toggleRow} htmlFor="wizard-honors">
                                <input
                                    id="wizard-honors"
                                    type="checkbox"
                                    checked={state.values.honors}
                                    onChange={() => toggle("honors")}
                                />
                                <span>Honors</span>
                            </label>
                        </fieldset>

                        <label className={styles.fieldLabel} htmlFor="wizard-free-text">
                            Anything else? (in your own words)
                        </label>
                        <textarea
                            id="wizard-free-text"
                            className={styles.textArea}
                            rows={3}
                            placeholder="e.g. I prefer lighter falls, or no early-morning classes…"
                            value={state.values.freeText}
                            onChange={(e) => setFreeText(e.target.value)}
                        />
                        <p className={styles.hint}>
                            We&apos;ll treat this as a preference (a soft objective), not a hard
                            requirement.
                        </p>
                    </div>
                )}

                {state.step === "plan" && (
                    <div className={styles.stepBody}>
                        <p className={styles.placeholder}>
                            You're all set — we'll build your plan from your DPR and your choices
                            (defaults applied for anything you skipped).
                        </p>
                    </div>
                )}
            </div>

            {/* Footer controls — Back · Skip (optional steps) · Next/Finish
                · "Skip all → see my plan" (the no-dead-end affordance). */}
            <footer className={styles.footer}>
                <div className={styles.footerLeft}>
                    <button
                        type="button"
                        className={styles.ghostBtn}
                        onClick={back}
                        disabled={stepIndex === 0}
                    >
                        Back
                    </button>
                </div>

                <div className={styles.footerRight}>
                    {!onPlan && (
                        <button type="button" className={styles.linkBtn} onClick={skipEverything}>
                            Skip all → see my plan
                        </button>
                    )}
                    {isOptionalStep(state.step) && (
                        <button type="button" className={styles.ghostBtn} onClick={skip}>
                            Skip
                        </button>
                    )}
                    {!onPlan && state.step !== "upload" && (
                        <button type="button" className={styles.primaryBtn} onClick={advance}>
                            {state.step === "preferences" ? "See my plan" : "Next"}
                        </button>
                    )}
                    {onPlan && (
                        <button
                            type="button"
                            className={styles.primaryBtn}
                            onClick={() => onReachPlan?.(state.values, parsedDpr)}
                        >
                            Build my plan
                        </button>
                    )}
                    {onDismiss && (
                        <button type="button" className={styles.linkBtn} onClick={onDismiss}>
                            Use chat instead
                        </button>
                    )}
                </div>
            </footer>
        </section>
    );
}
