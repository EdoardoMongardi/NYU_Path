// ============================================================
// whatIfSlotControl — G3.2 pure helper
// ============================================================
// Computes whether the slot popover should offer what-if controls
// ("Assume: withdraw" / "Assume: pass-fail (pass/fail)") for a
// current-term in-progress (IP) course, and what exactly to offer.
//
// F3 GATE: the control is ONLY offered when the IP course's
// registration window is editable (`add_drop` or `withdraw_pf`).
// When the window is `closed` or `unknown`, the control is NOT
// shown; the hedge text is exposed instead so the UI can display it
// in the popover as a grounded, non-actionable explanation.
//
// "future" is NOT offered either: a future-term slot is NOT
// in-progress, so it has a planned kind — this helper is only
// ever called for in_progress slots.
//
// This module is PURE TypeScript with NO React/JSX import so it is
// fully unit-testable in the `node` vitest environment (no jsdom).
// The SlotPopover is the thin React consumer.
// ============================================================

import type { SlotIpChangeability } from "../app/chat/sidebar/slotState";

/** An actionable what-if option the popover offers. */
export interface WhatIfOption {
    /** The payload sent to /api/plan/whatif. */
    outcome: "withdraw" | "pass" | "fail";
    /** Human-readable button label. */
    label: string;
}

/** The view returned by `whatIfSlotControl`. */
export interface WhatIfSlotControlView {
    /** Whether the popover should offer what-if controls. */
    offer: boolean;
    /** The options to offer when `offer` is true. Empty when `offer` is false. */
    options: WhatIfOption[];
    /** When `offer` is false, a grounded hedge the popover can display instead
     *  (sourced from the engine's ipChangeability window). When `offer` is
     *  true this is absent (the controls are the affordance, not a hedge). */
    hedge?: string;
}

/** Map from window to the hedge text to show when the control is suppressed.
 *  These mirror the IP_WINDOW_LABELS aria strings in slotState.ts — concise,
 *  grounded, non-invented. */
const CLOSED_HEDGES: Partial<Record<SlotIpChangeability["window"], string>> = {
    closed: "Change windows are closed for this term — verify with your adviser.",
    unknown: "The registrar change window for this term is unknown — verify with your adviser.",
    future: "This course is planned for a future term, not in progress.",
};

/** The what-if options that are always available when the window is open. */
const WITHDRAW_OPTION: WhatIfOption = {
    outcome: "withdraw",
    label: "Assume: withdraw (W — GPA-neutral)",
};
const PF_PASS_OPTION: WhatIfOption = {
    outcome: "pass",
    label: "Assume: pass-fail (elect PASS)",
};
const PF_FAIL_OPTION: WhatIfOption = {
    outcome: "fail",
    label: "Assume: pass-fail (elect FAIL)",
};

/**
 * Compute what what-if controls (if any) the slot popover should offer for a
 * current-term in-progress course.
 *
 * F3-GATING LOGIC (binding):
 *   - `add_drop`:   Offer withdraw + pass/fail (both verbs are available in
 *                   the add/drop window — you can still drop or P/F-elect).
 *   - `withdraw_pf`: Offer withdraw + pass/fail (the dedicated withdraw/P-F
 *                    window is exactly for these two).
 *   - `closed`:     No controls — display the grounded "windows closed" hedge.
 *   - `unknown`:    No controls — display the grounded "unknown window" hedge.
 *   - `future`:     No controls — the slot is not in-progress; hedge is present
 *                   so the caller can guard against calling with a non-IP slot.
 *   - absent:       No controls — no F3 classification available; suppress
 *                   rather than guess.
 *
 * @param ipChangeability The F3 window classification for the slot's term.
 *                        When absent (undefined), no controls are offered.
 */
export function whatIfSlotControl(
    ipChangeability: SlotIpChangeability | undefined,
): WhatIfSlotControlView {
    if (!ipChangeability) {
        // No F3 classification → no what-if control (cannot ground the offer).
        return { offer: false, options: [] };
    }

    const { window, hedge } = ipChangeability;

    if (window === "add_drop" || window === "withdraw_pf") {
        // The window is open — offer both withdraw and pass/fail options.
        return {
            offer: true,
            options: [WITHDRAW_OPTION, PF_PASS_OPTION, PF_FAIL_OPTION],
        };
    }

    // Window is closed, unknown, or future → suppress controls; surface hedge.
    const fallbackHedge = CLOSED_HEDGES[window] ?? hedge;
    return {
        offer: false,
        options: [],
        ...(fallbackHedge ? { hedge: fallbackHedge } : {}),
    };
}
