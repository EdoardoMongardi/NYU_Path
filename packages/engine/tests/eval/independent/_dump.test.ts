// Diagnostic dump test — prints actual engine output for each profile so we
// can compare side-by-side with the bulletin-predicted table in
// independent_fixtures.md. This file is intentionally noisy on stdout; it
// always passes. The bulletin-derived assertions live in independent.test.ts.

import { describe, it } from "vitest";
import type { Course, Program, StudentProfile, SchoolConfig } from "@nyupath/shared";
import { degreeAudit } from "../../../src/audit/degreeAudit.js";
import { crossProgramAudit } from "../../../src/audit/crossProgramAudit.js";
import { checkTransferEligibility } from "../../../src/audit/checkTransferEligibility.js";
import { calculateStanding } from "../../../src/audit/academicStanding.js";
import { decideSpsEnrollment } from "../../../src/audit/spsEnrollmentGuard.js";
import { loadCourses, loadProgram, loadSchoolConfig } from "../../../src/dataLoader.js";

const cs = loadProgram("cs_major_ba", "2023")!;
const COURSES: Course[] = loadCourses();
const casCfg = loadSchoolConfig("cas")!;

function dump(label: string, data: unknown): void {
    // eslint-disable-next-line no-console
    console.log(`\n===== ${label} =====`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, null, 2));
}

const PROFILES: Array<{ id: string; profile: StudentProfile }> = [];

PROFILES.push({
    id: "1-real",
    profile: {
        id: "anonymous-student-real-01",
        catalogYear: "2023",
        homeSchool: "cas",
        declaredPrograms: [
            { programId: "cs_major_ba", programType: "major", declaredAt: "2024-fall", declaredUnderCatalogYear: "2023" },
        ],
        coursesTaken: [
            { courseId: "CORE-UA 500", grade: "P", semester: "2023-fall", credits: 4, gradeMode: "pf" },
            { courseId: "CSCI-UA 102", grade: "B", semester: "2023-fall", credits: 4 },
            { courseId: "EXPOS-UA 5", grade: "B+", semester: "2023-fall", credits: 4 },
            { courseId: "IMNY-UT 99", grade: "P", semester: "2023-fall", credits: 0 },
            { courseId: "IMNY-UT 101", grade: "A", semester: "2023-fall", credits: 4 },
            { courseId: "IMNY-UT 102", grade: "A", semester: "2023-fall", credits: 4 },
            { courseId: "ASPP-UT 2", grade: "B", semester: "2024-spring", credits: 4 },
            { courseId: "CSCI-UA 201", grade: "B+", semester: "2024-spring", credits: 4 },
            { courseId: "MATH-UA 120", grade: "B+", semester: "2024-spring", credits: 4 },
            { courseId: "SPAN-UA 1", grade: "A-", semester: "2024-spring", credits: 4 },
            { courseId: "CSCI-UA 202", grade: "A", semester: "2024-fall", credits: 4 },
            { courseId: "ECON-UA 1", grade: "B", semester: "2024-fall", credits: 4 },
            { courseId: "MATH-UA 123", grade: "A-", semester: "2024-fall", credits: 4 },
            { courseId: "MATH-UA 140", grade: "A-", semester: "2024-fall", credits: 4 },
        ],
        transferCourses: [
            { source: "AP Calculus BC (AB sub-score)", scoreOrGrade: "5", nyuEquivalent: "MATH-UA 121", credits: 4 },
            { source: "AP Calculus BC", scoreOrGrade: "5", nyuEquivalent: "MATH-UA 122", credits: 4 },
            { source: "AP Microeconomics", scoreOrGrade: "5", nyuEquivalent: "ECON-UA 2", credits: 4 },
            { source: "AP Physics C: E&M", scoreOrGrade: "5", credits: 4 },
            { source: "AP Physics C: Mechanics", scoreOrGrade: "5", credits: 4 },
            { source: "AP Chinese Language and Culture", scoreOrGrade: "5", credits: 4 },
            { source: "AP Computer Science A", scoreOrGrade: "5", nyuEquivalent: "CSCI-UA 101", credits: 4 },
            { source: "AP World History", scoreOrGrade: "5", credits: 4 },
        ],
        currentSemester: {
            term: "2025-spring",
            courses: [
                { courseId: "CSCI-UA 310", title: "Basic Algorithms", credits: 4 },
                { courseId: "MATH-UA 233", title: "Theory of Probability", credits: 4 },
                { courseId: "MATH-UA 325", title: "Analysis", credits: 4 },
            ],
        },
        uaSuffixCredits: 40,
        nonCASNYUCredits: 12,
        passfailCredits: 0,
        matriculationYear: 2023,
        visaStatus: "domestic",
    },
});

PROFILES.push({
    id: "2-soph",
    profile: {
        id: "synthetic-cas-sophomore-cs-noap",
        catalogYear: "2023",
        homeSchool: "cas",
        declaredPrograms: [
            { programId: "cs_major_ba", programType: "major", declaredAt: "2024-spring", declaredUnderCatalogYear: "2023" },
        ],
        coursesTaken: [
            { courseId: "CSCI-UA 101", grade: "B", semester: "2023-fall", credits: 4 },
            { courseId: "MATH-UA 121", grade: "B+", semester: "2023-fall", credits: 4 },
            { courseId: "EXPOS-UA 1", grade: "A-", semester: "2023-fall", credits: 4 },
            { courseId: "CORE-UA 400", grade: "A", semester: "2023-fall", credits: 4 },
            { courseId: "CSCI-UA 102", grade: "B+", semester: "2024-spring", credits: 4 },
            { courseId: "MATH-UA 120", grade: "A-", semester: "2024-spring", credits: 4 },
            { courseId: "CORE-UA 500", grade: "A", semester: "2024-spring", credits: 4 },
            { courseId: "FREN-UA 1", grade: "B", semester: "2024-spring", credits: 4 },
            { courseId: "CSCI-UA 201", grade: "B", semester: "2024-fall", credits: 4 },
            { courseId: "FREN-UA 2", grade: "B+", semester: "2024-fall", credits: 4 },
            { courseId: "CORE-UA 760", grade: "A-", semester: "2024-fall", credits: 4 },
            { courseId: "CORE-UA 200", grade: "A", semester: "2024-fall", credits: 4 },
        ],
        uaSuffixCredits: 48,
        passfailCredits: 0,
        matriculationYear: 2023,
        visaStatus: "domestic",
    },
});

PROFILES.push({
    id: "3-stern-eligible",
    profile: {
        id: "synthetic-cas-junior-stern-eligible",
        catalogYear: "2023",
        homeSchool: "cas",
        declaredPrograms: [
            { programId: "cs_major_ba", programType: "major", declaredAt: "2023-fall", declaredUnderCatalogYear: "2023" },
        ],
        coursesTaken: [
            { courseId: "CSCI-UA 101", grade: "A", semester: "2023-fall", credits: 4 },
            { courseId: "MATH-UA 121", grade: "A-", semester: "2023-fall", credits: 4 },
            { courseId: "EXPOS-UA 1", grade: "A-", semester: "2023-fall", credits: 4 },
            { courseId: "CORE-UA 400", grade: "A-", semester: "2023-fall", credits: 4 },
            { courseId: "CSCI-UA 102", grade: "B+", semester: "2024-spring", credits: 4 },
            { courseId: "MATH-UA 120", grade: "B+", semester: "2024-spring", credits: 4 },
            { courseId: "ECON-UA 2", grade: "A-", semester: "2024-spring", credits: 4 },
            { courseId: "ACCT-UB 1", grade: "B+", semester: "2024-spring", credits: 4 },
            { courseId: "CSCI-UA 201", grade: "A-", semester: "2024-fall", credits: 4 },
            { courseId: "MATH-UA 235", grade: "B+", semester: "2024-fall", credits: 4 },
            { courseId: "FREN-UA 1", grade: "A-", semester: "2024-fall", credits: 4 },
            { courseId: "CORE-UA 500", grade: "A", semester: "2024-fall", credits: 4 },
            { courseId: "CSCI-UA 202", grade: "A", semester: "2025-spring", credits: 4 },
            { courseId: "MATH-UA 122", grade: "A", semester: "2025-spring", credits: 4 },
            { courseId: "FREN-UA 2", grade: "A-", semester: "2025-spring", credits: 4 },
            { courseId: "CORE-UA 760", grade: "B+", semester: "2025-spring", credits: 4 },
        ],
        uaSuffixCredits: 60,
        nonCASNYUCredits: 4,
        passfailCredits: 0,
        matriculationYear: 2023,
        visaStatus: "domestic",
    },
});

PROFILES.push({
    id: "4-missing-micro",
    profile: {
        ...PROFILES[2]!.profile,
        id: "synthetic-cas-junior-missing-micro",
        coursesTaken: PROFILES[2]!.profile.coursesTaken.map((c) =>
            c.courseId === "ECON-UA 2" ? { ...c, courseId: "ECON-UA 1" } : c,
        ),
    },
});

PROFILES.push({
    id: "5-pf-overcap",
    profile: {
        id: "synthetic-cas-pf-overcap",
        catalogYear: "2023",
        homeSchool: "cas",
        declaredPrograms: [
            { programId: "cs_major_ba", programType: "major", declaredAt: "2024-fall", declaredUnderCatalogYear: "2023" },
        ],
        coursesTaken: [
            { courseId: "CSCI-UA 101", grade: "A", semester: "2022-fall", credits: 4 },
            { courseId: "MATH-UA 121", grade: "A-", semester: "2022-fall", credits: 4 },
            { courseId: "EXPOS-UA 1", grade: "P", semester: "2022-fall", credits: 4, gradeMode: "pf" },
            { courseId: "CORE-UA 400", grade: "P", semester: "2022-fall", credits: 4, gradeMode: "pf" },
            { courseId: "CSCI-UA 102", grade: "B+", semester: "2023-spring", credits: 4 },
            { courseId: "MATH-UA 120", grade: "A-", semester: "2023-spring", credits: 4 },
            { courseId: "CORE-UA 500", grade: "P", semester: "2023-spring", credits: 4, gradeMode: "pf" },
            { courseId: "FREN-UA 1", grade: "P", semester: "2023-spring", credits: 4, gradeMode: "pf" },
            { courseId: "CSCI-UA 201", grade: "B", semester: "2023-fall", credits: 4 },
            { courseId: "FREN-UA 2", grade: "P", semester: "2023-fall", credits: 4, gradeMode: "pf" },
            { courseId: "CORE-UA 760", grade: "P", semester: "2023-fall", credits: 4, gradeMode: "pf" },
            { courseId: "CORE-UA 200", grade: "P", semester: "2024-spring", credits: 4, gradeMode: "pf" },
            { courseId: "CSCI-UA 202", grade: "B", semester: "2024-spring", credits: 4 },
            { courseId: "ANTH-UA 2", grade: "P", semester: "2024-fall", credits: 4, gradeMode: "pf" },
            { courseId: "PSYCH-UA 1", grade: "P", semester: "2024-fall", credits: 4, gradeMode: "pf" },
        ],
        uaSuffixCredits: 60,
        passfailCredits: 36,
        matriculationYear: 2022,
        visaStatus: "domestic",
    },
});

PROFILES.push({
    id: "6-w-and-i",
    profile: {
        id: "synthetic-cas-w-and-i-grades",
        catalogYear: "2023",
        homeSchool: "cas",
        declaredPrograms: [
            { programId: "cs_major_ba", programType: "major", declaredAt: "2023-fall", declaredUnderCatalogYear: "2023" },
        ],
        coursesTaken: [
            { courseId: "CSCI-UA 101", grade: "B", semester: "2023-fall", credits: 4 },
            { courseId: "MATH-UA 121", grade: "B+", semester: "2023-fall", credits: 4 },
            { courseId: "EXPOS-UA 1", grade: "A-", semester: "2023-fall", credits: 4 },
            { courseId: "CORE-UA 400", grade: "W", semester: "2023-fall", credits: 4 },
            { courseId: "CSCI-UA 102", grade: "C+", semester: "2024-spring", credits: 4 },
            { courseId: "MATH-UA 120", grade: "I", semester: "2024-spring", credits: 4 },
            { courseId: "CORE-UA 500", grade: "B", semester: "2024-spring", credits: 4 },
            { courseId: "FREN-UA 1", grade: "B+", semester: "2024-spring", credits: 4 },
            { courseId: "CSCI-UA 201", grade: "B", semester: "2024-fall", credits: 4 },
            { courseId: "FREN-UA 2", grade: "W", semester: "2024-fall", credits: 4 },
            { courseId: "CORE-UA 760", grade: "A-", semester: "2024-fall", credits: 4 },
            { courseId: "CORE-UA 200", grade: "B+", semester: "2024-fall", credits: 4 },
        ],
        uaSuffixCredits: 48,
        passfailCredits: 0,
        matriculationYear: 2023,
        visaStatus: "domestic",
    },
});

describe("dump engine output for each profile", () => {
    for (const { id, profile } of PROFILES) {
        it(`dump ${id}`, () => {
            const audit = degreeAudit(profile, cs, COURSES, casCfg);
            const trans = checkTransferEligibility(profile, "stern");
            const stand = calculateStanding(profile.coursesTaken, 4, casCfg);
            const sps = {
                cscia102: decideSpsEnrollment("CSCI-UA 102", casCfg),
                rebs1uc: decideSpsEnrollment("REBS1-UC 1234", casCfg),
            };
            const programs = new Map<string, Program>([[cs.programId, cs]]);
            const xprog = crossProgramAudit(profile, programs, COURSES, casCfg);
            dump(`${id} :: degreeAudit`, audit);
            dump(`${id} :: checkTransferEligibility(stern)`, trans);
            dump(`${id} :: calculateStanding`, stand);
            dump(`${id} :: decideSpsEnrollment`, sps);
            dump(`${id} :: crossProgramAudit warnings`, {
                warnings: xprog.warnings,
                shared: xprog.sharedCourses,
                programCount: xprog.programs.length,
            });
        });
    }
});
