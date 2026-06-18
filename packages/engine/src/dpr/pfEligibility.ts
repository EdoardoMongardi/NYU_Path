// ============================================================
// pfEligibility — per-school Pass/Fail requirement-category helper (G1.2)
// ============================================================
// Pure helper: answers "can a Pass/Fail course satisfy a requirement of this
// category at this school?" Used by applyPassFailToDpr (G1.3) to decide
// whether a re-graded P course should remain in / be removed from a
// requirement leaf's `coursesUsed[]`.
//
// DATA SOURCE: the single source of truth is each school's
// `data/schools/<schoolId>.json` passFail block — specifically the optional
// boolean fields:
//   passFail.countsForMajor  → true | false | undefined
//   passFail.countsForMinor  → true | false | undefined
//   passFail.countsForGenEd  → true | false | undefined
//   passFail.canElect        → true | false | undefined (undefined → can elect)
//
// RETURN VALUES (discriminated, not a boolean — preserves nuance):
//   "counts"       — P/F explicitly counts toward this requirement category
//   "elective_only" — P/F is ALLOWED but satisfies electives only (not this
//                    category's hard requirement). The course does not re-open
//                    the requirement leaf.
//   "defer"        — The policy is school-specific and the student MUST
//                    consult the department offering the requirement. The
//                    agent must hedge and never assume.
//   "unknown"      — The data is absent or ambiguous; fail-safe hedge.
//                    Never assume the course counts.
//
// LOGIC (in order):
//   1. category === "elective" → "counts" if canElect !== false, else
//      "unknown" (Tandon canElect:false means students cannot elect P/F at
//      all, so the outcome is uncertain even for electives).
//   2. DEFER overrides (explicit, cited, exhaustive table — do NOT expand
//      without a bulletin citation):
//        - gallatin/minor → "defer"
//          Source: NYU Gallatin bulletin, Pass/Fail Grade Option section:
//          "Students who have opted to complete a minor may not be able to
//          fulfill the minor requirements with courses graded with a pass (P)
//          grade; students should consult with the department offering the
//          minor for details."
//          data/bulletin-raw/undergraduate/individualized-study/
//            academic-policies/_index.md
//   3. Read the category-specific boolean from passFail:
//        major   → countsForMajor
//        minor   → countsForMinor
//        gen_ed  → countsForGenEd
//      Map: true → "counts", false → "elective_only", undefined → "unknown".
//   4. Unknown schoolId / missing config / no passFail block → "unknown".
//
// DATA GAP NOTES:
//   - SPS: bulletin explicit ("Pass/Fail option applies only to elective
//     courses", data/bulletin-raw/undergraduate/professional-studies/
//     academic-policies/_index.md). countsForMajor/Minor/GenEd:false added
//     to data/schools/sps.json in G1.2.
//   - Steinhardt: bulletin says "P/F can be applied to any course" but does
//     NOT explicitly state P/F satisfies a major requirement. countsForMajor/
//     Minor/GenEd left ABSENT → returns "unknown" → agent hedges. Correct
//     per core_philosophy.md (never invent a policy).
//   - Nursing: countsForMinor absent → returns "unknown" for minor.
//   - Gallatin + Stern: countsForGenEd absent → returns "unknown" for gen_ed.
//     Gallatin's core requirements are sui generis (not a "genEd" in the
//     standard sense); Stern's bulletin does not address gen_ed P/F.
//
// PURE: no I/O, no module state. loadSchoolConfig is called at call time
// with the canonical data/schools/ path (no caching needed for a helper
// this lightweight; production callers cache SchoolConfig upstream).
// ============================================================

import { loadSchoolConfig } from "../data/schoolConfigLoader.js";

/** The category of the requirement the student is trying to satisfy. */
export type PfCategory = "major" | "minor" | "gen_ed" | "elective";

/**
 * Whether a P/F-graded course can satisfy a requirement of `category`
 * at the given school.
 *
 * "counts"        — P/F explicitly counts.
 * "elective_only" — P/F is only elective credit (not this category).
 * "defer"         — school-specific rule requires adviser consultation.
 * "unknown"       — data absent or ambiguous; agent must hedge.
 */
export type PfEligibilityResult =
    | "counts"
    | "elective_only"
    | "defer"
    | "unknown";

// ---------------------------------------------------------------------------
// Defer-override table (exhaustive as of G1.2 — add only with a bulletin cite)
// ---------------------------------------------------------------------------
// Each entry: [schoolId, category] → "defer"
//
// gallatin/minor: bulletin (individualized-study/academic-policies/_index.md):
//   "Students who have opted to complete a minor may not be able to fulfill
//    the minor requirements with courses graded with a pass (P) grade;
//    students should consult with the department offering the minor for
//    details."
const DEFER_OVERRIDES: ReadonlyMap<string, ReadonlySet<PfCategory>> = new Map([
    [
        "gallatin",
        new Set<PfCategory>(["minor"]),
        // Source: NYU Gallatin Undergraduate Bulletin, "Pass/Fail Grade Option"
        // section, bullet: "Students who have opted to complete a minor may not
        // be able to fulfill the minor requirements with courses graded with a
        // pass (P) grade; students should consult with the department offering
        // the minor for details."
    ],
]);

/**
 * Returns whether a Pass/Fail course can satisfy a requirement of
 * `category` at `schoolId`.
 *
 * @param schoolId  Canonical 11-school identifier ("cas", "stern", …).
 * @param category  The requirement category to test.
 */
export function pfEligibility(
    schoolId: string,
    category: PfCategory,
): PfEligibilityResult {
    // Load the school's config once (the single source of truth for P/F policy).
    const config = loadSchoolConfig(schoolId);

    // ---- Step 1: Elective category ----
    if (category === "elective") {
        // canElect:false → students cannot elect P/F at all → outcome unknown
        // even for electives (Tandon case).
        if (config?.passFail?.canElect === false) return "unknown";
        // Absent canElect or true → students may elect; it counts as elective.
        // (No config → also hedge: school unknown → unknown, not "counts".)
        if (!config?.passFail) return "unknown";
        return "counts";
    }

    // ---- Step 2: Defer overrides (bulletin-cited, explicit) ----
    const deferCategories = DEFER_OVERRIDES.get(schoolId);
    if (deferCategories?.has(category)) return "defer";

    // ---- Step 3: Read the category boolean from the school config ----
    if (!config || !config.passFail) return "unknown";

    const pf = config.passFail;
    let flag: boolean | undefined;
    switch (category) {
        case "major":
            flag = pf.countsForMajor;
            break;
        case "minor":
            flag = pf.countsForMinor;
            break;
        case "gen_ed":
            flag = pf.countsForGenEd;
            break;
    }

    if (flag === true) return "counts";
    if (flag === false) return "elective_only";
    // undefined → bulletin not explicit → hedge
    return "unknown";
}
