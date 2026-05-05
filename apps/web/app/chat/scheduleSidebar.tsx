"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import type { ForwardSchedule, ScheduleSlot, SchedulePreferences, StudentProfile } from "@nyupath/shared";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { ForwardMaterializationPayload } from "../../lib/chatV2Client";
import { groupCoursesByTerm } from "../../lib/groupCoursesByTerm";
import {
    planAdd,
    planSwap,
    planDrop,
    planLock,
    planMove,
    type PlanActionResult,
    type PlanActionRouteResponse,
} from "../../lib/planActionClient";
import styles from "./chat.module.css";
import TermCard from "./sidebar/TermCard";
import SummaryCard from "./sidebar/SummaryCard";
import PriorCreditsCard from "./sidebar/PriorCreditsCard";
import { assumptionLabel, formatTermLabel } from "./sidebar/sidebarFormatters";
import type { SlotPopoverHandlers } from "./sidebar/slotPopover";

// Phase 16 Task B — env-flag-gated Clear button. The flag is read at
// render time (not module-eval) so a Vitest run that mutates the env
// before the test fixture mounts the sidebar still sees the fresh
// value.
function isTestClearEnabled(): boolean {
    return process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR === "1";
}

// Phase 17 Task D — env flag for the LLM polish stream. Off by
// default; ships dark. Page-side handler reads the same flag to
// decide whether to fire the polish round-trip after a bubble
// appears.
function isLlmPolishEnabled(): boolean {
    return process.env.NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH === "1";
}

// Phase 14 Task 10 — load-style proposals
const LOAD_STYLES: Array<{ value: "balanced" | "frontload" | "backload"; label: string; tooltip: string }> = [
    { value: "balanced", label: "Balanced", tooltip: "Propose a balanced credit load across all semesters" },
    { value: "frontload", label: "Frontload", tooltip: "Propose heavier semesters early, lighter ones later" },
    { value: "backload", label: "Backload", tooltip: "Propose lighter semesters early, heavier ones later" },
];

/**
 * Phase 17 Task D — sidebar-bottom toast latency threshold. Spinner
 * shows at 150ms+ (handled at the slot row level by the existing
 * Stage-1 in-flight Set); the toast appears when ANY spinner has been
 * on for at least 600ms. The spec keeps these two thresholds distinct
 * so the user sees feedback locally first, then a sidebar-level
 * "validating…" cue if the round-trip is unusually slow.
 */
const SIDEBAR_TOAST_THRESHOLD_MS = 600;

/**
 * Legacy verb-set surfaced via the optional `onProposeSlotChange`
 * callback. Kept as a no-op shim so existing page wiring (the
 * upstream chat-thread message kind) has a consistent transition
 * path until the inline confirm bubble fully replaces the old
 * synthesized chat-message flow.
 */
type LegacySlotAction = "lock" | "replace" | "drop" | "pin";

/**
 * Phase 17 Task C — slot-with-term tuple used by drag-to-move /
 * drag-to-exchange handlers.
 */
interface DragSlotRef {
    courseId: string;
    term: string;
}

interface ScheduleSidebarProps {
    schedule: ForwardSchedule | null;
    student?: StudentProfile | null;
    dpr?: DegreeProgressReport | null;
    materialization?: ForwardMaterializationPayload | null;
    /**
     * Phase 17 Task D — per-student SchedulePreferences row (loaded
     * via /api/session/restore on mount and updated whenever a
     * confirm round-trip persists new preferences). The sidebar walks
     * `pins[]` here at render time to mark slots as frozen → which
     * (a) flips the popover's Lock label to "Unlock" and (b) lets the
     * Lock-toggle handler send `locked: !isFrozen` instead of always
     * `true`. Optional because pre-onboarding the sidebar receives no
     * preferences row.
     */
    schedulePreferences?: SchedulePreferences | null;
    open: boolean;
    onClose: () => void;
    onProposeLoadStyle?: (style: "balanced" | "frontload" | "backload") => void;
    onProposeSlotChange?: (slot: ScheduleSlot, action: LegacySlotAction) => void;
    /**
     * Phase 17 Task C — fired AFTER each deterministic plan-action
     * route returns. Phase 17 Task D wires this into the page's
     * inline `plan_action_bubble` message kind so the result renders
     * in the chat thread as a Confirm / Keep-as-is / Override-anyway
     * affordance.
     */
    onPlanActionResult?: (
        verb: "add" | "swap" | "drop" | "lock" | "move",
        result: PlanActionResult<PlanActionRouteResponse>,
    ) => void;
    onConfirmCombination?: (proposalId: string) => void;
    onRefreshDpr?: (file: File) => Promise<void>;
    onClearAll?: () => Promise<void>;
}

export default function ScheduleSidebar({
    schedule,
    student,
    dpr,
    materialization,
    schedulePreferences,
    open,
    onClose,
    onProposeLoadStyle,
    onProposeSlotChange,
    onPlanActionResult,
    onConfirmCombination,
    onRefreshDpr,
    onClearAll,
}: ScheduleSidebarProps) {
    const [openPopover, setOpenPopover] = useState<string | null>(null);
    const [openSubmenu, setOpenSubmenu] = useState<{ key: string; verb: "swap" | "move" } | null>(null);
    const [pendingSlots, setPendingSlots] = useState<Set<string>>(() => new Set());
    /** Phase 17 Task D — first-spinner-on timestamp. Used to gate the
     *  sidebar-bottom toast at 600ms+. Reset whenever pendingSlots
     *  drains to empty. Stored in state (not a ref) so the toast
     *  becomes visible reactively. */
    const [pendingSince, setPendingSince] = useState<number | null>(null);
    /** Phase 17 Task D — is the sidebar-bottom toast currently
     *  rendered? Driven by `pendingSince` + a 600ms timer. */
    const [showToast, setShowToast] = useState(false);
    const [addCourseDraft, setAddCourseDraft] = useState<Map<string, string>>(() => new Map());
    const dragSourceRef = useRef<DragSlotRef | null>(null);
    const [dropTargetTerm, setDropTargetTerm] = useState<string | null>(null);
    const [selectedComboIdx, setSelectedComboIdx] = useState(0);
    const sidebarRef = useRef<HTMLElement>(null);
    const refreshDprInputRef = useRef<HTMLInputElement>(null);
    const [refreshing, setRefreshing] = useState(false);

    // Reset combination selection whenever the underlying materialization
    // changes (new term, new agent run, etc.).
    useEffect(() => {
        setSelectedComboIdx(0);
    }, [materialization?.computedAt]);

    // Close popover on outside click
    useEffect(() => {
        if (!openPopover) return;
        const handler = (e: MouseEvent) => {
            if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
                setOpenPopover(null);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [openPopover]);

    /**
     * Phase 17 Task D — sidebar-bottom toast timer. Schedules a
     * 600ms-from-pendingSince timeout; clears it whenever pendingSlots
     * drains (or pendingSince resets to null). The toast itself stays
     * rendered until pendingSlots is empty.
     */
    useEffect(() => {
        if (pendingSince === null) {
            setShowToast(false);
            return;
        }
        const elapsed = Date.now() - pendingSince;
        if (elapsed >= SIDEBAR_TOAST_THRESHOLD_MS) {
            setShowToast(true);
            return;
        }
        const id = setTimeout(() => setShowToast(true), SIDEBAR_TOAST_THRESHOLD_MS - elapsed);
        return () => clearTimeout(id);
    }, [pendingSince]);

    if (!open) return null;

    const hasBody = !!student || !!schedule;

    const handlePillClick = (style: "balanced" | "frontload" | "backload") => {
        onProposeLoadStyle?.(style);
    };

    const handleSlotClick = (key: string, slot: ScheduleSlot) => {
        if (slot.kind === "completed") return;
        setOpenPopover(prev => (prev === key ? null : key));
        setOpenSubmenu(null);
    };

    /**
     * Phase 17 Task D — derive the slot's stable identity key.
     * Returns `${term}::${courseId}` for concrete slots; placeholder
     * slots use a category-derived id so a swap-on-placeholder still
     * surfaces a spinner.
     */
    const slotKey = (slot: ScheduleSlot, term: string): string => {
        const id =
            slot.kind === "specific_planned" ||
            slot.kind === "completed" ||
            slot.kind === "in_progress"
                ? slot.courseId
                : `placeholder(${slot.category})`;
        return `${term}::${id}`;
    };

    /**
     * Phase 17 Task D — set of pin keys ("term::courseId") derived
     * from `schedule.schedulePreferences.pins[]` at render time. Drives
     * the SlotRow's `isFrozen` flag → which in turn flips the popover's
     * Lock/Unlock label and lets the Lock-toggle handler send
     * `locked: !isFrozen` instead of always `true`.
     *
     * Computed via useMemo so a re-render that doesn't change the
     * pins[] array doesn't allocate a fresh Set.
     */
    const frozenKeys = useMemo<Set<string>>(() => {
        const out = new Set<string>();
        const pins = schedulePreferences?.pins ?? [];
        for (const p of pins) {
            out.add(`${p.term}::${p.courseId}`);
        }
        return out;
    }, [schedulePreferences]);

    const markSlotPending = (key: string, pending: boolean): void => {
        setPendingSlots(prev => {
            const next = new Set(prev);
            if (pending) next.add(key);
            else next.delete(key);
            // Phase 17 Task D — toast timer maintenance. The sidebar
            // toast appears 600ms after the FIRST spinner turns on and
            // disappears the instant the LAST spinner clears.
            if (next.size === 0) {
                // Defer the reset so the same setState batch doesn't
                // race with the timer.
                setPendingSince(null);
            } else if (pending && prev.size === 0) {
                setPendingSince(Date.now());
            }
            return next;
        });
    };

    /**
     * Phase 17 Task D — surface a route response to the page (which
     * renders the inline confirm bubble). Falls back to a console
     * log when no `onPlanActionResult` is wired so manual debugging
     * still surfaces the result.
     */
    const announceResult = (
        verb: "add" | "swap" | "drop" | "lock" | "move",
        result: PlanActionResult<PlanActionRouteResponse>,
    ): void => {
        if (!result.ok) {
            console.error(`[plan/${verb}] HTTP ${result.status}: ${result.error}`);
        } else {
            const { feasible, consequences } = result.data;
            if (!feasible) {
                console.warn(`[plan/${verb}] refusal`, result.data);
            } else if (consequences.length > 0) {
                console.info(`[plan/${verb}] trade-offs`, result.data);
            } else {
                console.info(`[plan/${verb}] clean`, result.data);
            }
        }
        onPlanActionResult?.(verb, result);
    };

    /** Phase 17 Task D — Lock / Unlock click handler. The toggle is now
     *  bidirectional thanks to the sidebar-rendered `frozenKeys` walk:
     *  we look up the slot's frozen status and send the OPPOSITE value
     *  to the route. */
    const handleLockToggle = async (slot: ScheduleSlot, term: string): Promise<void> => {
        const courseId =
            slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress"
                ? slot.courseId
                : null;
        if (!courseId) return;
        const key = slotKey(slot, term);
        const wasFrozen = frozenKeys.has(key);
        markSlotPending(key, true);
        try {
            const result = await planLock({ courseId, term, locked: !wasFrozen });
            announceResult("lock", result);
            onProposeSlotChange?.(slot, "lock");
        } finally {
            markSlotPending(key, false);
            setOpenPopover(null);
            setOpenSubmenu(null);
        }
    };

    const handleDrop = async (slot: ScheduleSlot, term: string): Promise<void> => {
        const courseId =
            slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress"
                ? slot.courseId
                : null;
        if (!courseId) return;
        const key = slotKey(slot, term);
        markSlotPending(key, true);
        try {
            const result = await planDrop({ courseId, term });
            announceResult("drop", result);
            onProposeSlotChange?.(slot, "drop");
        } finally {
            markSlotPending(key, false);
            setOpenPopover(null);
            setOpenSubmenu(null);
        }
    };

    const handleSwap = async (
        slot: ScheduleSlot,
        term: string,
        candidateCourseId: string,
    ): Promise<void> => {
        const dropId =
            slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress"
                ? slot.courseId
                : null;
        if (!dropId) return;
        const trimmed = candidateCourseId.trim();
        if (trimmed.length === 0) return;
        const key = slotKey(slot, term);
        markSlotPending(key, true);
        try {
            const result = await planSwap({ drop: dropId, add: trimmed, term });
            announceResult("swap", result);
            onProposeSlotChange?.(slot, "replace");
        } finally {
            markSlotPending(key, false);
            setOpenPopover(null);
            setOpenSubmenu(null);
        }
    };

    const handleMove = async (
        slot: ScheduleSlot,
        fromTerm: string,
        toTerm: string,
    ): Promise<void> => {
        const courseId =
            slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress"
                ? slot.courseId
                : null;
        if (!courseId || fromTerm === toTerm) return;
        const key = slotKey(slot, fromTerm);
        markSlotPending(key, true);
        try {
            const result = await planMove({ courseId, fromTerm, toTerm });
            announceResult("move", result);
            onProposeSlotChange?.(slot, "pin");
        } finally {
            markSlotPending(key, false);
            setOpenPopover(null);
            setOpenSubmenu(null);
        }
    };

    const handleAddCourseSubmit = async (term: string): Promise<void> => {
        const draft = (addCourseDraft.get(term) ?? "").trim();
        if (draft.length === 0) return;
        const key = `${term}::add(${draft})`;
        markSlotPending(key, true);
        try {
            const result = await planAdd({ courseId: draft, term });
            announceResult("add", result);
        } finally {
            markSlotPending(key, false);
            setAddCourseDraft(prev => {
                const next = new Map(prev);
                next.delete(term);
                return next;
            });
        }
    };

    const handleAddCourseOpen = (term: string): void => {
        setAddCourseDraft(prev => {
            const next = new Map(prev);
            next.set(term, "");
            return next;
        });
    };
    const handleAddCourseClose = (term: string): void => {
        setAddCourseDraft(prev => {
            const next = new Map(prev);
            next.delete(term);
            return next;
        });
    };
    const handleAddCourseChange = (term: string, value: string): void => {
        setAddCourseDraft(prev => {
            const next = new Map(prev);
            next.set(term, value);
            return next;
        });
    };

    /** Phase 17 Task C — slot-pill `onDragStart` handler. */
    const handleDragStart = (
        e: React.DragEvent<HTMLLIElement>,
        slot: ScheduleSlot,
        term: string,
    ): void => {
        const courseId =
            slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress"
                ? slot.courseId
                : null;
        if (!courseId) {
            e.preventDefault();
            return;
        }
        dragSourceRef.current = { courseId, term };
        try {
            e.dataTransfer.setData("application/x-nyupath-slot", JSON.stringify({ courseId, term }));
            e.dataTransfer.effectAllowed = "move";
        } catch { /* jsdom may not support dataTransfer */ }
    };

    const handleTermDragOver = (e: React.DragEvent<HTMLElement>, term: string): void => {
        if (!dragSourceRef.current) return;
        if (dragSourceRef.current.term === term) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "move"; } catch { /* */ }
        if (dropTargetTerm !== term) setDropTargetTerm(term);
    };

    const handleTermDragLeave = (term: string): void => {
        if (dropTargetTerm === term) setDropTargetTerm(null);
    };

    const handleTermDrop = async (
        e: React.DragEvent<HTMLElement>,
        targetTerm: string,
    ): Promise<void> => {
        e.preventDefault();
        const src = dragSourceRef.current;
        dragSourceRef.current = null;
        setDropTargetTerm(null);
        if (!src) return;
        if (src.term === targetTerm) return;
        const key = `${src.term}::${src.courseId}`;
        markSlotPending(key, true);
        try {
            const result = await planMove({
                courseId: src.courseId,
                fromTerm: src.term,
                toTerm: targetTerm,
            });
            announceResult("move", result);
        } finally {
            markSlotPending(key, false);
        }
    };

    const handleSlotDragOver = (e: React.DragEvent<HTMLElement>): void => {
        if (!dragSourceRef.current) return;
        e.preventDefault();
        e.stopPropagation();
    };

    const handleSlotDrop = async (
        e: React.DragEvent<HTMLElement>,
        target: { courseId: string; term: string },
    ): Promise<void> => {
        e.preventDefault();
        e.stopPropagation();
        const src = dragSourceRef.current;
        dragSourceRef.current = null;
        setDropTargetTerm(null);
        if (!src) return;
        if (src.courseId === target.courseId && src.term === target.term) return;
        if (src.term === target.term) {
            const key = `${src.term}::${src.courseId}`;
            markSlotPending(key, true);
            try {
                const result = await planSwap({
                    drop: src.courseId,
                    add: target.courseId,
                    term: src.term,
                });
                announceResult("swap", result);
            } finally {
                markSlotPending(key, false);
            }
            return;
        }
        const key = `${src.term}::${src.courseId}`;
        markSlotPending(key, true);
        try {
            const result = await planSwap({
                exchanges: [{
                    aCourseId: src.courseId,
                    aTerm: src.term,
                    bCourseId: target.courseId,
                    bTerm: target.term,
                }],
            });
            announceResult("swap", result);
        } finally {
            markSlotPending(key, false);
        }
    };

    const handleRefreshDprPick = async (file: File) => {
        if (!onRefreshDpr || refreshing) return;
        setRefreshing(true);
        try {
            await onRefreshDpr(file);
        } finally {
            setRefreshing(false);
        }
    };

    const testClearEnabled = isTestClearEnabled();

    // Reference to silence the "imported but unused" check on
    // isLlmPolishEnabled — page.tsx reads the same env flag for the
    // polish round-trip; this constant is exported indirectly via the
    // sidebar surface so the chat page doesn't need to duplicate the
    // helper. We keep the helper here to keep the env-flag check in
    // one place.
    void isLlmPolishEnabled;

    const slotPopoverHandlers: SlotPopoverHandlers = {
        onSwap: handleSwap,
        onMove: handleMove,
        onDrop: handleDrop,
        onLock: handleLockToggle,
    };

    return (
        <aside ref={sidebarRef} className={styles.scheduleSidebar} aria-label="Forward schedule">
            <div className={styles.scheduleSidebarHeader}>
                <h2 className={styles.scheduleSidebarTitle}>Your Schedule</h2>
                <button onClick={onClose} className={styles.scheduleSidebarClose} aria-label="Close schedule">✕</button>
            </div>
            {onRefreshDpr && (
                <div className={styles.sidebarToolbar}>
                    <button
                        type="button"
                        className={styles.sidebarToolbarBtn}
                        onClick={() => refreshDprInputRef.current?.click()}
                        disabled={refreshing}
                        title="Upload a fresh DPR PDF — re-plans your schedule if anything changed"
                    >
                        {refreshing ? "Updating…" : "↻ Update DPR"}
                    </button>
                    <input
                        ref={refreshDprInputRef}
                        type="file"
                        accept=".pdf"
                        className={styles.sidebarToolbarHiddenInput}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void handleRefreshDprPick(f);
                            e.target.value = "";
                        }}
                    />
                </div>
            )}
            {!hasBody ? (
                <p className={styles.scheduleSidebarEmpty}>
                    No plan yet. Ask me what to take next semester to compute one.
                </p>
            ) : (
                <div className={styles.scheduleSidebarBody}>
                    {student && <SummaryCard student={student} dpr={dpr ?? null} schedule={schedule} />}

                    {schedule && (
                        <p className={styles.scheduleSidebarMeta}>
                            Targeting graduation in <strong>{formatTermLabel(schedule.graduationTerm)}</strong>
                            {" · "}
                            <strong>{schedule.creditTargetPerSemester} credits</strong> per semester
                        </p>
                    )}

                    {schedule && (
                        <div className={styles.loadStylePills}>
                            {LOAD_STYLES.map(s => (
                                <button
                                    key={s.value}
                                    type="button"
                                    className={styles.loadStylePill}
                                    title={s.tooltip}
                                    onClick={() => handlePillClick(s.value)}
                                >
                                    {s.label}
                                </button>
                            ))}
                        </div>
                    )}

                    {schedule && schedule.state === "valid-with-trade-offs" && schedule.assumptions.length > 0 && (
                        <div className={styles.scheduleTradeOffsBanner}>
                            ℹ Plan has trade-offs or assumptions:
                            <ul>
                                {schedule.assumptions.slice(0, 5).map((a, i) => (
                                    <li key={i}>{assumptionLabel(a)}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {schedule && schedule.state === "infeasible-draft" && (
                        <div className={styles.scheduleInfeasibilityBanner}>
                            ⚠ Plan has constraint violations:
                            <ul>
                                {schedule.feasibility.constraintViolations.slice(0, 5).map((v, i) => (
                                    <li key={i}>{v.detail}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {schedule && schedule.state === "student-preferred-invalid-draft" && (
                        <div className={styles.scheduleStudentPrefBanner}>
                            ⚠ Student-confirmed plan despite warnings
                        </div>
                    )}

                    {(() => {
                        const grouped = groupCoursesByTerm({
                            student: student ?? null,
                            forwardSchedule: schedule,
                            dpr: dpr ?? null,
                        });
                        const immediateTerm = schedule?.semesters.find(s => !s.locked)?.term;
                        const forwardByTerm = new Map((schedule?.semesters ?? []).map(s => [s.term, s]));
                        return (
                            <>
                                <PriorCreditsCard entries={grouped.priorCredits} />
                                {grouped.terms.map((bucket, semIdx) => (
                                    <TermCard
                                        key={bucket.term}
                                        bucket={bucket}
                                        semIdx={semIdx}
                                        forwardSemester={forwardByTerm.get(bucket.term)}
                                        schedule={schedule}
                                        materialization={materialization ?? null}
                                        isImmediate={bucket.term === immediateTerm}
                                        frozenKeys={frozenKeys}
                                        pendingSlots={pendingSlots}
                                        openPopoverKey={openPopover}
                                        openSubmenu={openSubmenu}
                                        addCourseDraft={addCourseDraft.get(bucket.term)}
                                        dropTargetTerm={dropTargetTerm}
                                        selectedComboIdx={selectedComboIdx}
                                        setSelectedComboIdx={setSelectedComboIdx}
                                        onSlotClick={handleSlotClick}
                                        onSubmenuToggle={(key, verb) => {
                                            if (verb === null) setOpenSubmenu(null);
                                            else setOpenSubmenu({ key, verb });
                                        }}
                                        handlers={slotPopoverHandlers}
                                        {...(onConfirmCombination ? { onConfirmCombination } : {})}
                                        onAddCourseOpen={handleAddCourseOpen}
                                        onAddCourseClose={handleAddCourseClose}
                                        onAddCourseChange={handleAddCourseChange}
                                        onAddCourseSubmit={handleAddCourseSubmit}
                                        slotKeyOf={slotKey}
                                        onDragStartSlot={handleDragStart}
                                        onTermDragOver={handleTermDragOver}
                                        onTermDragLeave={handleTermDragLeave}
                                        onTermDrop={handleTermDrop}
                                        onSlotDragOver={handleSlotDragOver}
                                        onSlotDrop={handleSlotDrop}
                                    />
                                ))}
                                {!schedule && (
                                    <p className={styles.scheduleSidebarEmpty}>
                                        No plan yet. Ask me what to take next semester to compute one.
                                    </p>
                                )}
                            </>
                        );
                    })()}
                </div>
            )}

            {/* Phase 17 Task D — sidebar-bottom toast. Renders when ANY
                slot's spinner has been on for 600ms+. Cleared the moment
                pendingSlots drains. Sits in its own container so it
                doesn't shift the body layout when it appears. */}
            {showToast && pendingSlots.size > 0 && (
                <div className={styles.sidebarToastContainer} role="status" aria-live="polite">
                    <div className={styles.sidebarToast}>
                        <span className={styles.slotSpinner} aria-hidden="true" />
                        <span>Validating plan change…</span>
                    </div>
                </div>
            )}

            {testClearEnabled && onClearAll && (
                <div className={styles.sidebarToolbarBottom}>
                    <button
                        type="button"
                        className={styles.sidebarClearBtn}
                        onClick={() => void onClearAll()}
                        title="Wipe ALL data for this student (test affordance)"
                    >
                        ⚠ Clear all data
                    </button>
                </div>
            )}
        </aside>
    );
}
