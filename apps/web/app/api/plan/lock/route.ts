// ============================================================
// /api/plan/lock — Phase 17 Task B
// ============================================================
// Sidebar verb: "Lock" — toggle solver-freeze on a slot.
//
// Body: `{courseId, term, locked: boolean}`.
//   - locked: true  → `[{kind: "pin", courseId, term, freeze: true}]`
//     Writes to SchedulePreferences.pins[]; the solver respects this
//     on every future re-plan.
//   - locked: false → `[{kind: "unpin", courseId, term}]`
//     Removes the matching entry from SchedulePreferences.pins[]; the
//     slot becomes solver-eligible for re-placement on the next
//     re-plan. The `unpin` primitive is new in Task B (~10 LOC engine
//     extension; mirrors `move`'s pattern from Task A).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleProposeRoute } from "../../../../lib/planActionRouteHelpers";
import type { PlanMutation } from "@nyupath/shared";

export const runtime = "nodejs";

const InputSchema = z.object({
    courseId: z.string().min(1),
    term: z.string().min(1),
    locked: z.boolean(),
});
type Input = z.infer<typeof InputSchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleProposeRoute<Input>(req, InputSchema, (input) => {
        if (input.locked) {
            const m: PlanMutation = {
                kind: "pin",
                courseId: input.courseId,
                term: input.term,
                freeze: true,
            };
            return [m];
        }
        const m: PlanMutation = {
            kind: "unpin",
            courseId: input.courseId,
            term: input.term,
        };
        return [m];
    });
}
