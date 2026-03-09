// ============================================================
// Degree Audit — Main audit function
// ============================================================
import type {
    StudentProfile,
    Program,
    AuditResult,
    RuleStatus,
    Course,
} from "@nyupath/shared";
import { evaluateRule } from "./ruleEvaluator.js";
import { EquivalenceResolver } from "../equivalence/equivalenceResolver.js";
import { validateCreditCaps } from "./creditCapValidator.js";

// Grades that satisfy CS major requirements and prerequisites (C or better per NYU CS policy).
const MAJOR_GRADES = new Set(["A", "A-", "B+", "B", "B-", "C+", "C"]);

// Grades that satisfy CAS Core requirements (D or better per General CAS academic rules §Core).
// P/F grades do NOT count for Core, except FL below Intermediate II (handled separately).
const CORE_GRADES = new Set(["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D"]);

// Grades that earn graduation credits (anything except F and W — C- earns credits but not major credit).
const CREDIT_GRADES = new Set(["A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "P"]);

/**
 * Run a full degree audit for a student against a specific program.
 *
 * This is the core deterministic function. No LLM involved.
 * Given a student profile and program rules, produces a structured audit.
 */
export function degreeAudit(
    student: StudentProfile,
    program: Program,
    courses: Course[]
): AuditResult {
    const equivalence = new EquivalenceResolver(courses);
    const courseCatalog = new Map(courses.map((c) => [c.id, c]));

    // Courses that satisfy CS major requirements AND prerequisites (C or better)
    const passedCourses = student.coursesTaken
        .filter((ct) => MAJOR_GRADES.has(ct.grade.toUpperCase()));

    // Courses that satisfy Core requirements (D or better, no P/F)
    const coreCourses = student.coursesTaken
        .filter((ct) => CORE_GRADES.has(ct.grade.toUpperCase()));

    // Courses that count toward the 128-credit graduation total (C- and D grades earn credits)
    const creditCourses = student.coursesTaken
        .filter((ct) => CREDIT_GRADES.has(ct.grade.toUpperCase()));

    const passedCourseIds = passedCourses.map((ct) => ct.courseId);
    const coreCourseIds = coreCourses.map((ct) => ct.courseId);
    const passedCourseMap = new Map(passedCourses.map((ct) => [ct.courseId, ct]));

    // Inject transfer course equivalents (AP/IB/A-Level/transfer) into the passed course list.
    // Courses with nyuEquivalent satisfy rules AND prerequisites, just like real NYU courses.
    // Transfer credits count for BOTH major (C+) and Core (D+) since they have no NYU grade.
    let transferCreditsFromMapped = 0;
    if (student.transferCourses) {
        for (const tc of student.transferCourses) {
            if (tc.nyuEquivalent) {
                passedCourseIds.push(tc.nyuEquivalent);
                coreCourseIds.push(tc.nyuEquivalent);
                passedCourseMap.set(tc.nyuEquivalent, {
                    courseId: tc.nyuEquivalent,
                    grade: "TR", // Transfer grade marker
                    semester: "transfer",
                    credits: tc.credits,
                });
                transferCreditsFromMapped += tc.credits;
            }
        }
    }

    // Normalize student's completed and passed courses (resolve cross-listings)
    const { normalized: normalizedMajor, warnings: eqWarnings } = equivalence.normalizeCompleted(passedCourseIds);
    const { normalized: normalizedCore } = equivalence.normalizeCompleted(coreCourseIds);
    const warnings: string[] = [...eqWarnings];

    // Pick the right completion set based on program type:
    // - Major programs (cs_major_ba, etc.) use C-or-better (normalizedMajor)
    // - Core program (cas_core) uses D-or-better (normalizedCore)
    const isCoreProgram = program.programId === "cas_core";
    const normalized = isCoreProgram ? normalizedCore : normalizedMajor;

    // Normalize creditCourses too so cross-listed courses aren't double-counted in graduation credits
    const creditCourseIds = creditCourses.map(ct => ct.courseId);
    const { normalized: normalizedCredit } = equivalence.normalizeCompleted(creditCourseIds);
    // Build a map for fast credit lookup (using canonical IDs)
    const creditCourseMap = new Map(creditCourses.map(ct => [equivalence.getCanonical(ct.courseId), ct]));

    // Count total credits for graduation: uses CREDIT_GRADES (C- and D count here)
    // This reflects NYU policy: C- earns credits toward 128-credit total but not major reqs
    let totalCreditsCompleted = student.genericTransferCredits ?? 0;
    let csciCreditsCompleted = 0;

    // Graduation credits — using deduplicated set of credit-eligible courses
    for (const courseId of normalizedCredit) {
        const canonicalId = equivalence.getCanonical(courseId);
        const course = courseCatalog.get(canonicalId);
        const ct = creditCourseMap.get(canonicalId);
        const credits = course?.credits ?? ct?.credits ?? 4;
        totalCreditsCompleted += credits;
    }
    // Also add transfer-mapped courses to graduation credits
    totalCreditsCompleted += transferCreditsFromMapped;

    // CSCI credits only from MAJOR_GRADES courses (C or better) — always use normalizedMajor
    for (const courseId of normalizedMajor) {
        const ct = passedCourseMap.get(courseId);
        if (!ct) continue;
        const canonicalId = equivalence.getCanonical(courseId);
        const course = courseCatalog.get(canonicalId);
        const isCSCI = course ? course.departments.includes("CSCI-UA") : courseId.startsWith("CSCI-UA");
        if (isCSCI) {
            const credits = course?.credits ?? ct.credits ?? 4;
            csciCreditsCompleted += credits;
        }
    }

    // Also add unmapped transfer credits (AP courses with no NYU equivalent)
    if (student.transferCourses) {
        for (const tc of student.transferCourses) {
            if (!tc.nyuEquivalent) {
                totalCreditsCompleted += tc.credits;
            }
        }
    }

    // Track which courses have been "used" by disallow-double-count rules
    const usedCourses = new Set<string>();
    // Track limit_1 double-counted courses
    const doubleCountedOnce = new Set<string>();

    // Evaluate each rule
    const ruleResults = program.rules.map((rule) => {
        const result = evaluateRule(rule, normalized, courseCatalog, equivalence, student.declaredPrograms, student.flags ?? []);

        // Apply double-count policy
        if (rule.doubleCountPolicy === "disallow") {
            // Filter out courses already used by another disallow rule
            const filteredSatisfying = result.coursesSatisfying.filter(
                (id) => !usedCourses.has(id)
            );
            const lostCourses = result.coursesSatisfying.length - filteredSatisfying.length;

            if (lostCourses > 0) {
                const newRemaining = result.remaining + lostCourses;
                const removedIds = result.coursesSatisfying.filter((id) => usedCourses.has(id));
                for (const id of removedIds) {
                    warnings.push(
                        `${id} already counted toward another requirement; cannot double-count for "${rule.label}"`
                    );
                }
                result.coursesSatisfying = filteredSatisfying;
                result.remaining = newRemaining;
                result.coursesRemaining = [
                    ...result.coursesRemaining,
                    ...removedIds,
                ];
                result.status = getStatus(newRemaining === 0, filteredSatisfying.length > 0);
            }

            // Mark these courses as used
            for (const id of filteredSatisfying) {
                usedCourses.add(id);
            }
        } else if (rule.doubleCountPolicy === "limit_1") {
            // At most 1 course in this rule's satisfying list can also count elsewhere
            let doubleCountUsed = false;
            const filteredSatisfying: string[] = [];

            for (const id of result.coursesSatisfying) {
                if (usedCourses.has(id)) {
                    if (!doubleCountUsed) {
                        // Allow this one to double-count
                        doubleCountUsed = true;
                        doubleCountedOnce.add(id);
                        filteredSatisfying.push(id);
                    } else {
                        warnings.push(
                            `${id} cannot double-count for "${rule.label}"; limit_1 already reached`
                        );
                    }
                } else {
                    filteredSatisfying.push(id);
                }
            }

            const lostCourses = result.coursesSatisfying.length - filteredSatisfying.length;
            if (lostCourses > 0) {
                result.coursesSatisfying = filteredSatisfying;
                result.remaining = result.remaining + lostCourses;
                result.status = getStatus(
                    result.remaining === 0,
                    filteredSatisfying.length > 0
                );
            }

            // Mark non-double-counted courses as used
            for (const id of filteredSatisfying) {
                if (!doubleCountedOnce.has(id)) {
                    usedCourses.add(id);
                }
            }
        }
        // "allow" → no restrictions

        return result;
    });

    // Overall status
    const allSatisfied = ruleResults.every((r) => r.status === "satisfied");
    const anyInProgress = ruleResults.some(
        (r) => r.status === "in_progress" || r.status === "satisfied"
    );
    const overallStatus: RuleStatus = allSatisfied
        ? "satisfied"
        : anyInProgress
            ? "in_progress"
            : "not_started";

    const result: AuditResult = {
        studentId: student.id,
        programId: program.programId,
        programName: program.name,
        catalogYear: student.catalogYear,
        timestamp: new Date().toISOString(),
        overallStatus,
        totalCreditsCompleted,
        totalCreditsRequired: program.totalCreditsRequired,
        rules: ruleResults,
        warnings,
    };

    // Run credit cap validators (residency, online, P/F, CSCI, etc.)
    const isCSProgram = program.rules.some(r => {
        const pool = "courses" in r ? (r as any).courses : "fromPool" in r ? (r as any).fromPool : [];
        return pool.some((c: string) => c.startsWith("CSCI-UA"));
    });
    const capWarnings = validateCreditCaps(student, courses, { isCSMajor: isCSProgram });
    for (const cw of capWarnings) {
        result.warnings.push(cw.message);
        // If a minimum isn't met, downgrade overall status
        if (cw.direction === "below_minimum" && result.overallStatus === "satisfied") {
            result.overallStatus = "in_progress";
        }
    }

    return result;
}

function getStatus(
    isSatisfied: boolean,
    hasProgress: boolean
): RuleStatus {
    if (isSatisfied) return "satisfied";
    if (hasProgress) return "in_progress";
    return "not_started";
}
