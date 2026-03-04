// ============================================================
// Enrollment Validator — F-1 visa rules & domestic status warnings
// ============================================================
import type {
    StudentProfile,
    PlannerConfig,
    CourseSuggestion,
} from "@nyupath/shared";

export interface EnrollmentValidation {
    valid: boolean;
    warnings: string[];
}

/**
 * Validate enrollment against F-1 visa rules and domestic enrollment norms.
 *
 * F-1 rules (Fall/Spring only):
 *  - Minimum 12 credits for full-time status
 *  - Maximum 1 online course (3 credits) toward full-time
 *  - Remaining ≥ 9 credits must be in-person/hybrid/blended
 *  - Final semester exception: can drop below 12 with OGS approval
 *
 * Domestic rules:
 *  - Advisory: < 12 credits = half-time (may affect aid, housing, scholarships)
 *
 * Summer/January semesters: no enrollment requirements for anyone.
 */
export function validateEnrollment(
    suggestions: CourseSuggestion[],
    student: StudentProfile,
    config: PlannerConfig
): EnrollmentValidation {
    const warnings: string[] = [];
    const term = parseTerm(config.targetSemester);

    // Summer and January terms have no enrollment requirements
    if (term === "summer" || term === "january") {
        return { valid: true, warnings };
    }

    const totalCredits = suggestions.reduce((sum, s) => sum + s.credits, 0);
    const onlineIds = new Set(config.onlineCourseIds ?? []);
    const onlineCourses = suggestions.filter(s => onlineIds.has(s.courseId));
    const onlineCredits = onlineCourses.reduce((sum, s) => sum + s.credits, 0);
    const inPersonCredits = totalCredits - onlineCredits;

    const visaStatus = student.visaStatus ?? "domestic";

    if (visaStatus === "f1") {
        return validateF1(totalCredits, onlineCourses.length, onlineCredits, inPersonCredits, config, warnings);
    }

    // Domestic students
    if (totalCredits < 12 && !config.isFinalSemester) {
        warnings.push(
            `Enrolling in ${totalCredits} credits (half-time). ` +
            `Full-time is 12+ credits. Half-time status may affect ` +
            `financial aid, housing eligibility, and scholarships.`
        );
    }

    return { valid: true, warnings };
}

function validateF1(
    totalCredits: number,
    onlineCourseCount: number,
    onlineCredits: number,
    inPersonCredits: number,
    config: PlannerConfig,
    warnings: string[]
): EnrollmentValidation {
    let valid = true;

    // Final semester exception
    if (config.isFinalSemester) {
        if (totalCredits < 12) {
            warnings.push(
                `Final semester: ${totalCredits} credits planned (below 12). ` +
                `F-1 students must obtain OGS Reduced Course Load (RCL) approval ` +
                `before dropping below full-time. You should still enroll in at ` +
                `least one in-person course.`
            );
        }
        if (inPersonCredits === 0 && totalCredits > 0) {
            warnings.push(
                `F-1 final semester: all courses are online. OGS advises ` +
                `enrolling in at least one in-person course.`
            );
        }
        // Final semester is valid even below 12 (with RCL approval)
        return { valid: true, warnings };
    }

    // Regular Fall/Spring semester
    const minCredits = config.minCredits ?? 12;

    if (totalCredits < minCredits) {
        valid = false;
        warnings.push(
            `F-1 VIOLATION: ${totalCredits} credits planned, minimum ${minCredits} required. ` +
            `F-1 students must maintain full-time enrollment (≥ 12 credits) ` +
            `every Fall and Spring semester. Dropping below without OGS ` +
            `approval is a SEVIS violation.`
        );
    }

    if (onlineCourseCount > 1) {
        valid = false;
        warnings.push(
            `F-1 VIOLATION: ${onlineCourseCount} online courses selected. ` +
            `Only 1 online course (max 3 credits) may count toward the ` +
            `full-time enrollment requirement per semester.`
        );
    } else if (onlineCredits > 3) {
        valid = false;
        warnings.push(
            `F-1 VIOLATION: online course has ${onlineCredits} credits. ` +
            `Maximum 3 online credits may count toward full-time enrollment.`
        );
    }

    if (inPersonCredits < 9 && totalCredits >= 12) {
        valid = false;
        warnings.push(
            `F-1 VIOLATION: only ${inPersonCredits} in-person credits. ` +
            `At least 9 credits must be from in-person, hybrid, or blended ` +
            `courses to meet the full-time enrollment requirement.`
        );
    }

    return { valid, warnings };
}

/**
 * Parse "2025-fall" → "fall"
 */
function parseTerm(semester: string): string {
    const parts = semester.split("-");
    return parts[parts.length - 1];
}
