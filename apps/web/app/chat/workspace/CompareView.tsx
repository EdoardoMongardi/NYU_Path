// ============================================================
// CompareView — H3 (plan 36 scenarios workspace UI)
// ============================================================
// Side-by-side comparison of ANY two scenarios. Presentational
// component: no store reads — all data is passed as props so the
// component is trivially unit-testable without a live store.
//
// Props:
//   left     — resolved Scenario for the left column (incl. the
//              committed anchor when leftId = "committed").
//   right    — resolved Scenario for the right column.
//   options  — ALL selectable scenarios (committed view +
//              getScenarios()) for the two pickers.
//   onPick   — called when the student changes a picker:
//              onPick("left" | "right", newId).
//
// Behaviour:
//   • Two <select> pickers (one per side): each lists `options`
//     by label/id. Changing one fires onPick.
//   • Same-scenario prevention: the left picker disables the
//     option whose value === right.id; the right picker disables
//     the option whose value === left.id. The store's openCompare
//     throws on equal ids, so we never let the picker submit one.
//   • The diff is computed with diffSchedules(left.schedule,
//     right.schedule) and fed to the two ScheduleView instances.
//   • A small legend below the pickers maps each diff colour so
//     the highlights are self-explanatory.
// ============================================================
"use client";

import type { ReactElement } from "react";
import type { Scenario } from "../../../lib/scenarios/scenarioModel";
import { diffSchedules } from "../../../lib/scenarios/scheduleDiff";
import ScheduleView from "./ScheduleView";
import { kindBadgeClass, kindBadgeLabel, type ScenarioKind } from "./ScheduleWorkspace";
import workspaceStyles from "./workspace.module.css";
import styles from "../chat.module.css";

// ============================================================
// Public interface
// ============================================================

export interface CompareViewProps {
    /** Resolved scenario for the left column (incl. the committed view). */
    left: Scenario;
    /** Resolved scenario for the right column. */
    right: Scenario;
    /** ALL selectable scenarios (committed view + getScenarios()), for the pickers. */
    options: Scenario[];
    /** Called when the student changes a picker. */
    onPick: (side: "left" | "right", id: string) => void;
}

// ============================================================
// Component
// ============================================================

export default function CompareView({
    left,
    right,
    options,
    onPick,
}: CompareViewProps): ReactElement {
    // Compute the two annotated columns from the diff engine.
    const d = diffSchedules(left.schedule, right.schedule);

    return (
        <div className="compare-view" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* ---- Pickers + legend row ---- */}
            <div
                className="compare-controls"
                style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 8,
                    padding: "8px 12px",
                    alignItems: "end",
                }}
            >
                {/* Left picker */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label
                        htmlFor="compare-left-picker"
                        style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}
                    >
                        Left
                    </label>
                    <select
                        id="compare-left-picker"
                        value={left.id}
                        onChange={(e) => onPick("left", e.target.value)}
                        style={{ fontSize: 13, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-medium)", background: "var(--surface-raised)", color: "var(--text-primary)", fontFamily: "var(--font-body)" }}
                    >
                        {options.map((opt) => (
                            <option
                                key={opt.id}
                                value={opt.id}
                                disabled={opt.id === right.id}
                            >
                                {opt.label}
                            </option>
                        ))}
                    </select>
                </div>

                {/* Right picker */}
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label
                        htmlFor="compare-right-picker"
                        style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em" }}
                    >
                        Right
                    </label>
                    <select
                        id="compare-right-picker"
                        value={right.id}
                        onChange={(e) => onPick("right", e.target.value)}
                        style={{ fontSize: 13, padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-medium)", background: "var(--surface-raised)", color: "var(--text-primary)", fontFamily: "var(--font-body)" }}
                    >
                        {options.map((opt) => (
                            <option
                                key={opt.id}
                                value={opt.id}
                                disabled={opt.id === left.id}
                            >
                                {opt.label}
                            </option>
                        ))}
                    </select>
                </div>
            </div>

            {/* ---- Diff legend ---- */}
            <DiffLegend />

            {/* ---- Side-by-side columns ---- */}
            <div
                className="compare-columns"
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
            >
                {/* Left column */}
                <div className="compare-col compare-col-left" style={{ minWidth: 0 }}>
                    <ScenarioColumnHeader scenario={left} />
                    <ScheduleView
                        schedule={left.schedule}
                        diff={d.base}
                        readOnly
                        singleColumn
                    />
                </div>

                {/* Right column */}
                <div className="compare-col compare-col-right" style={{ minWidth: 0 }}>
                    <ScenarioColumnHeader scenario={right} />
                    <ScheduleView
                        schedule={right.schedule}
                        diff={d.other}
                        readOnly
                        singleColumn
                    />
                </div>
            </div>
        </div>
    );
}

// ============================================================
// ScenarioColumnHeader — label + kind badge
// ============================================================

function ScenarioColumnHeader({ scenario }: { scenario: Scenario }): ReactElement {
    const kind = scenario.kind as ScenarioKind;
    return (
        <div
            className="compare-col-header"
            style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 0",
                marginBottom: 4,
                borderBottom: "1px solid var(--border-light)",
            }}
        >
            <span
                style={{
                    fontWeight: 600,
                    fontSize: 14,
                    color: "var(--text-primary)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                }}
            >
                {scenario.label}
            </span>
            <span className={kindBadgeClass(kind)} style={{ flexShrink: 0, fontSize: 11 }}>
                {kindBadgeLabel(kind)}
            </span>
        </div>
    );
}

// ============================================================
// DiffLegend — interprets the diff colour codes
// ============================================================

interface LegendEntry {
    cssClass: string;           // workspace.module.css class name
    label: string;
    description: string;
}

const LEGEND_ENTRIES: LegendEntry[] = [
    { cssClass: workspaceStyles.diffAdded,   label: "added",   description: "New in right" },
    { cssClass: workspaceStyles.diffRemoved, label: "removed", description: "Removed in right" },
    { cssClass: workspaceStyles.diffMoved,   label: "moved",   description: "Shifted between terms" },
    { cssClass: workspaceStyles.diffRetake,  label: "retake",  description: "Pushed to a later term" },
];

function DiffLegend(): ReactElement {
    return (
        <div
            className="diff-legend"
            style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "6px 16px",
                padding: "6px 12px",
                fontSize: 11,
                color: "var(--text-secondary)",
                borderBottom: "1px solid var(--border-light)",
            }}
            aria-label="Diff legend"
        >
            {LEGEND_ENTRIES.map(({ cssClass, label, description }) => (
                <span
                    key={label}
                    style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                    <span
                        className={cssClass}
                        style={{
                            display: "inline-block",
                            width: 12,
                            height: 12,
                            borderRadius: 2,
                            flexShrink: 0,
                        }}
                        aria-hidden="true"
                    />
                    <span>{description}</span>
                </span>
            ))}
        </div>
    );
}
