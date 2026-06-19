// ============================================================
// /api/plan/confirm — Phase 17 Task B (+ Task D retired by M1/M2)
// ============================================================
// Applies a previously-staged plan mutation by `pendingMutationId`.
//
// The 5 propose routes (add/swap/drop/lock/move) each mint a
// `pendingMutationId` and stash the underlying PlanMutation[] in the
// orchestrator's in-memory staging map. The UI surfaces the
// confirm-bubble; on click → POST `/api/plan/confirm` with the same
// id → the orchestrator looks up the mutations and applies them via
// `confirmPlanChangeTool.call({mutations})`.
//
// Single-use: a confirmed id is dropped from the staging map.
// Expired (10 min TTL) ids return 404; cross-tenant ids return 403.
//
// M1 (plan 37) — an infeasible re-solve is REFUSED with 422.
// An invalid plan is NEVER committed. The `force` param (below) is
// INERT / DEPRECATED — it was the Phase 17 Task D "Override anyway"
// affordance. M2 removed the UI and agent affordances so no call
// site passes force:true anymore; the server ignores it either way
// (422 is returned regardless of force when the re-solve is infeasible).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleConfirmRoute } from "../../../../lib/planActionRouteHelpers";

export const runtime = "nodejs";

const InputSchema = z.object({
    pendingMutationId: z.string().uuid(),
    /** DEPRECATED / INERT (M1 plan 37). The "Override anyway" affordance
     *  has been retired. This field is accepted for back-compat but is
     *  ignored: an infeasible re-solve returns 422 regardless of whether
     *  force is true or omitted. No UI path passes force:true after M2. */
    force: z.boolean().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleConfirmRoute(req, InputSchema);
}
