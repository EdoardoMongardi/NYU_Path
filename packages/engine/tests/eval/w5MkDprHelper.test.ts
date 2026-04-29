// ============================================================
// Phase 7-E W5 — mkDpr helper tests + tool-driven scenarios
// ============================================================
// Exercises the mkDpr() builder + the three audit-class tools
// against synthetic DPR fixtures. Demonstrates the post-W3
// pattern: tests construct a DPR fixture (not a Program +
// courses + StudentProfile triple) and assert on the tool's
// reaction.
// ============================================================

import { describe, expect, it } from "vitest";
import {
    mkDpr,
    mkAlmostDoneDpr,
    mkSatisfiedDpr,
    mkGroup,
    mkRequirement,
    mkCourse,
} from "../helpers/mkDpr.js";
import {
    notSatisfiedRequirements,
    walkRequirements,
    findRequirementById,
    type ToolSession,
} from "../../src/index.js";
import { runFullAuditTool } from "../../src/agent/tools/runFullAudit.js";
import { planSemesterTool } from "../../src/agent/tools/planSemester.js";

const ABORT = new AbortController().signal;

function dprSession(report: ReturnType<typeof mkDpr>): ToolSession {
    return {
        student: {
            id: "test_student",
            catalogYear: "2024-2025",
            homeSchool: "cas",
            declaredPrograms: [{ programId: "computer_science", programType: "major" }],
            coursesTaken: [],
        },
        degreeProgressReport: report,
    };
}

describe("mkDpr builder — defaults", () => {
    it("default DPR has Test Student + 2 programs (career + major)", () => {
        const dpr = mkDpr();
        expect(dpr.header.studentName).toBe("Test Student");
        expect(dpr.programs).toHaveLength(2);
        expect(dpr.programs[1]!.label).toBe("Computer Science");
    });

    it("default DPR cumulative is satisfied (128/128 credits, 3.5 GPA)", () => {
        const dpr = mkDpr();
        expect(dpr.cumulative.creditsUsed).toBe(128);
        expect(dpr.cumulative.creditsRequired).toBe(128);
        expect(dpr.cumulative.cumulativeGpa).toBe(3.5);
    });

    it("schema-validates with no warnings by default", () => {
        const dpr = mkDpr();
        expect(dpr._meta.warnings).toEqual([]);
    });
});

describe("mkDpr builder — overrides", () => {
    it("custom programs replace defaults", () => {
        const dpr = mkDpr({
            programs: [{
                programType: "Major Approved",
                label: "Mathematics",
                requirementTerm: "Fall 2024",
                requirementStatus: "not_satisfied",
            }],
        });
        expect(dpr.programs).toHaveLength(1);
        expect(dpr.programs[0]!.label).toBe("Mathematics");
    });

    it("partial cumulative override merges with defaults", () => {
        const dpr = mkDpr({ cumulative: { creditsUsed: 96, cumulativeGpa: 3.8 } });
        expect(dpr.cumulative.creditsUsed).toBe(96);
        expect(dpr.cumulative.creditsRequired).toBe(128); // default preserved
        expect(dpr.cumulative.cumulativeGpa).toBe(3.8);
    });

    it("requirementGroups + courseHistory pass through", () => {
        const dpr = mkDpr({
            requirementGroups: [
                mkGroup({
                    rgId: "RG_TEST",
                    children: [mkRequirement({ rId: "R_TEST/10" })],
                }),
            ],
            courseHistory: [mkCourse({ term: "2024 Fall", courseId: "CSCI-UA 101" })],
        });
        expect(dpr.requirementGroups).toHaveLength(1);
        expect(walkRequirements(dpr.requirementGroups)).toHaveLength(1);
        expect(dpr.courseHistory).toHaveLength(1);
    });
});

describe("mkDpr sugar — almost-done + satisfied fixtures", () => {
    it("mkAlmostDoneDpr surfaces the missing CSCI-UA 421 via notSatisfiedRequirements", () => {
        const dpr = mkAlmostDoneDpr();
        const ns = notSatisfiedRequirements(dpr.requirementGroups);
        // Both the parent RG ("not_satisfied" because child is) and the
        // leaf R_MAJOR_REQ surface; we just need the leaf for the test.
        const leaf = ns.find((r) => r.rId === "R_MAJOR_REQ");
        expect(leaf).toBeDefined();
        expect(leaf!.statusText).toContain("CSCI-UA 421");
    });

    it("mkSatisfiedDpr has no unsatisfied requirements", () => {
        const dpr = mkSatisfiedDpr();
        expect(notSatisfiedRequirements(dpr.requirementGroups)).toHaveLength(0);
    });
});

describe("run_full_audit consumes mkDpr fixtures", () => {
    it("returns DPR-source audit with correct standing for an almost-done student", async () => {
        const dpr = mkAlmostDoneDpr();
        const out = await runFullAuditTool.call({}, { signal: ABORT, session: dprSession(dpr) });
        expect(out.source).toBe("dpr");
        expect(out.standing.cumulativeGPA).toBe(3.4);
        expect(out.standing.inGoodStanding).toBe(true);
        expect(out.audits.length).toBeGreaterThan(0);
    });

    it("flags below-2.0 GPA as academic_concern", async () => {
        const dpr = mkDpr({ cumulative: { cumulativeGpa: 1.8 } });
        const out = await runFullAuditTool.call({}, { signal: ABORT, session: dprSession(dpr) });
        expect(out.standing.inGoodStanding).toBe(false);
        expect(out.standing.level).toBe("academic_concern");
    });

    it("verbatim quotes the GPA (Phase 9 Stage 5: loosened to substring; see runFullAudit.ts)", async () => {
        const dpr = mkDpr({ cumulative: { cumulativeGpa: 3.214 } });
        const out = await runFullAuditTool.call({}, { signal: ABORT, session: dprSession(dpr) });
        const v = runFullAuditTool.extractVerbatim?.(out);
        expect(v).toBe("Cumulative GPA: 3.214");
    });
});

describe("plan_semester consumes mkDpr fixtures", () => {
    it("almost-done DPR yields a plan that names CSCI-UA 421", async () => {
        const dpr = mkAlmostDoneDpr();
        const out = await planSemesterTool.call(
            { targetSemester: "2027-spring" },
            { signal: ABORT, session: dprSession(dpr) },
        );
        expect(out.source).toBe("dpr");
        expect(out.suggestions.map((s) => s.courseId)).toContain("CSCI-UA 421");
    });

    it("satisfied DPR yields zero suggestions", async () => {
        const dpr = mkSatisfiedDpr();
        const out = await planSemesterTool.call(
            { targetSemester: "2027-spring" },
            { signal: ABORT, session: dprSession(dpr) },
        );
        expect(out.suggestions).toHaveLength(0);
    });

    it("custom requirement with descriptive course IDs surfaces them", async () => {
        const dpr = mkDpr({
            requirementGroups: [
                mkGroup({
                    rgId: "RG_CUSTOM",
                    status: "not_satisfied",
                    children: [
                        mkRequirement({
                            rId: "R_CUSTOM/10",
                            status: "not_satisfied",
                            description: "Complete MATH-UA 343 Algebra and MATH-UA 251 Math Modeling.",
                            counter: { kind: "courses", required: 2, used: 0, needed: 2 },
                        }),
                    ],
                }),
            ],
        });
        const out = await planSemesterTool.call(
            { targetSemester: "2027-spring" },
            { signal: ABORT, session: dprSession(dpr) },
        );
        const ids = out.suggestions.map((s) => s.courseId);
        expect(ids).toContain("MATH-UA 343");
        expect(ids).toContain("MATH-UA 251");
    });
});

describe("mkDpr — schema invariants for downstream code", () => {
    it("findRequirementById round-trip", () => {
        const dpr = mkDpr({
            requirementGroups: [
                mkGroup({
                    rgId: "RG_X",
                    children: [mkRequirement({ rId: "R_X/10", title: "Specific" })],
                }),
            ],
        });
        const found = findRequirementById(dpr.requirementGroups, "R_X/10");
        expect(found?.title).toBe("Specific");
    });

    it("sourceFingerprint differs across structurally different fixtures", () => {
        const a = mkDpr({ cumulative: { creditsUsed: 50 } });
        const b = mkDpr({ cumulative: { creditsUsed: 100 } });
        expect(a._meta.sourceFingerprint).not.toBe(b._meta.sourceFingerprint);
    });

    it("sourceFingerprint stable for identical input (deterministic)", () => {
        const a = mkDpr({ cumulative: { creditsUsed: 50 } });
        const b = mkDpr({ cumulative: { creditsUsed: 50 } });
        expect(a._meta.sourceFingerprint).toBe(b._meta.sourceFingerprint);
    });
});
