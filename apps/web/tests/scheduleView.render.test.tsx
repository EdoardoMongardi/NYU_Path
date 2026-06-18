// @vitest-environment jsdom
// ============================================================
// H2.2 — ScheduleView render test (jsdom, @testing-library/react)
// ============================================================
// Covers:
//   (1) renders a schedule's terms + course codes in the DOM.
//   (2) with a `diff` AnnotatedColumn marking a course added / removed /
//       retake, the rendered course row carries the corresponding CSS class.
//   (3) `readOnly=true` hides the interactive ⋯ affordance (the slot
//       click / popover trigger is suppressed).
// ============================================================

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ForwardSchedule } from "@nyupath/shared";
import type { AnnotatedColumn } from "../lib/scenarios/scheduleDiff";
import ScheduleView from "../app/chat/workspace/ScheduleView";

afterEach(() => cleanup());

// ---- fixtures ---------------------------------------------------------------

/** Minimal specific_planned slot (only required shared fields). */
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

/** Minimal LoadRationale for test fixtures. */
const LOAD_RATIONALE = {
    strategy: "balanced" as const,
    creditsTarget: 16,
    slack: 0,
    weightedCredits: 16,
    hardCount: 2,
    easyCount: 0,
    alternativeDistributionsConsidered: [],
};

// Cast via `unknown` so the test fixture only needs the fields that
// ScheduleView actually reads (semesters[].term/locked/plannedCredits/notes/slots).
// ForwardSchedule has many required fields that are irrelevant to rendering.
const SCHEDULE = {
    state: "valid-clean",
    graduationTerm: "2027-spring",
    creditTargetPerSemester: 16,
    feasibility: { feasible: true, constraintViolations: [], placementRationale: {} },
    semesters: [
        {
            term: "2026-fall",
            locked: false,
            plannedCredits: 16,
            notes: [],
            loadRationale: LOAD_RATIONALE,
            slots: [
                specificSlot("CSCI-UA 101"),
                specificSlot("MATH-UA 121"),
            ],
        },
        {
            term: "2027-spring",
            locked: false,
            plannedCredits: 16,
            notes: [],
            loadRationale: LOAD_RATIONALE,
            slots: [
                specificSlot("CSCI-UA 201"),
            ],
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

/** AnnotatedColumn that marks CSCI-UA 101 as added, MATH-UA 121 as removed,
 *  CSCI-UA 201 as retake. */
const DIFF_COL: AnnotatedColumn = {
    terms: [
        {
            term: "2026-fall",
            rows: [
                { courseId: "CSCI-UA 101", label: "Intro CS", term: "2026-fall", diff: "added" },
                { courseId: "MATH-UA 121", label: "Calc I",   term: "2026-fall", diff: "removed" },
            ],
        },
        {
            term: "2027-spring",
            rows: [
                { courseId: "CSCI-UA 201", label: "Data Structures", term: "2027-spring", diff: "retake" },
            ],
        },
    ],
};

// ---- (1) basic render -------------------------------------------------------

describe("ScheduleView — basic render", () => {
    it("renders both terms' course codes in the DOM", () => {
        render(<ScheduleView schedule={SCHEDULE} />);
        // Course codes should appear as text
        expect(screen.getByText(/CSCI-UA 101/)).toBeTruthy();
        expect(screen.getByText(/MATH-UA 121/)).toBeTruthy();
        expect(screen.getByText(/CSCI-UA 201/)).toBeTruthy();
    });

    it("renders term labels for both semesters", () => {
        render(<ScheduleView schedule={SCHEDULE} />);
        // formatTermLabel("2026-fall") → "Fall 2026"
        expect(screen.getByText(/Fall 2026/)).toBeTruthy();
        expect(screen.getByText(/Spring 2027/)).toBeTruthy();
    });
});

// ---- (2) diff highlights -----------------------------------------------------
// We use the `data-diff` attribute that ScheduleView sets on each annotated
// slot row. CSS module class names are hashed in the test environment so
// `[class*='diff-added']` is unreliable; `[data-diff="diff-added"]` is stable
// and directly asserts the annotation is present on the correct element.

describe("ScheduleView — diff annotations", () => {
    it("added course carries diff-added annotation", () => {
        const { container } = render(<ScheduleView schedule={SCHEDULE} diff={DIFF_COL} />);
        const addedEls = container.querySelectorAll("[data-diff='diff-added']");
        expect(addedEls.length).toBeGreaterThan(0);
    });

    it("removed course carries diff-removed annotation", () => {
        const { container } = render(<ScheduleView schedule={SCHEDULE} diff={DIFF_COL} />);
        const removedEls = container.querySelectorAll("[data-diff='diff-removed']");
        expect(removedEls.length).toBeGreaterThan(0);
    });

    it("retake course carries diff-retake annotation", () => {
        const { container } = render(<ScheduleView schedule={SCHEDULE} diff={DIFF_COL} />);
        const retakeEls = container.querySelectorAll("[data-diff='diff-retake']");
        expect(retakeEls.length).toBeGreaterThan(0);
    });

    it("courses with no diff annotation carry no data-diff attribute", () => {
        // Render without diff: no data-diff attributes expected
        const { container } = render(<ScheduleView schedule={SCHEDULE} />);
        expect(container.querySelectorAll("[data-diff]").length).toBe(0);
    });
});

// ---- (3) readOnly hides ⋯ affordance ----------------------------------------

describe("ScheduleView — readOnly prop", () => {
    it("readOnly=true: no slot ⋯ button or popover trigger rendered", () => {
        render(<ScheduleView schedule={SCHEDULE} readOnly={true} />);
        // The ⋯ button is only present in editable mode; with readOnly we should
        // see no element with aria-label containing "open verbs" or the ⋯ char.
        const dotsButtons = screen.queryAllByRole("button", { name: /⋯/ });
        expect(dotsButtons.length).toBe(0);
        // Also confirm no popover affordances (title "Click to open verbs")
        const clickableSlots = document.querySelectorAll('[title="Click to open verbs"]');
        expect(clickableSlots.length).toBe(0);
    });

    it("readOnly=false (default): slots ARE clickable (title contains 'Click to open verbs')", () => {
        render(<ScheduleView schedule={SCHEDULE} readOnly={false} />);
        // specific_planned slots in a non-locked term should be clickable
        const clickableSlots = document.querySelectorAll('[title="Click to open verbs"]');
        expect(clickableSlots.length).toBeGreaterThan(0);
    });
});
