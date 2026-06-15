// ============================================================
// slotState — Phase 4 Task E2.2 (visible slot-state glyph/label/edit)
// ============================================================
// Pure, framework-agnostic helper (NO React/JSX import) that maps a
// `ScheduleSlot` (+ its per-render frozen / semester-locked context) to
// the design §8 slot-state view: the glyph (🔒 / ◐ / none), a human
// label, an aria label, and whether the sidebar offers edit/move verbs
// for the slot.
//
// apps/web ships NO DOM render harness (vitest runs in node), so this
// lives outside the component and is unit-tested directly in
// apps/web/tests/slotStates.test.ts. `SlotRow.tsx` is a thin consumer:
// it renders the returned glyph/label and gates the popover/drag on the
// returned `editable`. This module is the SINGLE source of truth for
// the slot's visible state — no helper-says-X-but-component-does-Y
// mismatch.
//
// Design §8 (binding): "🔒 locked (taken, final) · ◐ IP (fixed in its
// term) · planned (movable)". This makes the core_philosophy.md:18 IP
// rule VISIBLE: a non-IP (completed/final) course is unmodifiable; an IP
// or planned course is student-instructable.
//
// ----------------------------------------------------------------------
// EDITABILITY — scope note (DONE_WITH_CONCERNS):
//   `editable` mirrors the component's ACTUAL gating today so the helper
//   stays the consistent source of truth (no silent behavior change):
//     - completed                → false (final; popover already
//                                  suppressed, never draggable).
//     - specific_planned / IP    → true  (both clickable + draggable
//                                  in TermCard today).
//     - placeholder              → true  (movable open slot).
//     - semesterLocked term      → false for EVERY kind (the term is
//                                  read-only / history).
//   The design labels IP "fixed in its term", but the component
//   currently lets you click + drag an in_progress slot. E2.2's mandate
//   is making the STATE visible (the ◐ glyph + "fixed in its term"
//   label/tooltip is that signal) — NOT silently stripping IP's move
//   verb. So `editable` for in_progress stays `true` to match the
//   component, and the open "should IP lose its move verb?" question is
//   left for the owner. A frozen (student-pinned) slot keeps its 🔒
//   "locked by you" treatment but stays editable (unlock / drag-to-move,
//   the lock travels with it) — matching SlotRow's existing isFrozen
//   path.
// ============================================================

import type { ScheduleSlot } from "@nyupath/shared";

export interface SlotStateView {
    /** The design §8 glyph: "🔒" (taken/final OR locked-by-you OR
     *  term-locked), "◐" (in-progress, fixed in its term), or "" for a
     *  planned/movable slot (which uses the `label` marker, not a glyph). */
    glyph: "🔒" | "◐" | "";
    /** Human label, e.g. "Taken (final)" / "In progress (fixed in its
     *  term)" / "Planned (movable)" / "Locked by you". */
    label: string;
    /** Assistive-tech label — always non-empty so the lock/movable
     *  distinction is exposed beyond the glyph alone. */
    ariaLabel: string;
    /** Does the sidebar offer edit/move verbs (popover + drag) for this
     *  slot? Mirrors the component's actual gating — see the scope note. */
    editable: boolean;
}

export interface SlotStateOpts {
    /** Slot is student-pinned (in SchedulePreferences.pins[]) — drives
     *  the 🔒 "locked by you" treatment. Still student-instructable. */
    isFrozen: boolean;
    /** The slot's `ForwardSemester.locked` — a DPR-derived history /
     *  in-progress term that is read-only for EVERY kind. */
    semesterLocked: boolean;
}

const LABELS = {
    takenFinal: "Taken (final)",
    inProgress: "In progress (fixed in its term)",
    planned: "Planned (movable)",
    lockedByYou: "Locked by you",
    termLocked: "Locked — past or in-progress term",
} as const;

/**
 * Map a slot + its render context to the design §8 slot-state view.
 *
 * Precedence (highest first):
 *   1. `completed`      → 🔒 taken/final, not editable. (Kind-specific
 *                         FIRST so a completed slot shows the design-§8
 *                         "taken, final" label even though it always
 *                         renders inside a `locked:true` history bucket —
 *                         otherwise the generic term-lock label would
 *                         mask it.)
 *   2. `semesterLocked` → 🔒 term-locked, not editable (any other kind).
 *   3. `isFrozen`       → 🔒 "locked by you", still editable (unlock /
 *                         move; the lock travels with it).
 *   4. `in_progress`    → ◐ "fixed in its term" (editable matches the
 *                         component today — see scope note).
 *   5. planned kinds    → no glyph, "Planned (movable)", editable.
 */
export function computeSlotState(slot: ScheduleSlot, opts: SlotStateOpts): SlotStateView {
    // 1. A completed course is final and unmodifiable (philosophy:18).
    //    Checked BEFORE the generic term-lock so the §8 "taken, final"
    //    label is the one users actually see (completed slots always sit
    //    in a locked history bucket).
    if (slot.kind === "completed") {
        return {
            glyph: "🔒",
            label: LABELS.takenFinal,
            ariaLabel: "Taken — final, cannot edit",
            editable: false,
        };
    }

    // 2. A locked semester (DPR history / in-progress term) is read-only
    //    for every remaining slot kind.
    if (opts.semesterLocked) {
        return {
            glyph: "🔒",
            label: LABELS.termLocked,
            ariaLabel: "Locked term — cannot edit",
            editable: false,
        };
    }

    // 3. A student-pinned (frozen) slot keeps the 🔒 "locked by you"
    //    treatment but stays student-instructable (unlock / drag-to-move).
    if (opts.isFrozen) {
        return {
            glyph: "🔒",
            label: LABELS.lockedByYou,
            ariaLabel: "Locked by you — click to unlock or drag to move",
            editable: true,
        };
    }

    // 4. An in-progress course — the IP rule made visible (◐). Editable
    //    matches the component's current gating; see the scope note.
    if (slot.kind === "in_progress") {
        return {
            glyph: "◐",
            label: LABELS.inProgress,
            ariaLabel: "In progress — fixed in its term",
            editable: true,
        };
    }

    // 5. A planned slot (specific_planned / placeholder) — movable.
    return {
        glyph: "",
        label: LABELS.planned,
        ariaLabel: "Planned — movable",
        editable: true,
    };
}
