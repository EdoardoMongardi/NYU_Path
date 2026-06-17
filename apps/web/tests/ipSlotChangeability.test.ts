// ============================================================
// ipSlotChangeability (F3 — IP-course temporal model, web wiring)
// ============================================================
// The pure `computeSlotState` helper now honors an optional
// `ipChangeability` classification for an in_progress slot, so the
// sidebar's editable + label/aria come from the engine's honest
// registration-window state instead of the blanket "IP → editable".
// This unit-tests that wiring in node (apps/web ships no DOM harness):
//   - in_progress + window "future"      → editable + a "future" label
//   - in_progress + window "closed"      → NOT editable + honest label
//   - in_progress + window "withdraw_pf" → editable + a hedge label/title
//   - in_progress + window "unknown"     → editable + adviser-verify label
//   - in_progress with NO ipChangeability → editable (back-compat)
//   - completed stays locked regardless of any ipChangeability
//
// computeSlotState is the SINGLE source of truth the SlotRow component
// consumes, so asserting it here is asserting the rendered behavior.
// ============================================================

import { describe, it, expect } from "vitest";
import type {
    ScheduleSlotInProgress,
    ScheduleSlotCompleted,
} from "@nyupath/shared";
import {
    computeSlotState,
    type SlotIpChangeability,
} from "../app/chat/sidebar/slotState";

function inProgressSlot(courseId = "CSCI-UA 102"): ScheduleSlotInProgress {
    return { kind: "in_progress", courseId, title: courseId, credits: 4 };
}

function completedSlot(courseId = "CSCI-UA 101"): ScheduleSlotCompleted {
    return { kind: "completed", courseId, title: courseId, credits: 4, grade: "A" };
}

const UNFROZEN = { isFrozen: false, semesterLocked: false };

function withWindow(
    window: SlotIpChangeability["window"],
    hedge?: string,
): { isFrozen: boolean; semesterLocked: boolean; ipChangeability: SlotIpChangeability } {
    // editable mirrors the engine: only "closed" is non-editable.
    const editable = window !== "closed";
    return {
        ...UNFROZEN,
        ipChangeability: { window, editable, ...(hedge ? { hedge } : {}) },
    };
}

describe("computeSlotState — in_progress honors ipChangeability (F3)", () => {
    it("window 'future' → ◐ + editable + a future/changeable label", () => {
        const v = computeSlotState(inProgressSlot(), withWindow("future"));
        expect(v.glyph).toBe("◐");
        expect(v.editable).toBe(true);
        expect(v.label.toLowerCase()).toContain("future");
        expect(v.label.toLowerCase()).toContain("changeable");
    });

    it("window 'add_drop' → ◐ + editable + an 'add/drop' label", () => {
        const v = computeSlotState(inProgressSlot(), withWindow("add_drop"));
        expect(v.glyph).toBe("◐");
        expect(v.editable).toBe(true);
        expect(v.label.toLowerCase()).toContain("add/drop");
    });

    it("window 'closed' → ◐ + NOT editable + an honest 'closed' label", () => {
        const v = computeSlotState(inProgressSlot(), withWindow("closed"));
        expect(v.glyph).toBe("◐");
        expect(v.editable).toBe(false); // the load-bearing assertion
        expect(v.label.toLowerCase()).toContain("closed");
        // Honest, verification-grounded: points the student at their adviser.
        expect(v.ariaLabel.toLowerCase()).toContain("adviser");
    });

    it("window 'withdraw_pf' → editable + a hedge label, and the full hedge rides through as `title`", () => {
        const HEDGE = "Past add/drop — you could WITHDRAW or switch to PASS/FAIL; verify with your adviser.";
        const v = computeSlotState(inProgressSlot(), withWindow("withdraw_pf", HEDGE));
        expect(v.editable).toBe(true);
        expect(v.label.toLowerCase()).toContain("withdraw");
        expect(v.label.toLowerCase()).toContain("pass-fail");
        // The full hedge prose is exposed as the tooltip/title, NOT inlined
        // into the tiny label.
        expect(v.title).toBe(HEDGE);
    });

    it("window 'unknown' → editable + an adviser-verify label", () => {
        const v = computeSlotState(inProgressSlot(), withWindow("unknown"));
        expect(v.editable).toBe(true);
        expect(v.label.toLowerCase()).toContain("verification");
    });
});

describe("computeSlotState — back-compat + completed precedence (F3)", () => {
    it("in_progress with NO ipChangeability → editable + 'fixed in its term' (unchanged)", () => {
        const v = computeSlotState(inProgressSlot(), UNFROZEN);
        expect(v.glyph).toBe("◐");
        expect(v.editable).toBe(true);
        expect(v.label.toLowerCase()).toContain("fixed in its term");
        expect(v.title).toBeUndefined();
    });

    it("completed stays locked even if an ipChangeability somehow rides along", () => {
        // ipChangeability is ignored for non-in_progress kinds; completed's
        // final-lock wins (the kind-first precedence branch).
        const v = computeSlotState(completedSlot(), withWindow("future"));
        expect(v.glyph).toBe("🔒");
        expect(v.editable).toBe(false);
        expect(v.label.toLowerCase()).toContain("taken");
    });

    it("a 'closed' in_progress in a semesterLocked term stays not-editable (term lock wins)", () => {
        // semesterLocked precedes the in_progress branch, so this is locked
        // regardless — but the result must still be not-editable (no regress).
        const v = computeSlotState(inProgressSlot(), {
            isFrozen: false,
            semesterLocked: true,
            ipChangeability: { window: "future", editable: true },
        });
        expect(v.editable).toBe(false);
    });
});
