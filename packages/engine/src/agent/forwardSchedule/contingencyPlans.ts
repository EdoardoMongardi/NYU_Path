/**
 * Phase 13 Task 3.2 — IP contingency plan generator (Decision #30).
 *
 * Generates one extra solver run per IP course in `optimistic.assumptions`,
 * with that course removed from the satisfied set (simulating failure).
 * Phase 14's `simulate_alternatives` tool consumes this helper.
 */

import type { ForwardSchedule, Assumption } from "@nyupath/shared";
import type { SolverInput, SolverOutput } from "./types.js";
import { solveForwardSchedule } from "./solver.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ContingencyPlanResult {
    /** The original (optimistic) plan, unchanged. */
    optimistic: ForwardSchedule;
    /** One conservative plan per IP course in the optimistic plan's
     *  assumptions[]. Each conservative is a fresh solver run with the
     *  IP course's contribution to coursesInProgress / coursesTaken
     *  set REMOVED, so the solver re-plans assuming that course failed
     *  and the student must retake it. */
    conservatives: Array<{
        ipCourseAssumed: string;
        plan: ForwardSchedule;
    }>;
}

// ---------------------------------------------------------------------------
// Internal: build a ForwardSchedule from SolverOutput + SolverInput metadata
// ---------------------------------------------------------------------------

function solverOutputToForwardSchedule(
    output: SolverOutput,
    input: SolverInput,
): ForwardSchedule {
    const degreeCreditsMet =
        input.creditsEarned >= input.graduationCreditMinimum;

    return {
        studentId: input.studentId,
        homeSchoolId: input.homeSchoolId,
        graduationTerm: input.graduationTerm,
        creditTargetPerSemester: input.creditTargetPerSemester,
        f1Floor: input.f1Floor,
        domesticPartTimeFloor: input.domesticPartTimeFloor,
        graduationCreditMinimum: input.graduationCreditMinimum,
        degreeCreditsMet,
        semesters: output.semesters,
        dprCourseHistoryHash: input.dprCourseHistoryHash,
        computedAt: Date.now(),
        feasibility: output.feasibility,
        state: output.state,
        balanceScore: output.balanceScore,
        assumptions: output.assumptions,
        alternativeCandidates: output.alternativeCandidates,
    };
}

// ---------------------------------------------------------------------------
// Main export: generateContingencies
// ---------------------------------------------------------------------------

export function generateContingencies(
    optimistic: ForwardSchedule,
    baseInput: SolverInput,
): ContingencyPlanResult {
    // Filter to IP_COURSE_COMPLETION assumptions only
    const ipAssumptions = optimistic.assumptions.filter(
        (a): a is Extract<Assumption, { type: "IP_COURSE_COMPLETION" }> =>
            a.type === "IP_COURSE_COMPLETION",
    );

    if (ipAssumptions.length === 0) {
        return { optimistic, conservatives: [] };
    }

    const conservatives: ContingencyPlanResult["conservatives"] = [];

    for (const assumption of ipAssumptions) {
        const ipCourseId = assumption.courseId;

        // Build a derived SolverInput with a SHALLOW copy, removing the IP course:
        // 1. coursesInProgress minus the IP course
        // 2. unmetRequirements augmented with the IP course (synthetic re-take entry)
        const derivedCoursesInProgress = new Set(baseInput.coursesInProgress);
        derivedCoursesInProgress.delete(ipCourseId);

        // Also remove from coursesTaken if it was there (IP course that previously
        // failed should not count as taken)
        const derivedCoursesTaken = new Set(baseInput.coursesTaken);
        derivedCoursesTaken.delete(ipCourseId);

        // Append a synthetic unmet requirement for the IP course so the solver
        // re-places it in a future term.
        const syntheticRId = `IP_RETAKE_${ipCourseId.replace(/[^A-Za-z0-9]/g, "_")}`;
        const ipMeta = baseInput.courseCatalog.get(ipCourseId);
        const ipCredits = ipMeta?.credits ?? 4;

        const syntheticUnmet: SolverInput["unmetRequirements"][number] = {
            rId: syntheticRId,
            title: `Retake: ${ipCourseId} (IP course failed)`,
            category: "ip_retake",
            credits: ipCredits,
            candidateCourses: [ipCourseId],
        };

        // Check if there's already an unmet requirement for this course (avoid dup)
        const alreadyUnmet = baseInput.unmetRequirements.some(r =>
            r.candidateCourses.includes(ipCourseId),
        );

        const derivedUnmetRequirements = alreadyUnmet
            ? [...baseInput.unmetRequirements]
            : [...baseInput.unmetRequirements, syntheticUnmet];

        const derivedInput: SolverInput = {
            ...baseInput,
            coursesInProgress: derivedCoursesInProgress,
            coursesTaken: derivedCoursesTaken,
            unmetRequirements: derivedUnmetRequirements,
        };

        const output = solveForwardSchedule(derivedInput);
        const plan = solverOutputToForwardSchedule(output, derivedInput);

        conservatives.push({ ipCourseAssumed: ipCourseId, plan });
    }

    return { optimistic, conservatives };
}
