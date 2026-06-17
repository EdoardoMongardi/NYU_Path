// ============================================================
// applyPassFailToDpr — pure synthetic-DPR transform (G1.3)
// ============================================================
// RED-before-GREEN test for the what-if "claimed Pass/Fail election"
// DPR transform.
//
// A P/F election on a current-term course is modeled as an in-memory
// synthetic DPR + re-plan. The transform must:
//
//   PASS outcome:
//     - set the matching courseHistory grade to "P" (P clears the ≥D
//       gate → stays in coursesTaken → credit kept);
//     - for each leaf whose coursesUsed includes the course, classify the
//       leaf category (major/minor/gen_ed/elective/unknown) and consult
//       pfEligibility(schoolId, category):
//         "counts"        → KEEP leaf satisfied (Stern major; any elective);
//         "elective_only" + category ∈ {major,minor,gen_ed} → RE-OPEN it
//                           (strip course, decrement counter, not_satisfied);
//         "elective_only" + category === "elective" → KEEP;
//         "defer"/"unknown" (either dim) → KEEP + push an UNCERTAIN hedge
//                           naming the leaf (verify with adviser).
//
//   FAIL outcome:
//     - delegate to the same requirement-reopen mechanics as
//       applyFailedCourseToDpr (grade "F" → drops from coursesTaken,
//       strip from every leaf, decrement counters, flip not_satisfied);
//     - push a GPA hedge: a P/F FAIL counts 0.0 and lowers GPA, but the
//       exact new GPA is unknown until grades post (we do NOT recompute).
//
//   Always: structuredClone; reportKind = "what_if"; never mutate input;
//   leave the `cumulative` block byte-identical; unknown courseId → no-op
//   (clone with reportKind what_if, empty hedges).
//
// Mirrors failCourseTransform.test.ts / withdrawTransform.test.ts shape.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    walkRequirements,
    notSatisfiedRequirements,
    type DegreeProgressReport,
    type DPRRequirementGroup,
} from "../../../src/dpr/schema.js";
import {
    applyPassFailToDpr,
    classifyLeafCategory,
} from "../../../src/agent/forwardSchedule/passFailTransform.js";
import { mkDpr, mkGroup, mkRequirement, mkCourse } from "../../helpers/mkDpr.js";

// ---------------------------------------------------------------------------
// Fixture builders. A leaf "MAJOR/10" satisfied by CSCI-UA 101 lives under a
// "Computer Science Major" group; a second leaf "ELEC/10" satisfied by
// ELEC-UA 200 lives under a "General Electives" group. The declared program
// (programs[]) names "Computer Science" so classifyRequirementKind recognises
// the major group.
// ---------------------------------------------------------------------------

function csCourse() {
    return mkCourse({ term: "2026 Spr", courseId: "CSCI-UA 101", grade: null, type: "IP" });
}
function elecCourse() {
    return mkCourse({ term: "2026 Spr", courseId: "ELEC-UA 200", grade: null, type: "IP" });
}

/** A DPR with a MAJOR leaf (CSCI-UA 101) and a General-Electives leaf
 *  (ELEC-UA 200), both currently satisfied (IP courses are in coursesUsed in
 *  this synthetic fixture so we can exercise the reopen path). */
function makeDpr(): DegreeProgressReport {
    return mkDpr({
        programs: [
            {
                programType: "Undergraduate Career",
                label: "UA-Coll of Arts & Sci",
                requirementTerm: "Fall 2024",
                requirementStatus: "not_satisfied",
            },
            {
                programType: "Major Approved",
                label: "Computer Science",
                requirementTerm: "Fall 2024",
                requirementStatus: "not_satisfied",
            },
        ],
        requirementGroups: [
            mkGroup({
                rgId: "RG_CS",
                title: "Computer Science Major",
                status: "not_satisfied",
                children: [
                    mkRequirement({
                        rId: "MAJOR/10",
                        title: "Computer Science: Required Courses",
                        status: "satisfied",
                        counter: { kind: "courses", required: 1, used: 1, needed: 0 },
                        coursesUsed: [csCourse()],
                    }),
                ],
            }),
            mkGroup({
                rgId: "RG_ELEC",
                title: "General Electives",
                status: "satisfied",
                children: [
                    mkRequirement({
                        rId: "ELEC/10",
                        title: "General Electives",
                        status: "satisfied",
                        counter: { kind: "courses", required: 1, used: 1, needed: 0 },
                        coursesUsed: [elecCourse()],
                    }),
                ],
            }),
        ],
        courseHistory: [csCourse(), elecCourse()],
    });
}

const leafById = (dpr: DegreeProgressReport, rId: string) =>
    walkRequirements(dpr.requirementGroups).find((r) => r.rId === rId);

// ===========================================================================
// classifyLeafCategory (Step B)
// ===========================================================================

describe("classifyLeafCategory", () => {
    it("classifies a CAS major-group leaf as 'major'", () => {
        const dpr = makeDpr();
        const group = dpr.requirementGroups[0] as DPRRequirementGroup;
        const leaf = leafById(dpr, "MAJOR/10")!;
        expect(classifyLeafCategory(leaf, group, dpr)).toBe("major");
    });

    it("classifies a General-Electives leaf as 'elective'", () => {
        const dpr = makeDpr();
        const group = dpr.requirementGroups[1] as DPRRequirementGroup;
        const leaf = leafById(dpr, "ELEC/10")!;
        expect(classifyLeafCategory(leaf, group, dpr)).toBe("elective");
    });

    it("classifies a 'Minor' group leaf as 'minor' via the group title", () => {
        const dpr = mkDpr({
            requirementGroups: [
                mkGroup({
                    rgId: "RG_MIN",
                    title: "Economics Minor",
                    children: [mkRequirement({ rId: "MIN/10", title: "Minor Course" })],
                }),
            ],
        });
        const group = dpr.requirementGroups[0] as DPRRequirementGroup;
        const leaf = leafById(dpr, "MIN/10")!;
        expect(classifyLeafCategory(leaf, group, dpr)).toBe("minor");
    });

    it("returns 'unknown' for an unrecognisable group", () => {
        const dpr = mkDpr({
            requirementGroups: [
                mkGroup({
                    rgId: "RG_X",
                    title: "Zzz Block",
                    children: [mkRequirement({ rId: "X/10", title: "Mystery" })],
                }),
            ],
            // no declared major → no structural major match
            programs: [
                {
                    programType: "Undergraduate Career",
                    label: "UA-Coll of Arts & Sci",
                    requirementTerm: "Fall 2024",
                    requirementStatus: "not_satisfied",
                },
            ],
        });
        const group = dpr.requirementGroups[0] as DPRRequirementGroup;
        const leaf = leafById(dpr, "X/10")!;
        expect(classifyLeafCategory(leaf, group, dpr)).toBe("unknown");
    });
});

// ===========================================================================
// applyPassFailToDpr (Step C)
// ===========================================================================

describe("applyPassFailToDpr", () => {
    // (1) CAS major leaf, "pass" → leaf RE-OPENS (cas/major = elective_only)
    it("PASS at CAS: re-opens a MAJOR leaf the P course satisfied", () => {
        const dpr = makeDpr();
        const { dpr: out } = applyPassFailToDpr(dpr, "CSCI-UA 101", "pass", "cas");

        // grade flipped to P, still present in courseHistory (credit kept)
        const row = out.courseHistory.find(
            (r) => r.subject === "CSCI-UA" && r.catalogNbr === "101",
        );
        expect(row?.grade).toBe("P");

        const leaf = leafById(out, "MAJOR/10")!;
        expect(leaf.status).toBe("not_satisfied");
        expect(leaf.counter).toEqual({ kind: "courses", required: 1, used: 0, needed: 1 });
        expect(leaf.coursesUsed.some((c) => c.subject === "CSCI-UA")).toBe(false);
        expect(notSatisfiedRequirements(out.requirementGroups).map((r) => r.rId)).toContain(
            "MAJOR/10",
        );
    });

    // (2) Stern major leaf, "pass" → leaf KEPT satisfied (stern/major = counts)
    it("PASS at Stern: KEEPS a MAJOR leaf satisfied (Stern counts P/F)", () => {
        const dpr = makeDpr();
        const { dpr: out } = applyPassFailToDpr(dpr, "CSCI-UA 101", "pass", "stern");

        const row = out.courseHistory.find(
            (r) => r.subject === "CSCI-UA" && r.catalogNbr === "101",
        );
        expect(row?.grade).toBe("P");

        const leaf = leafById(out, "MAJOR/10")!;
        expect(leaf.status).toBe("satisfied");
        expect(leaf.counter).toEqual({ kind: "courses", required: 1, used: 1, needed: 0 });
        expect(leaf.coursesUsed.some((c) => c.subject === "CSCI-UA")).toBe(true);
    });

    // (3) Elective leaf, "pass" → KEPT (P/F is fine for electives everywhere)
    it("PASS: KEEPS an ELECTIVE leaf satisfied", () => {
        const dpr = makeDpr();
        const { dpr: out } = applyPassFailToDpr(dpr, "ELEC-UA 200", "pass", "cas");
        const leaf = leafById(out, "ELEC/10")!;
        expect(leaf.status).toBe("satisfied");
        expect(leaf.counter).toEqual({ kind: "courses", required: 1, used: 1, needed: 0 });
        expect(leaf.coursesUsed.some((c) => c.subject === "ELEC-UA")).toBe(true);
    });

    // (4) FAIL → all satisfied leaves the course is in re-open + GPA hedge present
    it("FAIL: re-opens the satisfied leaf + emits a GPA hedge", () => {
        const dpr = makeDpr();
        const { dpr: out, hedges } = applyPassFailToDpr(dpr, "CSCI-UA 101", "fail", "cas");

        const row = out.courseHistory.find(
            (r) => r.subject === "CSCI-UA" && r.catalogNbr === "101",
        );
        expect(row?.grade).toBe("F");

        const leaf = leafById(out, "MAJOR/10")!;
        expect(leaf.status).toBe("not_satisfied");
        expect(leaf.counter).toEqual({ kind: "courses", required: 1, used: 0, needed: 1 });

        // a qualitative GPA hedge is present (we do NOT recompute exact GPA)
        expect(hedges.some((h) => /gpa/i.test(h))).toBe(true);
    });

    // (5) A leaf at a DEFER school (gallatin/minor) → KEPT + uncertainty hedge
    it("PASS at a defer school (gallatin minor): KEEPS leaf + emits an uncertainty hedge", () => {
        const dpr = mkDpr({
            requirementGroups: [
                mkGroup({
                    rgId: "RG_MIN",
                    title: "Economics Minor",
                    children: [
                        mkRequirement({
                            rId: "MIN/10",
                            title: "Minor Course",
                            status: "satisfied",
                            counter: { kind: "courses", required: 1, used: 1, needed: 0 },
                            coursesUsed: [
                                mkCourse({
                                    term: "2026 Spr",
                                    courseId: "ECON-UA 1",
                                    grade: null,
                                    type: "IP",
                                }),
                            ],
                        }),
                    ],
                }),
            ],
            courseHistory: [
                mkCourse({ term: "2026 Spr", courseId: "ECON-UA 1", grade: null, type: "IP" }),
            ],
        });
        const { dpr: out, hedges } = applyPassFailToDpr(dpr, "ECON-UA 1", "pass", "gallatin");

        const leaf = leafById(out, "MIN/10")!;
        // conservative: KEEP satisfied (do not falsely re-open)
        expect(leaf.status).toBe("satisfied");
        expect(leaf.counter).toEqual({ kind: "courses", required: 1, used: 1, needed: 0 });
        // …but flag the uncertainty, naming the leaf
        expect(hedges.some((h) => /uncertain|verify|adviser|advisor/i.test(h))).toBe(true);
        expect(hedges.some((h) => h.includes("MIN/10") || /minor course/i.test(h))).toBe(true);
    });

    // (6) reportKind is always "what_if"
    it("sets reportKind to 'what_if'", () => {
        const dpr = makeDpr();
        expect(applyPassFailToDpr(dpr, "CSCI-UA 101", "pass", "cas").dpr.reportKind).toBe(
            "what_if",
        );
        expect(applyPassFailToDpr(dpr, "CSCI-UA 101", "fail", "cas").dpr.reportKind).toBe(
            "what_if",
        );
    });

    // (7) input DPR not mutated (deep-equal)
    it("does NOT mutate the input DPR (deep-copy proof)", () => {
        const dpr = makeDpr();
        const before = JSON.parse(JSON.stringify(dpr));
        applyPassFailToDpr(dpr, "CSCI-UA 101", "pass", "cas");
        applyPassFailToDpr(dpr, "CSCI-UA 101", "fail", "cas");
        expect(dpr).toEqual(before);
    });

    // (8) cumulative block byte-identical (no GPA recomputation)
    it("leaves the cumulative block unchanged for both outcomes", () => {
        const dpr = makeDpr();
        expect(applyPassFailToDpr(dpr, "CSCI-UA 101", "pass", "cas").dpr.cumulative).toEqual(
            dpr.cumulative,
        );
        expect(applyPassFailToDpr(dpr, "CSCI-UA 101", "fail", "cas").dpr.cumulative).toEqual(
            dpr.cumulative,
        );
    });

    // (9) unknown courseId → no-op (clone w/ reportKind what_if, no hedges)
    it("no-op for an unmatched courseId: clone with reportKind what_if, empty hedges", () => {
        const dpr = makeDpr();
        const { dpr: out, hedges } = applyPassFailToDpr(dpr, "CSCI-UA 999", "pass", "cas");
        expect(out.reportKind).toBe("what_if");
        expect(hedges).toEqual([]);
        const { reportKind: _o, ...outRest } = out;
        const { reportKind: _i, ...inRest } = dpr;
        expect(outRest).toEqual(inRest);
        expect(out).not.toBe(dpr);
    });
});
