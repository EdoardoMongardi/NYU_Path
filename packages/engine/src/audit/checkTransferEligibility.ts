// ============================================================
// checkTransferEligibility — Internal NYU School-to-School Transfer
// ============================================================
// Phase 2 deliverable per ARCHITECTURE.md §7.2 + §12.6.
//
// Pure read-only computation: given a student profile and a target
// school, determine whether the student meets the published prerequisite
// + credit + disqualifier requirements for an internal transfer to that
// school. Returns a structured result that the chat tool layer can
// summarize. No profile mutation; no LLM dependency.
//
// All bulletin-grounded data lives in `data/transfers/<from>_to_<to>.json`
// with `_meta` + `_provenance`. When a (from, to) pair isn't authored,
// the result returns `status: "unsupported"` with a contact pointer —
// per the project philosophy, we never invent transfer requirements.
// ============================================================

import type { StudentProfile } from "@nyupath/shared";
import {
    loadNyuInternalTransferPolicy,
    loadTransferRequirements,
    type TransferRequirements,
    type TransferEntryYearRequirements,
} from "../data/transferLoader.js";

export interface PrereqStatus {
    /** Category id from the bulletin requirement, e.g. "calculus" */
    category: string;
    description: string;
    satisfied: boolean;
    /** The student's course id that satisfies this category, if any */
    courseTaken?: string;
    /** Course IDs in the satisfiedBy pool the student has not taken */
    candidates: string[];
}

export type TransferDecision =
    | {
        status: "unsupported";
        reason: string;
        contact: string;
        nyuWidePolicy?: ReturnType<typeof loadNyuInternalTransferPolicy>;
    }
    | {
        status: "ineligible";
        reason: string;
        canApplyAfter?: string;
        nyuWidePolicy?: ReturnType<typeof loadNyuInternalTransferPolicy>;
    }
    | {
        status: "eligible" | "not_yet_eligible";
        entryYear: "sophomore" | "junior";
        deadline: string;
        acceptedTerms: string[];
        prereqStatus: PrereqStatus[];
        missingPrereqs: PrereqStatus[];
        notes: string[];
        gpaNote: string;
        equivalencyUrl?: string;
        applicationUrl?: string;
    };

/**
 * Run the deterministic transfer-eligibility check.
 *
 * @param student      profile with homeSchool + coursesTaken populated
 * @param targetSchool e.g. "stern", "tandon"
 * @param opts         testing override for the data directory
 */
export function checkTransferEligibility(
    student: StudentProfile,
    targetSchool: string,
    opts?: { transfersDir?: string },
): TransferDecision {
    if (student.homeSchool === targetSchool) {
        return {
            status: "unsupported",
            reason: `Already in ${targetSchool}.`,
            contact: "NYU Office of Undergraduate Admissions",
        };
    }

    const reqsResult = loadTransferRequirements(student.homeSchool, targetSchool, opts);

    // No specific (from, to) data file → return unsupported but include
    // the NYU-wide policy floor so the chat layer can still give the
    // student useful guidance.
    if (!reqsResult.ok) {
        const nyuPolicy = loadNyuInternalTransferPolicy(opts);
        return {
            status: "unsupported",
            reason:
                `Specific transfer requirements from ${student.homeSchool} to ${targetSchool} ` +
                `are not yet authored in the data set. The general NYU-wide policy applies.`,
            contact: "NYU Office of Undergraduate Admissions",
            nyuWidePolicy: nyuPolicy,
        };
    }

    const reqs: TransferRequirements = reqsResult.requirements;

    // Disqualifier check — e.g., Stern blocks previously-external transfers
    if (reqs.disqualifiers?.length) {
        const flags = student.flags ?? [];
        for (const dq of reqs.disqualifiers) {
            // Convention: a disqualifier id matches a flag of the same name
            // (e.g., flag "previously_external_transfer")
            if (flags.includes(dq)) {
                return {
                    status: "ineligible",
                    reason:
                        reqs.disqualifierReasons?.[dq]
                        ?? `Disqualified: ${dq}.`,
                };
            }
        }
    }

    // Credit-floor check
    const creditsCompleted = sumCreditsCompleted(student);
    if (creditsCompleted < reqs.minCreditsCompleted) {
        return {
            status: "ineligible",
            reason:
                `Need ${reqs.minCreditsCompleted} credits to apply (you have ${creditsCompleted}). ` +
                `Complete your first year first.`,
            canApplyAfter: `${reqs.minCreditsCompleted - creditsCompleted} more credits`,
        };
    }

    // Pick the entry-year requirements based on credits completed
    const entryYear: "sophomore" | "junior" = creditsCompleted >= 64 ? "junior" : "sophomore";
    const yearReqs = reqs.entryYearRequirements.find((r) => r.entryYear === entryYear);
    if (!yearReqs) {
        return {
            status: "unsupported",
            reason:
                `Entry-year requirements for "${entryYear}" are not authored ` +
                `for ${student.homeSchool} → ${targetSchool}.`,
            contact: "NYU Office of Undergraduate Admissions",
        };
    }

    const prereqStatus = evaluatePrereqs(student, yearReqs);
    const missingPrereqs = prereqStatus.filter((p) => !p.satisfied);
    const allSatisfied = missingPrereqs.length === 0;

    return {
        status: allSatisfied ? "eligible" : "not_yet_eligible",
        entryYear,
        deadline: reqs.applicationDeadline,
        acceptedTerms: reqs.acceptedTerms,
        prereqStatus,
        missingPrereqs,
        notes: reqs.notes ?? [],
        gpaNote: "Minimum GPA for internal transfer is not published. Contact the target school's admissions office.",
        equivalencyUrl: reqs.equivalencyUrl,
        applicationUrl: reqs.applicationUrl,
    };
}

// ---- helpers ----

function sumCreditsCompleted(student: StudentProfile): number {
    let total = student.genericTransferCredits ?? 0;
    for (const ct of student.coursesTaken) {
        const grade = ct.grade.toUpperCase();
        // CAS bulletin L394 + general practice: only count credits a passing
        // letter or P actually earned. Skip W/I/NR/F (not earned) and TR
        // (already in genericTransferCredits when applicable).
        if (
            grade === "F" ||
            grade === "W" ||
            grade === "I" ||
            grade === "NR" ||
            grade === "TR"
        ) continue;
        total += ct.credits ?? 4;
    }
    if (student.transferCourses) {
        for (const tc of student.transferCourses) total += tc.credits;
    }
    return total;
}

function evaluatePrereqs(
    student: StudentProfile,
    yearReqs: TransferEntryYearRequirements,
): PrereqStatus[] {
    // Build the set of NYU course IDs the student has taken with a
    // letter grade A-F (i.e., a prereq-eligible grade). Per CAS bulletin
    // L138 ("No course for the major may be taken Pass/Fail") and the
    // common-sense reading of NYU transfer-admissions ("1 semester of X"
    // implies a graded enrollment), a P-graded course does NOT satisfy a
    // transfer prereq. W/I/NR/F are obviously ineligible too — only
    // genuinely passed letter grades count.
    const PREREQ_VALID_GRADES = new Set([
        "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D",
    ]);
    const validIds = new Set<string>();
    for (const ct of student.coursesTaken) {
        const grade = ct.grade.toUpperCase();
        if (PREREQ_VALID_GRADES.has(grade)) validIds.add(ct.courseId);
    }
    return yearReqs.requiredCourseCategories.map((cat) => {
        const taken = cat.satisfiedBy.find((id) => matchesSatisfiedBy(id, validIds));
        return {
            category: cat.category,
            description: cat.description,
            satisfied: !!taken,
            courseTaken: taken ? resolveTakenMatch(taken, validIds) : undefined,
            candidates: cat.satisfiedBy,
        };
    });
}

/**
 * Match a single satisfiedBy entry against the student's taken-course set.
 * Supports `"DEPT-XX *"` wildcard prefix matching, mirroring the convention
 * used by `ruleEvaluator.matchesPool`.
 */
function matchesSatisfiedBy(entry: string, validIds: Set<string>): boolean {
    if (entry.includes("*")) {
        const prefix = entry.replace("*", "").trimEnd();
        for (const id of validIds) if (id.startsWith(prefix)) return true;
        return false;
    }
    return validIds.has(entry);
}

function resolveTakenMatch(entry: string, validIds: Set<string>): string {
    if (!entry.includes("*")) return entry;
    const prefix = entry.replace("*", "").trimEnd();
    for (const id of validIds) if (id.startsWith(prefix)) return id;
    return entry;
}
