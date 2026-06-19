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

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ForwardSchedule, ScheduleSlotInProgress, ScheduleSlotCompleted, ScheduleSlotPlaceholder } from "@nyupath/shared";
import type { SlotActionMatrix } from "@nyupath/engine";
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

    it("matches a ZERO-PADDED slot courseId against a CANONICAL-keyed diff row", () => {
        // scheduleDiff stores keys via canonicalizeCourseId; ScheduleView must key
        // slots identically, else a padded id ("CSCI-UA 0101") silently misses the
        // canonical diff row ("CSCI-UA 101") and the highlight is dropped.
        const paddedSchedule = {
            ...SCHEDULE,
            semesters: [{
                term: "2026-fall", locked: false, plannedCredits: 4, notes: [],
                loadRationale: LOAD_RATIONALE,
                slots: [specificSlot("CSCI-UA 0101")], // zero-padded
            }],
        } as unknown as ForwardSchedule;
        const canonicalDiff: AnnotatedColumn = {
            terms: [{ term: "2026-fall", rows: [
                { courseId: "CSCI-UA 101", label: "Intro CS", term: "2026-fall", diff: "added" },
            ] }],
        };
        const { container } = render(<ScheduleView schedule={paddedSchedule} diff={canonicalDiff} />);
        expect(container.querySelectorAll("[data-diff='diff-added']").length).toBe(1);
    });
});

// ---- (3) non-interactive slot grid (Cleanup A) ------------------------------
// Plan 36 H6.1 removed the dead slot popover + the "Click to open verbs"
// clickable affordance: ScheduleView is a purely-presentational grid (workspace
// editing is chat-only). NO slot is clickable, in EITHER readOnly mode, and the
// "Actions coming in H6" placeholder no longer ships.

describe("ScheduleView — non-interactive slot grid", () => {
    it("readOnly=true: no slot click affordance and no popover", () => {
        render(<ScheduleView schedule={SCHEDULE} readOnly={true} />);
        const dotsButtons = screen.queryAllByRole("button", { name: /⋯/ });
        expect(dotsButtons.length).toBe(0);
        expect(document.querySelectorAll('[title="Click to open verbs"]').length).toBe(0);
        expect(screen.queryByRole("dialog", { name: /slot actions/i })).toBeNull();
    });

    it("readOnly=false (default): slots are STILL non-interactive (no clickable affordance)", () => {
        render(<ScheduleView schedule={SCHEDULE} readOnly={false} />);
        // The workspace has no slot editor — editing is chat-only — so even the
        // default (non-readOnly) render exposes no clickable slot affordance.
        expect(document.querySelectorAll('[title="Click to open verbs"]').length).toBe(0);
    });

    it("never renders the dead 'Actions coming in H6' placeholder", () => {
        render(<ScheduleView schedule={SCHEDULE} readOnly={false} />);
        expect(screen.queryByText(/Actions coming in H6/i)).toBeNull();
    });

    it("singleColumn prop renders without error (compare-column layout)", () => {
        const { container } = render(<ScheduleView schedule={SCHEDULE} singleColumn />);
        // The grid still renders both terms' courses.
        expect(container.querySelector("ul")).not.toBeNull();
        expect(screen.getByText(/CSCI-UA 101/)).toBeTruthy();
    });
});

// ---- (4) F3 — interactive committed-plan slot editor -------------------------
// Plan 37 F3: the committed-plan ScheduleView accepts `slotMatrix` +
// `onSlotAction` props. When BOTH are present (and readOnly=false), clicking
// a slot opens the SlotActionPopover; clicking a popover button calls
// `onSlotAction(slot, term, action)`.
//
// The test schedule below has one `in_progress` slot (CSCI-UA 301 in
// 2026-fall) — the kind that has real per-slot actions (drop / withdraw /
// pass-fail are all potentially gated on the IP window).
// ----------------------------------------------------------------------------

/** Minimal in_progress slot. */
const IP_SLOT: ScheduleSlotInProgress = {
    kind: "in_progress",
    courseId: "CSCI-UA 301",
    title: "Data Structures",
    credits: 4,
};

// A schedule with ONE in_progress slot so we can target it precisely.
const IP_SCHEDULE = {
    ...SCHEDULE,
    semesters: [
        {
            term: "2026-fall",
            locked: false,
            plannedCredits: 4,
            notes: [],
            loadRationale: LOAD_RATIONALE,
            slots: [IP_SLOT],
        },
    ],
} as unknown as ForwardSchedule;

/** A stub SlotActionMatrix that allows drop + withdraw, not passFail. */
function makeMatrix(dropAllowed: boolean): SlotActionMatrix {
    return {
        state: "registered",
        allowed: { add: false, drop: dropAllowed, withdraw: true, passFail: false },
        perAction: {
            add:      { reason: "term-level only" },
            drop:     dropAllowed ? { hedge: "Check add/drop window" } : { reason: "closed" },
            withdraw: { hedge: "Verify the withdraw deadline" },
            passFail: { reason: "not offered" },
        },
    };
}

describe("ScheduleView — F3 interactive committed plan", () => {
    it("clicking a slot OPENS the SlotActionPopover (Drop button appears)", () => {
        const slotMatrix = vi.fn(() => makeMatrix(true));
        const onSlotAction = vi.fn();
        render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={false}
                slotMatrix={slotMatrix}
                onSlotAction={onSlotAction}
            />,
        );
        // Before clicking: no popover in the DOM.
        expect(screen.queryByRole("menu")).toBeNull();

        // Click the slot (the <li> containing "CSCI-UA 301").
        const courseEl = screen.getByText(/CSCI-UA 301/);
        fireEvent.click(courseEl);

        // After clicking: the popover should render (role="menu" on SlotActionPopover).
        expect(screen.queryByRole("menu")).toBeTruthy();
        // "Drop" should be visible in the popover.
        expect(screen.getByText("Drop")).toBeTruthy();
    });

    it("clicking 'Drop' in the popover calls onSlotAction with action='drop'", () => {
        const slotMatrix = vi.fn(() => makeMatrix(true));
        const onSlotAction = vi.fn();
        render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={false}
                slotMatrix={slotMatrix}
                onSlotAction={onSlotAction}
            />,
        );
        // Open the popover.
        fireEvent.click(screen.getByText(/CSCI-UA 301/));
        // Click the "Drop" button.
        fireEvent.click(screen.getByText("Drop"));

        expect(onSlotAction).toHaveBeenCalledTimes(1);
        // The spy is called with (slot, term, action). Verify the action arg.
        const args = onSlotAction.mock.calls[0] as [unknown, unknown, string];
        expect(args[2]).toBe("drop");
    });

    it("clicking 'Withdraw' in the popover calls onSlotAction with action='withdraw'", () => {
        const slotMatrix = vi.fn(() => makeMatrix(true));
        const onSlotAction = vi.fn();
        render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={false}
                slotMatrix={slotMatrix}
                onSlotAction={onSlotAction}
            />,
        );
        fireEvent.click(screen.getByText(/CSCI-UA 301/));
        fireEvent.click(screen.getByText("Withdraw"));

        const args = onSlotAction.mock.calls[0] as [unknown, unknown, string];
        expect(args[2]).toBe("withdraw");
    });

    it("clicking a slot action closes the popover (popover removed after click)", () => {
        const slotMatrix = vi.fn(() => makeMatrix(true));
        const onSlotAction = vi.fn();
        render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={false}
                slotMatrix={slotMatrix}
                onSlotAction={onSlotAction}
            />,
        );
        fireEvent.click(screen.getByText(/CSCI-UA 301/));
        expect(screen.queryByRole("menu")).toBeTruthy();
        fireEvent.click(screen.getByText("Drop"));
        // After clicking an action the popover should close.
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("the slotMatrix callback receives the correct slot + term", () => {
        const slotMatrix = vi.fn(() => makeMatrix(true));
        const onSlotAction = vi.fn();
        render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={false}
                slotMatrix={slotMatrix}
                onSlotAction={onSlotAction}
            />,
        );
        // Open the popover — slotMatrix should be called at that point
        // (the popover reads the matrix when it opens / renders).
        fireEvent.click(screen.getByText(/CSCI-UA 301/));
        // slotMatrix should have been called with (slot, term).
        expect(slotMatrix).toHaveBeenCalled();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [receivedSlot, receivedTerm] = (slotMatrix.mock.calls[0] as unknown) as [{ kind: string; courseId: string }, string];
        expect(receivedSlot.kind).toBe("in_progress");
        expect(receivedSlot.courseId).toBe("CSCI-UA 301");
        expect(receivedTerm).toBe("2026-fall");
    });
});

// ---- (5) F3 — read-only path: no popover regardless of slot click -----------

describe("ScheduleView — F3 read-only path (no popover)", () => {
    it("readOnly=true with slotMatrix+onSlotAction props: clicking slot does NOT open popover", () => {
        const slotMatrix = vi.fn(() => makeMatrix(true));
        const onSlotAction = vi.fn();
        render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={true}
                slotMatrix={slotMatrix}
                onSlotAction={onSlotAction}
            />,
        );
        // Even with the editor props present, readOnly=true suppresses interactivity.
        fireEvent.click(screen.getByText(/CSCI-UA 301/));
        expect(screen.queryByRole("menu")).toBeNull();
        expect(onSlotAction).not.toHaveBeenCalled();
    });

    it("WITHOUT slotMatrix/onSlotAction props: clicking slot does NOT open popover", () => {
        render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={false}
                // slotMatrix and onSlotAction intentionally absent
            />,
        );
        fireEvent.click(screen.getByText(/CSCI-UA 301/));
        expect(screen.queryByRole("menu")).toBeNull();
    });

    it("no 'Edit this course' title attribute when read-only (no click affordance)", () => {
        const { container } = render(
            <ScheduleView schedule={IP_SCHEDULE} readOnly={true} />,
        );
        // The .slotClickable title is only set in interactive mode.
        const slots = container.querySelectorAll("[title='Edit this course']");
        expect(slots.length).toBe(0);
    });

    it("'Edit this course' title IS present when interactive", () => {
        const { container } = render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={false}
                slotMatrix={vi.fn(() => makeMatrix(true))}
                onSlotAction={vi.fn()}
            />,
        );
        const slots = container.querySelectorAll("[title='Edit this course']");
        expect(slots.length).toBeGreaterThan(0);
    });
});

// ---- (6) F3 polish — completed + placeholder slots are NOT clickable ----------
// Plan 37 F3 polish: per-slot kind gate ensures that `completed` (locked/graded)
// and `placeholder` (unbound reservation, no courseId to act on) slots do NOT
// open the popover even when the editor props are mounted. Only `specific_planned`
// and `in_progress` slots are editable (they have a dispatchable courseId).

/** Minimal completed slot. */
const COMPLETED_SLOT: ScheduleSlotCompleted = {
    kind: "completed",
    courseId: "CSCI-UA 101",
    title: "Intro CS",
    credits: 4,
    grade: "A",
};

/** Minimal placeholder slot (bound reservation, no courseId). */
const PLACEHOLDER_SLOT: ScheduleSlotPlaceholder = {
    kind: "placeholder",
    category: "Free Elective",
    credits: 4,
    satisfiesRules: [],
    optional: false,
    reason: "free-elective requirement",
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
    bindingState: "placeholder-pending" as const,
    placeholderId: "ph-1",
    confidence: "historically_likely" as const,
    isCriticalPath: false,
};

const COMPLETED_SCHEDULE = {
    ...SCHEDULE,
    semesters: [
        {
            term: "2026-fall",
            locked: true,
            plannedCredits: 4,
            notes: [],
            loadRationale: LOAD_RATIONALE,
            slots: [COMPLETED_SLOT],
        },
    ],
} as unknown as ForwardSchedule;

const PLACEHOLDER_SCHEDULE = {
    ...SCHEDULE,
    semesters: [
        {
            term: "2026-fall",
            locked: false,
            plannedCredits: 4,
            notes: [],
            loadRationale: LOAD_RATIONALE,
            slots: [PLACEHOLDER_SLOT],
        },
    ],
} as unknown as ForwardSchedule;

describe("ScheduleView — F3 polish: completed/placeholder slots are NOT clickable", () => {
    it("completed slot: clicking does NOT open the popover (no menu rendered)", () => {
        const slotMatrix = vi.fn(() => makeMatrix(true));
        const onSlotAction = vi.fn();
        render(
            <ScheduleView
                schedule={COMPLETED_SCHEDULE}
                readOnly={false}
                slotMatrix={slotMatrix}
                onSlotAction={onSlotAction}
            />,
        );
        // The completed course should render in the DOM.
        expect(screen.getByText(/CSCI-UA 101/)).toBeTruthy();
        // Clicking it should NOT open the popover.
        fireEvent.click(screen.getByText(/CSCI-UA 101/));
        expect(screen.queryByRole("menu")).toBeNull();
        expect(onSlotAction).not.toHaveBeenCalled();
    });

    it("completed slot: title is NOT 'Edit this course' (no misleading edit affordance)", () => {
        const { container } = render(
            <ScheduleView
                schedule={COMPLETED_SCHEDULE}
                readOnly={false}
                slotMatrix={vi.fn(() => makeMatrix(true))}
                onSlotAction={vi.fn()}
            />,
        );
        // The slot must NOT have the "Edit this course" title — that would
        // imply it is editable (it is locked/graded).
        const editableTitles = container.querySelectorAll("[title='Edit this course']");
        expect(editableTitles.length).toBe(0);
        // It SHOULD carry the "Completed — locked" title (informative).
        const lockedTitles = container.querySelectorAll("[title='Completed — locked']");
        expect(lockedTitles.length).toBeGreaterThan(0);
    });

    it("placeholder slot: clicking does NOT open the popover (no dead Drop)", () => {
        const slotMatrix = vi.fn(() => makeMatrix(true));
        const onSlotAction = vi.fn();
        render(
            <ScheduleView
                schedule={PLACEHOLDER_SCHEDULE}
                readOnly={false}
                slotMatrix={slotMatrix}
                onSlotAction={onSlotAction}
            />,
        );
        // The placeholder renders its category as text.
        expect(screen.getByText(/Free Elective/)).toBeTruthy();
        // Clicking it should NOT open the popover.
        fireEvent.click(screen.getByText(/Free Elective/));
        expect(screen.queryByRole("menu")).toBeNull();
        expect(onSlotAction).not.toHaveBeenCalled();
    });

    it("specific_planned slot STILL opens the popover (existing behaviour unchanged)", () => {
        render(
            <ScheduleView
                schedule={SCHEDULE}
                readOnly={false}
                slotMatrix={vi.fn(() => makeMatrix(true))}
                onSlotAction={vi.fn()}
            />,
        );
        // SCHEDULE has CSCI-UA 101 as specific_planned.
        fireEvent.click(screen.getByText(/CSCI-UA 101/));
        expect(screen.queryByRole("menu")).toBeTruthy();
    });

    it("in_progress slot STILL opens the popover (existing behaviour unchanged)", () => {
        render(
            <ScheduleView
                schedule={IP_SCHEDULE}
                readOnly={false}
                slotMatrix={vi.fn(() => makeMatrix(true))}
                onSlotAction={vi.fn()}
            />,
        );
        fireEvent.click(screen.getByText(/CSCI-UA 301/));
        expect(screen.queryByRole("menu")).toBeTruthy();
    });
});

// ---- (7) F4 — per-term "+ Add course" affordance (window-gated, D-2) --------
// Plan 37 F4: the committed-plan ScheduleView accepts `addTermState` +
// `onAddCourse` props. When BOTH are present (and readOnly=false), each term
// `addTermState(term).allowed === true` renders a "+ Add course" control: a
// button that expands to a text input; submitting a non-empty trimmed value
// calls `onAddCourse(term, courseId)`. A term with `{ allowed: false }`
// renders NO control, and readOnly suppresses ALL add controls.
// ----------------------------------------------------------------------------

describe("ScheduleView — F4 per-term add affordance", () => {
    it("renders a '+ Add course' control on a FUTURE/planned term (allowed:true)", () => {
        const addTermState = vi.fn(() => ({ allowed: true }));
        const onAddCourse = vi.fn();
        render(
            <ScheduleView
                schedule={SCHEDULE}
                readOnly={false}
                addTermState={addTermState}
                onAddCourse={onAddCourse}
            />,
        );
        // SCHEDULE has two terms → both eligible → two "+ Add course" buttons.
        const addButtons = screen.getAllByRole("button", { name: /Add a course to/i });
        expect(addButtons.length).toBe(2);
    });

    it("shows the hedge on a current term with { allowed:true, hedge }", () => {
        const HEDGE = "Typical add/drop deadline — verify; registering this late is deadline-gated.";
        // Single-term schedule so we target one control unambiguously.
        const oneTerm = {
            ...SCHEDULE,
            semesters: [SCHEDULE.semesters[0]],
        } as unknown as ForwardSchedule;
        const addTermState = vi.fn(() => ({ allowed: true, hedge: HEDGE }));
        const onAddCourse = vi.fn();
        render(
            <ScheduleView
                schedule={oneTerm}
                readOnly={false}
                addTermState={addTermState}
                onAddCourse={onAddCourse}
            />,
        );
        // The hedge is surfaced as the button's title (and as caption text once
        // expanded). Open the control, then assert the hedge text is present.
        fireEvent.click(screen.getByRole("button", { name: /Add a course to/i }));
        expect(screen.getByText(HEDGE)).toBeTruthy();
    });

    it("renders NO add control on a term with { allowed:false }", () => {
        const addTermState = vi.fn(() => ({ allowed: false }));
        const onAddCourse = vi.fn();
        render(
            <ScheduleView
                schedule={SCHEDULE}
                readOnly={false}
                addTermState={addTermState}
                onAddCourse={onAddCourse}
            />,
        );
        expect(screen.queryAllByRole("button", { name: /Add a course to/i }).length).toBe(0);
    });

    it("renders NO add control when readOnly=true (even with the props present)", () => {
        const addTermState = vi.fn(() => ({ allowed: true }));
        const onAddCourse = vi.fn();
        render(
            <ScheduleView
                schedule={SCHEDULE}
                readOnly={true}
                addTermState={addTermState}
                onAddCourse={onAddCourse}
            />,
        );
        expect(screen.queryAllByRole("button", { name: /Add a course to/i }).length).toBe(0);
    });

    it("entering 'CSCI-UA 101' and submitting calls onAddCourse(term, 'CSCI-UA 101')", () => {
        const oneTerm = {
            ...SCHEDULE,
            semesters: [SCHEDULE.semesters[0]], // term "2026-fall"
        } as unknown as ForwardSchedule;
        const addTermState = vi.fn(() => ({ allowed: true }));
        const onAddCourse = vi.fn();
        render(
            <ScheduleView
                schedule={oneTerm}
                readOnly={false}
                addTermState={addTermState}
                onAddCourse={onAddCourse}
            />,
        );
        // Expand the control.
        fireEvent.click(screen.getByRole("button", { name: /Add a course to/i }));
        // Type into the input.
        const input = screen.getByRole("textbox", { name: /Course to add to/i });
        fireEvent.change(input, { target: { value: "CSCI-UA 101" } });
        // Submit via the "Add" button.
        fireEvent.click(screen.getByRole("button", { name: /^Add CSCI-UA 101 to/i }));

        expect(onAddCourse).toHaveBeenCalledTimes(1);
        expect(onAddCourse).toHaveBeenCalledWith("2026-fall", "CSCI-UA 101");
    });

    it("submitting via Enter also calls onAddCourse(term, courseId)", () => {
        const oneTerm = {
            ...SCHEDULE,
            semesters: [SCHEDULE.semesters[0]],
        } as unknown as ForwardSchedule;
        const onAddCourse = vi.fn();
        render(
            <ScheduleView
                schedule={oneTerm}
                readOnly={false}
                addTermState={vi.fn(() => ({ allowed: true }))}
                onAddCourse={onAddCourse}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /Add a course to/i }));
        const input = screen.getByRole("textbox", { name: /Course to add to/i });
        fireEvent.change(input, { target: { value: "MATH-UA 121" } });
        fireEvent.keyDown(input, { key: "Enter" });

        expect(onAddCourse).toHaveBeenCalledTimes(1);
        expect(onAddCourse).toHaveBeenCalledWith("2026-fall", "MATH-UA 121");
    });

    it("an empty / whitespace value does NOT call onAddCourse", () => {
        const oneTerm = {
            ...SCHEDULE,
            semesters: [SCHEDULE.semesters[0]],
        } as unknown as ForwardSchedule;
        const onAddCourse = vi.fn();
        render(
            <ScheduleView
                schedule={oneTerm}
                readOnly={false}
                addTermState={vi.fn(() => ({ allowed: true }))}
                onAddCourse={onAddCourse}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: /Add a course to/i }));
        const input = screen.getByRole("textbox", { name: /Course to add to/i });
        // Whitespace-only value.
        fireEvent.change(input, { target: { value: "   " } });
        // Enter submit — guard should no-op.
        fireEvent.keyDown(input, { key: "Enter" });
        expect(onAddCourse).not.toHaveBeenCalled();
    });

    it("WITHOUT the add props: no add control renders (read-only display grid)", () => {
        render(<ScheduleView schedule={SCHEDULE} readOnly={false} />);
        expect(screen.queryAllByRole("button", { name: /Add a course to/i }).length).toBe(0);
    });
});
