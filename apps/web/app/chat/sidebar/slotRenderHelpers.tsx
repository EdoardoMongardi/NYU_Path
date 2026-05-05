// ============================================================
// slotRenderHelpers — text + cell rendering for sidebar slot rows
// ============================================================
// Phase 17 Task D pre-flight extraction. Pulled out of
// `scheduleSidebar.tsx` so the SlotRow component can render a slot
// without re-importing the whole sidebar module.
// ============================================================
"use client";

import type { Fragment as ReactFragment } from "react";
import type { ScheduleSlot } from "@nyupath/shared";
import styles from "../chat.module.css";

/** Per-slot grade-column text. completed → letter grade; IP → "IP";
 *  specific_planned / placeholder → em-dash. */
export function slotGradeText(slot: ScheduleSlot): string {
    switch (slot.kind) {
        case "completed":
            return slot.grade;
        case "in_progress":
            return "IP";
        case "specific_planned":
        case "placeholder":
            return "—";
    }
}

/**
 * Render the inner contents of a slot row (icon + course id + title +
 * credits). The wrapping <li> is the SlotRow component's
 * responsibility (so it can attach onClick / drag handlers).
 */
export function renderSlotInner(slot: ScheduleSlot): React.ReactNode {
    switch (slot.kind) {
        case "completed":
            return (
                <>
                    <span className={styles.slotIcon}>✓</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    {slot.title && slot.title !== slot.courseId && (
                        <span className={styles.slotTitle}>{slot.title}</span>
                    )}
                    <span className={styles.slotMeta}>{slot.credits}cr</span>
                </>
            );
        case "in_progress":
            return (
                <>
                    <span className={styles.slotIcon}>⏳</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    {slot.title && slot.title !== slot.courseId && (
                        <span className={styles.slotTitle}>{slot.title}</span>
                    )}
                    <span className={styles.slotMeta}>{slot.credits}cr</span>
                </>
            );
        case "specific_planned":
            return (
                <>
                    <span className={styles.slotIcon}>📅</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    {slot.title && slot.title !== slot.courseId && (
                        <span className={styles.slotTitle}>{slot.title}</span>
                    )}
                    <span className={styles.slotMeta}>{slot.credits}cr</span>
                    {slot.requiresPetition && <span className={styles.slotFlag} title="Requires petition (instructor permission)">⚠</span>}
                </>
            );
        case "placeholder":
            return (
                <>
                    <span className={styles.slotIcon}>{slot.optional ? "○" : "●"}</span>
                    <span className={styles.slotPlaceholderCategory}>{slot.category}</span>
                    <span className={styles.slotMeta}>
                        {slot.credits}cr
                        {slot.optional && <span className={styles.slotOptionalTag}> · optional</span>}
                    </span>
                </>
            );
    }
}

// Stub re-export so tree-shaking keeps everything grouped.
export type { ReactFragment };
