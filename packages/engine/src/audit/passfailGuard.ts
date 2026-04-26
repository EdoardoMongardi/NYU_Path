// ============================================================
// Pass/Fail Guard — Detect P/F violations in major, Core
// ============================================================
// Sources: SKILL.md §A1.4 (CS major), §A2.2 (Core), §A3.5 (general P/F)
// All rules from: Original rules/Major rules CS BA major
//                 Original rules/CAS core rules.md
//                 Original rules/General CAS academic rules.md
//
// Phase 1 Step A: P/F limits + CS-not-applicable list moved into CAS_DEFAULTS.
// Phase 1 Step D: career credit limit + per-term limit read from SchoolConfig
// when supplied (only careerLimitType="credits" is honored at v1; "courses"
// and "percent_of_program" fall through to the CAS-credit default).
// ============================================================

import type { CourseTaken, Rule, Course, SchoolConfig } from "@nyupath/shared";

// ---- CAS defaults (Phase 1 Step A: extracted, not yet config-driven) ----
const CAS_DEFAULTS = {
    passFail: {
        careerLimit: 32,
        perTermLimit: 1,
    },
    csNotApplicable: [
        "CSCI-UA 2", "CSCI-UA 4", "CSCI-UA 60", "CSCI-UA 61",
        "CSCI-UA 330", "CSCI-UA 380", "CSCI-UA 381",
        "CSCI-UA 520", "CSCI-UA 521",
        "CSCI-UA 897", "CSCI-UA 898",
        "CSCI-UA 997", "CSCI-UA 998",
    ] as const,
} as const;

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
    courses: Course[],
    schoolConfig: SchoolConfig | null = null,
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
    const CS_NOT_APPLICABLE: ReadonlySet<string> = new Set(CAS_DEFAULTS.csNotApplicable);

    // Track P/F per term for the 1-per-term check. The bucket key honors
    // SchoolConfig.passFail.perTermUnit: "semester" → raw ct.semester
    // ("2024-fall"); "academic_year" → "AY-<startYear>" where AY runs
    // fall→summer (e.g., 2024-fall, 2025-spring, 2025-summer all map to
    // "AY-2024"). Stern uses academic_year; CAS/Tisch use semester.
    const perTermUnit: "semester" | "academic_year" =
        schoolConfig?.passFail?.perTermUnit ?? "semester";
    const pfPerTerm = new Map<string, string[]>();
    let totalPFCredits = 0;

    for (const ct of coursesTaken) {
        // Only check courses with P/F grade mode or grade "P"
        const isPF = ct.gradeMode === "pf" || ct.grade.toUpperCase() === "P";
        if (!isPF) continue;

        const course = courseCatalog.get(ct.courseId);
        const credits = course?.credits ?? ct.credits ?? 4;
        totalPFCredits += credits;

        // Track per-bucket usage (semester or academic-year, per SchoolConfig)
        const bucket = bucketForTerm(ct.semester, perTermUnit);
        const termList = pfPerTerm.get(bucket) ?? [];
        termList.push(ct.courseId);
        pfPerTerm.set(bucket, termList);

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

    // Check: P/F credit career maximum
    // SchoolConfig.passFail may use a non-credit limit (Stern: courses,
    // Steinhardt/Nursing: percent_of_program). The Phase 1 Step D wiring
    // only honors the "credits" form here; non-credit forms fall through
    // to the CAS default (32 credits) until a per-school checker lands.
    const careerLimitFromCfg =
        schoolConfig?.passFail?.careerLimitType === "credits"
            ? schoolConfig.passFail.careerLimit
            : null;
    const careerLimit =
        typeof careerLimitFromCfg === "number"
            ? careerLimitFromCfg
            : CAS_DEFAULTS.passFail.careerLimit;
    if (totalPFCredits > careerLimit) {
        violations.push({
            courseId: "",
            reason: `Pass/Fail career limit exceeded: ${totalPFCredits}/${careerLimit} credits. [GEN-ACAD]`,
            severity: "error",
        });
    }

    // Check: P/F per-term limit. Honor SchoolConfig.passFail.perTermLimit
    // when present; null/undefined => use CAS default (1/term).
    const perTermLimit =
        typeof schoolConfig?.passFail?.perTermLimit === "number"
            ? schoolConfig.passFail.perTermLimit
            : CAS_DEFAULTS.passFail.perTermLimit;
    for (const [term, pfCourses] of pfPerTerm) {
        if (pfCourses.length > perTermLimit) {
            const unitLabel = perTermUnit === "academic_year" ? "academic year" : "term";
            violations.push({
                courseId: pfCourses[perTermLimit], // Flag the first violator
                reason: `Only ${perTermLimit} Pass/Fail course${perTermLimit === 1 ? "" : "s"} allowed per ${unitLabel}. Found ${pfCourses.length} in ${term}. [GEN-ACAD]`,
                severity: "error",
            });
        }
    }

    return violations;
}

// ---- Helpers ----

/**
 * Map a semester string ("2024-fall", "2025-spring", "2025-summer",
 * "2025-january") to its bucket under the given perTermUnit.
 *
 * NYU academic year is fall → spring → summer (e.g., AY 2024 = 2024-fall,
 * 2025-spring, 2025-summer). January-term sits inside the same AY as the
 * preceding fall: 2025-january is in AY 2024. Unparseable strings are
 * passed through verbatim so callers can still bucket on raw input.
 */
function bucketForTerm(semester: string, unit: "semester" | "academic_year"): string {
    if (unit === "semester") return semester;
    const m = semester.match(/^(\d{4})-(fall|spring|summer|january)$/i);
    if (!m) return semester;
    const year = Number(m[1]);
    const season = m[2]!.toLowerCase();
    // fall keeps its calendar year; spring/summer/january roll back to the
    // prior calendar year so they share an AY bucket with the preceding fall.
    const ayStart = season === "fall" ? year : year - 1;
    return `AY-${ayStart}`;
}

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
