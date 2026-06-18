// ============================================================
// ScheduleWorkspace — H2.3 (plan 36 scenarios workspace UI)
// ============================================================
// The CENTER ZONE of the 3-zone chat page: a tabbed schedule
// workspace that shows the committed plan (📌 My Plan) plus any
// proposed/whatif scenarios, and lets the student confirm, cancel,
// ask why, discard, or compare them.
//
// Design references:
//   Docs/mockups/scenarios-ui-mockup.html  — visual structure
//   Docs/plans/36-*.md §3.1 + §7 H2.3     — spec
//
// Props:
//   planStore         — the shared PlanStore (wired by H2.1/page.tsx).
//   onConfirmProposed — callback when the student clicks Confirm on a
//                       proposed scenario (persist round-trip is H4).
//   onAskWhy          — callback when the student clicks "Ask why".
//
// Design constraints:
//   - CompareView (H3) is NOT built here. The Compare toggle shows a
//     labelled placeholder ("Compare view (H3)") until H3 lands. If H3
//     is present, it will be imported here.
//   - "⊕ New what-if" is NOT included (what-ifs are created from chat
//     only — owner decision confirmed in plan 36).
//   - The component reads state via useSyncExternalStore for correct
//     React 19 concurrent-mode semantics. It does NOT hold local copies
//     of scenario lists; all writes go through the store.
// ============================================================
"use client";

import { type ReactElement, useSyncExternalStore } from "react";
import type { PlanStore, Scenario } from "../planState";
import ScheduleView from "./ScheduleView";

// ============================================================
// Pure helpers — badge label, badge class, verdict glyph
// ============================================================
// Exported so they can be unit-tested in isolation (node env).

export type ScenarioKind = "committed" | "proposed" | "whatif";

/** Human-readable badge label (icon + name). */
export function kindBadgeLabel(kind: ScenarioKind): string {
    switch (kind) {
        case "committed": return "✓ Committed";
        case "proposed":  return "⏳ Proposed";
        case "whatif":    return "🔍 What-if";
    }
}

/** CSS class name to use for the kind badge. Must be a plain string for JSX classNames. */
export function kindBadgeClass(kind: ScenarioKind): string {
    switch (kind) {
        case "committed": return "badge badge-committed";
        case "proposed":  return "badge badge-proposed";
        case "whatif":    return "badge badge-whatif";
    }
}

/** Verdict glyph + readable label. */
export function verdictDisplay(verdict: "valid" | "trade-offs" | "invalid"): {
    glyph: string;
    label: string;
    className: string;
} {
    switch (verdict) {
        case "valid":      return { glyph: "✓", label: "Valid", className: "verdict verdict-ok" };
        case "trade-offs": return { glyph: "⚠", label: "Valid with trade-offs", className: "verdict verdict-warn" };
        case "invalid":    return { glyph: "✗", label: "Invalid", className: "verdict verdict-invalid" };
    }
}

// ============================================================
// Props
// ============================================================

export interface ScheduleWorkspaceProps {
    planStore: PlanStore;
    /** Called when student confirms a proposed scenario (persist is H4). */
    onConfirmProposed: (scenario: Scenario) => void;
    /** Called when student clicks "Ask why" on a proposed scenario. */
    onAskWhy: (scenario: Scenario) => void;
}

// ============================================================
// Component
// ============================================================

export default function ScheduleWorkspace({
    planStore,
    onConfirmProposed,
    onAskWhy,
}: ScheduleWorkspaceProps): ReactElement {
    // Subscribe to the store.
    // We read the full PlanState snapshot for backward-compat fields,
    // and separately call the scenario selectors for the new API.
    // Both read from the same underlying state — no double render.
    useSyncExternalStore(
        planStore.subscribe,
        planStore.getSnapshot,
        planStore.getSnapshot,
    );

    // Read scenario state after the subscription is established.
    const scenarioState  = planStore.getScenarioState();
    const scenarios      = planStore.getScenarios();
    const activeScenario = planStore.getActiveScenario();
    const committed      = planStore.getCommitted();

    const compareMode = scenarioState.compare !== null;
    const activeId    = scenarioState.activeId;

    // ---- tab click ----
    function handleTabClick(id: string): void {
        planStore.setActive(id);
    }

    // ---- close tab (discard scenario) ----
    function handleClose(e: React.MouseEvent, id: string): void {
        e.stopPropagation();
        planStore.discardScenario(id);
    }

    // ---- compare toggle ----
    function handleCompare(): void {
        if (compareMode) {
            planStore.closeCompare();
        } else {
            // Compare committed vs the active scenario (or the first scenario
            // if active is already committed). Match the mockup behavior.
            const rightId =
                activeId !== "committed"
                    ? activeId
                    : scenarios.length > 0
                        ? scenarios[0].id
                        : null;
            if (rightId !== null) {
                planStore.openCompare("committed", rightId);
            }
        }
    }

    return (
        <div className="schedule-workspace">
            {/* ---- Tab bar ---- */}
            <div className="ws-head">
                <div className="tabs">
                    {/* Pinned committed tab — always first, no close button */}
                    <button
                        className={[
                            "tab",
                            "tab-committed",
                            activeId === "committed" && !compareMode ? "active" : "",
                        ].filter(Boolean).join(" ")}
                        data-tab="committed"
                        onClick={() => handleTabClick("committed")}
                        aria-pressed={activeId === "committed" && !compareMode}
                    >
                        <span className="tab-pin" aria-hidden="true">📌</span>
                        {" My Plan"}
                        <span className={kindBadgeClass("committed")} style={{ marginLeft: 6 }}>
                            {kindBadgeLabel("committed")}
                        </span>
                        {/* NO close button on committed tab */}
                    </button>

                    {/* One tab per proposed/whatif scenario */}
                    {scenarios.map((sc) => (
                        <button
                            key={sc.id}
                            className={[
                                "tab",
                                `tab-${sc.kind}`,
                                activeId === sc.id && !compareMode ? "active" : "",
                            ].filter(Boolean).join(" ")}
                            data-tab={sc.id}
                            onClick={() => handleTabClick(sc.id)}
                            aria-pressed={activeId === sc.id && !compareMode}
                        >
                            <span className={kindBadgeClass(sc.kind)}>
                                {kindBadgeLabel(sc.kind).split(" ")[0]}
                            </span>
                            {" "}
                            {sc.label}
                            {/* Close button — scenario tabs only */}
                            <span
                                className="tab-close"
                                data-close={sc.id}
                                title={`Close ${sc.label}`}
                                onClick={(e) => handleClose(e, sc.id)}
                                role="button"
                                tabIndex={0}
                                aria-label={`Close ${sc.label}`}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.stopPropagation();
                                        planStore.discardScenario(sc.id);
                                    }
                                }}
                            >
                                {" ✕"}
                            </span>
                        </button>
                    ))}

                    {/* Compare toggle — right side */}
                    <button
                        className={["compare-btn", compareMode ? "compare-btn-on" : ""].filter(Boolean).join(" ")}
                        onClick={handleCompare}
                        aria-pressed={compareMode}
                    >
                        {"⇄ Compare"}
                        {compareMode ? " ✓" : ""}
                    </button>
                </div>
            </div>

            {/* ---- Body ---- */}
            <div className="ws-body">
                {compareMode ? (
                    <CompareBody planStore={planStore} />
                ) : activeScenario ? (
                    <ScenarioBody
                        scenario={activeScenario}
                        onConfirmProposed={onConfirmProposed}
                        onAskWhy={onAskWhy}
                        planStore={planStore}
                    />
                ) : committed === null ? (
                    <div className="ws-empty">
                        <p>No plan loaded yet. Upload your DPR to get started.</p>
                    </div>
                ) : (
                    <div className="ws-empty">
                        <p>Select a tab to view a scenario.</p>
                    </div>
                )}
            </div>
        </div>
    );
}

// ============================================================
// CompareBody — H3 placeholder
// ============================================================
// H3 (CompareView) is a separate task. Until it lands this renders a
// labelled placeholder so the Compare toggle is useable in the UI and
// the H2.3 render test can assert "H3" text is present.

function CompareBody({ planStore }: { planStore: PlanStore }): ReactElement {
    const state = planStore.getScenarioState();
    if (!state.compare) return <></>;
    return (
        <div className="compare-placeholder" role="region" aria-label="Compare view">
            {/* H3 will replace this block with the real CompareView */}
            <p style={{ padding: "24px 16px", color: "#6b6577", fontStyle: "italic" }}>
                {"Compare view (H3) — coming in the next task. Left: "}
                <strong>{state.compare.leftId}</strong>
                {" vs right: "}
                <strong>{state.compare.rightId}</strong>
            </p>
        </div>
    );
}

// ============================================================
// ScenarioBody — active scenario header + ScheduleView + actions
// ============================================================

interface ScenarioBodyProps {
    scenario: Scenario;
    planStore: PlanStore;
    onConfirmProposed: (s: Scenario) => void;
    onAskWhy: (s: Scenario) => void;
}

function ScenarioBody({
    scenario,
    planStore,
    onConfirmProposed,
    onAskWhy,
}: ScenarioBodyProps): ReactElement {
    const { kind, label, verdict, hedges, whatIfAssumption } = scenario;
    const vd = verdictDisplay(verdict);

    // Assumption/hedge block: show for proposed + whatif when non-empty.
    const showHedges = (hedges && hedges.length > 0) || whatIfAssumption;

    return (
        <div className="scenario-body">
            {/* Header: label + kind badge + verdict */}
            <div className="scenario-ctx">
                <h2 className="scenario-label">{label}</h2>
                <span className={kindBadgeClass(kind)}>
                    {kindBadgeLabel(kind)}
                </span>
                <span className={vd.className}>
                    {vd.glyph} {vd.label}
                </span>
            </div>

            {/* Assumption / hedge block */}
            {showHedges && (
                <div className={`hedge-block hedge-${kind}`} role="note">
                    {kind === "proposed" && (
                        <strong>Assumption:{" "}</strong>
                    )}
                    {whatIfAssumption && (
                        <span>{whatIfAssumption.label}</span>
                    )}
                    {whatIfAssumption?.windowCaveat && (
                        <span>{" · "}{whatIfAssumption.windowCaveat}</span>
                    )}
                    {hedges && hedges.map((h, i) => (
                        <span key={i}>{i > 0 || whatIfAssumption ? " · " : ""}{h}</span>
                    ))}
                </div>
            )}

            {/* Action bar — varies by kind */}
            {kind === "proposed" && (
                <div className="actionbar">
                    <button
                        className="btn btn-primary"
                        onClick={() => onConfirmProposed(scenario)}
                    >
                        Confirm — make this My Plan
                    </button>
                    <button
                        className="btn btn-ghost"
                        onClick={() => planStore.discardScenario(scenario.id)}
                    >
                        Cancel
                    </button>
                    <button
                        className="btn btn-subtle"
                        onClick={() => onAskWhy(scenario)}
                    >
                        Ask why
                    </button>
                </div>
            )}

            {kind === "whatif" && (
                <>
                    <div className="actionbar">
                        <button
                            className="btn btn-subtle"
                            onClick={() => { /* no-op: keep the scenario open */ }}
                        >
                            Keep this scenario
                        </button>
                        <button
                            className="btn btn-ghost"
                            onClick={() => planStore.discardScenario(scenario.id)}
                        >
                            Discard
                        </button>
                    </div>
                    <p className="whatif-readonly-note">
                        {"Read-only — a what-if never changes your plan. To adopt it, declare it in Albert & upload a new DPR."}
                    </p>
                </>
            )}

            {/* committed: no action buttons — it IS the plan */}

            {/* Schedule grid */}
            <div className="scenario-schedule">
                <ScheduleView
                    schedule={scenario.schedule}
                    readOnly={kind !== "committed"}
                />
            </div>
        </div>
    );
}
