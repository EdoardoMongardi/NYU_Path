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

import { useCallback, useRef, useState } from "react";
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
    onReachPlan?: (values: WizardValues, dpr: unknown | null) => void;
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
    const [parsedDpr, setParsedDpr] = useState<unknown | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const stepIndex = WIZARD_STEPS.indexOf(state.step);
    const totalSteps = WIZARD_STEPS.length;
    const onPlan = state.step === "plan";

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
                const data = await res.json();
                if (!res.ok) {
                    setUploadError(data?.message ?? "Upload failed. Please try again.");
                    return;
                }
                if (data?.parsedData) setParsedDpr(data.parsedData);
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

                {state.step !== "upload" && state.step !== "plan" && (
                    // E5.1 placeholder bodies — E5.2–E5.4 flesh these out.
                    // Every field here is defaulted in the machine and the
                    // step is Skippable, so this placeholder never blocks
                    // the path to Plan.
                    <div className={styles.stepBody}>
                        <p className={styles.placeholder}>
                            {STEP_TITLES[state.step]} — coming next. This step is optional; its
                            sensible defaults already apply.
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
