// ============================================================
// /api/plan/confirm — Phase 17 Task B
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
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleConfirmRoute } from "../../../../lib/planActionRouteHelpers";

export const runtime = "nodejs";

const InputSchema = z.object({
    pendingMutationId: z.string().uuid(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleConfirmRoute(req, InputSchema);
}
