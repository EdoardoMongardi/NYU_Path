// ============================================================
// slotState (Phase 4 Task E2.2) — visible slot-state glyph/label logic
// ============================================================
// apps/web ships NO DOM render harness (no @testing-library/react,
// no jsdom — vitest runs in node), so the slot-state logic is
// extracted into the pure, framework-agnostic helper
// `apps/web/app/chat/sidebar/slotState.ts` and unit-tested here
// directly. The `SlotRow` React component is a thin consumer of
// `computeSlotState` (it renders the returned glyph/label and gates
// edit verbs on `editable`).
//
// Design §8 slot-state mapping (binding):
//   🔒 locked  (taken, final)          → kind "completed"
//   ◐ in-progress (fixed in its term)  → kind "in_progress"
//   planned (movable)                  → kind "specific_planned" / "placeholder"
// This makes the core_philosophy.md:18 IP rule VISIBLE: a non-IP
// (completed/final) course is unmodifiable; an IP or planned course
// is student-instructable.
//
// Coverage:
//   - each kind → correct glyph + label.
//   - completed → editable === false (NO edit verbs); specific_planned
//     → editable === true (the two BINDING assertions, both already
//     true in the component today).
//   - a frozen specific_planned → keeps the 🔒 "locked by you"
//     treatment; still student-pinned (editable to unlock/move).
//   - any slot in a semesterLocked term → locked / not editable
//     regardless of kind.
// ============================================================

import { describe, it, expect } from "vitest";
import type {
    ScheduleSlot,
    ScheduleSlotCompleted,
    ScheduleSlotInProgress,
    ScheduleSlotSpecificPlanned,
    ScheduleSlotPlaceholder,
} from "@nyupath/shared";
import { computeSlotState } from "../app/chat/sidebar/slotState";

// ---------------------------------------------------------------------------
// Minimal real-type fixtures (one per ScheduleSlotKind). Mirrors the
// `specificSlot` shape in _planRouteTestUtils.ts; the other kinds are
// built with only their required fields.
// ---------------------------------------------------------------------------

function completedSlot(courseId = "CSCI-UA 101"): ScheduleSlotCompleted {
    return { kind: "completed", courseId, title: courseId, credits: 4, grade: "A" };
}

function inProgressSlot(courseId = "CSCI-UA 102"): ScheduleSlotInProgress {
    return { kind: "in_progress", courseId, title: courseId, credits: 4 };
}

function specificPlannedSlot(courseId = "CSCI-UA 201"): ScheduleSlotSpecificPlanned {
    return {
        kind: "specific_planned",
        courseId,
        title: courseId,
        credits: 4,
        satisfiesRules: [],
        reason: "test fixture",
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
        workloadTier: "free-elective",
        workloadWeight: 1.0,
        bindingState: "bound",
        confidence: "historically_likely",
        isCriticalPath: false,
    };
}

function placeholderSlot(category = "Liberal Arts elective"): ScheduleSlotPlaceholder {
    return {
        kind: "placeholder",
        category,
        credits: 4,
        satisfiesRules: [],
        optional: false,
        reason: "test fixture",
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
        workloadTier: "free-elective",
        workloadWeight: 1.0,
        bindingState: "placeholder-pending",
        placeholderId: "ph-1",
        confidence: "historically_likely",
        isCriticalPath: false,
    };
}

const UNFROZEN_FUTURE = { isFrozen: false, semesterLocked: false };

// ---------------------------------------------------------------------------
// Per-kind glyph + label
// ---------------------------------------------------------------------------

describe("computeSlotState — per-kind glyph + label", () => {
    it("completed → 🔒 + a 'taken (final)' label", () => {
        const v = computeSlotState(completedSlot(), UNFROZEN_FUTURE);
        expect(v.glyph).toBe("🔒");
        expect(v.label.toLowerCase()).toContain("taken");
        expect(v.label.toLowerCase()).toContain("final");
    });

    it("in_progress → ◐ + a 'fixed in its term' label (the IP rule made visible)", () => {
        const v = computeSlotState(inProgressSlot(), UNFROZEN_FUTURE);
        expect(v.glyph).toBe("◐");
        expect(v.label.toLowerCase()).toContain("progress");
        expect(v.label.toLowerCase()).toContain("fixed in its term");
    });

    it("specific_planned → planned-movable marker (no lock glyph)", () => {
        const v = computeSlotState(specificPlannedSlot(), UNFROZEN_FUTURE);
        expect(v.glyph).toBe("");
        expect(v.label.toLowerCase()).toContain("planned");
        expect(v.label.toLowerCase()).toContain("movable");
    });

    it("placeholder → planned-movable marker (open/pool slot)", () => {
        const v = computeSlotState(placeholderSlot(), UNFROZEN_FUTURE);
        expect(v.glyph).toBe("");
        expect(v.label.toLowerCase()).toContain("planned");
        expect(v.label.toLowerCase()).toContain("movable");
    });
});

// ---------------------------------------------------------------------------
// Editability — the two BINDING assertions
// ---------------------------------------------------------------------------

describe("computeSlotState — editability (binding)", () => {
    it("completed → editable === false (NO edit verbs)", () => {
        expect(computeSlotState(completedSlot(), UNFROZEN_FUTURE).editable).toBe(false);
    });

    it("specific_planned → editable === true (offers edit verbs)", () => {
        expect(computeSlotState(specificPlannedSlot(), UNFROZEN_FUTURE).editable).toBe(true);
    });

    it("placeholder → editable === true (movable open slot)", () => {
        expect(computeSlotState(placeholderSlot(), UNFROZEN_FUTURE).editable).toBe(true);
    });

    // in_progress matches the component's actual gating today (clickable
    // + draggable). E2.2 makes the ◐ "fixed in its term" state VISIBLE;
    // it does NOT silently strip in_progress's move verb (DONE_WITH_CONCERNS
    // — the "should IP lose its move verb?" question is left for the owner).
    it("in_progress → editable === true (matches the component's current gating)", () => {
        expect(computeSlotState(inProgressSlot(), UNFROZEN_FUTURE).editable).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Frozen (student-pinned) specific_planned → keeps the 🔒 "locked by you"
// treatment but remains student-instructable (can unlock / move).
// ---------------------------------------------------------------------------

describe("computeSlotState — frozen (student-pinned) slot", () => {
    it("frozen specific_planned → 🔒 + a 'locked by you' label, still editable", () => {
        const v = computeSlotState(specificPlannedSlot(), { isFrozen: true, semesterLocked: false });
        expect(v.glyph).toBe("🔒");
        expect(v.label.toLowerCase()).toContain("locked by you");
        // A user-pinned slot is still student-instructable (unlock / drag
        // to move — the lock travels with it), matching the component.
        expect(v.editable).toBe(true);
    });

    it("frozen does NOT override completed's final-lock treatment", () => {
        // completed is final regardless; isFrozen never makes it editable.
        const v = computeSlotState(completedSlot(), { isFrozen: true, semesterLocked: false });
        expect(v.glyph).toBe("🔒");
        expect(v.editable).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Semester-level lock (ForwardSemester.locked) → term-locked regardless
// of kind.
// ---------------------------------------------------------------------------

describe("computeSlotState — semester-locked term", () => {
    it("a specific_planned slot in a locked term → 🔒 + not editable", () => {
        const v = computeSlotState(specificPlannedSlot(), { isFrozen: false, semesterLocked: true });
        expect(v.glyph).toBe("🔒");
        expect(v.editable).toBe(false);
    });

    it("an in_progress slot in a locked term → 🔒 + not editable (term lock wins over ◐)", () => {
        const v = computeSlotState(inProgressSlot(), { isFrozen: false, semesterLocked: true });
        expect(v.glyph).toBe("🔒");
        expect(v.editable).toBe(false);
    });

    it("a placeholder slot in a locked term → not editable", () => {
        const v = computeSlotState(placeholderSlot(), { isFrozen: false, semesterLocked: true });
        expect(v.editable).toBe(false);
    });

    it("a completed slot in a locked term keeps the §8 'taken (final)' label (the LIVE path: completed always sits in a locked history bucket)", () => {
        // Kind-first precedence: a completed slot must show "taken, final"
        // even though it always renders inside a locked:true bucket — the
        // generic term-lock label must NOT mask it. This is the label users
        // actually see in the sidebar.
        const v = computeSlotState(completedSlot(), { isFrozen: false, semesterLocked: true });
        expect(v.glyph).toBe("🔒");
        expect(v.label.toLowerCase()).toContain("taken");
        expect(v.label.toLowerCase()).toContain("final");
        expect(v.editable).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// ariaLabel is always present + non-empty (a11y — the lock/movable
// distinction must be exposed to assistive tech, not just the glyph).
// ---------------------------------------------------------------------------

describe("computeSlotState — ariaLabel", () => {
    const cases: ScheduleSlot[] = [
        completedSlot(),
        inProgressSlot(),
        specificPlannedSlot(),
        placeholderSlot(),
    ];
    for (const slot of cases) {
        it(`${slot.kind} → non-empty ariaLabel`, () => {
            const v = computeSlotState(slot, UNFROZEN_FUTURE);
            expect(v.ariaLabel.length).toBeGreaterThan(0);
        });
    }
});
