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
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import type { AnnotatedColumn, CourseDiff } from "../../../lib/scenarios/scheduleDiff";
import { slotKey } from "../../../lib/scenarios/scheduleDiff";
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
    /** When true, render non-interactive (no slot click affordance) — used by
     *  the workspace (all kinds) + compare columns. Plan 36 has NO workspace
     *  slot editor (editing is chat-only: propose → scenario → confirm), so
     *  workspace schedules pass readOnly. Default false keeps ScheduleView a
     *  general display grid; in readOnly it is purely presentational. */
    readOnly?: boolean;
    /** When true, force a single-column term layout (one term per row) — used
     *  by the compare columns so two side-by-side grids stay readable. */
    singleColumn?: boolean;
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
// Slot identity helper
// ============================================================
// Delegate to scheduleDiff's slotKey so the diff-lookup key here is BYTE-
// IDENTICAL to the key scheduleDiff stored (canonicalizeCourseId for courses,
// `placeholder:${placeholderId}` for placeholders). A divergent key (raw vs
// canonical course id, or placeholder-by-category) silently drops highlights.

function slotCourseKey(slot: ScheduleSlot): string {
    return slotKey(slot).key;
}

// ============================================================
// ScheduleView component
// ============================================================

export default function ScheduleView({
    schedule,
    diff,
    readOnly = false,
    singleColumn = false,
}: ScheduleViewProps): ReactElement {
    const gridClass = [
        workspaceStyles.scheduleGrid,
        singleColumn ? workspaceStyles.scheduleGridSingle : "",
    ]
        .filter(Boolean)
        .join(" ");

    return (
        <div className={gridClass}>
            {schedule.semesters.map((sem) => {
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
                                const isLocked = slot.kind === "completed";
                                const tierClass = slotTierClassName(slot);

                                // Diff annotation for this course in this term.
                                const courseId = slotCourseKey(slot);
                                const diffName = diffClassFor(diff, sem.term, courseId);
                                const diffModule = workspaceDiffClass(diffName);

                                // Cleanup A (H6.1): the workspace has NO slot editor —
                                // editing happens in chat (propose → scenario → confirm).
                                // ScheduleView is therefore a purely-PRESENTATIONAL grid:
                                // no slot click handler, no popover, no false "clickable"
                                // affordance. The `readOnly` prop is retained for API
                                // compatibility (all workspace + compare usages pass it)
                                // but the grid is non-interactive at the slot level either
                                // way. The lock/in-progress glyph is the only per-slot
                                // status signal.
                                return (
                                    <li
                                        key={slotIdx}
                                        data-diff={diffName ?? undefined}
                                        className={[
                                            styles[`slot_${slot.kind}`],
                                            slot.kind === "placeholder" && slot.optional
                                                ? styles.slotOptional
                                                : "",
                                            isLocked ? styles.slotLocked : "",
                                            tierClass ? styles.slotTier : "",
                                            tierClass ?? "",
                                            diffModule,
                                        ]
                                            .filter(Boolean)
                                            .join(" ")}
                                        title={
                                            isLocked
                                                ? "Completed — locked"
                                                : slot.kind === "in_progress"
                                                    ? "In progress"
                                                    : undefined
                                        }
                                    >
                                        {renderSlotInner(slot)}
                                        <span className={styles.slotGradeCell}>
                                            {slotGradeText(slot)}
                                        </span>
                                        {/* Minimal lock/IP glyph (presentational status signal). */}
                                        <span className={styles.slotLockIcon} aria-hidden="true">
                                            {isLocked
                                                ? "🔒"
                                                : slot.kind === "in_progress"
                                                    ? "◐"
                                                    : ""}
                                        </span>
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
