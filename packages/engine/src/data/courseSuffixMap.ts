// ============================================================
// Course-suffix → School / Accessibility map (Phase 10 Stage 2)
// ============================================================
// NYU course IDs encode the offering school in the suffix after the
// dash:
//   CSCI-UA  101  → CAS undergraduate
//   FINC-UB  001  → Stern undergraduate
//   ENGR-UY  1004 → Tandon undergraduate
//   CSCI-GA  3033 → GSAS graduate (closed to undergrads except by
//                                   petition)
//   ARTH-UH  100  → NYU Abu Dhabi (study-abroad-only)
//
// Phase 9.5 stored these maps as inline literals in
// searchCourses.ts. Phase 10 moves them here to a single source of
// truth + adds explicit "data, not prose" semantics: when a new
// suffix appears in the catalog (e.g., a new degree program at a
// global site), one file changes.
// ============================================================

export interface SchoolMeta {
    school: string;
    undergrad: boolean;
    /** When set, the course is taught at an NYU portal campus. */
    globalSite: "abudhabi" | "shanghai" | null;
}

/**
 * Map from the 2-3 letter suffix following the dash to school metadata.
 * Keep in sync with NYU's class-search subject directory.
 */
export const SUFFIX_META: Readonly<Record<string, SchoolMeta>> = {
    "UA":  { school: "CAS",                            undergrad: true,  globalSite: null },
    "UB":  { school: "Stern (undergrad)",              undergrad: true,  globalSite: null },
    "UY":  { school: "Tandon (undergrad)",             undergrad: true,  globalSite: null },
    "UE":  { school: "Steinhardt (undergrad)",         undergrad: true,  globalSite: null },
    "UF":  { school: "Tisch (undergrad)",              undergrad: true,  globalSite: null },
    "UT":  { school: "Tisch (undergrad, alt)",         undergrad: true,  globalSite: null },
    "UN":  { school: "Gallatin",                       undergrad: true,  globalSite: null },
    "UP":  { school: "Liberal Studies",                undergrad: true,  globalSite: null },
    "UH":  { school: "NYU Abu Dhabi",                  undergrad: true,  globalSite: "abudhabi" },
    "SHU": { school: "NYU Shanghai",                   undergrad: true,  globalSite: "shanghai" },
    "GA":  { school: "GSAS (graduate)",                undergrad: false, globalSite: null },
    "GY":  { school: "Tandon (graduate)",              undergrad: false, globalSite: null },
    "GU":  { school: "Steinhardt (graduate)",          undergrad: false, globalSite: null },
    "GH":  { school: "Steinhardt (graduate)",          undergrad: false, globalSite: null },
    "GX":  { school: "Cross-school (graduate)",        undergrad: false, globalSite: null },
    "GB":  { school: "Stern (graduate)",               undergrad: false, globalSite: null },
    "GS":  { school: "SPS (graduate)",                 undergrad: false, globalSite: null },
    "MD":  { school: "Medical School",                 undergrad: false, globalSite: null },
    "MS":  { school: "Medical School",                 undergrad: false, globalSite: null },
    "DN":  { school: "Dental",                         undergrad: false, globalSite: null },
    "BMSC":{ school: "Biomedical Sciences (graduate)", undergrad: false, globalSite: null },
    "BMIN":{ school: "Biomedical Informatics (grad)",  undergrad: false, globalSite: null },
    "LW":  { school: "Law",                            undergrad: false, globalSite: null },
};

export const HOME_SCHOOL_TO_SUFFIX: Readonly<Record<string, string>> = {
    "cas":        "UA",
    "stern":      "UB",
    "tandon":     "UY",
    "steinhardt": "UE",
    "tisch":      "UF",
    "gallatin":   "UN",
    "ls":         "UP",
};

export type Accessibility = "home" | "cross_school" | "global_site" | "graduate" | "unknown";

export interface AccessibilityResult {
    school: string;
    accessibility: Accessibility;
    note?: string;
}

/**
 * Classify a course ID for cross-school accessibility relative to the
 * student's home school. Mirrors the legacy classifyCourse() from
 * searchCourses.ts but lives in the data layer.
 */
export function classifyCourseAccessibility(
    courseId: string,
    homeSchool: string | undefined,
): AccessibilityResult {
    const m = courseId.match(/-([A-Z]+)\b/);
    if (!m) return { school: "Unknown", accessibility: "unknown" };
    const suffix = m[1]!;
    const meta = SUFFIX_META[suffix] ?? SUFFIX_META[suffix.slice(-2)];
    if (!meta) return { school: `Subject "${suffix}"`, accessibility: "unknown" };
    if (!meta.undergrad) {
        return {
            school: meta.school,
            accessibility: "graduate",
            note: "graduate course — not open to undergrads except by petition",
        };
    }
    if (meta.globalSite) {
        return {
            school: meta.school,
            accessibility: "global_site",
            note: `${meta.school} site — only available during a study-abroad term`,
        };
    }
    const homeSuffix = homeSchool ? HOME_SCHOOL_TO_SUFFIX[homeSchool.toLowerCase()] : undefined;
    const studentSchool = homeSuffix && SUFFIX_META[homeSuffix]?.school;
    if (homeSuffix && studentSchool && meta.school === studentSchool) {
        return { school: meta.school, accessibility: "home" };
    }
    return {
        school: meta.school,
        accessibility: "cross_school",
        note: `cross-school course — your home school may require approval to count it toward your degree`,
    };
}
