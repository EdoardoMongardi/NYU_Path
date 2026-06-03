// ============================================================
// /api/plan/swap — Phase 17 Task B
// ============================================================
// Sidebar verb: "Swap" — replace X with Y in the same term, OR
// cross-term exchange (drag-A-onto-B gesture).
//
// Body shape is discriminated on the presence of `exchanges`:
//   - Single-term swap: `{drop, add, term}` →
//       `[{kind: "swap", drop, add, term}]`
//   - Cross-term exchange: `{exchanges: [{aCourseId, aTerm, bCourseId, bTerm}, ...]}` →
//       `[{kind: "swap", drop: aCourseId, add: bCourseId, term: aTerm},
//         {kind: "swap", drop: bCourseId, add: aCourseId, term: bTerm}, ...]`
//
// The 2-mutation cross-term batch leverages Phase 14's atomic
// multi-mutation apply (no transient duplicate-state false-rejection).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleProposeRoute } from "../../../../lib/planActionRouteHelpers";
import type { PlanMutation } from "@nyupath/shared";

export const runtime = "nodejs";

// May 2026 review: tighten the discriminator. The two schemas are
// non-overlapping (single-term has `drop`+`add`+`term`; cross-term has
// `exchanges`), but a body containing BOTH would silently match the
// single-term branch (zod strips unknown keys before union resolution).
// `.strict()` on each schema rejects extra keys so the union truly
// fails on a mixed body.
const SingleTermSwapSchema = z.object({
    drop: z.string().min(1),
    add: z.string().min(1),
    term: z.string().min(1),
}).strict();

const CrossTermExchangeSchema = z.object({
    exchanges: z.array(z.object({
        aCourseId: z.string().min(1),
        aTerm: z.string().min(1),
        bCourseId: z.string().min(1),
        bTerm: z.string().min(1),
    })).min(1),
}).strict();

const InputSchema = z.union([SingleTermSwapSchema, CrossTermExchangeSchema]);
type Input = z.infer<typeof InputSchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleProposeRoute<Input>(req, InputSchema, (input) => {
        if ("exchanges" in input) {
            const out: PlanMutation[] = [];
            for (const ex of input.exchanges) {
                out.push({ kind: "swap", drop: ex.aCourseId, add: ex.bCourseId, term: ex.aTerm });
                out.push({ kind: "swap", drop: ex.bCourseId, add: ex.aCourseId, term: ex.bTerm });
            }
            return out;
        }
        return [{ kind: "swap", drop: input.drop, add: input.add, term: input.term }];
    });
}
