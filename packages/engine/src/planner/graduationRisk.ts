// ============================================================
// Graduation Risk Detector
// ============================================================
import type {
    Course,
    Program,
    GraduationRisk,
    RuleAuditResult,
    StudentProfile,
} from "@nyupath/shared";
import { PrereqGraph } from "../graph/prereqGraph.js";

/**
 * Detect graduation risks based on remaining requirements,
 * prerequisite chains, and semester availability.
 */
export function detectGraduationRisks(
    student: StudentProfile,
    program: Program,
    ruleResults: RuleAuditResult[],
    completedCourses: Set<string>,
    totalCreditsCompleted: number,
    prereqGraph: PrereqGraph,
    courseCatalog: Map<string, Course>,
    remainingSemesters: number
): GraduationRisk[] {
    const risks: GraduationRisk[] = [];

    // 1. Credit deficit risk
    const creditsRemaining = program.totalCreditsRequired - totalCreditsCompleted;
    if (creditsRemaining > 0) {
        const creditsPerSemester = creditsRemaining / remainingSemesters;
        if (creditsPerSemester > 20) {
            risks.push({
                level: "critical",
                message: `Need ${creditsRemaining} more credits in ${remainingSemesters} semester(s) — requires ${Math.ceil(creditsPerSemester)} credits/semester, exceeding typical max of 18.`,
                courses: [],
            });
        } else if (creditsPerSemester > 18) {
            risks.push({
                level: "high",
                message: `Need ${creditsRemaining} more credits in ${remainingSemesters} semester(s) — heavy load of ${Math.ceil(creditsPerSemester)} credits/semester required.`,
                courses: [],
            });
        } else if (creditsPerSemester > 16) {
            risks.push({
                level: "medium",
                message: `Need ${creditsRemaining} more credits in ${remainingSemesters} semester(s) — above-average load of ${Math.ceil(creditsPerSemester)} credits/semester.`,
                courses: [],
            });
        }
    }

    // 2. Prerequisite chain depth risk
    // Find the longest chain of prerequisites among remaining required courses
    const unmetRules = ruleResults.filter(r => r.status !== "satisfied");
    const remainingRequiredCourses: string[] = [];
    for (const rule of unmetRules) {
        remainingRequiredCourses.push(...rule.coursesRemaining);
    }

    // Calculate the longest prereq chain depth for any remaining course
    let longestChainDepth = 0;
    let longestChainCourse = "";
    for (const courseId of remainingRequiredCourses) {
        const depth = getPrereqChainDepth(courseId, completedCourses, prereqGraph);
        if (depth > longestChainDepth) {
            longestChainDepth = depth;
            longestChainCourse = courseId;
        }
    }

    if (longestChainDepth > remainingSemesters) {
        risks.push({
            level: "critical",
            message: `${longestChainCourse} requires a prerequisite chain of ${longestChainDepth} semesters, but only ${remainingSemesters} semester(s) remain. On-time graduation is impossible without overloads or summer courses.`,
            courses: [longestChainCourse],
        });
    } else if (longestChainDepth === remainingSemesters) {
        risks.push({
            level: "high",
            message: `${longestChainCourse} requires exactly ${longestChainDepth} semesters of prerequisites — zero room for error. Must start this chain immediately.`,
            courses: [longestChainCourse],
        });
    }

    // 3. Summer-only / term-restricted course risk
    const termRestricted: string[] = [];
    for (const courseId of remainingRequiredCourses) {
        const course = courseCatalog.get(courseId);
        if (course && course.termsOffered.length === 1) {
            termRestricted.push(courseId);
        }
    }
    if (termRestricted.length > 0) {
        risks.push({
            level: "medium",
            message: `${termRestricted.length} required course(s) are only offered in a single term: ${termRestricted.join(", ")}. Missing the window could delay graduation.`,
            courses: termRestricted,
        });
    }

    // 4. Remaining requirement count risk
    const totalRemaining = unmetRules.reduce((sum, r) => sum + r.remaining, 0);
    const coursesPerSemester = totalRemaining / remainingSemesters;
    if (coursesPerSemester > 5) {
        risks.push({
            level: "high",
            message: `${totalRemaining} required courses remain across ${remainingSemesters} semester(s) — averaging ${coursesPerSemester.toFixed(1)} requirement courses/semester.`,
            courses: [],
        });
    }

    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, none: 4 };
    risks.sort((a, b) => severityOrder[a.level] - severityOrder[b.level]);

    return risks;
}

/**
 * Calculate the minimum number of semesters needed to reach a course
 * through its prerequisite chain, given what's already completed.
 */
function getPrereqChainDepth(
    courseId: string,
    completedCourses: Set<string>,
    prereqGraph: PrereqGraph,
    memo: Map<string, number> = new Map()
): number {
    if (completedCourses.has(courseId)) return 0;
    if (memo.has(courseId)) return memo.get(courseId)!;

    const prereq = prereqGraph.getPrereqs(courseId);
    if (!prereq || prereq.prereqGroups.length === 0) {
        memo.set(courseId, 1); // Can take it next semester
        return 1;
    }

    // For each prereq group, find the minimum depth
    // All groups must be satisfied, so we take the max across groups
    let maxGroupDepth = 0;
    for (const group of prereq.prereqGroups) {
        if (group.type === "AND") {
            // All must be completed — max depth among them
            let groupDepth = 0;
            for (const dep of group.courses) {
                const depDepth = getPrereqChainDepth(dep, completedCourses, prereqGraph, memo);
                groupDepth = Math.max(groupDepth, depDepth);
            }
            maxGroupDepth = Math.max(maxGroupDepth, groupDepth);
        } else {
            // OR — only need one, so take the minimum
            let groupDepth = Infinity;
            for (const dep of group.courses) {
                const depDepth = getPrereqChainDepth(dep, completedCourses, prereqGraph, memo);
                groupDepth = Math.min(groupDepth, depDepth);
            }
            maxGroupDepth = Math.max(maxGroupDepth, groupDepth === Infinity ? 0 : groupDepth);
        }
    }

    const depth = maxGroupDepth + 1; // +1 for this course itself
    memo.set(courseId, depth);
    return depth;
}
