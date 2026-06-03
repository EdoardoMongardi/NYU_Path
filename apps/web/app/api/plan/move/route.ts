// ============================================================
// /api/plan/move — Phase 17 Task B
// ============================================================
// Sidebar verb: "Move" — atomic drag-to-move a course from one term
// to another.
//
// Constructs a 2-mutation batch:
//   `[{kind: "move", courseId, fromTerm, toTerm},
//     {kind: "pin",  courseId, term: toTerm, freeze: true}]`
//
// Why two mutations? The helper-level `move` primitive (Task A) only
// writes the fromTerm exclusion to SchedulePreferences.exclusions[].
// Because the solver's exclusion set is term-AGNOSTIC
// (solver.ts:854), that exclusion blocks the course globally — it
// does NOT land the course in toTerm. The follow-up `pin
// freeze: true` writes the toTerm placement to
// SchedulePreferences.pins[] so the solver re-plan actually
// relocates the course (not just drops it).
//
// This is the load-bearing fix the Task A spec reviewer flagged.
// planMoveRoute.test.ts asserts the course actually lands in
// `forwardSchedule.semesters[<toTerm>].slots` after the route
// returns.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleProposeRoute } from "../../../../lib/planActionRouteHelpers";
import type { PlanMutation } from "@nyupath/shared";

export const runtime = "nodejs";

const InputSchema = z.object({
    courseId: z.string().min(1),
    fromTerm: z.string().min(1),
    toTerm: z.string().min(1),
});
type Input = z.infer<typeof InputSchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleProposeRoute<Input>(req, InputSchema, (input) => {
        if (input.fromTerm === input.toTerm) {
            // No-op gesture; the route returns 400 (handled upstream)
            // so the UI can surface a "you dropped the course back on
            // its current term" hint without burning the engine cycle.
            return [];
        }
        const move: PlanMutation = {
            kind: "move",
            courseId: input.courseId,
            fromTerm: input.fromTerm,
            toTerm: input.toTerm,
        };
        const pin: PlanMutation = {
            kind: "pin",
            courseId: input.courseId,
            term: input.toTerm,
            freeze: true,
        };
        return [move, pin];
    });
}
