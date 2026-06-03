// ============================================================
// /api/plan/add — Phase 17 Task B
// ============================================================
// Sidebar verb: "Add" — place a new course in a chosen term.
//
// Constructs `[{kind: "pin", courseId, term, freeze: true}]`. The
// freeze: true semantic encodes that a student dragging a course to
// a specific term IS expressing a preference; the placement is
// sticky until they explicitly Unlock (the Lock verb's locked:false
// path). See PHASE_17_PLAN.md Task B critical-context note.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleProposeRoute } from "../../../../lib/planActionRouteHelpers";
import type { PlanMutation } from "@nyupath/shared";

export const runtime = "nodejs";

const InputSchema = z.object({
    courseId: z.string().min(1),
    term: z.string().min(1),
});
type Input = z.infer<typeof InputSchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleProposeRoute<Input>(req, InputSchema, (input) => {
        const m: PlanMutation = {
            kind: "pin",
            courseId: input.courseId,
            term: input.term,
            freeze: true,
        };
        return [m];
    });
}
