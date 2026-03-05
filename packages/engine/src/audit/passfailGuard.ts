// ============================================================
// Pass/Fail Guard — Detect P/F violations in major, Core
// ============================================================
// Sources: SKILL.md §A1.4 (CS major), §A2.2 (Core), §A3.5 (general P/F)
// All rules from: Original rules/Major rules CS BA major
//                 Original rules/CAS core rules.md
//                 Original rules/General CAS academic rules.md
// ============================================================

import type { CourseTaken, Rule, Course } from "@nyupath/shared";

export interface PassFailViolation {
    courseId: string;
    /** Why this is a violation */
    reason: string;
    /** Severity: "error" = definitely invalid, "warning" = approaching limit */
    severity: "error" | "warning";
}

/**
 * Check for Pass/Fail violations in a student's courses.
 *
 * Rules enforced:
 * - P/F NOT allowed for major courses or prerequisites [CS-MAJOR] §A1.4
 * - P/F NOT allowed for Core courses, EXCEPT foreign language below Intermediate II [CAS-CORE] §A2.2
 * - Maximum 32 P/F credits total career [GEN-ACAD] §A3.5
 * - Only 1 P/F option per term [GEN-ACAD] §A3.5
 */
export function checkPassFailViolations(
    coursesTaken: CourseTaken[],
    majorRules: Rule[],
    coreRules: Rule[],
    courses: Course[]
): PassFailViolation[] {
    const violations: PassFailViolation[] = [];
    const courseCatalog = new Map(courses.map((c) => [c.id, c]));

    // Build sets of course IDs that belong to major and core pools
    // Separate exact IDs from wildcard patterns (e.g., "CORE-UA 5*")
    const majorCourseIds = new Set<string>();
    const majorWildcards: string[] = [];
    const coreCourseIds = new Set<string>();
    const coreWildcards: string[] = [];
    // Track core foreign language courses below Intermediate II (exempt from P/F restriction)
    const flBelowIntermediateII = new Set<string>();
    const flWildcards: string[] = [];

    for (const rule of majorRules) {
        const pool = getPoolFromRule(rule);
        for (const id of pool) {
            if (id.includes("*")) {
                majorWildcards.push(id.replace("*", ""));
            } else {
                majorCourseIds.add(id);
            }
        }
    }

    for (const rule of coreRules) {
        const pool = getPoolFromRule(rule);
        const isFL = rule.ruleId === "core_foreign_lang";
        for (const id of pool) {
            if (id.includes("*")) {
                coreWildcards.push(id.replace("*", ""));
                if (isFL) flWildcards.push(id.replace("*", ""));
            } else {
                coreCourseIds.add(id);
                if (isFL) flBelowIntermediateII.add(id);
            }
        }
    }

    // Courses that are NOT applicable to CS major per [CS-MAJOR] §A1.4
    const CS_NOT_APPLICABLE = new Set([
        "CSCI-UA 2", "CSCI-UA 4", "CSCI-UA 60", "CSCI-UA 61",
        "CSCI-UA 330", "CSCI-UA 380", "CSCI-UA 381",
        "CSCI-UA 520", "CSCI-UA 521",
        "CSCI-UA 897", "CSCI-UA 898",
        "CSCI-UA 997", "CSCI-UA 998",
    ]);

    // Track P/F per term for the 1-per-term check
    const pfPerTerm = new Map<string, string[]>();
    let totalPFCredits = 0;

    for (const ct of coursesTaken) {
        // Only check courses with P/F grade mode or grade "P"
        const isPF = ct.gradeMode === "pf" || ct.grade.toUpperCase() === "P";
        if (!isPF) continue;

        const course = courseCatalog.get(ct.courseId);
        const credits = course?.credits ?? ct.credits ?? 4;
        totalPFCredits += credits;

        // Track per-term usage
        const termList = pfPerTerm.get(ct.semester) ?? [];
        termList.push(ct.courseId);
        pfPerTerm.set(ct.semester, termList);

        // Check: is this a major course?
        // A course counts as "major" if it's in the major pool AND not in the not-applicable list
        const inMajorPool = (majorCourseIds.has(ct.courseId) || majorWildcards.some(p => ct.courseId.startsWith(p)))
            && !CS_NOT_APPLICABLE.has(ct.courseId);
        if (inMajorPool) {
            violations.push({
                courseId: ct.courseId,
                reason: `Pass/Fail not allowed for major courses. ${ct.courseId} is required for the CS BA major. [CS-MAJOR]`,
                severity: "error",
            });
        }

        // Check: is this a Core course?
        const inCorePool = coreCourseIds.has(ct.courseId) || coreWildcards.some(p => ct.courseId.startsWith(p));
        const isFLExempt = flBelowIntermediateII.has(ct.courseId) || flWildcards.some(p => ct.courseId.startsWith(p));
        if (inCorePool && !isFLExempt) {
            violations.push({
                courseId: ct.courseId,
                reason: `Pass/Fail not allowed for Core courses. ${ct.courseId} is a Core requirement. [CAS-CORE]`,
                severity: "error",
            });
        }
    }

    // Check: 32 P/F credit career maximum
    if (totalPFCredits > 32) {
        violations.push({
            courseId: "",
            reason: `Pass/Fail career limit exceeded: ${totalPFCredits}/32 credits. [GEN-ACAD]`,
            severity: "error",
        });
    }

    // Check: 1 P/F per term
    for (const [term, pfCourses] of pfPerTerm) {
        if (pfCourses.length > 1) {
            violations.push({
                courseId: pfCourses[1], // Flag the second one
                reason: `Only 1 Pass/Fail course allowed per term. Found ${pfCourses.length} in ${term}. [GEN-ACAD]`,
                severity: "error",
            });
        }
    }

    return violations;
}

// ---- Helpers ----

function getPoolFromRule(rule: Rule): string[] {
    switch (rule.type) {
        case "must_take":
            return rule.courses;
        case "choose_n":
            return [...rule.fromPool, ...(rule.mathSubstitutionPool ?? [])];
        case "min_credits":
        case "min_level":
            return rule.fromPool;
        default:
            return [];
    }
}
