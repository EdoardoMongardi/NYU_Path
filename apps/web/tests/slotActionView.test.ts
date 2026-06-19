// ============================================================
// F1 — slotActionView unit test
// ============================================================
// TDD: written BEFORE slotActionView.ts exists.
//
// Covers:
//   (1) The returned array contains only the 3 per-slot actions:
//       drop / withdraw / passFail (add is excluded — it's a
//       term-level action, not a per-slot action; see slotActionView.ts
//       for rationale).
//   (2) Labels: drop→"Drop", withdraw→"Withdraw", passFail→"Pass/Fail".
//   (3) enabled=true + tooltip=hedge when the action is allowed + has hedge.
//   (4) enabled=false + tooltip=reason when the action is forbidden.
//   (5) tooltip is undefined when enabled=true and there is no hedge.
//   (6) The order is stable: drop, withdraw, passFail.
// ============================================================

import { describe, expect, it } from "vitest";
import type { SlotActionMatrix } from "@nyupath/engine";
import { slotActionView } from "../app/chat/workspace/slotActionView";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** Build a minimal SlotActionMatrix for a REGISTERED slot where:
 *   - withdraw is ALLOWED (hedge = "check the deadline")
 *   - drop is ALLOWED (no hedge)
 *   - passFail is FORBIDDEN (reason = "can't elect")
 *   - add is always false (REGISTERED: already registered)
 */
function makeRegisteredMatrix(): SlotActionMatrix {
    return {
        state: "registered",
        allowed: {
            add: false,
            drop: true,
            withdraw: true,
            passFail: false,
        },
        perAction: {
            add: { reason: "already registered" },
            drop: { hedge: undefined },
            withdraw: { hedge: "check the deadline" },
            passFail: { reason: "can't elect" },
        },
    } as unknown as SlotActionMatrix;
}

/** Build a PLANNED slot matrix where only drop is allowed (no hedge). */
function makePlannedMatrix(): SlotActionMatrix {
    return {
        state: "planned",
        allowed: {
            add: false,
            drop: true,
            withdraw: false,
            passFail: false,
        },
        perAction: {
            add: { reason: "use the term affordance" },
            drop: { hedge: "removes from plan" },
            withdraw: { reason: "not applicable — only planned" },
            passFail: { reason: "not in progress yet" },
        },
    } as unknown as SlotActionMatrix;
}

// ---------------------------------------------------------------------------
// (1) Only 3 per-slot actions returned (add excluded)
// ---------------------------------------------------------------------------

describe("slotActionView — action coverage", () => {
    it("returns exactly 3 items (drop, withdraw, passFail — add excluded)", () => {
        const items = slotActionView(makeRegisteredMatrix());
        expect(items).toHaveLength(3);
        const actions = items.map((i) => i.action);
        expect(actions).not.toContain("add");
        expect(actions).toContain("drop");
        expect(actions).toContain("withdraw");
        expect(actions).toContain("passFail");
    });
});

// ---------------------------------------------------------------------------
// (2) Labels
// ---------------------------------------------------------------------------

describe("slotActionView — labels", () => {
    it("assigns correct human labels to each action", () => {
        const items = slotActionView(makeRegisteredMatrix());
        const byAction = Object.fromEntries(items.map((i) => [i.action, i]));
        expect(byAction["drop"]!.label).toBe("Drop");
        expect(byAction["withdraw"]!.label).toBe("Withdraw");
        expect(byAction["passFail"]!.label).toBe("Pass/Fail");
    });
});

// ---------------------------------------------------------------------------
// (3) enabled=true + tooltip=hedge when allowed and hedge is present
// ---------------------------------------------------------------------------

describe("slotActionView — enabled + hedge tooltip", () => {
    it("withdraw: enabled=true, tooltip='check the deadline'", () => {
        const items = slotActionView(makeRegisteredMatrix());
        const withdraw = items.find((i) => i.action === "withdraw")!;
        expect(withdraw.enabled).toBe(true);
        expect(withdraw.tooltip).toBe("check the deadline");
    });
});

// ---------------------------------------------------------------------------
// (4) enabled=false + tooltip=reason when forbidden
// ---------------------------------------------------------------------------

describe("slotActionView — disabled + reason tooltip", () => {
    it("passFail: enabled=false, tooltip='can't elect'", () => {
        const items = slotActionView(makeRegisteredMatrix());
        const pf = items.find((i) => i.action === "passFail")!;
        expect(pf.enabled).toBe(false);
        expect(pf.tooltip).toBe("can't elect");
    });
});

// ---------------------------------------------------------------------------
// (5) tooltip is undefined when enabled=true and hedge is absent/undefined
// ---------------------------------------------------------------------------

describe("slotActionView — enabled without hedge → no tooltip", () => {
    it("planned drop: enabled=true, hedge='removes from plan' → tooltip present", () => {
        const items = slotActionView(makePlannedMatrix());
        const drop = items.find((i) => i.action === "drop")!;
        expect(drop.enabled).toBe(true);
        // hedge is "removes from plan" → tooltip present
        expect(drop.tooltip).toBe("removes from plan");
    });

    it("when hedge is undefined, tooltip is undefined", () => {
        const matrix: SlotActionMatrix = {
            state: "registered",
            allowed: { add: false, drop: true, withdraw: false, passFail: false },
            perAction: {
                add: { reason: "already registered" },
                drop: {},       // no hedge
                withdraw: { reason: "deadline passed" },
                passFail: { reason: "deadline passed" },
            },
        } as unknown as SlotActionMatrix;
        const items = slotActionView(matrix);
        const drop = items.find((i) => i.action === "drop")!;
        expect(drop.enabled).toBe(true);
        expect(drop.tooltip).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// (6) Stable order: drop, withdraw, passFail
// ---------------------------------------------------------------------------

describe("slotActionView — stable order", () => {
    it("always returns [drop, withdraw, passFail] in that order", () => {
        const items = slotActionView(makeRegisteredMatrix());
        expect(items[0]!.action).toBe("drop");
        expect(items[1]!.action).toBe("withdraw");
        expect(items[2]!.action).toBe("passFail");
    });
});
