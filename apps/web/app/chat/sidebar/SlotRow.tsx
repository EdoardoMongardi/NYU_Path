// ============================================================
// SlotRow — single slot pill inside a term card's slot list
// ============================================================
// Phase 17 Task D pre-flight extraction. Owns:
//   - tier-tint + locked class derivation
//   - the inline spinner / grade cell swap
//   - per-slot click → open popover
//   - the popover render (4-verb model: Swap / Drop / Lock / Move)
//
// All routing logic stays in the parent (`scheduleSidebar.tsx`) —
// SlotRow only RECEIVES typed handlers. Phase 4 Task E3.4 removed the
// drag gesture entirely; the per-course ⋯ menu is the sole edit input.
// ============================================================
"use client";

import type { Fragment } from "react";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import styles from "../chat.module.css";
import { renderSlotPopover, type SlotPopoverHandlers } from "./slotPopover";
import { renderSlotInner, slotGradeText } from "./slotRenderHelpers";
import { slotTierClassName } from "./slotTier";
import { computeSlotState, type SlotIpChangeability } from "./slotState";

interface SlotRowProps {
    slot: ScheduleSlot;
    semIdx: number;
    slotIdx: number;
    /** Stable bucket term (e.g. "2026-fall"). */
    bucketTerm: string;
    /** Whether this slot's row should render the locked-styled (history)
     *  variant. The popover is suppressed when true. */
    isLocked: boolean;
    /** Phase 4 Task E2.2 — the slot's `ForwardSemester.locked` (a
     *  DPR-derived history / in-progress term). When true the slot is
     *  term-locked (🔒 / not editable) regardless of kind. Sourced from
     *  the render-plan bucket's `locked` flag in TermCard. */
    semesterLocked: boolean;
    /** F3 — the IP-changeability classification for this slot's term, when
     *  it's an in_progress (IP) bucket. Threaded from the term card's
     *  `bucket.ipChangeability`. When present, an in_progress slot's
     *  editable + label/hedge come from the honest registration-window
     *  state; when absent, the slot keeps its back-compat IP treatment. */
    ipChangeability?: SlotIpChangeability;
    isPending: boolean;
    isOpen: boolean;
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
}

export default function SlotRow(props: SlotRowProps) {
    const {
        slot, slotIdx, isLocked, semesterLocked, ipChangeability, isPending, isOpen,
        schedule, isFrozen, submenu, onSlotClick, onSubmenuToggle,
        handlers, bucketTerm,
    } = props;
    const tierClass = slotTierClassName(slot);

    // Phase 4 Task E2.2 — the design §8 slot-state view (🔒 / ◐ /
    // planned-movable). The pure `computeSlotState` helper is the single
    // source of truth for the glyph + label + aria-label this row
    // renders; the component holds no slot-state decision logic of its
    // own. We pass the honest `semesterLocked` (the bucket's
    // `ForwardSemester.locked`) — `completed` is handled by the helper's
    // own kind-first branch, so it needs no `|| isLocked` fold.
    const slotState = computeSlotState(slot, {
        isFrozen,
        semesterLocked,
        ...(ipChangeability ? { ipChangeability } : {}),
    });

    return (
        <li
            key={slotIdx}
            className={[
                styles[`slot_${slot.kind}`],
                slot.kind === "placeholder" && slot.optional ? styles.slotOptional : "",
                isLocked ? styles.slotLocked : styles.slotClickable,
                tierClass ? styles.slotTier : "",
                tierClass ?? "",
                isFrozen ? styles.slotFrozen : "",
            ].filter(Boolean).join(" ")}
            onClick={onSlotClick}
            title={
                isLocked
                    ? "Completed — locked"
                    : isFrozen
                        ? "Locked — click to open verbs (unlock / move via the ⋯ menu)"
                        : slot.kind === "in_progress"
                            // F3 — surface the full "verify with your adviser"
                            // hedge as the tooltip when one applies; otherwise
                            // the concise window-honest label.
                            ? (slotState.title ?? slotState.label)
                            : "Click to open verbs"
            }
        >
            {renderSlotInner(slot)}
            {isPending ? (
                <span className={styles.slotSpinner} aria-label="Validating plan change" role="status" />
            ) : (
                <span className={styles.slotGradeCell}>{slotGradeText(slot)}</span>
            )}
            {/* Phase 4 Task E2.2 — the design §8 slot-state glyph. 🔒 for
                taken/final, locked-by-you, or a term-locked slot; ◐ for an
                in-progress slot (the IP rule made visible); empty for a
                planned/movable slot (its movable state is shown by the row
                affordances, not a glyph). Glyph + labels come straight from
                the pure `computeSlotState` helper. */}
            <span
                className={styles.slotLockIcon}
                aria-label={slotState.glyph ? slotState.ariaLabel : ""}
                title={slotState.glyph ? slotState.label : ""}
                aria-hidden={slotState.glyph === ""}
            >
                {slotState.glyph}
            </span>
            {isOpen && !isLocked && renderSlotPopover({
                slot,
                term: bucketTerm,
                isFrozen,
                submenu,
                onSubmenuToggle,
                schedule,
                handlers,
                // G3.2 — pass the F3 changeability through so the popover can
                // offer the what-if section for in_progress slots.
                ...(ipChangeability ? { ipChangeability } : {}),
            })}
        </li>
    );
}

// Stub re-export so tree-shaking keeps the helpers grouped with the
// component. Not consumed elsewhere.
export type { Fragment };
