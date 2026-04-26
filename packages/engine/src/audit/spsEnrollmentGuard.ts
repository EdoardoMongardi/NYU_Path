// ============================================================
// SPS Enrollment Guard (Phase 2 §G47, §G61)
// ============================================================
// Determines whether a given SPS course (course id with -UC or -CE suffix)
// is enrollable by a student of a given home school, per the school's
// `SchoolConfig.spsPolicy`. SPS = School of Professional Studies.
//
// Authoritative bulletin sources for SPS policy ALREADY captured in each
// school config's `_provenance` array:
//   - CAS: data/schools/cas.json + bulletin L244-246
//   - Stern: data/schools/stern.json + bulletin L215 (TOTAL BAN)
//   - Tandon: data/schools/tandon.json + bulletin L167 (TOTAL BAN)
//   - Tisch (Phase 1 deferred — written in ARCHITECTURE §11.2 example only)
//
// Output is decision-grade: `enrollment` is "allowed" or "blocked", and
// when blocked the `reason` cites the policy that produced the decision.
// ============================================================

import type { Course, SchoolConfig } from "@nyupath/shared";

export type SpsDecision =
    | { enrollment: "allowed"; reason: string; creditType?: string }
    | { enrollment: "blocked"; reason: string; rule: SpsBlockRule };

export type SpsBlockRule =
    | "school_total_ban"
    | "prefix_not_in_allowlist"
    | "course_type_excluded";

/**
 * Decide whether a student in `homeSchoolConfig` can enroll in an SPS course.
 *
 * @param courseId          target course id, e.g. "REBS1-UC 1234" or "TCHT1-UC 50"
 * @param homeSchoolConfig  the student's home-school SchoolConfig (required —
 *                          callers must resolve via loadSchoolConfig before
 *                          invoking this guard; SPS policy has no defensible
 *                          fallback)
 * @param courseCatalog     optional — used to read the course's Course.tags
 *                          (e.g., "internship", "independent_study") that may
 *                          be excluded by spsPolicy.excludedCourseTypes
 *
 * Returns an SpsDecision. If the course is NOT an SPS course (no -UC/-CE
 * suffix), the decision is "allowed" with reason "not_an_sps_course"
 * because non-SPS course ids are out of scope for this guard — the
 * residency / non-home-school caps handle them elsewhere.
 */
export function decideSpsEnrollment(
    courseId: string,
    homeSchoolConfig: SchoolConfig,
    courseCatalog?: Map<string, Course>,
): SpsDecision {
    if (!isSpsCourse(courseId)) {
        return {
            enrollment: "allowed",
            reason: "not_an_sps_course",
        };
    }

    const policy = homeSchoolConfig.spsPolicy;

    // No policy defined → fail closed. Schools that fail to declare an
    // spsPolicy block SPS by default rather than silently allow.
    if (!policy) {
        return {
            enrollment: "blocked",
            rule: "school_total_ban",
            reason: `No SPS policy defined for ${homeSchoolConfig.schoolId}; SPS enrollment blocked by default.`,
        };
    }

    // Total ban (Stern, Tandon)
    if (policy.allowed === false) {
        return {
            enrollment: "blocked",
            rule: "school_total_ban",
            reason: `${homeSchoolConfig.name}: SPS courses are not allowed for credit toward the degree.`,
        };
    }

    // Allowlist check: course id must start with one of the allowed prefixes
    const allowedPrefixes = policy.allowedPrefixes ?? [];
    const matchedPrefix = allowedPrefixes.find((p) => courseId.startsWith(p));
    if (!matchedPrefix) {
        return {
            enrollment: "blocked",
            rule: "prefix_not_in_allowlist",
            reason:
                `${homeSchoolConfig.name}: ${courseId} is not in the SPS allowlist ` +
                `(allowed prefixes: ${allowedPrefixes.join(", ") || "none"}).`,
        };
    }

    // Excluded course types (e.g., CAS bans SPS internship + independent_study)
    const excludedTypes = policy.excludedCourseTypes ?? [];
    if (excludedTypes.length > 0 && courseCatalog) {
        const course = courseCatalog.get(courseId);
        const tags = courseTagsOf(course);
        const blockingTag = excludedTypes.find((t) => tags.includes(t));
        if (blockingTag) {
            return {
                enrollment: "blocked",
                rule: "course_type_excluded",
                reason:
                    `${homeSchoolConfig.name}: SPS ${blockingTag} courses cannot ` +
                    `be applied to the degree, even though ${courseId}'s prefix is allowed.`,
            };
        }
    }

    return {
        enrollment: "allowed",
        reason: `${courseId} matches allowlist prefix "${matchedPrefix}" for ${homeSchoolConfig.name}.`,
        creditType: policy.creditType,
    };
}

/**
 * SPS course detection. Per ARCHITECTURE.md §11.2 sps.json, SPS uses two
 * suffixes: -UC and -CE. Course ids that don't carry either are not SPS
 * courses for the purposes of this guard.
 */
export function isSpsCourse(courseId: string): boolean {
    return /-UC\b|-CE\b/.test(courseId);
}

/**
 * Read course "tags" used by the excluded-course-types check. The Course
 * type at v1.0 doesn't have a first-class `tags` field; this helper
 * inspects departments/title/id heuristically. Future revision: add a
 * proper Course.tags array sourced from FOSE keywords.
 */
function courseTagsOf(course: Course | undefined): string[] {
    if (!course) return [];
    const out: string[] = [];
    const titleLower = course.title?.toLowerCase() ?? "";
    if (titleLower.includes("internship")) out.push("internship");
    if (titleLower.includes("independent study")) out.push("independent_study");
    return out;
}
