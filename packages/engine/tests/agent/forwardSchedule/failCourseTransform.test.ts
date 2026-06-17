// ============================================================
// applyFailedCourseToDpr — pure synthetic-DPR transform (D2.1a)
// ============================================================
// RED-before-GREEN test for the counterfactual probe's "what if the
// student had FAILED this completed course" DPR transform.
//
// The transform must:
//   1. flip every matching courseHistory row's grade to a failing "F"
//      (so buildSolverInput's coursesTaken — which adds a row only when
//      meetsGradeThreshold(grade, "D") — excludes it);
//   2. remove the course from every requirement leaf's coursesUsed[], and
//      for any leaf that drops below counter.required, flip status to
//      "not_satisfied", decrement counter.used, recompute
//      counter.needed = max(0, required - used) — so
//      notSatisfiedRequirements() re-includes that requirement;
//   3. be PURE — deep-copy, never mutate the input.
//
// Course-id keying matches buildSolverInput.ts:197-206 (subject +
// " " + catalogNbr) under canonicalizeCourseId for the zero-pad form.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    degreeProgressReportSchema,
    walkRequirements,
    notSatisfiedRequirements,
    type DegreeProgressReport,
} from "../../../src/dpr/schema.js";
import { applyFailedCourseToDpr } from "../../../src/agent/forwardSchedule/failCourseTransform.js";

// ---------------------------------------------------------------------------
// Minimal valid DPR fixture.
//
// - CSCI-UA 101 is a PASSED courseHistory row (grade "A", type "EN").
// - It is recorded in the leaf SR/10's coursesUsed[] (status "satisfied",
//   counter {required:1, used:1, needed:0}).
// - A second leaf SR/20 is satisfied by a DIFFERENT course (MATH-UA 121) and
//   must be untouched (control for the "only reopen if it drops below
//   required" guard).
// ---------------------------------------------------------------------------

function makeDpr(): DegreeProgressReport {
    const dpr: DegreeProgressReport = {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:SYNTHETIC-failcourse-fixture",
            sourcePdfPageCount: 0,
            parseDurationMs: 0,
            warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
        },
        reportKind: "dpr",
        header: {
            studentName: "Synthetic Student (fabricated)",
            preparedDate: "01/01/2026",
        },
        programs: [
            {
                programType: "Undergraduate Career",
                label: "UA-Coll of Arts & Sci",
                requirementTerm: "Fall 2024",
                requirementStatus: "not_satisfied",
            },
        ],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 96,
            cumulativeGpa: 3.5,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 64,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: [
            {
                rgId: "RG1",
                title: "Computer Science Major",
                status: "not_satisfied",
                statusText: "Not Satisfied: Complete the Computer Science major.",
                children: [
                    {
                        rId: "SR/10",
                        title: "Intro Requirement",
                        status: "satisfied",
                        statusText: "Satisfied: Intro completed.",
                        counter: { kind: "courses", required: 1, used: 1, needed: 0 },
                        coursesUsed: [
                            {
                                term: "2024 Fall",
                                subject: "CSCI-UA",
                                catalogNbr: "101",
                                courseTitle: "Intro to Computer Science",
                                grade: "A",
                                units: 4,
                                type: "EN",
                            },
                        ],
                    },
                    {
                        rId: "SR/20",
                        title: "Calculus Requirement",
                        status: "satisfied",
                        statusText: "Satisfied: Calculus completed.",
                        counter: { kind: "courses", required: 1, used: 1, needed: 0 },
                        coursesUsed: [
                            {
                                term: "2024 Fall",
                                subject: "MATH-UA",
                                catalogNbr: "121",
                                courseTitle: "Calculus I",
                                grade: "B+",
                                units: 4,
                                type: "EN",
                            },
                        ],
                    },
                ],
            },
        ],
        courseHistory: [
            {
                term: "2024 Fall",
                subject: "CSCI-UA",
                catalogNbr: "101",
                courseTitle: "Intro to Computer Science",
                grade: "A",
                units: 4,
                type: "EN",
            },
            {
                term: "2024 Fall",
                subject: "MATH-UA",
                catalogNbr: "121",
                courseTitle: "Calculus I",
                grade: "B+",
                units: 4,
                type: "EN",
            },
        ],
    };
    return degreeProgressReportSchema.parse(dpr);
}

describe("applyFailedCourseToDpr", () => {
    it("flips the matching courseHistory grade to failing 'F'", () => {
        const dpr = makeDpr();
        const out = applyFailedCourseToDpr(dpr, "CSCI-UA 101");
        const row = out.courseHistory.find(
            (r) => r.subject === "CSCI-UA" && r.catalogNbr === "101",
        );
        expect(row?.grade).toBe("F");
        // The non-matching row is untouched.
        const math = out.courseHistory.find(
            (r) => r.subject === "MATH-UA" && r.catalogNbr === "121",
        );
        expect(math?.grade).toBe("B+");
    });

    it("removes the course from every leaf's coursesUsed[]", () => {
        const dpr = makeDpr();
        const out = applyFailedCourseToDpr(dpr, "CSCI-UA 101");
        for (const leaf of walkRequirements(out.requirementGroups)) {
            for (const cu of leaf.coursesUsed) {
                expect(`${cu.subject} ${cu.catalogNbr}`).not.toBe("CSCI-UA 101");
            }
        }
    });

    it("reopens the leaf that used the failed course (status + counter)", () => {
        const dpr = makeDpr();
        const out = applyFailedCourseToDpr(dpr, "CSCI-UA 101");
        const leaf = walkRequirements(out.requirementGroups).find(
            (r) => r.rId === "SR/10",
        );
        expect(leaf?.status).toBe("not_satisfied");
        expect(leaf?.counter).toEqual({ kind: "courses", required: 1, used: 0, needed: 1 });
        // notSatisfiedRequirements re-includes it.
        const unmet = notSatisfiedRequirements(out.requirementGroups).map((r) => r.rId);
        expect(unmet).toContain("SR/10");

        // The OTHER leaf (satisfied by a different course) is untouched.
        const other = walkRequirements(out.requirementGroups).find(
            (r) => r.rId === "SR/20",
        );
        expect(other?.status).toBe("satisfied");
        expect(other?.counter).toEqual({ kind: "courses", required: 1, used: 1, needed: 0 });
    });

    it("does NOT mutate the original dpr (deep-copy proof)", () => {
        const dpr = makeDpr();
        const before = JSON.parse(JSON.stringify(dpr));
        applyFailedCourseToDpr(dpr, "CSCI-UA 101");
        expect(dpr).toEqual(before);
    });

    it("matches the zero-padded canonical form (CSCI-UA 0101)", () => {
        const dpr = makeDpr();
        const out = applyFailedCourseToDpr(dpr, "CSCI-UA 0101");
        const row = out.courseHistory.find(
            (r) => r.subject === "CSCI-UA" && r.catalogNbr === "101",
        );
        expect(row?.grade).toBe("F");
    });

    it("no-op for an unmatched courseId returns a structurally-equal copy", () => {
        const dpr = makeDpr();
        const out = applyFailedCourseToDpr(dpr, "CSCI-UA 999");
        expect(out).toEqual(dpr);
        // …but it is a fresh object, not the same reference.
        expect(out).not.toBe(dpr);
        expect(out.courseHistory).not.toBe(dpr.courseHistory);
    });
});
