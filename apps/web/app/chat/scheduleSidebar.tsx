"use client";

import type { Assumption, ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import styles from "./chat.module.css";

interface ScheduleSidebarProps {
    schedule: ForwardSchedule | null;
    open: boolean;
    onClose: () => void;
}

export default function ScheduleSidebar({ schedule, open, onClose }: ScheduleSidebarProps) {
    if (!open) return null;

    return (
        <aside className={styles.scheduleSidebar} aria-label="Forward schedule">
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

                    {schedule.semesters.map(sem => (
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
                                {sem.slots.map((slot, i) => (
                                    <li
                                        key={i}
                                        className={[
                                            styles[`slot_${slot.kind}`],
                                            slot.kind === "placeholder" && slot.optional ? styles.slotOptional : "",
                                        ].filter(Boolean).join(" ")}
                                    >
                                        {renderSlot(slot)}
                                    </li>
                                ))}
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
