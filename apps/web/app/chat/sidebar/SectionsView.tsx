// ============================================================
// SectionsView — IMMEDIATE-term Sections render (Phase 15 Task 8)
// ============================================================
// Phase 17 Task D pre-flight extraction. Replaces the structural slot
// list when `materialization.state === "full"` and the materializer's
// term matches the semester. Combinations are sourced from
// `materialization.proposals` (one entry per conflict-free
// combination, already ranked best-first by the orchestrator's
// scorer).
// ============================================================
"use client";

import type { ForwardMaterializationPayload } from "../../../lib/chatV2Client";
import { formatPatterns } from "../../../lib/formatMeetingPatterns";
import styles from "../chat.module.css";

export function renderSectionsView(
    materialization: ForwardMaterializationPayload,
    selectedIdx: number,
    setSelectedIdx: (i: number) => void,
    onConfirmCombination: ((proposalId: string) => void) | undefined,
) {
    const proposals = materialization.proposals ?? [];
    if (proposals.length === 0) {
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
