// @vitest-environment jsdom
// ============================================================
// H2.3 — ScheduleWorkspace render test (jsdom, @testing-library/react)
// ============================================================
// TDD RED phase: these tests are written BEFORE the component exists.
//
// Covers:
//   (1) pinned "My Plan" (committed) tab is always present + NO "+ New what-if" control.
//   (2) clicking a scenario tab calls setActive (active body changes).
//   (3) proposed body shows Confirm / Cancel / Ask-why buttons + hedges.
//   (4) whatif body shows "Keep" / "Discard" buttons + the read-only note.
//   (5) ✕ on a scenario tab discards it (calls discardScenario).
//   (6) Compare toggle enters compare mode (calls openCompare + renders placeholder).
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ForwardSchedule } from "@nyupath/shared";
import { createPlanStore, type Scenario } from "../app/chat/planState";
import ScheduleWorkspace from "../app/chat/workspace/ScheduleWorkspace";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal ForwardSchedule — only the fields ScheduleView reads. */
function makeSchedule(tag: string): ForwardSchedule {
    return {
        state: "valid-clean",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        semesters: [],
        assumptions: [],
        balanceScore: 1.0,
        studentId: tag,
        homeSchoolId: "CAS",
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        dprCourseHistoryHash: tag,
        computedAt: 0,
    } as unknown as ForwardSchedule;
}

let seq = 0;
function makeProposedScenario(overrides: Partial<Scenario> = {}): Scenario {
    return {
        id: `sc-proposed-${seq++}`,
        kind: "proposed",
        label: "Withdraw MATH-UA 325",
        schedule: makeSchedule("proposed"),
        verdict: "trade-offs",
        hedges: ["Assumes you withdraw from MATH-UA 325 — verify the deadline."],
        pendingMutationId: `pmid-${seq}`,
        createdAt: seq * 1000,
        ...overrides,
    };
}

function makeWhatifScenario(overrides: Partial<Scenario> = {}): Scenario {
    return {
        id: `wi-${seq++}`,
        kind: "whatif",
        label: "+ Economics minor",
        schedule: makeSchedule("whatif"),
        verdict: "valid",
        hedges: ["Read-only exploration — not your real plan."],
        createdAt: seq * 1000,
        ...overrides,
    };
}

/** Build a store pre-seeded with committed + one proposed + one whatif. */
function buildStore() {
    const committed = makeSchedule("committed");
    const store = createPlanStore({ forwardSchedule: committed });
    const proposed = makeProposedScenario();
    const whatif = makeWhatifScenario();
    store.addScenario(proposed);
    // After addScenario(proposed), proposed is active. Add whatif but keep proposed active.
    store.addScenario(whatif);
    // setActive back to proposed so the body renders proposed by default.
    store.setActive(proposed.id);
    return { store, committed, proposed, whatif };
}

// ---------------------------------------------------------------------------
// (1) Tab bar — committed tab present + NO "+ New what-if" control
// ---------------------------------------------------------------------------

describe("ScheduleWorkspace — tab bar invariants", () => {
    it("renders the pinned My Plan (committed) tab", () => {
        const { store } = buildStore();
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        // "My Plan" should be in the tab bar (look inside the committed tab button)
        const committedTab = container.querySelector("[data-tab='committed']");
        expect(committedTab).not.toBeNull();
        expect(committedTab?.textContent).toMatch(/My Plan/i);
    });

    it("renders a tab for the proposed scenario", () => {
        const { store, proposed } = buildStore();
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        const proposedTab = container.querySelector(`[data-tab='${proposed.id}']`);
        expect(proposedTab).not.toBeNull();
        expect(proposedTab?.textContent).toMatch(new RegExp(proposed.label.replace(/[+.?*]/g, "\\$&"), "i"));
    });

    it("renders a tab for the whatif scenario", () => {
        const { store, whatif } = buildStore();
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        const whatifTab = container.querySelector(`[data-tab='${whatif.id}']`);
        expect(whatifTab).not.toBeNull();
        // just check kind badge is present
        expect(whatifTab?.textContent).toMatch(/What-if|Economics/i);
    });

    it("does NOT render a '+ New what-if' control", () => {
        const { store } = buildStore();
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        // No "new what-if" add button (owner decision: what-ifs created from chat only)
        expect(screen.queryByText(/new what.?if/i)).toBeNull();
    });

    it("the committed tab has NO close button (✕)", () => {
        const { store } = buildStore();
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        // Find the committed tab and confirm it contains no close button
        // We use data-testid approach: the committed tab should have data-tab="committed"
        const committedTab = container.querySelector("[data-tab='committed']");
        expect(committedTab).not.toBeNull();
        const closeInCommitted = committedTab?.querySelector("[data-close]");
        expect(closeInCommitted).toBeNull();
    });

    it("scenario tabs have a close (✕) button", () => {
        const { store, proposed } = buildStore();
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        const proposedTab = container.querySelector(`[data-tab='${proposed.id}']`);
        expect(proposedTab).not.toBeNull();
        const closeBtn = proposedTab?.querySelector("[data-close]");
        expect(closeBtn).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (2) Clicking a scenario tab switches active body
// ---------------------------------------------------------------------------

describe("ScheduleWorkspace — tab switching", () => {
    it("clicking the committed tab switches the active body to committed", () => {
        const { store, proposed } = buildStore();
        // proposed is currently active
        expect(store.getActiveScenario()?.id).toBe(proposed.id);
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        const committedTab = container.querySelector("[data-tab='committed']") as HTMLElement;
        fireEvent.click(committedTab);
        // Store should now have committed as active
        expect(store.getActiveScenario()?.kind).toBe("committed");
    });

    it("clicking a scenario tab calls store.setActive with that id", () => {
        const { store, whatif } = buildStore();
        // Spy on setActive
        const setActiveSpy = vi.spyOn(store, "setActive");
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        const whatifTab = container.querySelector(`[data-tab='${whatif.id}']`) as HTMLElement;
        fireEvent.click(whatifTab);
        expect(setActiveSpy).toHaveBeenCalledWith(whatif.id);
    });
});

// ---------------------------------------------------------------------------
// (3) Proposed body — Confirm / Cancel / Ask-why + hedges
// ---------------------------------------------------------------------------

describe("ScheduleWorkspace — proposed scenario body", () => {
    it("shows Confirm button for a proposed scenario", () => {
        const { store } = buildStore();
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        expect(screen.getByRole("button", { name: /confirm/i })).toBeTruthy();
    });

    it("shows Cancel button for a proposed scenario", () => {
        const { store } = buildStore();
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        expect(screen.getByRole("button", { name: /cancel/i })).toBeTruthy();
    });

    it("shows Ask why button for a proposed scenario", () => {
        const { store } = buildStore();
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        expect(screen.getByRole("button", { name: /ask why/i })).toBeTruthy();
    });

    it("shows the hedge text for a proposed scenario", () => {
        const { store, proposed } = buildStore();
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        // The hedge from the proposed scenario should appear in the body
        expect(screen.getByText(/verify the deadline/i)).toBeTruthy();
        expect(proposed.hedges).toBeDefined(); // fixture check
    });

    it("Confirm calls onConfirmProposed with the scenario", () => {
        const { store, proposed } = buildStore();
        const onConfirm = vi.fn();
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={onConfirm} onAskWhy={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
        expect(onConfirm).toHaveBeenCalledWith(proposed);
    });

    it("Cancel calls discardScenario with the scenario id", () => {
        const { store, proposed } = buildStore();
        const discardSpy = vi.spyOn(store, "discardScenario");
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
        expect(discardSpy).toHaveBeenCalledWith(proposed.id);
    });

    it("Ask why calls onAskWhy with the scenario", () => {
        const { store, proposed } = buildStore();
        const onAskWhy = vi.fn();
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={onAskWhy} />);
        fireEvent.click(screen.getByRole("button", { name: /ask why/i }));
        expect(onAskWhy).toHaveBeenCalledWith(proposed);
    });
});

// ---------------------------------------------------------------------------
// (4) Whatif body — Keep / Discard + read-only note
// ---------------------------------------------------------------------------

describe("ScheduleWorkspace — whatif scenario body", () => {
    it("shows Keep and Discard buttons for a whatif scenario", () => {
        const { store, whatif } = buildStore();
        // Activate the whatif scenario
        store.setActive(whatif.id);
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        expect(screen.getByRole("button", { name: /keep/i })).toBeTruthy();
        expect(screen.getByRole("button", { name: /discard/i })).toBeTruthy();
    });

    it("shows the read-only note for a whatif scenario", () => {
        const { store, whatif } = buildStore();
        store.setActive(whatif.id);
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        // The read-only note must mention "Read-only" and "Albert"
        // Use getAllByText since the hedge block and note may both mention read-only
        expect(screen.getAllByText(/read-only/i).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Albert/i).length).toBeGreaterThan(0);
    });

    it("shows the hedge text for a whatif scenario", () => {
        const { store, whatif } = buildStore();
        store.setActive(whatif.id);
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        expect(screen.getByText(/Read-only exploration/i)).toBeTruthy();
    });

    it("Discard calls discardScenario with the whatif id", () => {
        const { store, whatif } = buildStore();
        store.setActive(whatif.id);
        const discardSpy = vi.spyOn(store, "discardScenario");
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        fireEvent.click(screen.getByRole("button", { name: /discard/i }));
        expect(discardSpy).toHaveBeenCalledWith(whatif.id);
    });

    it("does NOT show Confirm button for a whatif scenario", () => {
        const { store, whatif } = buildStore();
        store.setActive(whatif.id);
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (5) ✕ close on a scenario tab — calls discardScenario
// ---------------------------------------------------------------------------

describe("ScheduleWorkspace — close tab", () => {
    it("clicking ✕ on the proposed tab calls discardScenario", () => {
        const { store, proposed } = buildStore();
        const discardSpy = vi.spyOn(store, "discardScenario");
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        const proposedTab = container.querySelector(`[data-tab='${proposed.id}']`);
        const closeBtn = proposedTab?.querySelector("[data-close]") as HTMLElement;
        expect(closeBtn).not.toBeNull();
        fireEvent.click(closeBtn);
        expect(discardSpy).toHaveBeenCalledWith(proposed.id);
    });

    it("clicking ✕ on the whatif tab calls discardScenario", () => {
        const { store, whatif } = buildStore();
        const discardSpy = vi.spyOn(store, "discardScenario");
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        const whatifTab = container.querySelector(`[data-tab='${whatif.id}']`);
        const closeBtn = whatifTab?.querySelector("[data-close]") as HTMLElement;
        expect(closeBtn).not.toBeNull();
        fireEvent.click(closeBtn);
        expect(discardSpy).toHaveBeenCalledWith(whatif.id);
    });
});

// ---------------------------------------------------------------------------
// (6) Compare toggle — enters compare mode
// ---------------------------------------------------------------------------

describe("ScheduleWorkspace — compare toggle", () => {
    it("Compare button is rendered", () => {
        const { store } = buildStore();
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        expect(screen.getByRole("button", { name: /compare/i })).toBeTruthy();
    });

    it("clicking Compare calls openCompare and renders the compare placeholder", () => {
        const { store, proposed } = buildStore();
        const openCompareSpy = vi.spyOn(store, "openCompare");
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        fireEvent.click(screen.getByRole("button", { name: /compare/i }));
        // openCompare should have been called (committed vs active)
        expect(openCompareSpy).toHaveBeenCalled();
        // The compare placeholder div should be present in the body
        const placeholder = container.querySelector(".compare-placeholder");
        expect(placeholder).not.toBeNull();
    });

    it("Compare mode shows a placeholder (CompareView H3 not yet built)", () => {
        const { store } = buildStore();
        const { container } = render(
            <ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />
        );
        fireEvent.click(screen.getByRole("button", { name: /compare/i }));
        // The placeholder paragraph should mention H3
        const placeholder = container.querySelector(".compare-placeholder");
        expect(placeholder).not.toBeNull();
        expect(placeholder?.textContent).toMatch(/H3/i);
    });
});

// ---------------------------------------------------------------------------
// (7) Committed body — no action buttons
// ---------------------------------------------------------------------------

describe("ScheduleWorkspace — committed body", () => {
    it("shows no Confirm/Cancel/Discard action buttons when committed tab is active", () => {
        const { store } = buildStore();
        store.setActive("committed");
        render(<ScheduleWorkspace planStore={store} onConfirmProposed={vi.fn()} onAskWhy={vi.fn()} />);
        expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
        expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
        expect(screen.queryByRole("button", { name: /discard/i })).toBeNull();
    });
});
