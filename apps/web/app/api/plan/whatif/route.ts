// ============================================================
// /api/plan/whatif — Plan 35 G3.1
// ============================================================
// Propose a current-term IP-course WHAT-IF ASSUMPTION ("I withdrew /
// I'll take pass-fail for course X"). The student claims an outcome on
// a course their REAL DPR already shows in-progress; we treat it as an
// ASSUMPTION, build a synthetic in-memory DPR, re-solve, and stage it
// for a Confirm.
//
// Body: `{ courseId: string, outcome: "withdraw" | "pass" | "fail" }`.
//
// Returns a `WhatIfAssumptionResponse` (the proposed un-persisted plan +
// a `pendingMutationId` + a `whatIfAssumption` marker the review card /
// canvas badge labels). The SAME `/api/plan/confirm` route confirms it:
// the orchestrator re-applies the transform and persists ONLY the
// resulting forward_schedule — NEVER students.parsed_dpr (R1 guardrail).
// "Confirming a plan ≠ recording a fact" — the next real DPR re-plans +
// supersedes via the normal flow (CORE RULE 15).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleProposeWhatIfRoute } from "../../../../lib/planActionRouteHelpers";

export const runtime = "nodejs";

const InputSchema = z.object({
    courseId: z.string().min(1),
    outcome: z.enum(["withdraw", "pass", "fail"]),
});
type Input = z.infer<typeof InputSchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleProposeWhatIfRoute<Input>(req, InputSchema, (input) => ({
        courseId: input.courseId,
        outcome: input.outcome,
    }));
}
