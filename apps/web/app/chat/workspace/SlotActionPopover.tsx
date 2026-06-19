// ============================================================
// SlotActionPopover.tsx — presentational slot action menu (F2)
// ============================================================
// A PRESENTATIONAL popover component that renders the per-slot
// action buttons produced by slotActionView (F1).
//
// No store reads, no plan state — fully driven by props so it
// is trivially testable and reusable in any slot context.
//
// Props:
//   items     — the view items from slotActionView() (drop/withdraw/
//               passFail); order is preserved.
//   onAction  — called with the SlotAction string when an enabled
//               button is clicked.
//   onClose   — called when the user clicks the ✕ close button.
//               The CALLER is responsible for removing the popover
//               from the tree (this component never unmounts itself).
//
// Styling: reuses the .slotPopover + .slotPopover button rules from
// chat.module.css (the same rules that govern the existing sidebar
// slot popover in slotPopover.tsx), with a muted opacity + cursor
// override for disabled actions.
// ============================================================
"use client";

import type { ReactElement } from "react";
import type { SlotAction } from "@nyupath/engine";
import type { SlotActionViewItem } from "./slotActionView";
import styles from "../chat.module.css";

// ============================================================
// Public props
// ============================================================

export interface SlotActionPopoverProps {
    /** View items from slotActionView() — one per per-slot action. */
    items: SlotActionViewItem[];
    /** Called with the action string when an enabled button is clicked. */
    onAction: (action: SlotAction) => void;
    /** Called when the user activates the close control. */
    onClose: () => void;
}

// ============================================================
// Component
// ============================================================

export default function SlotActionPopover({
    items,
    onAction,
    onClose,
}: SlotActionPopoverProps): ReactElement {
    return (
        // Stop click propagation so the popover doesn't close when the user
        // clicks inside it (the parent usually closes on outside-click).
        <div
            className={styles.slotPopover}
            onClick={(e) => e.stopPropagation()}
            role="menu"
        >
            {/* Close control — ✕ in the top-right corner. */}
            <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
                <button
                    type="button"
                    aria-label="Close"
                    onClick={onClose}
                    style={{
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        fontSize: "0.9em",
                        color: "var(--text-tertiary)",
                        padding: "2px 4px",
                        lineHeight: 1,
                        borderRadius: 3,
                    }}
                >
                    ✕
                </button>
            </div>

            {/* Action buttons */}
            {items.map((item) => (
                <button
                    key={item.action}
                    type="button"
                    role="menuitem"
                    disabled={!item.enabled}
                    title={item.tooltip}
                    onClick={item.enabled ? () => onAction(item.action) : undefined}
                    style={
                        !item.enabled
                            ? { opacity: 0.45, cursor: "not-allowed" }
                            : undefined
                    }
                >
                    {item.label}
                </button>
            ))}
        </div>
    );
}
