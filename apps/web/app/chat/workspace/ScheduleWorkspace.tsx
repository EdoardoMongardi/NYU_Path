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
import type { ScheduleSlot } from "@nyupath/shared";
import type { SlotAction, SlotActionMatrix } from "@nyupath/engine";
import type { PlanStore, Scenario } from "../planState";
import type { ScenarioState } from "../../../lib/scenarios/scenarioModel";
import { getScenario } from "../../../lib/scenarios/scenarioModel";
import ScheduleView from "./ScheduleView";
import CompareView from "./CompareView";
import {
    kindBadgeLabel,
    kindBadgeClass,
    verdictDisplay,
} from "./scenarioBadges";

// ============================================================
// Re-export helpers + ScenarioKind from the shared module so
// existing consumers that import from ScheduleWorkspace keep
// working without change (backward-compat re-export).
// ============================================================
export type { ScenarioKind } from "./scenarioBadges";
export { kindBadgeLabel, kindBadgeClass, verdictDisplay };

// ============================================================
// Props
// ============================================================

export interface ScheduleWorkspaceProps {
    planStore: PlanStore;
    /** Called when student confirms a proposed scenario (persist is H4). */
    onConfirmProposed: (scenario: Scenario) => void;
    /** Called when student clicks "Ask why" on a proposed scenario. */
    onAskWhy: (scenario: Scenario) => void;
    /** Plan 37 F3 — slot-action matrix builder for the COMMITTED plan only.
     *  Threaded into the committed ScenarioBody's ScheduleView; proposed/
     *  whatif/compare columns never receive it (they stay read-only). When
     *  absent (no DPR / no committed plan), the committed grid is non-editable. */
    slotMatrix?: (slot: ScheduleSlot, term: string) => SlotActionMatrix;
    /** Plan 37 F3 — dispatch a per-slot action for the COMMITTED plan only.
     *  PROPOSE-ONLY (D-8): routes through the existing /api/plan/{drop,whatif}
     *  propose pipeline; never auto-commits. */
    onSlotAction?: (slot: ScheduleSlot, term: string, action: SlotAction) => void;
    /** Plan 37 F4 — per-term add-eligibility (window-gated) for the COMMITTED
     *  plan only. Threaded into the committed ScenarioBody's ScheduleView. */
    addTermState?: (term: string) => { allowed: boolean; hedge?: string };
    /** Plan 37 F4 — add a course to a term for the COMMITTED plan only.
     *  PROPOSE-ONLY (D-8): routes through /api/plan/add; never auto-commits. */
    onAddCourse?: (term: string, courseId: string) => void;
}

// ============================================================
// Component
// ============================================================

export default function ScheduleWorkspace({
    planStore,
    onConfirmProposed,
    onAskWhy,
    slotMatrix,
    onSlotAction,
    addTermState,
    onAddCourse,
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

    // ---- tab id helpers (for ARIA panel wiring) ----
    // Stable id for each tab element and the single panel.
    const tabId  = (id: string) => `ws-tab-${id}`;
    const panelId = "ws-tabpanel";

    // Ordered list of tab ids — used for roving tabindex + arrow-key nav.
    const tabOrder = ["committed", ...scenarios.map((sc) => sc.id)];

    // ---- arrow-key navigation on the tablist ----
    function handleTablistKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const currentIndex = tabOrder.indexOf(activeId ?? "committed");
        if (currentIndex === -1) return;
        e.preventDefault();
        const delta = e.key === "ArrowRight" ? 1 : -1;
        const nextIndex = (currentIndex + delta + tabOrder.length) % tabOrder.length;
        const nextId = tabOrder[nextIndex];
        planStore.setActive(nextId);
        // Move DOM focus to the newly-active tab element.
        const tabEl = document.getElementById(tabId(nextId));
        tabEl?.focus();
    }

    return (
        <div className="schedule-workspace">
            {/* ---- Tab bar ----
                M3 restructure (H6.1): a tab is a NON-interactive container
                (role="tab") holding a label-select control + an optional close
                control as SIBLINGS — never a <button> nested inside a <button>
                (invalid HTML + a React hydration warning). The container carries
                data-tab + the select handler; the close <button> carries
                data-close and stops propagation. Mirrors the ProfileRail row
                pattern (data-select / data-compare siblings).

                ARIA tabs pattern (FIX 2, H6 polish):
                  - The tablist owns the ArrowLeft/Right handler (roving tabindex).
                  - Active tab: tabIndex=0; all others: tabIndex=-1.
                  - Each tab has id + aria-controls pointing to the single panel.
                  - The Compare <button> is a SIBLING of the tablist (NOT inside
                    role="tablist") — a tablist must contain only role="tab" children. */}
            <div className="ws-head">
                <div className="tabs-toolbar">
                    <div
                        className="tabs"
                        role="tablist"
                        aria-label="Scenario tabs"
                        onKeyDown={handleTablistKeyDown}
                    >
                        {/* Pinned committed tab — always first, no close button */}
                        <div
                            id={tabId("committed")}
                            className={[
                                "tab",
                                "tab-committed",
                                activeId === "committed" && !compareMode ? "active" : "",
                            ].filter(Boolean).join(" ")}
                            data-tab="committed"
                            role="tab"
                            tabIndex={activeId === "committed" && !compareMode ? 0 : -1}
                            aria-selected={activeId === "committed" && !compareMode}
                            aria-controls={panelId}
                            onClick={() => handleTabClick("committed")}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    handleTabClick("committed");
                                }
                            }}
                        >
                            <span className="tab-pin" aria-hidden="true">📌</span>
                            <span className="tab-label">My Plan</span>
                            <span className={kindBadgeClass("committed")}>
                                {kindBadgeLabel("committed")}
                            </span>
                            {/* NO close button on committed tab */}
                        </div>

                        {/* One tab per proposed/whatif scenario */}
                        {scenarios.map((sc) => (
                            <div
                                key={sc.id}
                                id={tabId(sc.id)}
                                className={[
                                    "tab",
                                    `tab-${sc.kind}`,
                                    activeId === sc.id && !compareMode ? "active" : "",
                                ].filter(Boolean).join(" ")}
                                data-tab={sc.id}
                                role="tab"
                                tabIndex={activeId === sc.id && !compareMode ? 0 : -1}
                                aria-selected={activeId === sc.id && !compareMode}
                                aria-controls={panelId}
                                onClick={() => handleTabClick(sc.id)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                        e.preventDefault();
                                        handleTabClick(sc.id);
                                    }
                                }}
                            >
                                <span className={kindBadgeClass(sc.kind)}>
                                    {kindBadgeLabel(sc.kind).split(" ")[0]}
                                </span>
                                <span className="tab-label">{sc.label}</span>
                                {/* Close — a real sibling <button> (no longer nested
                                    in an outer <button>). */}
                                <button
                                    type="button"
                                    className="tab-close"
                                    data-close={sc.id}
                                    title={`Close ${sc.label}`}
                                    aria-label={`Close ${sc.label}`}
                                    onClick={(e) => handleClose(e, sc.id)}
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                    </div>

                    {/* Compare toggle — SIBLING of tablist, NOT inside it.
                        (A tablist must contain only role="tab" children.) */}
                    <button
                        type="button"
                        className={["compare-btn", compareMode ? "compare-btn-on" : ""].filter(Boolean).join(" ")}
                        onClick={handleCompare}
                        aria-pressed={compareMode}
                    >
                        {"⇄ Compare"}
                        {compareMode ? " ✓" : ""}
                    </button>
                </div>
            </div>

            {/* ---- Body / Panel ---- */}
            <div
                id={panelId}
                className="ws-body"
                role="tabpanel"
                aria-labelledby={tabId(activeId ?? "committed")}
                tabIndex={0}
            >
                {compareMode ? (
                    <CompareBody planStore={planStore} />
                ) : activeScenario ? (
                    <ScenarioBody
                        scenario={activeScenario}
                        onConfirmProposed={onConfirmProposed}
                        onAskWhy={onAskWhy}
                        planStore={planStore}
                        slotMatrix={slotMatrix}
                        onSlotAction={onSlotAction}
                        addTermState={addTermState}
                        onAddCourse={onAddCourse}
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
// CompareBody — H3 implementation
// ============================================================
// Resolves the compare pair from the store, builds the options list, and
// renders the presentational CompareView. Handles the onPick callback:
// when the student changes a picker, compute the new (leftId, rightId)
// pair — keeping the UNCHANGED side stable — guard against equal ids
// (pick would select the same id that's already on the other side), then
// call openCompare with the valid pair.

function CompareBody({ planStore }: { planStore: PlanStore }): ReactElement {
    const state: ScenarioState = planStore.getScenarioState();
    if (!state.compare) return <></>;

    const { leftId, rightId } = state.compare;

    // Resolve both sides. Either can be "committed" (the committed anchor).
    const leftScenario  = getScenario(state, leftId);
    const rightScenario = getScenario(state, rightId);

    // Graceful fallback: if either side can't be resolved (e.g. committed was
    // null, or a scenario was removed while compare was open), show a message
    // rather than crashing.
    if (!leftScenario || !rightScenario) {
        return (
            <div className="compare-empty">
                <p>Select two plans to compare. Use the ⇄ Compare button to choose them.</p>
            </div>
        );
    }

    // Build the selectable options: the committed anchor (when non-null) plus
    // all proposed/whatif scenarios — in order.
    const committedAnchor = getScenario(state, "committed");
    const options = [
        ...(committedAnchor ? [committedAnchor] : []),
        ...state.scenarios,
    ];

    function handlePick(side: "left" | "right", id: string): void {
        // Compute the new pair for the changed side.
        const newLeftId  = side === "left"  ? id : leftId;
        const newRightId = side === "right" ? id : rightId;

        // Guard: never call openCompare with equal ids (it would throw).
        // If the new pick equals the OTHER side, ignore — the user must
        // pick a different scenario (the picker already disables it, but
        // guard defensively).
        if (newLeftId === newRightId) return;

        planStore.openCompare(newLeftId, newRightId);
    }

    return (
        <div className="compare-placeholder" role="region" aria-label="Compare view">
            <CompareView
                left={leftScenario}
                right={rightScenario}
                options={options}
                onPick={handlePick}
            />
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
    /** Plan 37 F3 — applied ONLY to the committed scenario's ScheduleView. */
    slotMatrix?: (slot: ScheduleSlot, term: string) => SlotActionMatrix;
    onSlotAction?: (slot: ScheduleSlot, term: string, action: SlotAction) => void;
    /** Plan 37 F4 — applied ONLY to the committed scenario's ScheduleView. */
    addTermState?: (term: string) => { allowed: boolean; hedge?: string };
    onAddCourse?: (term: string, courseId: string) => void;
}

function ScenarioBody({
    scenario,
    planStore,
    onConfirmProposed,
    onAskWhy,
    slotMatrix,
    onSlotAction,
    addTermState,
    onAddCourse,
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
                            className="btn btn-ghost"
                            onClick={() => planStore.discardScenario(scenario.id)}
                        >
                            Discard
                        </button>
                    </div>
                    <p className="whatif-readonly-note">
                        {"This what-if stays in your session until you discard it — nothing is saved unless you adopt it as your plan."}
                    </p>
                    <p className="whatif-readonly-note">
                        {"Read-only — a what-if never changes your plan. To adopt it, declare it in Albert & upload a new DPR."}
                    </p>
                </>
            )}

            {/* committed: no action buttons — it IS the plan */}

            {/* Schedule grid (plan 37 F3): the COMMITTED plan is EDITABLE via
                the per-slot action popover (propose-only → review → Confirm);
                proposed/whatif columns stay READ-ONLY (a read-only scenario is
                never directly editable — edits flow through chat). The editor
                props are applied ONLY when this is the committed scenario AND
                the caller supplied them (DPR present). */}
            <div className="scenario-schedule">
                {kind === "committed" && slotMatrix && onSlotAction ? (
                    <ScheduleView
                        schedule={scenario.schedule}
                        readOnly={false}
                        slotMatrix={slotMatrix}
                        onSlotAction={onSlotAction}
                        addTermState={addTermState}
                        onAddCourse={onAddCourse}
                    />
                ) : (
                    <ScheduleView
                        schedule={scenario.schedule}
                        readOnly={true}
                    />
                )}
            </div>
        </div>
    );
}
