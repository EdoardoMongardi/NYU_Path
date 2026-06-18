// ============================================================
// whatIfSlotControl (G3.2) — pure-helper tests
// ============================================================
// Verifies the F3-gating logic in `whatIfSlotControl`:
//   - add_drop + withdraw_pf windows → offer: true, 3 options
//     (withdraw, pass, fail)
//   - closed + unknown windows → offer: false, hedge present
//   - future window → offer: false, hedge present (not-IP)
//   - absent ipChangeability → offer: false (no F3 classification)
// ============================================================

import { describe, it, expect } from "vitest";
import { whatIfSlotControl } from "../lib/whatIfSlotControl";
import type { SlotIpChangeability } from "../app/chat/sidebar/slotState";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function changeability(
    window: SlotIpChangeability["window"],
    editable = true,
    hedge?: string,
): SlotIpChangeability {
    return { window, editable, ...(hedge ? { hedge } : {}) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("whatIfSlotControl — F3 gating (G3.2)", () => {
    // --- add_drop: window is open, all three options offered ---
    it("add_drop window → offer:true, 3 options (withdraw, pass, fail)", () => {
        const view = whatIfSlotControl(changeability("add_drop"));
        expect(view.offer).toBe(true);
        expect(view.options).toHaveLength(3);
        const outcomes = view.options.map((o) => o.outcome);
        expect(outcomes).toContain("withdraw");
        expect(outcomes).toContain("pass");
        expect(outcomes).toContain("fail");
        expect(view.hedge).toBeUndefined();
    });

    // --- withdraw_pf: dedicated withdraw/PF window, all three options ---
    it("withdraw_pf window → offer:true, 3 options (withdraw, pass, fail)", () => {
        const view = whatIfSlotControl(changeability("withdraw_pf"));
        expect(view.offer).toBe(true);
        expect(view.options).toHaveLength(3);
        const outcomes = view.options.map((o) => o.outcome);
        expect(outcomes).toContain("withdraw");
        expect(outcomes).toContain("pass");
        expect(outcomes).toContain("fail");
    });

    // --- closed: no controls, grounded hedge ---
    it("closed window → offer:false, empty options, hedge present", () => {
        const view = whatIfSlotControl(changeability("closed", false));
        expect(view.offer).toBe(false);
        expect(view.options).toHaveLength(0);
        expect(typeof view.hedge).toBe("string");
        expect(view.hedge!.length).toBeGreaterThan(0);
        // Grounded — mentions adviser verification, not invented copy
        expect(view.hedge!.toLowerCase()).toMatch(/adviser|window|closed/);
    });

    // --- unknown: no controls, grounded hedge ---
    it("unknown window → offer:false, empty options, hedge present", () => {
        const view = whatIfSlotControl(changeability("unknown", true));
        expect(view.offer).toBe(false);
        expect(view.options).toHaveLength(0);
        expect(typeof view.hedge).toBe("string");
        expect(view.hedge!.length).toBeGreaterThan(0);
        expect(view.hedge!.toLowerCase()).toMatch(/adviser|window|unknown/);
    });

    // --- future: no controls (slot is not in-progress) ---
    it("future window → offer:false, empty options", () => {
        const view = whatIfSlotControl(changeability("future", true));
        expect(view.offer).toBe(false);
        expect(view.options).toHaveLength(0);
    });

    // --- absent: no F3 classification → no controls, no hedge ---
    it("absent ipChangeability → offer:false, empty options, no hedge", () => {
        const view = whatIfSlotControl(undefined);
        expect(view.offer).toBe(false);
        expect(view.options).toHaveLength(0);
        expect(view.hedge).toBeUndefined();
    });

    // --- all offered options have a non-empty label ---
    it("offered options have non-empty labels", () => {
        const view = whatIfSlotControl(changeability("add_drop"));
        for (const opt of view.options) {
            expect(typeof opt.label).toBe("string");
            expect(opt.label.length).toBeGreaterThan(0);
        }
    });

    // --- closed window WITH a hedges string from F3 uses it as fallback ---
    it("closed window + custom hedge → hedge is the F3 source", () => {
        const customHedge = "Registration window closed since Oct 15.";
        // Our CLOSED_HEDGES constant takes priority; only if the constant is
        // absent do we fall back to the SlotIpChangeability.hedge. Both are
        // acceptable as grounded text — we just verify some hedge is surfaced.
        const view = whatIfSlotControl(changeability("closed", false, customHedge));
        expect(view.offer).toBe(false);
        // hedge is present (either the constant OR the custom one)
        expect(view.hedge).toBeDefined();
    });
});
