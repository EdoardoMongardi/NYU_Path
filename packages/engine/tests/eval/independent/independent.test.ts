// =============================================================================
// Independent (bulletin-only) test harness.
//
// IMPORTANT: The assertions in this file come from BULLETIN reading only,
// expressed as predictions in independent_fixtures.md. They are NOT cribbed
// from existing engine tests, and they DO NOT match what the engine actually
// returns by construction — the point is to surface mismatches.
//
// Each `expect(...)` is paired with a comment citing the bulletin line that
// drives the prediction. When the expectation FAILS, that's a candidate
// engine bug or a documented "engine encoding diverges from bulletin".
// =============================================================================

import { describe, it, expect } from "vitest";
import type { Course, Program, StudentProfile, SchoolConfig } from "@nyupath/shared";
import { degreeAudit } from "../../../src/audit/degreeAudit.js";
import { crossProgramAudit } from "../../../src/audit/crossProgramAudit.js";
import { decideSpsEnrollment } from "../../../src/audit/spsEnrollmentGuard.js";
import { calculateStanding } from "../../../src/audit/academicStanding.js";
import { loadCourses, loadProgram, loadSchoolConfig } from "../../../src/dataLoader.js";

// ---- helpers ----------------------------------------------------------------

function getCsBaProgram(): Program {
    const p = loadProgram("cs_major_ba", "2023");
    if (!p) throw new Error("cs_major_ba program missing from bundled data");
    return p;
}

function getCasConfig(): SchoolConfig {
    const r = loadSchoolConfig("cas");
    if (!r) throw new Error("CAS school config did not load");
    return r;
}

const COURSES: Course[] = loadCourses();

// ---- profiles ---------------------------------------------------------------

const PROFILE_1_REAL: StudentProfile = {
    id: "anonymous-student-real-01",
    catalogYear: "2023",
    homeSchool: "cas",
    declaredPrograms: [
        {
            programId: "cs_major_ba",
            programType: "major",
            declaredAt: "2024-fall",
            declaredUnderCatalogYear: "2023",
        },
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
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2023,
    visaStatus: "domestic",
};

const PROFILE_2_SOPH: StudentProfile = {
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
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2023,
    visaStatus: "domestic",
};

const PROFILE_3_STERN_ELIGIBLE: StudentProfile = {
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
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2023,
    visaStatus: "domestic",
};

const PROFILE_5_PF_OVERCAP: StudentProfile = {
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
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 36,
    matriculationYear: 2022,
    visaStatus: "domestic",
};

const PROFILE_6_W_AND_I: StudentProfile = {
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
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2023,
    visaStatus: "domestic",
};

// ---- tests ------------------------------------------------------------------

describe("Independent fixtures — bulletin-derived expectations", () => {
    const cs = getCsBaProgram();
    const casCfg = getCasConfig();

    // ---------- Profile 1: real transcript ----------
    describe("Profile 1 — real transcript student", () => {
        const s = PROFILE_1_REAL;

        it("degreeAudit: overallStatus is in_progress", () => {
            const r = degreeAudit(s, cs, COURSES, casCfg);
            // CS BA bulletin L138-150: 12 4-credit major courses required.
            // Student has only some core CSCI; Spring 2025 is in progress.
            expect(r.overallStatus).toBe("in_progress");
        });

        it("degreeAudit: cs_ba_intro satisfied via AP CS A → CSCI-UA 101", () => {
            const r = degreeAudit(s, cs, COURSES, casCfg);
            // CS BA bulletin L260: "AP credit for Computer Science A is the equivalent of CSCI-UA 101 ... and counts toward the major"
            const intro = r.rules.find((x) => x.ruleId === "cs_ba_intro");
            expect(intro?.status).toBe("satisfied");
        });

        it("degreeAudit: cs_ba_core has CSCI-UA 102, 201, 202 satisfying; missing 310", () => {
            const r = degreeAudit(s, cs, COURSES, casCfg);
            // CS BA bulletin L138-143: CS Core = 102, 201, 202, 310. Student has 102 (B), 201 (B+), 202 (A); 310 in progress.
            const core = r.rules.find((x) => x.ruleId === "cs_ba_core");
            expect(core?.status).toBe("in_progress");
            expect(core?.coursesRemaining).toContain("CSCI-UA 310");
        });

        it("degreeAudit: cs_ba_math_calculus satisfied via AP MATH-UA 121", () => {
            const r = degreeAudit(s, cs, COURSES, casCfg);
            // CS BA bulletin L147 + L260 (AP).
            const calc = r.rules.find((x) => x.ruleId === "cs_ba_math_calculus");
            expect(calc?.status).toBe("satisfied");
        });

        it("decideSpsEnrollment: CSCI-UA 102 is not an SPS course → allowed", () => {
            const d = decideSpsEnrollment("CSCI-UA 102", casCfg);
            // spsEnrollmentGuard contract: only -UC/-CE suffixes are SPS.
            expect(d.enrollment).toBe("allowed");
        });

        it("decideSpsEnrollment: REBS1-UC 1234 allowed for CAS", () => {
            const d = decideSpsEnrollment("REBS1-UC 1234", casCfg);
            // CAS school config: SPS allowed prefixes include REBS1-UC.
            expect(d.enrollment).toBe("allowed");
        });

        it("calculateStanding: cumulative GPA ≈ 3.50 (matches transcript)", () => {
            const r = calculateStanding(s.coursesTaken, 3, casCfg);
            // Transcript prints cumulative GPA 3.500. CAS bulletin L350-362 grade-point map.
            expect(r.cumulativeGPA).toBeGreaterThan(3.45);
            expect(r.cumulativeGPA).toBeLessThan(3.55);
            expect(r.level).toBe("good_standing");
        });
    });

    // ---------- Profile 2: CAS sophomore mid-CS-major, no AP ----------
    describe("Profile 2 — CAS sophomore mid-CS-major, no AP", () => {
        const s = PROFILE_2_SOPH;

        it("degreeAudit: overallStatus = in_progress; intro and discrete satisfied; core in_progress", () => {
            const r = degreeAudit(s, cs, COURSES, casCfg);
            expect(r.overallStatus).toBe("in_progress");
            expect(r.rules.find((x) => x.ruleId === "cs_ba_intro")?.status).toBe("satisfied");
            expect(r.rules.find((x) => x.ruleId === "cs_ba_math_calculus")?.status).toBe("satisfied");
            expect(r.rules.find((x) => x.ruleId === "cs_ba_math_discrete")?.status).toBe("satisfied");
            const core = r.rules.find((x) => x.ruleId === "cs_ba_core");
            expect(core?.status).toBe("in_progress");
            expect(new Set(core?.coursesRemaining ?? [])).toEqual(new Set(["CSCI-UA 202", "CSCI-UA 310"]));
        });

        it("calculateStanding: cumulative GPA ≈ 3.50", () => {
            const r = calculateStanding(s.coursesTaken, 3, casCfg);
            expect(r.cumulativeGPA).toBeGreaterThan(3.40);
            expect(r.cumulativeGPA).toBeLessThan(3.60);
            expect(r.level).toBe("good_standing");
        });
    });

    // ---------- Profile 3: junior nearly Stern-eligible ----------
    describe("Profile 3 — CAS junior nearly Stern-eligible", () => {
        const s = PROFILE_3_STERN_ELIGIBLE;

        it("calculateStanding: GPA ≥ 3.5 (all grades A-/B+/A)", () => {
            const r = calculateStanding(s.coursesTaken, 4, casCfg);
            expect(r.cumulativeGPA).toBeGreaterThan(3.5);
            expect(r.level).toBe("good_standing");
        });
    });

    // ---------- Profile 5: P/F over career cap ----------
    describe("Profile 5 — exceeds 32-credit P/F career cap", () => {
        const s = PROFILE_5_PF_OVERCAP;

        it("degreeAudit: warnings include something about pass/fail or 32-credit cap", () => {
            const r = degreeAudit(s, cs, COURSES, casCfg);
            // CAS academic-policies L410: "Students may elect one Pass/Fail option each term ... for a total of not more than 32 credits during their college career."
            // types.ts L429: "Total P/F credits taken career-wide [GEN-ACAD] §A3.5 — max 32 allowed".
            // The engine SHOULD flag passfailCredits = 36 > 32.
            const warningString = r.warnings.join(" | ").toLowerCase();
            expect(
                warningString.includes("pass/fail") ||
                    warningString.includes("passfail") ||
                    warningString.includes("32"),
            ).toBe(true);
        });

        it("calculateStanding: P credits don't enter GPA; level = good_standing", () => {
            const r = calculateStanding(s.coursesTaken, 5, casCfg);
            // CAS academic-policies L386: "The grade of P ... is not computed in the average."
            expect(r.level).toBe("good_standing");
            expect(r.cumulativeGPA).toBeGreaterThan(2.0);
        });
    });

    // ---------- Profile 6: W and I ----------
    describe("Profile 6 — student with W and I grades", () => {
        const s = PROFILE_6_W_AND_I;

        it("degreeAudit: cs_ba_math_discrete is in_progress (MATH-UA 120 = I)", () => {
            const r = degreeAudit(s, cs, COURSES, casCfg);
            // CAS academic-policies L394 (NR analogy: not earned credit) + L400-406 (I = temporary).
            const discrete = r.rules.find((x) => x.ruleId === "cs_ba_math_discrete");
            expect(discrete?.status).not.toBe("satisfied");
        });

        it("calculateStanding: completionRate uses attempted vs earned correctly", () => {
            const r = calculateStanding(s.coursesTaken, 3, casCfg);
            // Bulletin L394: NR = attempted but not earned. By analogy I = attempted but not yet earned.
            // W: bulletin L390 + L516 — not in GPA, but "indicates an official withdrawal" in good standing.
            //   Engineering question: is W counted as attempted? CAS bulletin doesn't say W is attempted.
            //   The analytic interpretation most students/advisors use: W is NOT attempted for completion-rate purposes.
            //   So attempted = 12 - 2(W) = 10 courses x 4 = 40; earned = 9 courses x 4 = 36; ratio = 0.90.
            //   But engine could legitimately count W as attempted. Either way ratio >= 0.75, so good_standing.
            expect(r.completionRate).toBeGreaterThanOrEqual(0.75);
            expect(r.cumulativeGPA).toBeGreaterThan(2.0);
            expect(r.level).toBe("good_standing");
        });

        it("calculateStanding: GPA computed only over letter grades (not W or I)", () => {
            const r = calculateStanding(s.coursesTaken, 3, casCfg);
            // Predicted GPA ≈ 3.185 if W and I are excluded. Allow 3.10-3.30.
            expect(r.cumulativeGPA).toBeGreaterThan(3.05);
            expect(r.cumulativeGPA).toBeLessThan(3.30);
        });
    });

    // ---------- crossProgramAudit smoke ----------
    describe("crossProgramAudit — single program produces no double-count warnings", () => {
        const s = PROFILE_2_SOPH;
        it("returns one entry, no warnings, no shared courses", () => {
            const programs = new Map<string, Program>([[cs.programId, cs]]);
            const r = crossProgramAudit(s, programs, COURSES, casCfg);
            expect(r.programs).toHaveLength(1);
            expect(r.warnings).toHaveLength(0);
            expect(r.sharedCourses).toHaveLength(0);
        });
    });
});
