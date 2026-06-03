// ============================================================
// SummaryCard — top-of-sidebar identity + degree-progress card
// ============================================================
// Phase 17 Task D pre-flight extraction. Renders the student's name,
// declared programs, home school, visa status, GPA, credits earned vs
// required (with a progress bar), and graduation term. Each field
// gracefully degrades when the underlying source is unavailable —
// missing values drop their row entirely instead of showing "null"
// or "0".
// ============================================================
"use client";

import type { ForwardSchedule, StudentProfile } from "@nyupath/shared";
import type { DegreeProgressReport } from "@nyupath/engine";
import styles from "../chat.module.css";
import { formatTermLabel, formatVisa } from "./sidebarFormatters";

interface SummaryCardProps {
    student: StudentProfile;
    dpr: DegreeProgressReport | null;
    schedule: ForwardSchedule | null;
}

export default function SummaryCard({ student, dpr, schedule }: SummaryCardProps) {
    // Name: prefer the DPR header (PeopleSoft surfaces "Mongardi,Edoardo"
    // or similar), fall back to the anonymized student.id when no DPR
    // is loaded yet.
    const name = (dpr?.header.studentName || student.id || "").trim() || "Student";

    // Programs: render as "BA cs_major_ba" / "Minor math_minor_ba" to
    // keep the original programType + programId visible.
    const programs = student.declaredPrograms
        .map((d) => `${d.programType} ${d.programId}`)
        .join(", ");

    const school = (student.homeSchool || "").toUpperCase();
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
