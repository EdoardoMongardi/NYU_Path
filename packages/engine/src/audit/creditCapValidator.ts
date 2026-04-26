// ============================================================
// Credit Cap Validator — Deterministic credit limit checks
// ============================================================
// Sources: SKILL.md §A3.2 (Residency), §A3.3 (Caps), §A3.5 (P/F), §A1.4 (CSCI-UA)
// All rules from: Original rules/General CAS academic rules.md
//                 Original rules/Major rules CS BA major
//
// Phase 1 Step A: Constants moved out of function bodies into CAS_DEFAULTS.
// Phase 1 Step D: each check function takes an optional SchoolConfig and
// reads from it when present, falling back to CAS_DEFAULTS when null.
// ============================================================

import type { StudentProfile, Course, SchoolConfig, CreditCap, CreditCapType } from "@nyupath/shared";

// ---- CAS defaults (Phase 1 Step A: extracted, not yet config-driven) ----
//
// IMPORTANT: do not introduce non-CAS values here. This constant exists ONLY
// to localize the existing CS/CAS hardcoding in one place. The runtime
// SchoolConfig threads through each check; these values are the fallback
// when no config is provided.
const CAS_DEFAULTS = {
    residency: {
        suffix: "-UA",
        minCredits: 64,
    },
    creditCaps: {
        nonHomeSchoolMax: 16,
        onlineMax: 24,
        transferMax: 64,
        advancedStandingMax: 32,
    },
    passFail: {
        careerLimit: 32,
    },
    csMajor: {
        csciMinCredits: 32,
        csciDept: "CSCI-UA",
        passingGrades: ["A", "A-", "B+", "B", "B-", "C+", "C"] as const,
    },
} as const;

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
    options?: { isCSMajor?: boolean; schoolConfig?: SchoolConfig | null }
): CreditCapWarning[] {
    const warnings: CreditCapWarning[] = [];
    const cfg = options?.schoolConfig ?? null;

    // §A3.2 — UA-suffix residency minimum
    const uaCheck = checkResidencyCredits(student, cfg);
    if (uaCheck) warnings.push(uaCheck);

    // §A3.3 — non-CAS NYU credits max
    const nonCASCheck = checkNonCASCredits(student, cfg);
    if (nonCASCheck) warnings.push(nonCASCheck);

    // §A3.3 — online credits max
    const onlineCheck = checkOnlineCredits(student, cfg);
    if (onlineCheck) warnings.push(onlineCheck);

    // §A3.3 — transfer credits max
    const transferCheck = checkTransferCredits(student, cfg);
    if (transferCheck) warnings.push(transferCheck);

    // §A3.3 — advanced standing credits max
    const advancedCheck = checkAdvancedStandingCredits(student, cfg);
    if (advancedCheck) warnings.push(advancedCheck);

    // §A3.5 — P/F credits max career
    const pfCheck = checkPassFailCredits(student, cfg);
    if (pfCheck) warnings.push(pfCheck);

    // §A1.4 — CSCI-UA credits minimum (CS major only)
    if (options?.isCSMajor) {
        const csciCheck = checkCSCICredits(student, courses);
        if (csciCheck) warnings.push(csciCheck);
    }

    return warnings;
}

// ---- SchoolConfig-aware lookups (CAS fallback when cfg is null) ----

function residencyMin(cfg: SchoolConfig | null): number {
    return cfg?.residency.minCredits ?? CAS_DEFAULTS.residency.minCredits;
}

function findCreditCapMax(cfg: SchoolConfig | null, type: CreditCapType): number | null {
    if (!cfg?.creditCaps) return null;
    const cap = cfg.creditCaps.find((c: CreditCap) => c.type === type);
    return cap?.maxCredits ?? null;
}

function nonHomeSchoolMax(cfg: SchoolConfig | null): number {
    return findCreditCapMax(cfg, "non_home_school") ?? CAS_DEFAULTS.creditCaps.nonHomeSchoolMax;
}
function onlineMax(cfg: SchoolConfig | null): number {
    return findCreditCapMax(cfg, "online") ?? CAS_DEFAULTS.creditCaps.onlineMax;
}
function transferMax(cfg: SchoolConfig | null): number {
    return findCreditCapMax(cfg, "transfer") ?? CAS_DEFAULTS.creditCaps.transferMax;
}
function advancedStandingMax(cfg: SchoolConfig | null): number {
    return findCreditCapMax(cfg, "advanced_standing") ?? CAS_DEFAULTS.creditCaps.advancedStandingMax;
}
function passfailCareerLimit(cfg: SchoolConfig | null): number {
    const limit = cfg?.passFail?.careerLimit;
    if (typeof limit === "number") return limit;
    return CAS_DEFAULTS.passFail.careerLimit;
}

// ---- Individual Validators ----

/**
 * §A3.2: At least N credits must have the residency suffix.
 * CAS source: "64 credits minimum must have the -UA suffix (CAS courses)"
 */
export function checkResidencyCredits(
    student: StudentProfile,
    cfg: SchoolConfig | null = null,
): CreditCapWarning | null {
    const ua = student.uaSuffixCredits;
    if (ua === undefined) return null; // Not tracked yet
    const limit = residencyMin(cfg);
    if (ua < limit) {
        const suffix = cfg?.residency?.suffix ?? CAS_DEFAULTS.residency.suffix;
        const schoolLabel = cfg?.name ?? "home-school";
        return {
            type: "residency_ua",
            current: ua,
            limit,
            direction: "below_minimum",
            message: `Residency requirement: ${ua}/${limit} ${suffix} credits completed. Need ${limit - ua} more ${schoolLabel} courses.`,
        };
    }
    return null;
}

/**
 * §A3.3: Maximum N credits from non-CAS NYU schools.
 * CAS source: "Courses at Other Schools and Divisions of New York University"
 */
export function checkNonCASCredits(
    student: StudentProfile,
    cfg: SchoolConfig | null = null,
): CreditCapWarning | null {
    const nonCAS = student.nonCASNYUCredits;
    if (nonCAS === undefined) return null;
    const limit = nonHomeSchoolMax(cfg);
    if (nonCAS > limit) {
        return {
            type: "non_cas_max",
            current: nonCAS,
            limit,
            direction: "above_maximum",
            message: `Non-CAS NYU credit limit exceeded: ${nonCAS}/${limit} credits. Only ${limit} credits from other NYU schools count toward degree.`,
        };
    }
    return null;
}

/**
 * §A3.3: Maximum N online credits toward degree.
 * CAS source: "Credit for Online Courses" — raised from 16 in Fall 2024
 */
export function checkOnlineCredits(
    student: StudentProfile,
    cfg: SchoolConfig | null = null,
): CreditCapWarning | null {
    const online = student.onlineCredits;
    if (online === undefined) return null;
    const limit = onlineMax(cfg);
    if (online > limit) {
        return {
            type: "online_max",
            current: online,
            limit,
            direction: "above_maximum",
            message: `Online credit limit exceeded: ${online}/${limit} credits. Maximum ${limit} online credits count toward degree.`,
        };
    }
    return null;
}

/**
 * §A3.3: Maximum N transfer credits.
 * CAS source: "Credit for Transfer Students" — max 64 credits transferred
 */
export function checkTransferCredits(
    student: StudentProfile,
    cfg: SchoolConfig | null = null,
): CreditCapWarning | null {
    const totalTransfer = computeTransferCredits(student);
    const limit = transferMax(cfg);
    if (totalTransfer > limit) {
        return {
            type: "transfer_max",
            current: totalTransfer,
            limit,
            direction: "above_maximum",
            message: `Transfer credit limit exceeded: ${totalTransfer}/${limit} credits. Maximum ${limit} transfer credits allowed.`,
        };
    }
    return null;
}

/**
 * §A3.3 / §A5.5: Maximum N advanced standing credits (AP/IB/A-Level + prior college for first-years).
 * CAS source: "no more than 32 advanced standing credits; this limit includes both credits from
 *              Advanced Placement and similar examinations and previous college credits"
 */
export function checkAdvancedStandingCredits(
    student: StudentProfile,
    cfg: SchoolConfig | null = null,
): CreditCapWarning | null {
    const totalTransfer = computeTransferCredits(student);
    const limit = advancedStandingMax(cfg);
    if (totalTransfer > limit) {
        return {
            type: "advanced_standing_max",
            current: totalTransfer,
            limit,
            direction: "above_maximum",
            message: `Advanced standing limit exceeded: ${totalTransfer}/${limit} credits from AP/IB/A-Level/prior college. Maximum ${limit} for first-year matriculants.`,
        };
    }
    return null;
}

/**
 * §A3.5: Maximum N P/F credits total career.
 * CAS source: "no more than 32 credits are graded on a pass/fail basis"
 */
export function checkPassFailCredits(
    student: StudentProfile,
    cfg: SchoolConfig | null = null,
): CreditCapWarning | null {
    const pf = student.passfailCredits;
    if (pf === undefined) return null;
    const limit = passfailCareerLimit(cfg);
    if (pf > limit) {
        return {
            type: "passfail_max",
            current: pf,
            limit,
            direction: "above_maximum",
            message: `Pass/Fail credit limit exceeded: ${pf}/${limit} credits. Maximum ${limit} P/F credits allowed across entire career.`,
        };
    }
    return null;
}

/**
 * §A1.4: CS BA major requires minimum N CSCI-UA credits.
 * Source: "minimum of 32 credits with the CSCI-UA designation"
 *
 * Counts CSCI-UA credits from courses with grade C or higher (per CS major policy).
 */
export function checkCSCICredits(
    student: StudentProfile,
    courses: Course[]
): CreditCapWarning | null {
    const passingGrades: ReadonlySet<string> = new Set(CAS_DEFAULTS.csMajor.passingGrades);
    const csciDept = CAS_DEFAULTS.csMajor.csciDept;
    const limit = CAS_DEFAULTS.csMajor.csciMinCredits;
    const courseCatalog = new Map(courses.map((c) => [c.id, c]));

    let csciCredits = 0;
    for (const ct of student.coursesTaken) {
        if (!passingGrades.has(ct.grade.toUpperCase())) continue;
        const course = courseCatalog.get(ct.courseId);
        const isCSCI = course
            ? course.departments.includes(csciDept)
            : ct.courseId.startsWith(csciDept);
        if (isCSCI) {
            csciCredits += course?.credits ?? ct.credits ?? 4;
        }
    }

    if (csciCredits < limit) {
        return {
            type: "csci_minimum",
            current: csciCredits,
            limit,
            direction: "below_minimum",
            message: `CS major residency: ${csciCredits}/${limit} CSCI-UA credits completed. Need ${limit - csciCredits} more CSCI-UA credits.`,
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
