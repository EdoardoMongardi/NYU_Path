"use client";

import { useState, useEffect, useRef } from "react";
import type { Assumption, ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import type { ForwardMaterializationPayload } from "../../lib/chatV2Client";
import { formatPatterns } from "../../lib/formatMeetingPatterns";
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

// Actions available on each slot popover
type SlotAction = "lock" | "replace" | "drop" | "pin";
const SLOT_ACTIONS: Array<{ action: SlotAction; label: string }> = [
    { action: "lock", label: "Lock as-is" },
    { action: "replace", label: "Replace with a different course" },
    { action: "drop", label: "Drop this slot" },
    { action: "pin", label: "Pin to a different term" },
];

interface ScheduleSidebarProps {
    schedule: ForwardSchedule | null;
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
    onProposeSlotChange?: (slot: ScheduleSlot, action: SlotAction) => void;
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
    materialization,
    open,
    onClose,
    onProposeLoadStyle,
    onProposeSlotChange,
    onConfirmCombination,
    onRefreshDpr,
    onClearAll,
}: ScheduleSidebarProps) {
    // Track which slot's popover is open. Key = "semIdx-slotIdx"
    const [openPopover, setOpenPopover] = useState<string | null>(null);
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

    const handlePillClick = (style: "balanced" | "frontload" | "backload") => {
        onProposeLoadStyle?.(style);
    };

    const handleSlotClick = (key: string) => {
        setOpenPopover(prev => (prev === key ? null : key));
    };

    const handleSlotAction = (slot: ScheduleSlot, action: SlotAction) => {
        setOpenPopover(null);
        onProposeSlotChange?.(slot, action);
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
            {!schedule ? (
                <p className={styles.scheduleSidebarEmpty}>
                    No plan yet. Ask me what to take next semester to compute one.
                </p>
            ) : (
                <div className={styles.scheduleSidebarBody}>
                    <p className={styles.scheduleSidebarMeta}>
                        Targeting graduation in <strong>{formatTermLabel(schedule.graduationTerm)}</strong>
                        {" · "}
                        <strong>{schedule.creditTargetPerSemester} credits</strong> per semester
                    </p>

                    {/* Phase 14 Task 10 — load-style pills row.
                        All three pills are equally styled — no "active" selection state
                        because the server is the source of truth for the current style.
                        Clicking any pill injects a proposal message into the chat. */}
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

                    {/* Decision #32 — 4-state banner */}
                    {schedule.state === "valid-with-trade-offs" && schedule.assumptions.length > 0 && (
                        <div className={styles.scheduleTradeOffsBanner}>
                            ℹ Plan has trade-offs or assumptions:
                            <ul>
                                {schedule.assumptions.slice(0, 5).map((a, i) => (
                                    <li key={i}>{assumptionLabel(a)}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {schedule.state === "infeasible-draft" && (
                        <div className={styles.scheduleInfeasibilityBanner}>
                            ⚠ Plan has constraint violations:
                            <ul>
                                {schedule.feasibility.constraintViolations.slice(0, 5).map((v, i) => (
                                    <li key={i}>{v.detail}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {schedule.state === "student-preferred-invalid-draft" && (
                        <div className={styles.scheduleStudentPrefBanner}>
                            ⚠ Student-confirmed plan despite warnings
                        </div>
                    )}

                    {(() => {
                        // Phase 15 Task 8 — IMMEDIATE term = the first
                        // non-locked semester. Section materialization
                        // only swaps the render for THIS term; locked
                        // and later non-locked semesters keep their
                        // structural-slot list. When materialization
                        // is absent or targets a different term, every
                        // semester falls through to the structural path.
                        const immediateTerm = schedule.semesters.find(s => !s.locked)?.term;
                        return schedule.semesters.map((sem, semIdx) => {
                            const isImmediate = sem.term === immediateTerm;
                            const matApplies = isImmediate && materialization
                                && (
                                    materialization.targetTerm === sem.term
                                    || materialization.semester?.term === sem.term
                                );
                            const showSectionsView = matApplies
                                && materialization!.state === "full"
                                && materialization!.semester !== undefined;
                            const showBanner = matApplies
                                && (materialization!.state === "partial" || materialization!.state === "unavailable");
                            return (
                                <section key={sem.term} className={`${styles.semesterCard} ${sem.locked ? styles.locked : ""}`}>
                                    <header className={styles.semesterCardHeader}>
                                        <h3>{formatTermLabel(sem.term)}</h3>
                                        <span className={styles.semesterCredits}>{sem.plannedCredits} cr</span>
                                    </header>
                                    {sem.notes.length > 0 && (
                                        <ul className={styles.semesterNotes}>
                                            {sem.notes.map((n, i) => <li key={i}>{n}</li>)}
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
                                            {sem.slots.map((slot, slotIdx) => {
                                                const key = `${semIdx}-${slotIdx}`;
                                                const isOpen = openPopover === key;
                                                return (
                                                    <li
                                                        key={slotIdx}
                                                        className={[
                                                            styles[`slot_${slot.kind}`],
                                                            slot.kind === "placeholder" && slot.optional ? styles.slotOptional : "",
                                                            styles.slotClickable,
                                                        ].filter(Boolean).join(" ")}
                                                        onClick={() => handleSlotClick(key)}
                                                        title="Click to propose a change"
                                                    >
                                                        {renderSlot(slot)}
                                                        {isOpen && (
                                                            <div
                                                                className={styles.slotPopover}
                                                                // Stop click from bubbling to the li
                                                                onClick={e => e.stopPropagation()}
                                                            >
                                                                {SLOT_ACTIONS.map(a => (
                                                                    <button
                                                                        key={a.action}
                                                                        type="button"
                                                                        onClick={() => handleSlotAction(slot, a.action)}
                                                                    >
                                                                        {a.label}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </section>
                            );
                        });
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
            return (
                <>
                    <span className={styles.slotIcon}>✓</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
                    <span className={styles.slotMeta}>{slot.credits}cr · {slot.grade}</span>
                </>
            );
        case "in_progress":
            return (
                <>
                    <span className={styles.slotIcon}>⏳</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
                    <span className={styles.slotMeta}>{slot.credits}cr</span>
                </>
            );
        case "specific_planned":
            return (
                <>
                    <span className={styles.slotIcon}>📅</span>
                    <span className={styles.slotCourseId}>{slot.courseId}</span>
                    <span className={styles.slotTitle}>{slot.title}</span>
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
