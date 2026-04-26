// ============================================================
// Transfer-Prep Planner (Phase 3 §12.6 row 3)
// ============================================================
// "Transfer student sees prereqs + deadline warnings."
//
// Given a student in their CURRENT school and a target NYU school for
// internal transfer, produce a planning result that:
//   1. Calls `checkTransferEligibility` to identify missing prereqs
//   2. Maps each missing prereq's `satisfiedBy[]` candidates into
//      planner CourseSuggestions (priority-boosted vs. major-only courses)
//   3. Surfaces the application deadline + acceptedTerms as warnings
//
// Crucial property: this planner does NOT modify the student's
// declaredPrograms. It plans for the student's CURRENT major while
// emphasizing the courses needed for the proposed transfer.
// ============================================================

import type {
    Course,
    PlannerConfig,
    Prerequisite,
    Program,
    SchoolConfig,
    SemesterPlan,
    StudentProfile,
} from "@nyupath/shared";
import { planNextSemester } from "./semesterPlanner.js";
import {
    checkTransferEligibility,
    type TransferDecision,
    type PrereqStatus,
} from "../audit/checkTransferEligibility.js";
import type { NyuPolicyLoadResult } from "../data/transferLoader.js";

export interface TransferPrepPlanResult {
    /** Plan run against the student's current major */
    plan: SemesterPlan;
    /** The full transfer eligibility decision */
    transferDecision: TransferDecision;
    /** Missing prereqs mapped to candidate course IDs the student should consider */
    missingPrereqsAsCourses: Array<{ category: string; description: string; candidates: string[] }>;
    /** Top deadline warning(s) added to the plan */
    deadlineWarnings: string[];
    /** Notes the chat layer should surface */
    notes: string[];
}

/**
 * Run a planner pass that emphasizes courses needed for an internal
 * transfer to `targetSchool`. The student's current major audit drives
 * the suggestion set; missing-prereq courses for the transfer are
 * promoted via the suggestions' reason field.
 */
export function planForTransferPrep(
    student: StudentProfile,
    currentMajor: Program,
    targetSchool: string,
    courses: Course[],
    prereqs: Prerequisite[],
    config: PlannerConfig,
    _schoolConfig?: SchoolConfig | null,
    opts?: { transfersDir?: string },
): TransferPrepPlanResult | {
    kind: "unsupported";
    reason: string;
    contact?: string;
    nyuWidePolicy?: NyuPolicyLoadResult;
} {
    const decision = checkTransferEligibility(student, targetSchool, opts);

    if (decision.status === "unsupported") {
        // Forward the NYU-wide policy floor so the chat layer can still
        // give the student useful guidance even without a specific
        // (from, to) data file.
        return {
            kind: "unsupported",
            reason: decision.reason,
            contact: decision.contact,
            nyuWidePolicy: decision.nyuWidePolicy,
        };
    }

    const plan = planNextSemester(student, currentMajor, courses, prereqs, config);

    const missingPrereqsAsCourses: TransferPrepPlanResult["missingPrereqsAsCourses"] = [];
    const deadlineWarnings: string[] = [];
    const notes: string[] = [];

    if (decision.status === "ineligible") {
        notes.push(`Transfer to ${targetSchool}: ineligible — ${decision.reason}`);
        if (decision.canApplyAfter) {
            notes.push(`Re-evaluate after: ${decision.canApplyAfter}.`);
        }
        return {
            plan,
            transferDecision: decision,
            missingPrereqsAsCourses: [],
            deadlineWarnings,
            notes,
        };
    }

    // status: eligible | not_yet_eligible
    deadlineWarnings.push(
        `${targetSchool} internal-transfer application deadline: ${decision.deadline}. ` +
        `Accepted terms: ${decision.acceptedTerms.join(", ")}.`,
    );

    for (const missing of decision.missingPrereqs) {
        missingPrereqsAsCourses.push({
            category: missing.category,
            description: missing.description,
            candidates: prereqsCandidates(missing),
        });
    }

    // Promote the suggestion priority for any course whose id matches a
    // missing-prereq candidate. The chat layer can sort by priority and
    // surface these first.
    const promotedIds = new Set<string>();
    for (const m of missingPrereqsAsCourses) {
        for (const c of m.candidates) promotedIds.add(c);
    }
    for (const s of plan.suggestions) {
        if (promotedIds.has(s.courseId)) {
            const prefix = `[transfer-prereq for ${targetSchool}: ${categoryFor(s.courseId, missingPrereqsAsCourses)}] `;
            if (!s.reason.startsWith("[transfer-prereq")) {
                s.reason = prefix + s.reason;
            }
            // Boost priority by a fixed delta — keeps relative ordering
            // among major rules, but pushes transfer-prereqs above pure
            // electives. Magnitude (50) chosen to dominate elective-only
            // suggestions but not break ties between two required courses.
            s.priority += 50;
        }
    }
    plan.suggestions.sort((a, b) => b.priority - a.priority);
    plan.enrollmentWarnings = [...plan.enrollmentWarnings, ...deadlineWarnings];

    notes.push(
        `Transfer-prep mode for ${student.homeSchool} → ${targetSchool}: ` +
        `${decision.status === "eligible"
            ? "all prereqs met"
            : `${decision.missingPrereqs.length} prereq(s) still needed`}.`,
    );

    return { plan, transferDecision: decision, missingPrereqsAsCourses, deadlineWarnings, notes };
}

// ---- helpers ----

function prereqsCandidates(missing: PrereqStatus): string[] {
    return missing.candidates ?? [];
}

function categoryFor(
    courseId: string,
    missing: TransferPrepPlanResult["missingPrereqsAsCourses"],
): string {
    for (const m of missing) {
        if (m.candidates.includes(courseId)) return m.category;
    }
    return "transfer";
}
