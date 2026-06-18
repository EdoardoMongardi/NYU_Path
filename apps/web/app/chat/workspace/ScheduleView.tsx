// ============================================================
// ScheduleView — reusable single-schedule term grid
// ============================================================
// H2.2 — renders ONE ForwardSchedule as a term grid, reusing the
// `renderSlotInner` / `formatTermLabel` helpers from the sidebar.
// Used by the scenarios workspace + compare view.
//
// DESIGN NOTE (why built fresh rather than extracting from scheduleSidebar):
// `scheduleSidebar.tsx` is deeply entangled with interactive handlers
// (popovers, spinners, add-course affordance, pending slots, etc.) that
// require a dozen pieces of local state and prop-drilling. A risky
// refactor of that surface is NOT required for H2.2; the sidebar is left
// untouched. `ScheduleView` is a thin, purpose-built grid that reuses the
// low-level helpers (`renderSlotInner`, `formatTermLabel`) and applies
// diff highlights on top.
//
// Props:
//   schedule   — the ForwardSchedule to render.
//   diff       — optional AnnotatedColumn from scheduleDiff.ts; when
//                present each course gets a diff CSS class.
//   readOnly   — when true, suppress all interactive affordances (no click
//                handler, no popover title). Default false.
// ============================================================
"use client";

import type { ReactElement } from "react";
import { useState } from "react";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import type { AnnotatedColumn, CourseDiff } from "../../../lib/scenarios/scheduleDiff";
import { renderSlotInner, slotGradeText } from "../sidebar/slotRenderHelpers";
import { formatTermLabel, slotCredits } from "../sidebar/sidebarFormatters";
import { slotTierClassName } from "../sidebar/slotTier";
import styles from "../chat.module.css";
import workspaceStyles from "./workspace.module.css";

// ============================================================
// Public types
// ============================================================

export interface ScheduleViewProps {
    schedule: ForwardSchedule;
    /** Optional compare-diff annotations for THIS schedule's column. When
     *  present, each course gets a diff class (same|added|removed|moved|retake)
     *  so the compare view can highlight changes. Absent → plain render. */
    diff?: AnnotatedColumn;
    /** When true, render non-interactive (no ⋯ menus / popovers) — used for
     *  what-if / compare columns. Default false (the committed plan is editable). */
    readOnly?: boolean;
}

// ============================================================
// Pure helper — diffClassFor
// ============================================================
// Exported for unit testing (diffClassFor.test.ts). Returns the CSS
// class name for a given course's diff annotation, or null when the
// diff is absent or the course is `same` (no highlight needed).

export function diffClassFor(
    diff: AnnotatedColumn | undefined,
    term: string,
    courseId: string,
): string | null {
    if (!diff) return null;
    const termBucket = diff.terms.find((t) => t.term === term);
    if (!termBucket) return null;
    const row = termBucket.rows.find((r) => r.courseId === courseId);
    if (!row) return null;
    return diffCssClass(row.diff);
}

function diffCssClass(d: CourseDiff): string | null {
    switch (d) {
        case "same":    return null;
        case "added":   return "diff-added";
        case "removed": return "diff-removed";
        case "retake":  return "diff-retake";
        case "moved":   return "diff-moved";
    }
}

/** Map from the plain diff class name to the CSS module class. */
function workspaceDiffClass(name: string | null): string {
    if (!name) return "";
    switch (name) {
        case "diff-added":   return workspaceStyles.diffAdded;
        case "diff-removed": return workspaceStyles.diffRemoved;
        case "diff-retake":  return workspaceStyles.diffRetake;
        case "diff-moved":   return workspaceStyles.diffMoved;
        default:             return "";
    }
}

// ============================================================
// Slot identity helper (mirrors scheduleSidebar.slotKey)
// ============================================================

function slotCourseKey(slot: ScheduleSlot): string {
    if (
        slot.kind === "specific_planned" ||
        slot.kind === "completed" ||
        slot.kind === "in_progress"
    ) {
        return slot.courseId;
    }
    return `placeholder(${slot.category})`;
}

// ============================================================
// ScheduleView component
// ============================================================

export default function ScheduleView({
    schedule,
    diff,
    readOnly = false,
}: ScheduleViewProps): ReactElement {
    // Controlled popover state — only meaningful when readOnly=false.
    // Key format: `${semIdx}-${slotIdx}` (mirrors TermCard's approach).
    const [openPopoverKey, setOpenPopoverKey] = useState<string | null>(null);

    const handleSlotClick = (key: string, slot: ScheduleSlot): void => {
        if (readOnly) return;
        if (slot.kind === "completed") return;
        setOpenPopoverKey((prev) => (prev === key ? null : key));
    };

    return (
        <div className={workspaceStyles.scheduleGrid}>
            {schedule.semesters.map((sem, semIdx) => {
                const termLabel = formatTermLabel(sem.term);
                const termCredits = sem.plannedCredits;

                return (
                    <section
                        key={sem.term}
                        className={[
                            styles.semesterCard,
                            sem.locked ? styles.locked : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                    >
                        <header className={styles.semesterCardHeader}>
                            <h3>{termLabel}</h3>
                            <span className={styles.semesterCardHeaderRight}>
                                <span className={styles.semesterCredits}>{termCredits} cr</span>
                            </span>
                        </header>

                        {sem.notes.length > 0 && (
                            <ul className={styles.semesterNotes}>
                                {sem.notes.map((n, i) => (
                                    <li key={i}>{n}</li>
                                ))}
                            </ul>
                        )}

                        <ul className={styles.slotList}>
                            {sem.slots.map((slot, slotIdx) => {
                                const key = `${semIdx}-${slotIdx}`;
                                const isLocked = slot.kind === "completed";
                                const tierClass = slotTierClassName(slot);

                                // Diff annotation for this course in this term.
                                const courseId = slotCourseKey(slot);
                                const diffName = diffClassFor(diff, sem.term, courseId);
                                const diffModule = workspaceDiffClass(diffName);

                                // In readOnly mode: no click title, no popover.
                                const interactive = !readOnly && !sem.locked && !isLocked;

                                return (
                                    <li
                                        key={slotIdx}
                                        data-diff={diffName ?? undefined}
                                        className={[
                                            styles[`slot_${slot.kind}`],
                                            slot.kind === "placeholder" && slot.optional
                                                ? styles.slotOptional
                                                : "",
                                            isLocked ? styles.slotLocked : interactive ? styles.slotClickable : "",
                                            tierClass ? styles.slotTier : "",
                                            tierClass ?? "",
                                            diffModule,
                                        ]
                                            .filter(Boolean)
                                            .join(" ")}
                                        onClick={interactive ? () => handleSlotClick(key, slot) : undefined}
                                        title={
                                            isLocked
                                                ? "Completed — locked"
                                                : slot.kind === "in_progress"
                                                    ? "In progress"
                                                    : interactive
                                                        ? "Click to open verbs"
                                                        : undefined
                                        }
                                    >
                                        {renderSlotInner(slot)}
                                        <span className={styles.slotGradeCell}>
                                            {slotGradeText(slot)}
                                        </span>
                                        {/* Minimal lock/IP glyph (readOnly: no full slotState) */}
                                        <span className={styles.slotLockIcon} aria-hidden="true">
                                            {isLocked
                                                ? "🔒"
                                                : slot.kind === "in_progress"
                                                    ? "◐"
                                                    : ""}
                                        </span>

                                        {/* Popover: only in editable mode when this slot is open.
                                            H6 will add the full SlotRow popover integration; for
                                            now the indicator shows the slot is selected. */}
                                        {!readOnly && openPopoverKey === key && !isLocked && (
                                            <div
                                                className={styles.slotPopover}
                                                role="dialog"
                                                aria-label="Slot actions"
                                            >
                                                {/* The full popover (swap/drop/lock/move/explain/what-if)
                                                    is wired in the sidebar via SlotRow; here we render a
                                                    placeholder until H6 integrates the full workspace toolbar. */}
                                                <span className={styles.slotPopoverContent}>
                                                    Actions coming in H6
                                                </span>
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}
