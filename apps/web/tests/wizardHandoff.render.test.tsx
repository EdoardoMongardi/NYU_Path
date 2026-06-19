// @vitest-environment jsdom
// ============================================================
// F1 fix — wizard→chat HANDOFF render test (page-level)
// ============================================================
// The mounted-wizard render test (mountedWizard.render.test.tsx) stops
// at "`onReachPlan` fired" — it mounts `<OnboardingWizard>` in isolation
// with a no-op callback and asserts the callback. It therefore CANNOT
// catch the bug this file guards: the chat page's `onReachPlan` consumer
// (`handleWizardReachPlan`) must (a) flip `onboardingStep → "complete"` +
// set `parsedData` so FUTURE turns route through the v2 agent loop, and
// (b) thread the just-uploaded DPR into the IMMEDIATE preference-turn seed
// so the same-tick injection carries it despite React state being async
// (the I2 stale-closure race extended to the DPR itself). Before the fix
// the handoff ignored the DPR entirely: every later turn fell to the
// legacy `/api/chat` v1 route and the sidebar stayed empty.
//
// SCOPE — this mounts the FULL `ChatPage` (the default export of
// `app/chat/page.tsx`) in jsdom and drives the live wizard to its handoff,
// then asserts the resulting turn hits `/api/chat/v2` (NOT the legacy
// `/api/chat`). That endpoint assertion is the clean, deterministic signal
// that `onboardingStep`/`parsedData` flipped — exactly what the bug broke.
//
// HANDOFF TIMING (important) — the wizard fires `onReachPlan` EXCLUSIVELY
// from the terminal "Build my plan" button's onClick (an event handler), NOT
// from its `advance`/`skip`/`skipAll` transitions. Those transitions are pure
// state changes that just LAND the student on the `plan` step; firing the
// handoff inside their setState updater used to update the parent (`ChatPage`)
// during render (React's "Cannot update a component while rendering" warning)
// and double-fired the handoff. So these tests drive the wizard to the `plan`
// step and then CLICK "Build my plan" to trigger the handoff. With a DPR
// present, that handoff flips onboarding to "complete", which UNMOUNTS the
// wizard (its mount is gated on `onboardingStep === "awaiting_dpr"`). So they
// assert against the POST-handoff chat surface (the textarea placeholder flips
// to "Type your message…"), not a lingering "Build my plan" button.
//
// HERMETIC — every network call the page makes is stubbed on
// `global.fetch`, keyed by URL, and recorded so tests can assert WHICH
// endpoint a turn hit and WHAT body it carried:
//   - GET  /api/session/restore → 401 (anonymous → no prior session →
//                                  `awaiting_dpr` so the wizard mounts).
//   - POST /api/onboard         → the parsed-DPR shape the wizard's upload
//                                  handler expects.
//   - POST /api/chat/v2         → a minimal one-event SSE stream over a
//                                  real ReadableStream (what streamChatV2
//                                  reads via response.body.getReader()).
//   - POST /api/chat            → recorded so we can ASSERT it is NOT hit
//                                  post-handoff (the bug routed here).
//
// MOUNT STUBS — jsdom lacks `Element.prototype.scrollIntoView` (the page
// calls it on every addMessage) and may lack `crypto.randomUUID` (used by
// `getOrCreateClientId` on the first chat send); we stub both.
// `requestAnimationFrame` + `localStorage` already exist in jsdom.
// ============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DegreeProgressReport } from "@nyupath/engine";
import ChatPage from "../app/chat/page";

afterEach(() => cleanup());

// The minimal DPR the /api/onboard stub returns. `courseHistory: []` keeps
// `buildStudentProfileFromDpr` (the sidebar derive) from iterating over
// undefined; no school indicator keeps the home-school proposal
// school-agnostic (the Confirm-profile step is skippable either way).
const MINIMAL_DPR = {
    header: { studentName: "Test Student" },
    programs: [],
    courseHistory: [],
    advisorNotations: [],
} as unknown as DegreeProgressReport;

/** A one-event SSE stream ("done") over a real ReadableStream, matching
 *  what `streamChatV2` reads via `response.body.getReader()`. */
function makeSseResponse(finalText: string): Response {
    const payload = JSON.stringify({ kind: "done", finalText });
    const block = `event: done\ndata: ${payload}\n\n`;
    const bytes = new TextEncoder().encode(block);
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    return { ok: true, status: 200, body, json: async () => ({}) } as unknown as Response;
}

/** Records each fetch call's URL + parsed JSON body so tests can assert
 *  WHICH endpoint a turn hit and WHAT it carried. */
interface FetchCall {
    url: string;
    method: string;
    body: unknown;
}

function installFetchMock(): { calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        let parsedBody: unknown = undefined;
        if (typeof init?.body === "string") {
            try {
                parsedBody = JSON.parse(init.body);
            } catch {
                parsedBody = init.body;
            }
        } else if (init?.body !== undefined) {
            parsedBody = "[FormData]"; // the /api/onboard upload
        }
        calls.push({ url, method, body: parsedBody });

        if (url.startsWith("/api/session/restore")) {
            // Anonymous — no prior session. The page's restore effect bails
            // on !res.ok, leaving onboardingStep="awaiting_dpr" → wizard mounts.
            return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
        }
        if (url.startsWith("/api/onboard")) {
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    message: "Parsed your DPR.",
                    parsedData: { kind: "dpr", report: MINIMAL_DPR },
                }),
            } as unknown as Response;
        }
        if (url.startsWith("/api/chat/v2")) {
            return makeSseResponse("Here is your plan.");
        }
        if (url.startsWith("/api/chat")) {
            // The LEGACY v1 route — the bug routed post-handoff turns here.
            return { ok: true, status: 200, json: async () => ({ message: "v1 reply" }) } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls };
}

/** Skip an optional wizard step by its title (scoped to the wizard
 *  section so we never grab an unrelated "Skip"). */
async function skipStep(title: string): Promise<void> {
    const section = screen.getByText(title).closest("section")!;
    fireEvent.click(within(section).getByText("Skip"));
    await act(async () => {
        await Promise.resolve();
    });
}

/** Drive the wizard's Upload step: fire the hidden file input's change (a
 *  jsdom file-picker click is a no-op) and wait for the parse to advance. */
async function uploadDpr(container: HTMLElement): Promise<void> {
    const fileInput = container.querySelector(
        'section[aria-label="Onboarding wizard"] input[type="file"]',
    ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    const pdf = new File(["%PDF-1.4 fake"], "dpr.pdf", { type: "application/pdf" });
    await act(async () => {
        fireEvent.change(fileInput, { target: { files: [pdf] } });
    });
    await screen.findByText("Confirm your profile");
}

const v2Turns = (calls: FetchCall[]) => calls.filter((c) => c.url.startsWith("/api/chat/v2"));
const v1PostTurns = (calls: FetchCall[]) =>
    calls.filter((c) => c.url === "/api/chat" && c.method === "POST");

beforeEach(() => {
    vi.unstubAllGlobals();
    // jsdom lacks scrollIntoView; the page calls it on every addMessage.
    Element.prototype.scrollIntoView = vi.fn();
    // getOrCreateClientId reads crypto.randomUUID on the first send.
    if (!globalThis.crypto) {
        // @ts-expect-error — minimal shim for environments without crypto.
        globalThis.crypto = {};
    }
    if (typeof globalThis.crypto.randomUUID !== "function") {
        // @ts-expect-error — test shim.
        globalThis.crypto.randomUUID = () => "test-uuid-0000";
    }
});

describe("F1 fix — wizard→chat handoff completes onboarding", () => {
    it("upload DPR → reach plan → a FUTURE chat turn routes to /api/chat/v2 (NOT /api/chat)", async () => {
        const { calls } = installFetchMock();
        const { container } = render(<ChatPage />);
        await screen.findByText("Upload your DPR");

        await uploadDpr(container);

        // Skip confirm_profile; on Goals, choose visa explicitly (H1 requires
        // it before "Build my plan" is enabled — a silently-defaulted "domestic"
        // for an F-1 student would suppress the 12-credit floor advisory).
        // All other optional fields stay at their defaults; preferences is skipped.
        await skipStep("Confirm your profile");
        await screen.findByText("Your goals");
        // H1 — choose visa on the Goals step so canBuildPlan returns true.
        const goalsSection = screen.getByText("Your goals").closest("section")!;
        await act(async () => {
            fireEvent.change(within(goalsSection).getByRole("combobox"), { target: { value: "domestic" } });
        });
        fireEvent.click(within(goalsSection).getByText("Next"));
        await screen.findByText("Your preferences");
        await skipStep("Your preferences");

        // On the terminal plan step — click "Build my plan" to fire the
        // handoff with the parsed DPR → completes onboarding → unmounts.
        await screen.findByText("Your plan");
        await act(async () => {
            fireEvent.click(screen.getByText("Build my plan"));
        });

        // Handoff completed onboarding: the wizard unmounted and the chat
        // input placeholder flipped from the awaiting_dpr copy.
        await waitFor(() => {
            expect(
                container.querySelector('section[aria-label="Onboarding wizard"]'),
            ).toBeNull();
        });
        const textarea = screen.getByPlaceholderText(/Type your message/i) as HTMLTextAreaElement;

        // No preference turn fired (all defaults).
        expect(v2Turns(calls).length).toBe(0);

        // Drive a FUTURE chat turn the way a student would: type + send.
        // This is the turn the BUG dropped to the legacy v1 route.
        fireEvent.change(textarea, { target: { value: "what should I take next?" } });
        const sendBtn = textarea.parentElement!.querySelector("button")!;
        await act(async () => {
            fireEvent.click(sendBtn);
        });

        // The post-handoff turn MUST hit the v2 agent loop, proving
        // onboardingStep flipped to "complete" AND parsedData is set.
        await waitFor(() => {
            expect(v2Turns(calls).length).toBeGreaterThan(0);
        });
        // And it must NOT have fallen to the legacy v1 route.
        expect(v1PostTurns(calls).length).toBe(0);

        // The v2 turn must carry the just-uploaded DPR in its parsedData.
        const v2Turn = v2Turns(calls)[0]!;
        expect((v2Turn.body as { parsedData?: { kind?: string } }).parsedData?.kind).toBe("dpr");
    });

    it("a non-default preference fires an IMMEDIATE v2 turn that carries the DPR via the seed (stale-closure fix)", async () => {
        const { calls } = installFetchMock();
        const { container } = render(<ChatPage />);
        await screen.findByText("Upload your DPR");
        await uploadDpr(container);

        // Skip to Preferences, then set a NON-default workload so
        // buildPreferenceTurns emits ONE turn — the IMMEDIATE injection that
        // runs in the SAME tick as the parsedData/step setters. Without the
        // seed threading the DPR, this turn's parsedData would be null
        // (stale closure) and the turn would mis-route.
        //
        // H1 — visa must be explicitly chosen before "Build my plan" enables.
        // We choose it on Goals (then Next) to satisfy canBuildPlan while
        // keeping other values at their defaults for the preference-turn test.
        await skipStep("Confirm your profile");
        await screen.findByText("Your goals");
        const goalsSection2 = screen.getByText("Your goals").closest("section")!;
        await act(async () => {
            fireEvent.change(within(goalsSection2).getByRole("combobox"), { target: { value: "domestic" } });
        });
        fireEvent.click(within(goalsSection2).getByText("Next"));
        await screen.findByText("Your preferences");

        const workload = screen.getByLabelText("Course-load distribution") as HTMLSelectElement;
        fireEvent.change(workload, { target: { value: "frontload" } });

        // "See my plan" advances preferences → plan (a pure transition, no
        // handoff yet). On the plan step, "Build my plan" fires the handoff
        // with the non-default workload, which injects exactly one preference
        // turn — the IMMEDIATE injection that runs in the SAME tick as the
        // parsedData/step setters.
        const section = screen.getByText("Your preferences").closest("section")!;
        await act(async () => {
            fireEvent.click(within(section).getByText("See my plan"));
        });
        await screen.findByText("Your plan");
        await act(async () => {
            fireEvent.click(screen.getByText("Build my plan"));
        });

        // That immediate preference turn MUST have hit v2 (not v1) and
        // carried the DPR via the seed.
        await waitFor(() => {
            expect(v2Turns(calls).length).toBeGreaterThan(0);
        });
        const v2Turn = v2Turns(calls)[0]!;
        expect((v2Turn.body as { parsedData?: { kind?: string } }).parsedData?.kind).toBe("dpr");
        expect(v1PostTurns(calls).length).toBe(0);
    });

    it("NO DPR → 'Skip all' is gated, so the student cannot reach 'Build my plan' without uploading (DPR mandatory)", async () => {
        const { calls } = installFetchMock();
        const { container } = render(<ChatPage />);
        await screen.findByText("Upload your DPR");

        // The DPR is MANDATORY (no DPR → no personalized plan). The no-dead-end
        // "Skip all → see my plan" affordance is therefore NOT offered until a
        // DPR is uploaded, so there is no UI path to the plan step / "Build my
        // plan" with a null DPR (which would derive no plan — the bug this
        // gate fixes). Uploading is the only way forward (a successful parse
        // auto-advances past Upload).
        expect(screen.queryByText("Skip all → see my plan")).toBeNull();
        expect(screen.queryByText("Build my plan")).toBeNull();

        // No plan was fabricated, and /api/onboard was never called (no upload).
        expect(v2Turns(calls).length).toBe(0);
        expect(calls.some((c) => c.url.startsWith("/api/onboard"))).toBe(false);
        expect(v1PostTurns(calls).length).toBe(0);

        // The wizard stays mounted on Upload (awaiting_dpr) so the student can
        // upload their DPR.
        expect(
            container.querySelector('section[aria-label="Onboarding wizard"]'),
        ).not.toBeNull();
    });
});
