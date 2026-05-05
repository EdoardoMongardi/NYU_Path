// ============================================================
// SlotRow — single slot pill inside a term card's slot list
// ============================================================
// Phase 17 Task D pre-flight extraction. Owns:
//   - tier-tint + locked / draggable class derivation
//   - the inline spinner / grade cell swap
//   - draggable affordance + cross-term/exchange drop targets
//   - per-slot click → open popover
//   - the popover render (4-verb model: Swap / Drop / Lock / Move)
//
// All routing logic stays in the parent (`scheduleSidebar.tsx`) —
// SlotRow only RECEIVES typed handlers.
// ============================================================
"use client";

import type { Fragment } from "react";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import styles from "../chat.module.css";
import { renderSlotPopover, type SlotPopoverHandlers } from "./slotPopover";
import { renderSlotInner, slotGradeText } from "./slotRenderHelpers";
import { slotTierClassName } from "./slotTier";

interface SlotRowProps {
    slot: ScheduleSlot;
    semIdx: number;
    slotIdx: number;
    /** Stable bucket term (e.g. "2026-fall"). */
    bucketTerm: string;
    /** Whether this slot's row should render the locked-styled (history)
     *  variant. The popover is suppressed when true. */
    isLocked: boolean;
    isPending: boolean;
    isOpen: boolean;
    isDraggable: boolean;
    schedule: ForwardSchedule | null;
    /** Phase 17 Task D — the freeze flag plumbed in from the
     *  SchedulePreferences.pins[] walk. Drives the popover's
     *  Lock/Unlock label + the Lock toggle's `locked: !slot.isFrozen`
     *  semantic. */
    isFrozen: boolean;
    /** Popover submenu state. `null` → just the verb row visible. */
    submenu: "swap" | "move" | null;
    onSlotClick: () => void;
    onSubmenuToggle: (v: "swap" | "move" | null) => void;
    handlers: SlotPopoverHandlers;
    /** Drag-to-move source-ref + drop-target plumbing comes from the
     *  parent so the parent owns the live useRef + state. */
    onDragStart: (e: React.DragEvent<HTMLLIElement>) => void;
    onDragOverSlot: (e: React.DragEvent<HTMLElement>) => void;
    onDropSlot: (e: React.DragEvent<HTMLElement>) => void;
}

export default function SlotRow(props: SlotRowProps) {
    const {
        slot, slotIdx, isLocked, isPending, isOpen, isDraggable,
        schedule, isFrozen, submenu, onSlotClick, onSubmenuToggle,
        handlers, onDragStart, onDragOverSlot, onDropSlot,
        bucketTerm,
    } = props;
    const tierClass = slotTierClassName(slot);

    return (
        <li
            key={slotIdx}
            className={[
                styles[`slot_${slot.kind}`],
                slot.kind === "placeholder" && slot.optional ? styles.slotOptional : "",
                isLocked ? styles.slotLocked : styles.slotClickable,
                tierClass ? styles.slotTier : "",
                tierClass ?? "",
                isDraggable ? styles.slotDraggable : "",
                isFrozen ? styles.slotFrozen : "",
            ].filter(Boolean).join(" ")}
            onClick={onSlotClick}
            title={
                isLocked
                    ? "Completed — locked"
                    : isFrozen
                        ? "Locked — click to unlock or drag to move (the lock will travel with it)"
                        : "Click to open verbs · drag to move"
            }
            draggable={isDraggable}
            onDragStart={isDraggable ? onDragStart : undefined}
            onDragOver={isDraggable ? onDragOverSlot : undefined}
            onDrop={isDraggable ? onDropSlot : undefined}
        >
            {renderSlotInner(slot)}
            {isPending ? (
                <span className={styles.slotSpinner} aria-label="Validating plan change" role="status" />
            ) : (
                <span className={styles.slotGradeCell}>{slotGradeText(slot)}</span>
            )}
            <span
                className={styles.slotLockIcon}
                aria-label={isLocked ? "locked" : isFrozen ? "frozen" : ""}
                title={isLocked ? "Completed — cannot edit" : isFrozen ? "Locked by you" : ""}
                aria-hidden={!isLocked && !isFrozen}
            >
                {isLocked ? "🔒" : isFrozen ? "🔒" : ""}
            </span>
            {isOpen && !isLocked && renderSlotPopover({
                slot,
                term: bucketTerm,
                isFrozen,
                submenu,
                onSubmenuToggle,
                schedule,
                handlers,
            })}
        </li>
    );
}

// Stub re-export so tree-shaking keeps the helpers grouped with the
// component. Not consumed elsewhere.
export type { Fragment };
