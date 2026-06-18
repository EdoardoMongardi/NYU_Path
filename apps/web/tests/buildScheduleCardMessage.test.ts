// ============================================================
// buildScheduleCardMessage.test.ts — H4.2a TDD
// ============================================================
// Unit-tests for the pure `buildScheduleCardMessage` helper.
// Written RED-first (before the implementation exists).
//
// Covers:
//   (1) A plain proposed scenario → correct label / kind / verdict / no summary.
//   (2) A proposed scenario with hedges → first hedge becomes summary.
//   (3) A Branch-B what-if scenario (whatIfAssumption present) →
//       label from assumption marker, summary from marker.
//   (4) An empty-label scenario falls back to "Proposed change".
//   (5) The returned object has the correct kind:"schedule_card" shape.
// ============================================================

import { describe, it, expect } from "vitest";
import { buildScheduleCardMessage } from "../app/chat/buildScheduleCardMessage";
import type { Scenario } from "../app/chat/planState";
import type { ForwardSchedule } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

/** A minimal ForwardSchedule stub — only fields the helper needs. */
function makeSchedule(): ForwardSchedule {
    return {
        state: { feasible: true, violations: [], warnings: [] },
        terms: [],
        unscheduled: [],
        completedRequirements: [],
    } as unknown as ForwardSchedule;
}

/** Build a proposed Scenario with optional overrides. */
function makeProposedScenario(
    overrides: Partial<Scenario> = {},
): Scenario {
    return {
        id: "preview-1",
        kind: "proposed",
        label: "Proposed: add",
        schedule: makeSchedule(),
        verdict: "valid",
        createdAt: 1000,
        ...overrides,
    };
}

/** Build a Branch-B what-if Scenario (withdraw/P-F assumption). */
function makeWhatIfScenario(): Scenario {
    return {
        id: "preview-2",
        kind: "proposed",
        label: "Proposed: whatif",
        schedule: makeSchedule(),
        verdict: "trade-offs",
        createdAt: 2000,
        whatIfAssumption: {
            courseId: "MATH-UA 325",
            outcome: "withdraw",
            label: "Assumes you withdraw from MATH-UA 325",
            hedges: ["A W does not affect your GPA.", "Verify with the registrar."],
            windowCaveat: "The withdrawal window closes Dec 5.",
        },
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildScheduleCardMessage", () => {
    // (1) Plain proposed scenario → label / kind / verdict / message shape
    it("returns a message with kind 'schedule_card' for a plain proposed scenario", () => {
        const sc = makeProposedScenario();
        const msg = buildScheduleCardMessage(sc, "msg-1", new Date(3000));
        expect(msg.kind).toBe("schedule_card");
    });

    it("uses the scenario label for a plain proposed scenario", () => {
        const sc = makeProposedScenario({ label: "Proposed: add" });
        const msg = buildScheduleCardMessage(sc, "msg-1", new Date(3000));
        expect(msg.scheduleCard?.label).toBe("Proposed: add");
    });

    it("carries the correct kind from the scenario", () => {
        const sc = makeProposedScenario({ kind: "proposed" });
        const msg = buildScheduleCardMessage(sc, "msg-1", new Date(3000));
        expect(msg.scheduleCard?.kind).toBe("proposed");
    });

    it("carries the correct verdict from the scenario", () => {
        const sc = makeProposedScenario({ verdict: "trade-offs" });
        const msg = buildScheduleCardMessage(sc, "msg-1", new Date(3000));
        expect(msg.scheduleCard?.verdict).toBe("trade-offs");
    });

    it("summary is undefined when hedges is absent", () => {
        const sc = makeProposedScenario({ hedges: undefined });
        const msg = buildScheduleCardMessage(sc, "msg-1", new Date(3000));
        expect(msg.scheduleCard?.summary).toBeUndefined();
    });

    // (2) Proposed scenario with hedges → first hedge becomes summary
    it("uses the first hedge as summary when no whatIfAssumption", () => {
        const sc = makeProposedScenario({
            hedges: ["Trade-off: raises credit load.", "Check with adviser."],
        });
        const msg = buildScheduleCardMessage(sc, "msg-1", new Date(3000));
        expect(msg.scheduleCard?.summary).toBe("Trade-off: raises credit load.");
    });

    it("returns undefined summary when hedges array is empty", () => {
        const sc = makeProposedScenario({ hedges: [] });
        const msg = buildScheduleCardMessage(sc, "msg-1", new Date(3000));
        expect(msg.scheduleCard?.summary).toBeUndefined();
    });

    // (3) Branch-B what-if scenario → label + summary from the assumption marker
    it("uses the whatIfAssumption.label as the card label", () => {
        const sc = makeWhatIfScenario();
        const msg = buildScheduleCardMessage(sc, "msg-2", new Date(4000));
        expect(msg.scheduleCard?.label).toBe("Assumes you withdraw from MATH-UA 325");
    });

    it("uses the first whatIfAssumption.hedge as summary (Branch B)", () => {
        const sc = makeWhatIfScenario();
        const msg = buildScheduleCardMessage(sc, "msg-2", new Date(4000));
        expect(msg.scheduleCard?.summary).toBe("A W does not affect your GPA.");
    });

    it("scenarioId is passed through to the card payload", () => {
        const sc = makeProposedScenario({ id: "preview-99" });
        const msg = buildScheduleCardMessage(sc, "msg-x", new Date(3000));
        expect(msg.scheduleCard?.scenarioId).toBe("preview-99");
    });

    // (4) Empty-label fallback
    it("falls back to 'Proposed change' when the scenario label is empty", () => {
        const sc = makeProposedScenario({ label: "" });
        const msg = buildScheduleCardMessage(sc, "msg-3", new Date(3000));
        expect(msg.scheduleCard?.label).toBe("Proposed change");
    });

    it("falls back to 'Proposed change' when the scenario label is a generic placeholder", () => {
        // previewToScenario uses "Proposed change" as a fallback label already,
        // so the helper must NOT over-strip it
        const sc = makeProposedScenario({ label: "Proposed change" });
        const msg = buildScheduleCardMessage(sc, "msg-3b", new Date(3000));
        expect(msg.scheduleCard?.label).toBe("Proposed change");
    });

    // (5) Message scaffold
    it("carries the provided id and timestamp", () => {
        const sc = makeProposedScenario();
        const ts = new Date(9999);
        const msg = buildScheduleCardMessage(sc, "my-unique-id", ts);
        expect(msg.id).toBe("my-unique-id");
        expect(msg.timestamp).toBe(ts);
    });

    it("is an assistant message with empty content (card carries the payload)", () => {
        const sc = makeProposedScenario();
        const msg = buildScheduleCardMessage(sc, "msg-4", new Date(3000));
        expect(msg.role).toBe("assistant");
        expect(msg.content).toBe("");
    });
});
