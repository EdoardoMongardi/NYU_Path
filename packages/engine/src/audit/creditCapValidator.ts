// ============================================================
// Credit Cap Validator — Deterministic credit limit checks
// ============================================================
// Sources: SKILL.md §A3.2 (Residency), §A3.3 (Caps), §A3.5 (P/F), §A1.4 (CSCI-UA)
// All rules from: Original rules/General CAS academic rules.md
//                 Original rules/Major rules CS BA major
// ============================================================

import type { StudentProfile, Course } from "@nyupath/shared";

export interface CreditCapWarning {
    /** Which cap was checked */
    type:
    | "residency_ua"
    | "csci_minimum"
    | "non_cas_max"
    | "online_max"
    | "transfer_max"
    | "advanced_standing_max"
    | "passfail_max";
    /** Current value */
    current: number;
    /** Required limit (min or max) */
    limit: number;
    /** Whether this is a "minimum not met" or "maximum exceeded" */
    direction: "below_minimum" | "above_maximum";
    /** Human-readable description */
    message: string;
}

/**
 * Run all credit cap checks against a student profile.
 * Returns an array of warnings for any caps that are violated or at risk.
 *
 * Source: [GEN-ACAD] §A3.2, §A3.3, §A3.5 + [CS-MAJOR] §A1.4
 */
export function validateCreditCaps(
    student: StudentProfile,
    courses: Course[],
    options?: { isCSMajor?: boolean }
): CreditCapWarning[] {
    const warnings: CreditCapWarning[] = [];

    // §A3.2 — 64 UA-suffix residency minimum
    // Source: General CAS academic rules.md → Residency Requirements
    // "64 credits minimum must have the -UA suffix (CAS courses)"
    const uaCheck = checkResidencyCredits(student);
    if (uaCheck) warnings.push(uaCheck);

    // §A3.3 — 16 non-CAS NYU credits max
    // Source: General CAS academic rules.md → Courses at Other Schools
    const nonCASCheck = checkNonCASCredits(student);
    if (nonCASCheck) warnings.push(nonCASCheck);

    // §A3.3 — 24 online credits max
    // Source: General CAS academic rules.md → Credit for Online Courses (raised from 16 in Fall 2024)
    const onlineCheck = checkOnlineCredits(student);
    if (onlineCheck) warnings.push(onlineCheck);

    // §A3.3 — 64 transfer credits max
    // Source: General CAS academic rules.md → Credit for Transfer Students
    const transferCheck = checkTransferCredits(student);
    if (transferCheck) warnings.push(transferCheck);

    // §A3.3 — 32 advanced standing credits max (AP + exams + prior college for first-years)
    // Source: General CAS academic rules.md → Dual Enrollment
    const advancedCheck = checkAdvancedStandingCredits(student);
    if (advancedCheck) warnings.push(advancedCheck);

    // §A3.5 — 32 P/F credits max career
    // Source: General CAS academic rules.md → Pass/Fail Option
    const pfCheck = checkPassFailCredits(student);
    if (pfCheck) warnings.push(pfCheck);

    // §A1.4 — 32 CSCI-UA credits minimum (CS major only)
    // Source: Major rules CS BA major → "minimum of 32 credits with the CSCI-UA designation"
    if (options?.isCSMajor) {
        const csciCheck = checkCSCICredits(student, courses);
        if (csciCheck) warnings.push(csciCheck);
    }

    return warnings;
}

// ---- Individual Validators ----

/**
 * §A3.2: At least 64 credits must have the -UA suffix.
 * Source: "64 credits minimum must have the -UA suffix (CAS courses)"
 */
export function checkResidencyCredits(student: StudentProfile): CreditCapWarning | null {
    const ua = student.uaSuffixCredits;
    if (ua === undefined) return null; // Not tracked yet
    if (ua < 64) {
        return {
            type: "residency_ua",
            current: ua,
            limit: 64,
            direction: "below_minimum",
            message: `Residency requirement: ${ua}/64 UA-suffix credits completed. Need ${64 - ua} more CAS courses.`,
        };
    }
    return null;
}

/**
 * §A3.3: Maximum 16 credits from non-CAS NYU schools.
 * Source: "Courses at Other Schools and Divisions of New York University"
 */
export function checkNonCASCredits(student: StudentProfile): CreditCapWarning | null {
    const nonCAS = student.nonCASNYUCredits;
    if (nonCAS === undefined) return null;
    if (nonCAS > 16) {
        return {
            type: "non_cas_max",
            current: nonCAS,
            limit: 16,
            direction: "above_maximum",
            message: `Non-CAS NYU credit limit exceeded: ${nonCAS}/16 credits. Only 16 credits from other NYU schools count toward degree.`,
        };
    }
    return null;
}

/**
 * §A3.3: Maximum 24 online credits toward degree.
 * Source: "Credit for Online Courses" — raised from 16 in Fall 2024
 */
export function checkOnlineCredits(student: StudentProfile): CreditCapWarning | null {
    const online = student.onlineCredits;
    if (online === undefined) return null;
    if (online > 24) {
        return {
            type: "online_max",
            current: online,
            limit: 24,
            direction: "above_maximum",
            message: `Online credit limit exceeded: ${online}/24 credits. Maximum 24 online credits count toward degree.`,
        };
    }
    return null;
}

/**
 * §A3.3: Maximum 64 transfer credits.
 * Source: "Credit for Transfer Students" — max 64 credits transferred
 */
export function checkTransferCredits(student: StudentProfile): CreditCapWarning | null {
    const totalTransfer = computeTransferCredits(student);
    if (totalTransfer > 64) {
        return {
            type: "transfer_max",
            current: totalTransfer,
            limit: 64,
            direction: "above_maximum",
            message: `Transfer credit limit exceeded: ${totalTransfer}/64 credits. Maximum 64 transfer credits allowed.`,
        };
    }
    return null;
}

/**
 * §A3.3 / §A5.5: Maximum 32 advanced standing credits (AP/IB/A-Level + prior college for first-years).
 * Source: "no more than 32 advanced standing credits; this limit includes both credits from
 *          Advanced Placement and similar examinations and previous college credits"
 */
export function checkAdvancedStandingCredits(student: StudentProfile): CreditCapWarning | null {
    const totalTransfer = computeTransferCredits(student);
    if (totalTransfer > 32) {
        return {
            type: "advanced_standing_max",
            current: totalTransfer,
            limit: 32,
            direction: "above_maximum",
            message: `Advanced standing limit exceeded: ${totalTransfer}/32 credits from AP/IB/A-Level/prior college. Maximum 32 for first-year matriculants.`,
        };
    }
    return null;
}

/**
 * §A3.5: Maximum 32 P/F credits total career.
 * Source: "no more than 32 credits are graded on a pass/fail basis"
 */
export function checkPassFailCredits(student: StudentProfile): CreditCapWarning | null {
    const pf = student.passfailCredits;
    if (pf === undefined) return null;
    if (pf > 32) {
        return {
            type: "passfail_max",
            current: pf,
            limit: 32,
            direction: "above_maximum",
            message: `Pass/Fail credit limit exceeded: ${pf}/32 credits. Maximum 32 P/F credits allowed across entire career.`,
        };
    }
    return null;
}

/**
 * §A1.4: CS BA major requires minimum 32 CSCI-UA credits.
 * Source: "minimum of 32 credits with the CSCI-UA designation"
 *
 * Counts CSCI-UA credits from courses with grade C or higher (per CS major policy).
 */
export function checkCSCICredits(
    student: StudentProfile,
    courses: Course[]
): CreditCapWarning | null {
    const MAJOR_GRADES = new Set(["A", "A-", "B+", "B", "B-", "C+", "C"]);
    const courseCatalog = new Map(courses.map((c) => [c.id, c]));

    let csciCredits = 0;
    for (const ct of student.coursesTaken) {
        if (!MAJOR_GRADES.has(ct.grade.toUpperCase())) continue;
        const course = courseCatalog.get(ct.courseId);
        const isCSCI = course
            ? course.departments.includes("CSCI-UA")
            : ct.courseId.startsWith("CSCI-UA");
        if (isCSCI) {
            csciCredits += course?.credits ?? ct.credits ?? 4;
        }
    }

    if (csciCredits < 32) {
        return {
            type: "csci_minimum",
            current: csciCredits,
            limit: 32,
            direction: "below_minimum",
            message: `CS major residency: ${csciCredits}/32 CSCI-UA credits completed. Need ${32 - csciCredits} more CSCI-UA credits.`,
        };
    }
    return null;
}

// ---- Helpers ----

function computeTransferCredits(student: StudentProfile): number {
    let total = student.genericTransferCredits ?? 0;
    if (student.transferCourses) {
        for (const tc of student.transferCourses) {
            total += tc.credits;
        }
    }
    return total;
}
