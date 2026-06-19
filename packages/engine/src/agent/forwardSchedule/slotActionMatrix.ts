// ============================================================
// slotActionMatrix.ts — D1 (plan 37 slot-editor)
// ============================================================
// A PURE function that decides which of {add, drop, withdraw, passFail} a
// slot allows, based on the 3-state model (D-1) × the F3 window classifier
// × the school's P/F policy.
//
// The 3-state → kind mapping (D-1):
//   FINAL      = slot.kind === "completed"       — graded, immutable.
//   REGISTERED = slot.kind === "in_progress"     — IP, window-gated by F3.
//   PLANNED    = slot.kind === "specific_planned" | "placeholder" — not on DPR.
//
// The action matrix per state (D-2):
//
//   FINAL → ALL actions forbidden (immutable).
//
//   REGISTERED → window-gated by classifyIpChangeability (5-valued):
//     future | add_drop    → drop allowed (pre add/drop, no W yet)
//     withdraw_pf | unknown → drop + withdraw allowed (drop IS a withdraw)
//     closed               → nothing allowed (deadline passed)
//     withdraw + passFail  → also gated on passFail?.canElect !== false
//     add                  → always false (add is term-level, not per-slot)
//     perAction carries ip.hedge when allowed; a reason when forbidden.
//
//   PLANNED → drop: true (just removes from plan), everything else false.
//
// This function is PURE (no I/O, no mutations). Inject `now` in tests.
// ============================================================

import type { ScheduleSlot, PassFailConfig } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import {
    classifyIpChangeability,
    type IpChangeabilityResult,
} from "../../dpr/ipCourseChangeability.js";
import type { Campus, AcademicCalendar } from "../../dpr/academicCalendar.js";
import { deriveTemporalContext } from "../../dpr/temporalContext.js";

// ---- Public types ----

export interface SlotActionMatrixArgs {
    slot: ScheduleSlot;
    /** The term this slot lives in, in any recognized shape ("2026-fall",
     *  "2026 Fall", "Fall 2026"). */
    term: string;
    /** The student's DPR — used to derive the temporal context (current vs.
     *  future vs. past term) for IP slots. */
    dpr: DegreeProgressReport;
    /** The campus whose registration windows govern this course. */
    campus: Campus;
    /** The academic-calendar config. Inject a fixture in tests. */
    calendar: AcademicCalendar;
    /** The school's P/F policy. When absent, canElect is treated as unknown
     *  (not explicitly false) — passFail is allowed in the withdraw window. */
    passFail?: PassFailConfig;
    /** "Today" — defaults to new Date(). Injected in tests for determinism. */
    now?: Date;
}

export type SlotAction = "add" | "drop" | "withdraw" | "passFail";

export interface SlotActionDecision {
    /** A human-facing reason WHY the action is forbidden. Present when the
     *  action is NOT allowed. */
    reason?: string;
    /** A "verify with your adviser" hedge surfaced when the action IS allowed
     *  but is window-gated (the date is a typical NYU deadline, not exact).
     *  Present when the action is allowed and carries uncertainty. */
    hedge?: string;
}

export interface SlotActionMatrix {
    /** The 3-state classification of this slot. */
    state: "final" | "registered" | "planned";
    /** Whether each action is currently permitted. */
    allowed: Record<SlotAction, boolean>;
    /** Per-action human-facing context (reason or hedge). */
    perAction: Record<SlotAction, SlotActionDecision>;
}

// ---- Implementation ----

export function slotActionMatrix(args: SlotActionMatrixArgs): SlotActionMatrix {
    const { slot, term, dpr, campus, calendar, passFail, now } = args;

    // -----------------------------------------------------------------------
    // FINAL — completed (graded, immutable). All actions forbidden.
    // -----------------------------------------------------------------------
    if (slot.kind === "completed") {
        return {
            state: "final",
            allowed: { add: false, drop: false, withdraw: false, passFail: false },
            perAction: {
                add: { reason: "This course is finished and graded — it can't be changed." },
                drop: { reason: "This course is finished and graded — it can't be removed from your record." },
                withdraw: { reason: "This course is finished and graded — the withdrawal window has closed." },
                passFail: { reason: "This course is finished and graded — pass/fail election is no longer available." },
            },
        };
    }

    // -----------------------------------------------------------------------
    // REGISTERED — in_progress (IP), window-gated by the F3 classifier.
    // -----------------------------------------------------------------------
    if (slot.kind === "in_progress") {
        const temporalContext = deriveTemporalContext(dpr, { now });
        const ip: IpChangeabilityResult = classifyIpChangeability({
            ipTerm: term,
            temporalContext,
            campus,
            calendar,
            now,
        });

        // Window shorthand flags.
        const inAddDrop   = ip.window === "add_drop"    || ip.window === "future";
        const inWithdrawPf = ip.window === "withdraw_pf" || ip.window === "unknown" || ip.window === "future";
        // After add/drop, "drop" IS a withdraw (it earns a W). We allow drop in
        // BOTH the add_drop and the withdraw_pf window.
        const dropAllowed      = inAddDrop || inWithdrawPf;
        const withdrawAllowed  = inWithdrawPf;
        // passFail: allowed in the withdraw window AND the school's policy doesn't
        // explicitly forbid election. When canElect is undefined we don't block.
        const canElect    = passFail?.canElect !== false;
        const pfAllowed   = inWithdrawPf && canElect;

        // Per-action decisions (reason when forbidden; hedge when allowed-but-gated).
        const addDecision: SlotActionDecision = {
            reason: "This course is already on your registration — use the chat to add a DIFFERENT course.",
        };

        const dropDecision: SlotActionDecision = dropAllowed
            ? { hedge: ip.hedge }
            : { reason: "The add/drop and withdrawal deadlines have passed for this term (typical — verify with your registrar)." };

        const withdrawDecision: SlotActionDecision = ip.window === "closed"
            ? { reason: "The withdrawal deadline has passed for this term (typical — verify with your registrar)." }
            : withdrawAllowed
                ? { hedge: ip.hedge }
                : { reason: "The withdrawal deadline has passed for this term (typical — verify with your registrar)." };

        let pfDecision: SlotActionDecision;
        if (!canElect) {
            pfDecision = { reason: "Your school doesn't let you elect pass/fail — only courses already graded pass/fail count." };
        } else if (ip.window === "closed") {
            pfDecision = { reason: "The pass/fail election deadline has passed for this term (typical — verify with your registrar)." };
        } else if (pfAllowed) {
            pfDecision = { hedge: ip.hedge };
        } else {
            pfDecision = { reason: "The pass/fail election deadline has passed for this term (typical — verify with your registrar)." };
        }

        return {
            state: "registered",
            allowed: { add: false, drop: dropAllowed, withdraw: withdrawAllowed, passFail: pfAllowed },
            perAction: {
                add: addDecision,
                drop: dropDecision,
                withdraw: withdrawDecision,
                passFail: pfDecision,
            },
        };
    }

    // -----------------------------------------------------------------------
    // PLANNED — specific_planned or placeholder (not yet on the DPR).
    // Drop = just remove from plan. Withdraw / passFail / add = not applicable.
    // -----------------------------------------------------------------------
    return {
        state: "planned",
        allowed: { add: false, drop: true, withdraw: false, passFail: false },
        perAction: {
            add: { reason: "Use “add a course” on the term to add a new course." },
            drop: { hedge: "This is a planned course — dropping it just removes it from your plan." },
            withdraw: { reason: "There’s nothing to withdraw from yet — this course is only planned. Drop it instead." },
            passFail: { reason: "You can only elect pass/fail once a course is in progress." },
        },
    };
}
