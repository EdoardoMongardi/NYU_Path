// @vitest-environment jsdom
// ============================================================
// H2.1 — ThreeZoneShell render test (jsdom, @testing-library/react)
// ============================================================
// The 3-zone chat shell: chat (LEFT) | ScheduleWorkspace (CENTER) |
// existing ScheduleSidebar (RIGHT). page.tsx is a heavy client
// component (SSE, localStorage, useMemo(createPlanStore), many hooks)
// that is impractical to mount whole in jsdom, so H2.1 extracts the
// presentational 3-zone shell into `ThreeZoneShell` and page.tsx
// mounts it. We test THAT thin component here with a seeded store —
// this directly covers the H2.1 deliverable (the three zones render +
// the workspace's committed tab shows the loaded plan).
//
// Covers:
//   (1) all three zones (left / center / right) are present.
//   (2) the LEFT zone renders the chat content passed as `left`.
//   (3) the RIGHT zone renders whatever is passed as `right` (sidebar).
//   (4) the CENTER zone mounts ScheduleWorkspace whose committed
//       ("My Plan") tab renders the loaded plan.
//   (5) the shell forwards the Confirm / Ask-why callbacks to the
//       workspace (Confirm on a proposed scenario calls onConfirmProposed).
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ForwardSchedule } from "@nyupath/shared";
import { createPlanStore, type Scenario } from "../app/chat/planState";
import ThreeZoneShell from "../app/chat/workspace/ThreeZoneShell";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures (mirror scheduleWorkspace.render.test.tsx)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// (1)-(3) The three zones + their content
// ---------------------------------------------------------------------------

describe("ThreeZoneShell — layout", () => {
    it("renders all three zones (left / center / right)", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const { container } = render(
            <ThreeZoneShell
                planStore={store}
                onConfirmProposed={vi.fn()}
                onAskWhy={vi.fn()}
                left={<div data-testid="left-content">chat</div>}
                right={<div data-testid="right-content">sidebar</div>}
            />,
        );
        expect(container.querySelector("[data-zone='left']")).not.toBeNull();
        expect(container.querySelector("[data-zone='center']")).not.toBeNull();
        expect(container.querySelector("[data-zone='right']")).not.toBeNull();
    });

    it("renders the chat content in the LEFT zone", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const { container } = render(
            <ThreeZoneShell
                planStore={store}
                onConfirmProposed={vi.fn()}
                onAskWhy={vi.fn()}
                left={<div data-testid="left-content">chat</div>}
                right={<div data-testid="right-content">sidebar</div>}
            />,
        );
        const left = container.querySelector("[data-zone='left']");
        expect(left?.querySelector("[data-testid='left-content']")).not.toBeNull();
    });

    it("renders the sidebar content in the RIGHT zone", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const { container } = render(
            <ThreeZoneShell
                planStore={store}
                onConfirmProposed={vi.fn()}
                onAskWhy={vi.fn()}
                left={<div data-testid="left-content">chat</div>}
                right={<div data-testid="right-content">sidebar</div>}
            />,
        );
        const right = container.querySelector("[data-zone='right']");
        expect(right?.querySelector("[data-testid='right-content']")).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// (4) The center zone mounts ScheduleWorkspace with the loaded plan
// ---------------------------------------------------------------------------

describe("ThreeZoneShell — center workspace", () => {
    it("mounts ScheduleWorkspace whose committed (My Plan) tab renders the loaded plan", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const { container } = render(
            <ThreeZoneShell
                planStore={store}
                onConfirmProposed={vi.fn()}
                onAskWhy={vi.fn()}
                left={<div>chat</div>}
                right={<div>sidebar</div>}
            />,
        );
        const center = container.querySelector("[data-zone='center']");
        expect(center).not.toBeNull();
        // The workspace renders the pinned committed tab.
        const committedTab = center?.querySelector("[data-tab='committed']");
        expect(committedTab).not.toBeNull();
        expect(committedTab?.textContent).toMatch(/My Plan/i);
    });
});

// ---------------------------------------------------------------------------
// (5) Callbacks forwarded to the workspace
// ---------------------------------------------------------------------------

describe("ThreeZoneShell — callback wiring", () => {
    it("forwards onConfirmProposed to the workspace (Confirm on a proposed scenario)", () => {
        const store = createPlanStore({ forwardSchedule: makeSchedule("committed") });
        const proposed = makeProposedScenario();
        store.addScenario(proposed); // becomes active
        const onConfirm = vi.fn();
        render(
            <ThreeZoneShell
                planStore={store}
                onConfirmProposed={onConfirm}
                onAskWhy={vi.fn()}
                left={<div>chat</div>}
                right={<div>sidebar</div>}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
        expect(onConfirm).toHaveBeenCalledWith(proposed);
    });
});
