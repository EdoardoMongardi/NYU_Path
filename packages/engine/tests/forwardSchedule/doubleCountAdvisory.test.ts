import { describe, expect, it } from "vitest";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";
import type { SchoolConfig } from "@nyupath/shared";
import {
    countDeclaredPrograms,
    detectSharedCourses,
    buildDoubleCountAdvisory,
} from "../../src/agent/forwardSchedule/doubleCountAdvisory.js";

function row(subject: string, catalogNbr: string) {
    return { term: "2025 Fall", subject, catalogNbr, courseTitle: "X", grade: "A", units: 4, type: "EN" };
}
function leaf(rId: string, coursesUsed: ReturnType<typeof row>[]) {
    return { rId, title: rId, status: "satisfied" as const, statusText: "", coursesUsed };
}
function makeDpr(programs: { programType: string; label: string }[], leaves: ReturnType<typeof leaf>[]): DegreeProgressReport {
    return {
        _meta: { parserVersion: "1.0.0", parsedAt: "t", sourceFingerprint: "sha256:x", sourcePdfPageCount: 1, parseDurationMs: 1, warnings: [] },
        header: { studentName: "S", preparedDate: "01/01/2026" },
        programs: programs.map((p) => ({ ...p, requirementTerm: "Fall 2024", requirementStatus: "satisfied" as const })),
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128, creditsUsed: 64, cumulativeGpa: 3.5, cumulativeGpaRequired: 2,
            residencyRequired: 64, residencyUsed: 32, passFailUsedUnits: 0, passFailCapUnits: 32,
            outsideHomeUsedUnits: 0, outsideHomeCapUnits: 16, timeLimitYears: 8,
        },
        requirementGroups: [{ rgId: "RG1", title: "root", status: "satisfied", statusText: "", children: leaves }],
        courseHistory: [],
    };
}
function schoolConfig(doubleCounting?: SchoolConfig["doubleCounting"], name = "College of Arts and Science"): SchoolConfig {
    return { schoolId: "cas", name, courseSuffix: ["-UA"], residency: { type: "suffix_based", suffix: "-UA" }, doubleCounting } as SchoolConfig;
}

const CAS_DC: SchoolConfig["doubleCounting"] = {
    cap: { majorToMajor: 2, majorToMinor: 2, minorToMinor: 2 },
    noTripleCounting: true, requiresApproval: true,
    sourceRef: "data/bulletin-raw/undergraduate/arts-science/academic-policies/_index.md:126",
};
const NYUAD_DC: SchoolConfig["doubleCounting"] = {
    floor: { minDistinctCreditsPerMajor: 30, minUniqueCoursesPerMinor: 2 },
    noTripleCounting: true, requiresApproval: true,
    sourceRef: "data/bulletin-raw/undergraduate/abu-dhabi/academic-policies/_index.md:146",
};

describe("countDeclaredPrograms", () => {
    it("counts majors+minors+concentrations, ignoring Career/Program rows", () => {
        const dpr = makeDpr(
            [{ programType: "Undergraduate Career", label: "UA" }, { programType: "Program", label: "UA-CAS" },
             { programType: "Major", label: "Economics" }, { programType: "Minor", label: "CS" }],
            [],
        );
        expect(countDeclaredPrograms(dpr)).toBe(2);
    });
    it("counts a concentration", () => {
        const dpr = makeDpr([{ programType: "Major", label: "X" }, { programType: "Concentration", label: "Y" }], []);
        expect(countDeclaredPrograms(dpr)).toBe(2);
    });
});

describe("detectSharedCourses", () => {
    it("flags a course appearing in two requirement leaves", () => {
        const dpr = makeDpr([{ programType: "Major", label: "M" }], [
            leaf("R1", [row("ECON-UA", "1")]),
            leaf("R2", [row("ECON-UA", "1"), row("MATH-UA", "121")]),
        ]);
        const r = detectSharedCourses(dpr);
        expect(r.sharedCourseCount).toBe(1);
        expect(r.sharedCourseIds).toEqual(["ECON-UA 1"]);
    });
    it("returns 0 when no course is reused across leaves", () => {
        const dpr = makeDpr([{ programType: "Major", label: "M" }], [
            leaf("R1", [row("ECON-UA", "1")]),
            leaf("R2", [row("MATH-UA", "121")]),
        ]);
        expect(detectSharedCourses(dpr).sharedCourseCount).toBe(0);
    });
    it("does not count a course repeated within a single leaf as shared", () => {
        const dpr = makeDpr([{ programType: "Major", label: "M" }], [
            leaf("R1", [row("ECON-UA", "1"), row("ECON-UA", "1")]),
        ]);
        expect(detectSharedCourses(dpr).sharedCourseCount).toBe(0);
    });
    it("walks nested requirement groups", () => {
        const dpr = makeDpr([{ programType: "Major", label: "M" }], []);
        dpr.requirementGroups = [{
            rgId: "RG1", title: "root", status: "satisfied", statusText: "",
            children: [{
                rgId: "RG2", title: "sub", status: "satisfied", statusText: "",
                children: [leaf("R1", [row("ECON-UA", "1")]), leaf("R2", [row("ECON-UA", "1")])],
            }],
        }];
        expect(detectSharedCourses(dpr).sharedCourseCount).toBe(1);
    });
});

describe("buildDoubleCountAdvisory", () => {
    const twoPrograms = [{ programType: "Major", label: "Economics" }, { programType: "Minor", label: "CS" }];

    it("returns null for a single-program student", () => {
        const dpr = makeDpr([{ programType: "Major", label: "Economics" }], []);
        expect(buildDoubleCountAdvisory(dpr, schoolConfig(CAS_DC))).toBeNull();
    });

    it("returns a QUANTIFIED cited disclaimer for a multi-program CAS student", () => {
        const dpr = makeDpr(twoPrograms, []);
        const d = buildDoubleCountAdvisory(dpr, schoolConfig(CAS_DC));
        expect(d).not.toBeNull();
        expect(d!.id).toBe("double_count_advisory");
        expect(d!.text).toContain("up to 2");
        expect(d!.text.toLowerCase()).toContain("double-count");
        expect(d!.text).toContain("adviser");
        expect(d!.bulletinSource).toBe(CAS_DC!.sourceRef);
    });

    it("describes the FLOOR model for a multi-program NYUAD student", () => {
        const dpr = makeDpr(twoPrograms, []);
        const d = buildDoubleCountAdvisory(dpr, schoolConfig(NYUAD_DC, "NYU Abu Dhabi"));
        expect(d!.text).toContain("30");
        expect(d!.text).toContain("unique");
        expect(d!.bulletinSource).toBe(NYUAD_DC!.sourceRef);
    });

    it("returns a GENERIC (uncited) disclaimer for a multi-program student at a school with no config", () => {
        const dpr = makeDpr(twoPrograms, []);
        const d = buildDoubleCountAdvisory(dpr, schoolConfig(undefined, "NYU Tisch"));
        expect(d).not.toBeNull();
        expect(d!.text.toLowerCase()).toContain("double-count");
        expect(d!.text).toContain("adviser");
        expect(d!.bulletinSource).toBeUndefined();
    });

    it("returns null when schoolConfig is null and student is single-program", () => {
        const dpr = makeDpr([{ programType: "Major", label: "M" }], []);
        expect(buildDoubleCountAdvisory(dpr, null)).toBeNull();
    });
    it("degrades to a well-formed number-free advisory when a config yields no numeric clause", () => {
        const dpr = makeDpr(twoPrograms, []);
        const emptyDc: SchoolConfig["doubleCounting"] = {
            cap: {}, floor: {}, noTripleCounting: true, requiresApproval: true,
            sourceRef: "data/bulletin-raw/x:1",
        };
        const d = buildDoubleCountAdvisory(dpr, schoolConfig(emptyDc, "Edge School"));
        expect(d).not.toBeNull();
        expect(d!.text).not.toContain(", ."); // no malformed empty clause
        expect(d!.text).not.toContain("  "); // no double space
        expect(d!.text.toLowerCase()).toContain("double-count");
        expect(d!.bulletinSource).toBe("data/bulletin-raw/x:1"); // still cites the config
    });
    it("surfaces the cited note nuance in the quantified advisory", () => {
        const dpr = makeDpr(twoPrograms, []);
        const dcWithNote: SchoolConfig["doubleCounting"] = {
            cap: { majorToMajor: 2 }, noTripleCounting: true, requiresApproval: true,
            note: "some departments allow only one shared course",
            sourceRef: "data/bulletin-raw/y:2",
        };
        const d = buildDoubleCountAdvisory(dpr, schoolConfig(dcWithNote));
        expect(d!.text).toContain("some departments allow only one shared course");
    });
});
