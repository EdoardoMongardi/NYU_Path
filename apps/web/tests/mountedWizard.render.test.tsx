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

    it("reaches Plan via the no-dead-end 'Skip all' path WITHOUT a DPR, then 'Build my plan' is the SOLE onReachPlan trigger", () => {
        const onReachPlan = vi.fn<(values: WizardValues, dpr: DegreeProgressReport | null) => void>();
        render(<OnboardingWizard onReachPlan={onReachPlan} />);

        // From the Upload step, the no-dead-end affordance jumps straight to
        // Plan with all defaults — no DPR, no network, no dead end.
        fireEvent.click(screen.getByText("Skip all → see my plan"));

        // We're on the terminal Plan step now — the student SEES the plan
        // confirmation + the "Build my plan" button (consistent with the
        // "Skip all → see my plan" label). Reaching plan does NOT fire the
        // handoff: the transition is a pure state change, never a parent
        // update during render. `onReachPlan` is the button's sole trigger.
        expect(screen.queryByText("Your plan")).not.toBeNull();
        expect(screen.queryByText("Step 5/5")).not.toBeNull();
        expect(onReachPlan).not.toHaveBeenCalled();

        // The terminal "Build my plan" button is present and, when clicked,
        // fires onReachPlan ONCE with the collected (all-default) values.
        const buildBtn = screen.getByText("Build my plan");
        fireEvent.click(buildBtn);
        expect(onReachPlan).toHaveBeenCalledTimes(1);
        const [values] = onReachPlan.mock.calls[0]!;
        // No DPR was uploaded on this path → home school stays the
        // never-silent-CAS empty default, and defaults flow through.
        expect(values.homeSchool).toBe("");
        expect(values.visa).toBe("domestic");
        expect(values.workload).toBe("balanced");
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
        const minimalDpr = {
            header: { studentName: "Test Student" },
            programs: [],
            courseHistory: [],
            advisorNotations: [],
        } as unknown as DegreeProgressReport;
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

        // confirm_profile → goals → preferences are each optional + skippable.
        // Use the Skip affordance on each to walk to Plan WITHOUT dead-ending.
        fireEvent.click(within(screen.getByText("Confirm your profile").closest("section")!).getByText("Skip"));
        await screen.findByText("Your goals");
        fireEvent.click(within(screen.getByText("Your goals").closest("section")!).getByText("Skip"));
        await screen.findByText("Your preferences");
        fireEvent.click(within(screen.getByText("Your preferences").closest("section")!).getByText("Skip"));

        // Terminal Plan step reached by skipping every optional step.
        await screen.findByText("Your plan");
        expect(screen.queryByText("Step 5/5")).not.toBeNull();

        // "Build my plan" hands the collected values (+ the parsed DPR) off.
        onReachPlan.mockClear();
        fireEvent.click(screen.getByText("Build my plan"));
        expect(onReachPlan).toHaveBeenCalledTimes(1);
        const [, dpr] = onReachPlan.mock.calls[0]!;
        expect(dpr).toBe(minimalDpr);
    });
});
