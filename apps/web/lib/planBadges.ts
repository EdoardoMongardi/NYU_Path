// ============================================================
// planBadges — Phase 4 Task E2.1 (plan-level badge row)
// ============================================================
// Pure, framework-agnostic helper that derives the four plan-level
// badges (validity · confidence · graduation term · trade-off count)
// from a live `ForwardSchedule` (+ the latest plan-action diff's
// consequences). apps/web ships no DOM render harness, so ALL badge
// logic lives here and is unit-tested directly in node
// (apps/web/tests/planBadges.test.ts); the `PlanBadges` React
// component in scheduleSidebar.tsx is a thin consumer that calls
// `computePlanBadges` and renders the returned object.
//
// NO-INVENTION GUARD (philosophy #3 / §11 — binding):
//   There is NO structured "CAS-approximated" / confidence field on
//   `ForwardSchedule`. The D4.4 hedge lives in the AGENT'S narration,
//   not on the plan object. So the confidence badge DERIVES its hedge
//   from real engine-produced plan fields only:
//     - optimality === "best-effort" | "feasibility-unconfirmed"
//       (types.ts:1108 — its own doc-comment says "surface a confidence
//       caveat"), OR
//     - a non-empty assumptions[], OR
//     - a non-final (invalid-draft) state.
//   When any of those hold the confidence label MUST carry a
//   "verify with your adviser" hedge. The badge NEVER computes a new
//   number and NEVER fabricates a CAS-coupling claim.
// ============================================================

import type { ForwardSchedule, PlanState } from "@nyupath/shared";
import { formatTermLabel } from "../app/chat/shared/sidebarFormatters";

export interface PlanBadgeData {
    /** ✓ for valid-clean / valid-with-trade-offs; clearly-marked
     *  invalid for the two draft states. */
    validity: { valid: boolean; label: string; state: PlanState };
    /** hedged → the label includes a "verify with your adviser" phrase.
     *  Derived ONLY from real engine fields (see NO-INVENTION GUARD). */
    confidence: { hedged: boolean; label: string };
    /** Human term label, e.g. "Spring 2027". Unrecognized shapes pass
     *  through verbatim (no invention). */
    graduationTerm: string;
    /** consequences?.length ?? 0 — 0 at rest (no pending diff). */
    tradeOffCount: number;
}

const VERIFY_HEDGE = "verify with your adviser";

/** The two VALID plan states (validity ✓). The two draft states are
 *  clearly-marked invalid. */
function isValidState(state: PlanState): boolean {
    return state === "valid-clean" || state === "valid-with-trade-offs";
}

/**
 * Derive the four plan-level badges from a live `ForwardSchedule`.
 *
 * @param schedule     the live forward schedule (single source of truth).
 * @param consequences the latest plan-action diff's `consequences: string[]`
 *                     (NOT a field on ForwardSchedule — passed by the
 *                     component). Omit at rest → trade-off count 0.
 */
export function computePlanBadges(
    schedule: ForwardSchedule,
    consequences?: string[],
): PlanBadgeData {
    const state = schedule.state;
    const valid = isValidState(state);

    // ---- validity ----------------------------------------------------
    const validity = {
        valid,
        // Invalid drafts get a clearly-marked label; valid plans a ✓.
        label: valid ? "✓ Valid" : "✗ Invalid draft",
        state,
    };

    // ---- confidence (binding §11 — derive, never invent) -------------
    // hedged when the plan carries ANY non-~99%-grounded marker:
    //   best-effort / feasibility-unconfirmed optimality, a populated
    //   assumptions[], or an invalid-draft state.
    const optimality = schedule.optimality; // undefined == "optimal" (back-compat)
    const hedged =
        optimality === "best-effort" ||
        optimality === "feasibility-unconfirmed" ||
        schedule.assumptions.length > 0 ||
        state === "infeasible-draft" ||
        state === "student-preferred-invalid-draft";

    const confidence = {
        hedged,
        label: hedged
            ? `Confidence: hedged — ${VERIFY_HEDGE}`
            : "✓ Grounded",
    };

    // ---- graduation term ---------------------------------------------
    // Reuse the sidebar's deterministic formatter; unrecognized shapes
    // pass through verbatim.
    const graduationTerm = formatTermLabel(schedule.graduationTerm);

    // ---- trade-off count ---------------------------------------------
    const tradeOffCount = consequences?.length ?? 0;

    return { validity, confidence, graduationTerm, tradeOffCount };
}
