// @vitest-environment jsdom
// ============================================================
// H3 — CompareView render test (jsdom, @testing-library/react)
// ============================================================
// TDD RED phase: written BEFORE CompareView exists.
//
// Covers:
//   (1) renders two columns with both scenarios' courses.
//   (2) a diff (course added in right) shows data-diff in the right
//       column and data-diff="diff-removed" in the left column.
//   (3) the two pickers render all options; the right picker disables
//       the option matching left.id (same-scenario prevention).
//   (4) changing a picker calls onPick with the correct (side, id).
// ============================================================

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ForwardSchedule } from "@nyupath/shared";
import type { Scenario } from "../lib/scenarios/scenarioModel";
import CompareView from "../app/chat/workspace/CompareView";

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal specific_planned slot. */
function specificSlot(courseId: string, credits = 4) {
    return {
        kind: "specific_planned" as const,
        courseId,
        title: courseId,
        credits,
        satisfiesRules: [],
        reason: "test",
        rationale: {
            satisfiesRequirements: [],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: [],
        },
        downstreamImpact: { courseIds: [], graduationDelay: 0 },
        workloadTier: "free-elective" as const,
        workloadWeight: 1.0,
        bindingState: "bound" as const,
        confidence: "historically_likely" as const,
        isCriticalPath: false,
    };
}

const LOAD_RATIONALE = {
    strategy: "balanced" as const,
    creditsTarget: 16,
    slack: 0,
    weightedCredits: 16,
    hardCount: 2,
    easyCount: 0,
    alternativeDistributionsConsidered: [],
};

function makeSchedule(courseIds: string[]): ForwardSchedule {
    return {
        state: "valid-clean",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
        semesters: [
            {
                term: "2026-fall",
                locked: false,
                plannedCredits: courseIds.length * 4,
                notes: [],
                loadRationale: LOAD_RATIONALE,
                slots: courseIds.map((id) => specificSlot(id)),
            },
        ],
        assumptions: [],
        balanceScore: 1.0,
        studentId: "test",
        homeSchoolId: "CAS",
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: true,
        dprCourseHistoryHash: "test",
        computedAt: 0,
    } as unknown as ForwardSchedule;
}

/** The "left" committed scenario: has CSCI-UA 101 + MATH-UA 121. */
const LEFT_SCENARIO: Scenario = {
    id: "committed",
    kind: "committed",
    label: "My Plan",
    schedule: makeSchedule(["CSCI-UA 101", "MATH-UA 121"]),
    verdict: "valid",
    createdAt: 0,
};

/** The "right" proposed scenario: has CSCI-UA 101 + PHYS-UA 11 (added), MATH-UA 121 removed. */
const RIGHT_SCENARIO: Scenario = {
    id: "sc-proposed-1",
    kind: "proposed",
    label: "Withdraw MATH-UA 121",
    schedule: makeSchedule(["CSCI-UA 101", "PHYS-UA 11"]),
    verdict: "trade-offs",
    createdAt: 1000,
};

/** A second alternate "right" scenario for picker tests. */
const WHATIF_SCENARIO: Scenario = {
    id: "wi-42",
    kind: "whatif",
    label: "+ Econ minor",
    schedule: makeSchedule(["CSCI-UA 101", "ECON-UA 1"]),
    verdict: "valid",
    createdAt: 2000,
};

const ALL_OPTIONS = [LEFT_SCENARIO, RIGHT_SCENARIO, WHATIF_SCENARIO];

// ---------------------------------------------------------------------------
// (1) Renders two columns with both scenarios' courses
// ---------------------------------------------------------------------------

describe("CompareView — two-column render", () => {
    it("renders the left scenario's courses", () => {
        render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        // CSCI-UA 101 is in both so appears in DOM; MATH-UA 121 is left-only
        expect(screen.getAllByText(/CSCI-UA 101/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/MATH-UA 121/).length).toBeGreaterThan(0);
    });

    it("renders the right scenario's courses", () => {
        render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        // PHYS-UA 11 is only in right
        expect(screen.getAllByText(/PHYS-UA 11/).length).toBeGreaterThan(0);
    });

    it("renders header labels for both scenarios", () => {
        render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        // "My Plan" appears in both the picker options and the column header
        expect(screen.getAllByText(/My Plan/i).length).toBeGreaterThan(0);
        // The right scenario label appears at least once (in header + options)
        expect(screen.getAllByText(/Withdraw MATH-UA 121/i).length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// (2) Diff highlights: added in right, removed in left
// ---------------------------------------------------------------------------

describe("CompareView — diff annotations", () => {
    it("the left column shows MATH-UA 121 (left-only) as diff-removed", () => {
        // MATH-UA 121 is in left but NOT in right → should be marked removed in left column
        const { container } = render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        const removedEls = container.querySelectorAll("[data-diff='diff-removed']");
        expect(removedEls.length).toBeGreaterThan(0);
    });

    it("the right column shows PHYS-UA 11 (right-only) as diff-added", () => {
        // PHYS-UA 11 is in right but NOT in left → should be marked added in right column
        const { container } = render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        const addedEls = container.querySelectorAll("[data-diff='diff-added']");
        expect(addedEls.length).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// (3) Pickers: all options rendered; right disables option matching left.id
// ---------------------------------------------------------------------------

describe("CompareView — pickers", () => {
    it("the left picker renders all options", () => {
        const { container } = render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        // There should be at least one select; the left picker should have 3 options
        const selects = container.querySelectorAll("select");
        expect(selects.length).toBeGreaterThanOrEqual(2);
        // At least one select should have 3 options (one per entry in ALL_OPTIONS)
        const optionCounts = Array.from(selects).map((s) => s.querySelectorAll("option").length);
        expect(optionCounts.some((c) => c === 3)).toBe(true);
    });

    it("the right picker disables the option matching left.id (cannot pick same on both sides)", () => {
        const { container } = render(
            <CompareView
                left={LEFT_SCENARIO}  // id = "committed"
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        // Find the right picker (second select). Its "committed" option should be disabled.
        const selects = container.querySelectorAll("select");
        expect(selects.length).toBeGreaterThanOrEqual(2);
        // The right picker is the second select
        const rightSelect = selects[1] as HTMLSelectElement;
        const disabledOptions = Array.from(rightSelect.querySelectorAll("option[disabled]"));
        const disabledValues = disabledOptions.map((o) => (o as HTMLOptionElement).value);
        expect(disabledValues).toContain("committed"); // left.id = "committed"
    });

    it("the left picker disables the option matching right.id (symmetric prevention)", () => {
        const { container } = render(
            <CompareView
                left={LEFT_SCENARIO}  // id = "committed"
                right={RIGHT_SCENARIO} // id = "sc-proposed-1"
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        const selects = container.querySelectorAll("select");
        const leftSelect = selects[0] as HTMLSelectElement;
        const disabledOptions = Array.from(leftSelect.querySelectorAll("option[disabled]"));
        const disabledValues = disabledOptions.map((o) => (o as HTMLOptionElement).value);
        expect(disabledValues).toContain("sc-proposed-1"); // right.id
    });
});

// ---------------------------------------------------------------------------
// (4) Changing a picker calls onPick with (side, id)
// ---------------------------------------------------------------------------

describe("CompareView — onPick callback", () => {
    it("changing the left picker calls onPick('left', newId)", () => {
        const onPick = vi.fn();
        const { container } = render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={onPick}
            />
        );
        const selects = container.querySelectorAll("select");
        const leftSelect = selects[0] as HTMLSelectElement;
        // Change to whatif scenario
        fireEvent.change(leftSelect, { target: { value: WHATIF_SCENARIO.id } });
        expect(onPick).toHaveBeenCalledWith("left", WHATIF_SCENARIO.id);
    });

    it("changing the right picker calls onPick('right', newId)", () => {
        const onPick = vi.fn();
        const { container } = render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={onPick}
            />
        );
        const selects = container.querySelectorAll("select");
        const rightSelect = selects[1] as HTMLSelectElement;
        // Change to whatif scenario
        fireEvent.change(rightSelect, { target: { value: WHATIF_SCENARIO.id } });
        expect(onPick).toHaveBeenCalledWith("right", WHATIF_SCENARIO.id);
    });
});

// ---------------------------------------------------------------------------
// (5) Graceful fallback when passed empty data
// ---------------------------------------------------------------------------

describe("CompareView — edge cases", () => {
    it("renders with no options without crashing", () => {
        render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={[]}
                onPick={vi.fn()}
            />
        );
        // Should not throw; just renders no options in the pickers
    });

    it("renders a diff legend with at least two entries", () => {
        const { container } = render(
            <CompareView
                left={LEFT_SCENARIO}
                right={RIGHT_SCENARIO}
                options={ALL_OPTIONS}
                onPick={vi.fn()}
            />
        );
        // The diff legend region should be present
        const legend = container.querySelector("[aria-label='Diff legend']");
        expect(legend).not.toBeNull();
        // The legend should have at least 2 child entries (one per diff kind shown)
        const entries = legend?.querySelectorAll("span > span:last-child");
        expect(entries && entries.length).toBeGreaterThanOrEqual(2);
    });
});
