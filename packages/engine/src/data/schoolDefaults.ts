// ============================================================
// Shared NYU-undergrad registration defaults + school display names
// ============================================================
// Improvement plan, Phase E (de-CAS). NYU Path is for ALL undergraduate
// schools, not just CAS. Most per-school caps a student needs are
// already in their DPR (creditsRequired, cumulativeGpaRequired,
// residencyRequired, passFailCapUnits, outsideHomeCapUnits,
// timeLimitYears), so the system reads those per-student rather than
// authoring a config file per school.
//
// Two registration constants are genuinely NOT in the DPR and are
// near-universal across NYU undergrad: the per-semester credit ceiling
// (~18) and the F-1 full-time floor (~12). They live here as a single
// shared default so a student whose school has no authored config still
// gets a sane answer. A school that genuinely differs can be added to
// the sparse override map rather than authoring a whole config file.
// ============================================================

/** Near-universal NYU-undergrad per-semester credit ceiling. A school
 *  that genuinely differs goes in PER_SEMESTER_CEILING_OVERRIDES. */
export const DEFAULT_PER_SEMESTER_CEILING = 18;

/** Default planner pacing target credits/semester when a school config
 *  does not author a per-school override. 16 is the near-universal
 *  NYU undergrad norm; schools can override via SchoolConfig.creditTargetPerSemester. */
export const DEFAULT_CREDIT_TARGET_PER_SEMESTER = 16;

/** Default domestic part-time floor credits/semester when a school config
 *  does not author a per-school override. Schools can override via
 *  SchoolConfig.domesticPartTimeFloor. */
export const DEFAULT_DOMESTIC_PARTTIME_FLOOR = 8;

/** F-1 full-time minimum credits/semester (NYU OGS guidance). */
export const DEFAULT_F1_FULLTIME_MIN_CREDITS = 12;

/** Sparse overrides — ONLY schools that actually differ from the
 *  near-universal default. Empty today; add entries as real exceptions
 *  surface, instead of authoring a per-school config file. */
export const PER_SEMESTER_CEILING_OVERRIDES: Record<string, number> = {};

/** The per-semester ceiling for a home school: a real override if one
 *  exists, otherwise the shared default. */
export function perSemesterCeilingFor(homeSchool: string | undefined): number {
    if (!homeSchool) return DEFAULT_PER_SEMESTER_CEILING;
    return PER_SEMESTER_CEILING_OVERRIDES[homeSchool.toLowerCase()] ?? DEFAULT_PER_SEMESTER_CEILING;
}

/** Full, user-facing display names per home-school id. Used by the
 *  system prompt (agent self-introduction) and `get_credit_caps` so the
 *  product reads correctly for non-CAS students. */
export const SCHOOL_DISPLAY_NAMES: Record<string, string> = {
    cas: "NYU College of Arts & Science",
    stern: "NYU Stern School of Business",
    tandon: "NYU Tandon School of Engineering",
    tisch: "NYU Tisch School of the Arts",
    steinhardt: "NYU Steinhardt School of Culture, Education, and Human Development",
    gallatin: "NYU Gallatin School of Individualized Study",
    liberal_studies: "NYU Liberal Studies",
    sps: "NYU School of Professional Studies",
    nursing: "NYU Rory Meyers College of Nursing",
    nyuad: "NYU Abu Dhabi",
    shanghai: "NYU Shanghai",
};

/** Display name for a home-school id; falls back to a generic "NYU"
 *  rather than asserting a specific school we can't confirm. */
export function schoolDisplayName(homeSchool: string | undefined): string {
    if (!homeSchool) return "NYU";
    return SCHOOL_DISPLAY_NAMES[homeSchool.toLowerCase()] ?? "NYU";
}
