// ============================================================
// slotActionView.ts — pure SlotActionMatrix → view-item mapper (F1)
// ============================================================
// Maps a SlotActionMatrix (computed by the engine's slotActionMatrix()
// function) to a flat array of view items that the SlotActionPopover
// (F2) and other UI leaves can render directly — no engine logic here.
//
// WHY add is excluded:
//   Per D-2 (plan 37 slot-editor spec), ADD is a TERM-level action,
//   not a per-slot action. The F4 term affordance owns it.  Including
//   "add" in the per-slot menu would be confusing and wrong — you
//   cannot "add" anything to a slot that already exists.  The popover
//   only gates the 3 per-slot verbs: drop / withdraw / passFail.
//
// PURE — no I/O, no React, no store imports.
// ============================================================

import type { SlotAction, SlotActionMatrix } from "@nyupath/engine";

// ---- Public type ----

export interface SlotActionViewItem {
    action: SlotAction;
    label: string;
    enabled: boolean;
    /** When ENABLED: the hedge from perAction (if any); indicates the user
     *  should verify the deadline.  When DISABLED: the reason from perAction
     *  explaining why the action is unavailable.  Absent when there is no
     *  hedge/reason (e.g. a drop with no hedge). */
    tooltip?: string;
}

// ---- Action metadata (per-slot only — add excluded) ----

const PER_SLOT_ACTIONS: Array<{ action: SlotAction; label: string }> = [
    { action: "drop",      label: "Drop" },
    { action: "withdraw",  label: "Withdraw" },
    { action: "passFail",  label: "Pass/Fail" },
];

// ---- Pure mapper ----

/**
 * Map a {@link SlotActionMatrix} to a stable ordered array of
 * {@link SlotActionViewItem}s, one per per-slot action (drop, withdraw,
 * passFail).  The `add` action is intentionally omitted — it is a
 * term-level affordance (F4), not a per-slot verb.
 */
export function slotActionView(matrix: SlotActionMatrix): SlotActionViewItem[] {
    return PER_SLOT_ACTIONS.map(({ action, label }) => {
        const enabled = matrix.allowed[action];
        const decision = matrix.perAction[action];

        // When enabled: surface the hedge (may be undefined → no tooltip).
        // When disabled: surface the reason (may be undefined → no tooltip).
        const tooltip = enabled ? decision.hedge : decision.reason;

        return { action, label, enabled, tooltip };
    });
}
