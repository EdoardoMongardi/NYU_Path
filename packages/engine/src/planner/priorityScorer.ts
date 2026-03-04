// ============================================================
// Priority Scorer — Rank courses by importance
// ============================================================
import type { Course, Program, Rule, RuleAuditResult } from "@nyupath/shared";
import { PrereqGraph } from "../graph/prereqGraph.js";
import { EquivalenceResolver } from "../equivalence/equivalenceResolver.js";

export interface ScoredCourse {
    courseId: string;
    course: Course;
    /** Total priority score (higher = take sooner) */
    score: number;
    /** Breakdown of score components for transparency */
    breakdown: {
        /** How many future courses are transitively blocked */
        blockedScore: number;
        /** How many unmet degree rules this satisfies */
        requirementScore: number;
        /** Urgency bonus for critical-path courses */
        urgencyScore: number;
        /** Bonus if student explicitly prefers this course */
        preferenceBonus: number;
    };
    /** Which rules this course satisfies */
    satisfiesRules: string[];
    /** Number of transitively blocked courses */
    blockedCount: number;
    /** Reason string summarizing why this was prioritized */
    reason: string;
}

// Score weights
const WEIGHTS = {
    BLOCKED: 10,         // per transitively blocked course
    REQUIREMENT: 25,     // per unmet rule this helps satisfy
    URGENCY: 15,         // for courses on the critical graduation path
    PREFERENCE: 20,      // student explicitly wants this course
    CORE_PREREQ: 30,     // for fundamental prereqs (101, 102, etc.)
} as const;

/**
 * Score and rank a list of candidate courses by how important
 * they are for the student to take this semester.
 */
export function scoreCourses(
    candidates: string[],
    completedCourses: Set<string>,
    program: Program,
    ruleResults: RuleAuditResult[],
    prereqGraph: PrereqGraph,
    courseCatalog: Map<string, Course>,
    equivalence: EquivalenceResolver,
    preferredCourses: string[] = [],
    remainingSemesters?: number
): ScoredCourse[] {
    const preferredSet = new Set(preferredCourses);

    // Identify unmet rules and what courses they still need
    const unmetRules = ruleResults.filter(r => r.status !== "satisfied");

    return candidates
        .map(courseId => {
            const course = courseCatalog.get(courseId);
            if (!course) return null;

            // 1. Blocked score — how many future courses depend on this one
            const blockedCount = prereqGraph.countTransitivelyBlocked(courseId);
            const blockedScore = blockedCount * WEIGHTS.BLOCKED;

            // 2. Requirement score — how many unmet rules does this course satisfy
            const satisfiesRules: string[] = [];
            for (const rule of unmetRules) {
                if (courseHelpsRule(courseId, rule, program, equivalence)) {
                    satisfiesRules.push(rule.ruleId);
                }
            }
            const requirementScore = satisfiesRules.length * WEIGHTS.REQUIREMENT;

            // 3. Urgency score — if few semesters remain, critical courses get a boost
            let urgencyScore = 0;
            if (remainingSemesters !== undefined && remainingSemesters <= 3) {
                // Courses that are prerequisites for other requirements get an urgency boost
                if (blockedCount > 0 && satisfiesRules.length > 0) {
                    urgencyScore = WEIGHTS.URGENCY * (4 - remainingSemesters);
                }
            }
            // Core prerequisite courses get a boost ONLY if relevant to the target program
            if (isCorePrereq(courseId) && isRelevantToProgram(courseId, program, equivalence)) {
                urgencyScore += WEIGHTS.CORE_PREREQ;
            }

            // 4. Preference bonus
            const preferenceBonus = preferredSet.has(courseId) ? WEIGHTS.PREFERENCE : 0;

            const score = blockedScore + requirementScore + urgencyScore + preferenceBonus;

            // Build a human-readable reason
            const reasons: string[] = [];
            if (blockedCount > 0) reasons.push(`unlocks ${blockedCount} future course(s)`);
            if (satisfiesRules.length > 0) reasons.push(`satisfies ${satisfiesRules.length} requirement(s)`);
            if (urgencyScore > 0) reasons.push("critical path course");
            if (preferenceBonus > 0) reasons.push("preferred by student");
            const reason = reasons.length > 0 ? reasons.join("; ") : "available elective";

            return {
                courseId,
                course,
                score,
                breakdown: {
                    blockedScore,
                    requirementScore,
                    urgencyScore,
                    preferenceBonus,
                },
                satisfiesRules,
                blockedCount,
                reason,
            } satisfies ScoredCourse;
        })
        .filter((s): s is ScoredCourse => s !== null)
        .sort((a, b) => b.score - a.score); // highest priority first
}

/**
 * Check if a course helps satisfy a specific unmet rule.
 */
function courseHelpsRule(
    courseId: string,
    ruleResult: RuleAuditResult,
    program: Program,
    equivalence: EquivalenceResolver
): boolean {
    // For must_take rules: check if this course is in coursesRemaining
    if (ruleResult.coursesRemaining.includes(courseId)) {
        return true;
    }

    // Check if canonical matches
    const canonical = equivalence.getCanonical(courseId);
    if (ruleResult.coursesRemaining.some(r => equivalence.getCanonical(r) === canonical)) {
        return true;
    }

    // For choose_n rules: check if it matches a wildcard pattern in the pool
    const rule = program.rules.find(r => r.ruleId === ruleResult.ruleId);
    if (rule && "fromPool" in rule && ruleResult.remaining > 0) {
        return rule.fromPool.some(pattern => {
            if (pattern.includes("*")) {
                const prefix = pattern.replace("*", "");
                return courseId.startsWith(prefix) || canonical.startsWith(prefix);
            }
            return equivalence.getCanonical(pattern) === canonical;
        });
    }

    return false;
}

/**
 * Core prerequisite courses that should always receive a priority boost
 * because they are gatekeepers to the entire CS curriculum.
 */
function isCorePrereq(courseId: string): boolean {
    const corePrereqs = new Set([
        "CSCI-UA 101", "CSCI-UA 110", // Intro
        "CSCI-UA 102",                 // Data Structures
        "CSCI-UA 201",                 // CSO
        "CSCI-UA 310",                 // Algorithms
        "MATH-UA 120",                 // Discrete Math
        "MATH-UA 121",                 // Calculus I
    ]);
    return corePrereqs.has(courseId);
}

/**
 * Check if a course is relevant to the target program.
 * A course is relevant if it appears in any of the program's rule pools
 * (directly or via wildcard matching).
 */
function isRelevantToProgram(
    courseId: string,
    program: Program,
    equivalence: EquivalenceResolver
): boolean {
    const canonical = equivalence.getCanonical(courseId);
    for (const rule of program.rules) {
        const pool = "courses" in rule ? (rule as any).courses : "fromPool" in rule ? (rule as any).fromPool : [];
        for (const pattern of pool) {
            if (pattern.includes("*")) {
                const prefix = pattern.replace("*", "");
                if (courseId.startsWith(prefix) || canonical.startsWith(prefix)) return true;
            } else if (equivalence.getCanonical(pattern) === canonical) {
                return true;
            }
        }
    }
    return false;
}
