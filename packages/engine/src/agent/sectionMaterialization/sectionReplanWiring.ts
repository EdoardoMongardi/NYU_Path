// ============================================================
// sectionMaterialization/sectionReplanWiring.ts — Phase 38 E3/E4
// ============================================================
// PRODUCTION wiring for the §2⑤ bounded outer loop: builds the
// `SectionReplanLoopDeps` (materialize + escalate) from a live session
// by composing the already-tested deterministic pieces —
// `materializeFeasible` (the candidate engine), the bridge
// (`classifySectionFailure` is in the loop; `generateResolutionLadder`
// + `validateResolutionCandidates` here), the within-term swap finder,
// and the frozen propose-path evaluator (`makeFrozenSeamEvaluator`).
//
// Kept SEPARATE from `sectionReplanBridge.ts` so that file's A1–A4 +
// the loop stay pure/DI; this is the one place that reaches FOSE
// (`searchCourses`) + the orchestrator. The frozen solver/validator is
// only CALLED (via `makeFrozenSeamEvaluator`), never modified.
// ============================================================

import type { ForwardSchedule } from "@nyupath/shared";
import type { ToolSession } from "../tool.js";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import { searchCourses as defaultSearchCourses } from "../../api/nyuClassSearch.js";
import { materializeFeasible } from "./materializeFeasible.js";
import {
    generateResolutionLadder,
    validateResolutionCandidates,
    makeFrozenSeamEvaluator,
    type SectionReplanLoopDeps,
} from "./sectionReplanBridge.js";
import { findWithinTermAlternatives, makeLeafSiblingsResolver } from "./withinTermSwap.js";
import { isAvailableStatus } from "./statusHelpers.js";

type SearchFn = (termCode: string, keyword: string) => Promise<unknown[]>;

interface WiringOptions {
    /** Test injection — defaults to the live FOSE `searchCourses`. */
    searchFn?: SearchFn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cache?: any;
}

/** First non-locked semester of a plan — the "near term" we section-check. */
function nearSemesterOf(plan: ForwardSchedule) {
    return plan.semesters.find((s) => !s.locked);
}

/**
 * Live "offered + usable this term" check (rung-1 within-term swap candidates).
 * Uses `isAvailableStatus` (O | W | A) — NOT a bare O||W — because the public
 * FOSE API returns `stat:"A"` for every live section (seat status unknown); a
 * bare O/W check would reject every live sibling and silently kill rung-1.
 * Exported for direct unit testing against all-"A" rows.
 */
export function makeFoseOpenCheck(searchFn: SearchFn): (courseId: string, term: string) => Promise<boolean> {
    return async (courseId, term) => {
        try {
            const rows = (await searchFn(term, courseId)) as Array<{ code?: string; stat?: string }>;
            return rows.some((r) => r.code === courseId && isAvailableStatus(r.stat ?? ""));
        } catch {
            return false;
        }
    };
}

/**
 * Build the production `SectionReplanLoopDeps` for `runSectionReplanLoop`.
 * `materialize` re-materializes a plan's near term; `escalate` runs the
 * full ladder (within-term swap → cross-term move → bounded multi-course)
 * and validates every batch through the frozen seam. Both rebuild their
 * plan-bound helpers per call so the outer loop's re-materialized plan is
 * always the one being evaluated.
 */
export function buildSectionReplanLoopDeps(
    session: ToolSession,
    dpr: DegreeProgressReport,
    opts: WiringOptions = {},
): SectionReplanLoopDeps {
    const searchFn = opts.searchFn ?? (defaultSearchCourses as SearchFn);
    const isOfferedAndOpen = makeFoseOpenCheck(searchFn);
    const schedulingPreferences = session.schedulePreferences?.schedulingPreferences;

    return {
        materialize: async (plan) => {
            const near = nearSemesterOf(plan);
            // No non-locked term, or no concrete courses there → nothing to
            // section-check ⇒ NOT a failure (don't escalate on absence), but
            // `checked:false` since no live schedulability was verified.
            if (!near) return { candidateCount: 1, unavailableCourses: [], nearTerm: plan.graduationTerm, checked: false };
            const courseIds = near.slots
                .filter((s): s is Extract<typeof s, { kind: "specific_planned" }> => s.kind === "specific_planned")
                .map((s) => s.courseId);
            if (courseIds.length === 0) {
                return { candidateCount: 1, unavailableCourses: [], nearTerm: near.term, checked: false };
            }
            const r = await materializeFeasible({
                termCode: near.term,
                courseIds,
                ...(schedulingPreferences ? { schedulingPreferences } : {}),
                ...(opts.searchFn ? { searchFn: opts.searchFn } : {}),
                ...(opts.cache ? { cache: opts.cache } : {}),
            });
            // Only a "full" verdict carries real feasibility signal. unavailable/
            // partial = no live FOSE data ⇒ can't check ⇒ not a failure (and
            // checked:false so the agent hedges instead of over-claiming).
            if (r.state !== "full") {
                return { candidateCount: 1, unavailableCourses: [], nearTerm: near.term, checked: false };
            }
            return { candidateCount: r.candidates.length, unavailableCourses: r.unavailableCourses, nearTerm: near.term, checked: true };
        },

        escalate: async (failure, plan, nearTerm) => {
            // Move targets = the plan's own non-locked semesters AFTER the near
            // term (already opted-in summer/J-term included; the frozen seam
            // drops any move that re-solves infeasible, so a loose list is safe).
            const nearIdx = plan.semesters.findIndex((s) => s.term === nearTerm);
            const laterTerms = plan.semesters
                .filter((s, i) => i > nearIdx && !s.locked)
                .map((s) => s.term);

            const leafSiblingsFor = makeLeafSiblingsResolver(session, dpr, plan);
            const withinTermAlternatives = await findWithinTermAlternatives(
                failure.courseIds,
                nearTerm,
                { leafSiblingsFor, isOfferedAndOpen },
            );

            const batches = generateResolutionLadder({
                failure,
                nearTerm,
                laterTerms,
                withinTermAlternatives,
            });
            return validateResolutionCandidates(
                batches,
                plan.graduationTerm,
                makeFrozenSeamEvaluator(session, dpr, plan),
            );
        },
    };
}
