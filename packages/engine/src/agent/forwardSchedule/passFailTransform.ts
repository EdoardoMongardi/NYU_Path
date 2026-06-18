// ============================================================
// applyPassFailToDpr — pure synthetic-DPR transform (G1.3)
// ============================================================
// Part of the what-if probe. Models a student's CLAIMED Pass/Fail
// election on a current-term in-progress course as an in-memory
// synthetic DegreeProgressReport (the input `dpr` is NEVER mutated)
// + re-plan. Returns the synthetic DPR plus any HEDGE strings the
// caller must surface to the student.
//
// WHY P/F is not a simple "fail" or "withdraw":
//   - A Pass (P) EARNS CREDIT (P clears the ≥D pass gate — see
//     meetsGradeThreshold("P","D") in gradeComparison.ts; P=6, D=3),
//     so the course STAYS in coursesTaken on the next solve.
//   - BUT at MOST schools a P does NOT satisfy a major/minor/core
//     requirement — it only counts as elective credit. This is
//     SCHOOL-SPECIFIC: Stern's bulletin lets P/F count toward the
//     major; CAS/Tisch/etc. don't; Gallatin-minor + many off-CAS
//     cases are uncertain → we hedge rather than assert.
//   - A Fail (F under P/F) earns NO credit, RE-OPENS the requirement,
//     and counts 0.0 in GPA. We do NOT compute the exact new GPA
//     (plan §5 Q3 — hedge it qualitatively).
//
// THE PASS-OUTCOME DECISION TABLE (per leaf the course satisfies):
//   classifyLeafCategory(leaf) → category, then pfEligibility(school, category):
//     "counts"                                   → KEEP leaf satisfied
//     "elective_only" & category ∈ {major,minor,gen_ed} → RE-OPEN leaf
//     "elective_only" & category === "elective"  → KEEP (P/F fine for electives)
//     "defer" | "unknown" (either dimension)     → KEEP + HEDGE (uncertain;
//                                                   verify with adviser)
//   "elective" category never re-opens — P/F always counts for electives
//   where the student can elect P/F at all (pfEligibility handles canElect).
//
// FAIL outcome delegates the requirement re-open to applyFailedCourseToDpr
// (identical mechanics: grade "F" → drops from coursesTaken, strip from
// every leaf, decrement counters, flip not_satisfied), then adds a GPA
// hedge. We never touch the `cumulative` block (no exact GPA recompute).
//
// COURSE-ID KEYING — identical to the sibling transforms and
// buildSolverInput (line 198): `${row.subject} ${row.catalogNbr}`,
// canonicalized via canonicalizeCourseId.
//
// PURE: no I/O beyond pfEligibility's school-config read (which the
// helper performs at call time); no module state. Returns a fresh
// object via structuredClone. Unknown / unmatched courseId → no-op:
// the clone gets reportKind "what_if" and an empty `hedges` array.
// ============================================================

import { canonicalizeCourseId } from "../../courseId.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
    type DPRRequirement,
    type DPRRequirementGroup,
} from "../../dpr/schema.js";
import type { ProgramDeclaration } from "@nyupath/shared";
import { rowKey } from "./transformUtils.js";
import { applyFailedCourseToDpr } from "./failCourseTransform.js";
import { classifyRequirementKind } from "./requirementKind.js";
import {
    pfEligibility,
    type PfCategory,
    type PfEligibilityResult,
} from "../../dpr/pfEligibility.js";

/** A passing P/F mark. P clears the ≥D gate, so the course keeps its
 *  credit and stays in coursesTaken on the next solve. */
const PASS_GRADE = "P";

/** The leaf-category vocabulary this transform reasons over. Maps onto
 *  pfEligibility's PfCategory plus an explicit "unknown" escape hatch
 *  (when we cannot confidently classify the leaf, we hedge). */
export type LeafCategory = PfCategory | "unknown";

// ---------------------------------------------------------------------------
// Step B — leaf-category classifier
// ---------------------------------------------------------------------------

/**
 * Derive a best-effort `ProgramDeclaration[]` from the DPR's own programs[]
 * block so classifyRequirementKind can recognise the student's major group
 * by matching the declared-program label against the group title.
 *
 * The DPR programs[].programType uses PeopleSoft labels ("Major",
 * "Major Approved", "Minor", "Minor Approved", "Undergraduate Career", …);
 * we map case-insensitively (contains "minor" → minor, contains "major" →
 * major) and use the program `label` as the matchable programId.
 */
function declaredProgramsFromDpr(dpr: DegreeProgressReport): ProgramDeclaration[] {
    const out: ProgramDeclaration[] = [];
    for (const p of dpr.programs) {
        const t = p.programType.toLowerCase();
        if (t.includes("minor")) {
            out.push({ programId: p.label, programType: "minor" });
        } else if (t.includes("major")) {
            out.push({ programId: p.label, programType: "major" });
        }
        // "Undergraduate Career", "Program", "Concentration" etc. are not
        // needed for major-group identification and are skipped.
    }
    return out;
}

/**
 * Title-based fallback for a single group/leaf when the structural
 * classifier returns "unknown". Confident only on clear labels; anything
 * ambiguous stays "unknown" so the caller hedges rather than asserts.
 */
function categoryFromTitles(groupTitle: string, leafTitle: string): LeafCategory {
    const g = groupTitle.toLowerCase();
    const l = leafTitle.toLowerCase();
    // Minor is checked FIRST: requirementKind.ts does not classify minors,
    // and "Minor" is an unambiguous group-level label.
    if (g.includes("minor") || l.includes("minor")) return "minor";
    // General electives before "major" — a "General Electives" block must not
    // be mis-read as a major just because the word appears elsewhere.
    if (g.includes("general elective") || l.includes("general elective")) {
        return "elective";
    }
    if (g.startsWith("core ") || g === "core" || g.includes("core curriculum")) {
        return "gen_ed";
    }
    if (g.includes("general education") || g.includes("gen ed")) return "gen_ed";
    if (g.includes("major") || l.includes("major")) return "major";
    return "unknown";
}

/**
 * Classify a DPR requirement leaf into a coarse category used by the P/F
 * eligibility check: "major" | "minor" | "gen_ed" | "elective" | "unknown".
 *
 * Strategy (structural first, title fallback second):
 *   1. Run the structural classifier (requirementKind.ts) over the whole
 *      tree using a major label derived from the DPR's own programs[]. Map
 *      its granular kind to our coarse category:
 *        major-required / major-elective → "major"
 *        school-core                     → "gen_ed"
 *        general-elective / free-elective → "elective"
 *        unknown                         → fall through to (2)
 *   2. Title fallback on the GROUP title (then leaf title) — this is the
 *      ONLY path that can yield "minor" (requirementKind.ts doesn't model
 *      minors) and a backstop when the structural classifier abstains.
 *   3. Otherwise "unknown" → the caller hedges (never a wrong deterministic
 *      verdict). Off-CAS hierarchies will frequently land here, which is
 *      correct per the documented requirementKind.ts limit.
 *
 * @param leaf  The leaf requirement to classify.
 * @param group The leaf's immediate parent group (title is a strong signal).
 * @param dpr   The full DPR (needed to derive declared programs + walk the tree).
 */
export function classifyLeafCategory(
    leaf: DPRRequirement,
    group: DPRRequirementGroup,
    dpr: DegreeProgressReport,
): LeafCategory {
    // ---- 1. Structural classifier ----
    const kindByRId = classifyRequirementKind({
        groups: dpr.requirementGroups,
        declaredPrograms: declaredProgramsFromDpr(dpr),
    });
    const kind = kindByRId.get(leaf.rId);
    switch (kind) {
        case "major-required":
        case "major-elective":
            return "major";
        case "school-core":
            return "gen_ed";
        case "general-elective":
        case "free-elective":
            return "elective";
        // "unknown" or undefined → fall through to the title fallback.
    }

    // ---- 2. Title fallback (only source of "minor"; backstop otherwise) ----
    return categoryFromTitles(group.title, leaf.title);
}

// ---------------------------------------------------------------------------
// Step C — the pass/fail transform
// ---------------------------------------------------------------------------

/** Re-open a single leaf the course satisfied — identical mechanics to the
 *  fail/withdraw transforms: strip the course from coursesUsed, decrement a
 *  droppable counter, and flip status to not_satisfied when it drops below
 *  required (or unconditionally when there is no droppable counter). */
function reopenLeaf(leaf: DPRRequirement, targetId: string): void {
    const before = leaf.coursesUsed.length;
    leaf.coursesUsed = leaf.coursesUsed.filter((cu) => rowKey(cu) !== targetId);
    const removed = before - leaf.coursesUsed.length;
    if (removed === 0) return;

    const counter = leaf.counter;
    if (counter && (counter.kind === "courses" || counter.kind === "units")) {
        const used = counter.used - removed;
        counter.used = used;
        counter.needed = Math.max(0, counter.required - used);
        if (used < counter.required) {
            leaf.status = "not_satisfied";
        }
    } else {
        // No droppable counter: conservatively re-open it as unmet work.
        leaf.status = "not_satisfied";
    }
}

/**
 * Return a DEEP-COPIED `DegreeProgressReport` modeling a CLAIMED Pass/Fail
 * election on `courseId`, plus any HEDGE strings the caller must surface.
 *
 * - outcome "fail": delegates the requirement re-open to applyFailedCourseToDpr
 *   (grade "F", drops from coursesTaken, leaves re-open), adds a qualitative
 *   GPA hedge. The `cumulative` block is left unchanged.
 * - outcome "pass": grade → "P" (credit kept), then per leaf the course
 *   satisfies, consult classifyLeafCategory + pfEligibility(schoolId,…) per
 *   the decision table in this file's header. The `cumulative` block is left
 *   unchanged.
 *
 * The input `dpr` is never mutated. `reportKind` is always "what_if".
 * Unknown / unmatched courseId → no-op (clone w/ reportKind what_if, []).
 *
 * @param dpr      The student's real DPR (never mutated).
 * @param courseId The current-term course the student claims to P/F.
 * @param outcome  "pass" | "fail" — the claimed P/F result.
 * @param schoolId Canonical 11-school id ("cas", "stern", "gallatin", …),
 *                 used by pfEligibility for the per-school policy.
 */
export function applyPassFailToDpr(
    dpr: DegreeProgressReport,
    courseId: string,
    outcome: "pass" | "fail",
    schoolId: string,
): { dpr: DegreeProgressReport; hedges: string[] } {
    const targetId = canonicalizeCourseId(courseId);
    const hedges: string[] = [];

    // ---- FAIL: delegate the reopen to applyFailedCourseToDpr ----
    if (outcome === "fail") {
        const failed = applyFailedCourseToDpr(dpr, courseId);
        failed.reportKind = "what_if";
        // Whether or not the course matched a leaf, a P/F fail has a GPA
        // impact we describe qualitatively (we never recompute the exact GPA).
        const matched = dpr.courseHistory.some((r) => rowKey(r) === targetId);
        if (matched) {
            hedges.push(
                `A Pass/Fail FAIL in ${courseId} counts as 0.0 and will lower your cumulative GPA. ` +
                    `The exact new GPA is unknown until grades post — we do not recompute it here. ` +
                    `Verify the impact with your adviser.`,
            );
        }
        // Re-validate (applyFailedCourseToDpr already parsed, but we mutated
        // reportKind, so re-parse to keep the returned object validated + fresh).
        return { dpr: degreeProgressReportSchema.parse(failed), hedges };
    }

    // ---- PASS: keep credit (grade → P) and apply per-leaf eligibility ----
    const next: DegreeProgressReport = structuredClone(dpr);
    next.reportKind = "what_if";

    // 1. Flip matching courseHistory rows to "P" (P clears the ≥D gate →
    //    stays in coursesTaken → credit kept).
    for (const row of next.courseHistory) {
        if (rowKey(row) === targetId) {
            row.grade = PASS_GRADE;
        }
    }

    // 2. Walk the tree; for each leaf the course satisfies, apply the
    //    pass-outcome decision table.
    const visit = (
        node: DPRRequirementGroup | DPRRequirement,
        parentGroup: DPRRequirementGroup | null,
    ): void => {
        if ("rId" in node) {
            const leaf = node;
            const usesCourse = leaf.coursesUsed.some((cu) => rowKey(cu) === targetId);
            if (!usesCourse || parentGroup === null) return;

            const category = classifyLeafCategory(leaf, parentGroup, next);
            // Cannot confidently classify the leaf → hedge without even
            // consulting pfEligibility (no valid category to pass it).
            const eligibility: PfEligibilityResult =
                category === "unknown" ? "unknown" : pfEligibility(schoolId, category);

            // "unknown" category OR defer/unknown eligibility → KEEP + hedge.
            if (eligibility === "defer" || eligibility === "unknown") {
                hedges.push(
                    `It is UNCERTAIN whether a Pass/Fail course satisfies the requirement ` +
                        `"${leaf.title}" (${leaf.rId}) at this school — we have kept it marked ` +
                        `satisfied here, but verify with your adviser before relying on it.`,
                );
                return;
            }

            // "counts" → KEEP satisfied (Stern major; any elective).
            if (eligibility === "counts") return;

            // "elective_only":
            //   - elective category → KEEP (P/F fine for electives)
            //   - major/minor/gen_ed → RE-OPEN (P/F only earns elective credit)
            if (eligibility === "elective_only") {
                if (category === "elective") return;
                reopenLeaf(leaf, targetId);
            }
            return;
        }
        for (const child of node.children) visit(child, node);
    };
    for (const g of next.requirementGroups) visit(g, null);

    // 3. Validate the synthetic DPR is still schema-valid (also returns a
    //    fresh validated object, preserving purity).
    return { dpr: degreeProgressReportSchema.parse(next), hedges };
}
