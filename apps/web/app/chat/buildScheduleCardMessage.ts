// ============================================================
// buildScheduleCardMessage.ts — H4.2a
// ============================================================
// Pure helper: given a Scenario, produce a Message-shaped object
// (kind "schedule_card") to inject into the chat thread whenever
// the engine produces a new proposed schedule.
//
// PURE — no React, no I/O, no module-level state.
// Unit-tested by apps/web/tests/buildScheduleCardMessage.test.ts.
// ============================================================

import type { Scenario } from "./planState";
import type { ScenarioKind } from "./workspace/scenarioBadges";

// ---------------------------------------------------------------------------
// Output type (inlined here so this module doesn't import from page.tsx, which
// has "use client" and is a client component — importing it would pull in all
// of its heavy deps; page.tsx imports US, not vice-versa).
// ---------------------------------------------------------------------------

/**
 * The `scheduleCard` payload embedded in a `kind:"schedule_card"` Message.
 * This matches the `Message["scheduleCard"]` field declared in page.tsx.
 */
export interface ScheduleCardPayload {
    scenarioId: string;
    kind: ScenarioKind;
    label: string;
    summary?: string;
    verdict?: "valid" | "trade-offs" | "invalid";
}

/**
 * Minimal Message shape — keeps this file decoupled from page.tsx.
 * page.tsx uses the full `Message` interface (which extends these fields)
 * so the return value is directly spreadable.
 */
export interface ScheduleCardMessage {
    id: string;
    role: "assistant";
    content: "";
    timestamp: Date;
    kind: "schedule_card";
    scheduleCard: ScheduleCardPayload;
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

/**
 * Derive the card label from a Scenario.
 *
 * Priority:
 *   1. whatIfAssumption.label (Branch B — human-readable "Assumes you
 *      withdraw from X") — clearer than the generic "Proposed: …" from the
 *      compat facade.
 *   2. scenario.label, IF non-empty.
 *   3. "Proposed change" fallback.
 */
function deriveLabel(scenario: Scenario): string {
    if (scenario.whatIfAssumption?.label) {
        return scenario.whatIfAssumption.label;
    }
    if (scenario.label && scenario.label.trim().length > 0) {
        return scenario.label;
    }
    return "Proposed change";
}

/**
 * Derive the optional one-line summary.
 *
 * Priority:
 *   1. whatIfAssumption.hedges[0] (Branch B — "A W does not affect your
 *      GPA." etc.). The assumption marker always has hedges; the first one
 *      is the most salient user-facing statement.
 *   2. scenario.hedges[0] (plain proposed — trade-off list from the
 *      engine, e.g. "Raises credit load this term").
 *   3. undefined (no summary line on the card).
 */
function deriveSummary(scenario: Scenario): string | undefined {
    const waHedges = scenario.whatIfAssumption?.hedges;
    if (waHedges && waHedges.length > 0) {
        return waHedges[0];
    }
    const hedges = scenario.hedges;
    if (hedges && hedges.length > 0) {
        return hedges[0];
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a `kind:"schedule_card"` chat message for a Scenario.
 *
 * @param scenario   The Scenario to represent (proposed or whatif).
 * @param id         Unique message id (caller supplies, same pattern as page.tsx).
 * @param timestamp  When the message is created (caller supplies for testability).
 */
export function buildScheduleCardMessage(
    scenario: Scenario,
    id: string,
    timestamp: Date,
): ScheduleCardMessage {
    return {
        id,
        role: "assistant",
        content: "",
        timestamp,
        kind: "schedule_card",
        scheduleCard: {
            scenarioId: scenario.id,
            kind: scenario.kind,
            label: deriveLabel(scenario),
            summary: deriveSummary(scenario),
            verdict: scenario.verdict,
        },
    };
}
