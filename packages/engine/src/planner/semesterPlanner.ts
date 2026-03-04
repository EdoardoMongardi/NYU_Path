// ============================================================
// Semester Planner — Main entry point (Phase 1)
// ============================================================
import type {
    Course,
    Program,
    StudentProfile,
    PlannerConfig,
    SemesterPlan,
    CourseSuggestion,
} from "@nyupath/shared";
import { PrereqGraph } from "../graph/prereqGraph.js";
import { EquivalenceResolver } from "../equivalence/equivalenceResolver.js";
import { degreeAudit } from "../audit/degreeAudit.js";
import { scoreCourses } from "./priorityScorer.js";
import { detectGraduationRisks } from "./graduationRisk.js";
import { validateEnrollment } from "./enrollmentValidator.js";
import { balancedSelect } from "./balancedSelector.js";
import type { Prerequisite } from "@nyupath/shared";

/**
 * Plan the next semester for a student.
 *
 * This is the core planner function that:
 * 1. Runs a degree audit to understand current progress
 * 2. Finds all unlocked courses (prerequisites met)
 * 3. Filters by term availability
 * 4. Scores and ranks candidates by priority
 * 5. Selects courses up to max limits
 * 6. Detects graduation risks
 *
 * @param student - Student profile with completed courses
 * @param program - Degree program rules
 * @param courses - Full course catalog
 * @param prereqs - Prerequisite definitions
 * @param config - Planner configuration (target semester, limits)
 * @returns A semester plan with ranked suggestions and risk warnings
 */
export function planNextSemester(
    student: StudentProfile,
    program: Program,
    courses: Course[],
    prereqs: Prerequisite[],
    config: PlannerConfig
): SemesterPlan {
    const equivalence = new EquivalenceResolver(courses);
    const prereqGraph = new PrereqGraph(prereqs);
    const courseCatalog = new Map(courses.map(c => [c.id, c]));

    // Step 1: Run audit to get current progress
    const audit = degreeAudit(student, program, courses);

    // Step 2: Build completed course set (grade-filtered, normalized)
    // Include transfer course equivalents so they satisfy prerequisites
    const VALID_GRADES = new Set(["A", "A-", "B+", "B", "B-", "C+", "C"]);
    const passedIds = student.coursesTaken
        .filter(ct => VALID_GRADES.has(ct.grade.toUpperCase()))
        .map(ct => ct.courseId);

    // Inject transfer equivalents (AP/IB/A-Level/transfer)
    if (student.transferCourses) {
        for (const tc of student.transferCourses) {
            if (tc.nyuEquivalent) {
                passedIds.push(tc.nyuEquivalent);
            }
        }
    }

    const { normalized: completedCourses } = equivalence.normalizeCompleted(passedIds);

    // Step 3: Get all unlocked courses
    const allCourseIds = courses.map(c => c.id);
    const unlocked = prereqGraph.getUnlockedCourses(completedCourses, allCourseIds);

    // Step 4: Filter by term availability
    const targetTerm = parseTerm(config.targetSemester);
    const termFiltered = unlocked.filter(courseId => {
        const course = courseCatalog.get(courseId);
        if (!course) return false;

        // Check if offered in the target term
        return course.termsOffered.includes(targetTerm);
    });

    // Step 5: Remove avoided courses and currently-enrolled courses
    const avoidSet = new Set(config.avoidCourses ?? []);
    const inProgressSet = new Set(
        (student.currentSemester?.courses ?? []).map(c => equivalence.getCanonical(c.courseId) ?? c.courseId)
    );
    const candidates = termFiltered.filter(id => {
        const canonical = equivalence.getCanonical(id) ?? id;
        return !avoidSet.has(id) && !inProgressSet.has(canonical) && !inProgressSet.has(id);
    });

    // Step 6: Estimate remaining semesters
    const remainingSemesters = estimateRemainingSemesters(
        student,
        config.targetSemester
    );

    // Step 7: Score and rank candidates
    const scored = scoreCourses(
        candidates,
        completedCourses,
        program,
        audit.rules,
        prereqGraph,
        courseCatalog,
        equivalence,
        config.preferredCourses,
        remainingSemesters
    );

    // Step 8: Balanced selection — distributes required courses across semesters
    const selection = balancedSelect(
        scored,
        audit.rules,
        config,
        remainingSemesters,
        audit.totalCreditsCompleted,
        program.totalCreditsRequired,
        student.visaStatus
    );

    // Step 9: Detect graduation risks
    const risks = detectGraduationRisks(
        student,
        program,
        audit.rules,
        completedCourses,
        audit.totalCreditsCompleted,
        prereqGraph,
        courseCatalog,
        remainingSemesters
    );

    // Step 10: Validate enrollment (F-1 visa rules, domestic half-time)
    const enrollment = validateEnrollment(selection.suggestions, student, config);

    // Step 11: Annotate suggestions with prereqRisk for in-progress course dependencies.
    // A suggestion has prereqRisk if any of its prerequisites is currently in-progress
    // (meaning the student hasn't yet received a grade of C or better for it).
    const inProgressIds = new Set(
        (student.currentSemester?.courses ?? []).map(c => c.courseId)
    );

    const annotatedSuggestions = selection.suggestions.map(suggestion => {
        if (inProgressIds.size === 0) return suggestion;

        // Get direct prereqs of this course from the prereq graph
        const prereqDef = prereqGraph.getPrereqs(suggestion.courseId);
        if (!prereqDef) return suggestion;

        // Collect all direct prereq course IDs across all groups
        const directPrereqs = prereqDef.prereqGroups.flatMap(g => g.courses);

        // Find which prereqs are currently in-progress (not yet graded)
        const atRiskPrereqs = directPrereqs.filter(pid =>
            inProgressIds.has(equivalence.getCanonical(pid) ?? pid)
        );

        if (atRiskPrereqs.length === 0) return suggestion;

        return { ...suggestion, prereqRisk: atRiskPrereqs };
    });

    // Surface a consolidated risk warning if any suggestions have prereq risk
    const atRiskSuggestions = annotatedSuggestions.filter(s => s.prereqRisk && s.prereqRisk.length > 0);
    if (atRiskSuggestions.length > 0) {
        const atRiskCourses = [...new Set(atRiskSuggestions.flatMap(s => s.prereqRisk!))];
        risks.push({
            level: "medium",
            message: `${atRiskSuggestions.length} suggested course(s) require you to pass ${atRiskCourses.join(", ")} this semester with a grade of C or better. If you receive below a C, those suggestions will need to shift to a later semester.`,
            courses: atRiskCourses,
        });
    }

    return {
        studentId: student.id,
        targetSemester: config.targetSemester,
        suggestions: annotatedSuggestions,
        risks,
        estimatedSemestersLeft: remainingSemesters,
        plannedCredits: selection.plannedCredits,
        projectedTotalCredits: audit.totalCreditsCompleted + selection.plannedCredits,
        freeSlots: selection.freeSlots,
        enrollmentWarnings: enrollment.warnings,
    };
}

/**
 * Parse "2025-fall" → "fall"
 */
function parseTerm(semester: string): "fall" | "spring" | "summer" | "january" {
    const parts = semester.split("-");
    const term = parts[parts.length - 1];
    if (term === "fall" || term === "spring" || term === "summer" || term === "january") {
        return term;
    }
    throw new Error(`Invalid semester format: ${semester}. Expected "YYYY-fall", "YYYY-spring", "YYYY-summer", or "YYYY-january".`);
}

/**
 * Rough estimate of remaining semesters.
 * Assumes student graduates by spring of their 4th year (8 semesters total).
 * Uses catalog year as the start year.
 */
function estimateRemainingSemesters(
    student: StudentProfile,
    targetSemester: string
): number {
    const startYear = parseInt(student.catalogYear, 10);
    const graduationSemester = `${startYear + 4}-spring`;

    const targetDate = semesterToOrdinal(targetSemester);
    const gradDate = semesterToOrdinal(graduationSemester);

    return Math.max(1, gradDate - targetDate + 1);
}

/**
 * Convert semester to a comparable ordinal number.
 * "2023-january" → 2023*4 + 1
 * "2023-spring"  → 2023*4 + 2
 * "2023-summer"  → 2023*4 + 3
 * "2023-fall"    → 2023*4 + 4
 */
function semesterToOrdinal(semester: string): number {
    const [yearStr, term] = semester.split("-");
    const year = parseInt(yearStr, 10);
    const termOffset = term === "january" ? 1 : term === "spring" ? 2 : term === "summer" ? 3 : 4;
    return year * 4 + termOffset;
}
