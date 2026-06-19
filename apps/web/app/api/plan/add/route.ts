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
//
// E3 (Task E3): returns 422 when the courseId is not found in the NYU
// undergraduate planning catalog. The check runs on a clone of the
// request body so the original stream is still available for the
// handleProposeRoute auth + rate-limit + parse pipeline.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleProposeRoute } from "../../../../lib/planActionRouteHelpers";
import { courseExists } from "../../../../lib/courseExists";
import type { PlanMutation } from "@nyupath/shared";

export const runtime = "nodejs";

const InputSchema = z.object({
    courseId: z.string().min(1),
    term: z.string().min(1),
});
type Input = z.infer<typeof InputSchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
    // E3 — existence check: peek at the body on a clone so the original
    // request stream is intact for handleProposeRoute's auth + rate-limit
    // + parse pipeline. If the body is unreadable or the courseId field is
    // absent we let handleProposeRoute surface the 400 as normal.
    try {
        const clone = req.clone();
        const body = await clone.json() as Record<string, unknown>;
        if (typeof body.courseId === "string" && body.courseId.length > 0) {
            if (!courseExists(body.courseId)) {
                return NextResponse.json(
                    {
                        message: `I couldn't find ${body.courseId} in the NYU course catalog — check the course number, or ask me to search by name.`,
                    },
                    { status: 422 },
                );
            }
        }
    } catch {
        // Malformed JSON — fall through; handleProposeRoute returns 400.
    }

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
