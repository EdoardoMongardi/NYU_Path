"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import type { ForwardSchedule, ScheduleSlot, SchedulePreferences, StudentProfile } from "@nyupath/shared";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { ForwardMaterializationPayload } from "../../lib/chatV2Client";
import { groupCoursesByTerm } from "../../lib/groupCoursesByTerm";
import { computePlanBadges } from "../../lib/planBadges";
import { computePreviewView } from "../../lib/planPreview";
import { computeReviewCard } from "../../lib/reviewCard";
import type { InvalidProposalCard } from "../../lib/reviewCard";
import type { PendingPreview } from "./planState";
import {
    planAdd,
    planSwap,
    planDrop,
    planLock,
    planMove,
    planWhatIf,
    type PlanActionResult,
    type PlanActionRouteResponse,
    type WhatIfAssumptionRouteResponse,
} from "../../lib/planActionClient";
import styles from "./chat.module.css";
import TermCard from "./sidebar/TermCard";
import SummaryCard from "./profile/SummaryCard";
import PriorCreditsCard from "./sidebar/PriorCreditsCard";
import { assumptionLabel, formatTermLabel } from "./shared/sidebarFormatters";
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
 * Phase 4 Task E2.1 — plan-level badge row.
 *
 * Thin consumer of the pure `computePlanBadges` helper: it renders the
 * four plan-level badges (validity · confidence · graduation term ·
 * trade-off count) derived from the live `ForwardSchedule`. ALL the
 * derivation logic — including the binding §11 confidence hedge — lives
 * in `apps/web/lib/planBadges.ts` (node-unit-tested in
 * planBadges.test.ts); this component holds no decision logic of its own.
 *
 * Styling is deliberately minimal here (semantic class names only);
 * E2.3 applies the NYU-violet light/dark theme to these classes next.
 *
 * `consequences` is the latest plan-action diff's `consequences[]`,
 * threaded down for the trade-off count. At rest (no pending diff) it is
 * absent → count 0. (Live consequences wiring is E3's job.)
 */
function PlanBadges({
    schedule,
    consequences,
}: {
    schedule: ForwardSchedule;
    consequences?: string[];
}) {
    const badges = computePlanBadges(schedule, consequences);
    return (
        <div className={styles.planBadgeRow} role="status" aria-label="Plan summary badges">
            <span
                className={
                    badges.validity.valid
                        ? styles.planBadgeValid
                        : styles.planBadgeInvalid
                }
                title={badges.validity.valid ? "Plan satisfies all hard requirements" : "Draft plan with unmet requirements"}
            >
                {badges.validity.label}
            </span>
            <span
                className={
                    badges.confidence.hedged
                        ? styles.planBadgeHedged
                        : styles.planBadgeGrounded
                }
                title={badges.confidence.label}
            >
                {badges.confidence.label}
            </span>
            <span className={styles.planBadgeNeutral} title="Targeted graduation term">
                🎓 {badges.graduationTerm}
            </span>
            <span className={styles.planBadgeNeutral} title="Trade-offs in the latest change">
                {badges.tradeOffCount} trade-off{badges.tradeOffCount === 1 ? "" : "s"}
            </span>
        </div>
    );
}

interface ScheduleSidebarProps {
    schedule: ForwardSchedule | null;
    /**
     * Phase 4 Task E3.1 — a STAGED (not-yet-committed) proposal to
     * overlay on the canvas. When set, the sidebar renders
     * `pendingPreview.proposedSchedule` marked PENDING (a violet
     * "preview" banner + the credit deltas) instead of the committed
     * `schedule`; the committed plan is NOT mutated. Null at rest →
     * the committed `schedule` renders as today. Cleared by the page on
     * Confirm / Cancel / Keep-as-is.
     */
    pendingPreview?: PendingPreview | null;
    /**
     * Phase 4 Task E3.3 — the RED card for an engine-REJECTED
     * (`feasible:false`) proposal. When set, the sidebar renders a
     * clearly-error-styled card naming the binding constraint(s) (from
     * the response's OWN fields — conflicts ∪ feasibility
     * .constraintViolations) with a Dismiss button. It renders NO
     * proposed-plan overlay: the committed term cards stay exactly as
     * they are. MUTUALLY EXCLUSIVE with `pendingPreview`. Null at rest.
     */
    invalidProposal?: InvalidProposalCard | null;
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
     * Phase 4 Task E4.1 — the slot ⋯ "Explain why" affordance. Fired
     * with the clicked slot + its term; the page builds a SCOPED
     * natural-language question (course code / placeholder category +
     * human term label) and injects it into the normal agent loop. The
     * sidebar holds NO question-building logic of its own. Optional so
     * pre-onboarding renders (and the read-only preview overlay) can
     * omit it.
     */
    onExplainSlot?: (slot: ScheduleSlot, term: string) => void;
    /** Phase 4 Task E4.1 — the term-header "Explain this term"
     *  affordance (workload-scoped). Fired with the term. */
    onExplainTerm?: (term: string) => void;
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
    /** G3.2 — fired after a what-if assumption route returns. The page
     *  handles the `WhatIfAssumptionRouteResponse` to stage the pending
     *  preview (with the `whatIfAssumption` marker) for the review card.
     *  Optional so pre-onboarding renders can omit it. */
    onWhatIfResult?: (
        result: PlanActionResult<WhatIfAssumptionRouteResponse>,
    ) => void;
    /**
     * Phase 4 Task E3.2 — review-card actions. The card renders the
     * verdict (✓/⚠/✗) + trade-off lines alongside the E3.1 preview
     * overlay, with three buttons:
     *   - onReviewConfirm: applies the staged mutation via the shared
     *     /api/plan/confirm path (commits + clears the preview on
     *     success; leaves it staged on failure for retry).
     *   - onReviewCancel: drops the staged proposal + clears the
     *     preview WITHOUT a confirm round-trip.
     *   - onReviewAskWhy: routes a scoped "why" question into the
     *     grounded chat agent (basic now; E4 builds the full ⋯ Explain).
     * Each is threaded from page.tsx so the sidebar holds NO confirm
     * logic of its own (the decision logic lives in the pure
     * `apps/web/lib/reviewCard.ts` helpers).
     */
    onReviewConfirm?: (pendingMutationId: string) => void | Promise<void>;
    onReviewCancel?: () => void;
    onReviewAskWhy?: (pendingMutationId: string, verb?: string) => void;
    /** Phase 4 Task E3.3 — Dismiss the RED invalid-proposal card.
     *  Nothing was staged or committed, so this just clears the slot. */
    onDismissInvalid?: () => void;
    onConfirmCombination?: (proposalId: string) => void;
    onRefreshDpr?: (file: File) => Promise<void>;
    onClearAll?: () => Promise<void>;
    /** Phase 4 Task E6.4 — STANDING, always-on self-serve account
     *  deletion (DELETE /api/session/delete). Unlike `onClearAll`
     *  (the env-gated test affordance) this is always shown to a
     *  signed-in student. */
    onDeleteAccount?: () => Promise<void>;
    /** Phase 4 Task E6.4 — in-flight guard from the page; disables the
     *  delete control while the request is pending. */
    deletingAccount?: boolean;
}

export default function ScheduleSidebar({
    schedule,
    pendingPreview,
    invalidProposal,
    student,
    dpr,
    materialization,
    schedulePreferences,
    open,
    onClose,
    onProposeLoadStyle,
    onProposeSlotChange,
    onExplainSlot,
    onExplainTerm,
    onPlanActionResult,
    onWhatIfResult,
    onReviewConfirm,
    onReviewCancel,
    onReviewAskWhy,
    onDismissInvalid,
    onConfirmCombination,
    onRefreshDpr,
    onClearAll,
    onDeleteAccount,
    deletingAccount,
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

    /**
     * Phase 17 Task D — set of pin keys ("term::courseId") derived
     * from `schedule.schedulePreferences.pins[]` at render time. Drives
     * the SlotRow's `isFrozen` flag → which in turn flips the popover's
     * Lock/Unlock label and lets the Lock-toggle handler send
     * `locked: !isFrozen` instead of always `true`.
     *
     * Must sit above the `if (!open) return null` early return so the
     * hook count is stable across open/closed renders (Rules of Hooks).
     */
    const frozenKeys = useMemo<Set<string>>(() => {
        const out = new Set<string>();
        const pins = schedulePreferences?.pins ?? [];
        for (const p of pins) {
            out.add(`${p.term}::${p.courseId}`);
        }
        return out;
    }, [schedulePreferences]);

    if (!open) return null;

    // Phase 4 Task E3.1 — when a proposal is staged, derive the
    // render-ready preview view (proposed schedule + credit deltas vs
    // the committed plan). The committed `schedule` is read ONLY to
    // compute the delta; it is never mutated. Null when nothing is
    // staged → the committed plan renders as today.
    const previewView = pendingPreview
        ? computePreviewView(schedule, pendingPreview)
        : null;

    const hasBody = !!student || !!schedule || !!previewView;

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

    /** Phase 4 Task E4.1 — slot ⋯ "Explain why" → close the popover,
     *  then ask the page to inject a scoped chat question. The page
     *  owns the question-building + agent-loop injection; the sidebar
     *  only closes its own popover state. */
    const handleExplain = (slot: ScheduleSlot, term: string): void => {
        setOpenPopover(null);
        setOpenSubmenu(null);
        onExplainSlot?.(slot, term);
    };

    /** G3.2 — what-if assumption handler. POSTs to /api/plan/whatif and
     *  surfaces the typed result to the page via `onWhatIfResult` (mirrors
     *  the `announceResult` → `onPlanActionResult` pattern for regular verbs).
     *  Closes the popover on completion (success OR failure). */
    const handleWhatIf = async (
        slot: ScheduleSlot,
        term: string,
        outcome: "withdraw" | "pass" | "fail",
    ): Promise<void> => {
        const courseId =
            slot.kind === "in_progress" ? slot.courseId : null;
        if (!courseId) return;
        const key = slotKey(slot, term);
        markSlotPending(key, true);
        try {
            const result = await planWhatIf({ courseId, outcome });
            if (!result.ok) {
                console.error(`[plan/whatif] HTTP ${result.status}: ${result.error}`);
            } else {
                console.info(`[plan/whatif] ok`, result.data);
            }
            onWhatIfResult?.(result);
        } finally {
            markSlotPending(key, false);
            setOpenPopover(null);
            setOpenSubmenu(null);
        }
    };

    const slotPopoverHandlers: SlotPopoverHandlers = {
        onSwap: handleSwap,
        onMove: handleMove,
        onDrop: handleDrop,
        onLock: handleLockToggle,
        onExplain: handleExplain,
        // G3.2 — only wire onWhatIf when the page has opted in via
        // `onWhatIfResult`; when absent the popover suppresses the section.
        ...(onWhatIfResult ? { onWhatIf: handleWhatIf } : {}),
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
                    {/* Phase 4 Task E3.1 — PENDING proposal overlay. When a
                        proposal is staged, the proposed plan is shown read-only
                        above the committed cards, clearly marked PENDING with
                        the per-term + total credit deltas. The committed plan
                        below is NOT mutated — it stays until the user Confirms
                        (which commits + clears) or Cancels (which clears). */}
                    {previewView && (
                        <div
                            className={styles.schedulePreviewOverlay}
                            role="status"
                            aria-label="Proposed plan preview (pending confirmation)"
                        >
                            <div className={styles.schedulePreviewBanner}>
                                <span className={styles.schedulePreviewBadge}>◷ Preview</span>
                                <span className={styles.schedulePreviewBannerText}>
                                    Proposed change — not applied yet. Confirm in chat to keep it.
                                </span>
                            </div>

                            {(() => {
                                const { total, byTerm } = previewView.creditDelta;
                                const changedTerms = Object.entries(byTerm)
                                    .filter(([, d]) => d !== 0)
                                    .sort((a, b) => a[0].localeCompare(b[0]));
                                const fmtDelta = (d: number): string => (d > 0 ? `+${d}` : `${d}`);
                                return (
                                    <div className={styles.schedulePreviewDelta}>
                                        <span className={styles.schedulePreviewDeltaTotal}>
                                            Credit change: {fmtDelta(total)}
                                        </span>
                                        {changedTerms.length > 0 && (
                                            <ul className={styles.schedulePreviewDeltaList}>
                                                {changedTerms.map(([term, d]) => (
                                                    <li key={term}>
                                                        {formatTermLabel(term)}: {fmtDelta(d)} credits
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                );
                            })()}

                            {previewView.consequences.length > 0 && (
                                <ul className={styles.schedulePreviewConsequences}>
                                    {previewView.consequences.slice(0, 5).map((c, i) => (
                                        <li key={i}>{c}</li>
                                    ))}
                                </ul>
                            )}

                            {/* Proposed term cards rendered read-only (no slot
                                handlers): this is a preview, not an editable plan. */}
                            {(() => {
                                const grouped = groupCoursesByTerm({
                                    student: student ?? null,
                                    forwardSchedule: previewView.proposedSchedule,
                                    dpr: dpr ?? null,
                                });
                                const forwardByTerm = new Map(
                                    previewView.proposedSchedule.semesters.map(s => [s.term, s]),
                                );
                                return (
                                    <>
                                        {grouped.terms.map((bucket, semIdx) => (
                                            <TermCard
                                                key={`preview-${bucket.term}`}
                                                bucket={bucket}
                                                semIdx={semIdx}
                                                forwardSemester={forwardByTerm.get(bucket.term)}
                                                schedule={previewView.proposedSchedule}
                                                materialization={null}
                                                isImmediate={false}
                                                frozenKeys={frozenKeys}
                                                pendingSlots={new Set()}
                                                openPopoverKey={null}
                                                openSubmenu={null}
                                                addCourseDraft={undefined}
                                                selectedComboIdx={selectedComboIdx}
                                                setSelectedComboIdx={setSelectedComboIdx}
                                                onSlotClick={() => { /* read-only preview */ }}
                                                onSubmenuToggle={() => { /* read-only preview */ }}
                                                handlers={slotPopoverHandlers}
                                                onAddCourseOpen={() => { /* read-only preview */ }}
                                                onAddCourseClose={() => { /* read-only preview */ }}
                                                onAddCourseChange={() => { /* read-only preview */ }}
                                                onAddCourseSubmit={() => { /* read-only preview */ }}
                                                slotKeyOf={slotKey}
                                            />
                                        ))}
                                    </>
                                );
                            })()}

                            {/* Phase 4 Task E3.2 — review card: verdict
                                (✓ valid / ⚠ valid-with-trade-offs) + the
                                trade-off lines + Confirm / Cancel / Ask-why.
                                The verdict + lines are computed by the pure
                                `computeReviewCard` helper from the engine's
                                own fields (NEVER fabricated). A staged
                                preview is always feasible (E3.1 gates
                                feasible:false out of the preview path), so
                                only the ✓/⚠ cards render here; the ✗ red
                                card is E3.3's scope. */}
                            {(() => {
                                // A staged preview is, by the E3.1 gate,
                                // always a FEASIBLE proposal. Build the
                                // minimal PlanActionResponse the pure helper
                                // reads (feasible + consequences + planDiff +
                                // pendingMutationId) from the preview's own
                                // engine-sourced fields — no fabrication.
                                // G3.2 — thread the whatIfAssumption marker so
                                // the card can show the assumption label/hedges.
                                const card = computeReviewCard({
                                    feasible: true,
                                    diff: { added: [], removed: [] },
                                    consequences: previewView.consequences,
                                    explanation: "",
                                    pendingMutationId: previewView.pendingMutationId,
                                    futureTerms: [],
                                    ...(previewView.planDiff ? { planDiff: previewView.planDiff } : {}),
                                    ...(pendingPreview?.whatIfAssumption
                                        ? { whatIfAssumption: pendingPreview.whatIfAssumption }
                                        : {}),
                                });
                                // G3.2 — for a what-if assumption the heading names
                                // the assumption ("Review what-if assumption") rather
                                // than the verb. For ordinary proposals the existing
                                // verb label is used.
                                const verbLabel = card.whatIfAssumption
                                    ? "Review what-if assumption"
                                    : pendingPreview?.verb
                                        ? `Review: ${pendingPreview.verb} change`
                                        : "Review proposed change";
                                return (
                                    <div
                                        className={styles.reviewCard}
                                        role="group"
                                        aria-label="Review proposed plan change"
                                    >
                                        <p className={styles.reviewCardHeading}>{verbLabel}</p>

                                        {/* G3.2 — what-if assumption label + assumption
                                            disclaimer. Displayed BEFORE the verdict so
                                            the student sees "this is an assumption, not
                                            a fact" before seeing ✓/⚠. Source: the engine's
                                            own WhatIfAssumptionMarker — never invented. */}
                                        {card.whatIfAssumption && (
                                            <div className={styles.reviewWhatIfAssumption}>
                                                <p className={styles.reviewWhatIfLabel}>
                                                    <span aria-hidden="true">◈</span>{" "}
                                                    {card.whatIfAssumption.label}
                                                </p>
                                                {card.whatIfAssumption.windowCaveat && (
                                                    <p className={styles.reviewWhatIfCaveat}>
                                                        {card.whatIfAssumption.windowCaveat}
                                                    </p>
                                                )}
                                                {card.whatIfAssumption.hedges.length > 0 && (
                                                    <ul className={styles.reviewWhatIfHedges}>
                                                        {card.whatIfAssumption.hedges.map((h, i) => (
                                                            <li key={i}>{h}</li>
                                                        ))}
                                                    </ul>
                                                )}
                                                <p className={styles.reviewWhatIfDisclaimer}>
                                                    Confirming records a plan under this assumption — not a fact.
                                                    Your DPR is never changed. When your next official DPR
                                                    arrives it supersedes this assumption.
                                                </p>
                                            </div>
                                        )}

                                        <p
                                            className={
                                                card.verdict === "valid"
                                                    ? styles.reviewVerdictValid
                                                    : styles.reviewVerdictTradeOffs
                                            }
                                        >
                                            <span aria-hidden="true">{card.glyph}</span> {card.label}
                                        </p>
                                        {card.tradeOffLines.length > 0 && (
                                            <ul className={styles.reviewTradeOffList}>
                                                {card.tradeOffLines.slice(0, 6).map((line, i) => (
                                                    <li key={i}>{line}</li>
                                                ))}
                                            </ul>
                                        )}
                                        <div className={styles.reviewCardActions}>
                                            <button
                                                type="button"
                                                className={styles.reviewBtnConfirm}
                                                disabled={!card.canConfirm}
                                                onClick={() =>
                                                    void onReviewConfirm?.(card.pendingMutationId)
                                                }
                                            >
                                                Confirm
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.reviewBtnCancel}
                                                onClick={() => onReviewCancel?.()}
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.reviewBtnAskWhy}
                                                onClick={() =>
                                                    onReviewAskWhy?.(
                                                        card.pendingMutationId,
                                                        pendingPreview?.verb,
                                                    )
                                                }
                                            >
                                                Ask why
                                            </button>
                                        </div>
                                    </div>
                                );
                            })()}

                            <p className={styles.schedulePreviewCommittedLabel}>
                                Your current plan (unchanged):
                            </p>
                        </div>
                    )}

                    {/* Phase 4 Task E3.3 — RED invalid-proposal card. An
                        engine-REJECTED (`feasible:false`) proposal NEVER
                        reaches the preview overlay above: it renders here as
                        a clearly error-styled card naming the binding
                        constraint(s) the response's OWN fields surfaced
                        (conflicts ∪ feasibility.constraintViolations,
                        deduped by `computeInvalidCard`). It renders NO
                        proposed-plan overlay — the committed term cards below
                        stay exactly as they are. Mutually exclusive with the
                        preview (the page clears one when staging the other).
                        Both sources empty → a generic, no-invented-specifics
                        fallback line. */}
                    {invalidProposal && (
                        <div
                            className={styles.invalidProposalCard}
                            role="alert"
                            aria-label="Proposed change is invalid"
                        >
                            <p className={styles.invalidProposalHeading}>
                                <span aria-hidden="true">✗</span>{" "}
                                {invalidProposal.verb
                                    ? `Can't ${invalidProposal.verb} — invalid change`
                                    : "Invalid change"}
                            </p>
                            {invalidProposal.bindingConstraints.length > 0 ? (
                                <ul className={styles.invalidProposalList}>
                                    {invalidProposal.bindingConstraints.slice(0, 5).map((c, i) => (
                                        <li key={i}>{c.detail}</li>
                                    ))}
                                </ul>
                            ) : (
                                <p className={styles.invalidProposalFallback}>
                                    The engine could not validate this change — verify with your adviser.
                                </p>
                            )}
                            <p className={styles.invalidProposalUntouched}>
                                Your plan was not changed.
                            </p>
                            <div className={styles.invalidProposalActions}>
                                <button
                                    type="button"
                                    className={styles.invalidProposalDismiss}
                                    onClick={() => onDismissInvalid?.()}
                                >
                                    Dismiss
                                </button>
                            </div>
                        </div>
                    )}

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

                    {/* Phase 4 Task E2.1 — plan-level badge row above the term cards. */}
                    {schedule && <PlanBadges schedule={schedule} />}

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
                                        selectedComboIdx={selectedComboIdx}
                                        setSelectedComboIdx={setSelectedComboIdx}
                                        onSlotClick={handleSlotClick}
                                        onSubmenuToggle={(key, verb) => {
                                            if (verb === null) setOpenSubmenu(null);
                                            else setOpenSubmenu({ key, verb });
                                        }}
                                        handlers={slotPopoverHandlers}
                                        {...(onConfirmCombination ? { onConfirmCombination } : {})}
                                        {...(onExplainTerm ? { onExplainTerm } : {})}
                                        onAddCourseOpen={handleAddCourseOpen}
                                        onAddCourseClose={handleAddCourseClose}
                                        onAddCourseChange={handleAddCourseChange}
                                        onAddCourseSubmit={handleAddCourseSubmit}
                                        slotKeyOf={slotKey}
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

            {/* Phase 4 Task E6.4 — STANDING self-serve account deletion.
                Always visible to a signed-in student (NOT gated on the
                test-clear flag below); wired to the always-on DELETE
                /api/session/delete route so the /privacy promise that
                "self-serve deletion is always available to signed-in
                users" is literally true in-app. */}
            {onDeleteAccount && (
                <div className={styles.sidebarToolbarBottom}>
                    <button
                        type="button"
                        className={styles.sidebarClearBtn}
                        onClick={() => void onDeleteAccount()}
                        disabled={deletingAccount}
                        title="Permanently delete your account and all your data"
                    >
                        {deletingAccount ? "Deleting…" : "Delete my account & data"}
                    </button>
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
