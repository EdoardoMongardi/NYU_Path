// ============================================================
// PriorCreditsCard — Prior Credits card (Phase 16 Task C)
// ============================================================
// Phase 17 Task D pre-flight extraction. Sits ABOVE all term cards
// in the body, listing every TE row from the DPR (AP/IB/transfer
// credits) with credits but no grade column — TE rows in PeopleSoft
// carry "TE" as the grade and there's no letter grade to surface.
// ============================================================
"use client";

import type { PriorCreditEntry } from "../../../lib/groupCoursesByTerm";
import styles from "../chat.module.css";

interface PriorCreditsCardProps {
    entries: PriorCreditEntry[];
}

export default function PriorCreditsCard({ entries }: PriorCreditsCardProps) {
    if (entries.length === 0) return null;
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
