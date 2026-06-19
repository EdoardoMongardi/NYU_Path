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

import { type ReactElement, useState } from "react";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
// TYPE-ONLY import from the engine — `SlotAction`/`SlotActionMatrix` are pure
// types so this does NOT drag node:* into the client bundle (verified). The
// RUNTIME `slotActionMatrix` builder + the calendar const are sourced by the
// caller (page.tsx) via the client-safe `@nyupath/engine/client` entry and
// injected through the `slotMatrix` prop — ScheduleView never imports the
// engine barrel at runtime.
import type { SlotAction, SlotActionMatrix } from "@nyupath/engine";
import type { AnnotatedColumn, CourseDiff } from "../../../lib/scenarios/scheduleDiff";
import { slotKey } from "../../../lib/scenarios/scheduleDiff";
import { renderSlotInner, slotGradeText } from "../sidebar/slotRenderHelpers";
import { formatTermLabel, slotCredits } from "../sidebar/sidebarFormatters";
import { slotTierClassName } from "../sidebar/slotTier";
import { slotActionView } from "./slotActionView";
import SlotActionPopover from "./SlotActionPopover";
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
     *  the proposed/whatif scenario columns + compare columns (read-only
     *  scenarios are never editable). The COMMITTED plan passes readOnly=false
     *  AND `slotMatrix`+`onSlotAction` to enable the slot-action popover (plan
     *  37 F3). Absent the editor props, the grid stays purely presentational in
     *  EITHER mode. Default false keeps ScheduleView a general display grid. */
    readOnly?: boolean;
    /** When true, force a single-column term layout (one term per row) — used
     *  by the compare columns so two side-by-side grids stay readable. */
    singleColumn?: boolean;
    /** Plan 37 F3 — the slot-action matrix builder. Called per slot to decide
     *  which of {drop, withdraw, passFail} the slot allows (3-state × F3
     *  window × school P/F policy). Injected by the COMMITTED-plan caller
     *  (page.tsx) so ScheduleView never imports the engine barrel at runtime.
     *  When absent (proposed/whatif columns), the slot grid is non-interactive. */
    slotMatrix?: (slot: ScheduleSlot, term: string) => SlotActionMatrix;
    /** Plan 37 F3 — dispatch a chosen per-slot action. The editor is
     *  PROPOSE-ONLY (D-8): this MUST route through the same propose pipeline a
     *  chat-driven change uses (POST /api/plan/{drop,whatif}) and NEVER
     *  auto-commit. Provided ONLY for the committed plan. When absent (or when
     *  readOnly is true), the slot grid is non-interactive. */
    onSlotAction?: (slot: ScheduleSlot, term: string, action: SlotAction) => void;
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
    slotMatrix,
    onSlotAction,
}: ScheduleViewProps): ReactElement {
    // Plan 37 F3 — the slot-action popover is interactive ONLY when the caller
    // opts in: the plan is editable (!readOnly) AND both editor props are
    // present (the COMMITTED plan). Proposed/whatif/compare columns (readOnly,
    // no props) stay purely presentational.
    const interactive = !readOnly && !!slotMatrix && !!onSlotAction;

    // Controlled open-popover key (one popover at a time). `null` = closed.
    // Keyed by `${term}::${slotIdx}` so identical course codes in different
    // terms/positions don't collide.
    const [openPopoverKey, setOpenPopoverKey] = useState<string | null>(null);

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

                                // Plan 37 F3 — the COMMITTED plan (interactive) gets a
                                // click-to-open slot-action popover; proposed/whatif/
                                // compare columns (readOnly or no editor props) stay
                                // purely PRESENTATIONAL (no click handler, no popover).
                                // The popover is PROPOSE-ONLY (D-8): clicking an action
                                // calls onSlotAction which routes through the existing
                                // propose pipeline; nothing commits until the workspace
                                // Confirm button.
                                const popoverKey = `${sem.term}::${slotIdx}`;
                                const isOpen = interactive && openPopoverKey === popoverKey;

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
                                            // .slotClickable supplies cursor:pointer +
                                            // position:relative (the popover anchor).
                                            interactive ? styles.slotClickable : "",
                                        ]
                                            .filter(Boolean)
                                            .join(" ")}
                                        title={
                                            interactive
                                                ? "Edit this course"
                                                : isLocked
                                                    ? "Completed — locked"
                                                    : slot.kind === "in_progress"
                                                        ? "In progress"
                                                        : undefined
                                        }
                                        onClick={
                                            interactive
                                                ? () =>
                                                      setOpenPopoverKey((cur) =>
                                                          cur === popoverKey ? null : popoverKey,
                                                      )
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
                                        {isOpen && slotMatrix && onSlotAction && (
                                            <SlotActionPopover
                                                items={slotActionView(slotMatrix(slot, sem.term))}
                                                onAction={(a) => {
                                                    onSlotAction(slot, sem.term, a);
                                                    setOpenPopoverKey(null);
                                                }}
                                                onClose={() => setOpenPopoverKey(null)}
                                            />
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
