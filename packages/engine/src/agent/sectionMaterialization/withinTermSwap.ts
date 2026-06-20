// ============================================================
// sectionMaterialization/withinTermSwap.ts — Phase 38 Phase B
// ============================================================
// The rung-1 WITHIN-TERM swap finder for the escalation bridge (§2④
// resolution ladder, rung 1 — "smallest change first"). When a planned
// course has no schedulable section this term, look for an alternative
// course on the SAME requirement leaf that is offered + open this term,
// so the bridge can SWAP it in-term (cheaper than a cross-term MOVE).
//
// The result feeds `generateResolutionLadder`'s `withinTermAlternatives`
// (rung 1). No swap candidate ⇒ the ladder falls through to rung 2
// (cross-term move) — the bridge stays functional without Phase B.
//
// Split for testability (mirrors A3's `makeFrozenSeamEvaluator`):
//   - `findWithinTermAlternatives` is PURE given its deps (the same-leaf
//     siblings + a live "offered+open this term" check). Unit-tested
//     with stubs.
//   - `makeLeafSiblingsResolver` is the deterministic production factory
//     that derives the same-requirement-leaf siblings from the solver's
//     constraint model (`poolMembersFor`). The live-FOSE `isOfferedAndOpen`
//     check is injected by the caller (the route/tool already owns FOSE
//     access), so this module never imports the FOSE client.
//
// No change to the solver/validator — `poolMembersFor` /
// `buildConstraintContext` are READ to derive membership only.
// ============================================================

import type { ForwardSchedule } from "@nyupath/shared";
import type { ToolSession } from "../tool.js";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import { buildSolverInputWithRulesFromSession } from "../forwardSchedule/planChangeHelpers.js";
import { buildConstraintContext, poolMembersFor } from "../forwardSchedule/constraintModel.js";

export interface WithinTermSwapDeps {
    /** Same-requirement-leaf sibling course ids for a failed course. */
    leafSiblingsFor: (failedCourseId: string) => string[];
    /** Is this course offered AND open/waitlist this term? (live FOSE — injected) */
    isOfferedAndOpen: (courseId: string, term: string) => boolean | Promise<boolean>;
}

/**
 * For each failed course, return the FIRST same-leaf sibling that is
 * offered + open this term, as a `failedCourseId → altCourseId` map
 * (the shape `generateResolutionLadder` consumes as
 * `withinTermAlternatives`). Courses with no offered+open sibling are
 * simply absent (⇒ the ladder uses a cross-term move). Pure given deps.
 */
export async function findWithinTermAlternatives(
    failedCourseIds: string[],
    term: string,
    deps: WithinTermSwapDeps,
): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const failed of failedCourseIds) {
        for (const sibling of deps.leafSiblingsFor(failed)) {
            if (sibling === failed) continue;
            if (await deps.isOfferedAndOpen(sibling, term)) {
                out[failed] = sibling;
                break;
            }
        }
    }
    return out;
}

/**
 * Production factory: derive the same-requirement-leaf siblings of a
 * course from the solver's constraint model. Builds the solver input +
 * constraint context ONCE (from the session + DPR), then resolves a
 * failed course to its requirement leaf and returns the other members
 * of that leaf (via `poolMembersFor` + the leaf's enumerated
 * candidates), excluding the failed course itself.
 *
 * Deterministic; reads the frozen constraint model, never mutates it.
 * Returns `[]` when the course belongs to no enumerable leaf (e.g. a
 * free-elective placeholder) — the caller then has no within-term swap.
 */
export function makeLeafSiblingsResolver(
    session: ToolSession,
    dpr: DegreeProgressReport,
    _currentPlan: ForwardSchedule,
): (failedCourseId: string) => string[] {
    const { solverInput } = buildSolverInputWithRulesFromSession(
        session,
        dpr,
        session.schedulePreferences ?? {},
    );
    const ctx = buildConstraintContext(solverInput);

    return (failedCourseId: string): string[] => {
        for (const req of solverInput.unmetRequirements) {
            const members = poolMembersFor(req, ctx);
            const inLeaf =
                members.includes(failedCourseId) || req.candidateCourses.includes(failedCourseId);
            if (!inLeaf) continue;
            const siblings = new Set<string>([...members, ...req.candidateCourses]);
            siblings.delete(failedCourseId);
            return [...siblings];
        }
        return [];
    };
}
