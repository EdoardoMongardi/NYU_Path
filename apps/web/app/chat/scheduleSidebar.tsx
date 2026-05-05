"use client";

import { useState, useEffect, useRef } from "react";
import type { Assumption, ForwardSchedule, ScheduleSlot, StudentProfile } from "@nyupath/shared";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { ForwardMaterializationPayload } from "../../lib/chatV2Client";
import { formatPatterns } from "../../lib/formatMeetingPatterns";
import { groupCoursesByTerm, type PriorCreditEntry } from "../../lib/groupCoursesByTerm";
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
    student,
    dpr,
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
                                    return (
                                        <section
                                            key={bucket.term}
                                            className={`${styles.semesterCard} ${bucket.locked ? styles.locked : ""}`}
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
                                                        return (
                                                            <li
                                                                key={slotIdx}
                                                                className={[
                                                                    styles[`slot_${slot.kind}`],
                                                                    slot.kind === "placeholder" && slot.optional ? styles.slotOptional : "",
                                                                    isLocked ? styles.slotLocked : styles.slotClickable,
                                                                    tierClass ? styles.slotTier : "",
                                                                    tierClass ?? "",
                                                                ].filter(Boolean).join(" ")}
                                                                onClick={() => handleSlotClick(key, slot)}
                                                                title={isLocked ? "Completed — locked" : "Click to propose a change"}
                                                            >
                                                                {renderSlot(slot)}
                                                                <span className={styles.slotGradeCell}>{slotGradeText(slot)}</span>
                                                                <span
                                                                    className={styles.slotLockIcon}
                                                                    aria-label={isLocked ? "locked" : ""}
                                                                    title={isLocked ? "Completed — cannot edit" : ""}
                                                                    aria-hidden={!isLocked}
                                                                >
                                                                    {isLocked ? "🔒" : ""}
                                                                </span>
                                                                {isOpen && !isLocked && (
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
