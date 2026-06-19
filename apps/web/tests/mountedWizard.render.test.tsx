// @vitest-environment jsdom
// ============================================================
// F1 — mounted-wizard RENDER test (the first DOM render test in the repo)
// ============================================================
// Phase 4 follow-up F1 mounts `OnboardingWizard` as the LIVE onboarding
// surface in `app/chat/page.tsx` for the `awaiting_dpr` state. The pure
// `wizardMachine` already has node-level unit coverage
// (apps/web/tests/wizardShell.test.ts); THIS test proves the React shell
// actually renders + drives to the terminal "Build my plan" handoff in a
// real DOM (jsdom), which the node-only suite can't.
//
// SCOPE — we render `<OnboardingWizard …>` DIRECTLY rather than mounting
// the whole `ChatPage`: the page does a session-restore fetch + opens an
// SSE stream on mount and is far too fragile for a deterministic unit-
// level render. The wizard is the unit under test here; its handoff to
// the chat page is just the `onReachPlan` callback, which we assert fires.
//
// jsdom env is declared PER-FILE via the docblock above (the repo's other
// tests stay on the node environment — see the vitest `include` glob's
// `*.test.{ts,tsx}` extension + the per-file note there). No global jsdom
// env, no shared setup file.
//
// HERMETIC: the wizard only touches the network on its Upload step
// (`POST /api/onboard`). We stub `global.fetch` so the one test that
// exercises Upload is deterministic; the no-dead-end "Skip all" path
// never calls fetch at all.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DegreeProgressReport } from "@nyupath/engine";
import OnboardingWizard from "../app/chat/wizard/OnboardingWizard";
import type { WizardValues } from "../lib/wizard/wizardMachine";

// Minimal DPR fixture reused across tests.
const minimalDpr = {
    header: { studentName: "Test Student" },
    programs: [],
    courseHistory: [],
    advisorNotations: [],
} as unknown as DegreeProgressReport;

// React Testing Library's auto-cleanup hook only registers when the test
// framework exposes a global `afterEach`; we register it explicitly so each
// test starts from a clean DOM regardless of config.
afterEach(() => cleanup());

describe("F1 — mounted OnboardingWizard render", () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it("renders the first step (Upload your DPR) on mount", () => {
        render(<OnboardingWizard onReachPlan={vi.fn()} />);
        // The Upload step title + its data-source affordance are visible.
        expect(screen.queryByText("Upload your DPR")).not.toBeNull();
        expect(screen.queryByText("Choose DPR PDF")).not.toBeNull();
        // Step indicator starts at 1/5.
        expect(screen.queryByText("Step 1/5")).not.toBeNull();
    });

    it("does NOT offer 'Skip all' on the Upload step without a DPR — the DPR is mandatory", () => {
        const onReachPlan = vi.fn<(values: WizardValues, dpr: DegreeProgressReport | null) => void>();
        render(<OnboardingWizard onReachPlan={onReachPlan} />);

        // We start on the Upload step (1/5). The DPR is MANDATORY (no DPR → no
        // personalized plan; core philosophy), so the no-dead-end
        // "Skip all → see my plan" affordance is NOT rendered here — uploading
        // is the only way forward (a successful parse auto-advances past
        // Upload). Without this gate, Skip-all jumped straight to "Build my
        // plan" with a null DPR, which derives no plan.
        expect(screen.queryByText("Step 1/5")).not.toBeNull();
        expect(screen.queryByText("Skip all → see my plan")).toBeNull();
        // The Upload step also has no "Next" (the upload itself advances), so
        // there is no path past Upload without a DPR.
        expect(screen.queryByText("Next")).toBeNull();
        expect(onReachPlan).not.toHaveBeenCalled();
    });

    it("advances past Upload by parsing a DPR, then Skips each optional step to reach 'Build my plan'", async () => {
        // Mock the /api/onboard parse the Upload step POSTs to. The wizard
        // only needs `parsedData.report` back to advance + derive the
        // home-school proposal; this is the SAME minimal-DPR shape
        // buildSessionFromDpr.test.ts uses for the classifier surface
        // (`courseHistory: []` so `buildStudentProfileFromDpr` doesn't
        // iterate over undefined). No school indicator → the proposal stays
        // school-agnostic, but the Confirm-profile step is skippable either
        // way so the path to Plan is unaffected.
        const fetchMock = vi.fn(
            async (_input: RequestInfo | URL, _init?: RequestInit) =>
                ({
                    ok: true,
                    json: async () => ({ parsedData: { kind: "dpr", report: minimalDpr } }),
                }) as unknown as Response,
        );
        vi.stubGlobal("fetch", fetchMock);

        const onReachPlan = vi.fn<(values: WizardValues, dpr: DegreeProgressReport | null) => void>();
        const { container } = render(<OnboardingWizard onReachPlan={onReachPlan} />);

        // Drive the hidden file input directly (a jsdom file-picker click is a
        // no-op, so we fire the change the picker would have produced).
        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
        expect(fileInput).not.toBeNull();
        const pdf = new File(["%PDF-1.4 fake"], "dpr.pdf", { type: "application/pdf" });
        fireEvent.change(fileInput, { target: { files: [pdf] } });

        // The upload handler is async (awaits fetch + json); let microtasks
        // flush so the wizard advances off the Upload step.
        await screen.findByText("Confirm your profile");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith("/api/onboard", expect.anything());

        // confirm_profile is skippable — skip it.
        fireEvent.click(within(screen.getByText("Confirm your profile").closest("section")!).getByText("Skip"));
        await screen.findByText("Your goals");

        // H1 — visa must be EXPLICITLY chosen before "Build my plan" is enabled.
        // On the Goals step, select F-1 to mark visaChosen = true, then advance.
        const goalsSection = screen.getByText("Your goals").closest("section")!;
        const visaSelect = within(goalsSection).getByRole("combobox") as HTMLSelectElement;
        fireEvent.change(visaSelect, { target: { value: "f1" } });
        fireEvent.click(within(goalsSection).getByText("Next"));

        await screen.findByText("Your preferences");
        fireEvent.click(within(screen.getByText("Your preferences").closest("section")!).getByText("Skip"));

        // Terminal Plan step reached with visa explicitly chosen.
        await screen.findByText("Your plan");
        expect(screen.queryByText("Step 5/5")).not.toBeNull();

        // "Build my plan" is now ENABLED (DPR present + visa chosen).
        // It hands the collected values (+ the parsed DPR) off.
        onReachPlan.mockClear();
        const buildBtn = screen.getByText("Build my plan") as HTMLButtonElement;
        expect(buildBtn.disabled).toBe(false);
        fireEvent.click(buildBtn);
        expect(onReachPlan).toHaveBeenCalledTimes(1);
        const [, dpr] = onReachPlan.mock.calls[0]!;
        expect(dpr).toBe(minimalDpr);
    });
});

// ---------------------------------------------------------------------------
// H1 — "Build my plan" is disabled until BOTH a DPR and visa are present.
// ---------------------------------------------------------------------------

describe("H1 — visa is mandatory before Build my plan", () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    /** Helper: upload a DPR (via mocked fetch) and walk to the plan step,
     *  skipping ALL optional steps (so visa stays at default = unchosen). */
    async function uploadDprAndSkipToPlanning() {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                json: async () => ({ parsedData: { kind: "dpr", report: minimalDpr } }),
            })),
        );
        const onReachPlan = vi.fn<(values: WizardValues, dpr: DegreeProgressReport | null) => void>();
        const { container } = render(<OnboardingWizard onReachPlan={onReachPlan} />);

        // Upload DPR.
        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
        const pdf = new File(["%PDF-1.4 fake"], "dpr.pdf", { type: "application/pdf" });
        fireEvent.change(fileInput, { target: { files: [pdf] } });
        await screen.findByText("Confirm your profile");

        // Skip all optional steps → land on plan WITHOUT choosing visa.
        fireEvent.click(within(screen.getByText("Confirm your profile").closest("section")!).getByText("Skip"));
        await screen.findByText("Your goals");
        fireEvent.click(within(screen.getByText("Your goals").closest("section")!).getByText("Skip"));
        await screen.findByText("Your preferences");
        fireEvent.click(within(screen.getByText("Your preferences").closest("section")!).getByText("Skip"));
        await screen.findByText("Your plan");

        return { onReachPlan, container };
    }

    it("'Build my plan' is DISABLED when DPR is present but visa was never explicitly chosen", async () => {
        await uploadDprAndSkipToPlanning();
        const buildBtn = screen.getByText("Build my plan") as HTMLButtonElement;
        expect(buildBtn.disabled).toBe(true);
    });

    it("'Build my plan' shows a tooltip explaining what is missing (visa)", async () => {
        await uploadDprAndSkipToPlanning();
        const buildBtn = screen.getByText("Build my plan") as HTMLButtonElement;
        // The title attribute carries the hint so assistive tech + hover can surface it.
        expect(buildBtn.title).toMatch(/visa/i);
    });

    it("clicking disabled 'Build my plan' does NOT fire onReachPlan", async () => {
        const { onReachPlan } = await uploadDprAndSkipToPlanning();
        const buildBtn = screen.getByText("Build my plan") as HTMLButtonElement;
        expect(buildBtn.disabled).toBe(true);
        fireEvent.click(buildBtn);
        expect(onReachPlan).not.toHaveBeenCalled();
    });

    it("'Build my plan' ENABLES after choosing a visa on confirm_profile", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({
                ok: true,
                json: async () => ({ parsedData: { kind: "dpr", report: minimalDpr } }),
            })),
        );
        const onReachPlan = vi.fn<(values: WizardValues, dpr: DegreeProgressReport | null) => void>();
        const { container } = render(<OnboardingWizard onReachPlan={onReachPlan} />);

        // Upload DPR.
        const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
        const pdf = new File(["%PDF-1.4 fake"], "dpr.pdf", { type: "application/pdf" });
        fireEvent.change(fileInput, { target: { files: [pdf] } });
        await screen.findByText("Confirm your profile");

        // Choose visa on confirm_profile (the wizard-visa-status select).
        const visaSelect = screen.getByLabelText("Visa status") as HTMLSelectElement;
        fireEvent.change(visaSelect, { target: { value: "domestic" } });

        // Skip the rest.
        fireEvent.click(within(screen.getByText("Confirm your profile").closest("section")!).getByText("Skip"));
        await screen.findByText("Your goals");
        fireEvent.click(within(screen.getByText("Your goals").closest("section")!).getByText("Skip"));
        await screen.findByText("Your preferences");
        fireEvent.click(within(screen.getByText("Your preferences").closest("section")!).getByText("Skip"));
        await screen.findByText("Your plan");

        // Button is now ENABLED — visa was explicitly chosen.
        const buildBtn = screen.getByText("Build my plan") as HTMLButtonElement;
        expect(buildBtn.disabled).toBe(false);

        fireEvent.click(buildBtn);
        expect(onReachPlan).toHaveBeenCalledTimes(1);
        const [values, dpr] = onReachPlan.mock.calls[0]!;
        expect(dpr).toBe(minimalDpr);
        expect(values.visa).toBe("domestic");
        expect(values.visaChosen).toBe(true);
    });
});
