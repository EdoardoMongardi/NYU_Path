// ============================================================
// /api/plan/confirm — Phase 17 Task B + Task D
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
// Phase 17 Task D — optional `force: true` flag for the
// "Override anyway" affordance. The engine path is unchanged — an
// apply that lands in `studentDraftPlan` keeps its `infeasible-draft`
// state. The route-layer post-processor reclassifies the persisted
// plan to `student-preferred-invalid-draft` when `force=true` was set
// AND the engine returned `feasible: false`. That keeps the engine
// scope unchanged (no new tool argument, no new semantic) while
// surfacing the student's "I know it's invalid, do it anyway"
// intent through the Decision #32 4-state PlanState union.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleConfirmRoute } from "../../../../lib/planActionRouteHelpers";

export const runtime = "nodejs";

const InputSchema = z.object({
    pendingMutationId: z.string().uuid(),
    /** Phase 17 Task D — when `true`, an infeasible apply lands as
     *  `student-preferred-invalid-draft` rather than `infeasible-draft`
     *  (Decision #32). When `false` or omitted, behaves identically to
     *  the Phase 17 Task B route. The engine path is unchanged; this
     *  is a route-layer reclassification of `state`. */
    force: z.boolean().optional(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleConfirmRoute(req, InputSchema);
}
