// ============================================================
// ScheduleCard — H4.1 (plan 36 scenarios workspace UI)
// ============================================================
// A compact chat-thread card that appears in the assistant's
// message stream whenever the engine produces a new schedule
// (proposed edit, what-if exploration, or probe result).
// Lets the student OPEN that scenario in the workspace or
// COMPARE it against the committed plan.
//
// Design references:
//   Docs/mockups/scenarios-ui-mockup.html  — the chat .card
//   Docs/plans/36-*.md §3.1 + §7 H4.1     — spec
//
// PRESENTATIONAL ONLY — no store reads, no page wiring.
// Page wiring (emitting these cards when a result arrives) is H4.2.
// ============================================================

import type { JSX } from "react";
import styles from "./chat.module.css";
import {
    kindBadgeLabel,
    kindBadgeClass,
    verdictDisplay,
    type ScenarioKind,
} from "./workspace/scenarioBadges";

// ============================================================
// Props
// ============================================================

export interface ScheduleCardProps {
    /** The scenario's unique id — passed back through onOpen / onCompare. */
    scenarioId: string;
    /** Kind of the scenario. */
    kind: ScenarioKind;
    /** Short label shown in the card header (e.g. "Withdraw MATH-UA 325"). */
    label: string;
    /** Optional one-line plain-English summary shown in the card body. */
    summary?: string;
    /** Optional validity verdict — renders a glyph (✓/⚠/✗) when present. */
    verdict?: "valid" | "trade-offs" | "invalid";
    /** Called when the student clicks Open. */
    onOpen: (scenarioId: string) => void;
    /** Called when the student clicks Compare. */
    onCompare: (scenarioId: string) => void;
}

// ============================================================
// Component
// ============================================================

export default function ScheduleCard({
    scenarioId,
    kind,
    label,
    summary,
    verdict,
    onOpen,
    onCompare,
}: ScheduleCardProps): JSX.Element {
    const vd = verdict ? verdictDisplay(verdict) : null;

    return (
        <div className={styles.scheduleCard} data-scenario-id={scenarioId} data-kind={kind}>
            {/* ---- Top row: badge + label + verdict ---- */}
            <div className={styles.scheduleCardTop}>
                {/* Kind badge — uses plain global badge classes (same as ScheduleWorkspace).
                    data-kind is a test anchor so the test can querySelector("[data-kind='proposed']"). */}
                <span
                    className={kindBadgeClass(kind)}
                    data-kind={kind}
                    aria-label={`Scenario kind: ${kindBadgeLabel(kind)}`}
                >
                    {kindBadgeLabel(kind)}
                </span>

                {/* Label */}
                <span className={styles.scheduleCardLabel}>{label}</span>

                {/* Verdict glyph — only when a verdict is provided */}
                {vd !== null && (
                    <span className={vd.className} aria-label={vd.label}>
                        {vd.glyph}
                    </span>
                )}
            </div>

            {/* ---- Summary line — optional ---- */}
            {summary !== undefined && (
                <div
                    className={styles.scheduleCardSummary}
                    data-testid="schedule-card-summary"
                >
                    {summary}
                </div>
            )}

            {/* ---- Actions ---- */}
            <div className={styles.scheduleCardActions}>
                <button
                    className={`${styles.scheduleCardBtn} ${styles.scheduleCardBtnOpen}`}
                    type="button"
                    onClick={() => onOpen(scenarioId)}
                    aria-label={`Open scenario: ${label}`}
                >
                    Open
                </button>
                <button
                    className={`${styles.scheduleCardBtn} ${styles.scheduleCardBtnCompare}`}
                    type="button"
                    onClick={() => onCompare(scenarioId)}
                    aria-label={`Compare scenario: ${label}`}
                >
                    Compare
                </button>
            </div>
        </div>
    );
}
