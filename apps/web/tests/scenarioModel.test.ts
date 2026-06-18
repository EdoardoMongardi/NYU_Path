/**
 * H0.1 — scenarioModel.test.ts
 *
 * Pure unit tests for the scenario state model. No React, no I/O.
 * RED phase: import paths intentionally point at the not-yet-created
 * implementation file so these tests fail with "module not found" first.
 */

import { describe, it, expect } from "vitest";
import type { ForwardSchedule } from "@nyupath/shared";
import type { InvalidProposalCard } from "../lib/reviewCard";
import {
    initialState,
    setCommitted,
    addScenario,
    setActive,
    openCompare,
    closeCompare,
    discardScenario,
    confirmProposed,
    setInvalidProposal,
    getScenario,
    activeScenario,
} from "../lib/scenarios/scenarioModel";
import type { Scenario, ScenarioState } from "../lib/scenarios/scenarioModel";
import { makeFeasibleScheduleWithSemesters } from "./_planRouteTestUtils";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSchedule(studentId = "s1"): ForwardSchedule {
    return makeFeasibleScheduleWithSemesters(studentId, []);
}

function makeScenario(overrides: Partial<Scenario> = {}): Scenario {
    return {
        id: "sc-1",
        kind: "proposed",
        label: "Test scenario",
        schedule: makeSchedule("s2"),
        verdict: "valid",
        createdAt: 1000,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// initialState
// ---------------------------------------------------------------------------

describe("initialState", () => {
    it("returns correct shape with committed=null", () => {
        const s = initialState(null);
        expect(s.committed).toBeNull();
        expect(s.scenarios).toEqual([]);
        expect(s.activeId).toBe("committed");
        expect(s.compare).toBeNull();
        expect(s.invalidProposal).toBeNull();
    });

    it("returns correct shape with a committed schedule", () => {
        const sched = makeSchedule();
        const s = initialState(sched);
        expect(s.committed).toBe(sched);
        expect(s.scenarios).toEqual([]);
        expect(s.activeId).toBe("committed");
        expect(s.compare).toBeNull();
        expect(s.invalidProposal).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// setCommitted
// ---------------------------------------------------------------------------

describe("setCommitted", () => {
    it("replaces committed schedule, does NOT clear scenarios", () => {
        const sched1 = makeSchedule("s1");
        const sched2 = makeSchedule("s2");
        let s = initialState(sched1);
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = setCommitted(s, sched2);
        expect(s.committed).toBe(sched2);
        expect(s.scenarios).toHaveLength(1);
    });

    it("does not change activeId when activeId is committed", () => {
        const s0 = initialState(makeSchedule());
        const s1 = setCommitted(s0, makeSchedule("s2"));
        expect(s1.activeId).toBe("committed");
    });

    it("leaves activeId pointing at scenario even if it was still in list", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        expect(s.activeId).toBe("sc-1");
        const s1 = setCommitted(s, makeSchedule("s2"));
        // activeId still "sc-1" — the scenario wasn't removed
        expect(s1.activeId).toBe("sc-1");
    });
});

// ---------------------------------------------------------------------------
// addScenario
// ---------------------------------------------------------------------------

describe("addScenario", () => {
    it("appends a new scenario and sets activeId", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        expect(s.scenarios).toHaveLength(1);
        expect(s.activeId).toBe("sc-1");
    });

    it("clears compare when a new scenario is added", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = { ...s, compare: { leftId: "committed", rightId: "sc-1" } };
        s = addScenario(s, makeScenario({ id: "sc-3" }));
        expect(s.compare).toBeNull();
        expect(s.activeId).toBe("sc-3");
    });

    it("de-dupes by id (replaces existing scenario)", () => {
        let s = initialState(makeSchedule());
        const sc1a = makeScenario({ id: "sc-1", label: "original" });
        const sc1b = makeScenario({ id: "sc-1", label: "updated" });
        s = addScenario(s, sc1a);
        s = addScenario(s, sc1b);
        expect(s.scenarios).toHaveLength(1);
        expect(s.scenarios[0].label).toBe("updated");
        expect(s.activeId).toBe("sc-1");
    });

    it("throws if scenario.id === 'committed'", () => {
        const s = initialState(makeSchedule());
        expect(() => addScenario(s, makeScenario({ id: "committed" }))).toThrow();
    });

    it("never puts the committed anchor in scenarios[]", () => {
        const s = initialState(makeSchedule());
        const thrown = (() => {
            try {
                addScenario(s, makeScenario({ id: "committed" }));
                return false;
            } catch {
                return true;
            }
        })();
        expect(thrown).toBe(true);
        expect(s.scenarios).toHaveLength(0);
    });

    it("does NOT mutate the input state", () => {
        const s0 = initialState(makeSchedule());
        const s1 = addScenario(s0, makeScenario({ id: "sc-1" }));
        expect(s0.scenarios).toHaveLength(0);
        expect(s1.scenarios).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// setActive
// ---------------------------------------------------------------------------

describe("setActive", () => {
    it("sets activeId to 'committed'", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = setActive(s, "committed");
        expect(s.activeId).toBe("committed");
    });

    it("sets activeId to an existing scenario id", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = setActive(s, "sc-1");
        expect(s.activeId).toBe("sc-1");
    });

    it("clears compare on setActive", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = openCompare(s, "sc-1", "sc-2");
        expect(s.compare).not.toBeNull();
        s = setActive(s, "sc-1");
        expect(s.compare).toBeNull();
    });

    it("throws on unknown id", () => {
        const s = initialState(makeSchedule());
        expect(() => setActive(s, "does-not-exist")).toThrow();
    });
});

// ---------------------------------------------------------------------------
// openCompare
// ---------------------------------------------------------------------------

describe("openCompare", () => {
    it("sets compare with leftId and rightId", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = openCompare(s, "committed", "sc-1");
        expect(s.compare).toEqual({ leftId: "committed", rightId: "sc-1" });
    });

    it("throws if leftId === rightId", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        expect(() => openCompare(s, "sc-1", "sc-1")).toThrow();
    });

    it("throws if leftId is unknown", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        expect(() => openCompare(s, "unknown", "sc-1")).toThrow();
    });

    it("throws if rightId is unknown", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        expect(() => openCompare(s, "committed", "unknown")).toThrow();
    });

    it("allows committed,committed to fail (equal)", () => {
        const s = initialState(makeSchedule());
        expect(() => openCompare(s, "committed", "committed")).toThrow();
    });
});

// ---------------------------------------------------------------------------
// closeCompare
// ---------------------------------------------------------------------------

describe("closeCompare", () => {
    it("sets compare to null", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = openCompare(s, "committed", "sc-1");
        s = closeCompare(s);
        expect(s.compare).toBeNull();
    });

    it("is a no-op if compare was already null", () => {
        const s = initialState(makeSchedule());
        expect(closeCompare(s).compare).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// discardScenario
// ---------------------------------------------------------------------------

describe("discardScenario", () => {
    it("removes the scenario by id", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = discardScenario(s, "sc-1");
        expect(s.scenarios.map((x) => x.id)).not.toContain("sc-1");
        expect(s.scenarios.map((x) => x.id)).toContain("sc-2");
    });

    it("falls back activeId to 'committed' if the active scenario is removed", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        expect(s.activeId).toBe("sc-1");
        s = discardScenario(s, "sc-1");
        expect(s.activeId).toBe("committed");
    });

    it("does NOT change activeId if the removed scenario was not active", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = setActive(s, "sc-1");
        s = discardScenario(s, "sc-2");
        expect(s.activeId).toBe("sc-1");
    });

    it("clears compare if the discarded scenario was referenced", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = openCompare(s, "sc-1", "sc-2");
        s = discardScenario(s, "sc-1");
        expect(s.compare).toBeNull();
    });

    it("is a no-op (does not throw) if id not found, returning the SAME reference", () => {
        const s = initialState(makeSchedule());
        expect(() => discardScenario(s, "does-not-exist")).not.toThrow();
        // Returns `s` unchanged (NOT a clone) so a useSyncExternalStore wrapper
        // (H0.2) sees no spurious change → no re-render.
        expect(discardScenario(s, "does-not-exist")).toBe(s);
    });
});

// ---------------------------------------------------------------------------
// confirmProposed
// ---------------------------------------------------------------------------

describe("confirmProposed", () => {
    it("promotes the proposed schedule to committed", () => {
        const sched1 = makeSchedule("s1");
        const sched2 = makeSchedule("s2");
        let s = initialState(sched1);
        s = addScenario(s, makeScenario({ id: "sc-1", kind: "proposed", schedule: sched2 }));
        s = confirmProposed(s, "sc-1");
        expect(s.committed).toBe(sched2);
    });

    it("removes the confirmed scenario from scenarios[]", () => {
        let s = initialState(makeSchedule("s1"));
        s = addScenario(s, makeScenario({ id: "sc-1", kind: "proposed" }));
        s = confirmProposed(s, "sc-1");
        expect(s.scenarios.map((x) => x.id)).not.toContain("sc-1");
    });

    it("sets activeId to 'committed'", () => {
        let s = initialState(makeSchedule("s1"));
        s = addScenario(s, makeScenario({ id: "sc-1", kind: "proposed" }));
        s = confirmProposed(s, "sc-1");
        expect(s.activeId).toBe("committed");
    });

    it("clears compare and invalidProposal", () => {
        let s = initialState(makeSchedule("s1"));
        s = addScenario(s, makeScenario({ id: "sc-1", kind: "proposed" }));
        s = addScenario(s, makeScenario({ id: "sc-2", kind: "proposed" }));
        s = openCompare(s, "sc-1", "sc-2");
        s = setInvalidProposal(s, {
            bindingConstraints: [{ kind: "prereq", detail: "X before Y" }],
        });
        s = confirmProposed(s, "sc-1");
        expect(s.compare).toBeNull();
        expect(s.invalidProposal).toBeNull();
    });

    it("is PURE — does not persist anything (the returned state carries the change)", () => {
        const sched1 = makeSchedule("s1");
        const sched2 = makeSchedule("s2");
        const s0 = initialState(sched1);
        const s1 = addScenario(s0, makeScenario({ id: "sc-1", kind: "proposed", schedule: sched2 }));
        const s2 = confirmProposed(s1, "sc-1");
        // original state untouched
        expect(s1.committed).toBe(sched1);
        expect(s2.committed).toBe(sched2);
    });

    it("throws if the scenario does not exist", () => {
        const s = initialState(makeSchedule());
        expect(() => confirmProposed(s, "non-existent")).toThrow();
    });

    it("throws if the scenario is not kind='proposed' (e.g. 'whatif')", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1", kind: "whatif" }));
        expect(() => confirmProposed(s, "sc-1")).toThrow();
    });
});

// ---------------------------------------------------------------------------
// setInvalidProposal
// ---------------------------------------------------------------------------

describe("setInvalidProposal", () => {
    it("sets a card", () => {
        const s = initialState(makeSchedule());
        const card: InvalidProposalCard = {
            bindingConstraints: [{ kind: "prereq", detail: "X before Y" }],
        };
        const s1 = setInvalidProposal(s, card);
        expect(s1.invalidProposal).toEqual(card);
        // rest of state unchanged
        expect(s1.committed).toBe(s.committed);
        expect(s1.scenarios).toBe(s.scenarios);
    });

    it("clears the card to null", () => {
        let s = initialState(makeSchedule());
        s = setInvalidProposal(s, {
            bindingConstraints: [{ kind: "prereq", detail: "X before Y" }],
        });
        s = setInvalidProposal(s, null);
        expect(s.invalidProposal).toBeNull();
    });

    it("does NOT mutate the input state", () => {
        const s0 = initialState(makeSchedule());
        const s1 = setInvalidProposal(s0, {
            bindingConstraints: [],
        });
        expect(s0.invalidProposal).toBeNull();
        expect(s1.invalidProposal).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------
// getScenario / activeScenario
// ---------------------------------------------------------------------------

describe("getScenario", () => {
    it("resolves 'committed' to a synthesized committed-scenario view", () => {
        const sched = makeSchedule();
        const s = initialState(sched);
        const view = getScenario(s, "committed");
        expect(view).toBeDefined();
        expect(view!.id).toBe("committed");
        expect(view!.kind).toBe("committed");
        expect(view!.label).toBe("My Plan");
        expect(view!.schedule).toBe(sched);
        expect(view!.verdict).toBe("valid");
    });

    it("returns undefined for 'committed' when committed is null", () => {
        const s = initialState(null);
        expect(getScenario(s, "committed")).toBeUndefined();
    });

    it("resolves an existing scenario id", () => {
        let s = initialState(makeSchedule());
        const sc = makeScenario({ id: "sc-1" });
        s = addScenario(s, sc);
        const view = getScenario(s, "sc-1");
        expect(view).toBe(sc);
    });

    it("returns undefined for an unknown id", () => {
        const s = initialState(makeSchedule());
        expect(getScenario(s, "unknown")).toBeUndefined();
    });
});

describe("activeScenario", () => {
    it("returns the synthesized committed view when activeId is 'committed'", () => {
        const sched = makeSchedule();
        const s = initialState(sched);
        const view = activeScenario(s);
        expect(view?.id).toBe("committed");
        expect(view?.schedule).toBe(sched);
    });

    it("returns the active scenario when set", () => {
        let s = initialState(makeSchedule());
        const sc = makeScenario({ id: "sc-1" });
        s = addScenario(s, sc);
        expect(activeScenario(s)).toBe(sc);
    });
});

// ---------------------------------------------------------------------------
// H2.3 no-op guard identities (useSyncExternalStore referential stability)
// ---------------------------------------------------------------------------

describe("setActive — no-op guard", () => {
    it("returns the SAME reference when id is already active AND compare is null", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        // sc-1 is now active; compare is null (addScenario clears it)
        const s2 = setActive(s, "sc-1");
        expect(s2).toBe(s);
    });

    it("returns a NEW reference when switching to a different id", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = setActive(s, "sc-1"); // active = sc-1
        const s2 = setActive(s, "sc-2");
        expect(s2).not.toBe(s);
        expect(s2.activeId).toBe("sc-2");
    });

    it("returns a NEW reference when id matches but compare is non-null (must clear compare)", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = openCompare(s, "sc-1", "sc-2");
        s = setActive(s, "sc-2"); // first call sets active + clears compare
        // Now sc-2 is active, compare is null — calling setActive(sc-2) again should be a no-op.
        const s2 = setActive(s, "sc-2");
        expect(s2).toBe(s);
    });
});

describe("closeCompare — no-op guard", () => {
    it("returns the SAME reference when compare is already null", () => {
        const s = initialState(makeSchedule());
        expect(s.compare).toBeNull();
        const s2 = closeCompare(s);
        expect(s2).toBe(s);
    });

    it("returns a NEW reference (compare cleared) when compare was non-null", () => {
        let s = initialState(makeSchedule());
        s = addScenario(s, makeScenario({ id: "sc-1" }));
        s = addScenario(s, makeScenario({ id: "sc-2" }));
        s = openCompare(s, "sc-1", "sc-2");
        expect(s.compare).not.toBeNull();
        const s2 = closeCompare(s);
        expect(s2).not.toBe(s);
        expect(s2.compare).toBeNull();
    });
});

describe("setCommitted — no-op guard", () => {
    it("returns the SAME reference when the schedule is the same object", () => {
        const sched = makeSchedule();
        const s = initialState(sched);
        const s2 = setCommitted(s, sched);
        expect(s2).toBe(s);
    });

    it("returns a NEW reference when the schedule differs", () => {
        const sched1 = makeSchedule("s1");
        const sched2 = makeSchedule("s2");
        const s = initialState(sched1);
        const s2 = setCommitted(s, sched2);
        expect(s2).not.toBe(s);
        expect(s2.committed).toBe(sched2);
    });
});
