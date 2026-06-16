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
    /** F3 — the full "verify with your adviser" hedge for an in_progress
     *  slot whose term was classified (`ipChangeability.hedge`). Surfaced
     *  as the slot's tooltip/title; the concise `label` stays the visible
     *  marker. Absent when there's no hedge to surface. */
    title?: string;
}

/** The window-classification an `in_progress` slot was given by the
 *  engine's `classifyIpChangeability` (F3 — IP-course temporal model).
 *  Threaded down from the caller (groupCoursesByTerm/TermCard), which
 *  derives the temporal context once + classifies each IP slot's term.
 *  A subset of the engine's `IpChangeabilityResult` (we don't need the
 *  rationale in the view). */
export interface SlotIpChangeability {
    /** "future" | "add_drop" | "withdraw_pf" | "closed" | "unknown". */
    window: "future" | "add_drop" | "withdraw_pf" | "closed" | "unknown";
    /** Whether the engine deems this IP course student-changeable. */
    editable: boolean;
    /** The full "verify with your adviser" hedge, when one applies.
     *  Surfaced as the slot's tooltip/title — NOT inlined into the tiny
     *  slot label (the agent surfaces the full prose in chat). */
    hedge?: string;
}

export interface SlotStateOpts {
    /** Slot is student-pinned (in SchedulePreferences.pins[]) — drives
     *  the 🔒 "locked by you" treatment. Still student-instructable. */
    isFrozen: boolean;
    /** The slot's `ForwardSemester.locked` — a DPR-derived history /
     *  in-progress term that is read-only for EVERY kind. */
    semesterLocked: boolean;
    /** F3 — per-IP-course changeability for an `in_progress` slot. When
     *  PRESENT, an in_progress slot's `editable` + label/aria come from
     *  this honest temporal classification instead of the blanket
     *  `in_progress → editable:true`. When ABSENT, in_progress keeps its
     *  back-compat behavior (editable: true, ◐, "fixed in its term").
     *  Ignored for non-in_progress kinds. */
    ipChangeability?: SlotIpChangeability;
}

const LABELS = {
    takenFinal: "Taken (final)",
    inProgress: "In progress (fixed in its term)",
    planned: "Planned (movable)",
    lockedByYou: "Locked by you",
    termLocked: "Locked — past or in-progress term",
} as const;

/** F3 — window-honest labels for an in_progress slot that carries an
 *  `ipChangeability` classification. Kept CONCISE (the agent surfaces the
 *  full hedge prose in chat; `hedge` rides through as the tooltip/title).
 *  Maps the engine's IpChangeWindow → a short marker + aria phrasing. */
const IP_WINDOW_LABELS: Record<
    SlotIpChangeability["window"],
    { label: string; aria: string }
> = {
    future: {
        label: "Planned for a future term — changeable",
        aria: "Planned for a future term — changeable",
    },
    add_drop: {
        label: "In progress (within add/drop)",
        aria: "In progress — within add/drop, changeable",
    },
    withdraw_pf: {
        label: "In progress — withdraw/pass-fail only (verify with adviser)",
        aria: "In progress — withdraw or pass-fail only; verify with your adviser",
    },
    closed: {
        label: "In progress — change windows closed (verify with adviser)",
        aria: "In progress — change windows closed; verify with your adviser",
    },
    unknown: {
        label: "In progress — changes need adviser verification",
        aria: "In progress — changes need adviser verification",
    },
};

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
 *   4. `in_progress`    → ◐. With an F3 `ipChangeability` classification:
 *                         editable + label/aria come from the honest
 *                         temporal window (closed → NOT editable; future →
 *                         changeable; withdraw_pf/unknown → editable+hedge).
 *                         Without it: back-compat "fixed in its term",
 *                         editable.
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

    // 4. An in-progress course — the IP rule made visible (◐). When the
    //    caller has classified the slot's term (F3 `ipChangeability`), the
    //    editable flag + label/aria come from that HONEST temporal window
    //    (future → changeable; closed → NOT editable; withdraw_pf/unknown →
    //    editable-with-a-hedge). Absent → keep the back-compat blanket
    //    (editable: true, "fixed in its term"). The ◐ glyph stays in every
    //    case (the slot is still an in-progress course); the full hedge
    //    prose rides through as the tooltip (`title`) via the SlotRow, NOT
    //    inlined into the tiny label.
    if (slot.kind === "in_progress") {
        const ip = opts.ipChangeability;
        if (ip) {
            const view = IP_WINDOW_LABELS[ip.window];
            return {
                glyph: "◐",
                label: view.label,
                ariaLabel: view.aria,
                editable: ip.editable,
                ...(ip.hedge ? { title: ip.hedge } : {}),
            };
        }
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
