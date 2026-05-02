// ============================================================
// Phase 11 Stage 2 — Plan-feasibility verifier (deterministic)
// ============================================================
// Catches plans that violate hard constraints the agent might
// otherwise miss. Mirrors the per-change-type strategy pattern from
// claude-code-leak/verificationAgent.ts:27-40 ("Backend: start
// server → curl endpoints → verify response shapes"); we adapt to
// "Plan output: walk requirements → check ceiling → check floor →
// check prereqs → check duplicates").
//
// Pattern source (claude-code-leak):
//   - verificationAgent.ts:27-40 — strategy adaptation per output type
//   - verificationAgent.ts:101-128 — every check attaches the actual
//     evidence (we attach the data we used, not narrative reasoning)
//
// Pure deterministic. No LLM. Designed to be called from
// planSemester.ts after the plan is built; results are attached to
// the envelope's `disclaimers` (Phase 10 architecture pattern).
// ============================================================

import type { ToolSession } from "../tool.js";
import type { CourseSuggestion, PrereqGroup, SchoolConfig } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../dpr/schema.js";
import { formatCitation } from "../citationLabels.js";

export type FeasibilityViolationKind =
    | "exceeds_semester_ceiling"
    | "below_f1_floor"
    | "prereq_chain_broken"
    | "duplicate_in_target_term"
    | "uses_completed_course";

export interface FeasibilityViolation {
    kind: FeasibilityViolationKind;
    /** Human-readable + evidence attached (the data we used) */
    detail: string;
    /** When the violation is course-specific */
    courseId?: string;
}

export interface PlanFeasibilityVerdict {
    ok: boolean;
    violations: FeasibilityViolation[];
}

interface PlanFeasibilityInput {
    suggestions: ReadonlyArray<CourseSuggestion>;
    plannedCredits: number;
    targetSemester: string;          // "2025-fall" / "2026 Fall" — for messages only
    creditsAlreadyInTarget: number;
    alreadyRegisteredForTargetIds: ReadonlyArray<string>;
    schoolConfig: SchoolConfig | null;
    visaStatus: string | undefined;
    dpr: DegreeProgressReport | null;
    prereqs: ToolSession["prereqs"] | undefined;
}

/**
 * Walk every plan suggestion against five hard constraints.
 * Each violation includes the EVIDENCE the verifier saw (per the
 * verificationAgent.ts:101-128 pattern) so the agent can pass it
 * back to the student verbatim.
 */
export function verifyPlanFeasibility(input: PlanFeasibilityInput): PlanFeasibilityVerdict {
    const violations: FeasibilityViolation[] = [];

    const totalProjected = input.creditsAlreadyInTarget + input.plannedCredits;

    // Check 1: per-semester ceiling. Source: schoolConfig.maxCreditsPerSemester.
    if (input.schoolConfig?.maxCreditsPerSemester !== undefined) {
        const ceiling = input.schoolConfig.maxCreditsPerSemester;
        if (totalProjected > ceiling) {
            violations.push({
                kind: "exceeds_semester_ceiling",
                detail:
                    `Total projected credits ${totalProjected} ` +
                    `(${input.creditsAlreadyInTarget} already registered + ${input.plannedCredits} planned) ` +
                    `exceed the ${input.schoolConfig.name} per-semester ceiling of ${ceiling}. ` +
                    `Source: ${formatCitation(`data/schools/${input.schoolConfig.schoolId}.json#maxCreditsPerSemester`)}. ` +
                    `Reduce the plan or note the overload requires adviser approval.`,
            });
        }
    }

    // Check 2: F-1 full-time floor. Source: schoolConfig.f1FullTimeMinCredits.
    if (input.visaStatus === "f1" && input.schoolConfig?.f1FullTimeMinCredits !== undefined) {
        const floor = input.schoolConfig.f1FullTimeMinCredits;
        if (totalProjected < floor) {
            violations.push({
                kind: "below_f1_floor",
                detail:
                    `Total projected credits ${totalProjected} ` +
                    `(${input.creditsAlreadyInTarget} already registered + ${input.plannedCredits} planned) ` +
                    `are below the F-1 full-time floor of ${floor}. ` +
                    `Source: ${formatCitation(`data/schools/${input.schoolConfig.schoolId}.json#f1FullTimeMinCredits`)}. ` +
                    `Drop below this and visa status is at risk; consult OGS before submitting.`,
            });
        }
    }

    // Build sets for the remaining checks.
    const completedIds = new Set<string>();
    const ipIds = new Set<string>(); // currently in-progress (not for target term)
    if (input.dpr) {
        for (const c of input.dpr.courseHistory) {
            const id = `${c.subject} ${c.catalogNbr}`;
            if (c.type === "EN" || c.type === "TE") completedIds.add(id);
            else if (c.type === "IP") ipIds.add(id);
        }
    }
    const alreadyInTargetSet = new Set(input.alreadyRegisteredForTargetIds);

    // Check 3: prerequisites chain. Source: session.prereqs graph.
    const prereqIndex = new Map<string, ReadonlyArray<PrereqGroup>>();
    if (input.prereqs) {
        for (const p of input.prereqs) {
            prereqIndex.set(p.course, p.prereqGroups);
        }
    }
    const has = (c: string) => completedIds.has(c) || ipIds.has(c) || alreadyInTargetSet.has(c);
    for (const s of input.suggestions) {
        const groups = prereqIndex.get(s.courseId);
        if (!groups || groups.length === 0) continue;
        const unmetGroups: string[] = [];
        for (const group of groups) {
            if (group.type === "NOT") {
                const blocked = (group.notCourses ?? []).filter(has);
                if (blocked.length > 0) {
                    unmetGroups.push(`must not have taken [${blocked.join(", ")}]`);
                }
                continue;
            }
            const groupCourses = group.courses;
            if (groupCourses.length === 0) continue;
            const satisfied =
                group.type === "AND"
                    ? groupCourses.every(has)
                    : groupCourses.some(has);
            if (!satisfied) {
                const need = groupCourses.filter((c) => !has(c));
                unmetGroups.push(`${group.type === "OR" ? "any of" : "all of"} [${need.join(", ")}]`);
            }
        }
        if (unmetGroups.length > 0) {
            violations.push({
                kind: "prereq_chain_broken",
                courseId: s.courseId,
                detail:
                    `${s.courseId} prerequisites are unmet: ${unmetGroups.join("; ")}. ` +
                    `Source: prereq graph (session.prereqs). ` +
                    `Either complete the prerequisite first or drop ${s.courseId} from this term's plan.`,
            });
        }
    }

    // Check 4: duplicate-in-target-term. Suggesting a course that's
    // already in the IP rows for the target term is wasted credit.
    for (const s of input.suggestions) {
        if (alreadyInTargetSet.has(s.courseId)) {
            violations.push({
                kind: "duplicate_in_target_term",
                courseId: s.courseId,
                detail:
                    `${s.courseId} is already in the student's IP rows for ${input.targetSemester}. ` +
                    `Source: dpr.courseHistory IP rows for the target term. ` +
                    `Drop ${s.courseId} from the plan — it's already on their schedule.`,
            });
        }
    }

    // Check 5: course already completed. Suggesting a course the
    // student passed is a waste; the planner's takenIds dedup should
    // have caught this, but the verifier double-checks.
    for (const s of input.suggestions) {
        if (completedIds.has(s.courseId)) {
            violations.push({
                kind: "uses_completed_course",
                courseId: s.courseId,
                detail:
                    `${s.courseId} is already in the student's transcript as completed (EN/TE row). ` +
                    `Source: dpr.courseHistory completed rows. ` +
                    `Drop ${s.courseId} from the plan unless the student is intentionally repeating it.`,
            });
        }
    }

    return { ok: violations.length === 0, violations };
}
