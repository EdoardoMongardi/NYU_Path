"use client";

import { useState, useEffect, useRef } from "react";
import type { Assumption, ForwardSchedule, ScheduleSlot, StudentProfile } from "@nyupath/shared";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { ForwardMaterializationPayload } from "../../lib/chatV2Client";
import { formatPatterns } from "../../lib/formatMeetingPatterns";
import { groupCoursesByTerm, type PriorCreditEntry } from "../../lib/groupCoursesByTerm";
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

// Phase 16 Task B — env-flag-gated Clear button. The flag is read at
// render time (not module-eval) so a Vitest run that mutates the env
// before the test fixture mounts the sidebar still sees the fresh
// value.
function isTestClearEnabled(): boolean {
    return process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR === "1";
}

// Phase 14 Task 10 — load-style proposals
const LOAD_STYLES: Array<{ value: "balanced" | "frontload" | "backload"; label: string; tooltip: string }> = [
    { value: "balanced", label: "Balanced", tooltip: "Propose a balanced credit load across all semesters" },
    { value: "frontload", label: "Frontload", tooltip: "Propose heavier semesters early, lighter ones later" },
    { value: "backload", label: "Backload", tooltip: "Propose lighter semesters early, heavier ones later" },
];

/**
 * Phase 17 Task C — 4-verb slot popover model. The legacy `pin` verb
 * is dropped; "Add" lives on the term card (not the slot popover) so
 * Phase 17 routes a clean 4-verb surface here. The submenu-bearing
 * verbs (`swap`, `move`) keep `submenu: true` so the popover knows to
 * render an inline picker instead of firing the route on first click.
 */
type SlotVerb = "swap" | "drop" | "lock" | "move";
const SLOT_VERBS: Array<{ verb: SlotVerb; label: string; submenu: boolean }> = [
    { verb: "swap", label: "Swap with…", submenu: true },
    { verb: "drop", label: "Drop", submenu: false },
    { verb: "lock", label: "Lock / Unlock", submenu: false },
    { verb: "move", label: "Move to…", submenu: true },
];

/**
 * Legacy verb-set surfaced via the optional `onProposeSlotChange`
 * callback. Kept as a no-op shim because the previous page-side
 * handler is still wired in `page.tsx` (Task D will retire the shim
 * when it wires the inline confirm bubble through the new SSE event).
 */
type LegacySlotAction = "lock" | "replace" | "drop" | "pin";

/**
 * Phase 17 Task C — slot-with-term tuple used by drag-to-move /
 * drag-to-exchange handlers. The drag source carries the slot's
 * courseId + the bucket's term so the drop handler can construct the
 * route call without re-walking the grouped term buckets.
 */
interface DragSlotRef {
    courseId: string;
    term: string;
}

interface ScheduleSidebarProps {
    schedule: ForwardSchedule | null;
    /**
     * Phase 16 Task C — built StudentProfile (post-buildStudentProfileFromDpr).
     * The sidebar now consumes the profile to render historical term
     * cards (from `coursesTaken`) + the IP card (from `currentSemester`).
     * Optional because the page wires it in only after onboarding /
     * restore completes; pre-onboarding the sidebar only has a forward
     * schedule (or nothing) to draw.
     */
    student?: StudentProfile | null;
    /**
     * Phase 16 Task C — raw DegreeProgressReport. Source of truth for
     * the Prior Credits card (TE rows live on `dpr.courseHistory`; the
     * StudentProfile keeps them in `coursesTaken` with grade="TE" but
     * the `subject="ELECTIVE"` rows are filtered out at build time, so
     * the DPR is the only place to recover the AP/IB labels).
     */
    dpr?: DegreeProgressReport | null;
    /**
     * Phase 15 Task 8 — most recent `materialize_sections` output for
     * this session. When `state === "full"` AND its semester matches the
     * IMMEDIATE (first non-locked) term, the sidebar swaps that term's
     * structural slot list for the Sections view + combination picker.
     * `partial` / `unavailable` keep the structural list and surface the
     * orchestrator's `message` as a banner.
     */
    materialization?: ForwardMaterializationPayload | null;
    open: boolean;
    onClose: () => void;
    onProposeLoadStyle?: (style: "balanced" | "frontload" | "backload") => void;
    /**
     * Phase 14 — legacy chat-mediated slot-change callback. Phase 17
     * Task C wires the deterministic engine routes directly inside
     * the sidebar, so this prop is now optional. When provided, it is
     * still invoked with the legacy verb set (`lock | replace | drop |
     * pin`) AFTER the deterministic call resolves — gives existing
     * page wiring (and the upstream chat-thread message kind) a
     * consistent transition path until Task D's inline confirm bubble
     * lands.
     */
    onProposeSlotChange?: (slot: ScheduleSlot, action: LegacySlotAction) => void;
    /**
     * Phase 17 Task C — fired AFTER each deterministic plan-action
     * route (Add / Swap / Drop / Lock / Move) returns. The page can
     * use this to refresh local schedule state, append a chat-thread
     * message, or stage Task D's inline confirm bubble. Optional so
     * existing tests + Storybook fixtures don't have to wire it.
     */
    onPlanActionResult?: (
        verb: "add" | "swap" | "drop" | "lock" | "move",
        result: PlanActionResult<PlanActionRouteResponse>,
    ) => void;
    /**
     * Phase 15 Task 8 — invoked when the student clicks the
     * "Apply combination" button. Receives the proposalId of the
     * currently-selected combination tab. The page injects a
     * chat-visible message that asks the agent to call
     * `confirm_section_combination`.
     */
    onConfirmCombination?: (proposalId: string) => void;
    /**
     * Phase 16 Task B — Update-DPR file picker. Receives the
     * selected PDF; the page POSTs to /api/onboard/refresh-dpr and
     * updates `schedule` directly on success.
     */
    onRefreshDpr?: (file: File) => Promise<void>;
    /**
     * Phase 16 Task B — Clear-data button (test affordance).
     * Visible only when `NEXT_PUBLIC_ENABLE_TEST_CLEAR=1`. The page
     * shows a confirm dialog before firing.
     */
    onClearAll?: () => Promise<void>;
}

export default function ScheduleSidebar({
    schedule,
    student,
    dpr,
    materialization,
    open,
    onClose,
    onProposeLoadStyle,
    onProposeSlotChange,
    onPlanActionResult,
    onConfirmCombination,
    onRefreshDpr,
    onClearAll,
}: ScheduleSidebarProps) {
    // Track which slot's popover is open. Key = "semIdx-slotIdx"
    const [openPopover, setOpenPopover] = useState<string | null>(null);
    /**
     * Phase 17 Task C — which submenu (Swap or Move) is currently
     * expanded inside the open popover. `null` means the popover is
     * showing only the verb row. `{key, verb}` keys the expansion to
     * the same slot ref so closing/reopening the popover (or jumping
     * to a different slot) collapses cleanly.
     */
    const [openSubmenu, setOpenSubmenu] = useState<{ key: string; verb: "swap" | "move" } | null>(null);
    /**
     * Phase 17 Task C — per-slot in-flight Stage-1 spinner. Keyed by
     * `${term}::${courseId}` (the slot ref shape used by the
     * draggable + popover code paths). When a slot's key is in this
     * Set, the row replaces its grade cell with a small spinner.
     */
    const [pendingSlots, setPendingSlots] = useState<Set<string>>(() => new Set());
    /**
     * Phase 17 Task C — per-term-card "+ Add course" affordance state.
     * Keyed by term string. `null` means the input is closed for that
     * term; a string value carries the current input contents.
     */
    const [addCourseDraft, setAddCourseDraft] = useState<Map<string, string>>(() => new Map());
    /**
     * Phase 17 Task C — drag-to-move source ref. Set by `onDragStart`
     * on a slot pill, read by `onDrop` on the destination term card
     * (or destination slot, for cross-term exchange). Cleared at the
     * end of every drag op.
     */
    const dragSourceRef = useRef<DragSlotRef | null>(null);
    /**
     * Phase 17 Task C — which term card is currently the active drop
     * target. Drives the highlight ring rendered via
     * `.termCardDropTarget`. `null` means no drag is hovering. Stored
     * in state (not a ref) because the ring is a render concern.
     */
    const [dropTargetTerm, setDropTargetTerm] = useState<string | null>(null);
    // Phase 15 Task 8 — selected combination index for the Sections
    // picker. Defaults to 0 (the highest-scored combination per Task 6's
    // ranking) and resets whenever the materialization changes.
    const [selectedComboIdx, setSelectedComboIdx] = useState(0);
    // Ref for click-outside-to-close
    const sidebarRef = useRef<HTMLElement>(null);
    // Phase 16 Task B — Update-DPR hidden-file-input ref.
    const refreshDprInputRef = useRef<HTMLInputElement>(null);
    // Phase 16 Task B — Update-DPR pending state. Disables the button
    // while the network round-trip is in flight so the student can't
    // double-fire.
    const [refreshing, setRefreshing] = useState(false);

    // Reset combination selection whenever the underlying materialization
    // changes (new term, new agent run, etc.) so the picker doesn't
    // remember a tab index that may no longer exist. Depend on the
    // stable `computedAt` timestamp rather than the object reference so
    // no-op re-emits of the same materialization (e.g. an unrelated
    // follow-up turn that re-streams the same SSE event) don't clobber
    // the user's chosen combination tab.
    useEffect(() => {
        setSelectedComboIdx(0);
    }, [materialization?.computedAt]);

    // Close popover on outside click
    useEffect(() => {
        if (!openPopover) return;
        const handler = (e: MouseEvent) => {
            // If click is outside the sidebar entirely, close
            if (sidebarRef.current && !sidebarRef.current.contains(e.target as Node)) {
                setOpenPopover(null);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [openPopover]);

    if (!open) return null;

    // Phase 16 Task D — render-when-no-plan gap fix (Task C self-review
    // carry). The sidebar previously bailed at `if (!schedule) return
    // <empty state>`, which hid the student's history + IP cards even
    // after onboarding. Now the body renders whenever the student is
    // known; the no-plan empty-state line moves to the BOTTOM so the
    // historical context stays visible. The pre-onboarding case
    // (no student AND no schedule) still falls back to the empty state.
    const hasBody = !!student || !!schedule;

    const handlePillClick = (style: "balanced" | "frontload" | "backload") => {
        onProposeLoadStyle?.(style);
    };

    // Phase 16 Task C — Decision #16.4 edit gating. Completed (history)
    // slots are read-only; clicking them must NOT open the popover.
    // Other kinds (in_progress / specific_planned / placeholder) keep the
    // existing toggle behavior.
    const handleSlotClick = (key: string, slot: ScheduleSlot) => {
        if (slot.kind === "completed") return;
        setOpenPopover(prev => (prev === key ? null : key));
        setOpenSubmenu(null);
    };

    /**
     * Phase 17 Task C — derive the slot's stable identity key for the
     * pendingSlots Set + the drag source ref. Returns null when the
     * slot has no concrete courseId (placeholder slots use a generated
     * id derived from category + term so they can still surface a
     * spinner during a swap).
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
     * Mark a slot as in-flight (or clear it). Wraps the Set state
     * update in an immutable copy so React re-renders deterministically
     * across nested closures.
     */
    const markSlotPending = (key: string, pending: boolean): void => {
        setPendingSlots(prev => {
            const next = new Set(prev);
            if (pending) next.add(key);
            else next.delete(key);
            return next;
        });
    };

    /**
     * Phase 17 Task C — surface a route response to the user. Until
     * Task D wires the inline confirm bubble, we use deterministic
     * `alert()` placeholders so the explanation + pendingMutationId
     * are still visible end-to-end. The alerts will be replaced by
     * the bubble + console-only logging once Task D lands.
     */
    const announceResult = (
        verb: "add" | "swap" | "drop" | "lock" | "move",
        result: PlanActionResult<PlanActionRouteResponse>,
    ): void => {
        if (!result.ok) {
            const msg = `Plan action failed (${result.status}): ${result.error}`;
            console.error(`[plan/${verb}]`, msg);
            try { window.alert(msg); } catch { /* SSR / jsdom-no-window */ }
            onPlanActionResult?.(verb, result);
            return;
        }
        const { explanation, pendingMutationId, feasible, consequences } = result.data;
        if (!feasible) {
            const msg = `${explanation}\n\n(Refused — Task D will offer "Override anyway" for soft refusals.)\npendingMutationId=${pendingMutationId}`;
            console.warn(`[plan/${verb}] refusal`, msg);
            try { window.alert(msg); } catch { /* SSR / jsdom-no-window */ }
        } else if (consequences.length > 0) {
            const msg = `${explanation}\n\nConsequences:\n - ${consequences.join("\n - ")}\n\n(Trade-offs — Task D will render the inline Confirm / Keep-as-is bubble.)\npendingMutationId=${pendingMutationId}`;
            console.info(`[plan/${verb}] trade-offs`, msg);
            try { window.alert(msg); } catch { /* SSR / jsdom-no-window */ }
        } else {
            const msg = `Action validated: ${explanation}\n\npendingMutationId=${pendingMutationId}`;
            console.info(`[plan/${verb}] clean`, msg);
            try { window.alert(msg); } catch { /* SSR / jsdom-no-window */ }
        }
        onPlanActionResult?.(verb, result);
    };

    /** Phase 17 Task C — Lock / Unlock click handler. */
    const handleLockToggle = async (slot: ScheduleSlot, term: string): Promise<void> => {
        const courseId =
            slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress"
                ? slot.courseId
                : null;
        if (!courseId) return;
        const key = slotKey(slot, term);
        markSlotPending(key, true);
        try {
            // TODO(Phase 17 Task D): the popover label says "Lock /
            // Unlock" but this handler ALWAYS sends locked: true — the
            // toggle is currently one-way. The blocker is that
            // ScheduleSlot doesn't yet expose the freeze flag (Task A
            // landed it on PlanMutation.pin but not on the slot shape
            // the sidebar consumes), so we can't read `slot.isLocked`
            // to compute `!isLocked`. Task D must:
            //   (a) plumb the freeze flag from SchedulePreferences.pins[]
            //       onto each ScheduleSlot at sidebar-render time
            //       (probably in groupCoursesByTerm), then
            //   (b) flip this `locked: true` to `!slot.isLocked` so
            //       the toggle actually toggles.
            // Without (a) + (b), the popover label is aspirational —
            // the toggle currently only LOCKS, never UNLOCKS.
            // The plan-action route is idempotent, so always-locking
            // is harmless until the toggle is wired correctly.
            const result = await planLock({ courseId, term, locked: true });
            announceResult("lock", result);
            onProposeSlotChange?.(slot, "lock");
        } finally {
            markSlotPending(key, false);
            setOpenPopover(null);
            setOpenSubmenu(null);
        }
    };

    /** Phase 17 Task C — Drop click handler. */
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

    /** Phase 17 Task C — Swap click handler. Picks the candidate from
     *  the submenu (engine-suggested or free-text). */
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

    /** Phase 17 Task C — Move click handler (popover submenu picker). */
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

    /** Phase 17 Task C — per-term-card Add course handler. */
    const handleAddCourse = async (term: string): Promise<void> => {
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
        // Use dataTransfer so the browser shows the move cursor +
        // ghost image; opaque payload (the source ref is also held
        // in the closure-bound ref above so we don't depend on
        // dataTransfer for routing).
        try {
            e.dataTransfer.setData("application/x-nyupath-slot", JSON.stringify({ courseId, term }));
            e.dataTransfer.effectAllowed = "move";
        } catch { /* jsdom may not support dataTransfer */ }
    };

    /** Phase 17 Task C — term-card `onDragOver` (allow drop). */
    const handleTermDragOver = (e: React.DragEvent<HTMLElement>, term: string): void => {
        if (!dragSourceRef.current) return;
        // Cross-term only — dropping back on the source term is a no-op.
        if (dragSourceRef.current.term === term) return;
        e.preventDefault();
        try { e.dataTransfer.dropEffect = "move"; } catch { /* */ }
        if (dropTargetTerm !== term) setDropTargetTerm(term);
    };

    const handleTermDragLeave = (term: string): void => {
        if (dropTargetTerm === term) setDropTargetTerm(null);
    };

    /** Phase 17 Task C — term-card `onDrop` (drag-to-move). */
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

    /** Phase 17 Task C — slot-pill `onDrop` (drag-to-exchange). */
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
        // Same-term swap when dropping a slot pill on another slot pill
        // in the SAME term — collapse to the single-mutation form so the
        // engine path is identical to the popover-driven Swap.
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
        // Cross-term exchange — atomic 2-mutation batch via {exchanges}.
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

    return (
        <aside ref={sidebarRef} className={styles.scheduleSidebar} aria-label="Forward schedule">
            <div className={styles.scheduleSidebarHeader}>
                <h2 className={styles.scheduleSidebarTitle}>Your Schedule</h2>
                <button onClick={onClose} className={styles.scheduleSidebarClose} aria-label="Close schedule">✕</button>
            </div>
            {/* Phase 16 Task B — Update DPR button at the top. Always
                visible (even when no schedule has been computed yet)
                so a returning student can refresh without first having
                to ask the agent to plan something. */}
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
                    {/* Phase 16 Task D — summary card. Renders whenever
                        we know the student (post-onboarding), independent
                        of whether a forward schedule has been computed
                        yet. Falls back gracefully when individual fields
                        are missing on the DPR. */}
                    {student && renderSummaryCard(student, dpr ?? null, schedule)}

                    {schedule && (
                        <p className={styles.scheduleSidebarMeta}>
                            Targeting graduation in <strong>{formatTermLabel(schedule.graduationTerm)}</strong>
                            {" · "}
                            <strong>{schedule.creditTargetPerSemester} credits</strong> per semester
                        </p>
                    )}

                    {/* Phase 14 Task 10 — load-style pills row.
                        All three pills are equally styled — no "active" selection state
                        because the server is the source of truth for the current style.
                        Clicking any pill injects a proposal message into the chat.
                        Hidden when there's no schedule yet — pills propose CHANGES
                        to a plan and are meaningless without one. */}
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

                    {/* Decision #32 — 4-state banner */}
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
                        // Phase 16 Task C — full-degree render. The
                        // sidebar now spans history (locked) → current
                        // (IP, editable) → future (planner, editable).
                        // The grouped helper de-dups overlapping terms
                        // and orders chronologically. Prior Credits
                        // (TE rows) render as a dedicated card BEFORE
                        // any term card.
                        // Phase 16 Task D — also runs when `schedule`
                        // is null but `student` is non-null, so a
                        // returning student sees their history + IP
                        // even before a forward plan exists.
                        const grouped = groupCoursesByTerm({
                            student: student ?? null,
                            forwardSchedule: schedule,
                            dpr: dpr ?? null,
                        });
                        // Phase 15 Task 8 — IMMEDIATE term = the first
                        // non-locked future term in the planner's own
                        // semesters list. Section materialization still
                        // swaps the render for ONLY that one term; the
                        // history + current cards never participate.
                        const immediateTerm = schedule?.semesters.find(s => !s.locked)?.term;
                        // Index forwardSchedule semesters by term so we
                        // can recover plannedCredits / notes / locked
                        // for future-card rendering. Historical + IP
                        // buckets don't have these (they're synthesized
                        // from the StudentProfile).
                        const forwardByTerm = new Map((schedule?.semesters ?? []).map(s => [s.term, s]));
                        return (
                            <>
                                {grouped.priorCredits.length > 0 && (
                                    renderPriorCreditsCard(grouped.priorCredits)
                                )}
                                {grouped.terms.map((bucket, semIdx) => {
                                    const fwd = forwardByTerm.get(bucket.term);
                                    const isImmediate = bucket.term === immediateTerm;
                                    const matApplies = isImmediate && materialization
                                        && (
                                            materialization.targetTerm === bucket.term
                                            || materialization.semester?.term === bucket.term
                                        );
                                    const showSectionsView = matApplies
                                        && materialization!.state === "full"
                                        && materialization!.semester !== undefined;
                                    const showBanner = matApplies
                                        && (materialization!.state === "partial" || materialization!.state === "unavailable");
                                    const headerCredits = fwd
                                        ? fwd.plannedCredits
                                        : bucket.slots.reduce((sum, s) => sum + (slotCredits(s)), 0);
                                    // Phase 17 Task C — drag-to-move drop-target
                                    // eligibility: term card must NOT be locked
                                    // (history/completed buckets stay read-only).
                                    const isDropEligible = !bucket.locked;
                                    const isActiveDropTarget = isDropEligible && dropTargetTerm === bucket.term;
                                    // Phase 17 Task C — Add-course affordance:
                                    // only on non-locked future term cards (the
                                    // bucket is non-locked AND has a forward
                                    // semester entry — we don't add courses to
                                    // an IP term).
                                    const showAddCourse = isDropEligible && !!fwd;
                                    const addDraft = addCourseDraft.get(bucket.term);
                                    const isAddOpen = addDraft !== undefined;
                                    return (
                                        <section
                                            key={bucket.term}
                                            className={[
                                                styles.semesterCard,
                                                bucket.locked ? styles.locked : "",
                                                isActiveDropTarget ? styles.termCardDropTarget : "",
                                            ].filter(Boolean).join(" ")}
                                            onDragOver={isDropEligible ? (e) => handleTermDragOver(e, bucket.term) : undefined}
                                            onDragLeave={isDropEligible ? () => handleTermDragLeave(bucket.term) : undefined}
                                            onDrop={isDropEligible ? (e) => void handleTermDrop(e, bucket.term) : undefined}
                                        >
                                            <header className={styles.semesterCardHeader}>
                                                <h3>{formatTermLabel(bucket.term)}</h3>
                                                <span className={styles.semesterCredits}>{headerCredits} cr</span>
                                            </header>
                                            {fwd && fwd.notes.length > 0 && (
                                                <ul className={styles.semesterNotes}>
                                                    {fwd.notes.map((n, i) => <li key={i}>{n}</li>)}
                                                </ul>
                                            )}
                                            {showBanner && (
                                                <div className={styles.materializationBanner}>
                                                    {materialization!.message}
                                                </div>
                                            )}
                                            {showSectionsView ? (
                                                renderSectionsView(
                                                    materialization!,
                                                    selectedComboIdx,
                                                    setSelectedComboIdx,
                                                    onConfirmCombination,
                                                )
                                            ) : (
                                                <ul className={styles.slotList}>
                                                    {bucket.slots.map((slot, slotIdx) => {
                                                        const key = `${semIdx}-${slotIdx}`;
                                                        const isOpen = openPopover === key;
                                                        const isLocked = slot.kind === "completed";
                                                        // Phase 16 Task D — workload-tier
                                                        // tint classes. Only specific_planned
                                                        // + placeholder slots carry the tier;
                                                        // history (completed) and IP slots
                                                        // intentionally render uncolored.
                                                        const tierClass = slotTierClassName(slot);
                                                        // Phase 17 Task C — pending-spinner state
                                                        // + draggable affordance. Slots are
                                                        // draggable iff the bucket is non-locked
                                                        // AND the slot carries a courseId
                                                        // (placeholder slots do not).
                                                        const sKey = slotKey(slot, bucket.term);
                                                        const isPending = pendingSlots.has(sKey);
                                                        const slotCourseId = (
                                                            slot.kind === "specific_planned"
                                                            || slot.kind === "in_progress"
                                                            || slot.kind === "completed"
                                                        ) ? slot.courseId : null;
                                                        const isDraggable = !isLocked && slotCourseId !== null;
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
                                                                ].filter(Boolean).join(" ")}
                                                                onClick={() => handleSlotClick(key, slot)}
                                                                title={isLocked ? "Completed — locked" : "Click to open verbs · drag to move"}
                                                                draggable={isDraggable}
                                                                onDragStart={isDraggable ? (e) => handleDragStart(e, slot, bucket.term) : undefined}
                                                                onDragOver={isDraggable ? (e) => {
                                                                    // Allow dropping ONTO this
                                                                    // slot for cross-term
                                                                    // exchange. Stop the term-
                                                                    // card handler from also
                                                                    // claiming the drop.
                                                                    if (!dragSourceRef.current) return;
                                                                    e.preventDefault();
                                                                    e.stopPropagation();
                                                                } : undefined}
                                                                onDrop={isDraggable && slotCourseId
                                                                    ? (e) => void handleSlotDrop(e, { courseId: slotCourseId, term: bucket.term })
                                                                    : undefined}
                                                            >
                                                                {renderSlot(slot)}
                                                                {isPending ? (
                                                                    <span className={styles.slotSpinner} aria-label="Validating plan change" role="status" />
                                                                ) : (
                                                                    <span className={styles.slotGradeCell}>{slotGradeText(slot)}</span>
                                                                )}
                                                                <span
                                                                    className={styles.slotLockIcon}
                                                                    aria-label={isLocked ? "locked" : ""}
                                                                    title={isLocked ? "Completed — cannot edit" : ""}
                                                                    aria-hidden={!isLocked}
                                                                >
                                                                    {isLocked ? "🔒" : ""}
                                                                </span>
                                                                {isOpen && !isLocked && renderSlotPopover({
                                                                    slot,
                                                                    term: bucket.term,
                                                                    popoverKey: key,
                                                                    openSubmenu,
                                                                    setOpenSubmenu,
                                                                    schedule,
                                                                    onSwap: handleSwap,
                                                                    onMove: handleMove,
                                                                    onDrop: handleDrop,
                                                                    onLock: handleLockToggle,
                                                                })}
                                                            </li>
                                                        );
                                                    })}
                                                </ul>
                                            )}
                                            {/* Phase 17 Task C — per-term-card
                                                "+ Add course" affordance. Only
                                                renders on non-locked future
                                                terms (i.e. the bucket has a
                                                matching forward semester AND
                                                isn't a history card). */}
                                            {showAddCourse && (
                                                <div className={styles.addCourseAffordance}>
                                                    {!isAddOpen ? (
                                                        <button
                                                            type="button"
                                                            className={styles.addCourseButton}
                                                            onClick={() => {
                                                                setAddCourseDraft(prev => {
                                                                    const next = new Map(prev);
                                                                    next.set(bucket.term, "");
                                                                    return next;
                                                                });
                                                            }}
                                                        >
                                                            + Add course
                                                        </button>
                                                    ) : (
                                                        <div className={styles.addCourseInputWrap}>
                                                            <input
                                                                type="text"
                                                                className={styles.addCourseInput}
                                                                placeholder="e.g. CSCI-UA 480"
                                                                value={addDraft ?? ""}
                                                                autoFocus
                                                                onChange={(e) => {
                                                                    const v = e.target.value;
                                                                    setAddCourseDraft(prev => {
                                                                        const next = new Map(prev);
                                                                        next.set(bucket.term, v);
                                                                        return next;
                                                                    });
                                                                }}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === "Enter") void handleAddCourse(bucket.term);
                                                                    if (e.key === "Escape") {
                                                                        setAddCourseDraft(prev => {
                                                                            const next = new Map(prev);
                                                                            next.delete(bucket.term);
                                                                            return next;
                                                                        });
                                                                    }
                                                                }}
                                                            />
                                                            {/* V1 autocomplete is a static
                                                                stub: when the draft has 2+
                                                                chars, surface a small list of
                                                                candidate course IDs derived
                                                                from existing schedule slots
                                                                whose courseId starts with the
                                                                draft string (case-insensitive).
                                                                Task D will replace this with a
                                                                real /api/v2/search-courses
                                                                call. */}
                                                            {(addDraft ?? "").trim().length >= 2 && (
                                                                <ul className={styles.addCourseSuggestions}>
                                                                    {gatherAddCourseSuggestions(schedule, addDraft ?? "").map((cid) => (
                                                                        <li
                                                                            key={cid}
                                                                            className={styles.addCourseSuggestion}
                                                                            onClick={() => {
                                                                                setAddCourseDraft(prev => {
                                                                                    const next = new Map(prev);
                                                                                    next.set(bucket.term, cid);
                                                                                    return next;
                                                                                });
                                                                            }}
                                                                        >
                                                                            {cid}
                                                                        </li>
                                                                    ))}
                                                                </ul>
                                                            )}
                                                            <div className={styles.addCourseInputRow}>
                                                                <button
                                                                    type="button"
                                                                    className={styles.addCourseSubmitBtn}
                                                                    disabled={(addDraft ?? "").trim().length === 0}
                                                                    onClick={() => void handleAddCourse(bucket.term)}
                                                                >
                                                                    Add
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    className={styles.addCourseCancelBtn}
                                                                    onClick={() => {
                                                                        setAddCourseDraft(prev => {
                                                                            const next = new Map(prev);
                                                                            next.delete(bucket.term);
                                                                            return next;
                                                                        });
                                                                    }}
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </section>
                                    );
                                })}
                                {/* Phase 16 Task D — render-when-no-plan
                                    fix. When the student has onboarded
                                    but no forward plan exists yet, the
                                    "Ask me what to take next semester"
                                    nudge appears AFTER the historical /
                                    IP cards rather than replacing them. */}
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
            {/* Phase 16 Task B — Clear-data button at the bottom.
                Test-only — env-gated. Sits below the schedule body so
                it never competes with the primary affordances. The
                page hosts the confirm dialog. */}
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

// ============================================================
// Phase 17 Task C — slot-popover renderer + autocomplete helper
// ============================================================

interface RenderSlotPopoverArgs {
    slot: ScheduleSlot;
    term: string;
    popoverKey: string;
    openSubmenu: { key: string; verb: "swap" | "move" } | null;
    setOpenSubmenu: (next: { key: string; verb: "swap" | "move" } | null) => void;
    schedule: ForwardSchedule | null;
    onSwap: (slot: ScheduleSlot, term: string, candidateCourseId: string) => Promise<void>;
    onMove: (slot: ScheduleSlot, fromTerm: string, toTerm: string) => Promise<void>;
    onDrop: (slot: ScheduleSlot, term: string) => Promise<void>;
    onLock: (slot: ScheduleSlot, term: string) => Promise<void>;
}

/**
 * Render the per-slot popover (4-verb model). Inline `<input>` for
 * the Swap submenu's free-search lives here so the typed value never
 * leaks out to a parent ref. Move's submenu is a list of buttons —
 * one per eligible target term.
 */
function renderSlotPopover(args: RenderSlotPopoverArgs) {
    const { slot, term, popoverKey, openSubmenu, setOpenSubmenu, schedule } = args;
    const submenu = openSubmenu && openSubmenu.key === popoverKey ? openSubmenu.verb : null;

    return (
        <div className={styles.slotPopover} onClick={(e) => e.stopPropagation()}>
            {SLOT_VERBS.map((v) => (
                <button
                    key={v.verb}
                    type="button"
                    onClick={() => {
                        // Toggle submenu — clicking the same verb
                        // again collapses; clicking a different
                        // submenu verb swaps. The verb-without-
                        // submenu paths fire the route directly.
                        if (v.verb === "swap" || v.verb === "move") {
                            if (submenu === v.verb) setOpenSubmenu(null);
                            else setOpenSubmenu({ key: popoverKey, verb: v.verb });
                            return;
                        }
                        if (v.verb === "drop") void args.onDrop(slot, term);
                        else if (v.verb === "lock") void args.onLock(slot, term);
                    }}
                >
                    {v.label}
                </button>
            ))}
            {submenu === "swap" && renderSwapSubmenu(args)}
            {submenu === "move" && renderMoveSubmenu(args)}
        </div>
    );
}

/**
 * Phase 17 Task C — Swap submenu. Top section: client-side derived
 * alternatives (other slots in the same term that share a
 * satisfiesRules entry). Bottom section: free-text input that
 * submits literally. Task D will replace the free-text shim with a
 * real catalog autocomplete.
 */
function renderSwapSubmenu(args: RenderSlotPopoverArgs) {
    const { slot, term, schedule, onSwap } = args;
    const alternatives = gatherSwapAlternatives(slot, term, schedule);
    return (
        <div className={`${styles.slotPopoverSubmenu} ${styles.swapSubmenu}`}>
            {alternatives.length > 0 && (
                <>
                    <div className={styles.slotPopoverSubmenuHeading}>Alternatives</div>
                    {alternatives.map((alt) => (
                        <button
                            key={alt}
                            type="button"
                            onClick={() => void onSwap(slot, term, alt)}
                        >
                            {alt}
                        </button>
                    ))}
                </>
            )}
            <div className={styles.slotPopoverSubmenuHeading}>Or search…</div>
            <SwapFreeSearch slot={slot} term={term} onSwap={onSwap} />
        </div>
    );
}

function SwapFreeSearch(props: {
    slot: ScheduleSlot;
    term: string;
    onSwap: (slot: ScheduleSlot, term: string, candidateCourseId: string) => Promise<void>;
}) {
    const [value, setValue] = useState("");
    return (
        <div className={styles.addCourseInputWrap}>
            <input
                type="text"
                className={styles.addCourseInput}
                placeholder="e.g. CSCI-UA 480"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && value.trim().length > 0) {
                        void props.onSwap(props.slot, props.term, value.trim());
                    }
                }}
            />
            <div className={styles.addCourseInputRow}>
                <button
                    type="button"
                    className={styles.addCourseSubmitBtn}
                    disabled={value.trim().length === 0}
                    onClick={() => void props.onSwap(props.slot, props.term, value.trim())}
                >
                    Swap
                </button>
            </div>
        </div>
    );
}

/**
 * Phase 17 Task C — Move submenu. Lists eligible target terms
 * (every non-locked future term in the schedule, except the source
 * term).
 */
function renderMoveSubmenu(args: RenderSlotPopoverArgs) {
    const { slot, term, schedule, onMove } = args;
    const targets = gatherMoveTargets(term, schedule);
    if (targets.length === 0) {
        return (
            <div className={`${styles.slotPopoverSubmenu} ${styles.moveSubmenu}`}>
                <div className={styles.slotPopoverSubmenuHeading}>No eligible terms</div>
            </div>
        );
    }
    return (
        <div className={`${styles.slotPopoverSubmenu} ${styles.moveSubmenu}`}>
            <div className={styles.slotPopoverSubmenuHeading}>Move to…</div>
            {targets.map((t) => (
                <button
                    key={t}
                    type="button"
                    onClick={() => void onMove(slot, term, t)}
                >
                    {formatTermLabel(t)}
                </button>
            ))}
        </div>
    );
}

/**
 * Phase 17 Task C — derive Swap candidate course IDs from the
 * forward schedule. We collect course IDs that appear in OTHER
 * slots across ANY term and share at least one entry in
 * `satisfiesRules` with the source slot. Falls back to "other slots
 * in the same term" when the slot lacks rules (history / IP slots).
 */
function gatherSwapAlternatives(
    slot: ScheduleSlot,
    term: string,
    schedule: ForwardSchedule | null,
): string[] {
    if (!schedule) return [];
    const rules = (slot.kind === "specific_planned" || slot.kind === "placeholder")
        ? new Set(slot.satisfiesRules)
        : null;
    const ownId = (slot.kind === "specific_planned" || slot.kind === "completed" || slot.kind === "in_progress")
        ? slot.courseId
        : null;
    const out = new Set<string>();
    for (const sem of schedule.semesters) {
        for (const s of sem.slots) {
            // Skip self.
            if (s === slot) continue;
            const cid =
                s.kind === "specific_planned" || s.kind === "completed" || s.kind === "in_progress"
                    ? s.courseId
                    : null;
            if (!cid) continue;
            if (cid === ownId) continue;
            // When the source slot has rules, require an overlap.
            if (rules && rules.size > 0) {
                const sRules = (s.kind === "specific_planned" || s.kind === "placeholder")
                    ? s.satisfiesRules
                    : [];
                if (!sRules.some((r) => rules.has(r))) continue;
            } else {
                // Fall back to same-term "other slots".
                if (sem.term !== term) continue;
            }
            out.add(cid);
        }
    }
    return Array.from(out).slice(0, 5);
}

/**
 * Phase 17 Task C — derive Move target terms. Eligible = any
 * non-locked semester other than the source term.
 */
function gatherMoveTargets(sourceTerm: string, schedule: ForwardSchedule | null): string[] {
    if (!schedule) return [];
    const out: string[] = [];
    for (const sem of schedule.semesters) {
        if (sem.locked) continue;
        if (sem.term === sourceTerm) continue;
        out.push(sem.term);
    }
    return out;
}

/**
 * Phase 17 Task C — V1 Add-course autocomplete. Surface concrete
 * course IDs from the forward schedule that match the draft as a
 * prefix (case-insensitive). When no matches exist, returns an
 * empty list — the input still accepts free-text submission via
 * Enter / the Add button. Task D will swap this for
 * `/api/v2/search-courses` once the route ships.
 */
function gatherAddCourseSuggestions(
    schedule: ForwardSchedule | null,
    draft: string,
): string[] {
    const q = draft.trim().toUpperCase();
    if (q.length < 2 || !schedule) return [];
    const out = new Set<string>();
    for (const sem of schedule.semesters) {
        for (const s of sem.slots) {
            const cid =
                s.kind === "specific_planned" || s.kind === "completed" || s.kind === "in_progress"
                    ? s.courseId
                    : null;
            if (!cid) continue;
            if (cid.toUpperCase().startsWith(q)) out.add(cid);
        }
    }
    return Array.from(out).slice(0, 5);
}

// ============================================================
// Phase 15 Task 8 — Sections view (full-state immediate-term render)
// ============================================================

/**
 * Render the "Sections" view for the IMMEDIATE term inside a semester
 * card. Replaces the structural slot list when
 * `materialization.state === "full"` and the materializer's term
 * matches the semester. Combinations are sourced from
 * `materialization.proposals` (one entry per conflict-free combination,
 * already ranked best-first by the orchestrator's Task 6 scorer).
 */
function renderSectionsView(
    materialization: ForwardMaterializationPayload,
    selectedIdx: number,
    setSelectedIdx: (i: number) => void,
    onConfirmCombination: ((proposalId: string) => void) | undefined,
) {
    const proposals = materialization.proposals ?? [];
    if (proposals.length === 0) {
        // Defensive: state === "full" with no proposals shouldn't
        // happen (the staging path always populates), but if FOSE
        // returned zero combinations the user should still see the
        // explanatory message rather than an empty card.
        return (
            <div className={styles.materializationBanner}>
                {materialization.message}
            </div>
        );
    }
    const safeIdx = Math.min(selectedIdx, proposals.length - 1);
    const selected = proposals[safeIdx]!;
    const semester = materialization.semester;
    return (
        <div className={styles.sectionsView}>
            <h4 className={styles.sectionsViewHeader}>Sections</h4>
            <div className={styles.combinationPicker}>
                {proposals.map((p, i) => (
                    <button
                        key={p.proposalId}
                        type="button"
                        className={
                            i === safeIdx
                                ? `${styles.combinationTab} ${styles.combinationTabActive}`
                                : styles.combinationTab
                        }
                        onClick={() => setSelectedIdx(i)}
                        title={`Combination ${i + 1} (${p.weeklyHours.toFixed(1)}h/wk)`}
                    >
                        {i + 1}
                    </button>
                ))}
            </div>
            {selected.sections.map((section) => {
                const courseTitle =
                    semester?.courses.find(c => c.courseId === section.courseId)?.title
                    ?? section.title;
                return (
                    <div key={`${section.courseId}-${section.crn}`} className={styles.sectionCard}>
                        <div>
                            <span className={styles.slotCourseId}>{section.courseId}</span>
                            {courseTitle && courseTitle !== section.courseId && (
                                <span className={styles.slotTitle}> · {courseTitle}</span>
                            )}
                        </div>
                        <div className={styles.sectionMeta}>
                            CRN {section.crn}
                            {section.schd ? ` · ${section.schd}` : ""}
                            {section.section ? ` · §${section.section}` : ""}
                        </div>
                        <div className={styles.sectionPatterns}>
                            {section.isAsynchronous
                                ? "Asynchronous"
                                : formatPatterns(section.meetingPatterns)}
                        </div>
                        <div className={styles.sectionInstructor}>
                            {section.instructor || "Staff"}
                        </div>
                    </div>
                );
            })}
            {onConfirmCombination && (
                <button
                    type="button"
                    className={styles.applyCombinationBtn}
                    onClick={() => onConfirmCombination(selected.proposalId)}
                >
                    Apply combination
                </button>
            )}
            {semester?.combinationsTruncated && (
                <p className={styles.truncatedNote}>
                    {`and more conflict-free combinations not listed (showing top ${proposals.length})`}
                </p>
            )}
        </div>
    );
}


function renderSlot(slot: ScheduleSlot) {
    switch (slot.kind) {
        case "completed":
            // Phase 16 Task C — grade moved into the dedicated grade
            // cell appended by the row layout; the meta cell now holds
            // ONLY credits to keep alignment with the other slot kinds.
            // May 2026 post-mortem: only render title when it actually
            // differs from courseId — the legacy CourseTaken path stores
            // `title = courseId` as a placeholder and would otherwise
            // render "CSCI-UA 4 CSCI-UA 4".
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

// ============================================================
// Phase 16 Task C — Prior Credits card + grade column helpers
// ============================================================

/**
 * Render the dedicated Prior Credits card. Sits ABOVE all term cards
 * in the body, listing every TE row from the DPR (AP/IB/transfer
 * credits) with credits but no grade column — TE rows in PeopleSoft
 * carry "TE" as the grade and there's no letter grade to surface.
 */
function renderPriorCreditsCard(entries: PriorCreditEntry[]) {
    const total = entries.reduce((sum, e) => sum + e.credits, 0);
    return (
        <section className={styles.priorCreditsCard}>
            <header className={styles.semesterCardHeader}>
                <h3>Prior Credits</h3>
                <span className={styles.semesterCredits}>{total} cr</span>
            </header>
            <ul className={styles.slotList}>
                {entries.map((e, i) => (
                    <li
                        key={`${e.courseId}-${i}`}
                        className={styles.priorCreditsRow}
                        title={e.source ?? undefined}
                    >
                        <span className={styles.slotIcon}>★</span>
                        <span className={styles.slotCourseId}>{e.courseId}</span>
                        {e.source && e.source !== e.courseId && (
                            <span className={styles.slotTitle}>{e.source}</span>
                        )}
                        <span className={styles.slotMeta}>{e.credits}cr</span>
                    </li>
                ))}
            </ul>
        </section>
    );
}

/** Per-slot grade-column text. completed → letter grade; IP → "IP";
 *  specific_planned / placeholder → em-dash. */
function slotGradeText(slot: ScheduleSlot): string {
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
 * Phase 16 Task D — workload-tier left-border tint. Returns the
 * CSS-module class for the slot's `workloadTier`, or `undefined`
 * for slot kinds that don't carry a tier (history `completed` rows
 * synthesized from `coursesTaken` and IP `in_progress` rows).
 *
 * The tier value is one of five strings (see `WorkloadTier` in
 * `packages/shared/src/types.ts`). CSS-module class names are
 * keyed identically (`.slotTier_major-required`, etc.).
 */
function slotTierClassName(slot: ScheduleSlot): string | undefined {
    if (slot.kind !== "specific_planned" && slot.kind !== "placeholder") return undefined;
    const cls = styles[`slotTier_${slot.workloadTier}`];
    return cls || undefined;
}

// ============================================================
// Phase 16 Task D — Summary card
// ============================================================

/**
 * Render the top-of-sidebar identity card. Shows the student's name
 * (from the parsed DPR header, falling back to the anonymized
 * `student.id`), declared programs, home school, visa status, GPA,
 * credits earned vs required (with a progress bar), and graduation
 * term. Every field gracefully degrades when the underlying source
 * is unavailable: missing GPA / credits drop their row entirely
 * rather than showing "null" or "0".
 *
 * Cardinal Rule §2.1 — no fabrication: if a field can't be sourced
 * from the StudentProfile or DPR, we omit it.
 */
function renderSummaryCard(
    student: StudentProfile,
    dpr: DegreeProgressReport | null,
    schedule: ForwardSchedule | null,
) {
    // Name: prefer the DPR header (PeopleSoft surfaces "Mongardi,Edoardo"
    // or similar), fall back to the anonymized student.id when no DPR
    // is loaded yet.
    const name = (dpr?.header.studentName || student.id || "").trim() || "Student";

    // Programs: render as "BA cs_major_ba" / "Minor math_minor_ba" to
    // keep the original programType + programId visible (the UI hasn't
    // promoted programId → human label anywhere else yet).
    const programs = student.declaredPrograms
        .map((d) => `${d.programType} ${d.programId}`)
        .join(", ");

    const school = (student.homeSchool || "").toUpperCase();

    // Visa: PeopleSoft uses lowercase "f1" / "domestic" / "other" but
    // the UI renders "F-1" / "Domestic" — match the spec.
    const visa = formatVisa(student.visaStatus);

    const gpa = dpr?.cumulative.cumulativeGpa ?? null;
    const creditsUsed = dpr?.cumulative.creditsUsed ?? null;
    const creditsRequired = dpr?.cumulative.creditsRequired ?? null;
    const progressPct = creditsUsed !== null && creditsRequired !== null && creditsRequired > 0
        ? Math.min(100, Math.max(0, (creditsUsed / creditsRequired) * 100))
        : null;

    const graduationLabel = schedule?.graduationTerm
        ? formatTermLabel(schedule.graduationTerm)
        : "TBD";

    // Build the meta line (programs · school · visa) defensively so
    // missing fields don't leave dangling separators.
    const metaParts: string[] = [];
    if (programs) metaParts.push(programs);
    if (school) metaParts.push(school);
    if (visa) metaParts.push(visa);

    return (
        <section className={styles.summaryCard} aria-label="Student summary">
            <h3 className={styles.summaryCardHeader}>{name}</h3>
            {metaParts.length > 0 && (
                <div className={styles.summaryCardRow}>{metaParts.join(" · ")}</div>
            )}
            {(gpa !== null || creditsUsed !== null) && (
                <div className={styles.summaryCardRow}>
                    {gpa !== null && (
                        <>GPA <strong>{gpa.toFixed(3)}</strong></>
                    )}
                    {gpa !== null && creditsUsed !== null && creditsRequired !== null && " · "}
                    {creditsUsed !== null && creditsRequired !== null && (
                        <><strong>{creditsUsed} / {creditsRequired}</strong> credits</>
                    )}
                </div>
            )}
            <div className={styles.summaryCardRow}>
                Graduating <strong>{graduationLabel}</strong>
            </div>
            {progressPct !== null && (
                <div
                    className={styles.summaryCardProgressBar}
                    role="progressbar"
                    aria-valuenow={Math.round(progressPct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Degree progress: ${creditsUsed} of ${creditsRequired} credits`}
                >
                    <div
                        className={styles.summaryCardProgressFill}
                        style={{ width: `${progressPct}%` }}
                    />
                </div>
            )}
        </section>
    );
}

function formatVisa(visaStatus?: "f1" | "domestic" | "other"): string {
    switch (visaStatus) {
        case "f1": return "F-1";
        case "domestic": return "Domestic";
        case "other": return "Other";
        default: return "";
    }
}

/** Slot-level credit accessor used to compute a per-bucket header
 *  total when the bucket has no matching ForwardSemester (history /
 *  IP cards). All four slot kinds carry `credits` directly. */
function slotCredits(slot: ScheduleSlot): number {
    return slot.credits;
}

function formatTermLabel(term: string): string {
    const m = term.match(/^(\d{4})-(spring|summer|fall|january)$/i);
    if (!m) return term;
    const season = m[2]!.charAt(0).toUpperCase() + m[2]!.slice(1).toLowerCase();
    return `${season} ${m[1]}`;
}

function assumptionLabel(a: Assumption): string {
    switch (a.type) {
        case "IP_COURSE_COMPLETION":
            return `Assumes ${a.courseId} completes successfully`;
        case "LLM_RANKED_ALTERNATIVE":
            return a.reasoning.slice(0, 120);
        case "HEURISTIC_MAPPING":
            return a.reasoning.slice(0, 120);
    }
}
