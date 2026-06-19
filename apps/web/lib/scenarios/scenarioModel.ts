/**
 * H0.1 — scenarioModel.ts
 *
 * Pure scenario state model: types + pure reducers for the scenarios workspace.
 * No React, no I/O, no module-level state. Every reducer returns a NEW
 * ScenarioState — the input is never mutated.
 *
 * The committed anchor ("My Plan") is NOT in the `scenarios` array. It lives
 * in its own `committed` slot and is resolved by `getScenario("committed")`.
 */

import type { ForwardSchedule } from "@nyupath/shared";
import type { WhatIfAssumptionMarker, WhatIfOutcome } from "@nyupath/engine";
import type { InvalidProposalCard } from "../reviewCard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScenarioKind = "committed" | "proposed" | "whatif";

export type RederiveSpec =
    | { via: "whatif_assumption"; courseId: string; outcome: WhatIfOutcome }
    | { via: "probe"; payload: unknown }
    | { via: "audit_upload" };

export interface Scenario {
    /** "committed" for the anchor; a unique id otherwise. */
    id: string;
    kind: ScenarioKind;
    label: string;
    schedule: ForwardSchedule;
    verdict: "valid" | "trade-offs" | "invalid";
    hedges?: string[];
    /** proposed only */
    pendingMutationId?: string;
    /** proposed withdraw/PF */
    whatIfAssumption?: WhatIfAssumptionMarker;
    /** whatif only */
    rederive?: RederiveSpec;
    /** INJECTED by the caller — reducers never call Date.now(). */
    createdAt: number;
}

export interface ScenarioState {
    committed: ForwardSchedule | null;
    /** proposed + whatif ONLY — the committed anchor is its OWN slot. */
    scenarios: Scenario[];
    /** "committed" or a scenario id. */
    activeId: string;
    compare: { leftId: string; rightId: string } | null;
    invalidProposal: InvalidProposalCard | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Return true iff id is resolvable in s (either "committed" with non-null schedule, or an existing scenario). */
function isResolvable(s: ScenarioState, id: string): boolean {
    if (id === "committed") return s.committed !== null;
    return s.scenarios.some((sc) => sc.id === id);
}

/** Return true iff id is valid as an activeId target ("committed" always valid; scenario must exist). */
function isValidActiveTarget(s: ScenarioState, id: string): boolean {
    if (id === "committed") return true;
    return s.scenarios.some((sc) => sc.id === id);
}

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

/**
 * Create the initial empty state.
 * committed may be null (no DPR loaded yet).
 */
export function initialState(committed: ForwardSchedule | null): ScenarioState {
    return {
        committed,
        scenarios: [],
        activeId: "committed",
        compare: null,
        invalidProposal: null,
    };
}

/**
 * Replace the committed anchor schedule.
 * Does NOT clear `scenarios`. `activeId` is unchanged (it may now point at a
 * scenario id that still exists, or at "committed" — both fine).
 *
 * NO-OP guard: returns `s` unchanged (same reference) when the schedule is
 * already the same object, so `useSyncExternalStore` sees no spurious change.
 */
export function setCommitted(s: ScenarioState, schedule: ForwardSchedule): ScenarioState {
    if (schedule === s.committed) return s;
    return { ...s, committed: schedule };
}

/**
 * Append a new scenario (or replace an existing one with the same id).
 * Sets activeId to the new scenario. Clears compare.
 *
 * Throws if `scenario.id === "committed"` (the anchor is not a list scenario).
 */
export function addScenario(s: ScenarioState, scenario: Scenario): ScenarioState {
    if (scenario.id === "committed") {
        throw new Error(
            'addScenario: scenario.id may not be "committed" — the committed anchor is not a list scenario.',
        );
    }
    const existing = s.scenarios.findIndex((sc) => sc.id === scenario.id);
    let newScenarios: Scenario[];
    if (existing !== -1) {
        // Replace in-place to preserve ordering of other entries.
        newScenarios = s.scenarios.map((sc, i) => (i === existing ? scenario : sc));
    } else {
        newScenarios = [...s.scenarios, scenario];
    }
    return {
        ...s,
        scenarios: newScenarios,
        activeId: scenario.id,
        compare: null,
    };
}

/**
 * Set the active tab.
 * Clears compare.
 *
 * Throws if id is neither "committed" nor an existing scenario id.
 *
 * NO-OP guard: returns `s` unchanged (same reference) when id is already the
 * active tab AND compare is already null, so `useSyncExternalStore` sees no
 * spurious change.
 */
export function setActive(s: ScenarioState, id: string): ScenarioState {
    if (!isValidActiveTarget(s, id)) {
        throw new Error(
            `setActive: unknown id "${id}". Must be "committed" or an existing scenario id.`,
        );
    }
    // No-op: already the active tab and compare is already null.
    if (id === s.activeId && s.compare === null) return s;
    return { ...s, activeId: id, compare: null };
}

/**
 * Open the side-by-side compare view.
 *
 * Throws if leftId === rightId, or if either id is neither "committed" nor an existing scenario.
 */
export function openCompare(s: ScenarioState, leftId: string, rightId: string): ScenarioState {
    if (leftId === rightId) {
        throw new Error(`openCompare: leftId and rightId must differ (both are "${leftId}").`);
    }
    if (!isResolvable(s, leftId)) {
        throw new Error(`openCompare: leftId "${leftId}" is not resolvable.`);
    }
    if (!isResolvable(s, rightId)) {
        throw new Error(`openCompare: rightId "${rightId}" is not resolvable.`);
    }
    return { ...s, compare: { leftId, rightId } };
}

/**
 * Close the compare view (set compare to null).
 *
 * NO-OP guard: returns `s` unchanged (same reference) when compare is already
 * null, so `useSyncExternalStore` sees no spurious change.
 */
export function closeCompare(s: ScenarioState): ScenarioState {
    if (s.compare === null) return s;
    return { ...s, compare: null };
}

/**
 * Remove a scenario by id.
 * - If activeId was that scenario, fall back to "committed".
 * - If compare referenced it, clear compare.
 * - No-op (returns the SAME state reference) if id not found, so a
 *   `useSyncExternalStore` wrapper (H0.2) sees no spurious change.
 */
export function discardScenario(s: ScenarioState, id: string): ScenarioState {
    const exists = s.scenarios.some((sc) => sc.id === id);
    if (!exists) {
        // No-op — return `s` unchanged (NOT a clone) so referential-equality
        // consumers (the store's useSyncExternalStore) don't re-render.
        return s;
    }
    const newScenarios = s.scenarios.filter((sc) => sc.id !== id);
    const newActiveId = s.activeId === id ? "committed" : s.activeId;
    const compareReferencesId =
        s.compare !== null &&
        (s.compare.leftId === id || s.compare.rightId === id);
    const newCompare = compareReferencesId ? null : s.compare;
    return {
        ...s,
        scenarios: newScenarios,
        activeId: newActiveId,
        compare: newCompare,
    };
}

/**
 * Confirm a proposed scenario — THE commit chokepoint.
 *
 * Semantics:
 *   - The scenario must exist AND be kind="proposed" (else throw).
 *   - committed = that scenario's schedule.
 *   - Remove the scenario from scenarios[].
 *   - activeId = "committed".
 *   - compare = null; invalidProposal = null.
 *
 * PURE — does NOT persist. The store wrapper in a later task calls the
 * server-side confirm round-trip. This function only computes the new state.
 */
export function confirmProposed(s: ScenarioState, id: string): ScenarioState {
    const scenario = s.scenarios.find((sc) => sc.id === id);
    if (!scenario) {
        throw new Error(`confirmProposed: no scenario with id "${id}".`);
    }
    if (scenario.kind !== "proposed") {
        throw new Error(
            `confirmProposed: scenario "${id}" is kind="${scenario.kind}", must be "proposed".`,
        );
    }
    return {
        ...s,
        committed: scenario.schedule,
        scenarios: s.scenarios.filter((sc) => sc.id !== id),
        activeId: "committed",
        compare: null,
        invalidProposal: null,
    };
}

/**
 * Swap only the invalidProposal slot.
 */
export function setInvalidProposal(
    s: ScenarioState,
    card: InvalidProposalCard | null,
): ScenarioState {
    return { ...s, invalidProposal: card };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Resolve an id to a Scenario (or a synthesized committed-anchor view).
 *
 * - "committed" → synthesizes `{ id:"committed", kind:"committed", label:"My Plan",
 *   schedule: s.committed, verdict:"valid", createdAt: 0 }` when committed is
 *   non-null. `createdAt: 0` is a SENTINEL — the committed plan has no single
 *   creation timestamp (it's been confirmed/refreshed many times); consumers
 *   must NOT treat it as a real epoch (e.g. for ordering). Returns undefined
 *   when committed is null.
 * - Any other id → looks up in scenarios[]. Returns undefined if not found.
 */
export function getScenario(s: ScenarioState, id: string): Scenario | undefined {
    if (id === "committed") {
        if (s.committed === null) return undefined;
        return {
            id: "committed",
            kind: "committed",
            label: "My Plan",
            schedule: s.committed,
            verdict: "valid",
            createdAt: 0, // sentinel — committed has no single createdAt (see JSDoc)
        };
    }
    return s.scenarios.find((sc) => sc.id === id);
}

/**
 * Resolve the currently-active scenario (delegates to getScenario).
 */
export function activeScenario(s: ScenarioState): Scenario | undefined {
    return getScenario(s, s.activeId);
}
