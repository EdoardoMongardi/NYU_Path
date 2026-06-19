// ============================================================
// buildWhatIfScenarioFromAudit.ts — H4.2b-3
// ============================================================
// Pure helper: turn a successful /api/whatif-audit response (a parsed
// Albert What-If audit) into a READ-ONLY 🔍 what-if Scenario for the
// scenarios workspace.
//
// READ-ONLY by construction — the returned Scenario has NO
// `pendingMutationId`, so the workspace shows Keep / Discard, NEVER
// Confirm. This is the Branch-A (program-change) exploration: it can be
// inspected and compared, but never committed. To make it real the
// student must declare it in Albert and upload a corrected DPR.
//
// PURE — no React, no I/O, no module-level state.
// Unit-tested by apps/web/tests/buildWhatIfScenarioFromAudit.test.ts.
//
// R1: nothing here touches /api/plan/confirm or `parsed_dpr`. The
// absence of `pendingMutationId` is the structural guarantee that this
// scenario can never be committed.
// ============================================================

import type { ForwardSchedule, PlanState } from "@nyupath/shared";
import type { Scenario } from "./planState";

// ---------------------------------------------------------------------------
// Local structural type for the route response.
//
// The interface lives in apps/web/app/api/whatif-audit/route.ts, but that
// module imports server-only code (PDF extraction, the DPR parser, the
// engine plan tool). Importing it into this CLIENT module would pull all
// of that in. We declare a matching structural type here instead — it is
// kept in sync with `WhatIfAuditResponse` in the route by the route's
// own typecheck (the route still exports the canonical interface; this is
// purely the client-side view of the JSON it returns).
// ---------------------------------------------------------------------------

export interface WhatIfAuditResponse {
    exploration: {
        /** The hypothetical forward plan computed against the what-if DPR. */
        schedule: ForwardSchedule;
        /** Human-readable solver summary. */
        summary: string;
        /** The hypothetical program name(s) derived from the what-if report. */
        hypotheticalProgram: string;
    };
    /** Canvas/chat banner — always flags this as hypothetical, never committed. */
    label: string;
    /** The single next step to make this real. */
    cta: string;
}

// ---------------------------------------------------------------------------
// VERDICT MAPPING — ForwardSchedule.state (PlanState) → workspace verdict.
//   "valid-clean"                     => "valid"
//   "valid-with-trade-offs"           => "trade-offs"
//   "infeasible-draft"                => "invalid"
//   "student-preferred-invalid-draft" => "invalid"
// ---------------------------------------------------------------------------

/**
 * Map a `ForwardSchedule.state` (the 4-state `PlanState` union) to the
 * 3-value workspace verdict the Scenario / ScheduleCard render with.
 */
export function mapStateToVerdict(
    state: PlanState,
): "valid" | "trade-offs" | "invalid" {
    switch (state) {
        case "valid-clean":
            return "valid";
        case "valid-with-trade-offs":
            return "trade-offs";
        case "infeasible-draft":
        case "student-preferred-invalid-draft":
            return "invalid";
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a READ-ONLY 🔍 what-if Scenario from a /api/whatif-audit response.
 *
 * @param resp  The successful route response (parsed Albert What-If audit).
 * @param id    Unique scenario id (caller supplies).
 * @param now   Creation timestamp in epoch ms (caller supplies for testability).
 *
 * CRUCIALLY returns NO `pendingMutationId` — the read-only guarantee. The
 * workspace renders Keep / Discard for `kind:"whatif"`, never Confirm.
 */
export function buildWhatIfScenarioFromAudit(
    resp: WhatIfAuditResponse,
    id: string,
    now: number,
): Scenario {
    return {
        id,
        kind: "whatif",
        // Prefer the derived hypothetical-program label; fall back to the
        // route's banner label when no program was extracted.
        label: resp.exploration.hypotheticalProgram || resp.label,
        schedule: resp.exploration.schedule,
        verdict: mapStateToVerdict(resp.exploration.schedule.state),
        rederive: { via: "audit_upload" },
        // The single next step to make this real, surfaced as a hedge.
        hedges: [resp.cta],
        createdAt: now,
        // NO pendingMutationId — see JSDoc. Read-only ⇒ not confirmable.
    };
}
