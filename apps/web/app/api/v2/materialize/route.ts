// ============================================================
// /api/v2/materialize — Phase 38 Task E1 (READ-ONLY)
// ============================================================
// Wraps the deterministic `materialize_feasible` engine: given a target
// term, return the VERIFIED feasible section-schedule candidate set
// (the Phase-0.3 UI-complete schema) + `unavailableCourses` + cite-or-
// hedge notes. This is the data contract the (deferred) top-5 picker
// will render against — no rework when that UI lands.
//
// Body: `{ targetTerm: string }` (solver format, e.g. "2026-fall").
//
// READ-ONLY: this route NEVER mutates state — in particular it NEVER
// writes `students.parsed_dpr` (R1 guardrail). It only reads the
// session + runs a read-only engine. Confirming a chosen section
// combination remains a separate write via the existing
// `confirm_section_combination` path.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleMaterializeRoute } from "../../../../lib/planActionRouteHelpers";

export const runtime = "nodejs";

const InputSchema = z.object({
    targetTerm: z.string().min(1),
});
type Input = z.infer<typeof InputSchema>;

export async function POST(req: NextRequest): Promise<NextResponse> {
    return handleMaterializeRoute<Input>(req, InputSchema);
}
