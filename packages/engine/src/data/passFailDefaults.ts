// ============================================================
// passFailDefaults.ts — client-safe per-school P/F config map
// ============================================================
// A NODE-FREE static inline map of each school's PassFailConfig, extracted
// from `data/schools/<id>.json`. The full configs are loaded server-side via
// `schoolConfigLoader.ts` (node:fs / node:url). This module exists so the
// CLIENT slot-action matrix can pre-disable the Pass/Fail button at a
// `canElect:false` school (e.g. Tandon) without touching any Node API.
//
// SOURCE OF TRUTH: `data/schools/*.json` (repo root). Keep this file in sync
// whenever a school's `passFail` block changes in the JSON files.
//
// ZERO imports — this is a pure data module (verified). Do NOT add imports.
// Re-exported via `@nyupath/engine/client` (packages/engine/src/client.ts).
// ============================================================

import type { PassFailConfig } from "@nyupath/shared";

/**
 * Per-school PassFailConfig keyed by the canonical school id (lowercase).
 * Sourced verbatim from `data/schools/<id>.json#passFail`.
 * Schools absent here have no passFail block in their JSON config — callers
 * should treat an absent entry as "unknown" (not explicitly false).
 */
const PASS_FAIL_CONFIGS: Record<string, PassFailConfig> = {
    cas: {
        careerLimitType: "credits",
        careerLimitValue: 32,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/arts-science/academic-policies/_index.md:410",
        perTermLimit: 1,
        perTermUnit: "semester",
        countsForMajor: false,
        countsForMinor: false,
        countsForGenEd: false,
        excludedCourseTypes: [],
        canElect: true,
        autoExcludedFromLimit: [],
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        exceptions: ["FL courses not used for FL requirement are P/F-eligible"],
    },

    gallatin: {
        careerLimitType: "courses",
        careerLimitValue: 4,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/individualized-study/academic-policies/_index.md:60",
        perTermLimit: 1,
        perTermUnit: "academic_year",
        countsForMajor: false,
        countsForMinor: false,
        excludedCourseTypes: [
            "liberal_arts_requirement",
            "historical_cultural_requirement",
            "first_year_seminar",
            "senior_project",
            "travel_course",
        ],
        canElect: true,
        autoExcludedFromLimit: ["private_lessons"],
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        exceptions: [
            "Pass/Fail option may be used once per full-time academic year (once within 32 credits) and a maximum of four times during the academic career.",
            "Courses graded with P do not count toward the Dean's List 12-credit graded minimum.",
        ],
    },

    liberal_studies: {
        careerLimitType: "credits",
        careerLimitValue: 16,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/liberal-studies/academic-policies/_index.md:205",
        perTermLimit: 1,
        perTermUnit: "semester",
        countsForMajor: false,
        countsForMinor: false,
        countsForGenEd: false,
        creditType: "elective_only",
        canElect: true,
        autoExcludedFromLimit: [],
        excludedCourseTypes: [
            "ls_core_curriculum",
            "major_required",
            "minor_required",
            "college_core_curriculum",
        ],
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        exceptions: [
            "One P/F option per term including summer sessions; cumulative cap 16 credits while a degree candidate in LS",
            "Not available for courses completed at other institutions",
            "Not permitted for any required course (LS Core, major/minor required, College Core Curriculum or other-school core)",
            "Election deadline: before completion of the 9th week of the term (3rd week of a six-week summer session); cannot be reversed once elected",
        ],
    },

    nursing: {
        careerLimitType: "percent_of_program",
        careerLimitValue: 25,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/nursing/academic-policies/_index.md (25% of program)",
        countsForMajor: false,
        countsForGenEd: false,
        creditType: "elective_only",
        excludedCourseTypes: [
            "core_ua",
            "intro_to_psychology",
            "science",
            "nursing_prerequisite",
            "nursing_sequence",
        ],
        canElect: true,
        autoExcludedFromLimit: [],
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        exceptions: [
            "Nursing cohort seminar is taken Pass/Fail and is a graduation requirement",
            "Liberal arts electives only; subject to the policy of the school offering the course and adviser approval",
        ],
    },

    nyuad: {
        careerLimitType: "courses",
        careerLimitValue: 3,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/abu-dhabi/academic-policies/_index.md (3-course career)",
        perTermLimit: 1,
        perTermUnit: "semester",
        countsForMajor: false,
        countsForMinor: false,
        countsForGenEd: false,
        excludedCourseTypes: ["jterm", "summer", "corequisite"],
        canElect: true,
        autoExcludedFromLimit: [],
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        exceptions: [
            "Available only beginning in the second year of study",
            "Electives only — major, minor, and Core courses (incl. E, Q, X, J, Colloquium) cannot be taken P/F",
            "First attempt in any Core area must be letter-graded",
            "A P/F course cannot satisfy a prerequisite",
            "J-Term and summer courses may not be taken P/F",
        ],
    },

    shanghai: {
        careerLimitType: "credits",
        careerLimitValue: null,
        careerLimitSourceRef: "no published career cap on file → hedge",
        perTermLimit: 1,
        perTermUnit: "semester",
        countsForMajor: false,
        countsForMinor: false,
        countsForGenEd: false,
        excludedCourseTypes: [],
        canElect: true,
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        exceptions: [
            "Chinese language (through Intermediate II) and English for Academic Purposes courses cannot be taken P/F",
            "Courses in other languages and Advanced Chinese can be taken P/F, but a grade of C or higher (not P) is required to satisfy a prerequisite for a higher-level course",
        ],
    },

    sps: {
        careerLimitType: "credits",
        careerLimitValue: 16,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/professional-studies/academic-policies/_index.md",
        perTermLimit: 1,
        perTermUnit: "semester",
        countsForMajor: false,
        countsForMinor: false,
        countsForGenEd: false,
        excludedCourseTypes: ["TCHT1-UC", "TCSM1-UC", "REBS1-UC"],
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        exceptions: [
            "Division of Applied Undergraduate Studies: Pass/Fail applies only to elective courses",
            "Pass/Fail election must be made prior to completion of the ninth week of the term",
        ],
    },

    steinhardt: {
        careerLimitType: "percent_of_program",
        careerLimitValue: 25,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/culture-education-human-development/academic-policies/_index.md (25% of program)",
    },

    stern: {
        careerLimitType: "courses",
        careerLimitValue: 4,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/business/academic-policies/_index.md:398",
        perTermLimit: 1,
        perTermUnit: "academic_year",
        countsForMajor: true,
        countsForMinor: true,
        canElect: true,
        autoExcludedFromLimit: ["IBEX", "CLP"],
        excludedCourseTypes: ["stern_graduate", "bfa_film_tv"],
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        warnings: [
            "May impact enrollment in upper-level CAS math/CS courses",
            "May impact Dean's List, Valedictorian, honors eligibility",
        ],
    },

    tandon: {
        careerLimitType: "credits",
        careerLimitValue: null,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/engineering/academic-policies/_index.md:218 — no cap; canElect:false",
        perTermLimit: null,
        perTermUnit: "semester",
        countsForMajor: false,
        countsForMinor: false,
        creditType: "elective_only",
        canElect: false,
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        note: "Students cannot elect P/F. Only courses already designated P/F are allowed, and they count only as Free Elective credit.",
    },

    tisch: {
        careerLimitType: "credits",
        careerLimitValue: 32,
        careerLimitSourceRef:
            "bulletin-raw/undergraduate/arts/academic-policies/_index.md:438",
        perTermLimit: 1,
        perTermUnit: "semester",
        countsForMajor: false,
        countsForMinor: false,
        countsForGenEd: false,
        excludedCourseTypes: [],
        canElect: true,
        autoExcludedFromLimit: [],
        gradePassEquivalent: "D",
        failCountsInGpa: true,
        exceptions: [
            "Tisch courses specifically designed to be pass/fail are excluded from the 32-credit maximum",
        ],
    },
};

/**
 * Return the PassFailConfig for a school, or `undefined` when the school is
 * unknown or has no authored P/F config.
 *
 * Callers should treat `undefined` as "unknown" (NOT the same as
 * `canElect: false`). The `slotActionMatrix` function already treats an absent
 * `passFail` arg as "unknown → not explicitly blocked".
 *
 * @param homeSchool - The canonical home-school id (case-insensitive),
 *   e.g. "tandon", "cas", "stern". Matches the keys in SCHOOL_DISPLAY_NAMES.
 */
export function passFailForSchool(
    homeSchool: string | undefined,
): PassFailConfig | undefined {
    if (!homeSchool) return undefined;
    return PASS_FAIL_CONFIGS[homeSchool.toLowerCase()];
}
