// ============================================================
// applyWithdrawalToDpr — pure synthetic-DPR transform (G1.1)
// ============================================================
// RED-before-GREEN test for the what-if "withdrawal" DPR transform.
//
// A withdrawal (W) is GPA-neutral and earns no credit. The transform:
//   1. Sets reportKind to "what_if" (marks the clone as hypothetical).
//   2. Sets matching courseHistory grade to "W" — NOT "F".
//      "W" is not in the NYU letter-grade ladder, so
//      meetsGradeThreshold("W", "D") returns false → the course
//      correctly drops out of coursesTaken without being counted as
//      an F in the GPA ladder.
//   3. Strips the course from every requirement leaf's coursesUsed[].
//   4. Reopens any leaf that drops below its counter.required
//      (status → not_satisfied, counter.used decremented,
//      counter.needed recomputed).
//   5. Does NOT touch the cumulative block (W is GPA-neutral; the
//      known simplification: credit/GPA totals are not recomputed).
//   6. Is PURE — deep-copies, never mutates the input DPR.
//   7. Unknown courseId → returns a clone unchanged (no-op).
//
// Mirrors failCourseTransform.test.ts structure; see that file for
// full context on courseId keying and counter semantics.
// ============================================================

import { describe, it, expect } from "vitest";
import {
    degreeProgressReportSchema,
    walkRequirements,
    notSatisfiedRequirements,
    type DegreeProgressReport,
} from "../../../src/dpr/schema.js";
import { applyWithdrawalToDpr } from "../../../src/agent/forwardSchedule/withdrawTransform.js";

// ---------------------------------------------------------------------------
// Minimal valid DPR fixture — same shape as failCourseTransform.test.ts.
//
// - CSCI-UA 101 is a PASSED courseHistory row (grade "A", type "EN").
// - It is in leaf SR/10's coursesUsed[] (status "satisfied",
//   counter {required:1, used:1, needed:0}).
// - A second leaf SR/20 is satisfied by a DIFFERENT course (MATH-UA 121)
//   and must be untouched (control for the "only reopen if it drops below
//   required" guard).
// ---------------------------------------------------------------------------

function makeDpr(): DegreeProgressReport {
    const dpr: DegreeProgressReport = {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:SYNTHETIC-withdraw-fixture",
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

describe("applyWithdrawalToDpr", () => {
    // (b) Output reportKind must be "what_if"
    it("sets reportKind to 'what_if' on the output", () => {
        const dpr = makeDpr();
        const out = applyWithdrawalToDpr(dpr, "CSCI-UA 101");
        expect(out.reportKind).toBe("what_if");
    });

    // (c) Matching courseHistory grade becomes "W" (NOT "F")
    it("sets the matching courseHistory grade to 'W', not 'F'", () => {
        const dpr = makeDpr();
        const out = applyWithdrawalToDpr(dpr, "CSCI-UA 101");
        const row = out.courseHistory.find(
            (r) => r.subject === "CSCI-UA" && r.catalogNbr === "101",
        );
        expect(row?.grade).toBe("W");
        expect(row?.grade).not.toBe("F");
        // Non-matching row is untouched.
        const math = out.courseHistory.find(
            (r) => r.subject === "MATH-UA" && r.catalogNbr === "121",
        );
        expect(math?.grade).toBe("B+");
    });

    // (a) A course satisfying an otherwise-satisfied leaf → leaf reopens after withdrawal
    it("removes the course from every leaf's coursesUsed[]", () => {
        const dpr = makeDpr();
        const out = applyWithdrawalToDpr(dpr, "CSCI-UA 101");
        for (const leaf of walkRequirements(out.requirementGroups)) {
            for (const cu of leaf.coursesUsed) {
                expect(`${cu.subject} ${cu.catalogNbr}`).not.toBe("CSCI-UA 101");
            }
        }
    });

    it("reopens the leaf that used the withdrawn course (status + counter)", () => {
        const dpr = makeDpr();
        const out = applyWithdrawalToDpr(dpr, "CSCI-UA 101");
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

    // (d) cumulative block is byte-identical to input (deep-equal)
    it("leaves the cumulative block unchanged (W is GPA-neutral)", () => {
        const dpr = makeDpr();
        const out = applyWithdrawalToDpr(dpr, "CSCI-UA 101");
        expect(out.cumulative).toEqual(dpr.cumulative);
    });

    // (e) Input DPR object is NOT mutated
    it("does NOT mutate the original dpr (deep-copy proof)", () => {
        const dpr = makeDpr();
        const before = JSON.parse(JSON.stringify(dpr));
        applyWithdrawalToDpr(dpr, "CSCI-UA 101");
        expect(dpr).toEqual(before);
    });

    // Canonical form matching: zero-padded courseId
    it("matches the zero-padded canonical form (CSCI-UA 0101)", () => {
        const dpr = makeDpr();
        const out = applyWithdrawalToDpr(dpr, "CSCI-UA 0101");
        const row = out.courseHistory.find(
            (r) => r.subject === "CSCI-UA" && r.catalogNbr === "101",
        );
        expect(row?.grade).toBe("W");
    });

    // (f) Unknown courseId → output deep-equals input clone (except reportKind is set to what_if)
    // Decision: even for a no-op (unmatched courseId), we still set reportKind = "what_if"
    // because the clone is a hypothetical container regardless of whether the course matched.
    it("no-op for an unmatched courseId: returns a clone with reportKind='what_if' but otherwise unchanged", () => {
        const dpr = makeDpr();
        const out = applyWithdrawalToDpr(dpr, "CSCI-UA 999");
        // reportKind is always flipped to what_if (hypothetical container)
        expect(out.reportKind).toBe("what_if");
        // Everything else is structurally equal to the original
        const { reportKind: _outKind, ...outRest } = out;
        const { reportKind: _inKind, ...inRest } = dpr;
        expect(outRest).toEqual(inRest);
        // It's a fresh object, not the same reference
        expect(out).not.toBe(dpr);
        expect(out.courseHistory).not.toBe(dpr.courseHistory);
    });
});
