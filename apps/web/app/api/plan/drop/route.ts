// ============================================================
// /api/plan/drop — Phase 17 Task B
// ============================================================
// Sidebar verb: "Drop" — exclude a course from the plan, optionally
// scoped to a single term.
//
// Body: `{courseId: string, term?: string}`. Term-less drop excludes
// the course globally (engine: SchedulePreferences.exclusions[] with
// term: undefined). Term-scoped drop excludes only in that term.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleProposeRoute } from "../../../../lib/planActionRouteHelpers";
import type { PlanMutation } from "@nyupath/shared";

export const runtime = "nodejs";

const InputSchema = z.object({
    courseId: z.string().min(1),
    term: z.string().min(1).optional(),
});
type Input = z.infer<typeof InputSchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleProposeRoute<Input>(req, InputSchema, (input) => {
        const m: PlanMutation = input.term
            ? { kind: "exclude", courseId: input.courseId, term: input.term }
            : { kind: "exclude", courseId: input.courseId };
        return [m];
    });
}
