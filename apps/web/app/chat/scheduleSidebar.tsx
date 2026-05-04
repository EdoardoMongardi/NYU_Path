"use client";

import { useState, useEffect, useRef } from "react";
import type { Assumption, ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import styles from "./chat.module.css";

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
    open: boolean;
    onClose: () => void;
    onProposeLoadStyle?: (style: "balanced" | "frontload" | "backload") => void;
    onProposeSlotChange?: (slot: ScheduleSlot, action: SlotAction) => void;
}

export default function ScheduleSidebar({
    schedule,
    open,
    onClose,
    onProposeLoadStyle,
    onProposeSlotChange,
}: ScheduleSidebarProps) {
    // Track which slot's popover is open. Key = "semIdx-slotIdx"
    const [openPopover, setOpenPopover] = useState<string | null>(null);
    // Ref for click-outside-to-close
    const sidebarRef = useRef<HTMLElement>(null);

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

    return (
        <aside ref={sidebarRef} className={styles.scheduleSidebar} aria-label="Forward schedule">
            <div className={styles.scheduleSidebarHeader}>
                <h2 className={styles.scheduleSidebarTitle}>Your Schedule</h2>
                <button onClick={onClose} className={styles.scheduleSidebarClose} aria-label="Close schedule">✕</button>
            </div>
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

                    {schedule.semesters.map((sem, semIdx) => (
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
                        </section>
                    ))}
                </div>
            )}
        </aside>
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
