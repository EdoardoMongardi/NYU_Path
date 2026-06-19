// ============================================================
// ProfileRail — H5.1 (plan 36 scenarios workspace UI)
// ============================================================
// The RIGHT ZONE of the 3-zone chat page. Replaces the heavyweight
// `scheduleSidebar.tsx` (schedule grid + slot popovers + the G3.2
// what-if control + the review/preview card). Those concerns moved:
//   - the schedule grid + per-kind action bodies → the CENTER-zone
//     ScheduleWorkspace (H2/H3),
//   - what-if creation → CHAT ONLY (the agent's propose_plan_change /
//     what_if flow — owner decision confirmed in plan 36; the rail has
//     NO spawn control),
//   - the review/preview card → the workspace's ScenarioBody.
//
// What remains here is PROFILE-LEVEL only (top → bottom):
//   1. a "Your profile" header,
//   2. <SummaryCard> — the DPR-derived read-only fields (home school /
//      major-minor / catalog year / GPA / credits / grad target). These
//      stay READ-ONLY (CORE RULE 14 — they change only via a corrected
//      DPR). The COMMITTED schedule feeds the card (NOT an active
//      scenario), so the profile always reflects the authoritative plan.
//   3. the "↻ Update DPR" refresh control — the single path by which a
//      student updates the authoritative plan (upload a fresh DPR PDF).
//   4. the SCENARIOS LIST — the committed anchor pinned at top ("My Plan",
//      ✓ committed) + one row per proposed/whatif scenario, badge-colored,
//      with a per-row Compare affordance. Clicking a row selects it
//      (→ store.setActive via the page); Compare opens committed-vs-row
//      (→ store.openCompare via the page).
//   5. the "your DPR is never changed / only your committed plan is saved"
//      note + the standing account actions (delete account / clear-all).
//
// Design constraints:
//   - Reads scenario state via `useSyncExternalStore` (same pattern as
//     ScheduleWorkspace) so the list re-renders when the store changes.
//   - Holds NO decision logic: badge labels/classes come from
//     `scenarioBadges`; the SummaryCard owns its own field derivation.
//   - The full visual pass is H6; the classes here reuse the existing
//     sidebar CSS so the rail is styled-enough but not bespoke yet.
// ============================================================
"use client";

import { type ReactElement, useRef, useSyncExternalStore } from "react";
import type { StudentProfile } from "@nyupath/shared";
import type { DegreeProgressReport } from "@nyupath/engine";
import type { PlanStore } from "./planState";
import styles from "./chat.module.css";
import SummaryCard from "./profile/SummaryCard";
import { kindBadgeClass, kindBadgeLabel, verdictDisplay } from "./workspace/scenarioBadges";

// Phase 16 Task B — env-flag-gated test "clear all" affordance. Read at
// render time (not module-eval) so a Vitest run that mutates the env
// before the rail mounts still sees the fresh value. Mirrors the
// behavior the scheduleSidebar had so the test-clear affordance is
// gated identically after the rail replaces it.
function isTestClearEnabled(): boolean {
    return process.env.NEXT_PUBLIC_ENABLE_TEST_CLEAR === "1";
}

// ============================================================
// Props
// ============================================================

export interface ProfileRailProps {
    /** The DPR-derived student profile (read-only). Null pre-onboarding. */
    student: StudentProfile | null;
    /** The authoritative DPR (read-only). Null pre-onboarding. */
    dpr: DegreeProgressReport | null;
    /** The shared plan store (the SAME instance the workspace holds). */
    planStore: PlanStore;
    /** Upload a fresh DPR PDF → re-plan the authoritative committed plan. */
    onRefreshDpr?: (file: File) => Promise<void> | void;
    /** In-flight guard for the DPR-refresh control (from the page). */
    refreshing?: boolean;
    /** Env-gated test affordance — wipe all data for this student. */
    onClearAll?: () => Promise<void> | void;
    /** STANDING self-serve account deletion (always shown to a signed-in user). */
    onDeleteAccount?: () => Promise<void> | void;
    /** In-flight guard for the delete control (from the page). */
    deletingAccount?: boolean;
    /** Select a scenario by id ("committed" or a scenario id) → store.setActive. */
    onSelectScenario: (id: string) => void;
    /** Compare a scenario against the committed anchor → store.openCompare("committed", id). */
    onCompareScenario: (id: string) => void;
}

// ============================================================
// Component
// ============================================================

export default function ProfileRail({
    student,
    dpr,
    planStore,
    onRefreshDpr,
    refreshing = false,
    onClearAll,
    onDeleteAccount,
    deletingAccount = false,
    onSelectScenario,
    onCompareScenario,
}: ProfileRailProps): ReactElement {
    const refreshInputRef = useRef<HTMLInputElement>(null);
    const testClearEnabled = isTestClearEnabled();

    // Subscribe to the store so the scenarios list + the committed anchor
    // re-render on every mutation (same pattern as ScheduleWorkspace).
    useSyncExternalStore(
        planStore.subscribe,
        planStore.getSnapshot,
        planStore.getSnapshot,
    );

    const committedSchedule = planStore.getCommitted();
    const scenarios = planStore.getScenarios();
    const activeId = planStore.getScenarioState().activeId;

    function handleRefreshPick(file: File): void {
        if (!onRefreshDpr || refreshing) return;
        // The page-side handler owns the busy state via the `refreshing`
        // prop, so we just forward the file.
        void onRefreshDpr(file);
    }

    return (
        <aside className={styles.profileRail} aria-label="Your profile">
            <div className={styles.scheduleSidebarHeader}>
                <h2 className={styles.scheduleSidebarTitle}>Your profile</h2>
            </div>

            <div className={styles.scheduleSidebarBody}>
                {/* 1 + 2 — DPR-derived read-only profile fields (CORE RULE 14).
                    The COMMITTED schedule feeds the card (not an active
                    scenario) so the profile always reflects the authoritative
                    plan, never a hypothetical. */}
                {student && (
                    <SummaryCard student={student} dpr={dpr} schedule={committedSchedule} />
                )}

                {/* 3 — DPR-refresh: the single path to change the authoritative plan. */}
                {onRefreshDpr && (
                    <div className={styles.sidebarToolbar}>
                        <button
                            type="button"
                            className={styles.sidebarToolbarBtn}
                            onClick={() => refreshInputRef.current?.click()}
                            disabled={refreshing}
                            title="Upload a fresh DPR PDF — re-plans your schedule if anything changed"
                        >
                            {refreshing ? "Updating…" : "↻ Update DPR"}
                        </button>
                        <input
                            ref={refreshInputRef}
                            type="file"
                            accept=".pdf"
                            className={styles.sidebarToolbarHiddenInput}
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleRefreshPick(f);
                                e.target.value = "";
                            }}
                        />
                    </div>
                )}

                {/* 4 — scenarios list. The committed anchor is pinned at top;
                    every proposed/whatif scenario follows as a badge-colored
                    row with a per-row Compare affordance. */}
                <ScenarioList
                    hasCommitted={committedSchedule !== null}
                    scenarios={scenarios}
                    activeId={activeId}
                    onSelectScenario={onSelectScenario}
                    onCompareScenario={onCompareScenario}
                />

                {/* 5a — the "only My Plan is saved / DPR never changed" note.
                    Reuses the sidebar's what-if-disclaimer wording so the
                    privacy promise is stated where the student manages their
                    profile. */}
                <p className={styles.profileRailNote} role="note">
                    Only <strong>My Plan</strong> is saved. Your DPR is never changed — it
                    updates only when you upload a corrected one. Proposed changes and
                    what-ifs are explorations and are not recorded until you confirm them
                    into My Plan.
                </p>
            </div>

            {/* 5b — STANDING self-serve account deletion. Always visible to a
                signed-in student (not gated on the test-clear flag). */}
            {onDeleteAccount && (
                <div className={styles.sidebarToolbarBottom}>
                    <button
                        type="button"
                        className={styles.sidebarClearBtn}
                        onClick={() => void onDeleteAccount()}
                        disabled={deletingAccount}
                        title="Permanently delete your account and all your data"
                    >
                        {deletingAccount ? "Deleting…" : "Delete my account & data"}
                    </button>
                </div>
            )}

            {/* 5c — env-gated test-clear affordance. */}
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
// ScenarioList — pinned committed anchor + a row per scenario
// ============================================================

interface ScenarioListProps {
    hasCommitted: boolean;
    scenarios: ReadonlyArray<{
        id: string;
        kind: "committed" | "proposed" | "whatif";
        label: string;
        verdict: "valid" | "trade-offs" | "invalid";
    }>;
    activeId: string;
    onSelectScenario: (id: string) => void;
    onCompareScenario: (id: string) => void;
}

function ScenarioList({
    hasCommitted,
    scenarios,
    activeId,
    onSelectScenario,
    onCompareScenario,
}: ScenarioListProps): ReactElement {
    return (
        <section className={styles.profileRailScenarios} aria-label="Scenarios">
            <h3 className={styles.profileRailScenariosHeader}>Plans &amp; scenarios</h3>
            <ul className={styles.profileRailScenarioList}>
                {/* Pinned committed anchor — "My Plan". Always first; NO compare
                    affordance (committed-vs-committed is invalid). When no DPR is
                    loaded yet, show a muted placeholder row instead. */}
                {hasCommitted ? (
                    <ScenarioRow
                        id="committed"
                        kind="committed"
                        label="My Plan"
                        verdict="valid"
                        active={activeId === "committed"}
                        pinned
                        onSelect={onSelectScenario}
                        /* no onCompare for the committed anchor */
                    />
                ) : (
                    <li className={styles.profileRailScenarioEmpty} aria-disabled="true">
                        No plan yet — upload your DPR to get started.
                    </li>
                )}

                {/* One row per proposed/whatif scenario. */}
                {scenarios.map((sc) => (
                    <ScenarioRow
                        key={sc.id}
                        id={sc.id}
                        kind={sc.kind}
                        label={sc.label}
                        verdict={sc.verdict}
                        active={activeId === sc.id}
                        onSelect={onSelectScenario}
                        onCompare={onCompareScenario}
                    />
                ))}
            </ul>
        </section>
    );
}

// ============================================================
// ScenarioRow — one selectable scenario row + badge + verdict + compare
// ============================================================

interface ScenarioRowProps {
    id: string;
    kind: "committed" | "proposed" | "whatif";
    label: string;
    verdict: "valid" | "trade-offs" | "invalid";
    active: boolean;
    pinned?: boolean;
    onSelect: (id: string) => void;
    onCompare?: (id: string) => void;
}

function ScenarioRow({
    id,
    kind,
    label,
    verdict,
    active,
    pinned = false,
    onSelect,
    onCompare,
}: ScenarioRowProps): ReactElement {
    const vd = verdictDisplay(verdict);
    return (
        <li
            className={[
                styles.profileRailScenarioRow,
                active ? styles.profileRailScenarioRowActive : "",
            ].filter(Boolean).join(" ")}
            data-scenario-row={id}
            aria-current={active ? "true" : undefined}
        >
            {/* The selectable body. A plain button so the whole row is one
                click target; the compare affordance sits OUTSIDE it so the two
                actions don't nest (no nested-button hydration warning). */}
            <button
                type="button"
                className={styles.profileRailScenarioSelect}
                data-select=""
                onClick={() => onSelect(id)}
                aria-pressed={active}
            >
                {pinned && <span className={styles.profileRailScenarioPin} aria-hidden="true">📌 </span>}
                <span className={styles.profileRailScenarioLabel}>{label}</span>
                <span className={kindBadgeClass(kind)}>{kindBadgeLabel(kind)}</span>
                <span className={vd.className} title={vd.label} aria-label={vd.label}>
                    {vd.glyph}
                </span>
            </button>

            {/* Per-row Compare affordance — committed-vs-this. Omitted for the
                committed anchor (committed-vs-committed throws in openCompare). */}
            {onCompare && (
                <button
                    type="button"
                    className={styles.profileRailScenarioCompare}
                    data-compare=""
                    onClick={() => onCompare(id)}
                    title={`Compare ${label} with My Plan`}
                    aria-label={`Compare ${label} with My Plan`}
                >
                    ⇄
                </button>
            )}
        </li>
    );
}
