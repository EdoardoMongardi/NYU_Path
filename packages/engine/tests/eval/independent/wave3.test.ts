// =============================================================================
// Wave 3 — Independent (bulletin-only) test harness for Phase 3 modules.
//
// IMPORTANT: The assertions in this file come from BULLETIN reading + the
// engine's exported function SIGNATURES only (no engine source bodies were
// read except where noted in wave3_fixtures.md). Each `expect(...)` is paired
// with a comment citing the bulletin/signature line that drives the
// prediction.
// =============================================================================

import { describe, it, expect } from "vitest";
import type {
    Course,
    Program,
    StudentProfile,
    SchoolConfig,
    PlannerConfig,
    Prerequisite,
} from "@nyupath/shared";

import {
    loadCourses,
    loadProgram,
    loadPrograms,
    loadPrereqs,
    loadSchoolConfig,
} from "../../../src/dataLoader.js";

import { projectMultiSemester } from "../../../src/planner/multiSemesterProjector.js";
import { planExploratory } from "../../../src/planner/explorePlanner.js";
import { planForTransferPrep } from "../../../src/planner/transferPrepPlanner.js";
import { planMultiProgram } from "../../../src/planner/crossProgramPlanner.js";
import {
    parseTranscript,
    transcriptToProfileDraft,
    buildConfirmationSummary,
} from "../../../src/transcript/index.js";

// ---- helpers ----------------------------------------------------------------

function getCsBaProgram(): Program {
    const p = loadProgram("cs_major_ba", "2023");
    if (!p) throw new Error("cs_major_ba program missing from bundled data");
    return p;
}
function getCasCoreProgram(): Program {
    const p = loadProgram("cas_core", "2023");
    if (!p) throw new Error("cas_core program missing from bundled data");
    return p;
}
function getSchoolCfg(schoolId: string): SchoolConfig {
    const r = loadSchoolConfig(schoolId);
    if (!r) throw new Error(`${schoolId} school config did not load`);
    return r;
}

const COURSES: Course[] = loadCourses();
const PREREQS: Prerequisite[] = loadPrereqs();
const ALL_PROGRAMS = loadPrograms();
const PROGRAMS_MAP = new Map<string, Program>();
for (const p of ALL_PROGRAMS) {
    // last one wins per programId — there's only one of each at the time of
    // wave 3 authoring (programs.json contains only cs_major_ba + cas_core).
    PROGRAMS_MAP.set(p.programId, p);
}

const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
    targetSemester: "2025-fall",
    maxCourses: 5,
    maxCredits: 18,
};

// =============================================================================
// Profile 1 — Multi-semester projection: graduation semester
// =============================================================================

const PROFILE_1: StudentProfile = {
    id: "synthetic-cas-junior-multisem-grad",
    catalogYear: "2023",
    homeSchool: "cas",
    declaredPrograms: [
        { programId: "cs_major_ba", programType: "major", declaredAt: "2023-fall", declaredUnderCatalogYear: "2023" },
    ],
    coursesTaken: [
        { courseId: "CSCI-UA 101", grade: "A", semester: "2023-fall", credits: 4 },
        { courseId: "MATH-UA 121", grade: "A-", semester: "2023-fall", credits: 4 },
        { courseId: "EXPOS-UA 1", grade: "A-", semester: "2023-fall", credits: 4 },
        { courseId: "FYSEM-UA 50", grade: "A", semester: "2023-fall", credits: 4 },
        { courseId: "CSCI-UA 102", grade: "B+", semester: "2024-spring", credits: 4 },
        { courseId: "MATH-UA 120", grade: "A-", semester: "2024-spring", credits: 4 },
        { courseId: "ECON-UA 2", grade: "A-", semester: "2024-spring", credits: 4 },
        { courseId: "CORE-UA 400", grade: "A-", semester: "2024-spring", credits: 4 },
        { courseId: "CSCI-UA 201", grade: "A-", semester: "2024-fall", credits: 4 },
        { courseId: "MATH-UA 235", grade: "B+", semester: "2024-fall", credits: 4 },
        { courseId: "FREN-UA 1", grade: "A-", semester: "2024-fall", credits: 4 },
        { courseId: "CORE-UA 500", grade: "A", semester: "2024-fall", credits: 4 },
        { courseId: "CSCI-UA 202", grade: "A", semester: "2025-spring", credits: 4 },
        { courseId: "CSCI-UA 310", grade: "B+", semester: "2025-spring", credits: 4 },
        { courseId: "FREN-UA 2", grade: "A-", semester: "2025-spring", credits: 4 },
        { courseId: "CORE-UA 760", grade: "B+", semester: "2025-spring", credits: 4 },
    ],
    transferCourses: [
        { source: "AP Calculus BC", scoreOrGrade: "5", nyuEquivalent: "MATH-UA 121", credits: 4 },
        { source: "AP Computer Science A", scoreOrGrade: "5", nyuEquivalent: "CSCI-UA 101", credits: 4 },
        { source: "AP Microeconomics", scoreOrGrade: "5", nyuEquivalent: "ECON-UA 2", credits: 4 },
        { source: "AP Macroeconomics", scoreOrGrade: "5", credits: 4 },
        { source: "AP World History", scoreOrGrade: "5", credits: 4 },
        { source: "AP English Lit", scoreOrGrade: "5", credits: 4 },
        { source: "AP Spanish Lang", scoreOrGrade: "5", credits: 4 },
        { source: "AP US History", scoreOrGrade: "5", credits: 4 },
    ],
    uaSuffixCredits: 60,
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2023,
    visaStatus: "domestic",
};

// =============================================================================
// Profile 2 — Multi-semester projection: early halt with note
// =============================================================================

const PROFILE_2: StudentProfile = {
    id: "synthetic-cas-senior-cs-major-complete",
    catalogYear: "2023",
    homeSchool: "cas",
    declaredPrograms: [
        { programId: "cs_major_ba", programType: "major", declaredAt: "2022-fall", declaredUnderCatalogYear: "2023" },
    ],
    coursesTaken: [
        { courseId: "CSCI-UA 101", grade: "A", semester: "2022-fall", credits: 4 },
        { courseId: "MATH-UA 121", grade: "A", semester: "2022-fall", credits: 4 },
        { courseId: "EXPOS-UA 1", grade: "A", semester: "2022-fall", credits: 4 },
        { courseId: "FYSEM-UA 50", grade: "A", semester: "2022-fall", credits: 4 },
        { courseId: "CSCI-UA 102", grade: "A", semester: "2023-spring", credits: 4 },
        { courseId: "MATH-UA 120", grade: "A", semester: "2023-spring", credits: 4 },
        { courseId: "CORE-UA 400", grade: "A", semester: "2023-spring", credits: 4 },
        { courseId: "CORE-UA 500", grade: "A", semester: "2023-spring", credits: 4 },
        { courseId: "CSCI-UA 201", grade: "A", semester: "2023-fall", credits: 4 },
        { courseId: "CSCI-UA 202", grade: "A", semester: "2023-fall", credits: 4 },
        { courseId: "CORE-UA 760", grade: "A", semester: "2023-fall", credits: 4 },
        { courseId: "CORE-UA 200", grade: "A", semester: "2023-fall", credits: 4 },
        { courseId: "CSCI-UA 310", grade: "A", semester: "2024-spring", credits: 4 },
        { courseId: "CSCI-UA 470", grade: "A", semester: "2024-spring", credits: 4 },
        { courseId: "CSCI-UA 472", grade: "A", semester: "2024-spring", credits: 4 },
        { courseId: "CORE-UA 100", grade: "A", semester: "2024-spring", credits: 4 },
        { courseId: "CSCI-UA 473", grade: "A", semester: "2024-fall", credits: 4 },
        { courseId: "CSCI-UA 474", grade: "A", semester: "2024-fall", credits: 4 },
        { courseId: "CSCI-UA 480", grade: "A", semester: "2024-fall", credits: 4 },
        { courseId: "CORE-UA 201", grade: "A", semester: "2024-fall", credits: 4 },
        { courseId: "CSCI-UA 481", grade: "A", semester: "2025-spring", credits: 4 },
        { courseId: "MATH-UA 122", grade: "A", semester: "2025-spring", credits: 4 },
        { courseId: "MATH-UA 140", grade: "A", semester: "2025-spring", credits: 4 },
        { courseId: "MATH-UA 233", grade: "A", semester: "2025-spring", credits: 4 },
        { courseId: "FREN-UA 12", grade: "A", semester: "2025-fall", credits: 4 },
        { courseId: "ECON-UA 1", grade: "A", semester: "2025-fall", credits: 4 },
        { courseId: "PHIL-UA 1", grade: "A", semester: "2025-fall", credits: 4 },
        { courseId: "ANTH-UA 1", grade: "A", semester: "2025-fall", credits: 4 },
        { courseId: "MATH-UA 325", grade: "A", semester: "2026-spring", credits: 4 },
        { courseId: "MATH-UA 328", grade: "A", semester: "2026-spring", credits: 4 },
        { courseId: "MATH-UA 329", grade: "A", semester: "2026-spring", credits: 4 },
    ],
    uaSuffixCredits: 124,
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2022,
    visaStatus: "domestic",
};

// =============================================================================
// Profile 3 — Exploratory mode: undeclared CAS first-year, 0 courses
// =============================================================================

const PROFILE_3: StudentProfile = {
    id: "synthetic-cas-undeclared-zero-courses",
    catalogYear: "2025",
    homeSchool: "cas",
    declaredPrograms: [],
    coursesTaken: [],
    uaSuffixCredits: 0,
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2025,
    visaStatus: "domestic",
};

// =============================================================================
// Profile 4 — Transfer-prep eligible CAS junior (all 5 Stern junior prereqs)
// =============================================================================

const PROFILE_4: StudentProfile = {
    id: "synthetic-cas-junior-stern-eligible-w3",
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

// =============================================================================
// Profile 5 — Cross-program priority: shared MATH-UA 121 should top merged list
// =============================================================================

const PROFILE_5: StudentProfile = {
    id: "synthetic-cas-multiprogram-shared",
    catalogYear: "2024",
    homeSchool: "cas",
    declaredPrograms: [
        { programId: "cs_major_ba", programType: "major", declaredAt: "2024-fall", declaredUnderCatalogYear: "2024" },
        { programId: "cas_core", programType: "minor", declaredAt: "2024-fall", declaredUnderCatalogYear: "2024" },
    ],
    coursesTaken: [
        { courseId: "CSCI-UA 101", grade: "A", semester: "2024-fall", credits: 4 },
        { courseId: "EXPOS-UA 1", grade: "B+", semester: "2024-fall", credits: 4 },
        { courseId: "FYSEM-UA 50", grade: "A", semester: "2024-fall", credits: 4 },
        { courseId: "CORE-UA 400", grade: "B+", semester: "2024-fall", credits: 4 },
    ],
    flags: ["nonEnglishSecondary"],
    uaSuffixCredits: 16,
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2024,
    visaStatus: "domestic",
};

// =============================================================================
// Profile 6 — Real transcript text reconstructed for the parser
// =============================================================================
// The text below is a parser-readable rendition of
// `packages/engine/tests/eval/real_transcripts/sample_01.pdf`. The PDF was
// extracted via the Read tool (the PDF is pure-text, no OCR needed). Field
// values are VERBATIM from the PDF — only the layout is normalized to the
// "Term: <Season Year>" / "Term Totals: AHRS … GPA …" structure the parser
// recognises. Per-row math is preserved exactly (every QPTS field equals the
// PDF's printed value).

const PROFILE_6_TRANSCRIPT_TEXT = `Edoardo Mongardi
N17849249
Beginning of Undergraduate Record

Test Credits Applied Toward Fall 2024
AP Calculus BC  Score 5  → MATH-UA 121 (4 cr)
AP Calculus BC  Score 5  → MATH-UA 122 (4 cr)
AP Microeconomics  Score 5  → ECON-UA 2 (4 cr)
AP Physics C E&M  Score 5  → (4 cr)
AP Physics C Mechanics  Score 5  → (4 cr)
AP Chinese Language and Culture  Score 5  → (4 cr)
AP Computer Science A  Score 5  → CSCI-UA 101 (4 cr)
AP World History  Score 5  → (4 cr)

Term: Fall 2023
COURSE       TITLE                      GRADE EHRS  QHRS  QPTS
CSCI-UA 102  Data Structures            B     4.0   4.0   12.0
EXPOS-UA 5   Writing the Essay          B+    4.0   4.0   13.332
IMNY-UT 99   IMA Cohort                 P     0.0   0.0   0.0
IMNY-UT 101  Creative Computing         A     4.0   4.0   16.0
IMNY-UT 102  Communications Lab         A     4.0   4.0   16.0
Term Totals: AHRS 16.0 EHRS 16.0 QHRS 16.0 QPTS 57.332 GPA 3.583

Term: Spring 2024
COURSE       TITLE                      GRADE EHRS  QHRS  QPTS
ASPP-UT 2    Art Writing                B     4.0   4.0   12.0
CSCI-UA 201  Computer Systems Org       B+    4.0   4.0   13.332
MATH-UA 120  Discrete Mathematics       B+    4.0   4.0   13.332
SPAN-UA 1    Spanish Beginners I        A-    4.0   4.0   14.668
Term Totals: AHRS 16.0 EHRS 16.0 QHRS 16.0 QPTS 53.332 GPA 3.333

Term: Fall 2024
COURSE       TITLE                      GRADE EHRS  QHRS  QPTS
CSCI-UA 202  Operating Systems          A     4.0   4.0   16.0
ECON-UA 1    Intro to Macroeconomics    B     4.0   4.0   12.0
MATH-UA 123  Calculus III               A-    4.0   4.0   14.668
MATH-UA 140  Linear Algebra             A-    4.0   4.0   14.668
Term Totals: AHRS 16.0 EHRS 16.0 QHRS 16.0 QPTS 57.336 GPA 3.584

Term: Spring 2025
COURSE       TITLE                      GRADE EHRS  QHRS  QPTS
CORE-UA 500  Cultures and Contexts      ***   0.0   0.0   0.0
CSCI-UA 310  Basic Algorithms           ***   0.0   0.0   0.0
MATH-UA 233  Theory of Probability      ***   0.0   0.0   0.0
MATH-UA 325  Analysis                   ***   0.0   0.0   0.0
Term Totals: AHRS 16.0 EHRS 0.0 QHRS 0.0 QPTS 0.0 GPA 0.0

AHRS  64.0
EHRS  80.0
QHRS  48.0
QPTS  168.000
GPA   3.500
`;

// =============================================================================
// Tests
// =============================================================================

describe("Wave 3 — Independent fixtures (Phase 3 modules, bulletin-derived)", () => {
    const cs = getCsBaProgram();
    const casCore = getCasCoreProgram();
    const casCfg = getSchoolCfg("cas");

    // ---------- Profile 1: Multi-semester projection — graduation ----------
    describe("Profile 1 — Multi-semester projection: graduation semester", () => {
        it("projectMultiSemester returns at most semesterCount entries", () => {
            const r = projectMultiSemester({
                student: PROFILE_1,
                program: cs,
                courses: COURSES,
                prereqs: PREREQS,
                startSemester: "2025-fall",
                semesterCount: 6,
                schoolConfig: casCfg,
            });
            // multiSemesterProjector.ts:79-99 — loop iterates 0..semesterCount-1.
            expect(r.semesters.length).toBeGreaterThanOrEqual(1);
            expect(r.semesters.length).toBeLessThanOrEqual(6);
        });

        it("projectMultiSemester first iteration uses startSemester", () => {
            const r = projectMultiSemester({
                student: PROFILE_1,
                program: cs,
                courses: COURSES,
                prereqs: PREREQS,
                startSemester: "2025-fall",
                semesterCount: 6,
                schoolConfig: casCfg,
            });
            // L82 — first iteration cursor = startSemester.
            expect(r.semesters[0]?.semester).toBe("2025-fall");
        });

        it("projectMultiSemester second iteration is 2026-spring (Fall→Spring helper)", () => {
            const r = projectMultiSemester({
                student: PROFILE_1,
                program: cs,
                courses: COURSES,
                prereqs: PREREQS,
                startSemester: "2025-fall",
                semesterCount: 6,
                schoolConfig: casCfg,
            });
            // multiSemesterProjector.ts:141-150 — Fall → Spring(year+1).
            if (r.semesters.length >= 2) {
                expect(r.semesters[1]?.semester).toBe("2026-spring");
            }
        });

        it("projectMultiSemester reports a projectedGraduationSemester (≤ 32 cr to add)", () => {
            const r = projectMultiSemester({
                student: PROFILE_1,
                program: cs,
                courses: COURSES,
                prereqs: PREREQS,
                startSemester: "2025-fall",
                semesterCount: 6,
                schoolConfig: casCfg,
            });
            // CS BA totalCreditsRequired = 128; student starts at 64 graded + 32 AP = 96.
            // At ≤ 16 cr/sem (4 four-credit suggestions per planner default), 32 more
            // credits take 2 semesters. multiSemesterProjector.ts:120-121 picks earliest.
            // We don't pin the exact semester — bulletin doesn't dictate whether AP
            // credits flow into projectedTotalCredits. Acceptable answers:
            // {2026-spring, 2026-fall, 2027-spring}.
            expect(r.projectedGraduationSemester).toBeDefined();
            expect(["2026-spring", "2026-fall", "2027-spring"]).toContain(
                r.projectedGraduationSemester,
            );
        });

        it("projectMultiSemester cumulative credits are non-decreasing", () => {
            const r = projectMultiSemester({
                student: PROFILE_1,
                program: cs,
                courses: COURSES,
                prereqs: PREREQS,
                startSemester: "2025-fall",
                semesterCount: 6,
                schoolConfig: casCfg,
            });
            for (let i = 1; i < r.semesters.length; i++) {
                expect(r.semesters[i]!.cumulativeCreditsAtEnd).toBeGreaterThanOrEqual(
                    r.semesters[i - 1]!.cumulativeCreditsAtEnd,
                );
            }
        });

        it("projectMultiSemester notes mention assumed grade", () => {
            const r = projectMultiSemester({
                student: PROFILE_1,
                program: cs,
                courses: COURSES,
                prereqs: PREREQS,
                startSemester: "2025-fall",
                semesterCount: 6,
                schoolConfig: casCfg,
            });
            // multiSemesterProjector.ts:124-127 — the function always pushes a note
            // ending in "Assumed grade for projected courses: …".
            const blob = r.notes.join(" | ").toLowerCase();
            expect(blob).toContain("assumed grade");
        });
    });

    // ---------- Profile 2: Multi-semester projection — early halt ----------
    describe("Profile 2 — Multi-semester projection: early halt with note", () => {
        it("projectMultiSemester halts at first iteration when no suggestions remain", () => {
            const r = projectMultiSemester({
                student: PROFILE_2,
                program: cs,
                courses: COURSES,
                prereqs: PREREQS,
                startSemester: "2026-fall",
                semesterCount: 5,
                schoolConfig: casCfg,
            });
            // multiSemesterProjector.ts:99-107 — once plan.suggestions.length === 0,
            // the loop pushes the empty-plan semester, emits the "halted" note, and
            // breaks. So with all major rules met, the result has exactly 1 entry.
            expect(r.semesters.length).toBe(1);
            expect(r.semesters[0]?.semester).toBe("2026-fall");
        });

        it("projectMultiSemester emits a 'halted' note when zero suggestions are returned", () => {
            const r = projectMultiSemester({
                student: PROFILE_2,
                program: cs,
                courses: COURSES,
                prereqs: PREREQS,
                startSemester: "2026-fall",
                semesterCount: 5,
                schoolConfig: casCfg,
            });
            // multiSemesterProjector.ts:100-104 — verbatim wording "Projection halted at <cursor>".
            const blob = r.notes.join(" | ");
            expect(blob).toMatch(/halted/i);
            expect(blob).toContain("2026-fall");
        });
    });

    // ---------- Profile 3: Exploratory mode ----------
    describe("Profile 3 — Exploratory mode: undeclared CAS student", () => {
        it("planExploratory does NOT return unsupported when CAS has sharedPrograms", () => {
            const r = planExploratory(
                PROFILE_3,
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
                PROGRAMS_MAP,
            );
            // explorePlanner.ts:62-83 — supported when (a) student has 0 declared
            // programs AND (b) sharedPrograms[0] is loadable. cas.json has
            // sharedPrograms: ["cas_core"] (line 110); programs.json bundles cas_core.
            expect("kind" in r).toBe(false);
        });

        it("planExploratory.auditedProgramId === 'cas_core'", () => {
            const r = planExploratory(
                PROFILE_3,
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
                PROGRAMS_MAP,
            );
            if ("kind" in r) throw new Error("planExploratory unexpectedly returned unsupported");
            // explorePlanner.ts:74 — auditedProgramId is sharedPrograms[0].
            expect(r.auditedProgramId).toBe("cas_core");
        });

        it("planExploratory.basis mentions the CAS Core Curriculum", () => {
            const r = planExploratory(
                PROFILE_3,
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
                PROGRAMS_MAP,
            );
            if ("kind" in r) throw new Error("planExploratory unexpectedly returned unsupported");
            // explorePlanner.ts:97-99 — `basis: "Student has no declaredPrograms; audit run against shared core ..."`.
            expect(r.basis.toLowerCase()).toMatch(/cas_core|core curriculum/i);
        });

        it("planExploratory has at least one suggestion (every Core rule is unmet)", () => {
            const r = planExploratory(
                PROFILE_3,
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
                PROGRAMS_MAP,
            );
            if ("kind" in r) throw new Error("planExploratory unexpectedly returned unsupported");
            // 0 courses taken; every cas_core rule (10 of them in programs.json) is
            // not_started. The planner should produce at least one candidate.
            expect(r.plan.suggestions.length).toBeGreaterThan(0);
        });

        it("every suggestion's reason starts with '[exploratory mode' prefix", () => {
            const r = planExploratory(
                PROFILE_3,
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
                PROGRAMS_MAP,
            );
            if ("kind" in r) throw new Error("planExploratory unexpectedly returned unsupported");
            // explorePlanner.ts:90-94 — every suggestion gets re-tagged with the
            // "[exploratory mode — toward <name>]" prefix.
            for (const s of r.plan.suggestions) {
                expect(s.reason.startsWith("[exploratory")).toBe(true);
            }
        });

        it("notes are non-empty and mention undeclared / exploratory", () => {
            const r = planExploratory(
                PROFILE_3,
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
                PROGRAMS_MAP,
            );
            if ("kind" in r) throw new Error("planExploratory unexpectedly returned unsupported");
            // explorePlanner.ts:100-104 — three pre-canned notes.
            expect(r.notes.length).toBeGreaterThan(0);
            const blob = r.notes.join(" | ").toLowerCase();
            expect(blob).toMatch(/exploratory|declared|undeclared/);
        });
    });

    // ---------- Profile 4: Transfer-prep, eligible junior ----------
    describe("Profile 4 — Transfer-prep eligible CAS junior", () => {
        it("planForTransferPrep does NOT return unsupported (cas→stern data exists)", () => {
            const r = planForTransferPrep(
                PROFILE_4,
                cs,
                "stern",
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
            );
            expect("kind" in r).toBe(false);
        });

        it("transferDecision.status === 'eligible'", () => {
            const r = planForTransferPrep(
                PROFILE_4,
                cs,
                "stern",
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
            );
            if ("kind" in r) throw new Error("planForTransferPrep unexpectedly returned unsupported");
            // 5 junior prereqs all satisfied: MATH-UA 121, EXPOS-UA 1, MATH-UA 235,
            // ACCT-UB 1, ECON-UA 2. cas_to_stern.json L78-122.
            expect(r.transferDecision.status).toBe("eligible");
        });

        it("transferDecision.entryYear === 'junior'", () => {
            const r = planForTransferPrep(
                PROFILE_4,
                cs,
                "stern",
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
            );
            if ("kind" in r) throw new Error("planForTransferPrep unexpectedly returned unsupported");
            const decision = r.transferDecision;
            // Narrowing: entryYear is only on the eligible/not_yet_eligible variants.
            if (decision.status !== "eligible" && decision.status !== "not_yet_eligible") {
                throw new Error(`unexpected decision status ${decision.status}`);
            }
            expect(decision.entryYear).toBe("junior");
        });

        it("transferDecision.missingPrereqs is empty", () => {
            const r = planForTransferPrep(
                PROFILE_4,
                cs,
                "stern",
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
            );
            if ("kind" in r) throw new Error("planForTransferPrep unexpectedly returned unsupported");
            const decision = r.transferDecision;
            if (decision.status !== "eligible" && decision.status !== "not_yet_eligible") {
                throw new Error(`unexpected decision status ${decision.status}`);
            }
            expect(decision.missingPrereqs).toHaveLength(0);
        });

        it("deadlineWarnings include 'March 1' (Stern application deadline)", () => {
            const r = planForTransferPrep(
                PROFILE_4,
                cs,
                "stern",
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
            );
            if ("kind" in r) throw new Error("planForTransferPrep unexpectedly returned unsupported");
            // cas_to_stern.json applicationDeadline = "March 1".
            // transferPrepPlanner.ts:93-96 always pushes one deadline warning when
            // status is eligible/not_yet_eligible.
            const blob = r.deadlineWarnings.join(" | ");
            expect(blob).toContain("March 1");
        });

        it("deadlineWarnings include 'fall' (Stern accepted term)", () => {
            const r = planForTransferPrep(
                PROFILE_4,
                cs,
                "stern",
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
            );
            if ("kind" in r) throw new Error("planForTransferPrep unexpectedly returned unsupported");
            // cas_to_stern.json acceptedTerms = ["fall"].
            const blob = r.deadlineWarnings.join(" | ").toLowerCase();
            expect(blob).toContain("fall");
        });

        it("no plan suggestion's reason starts with '[transfer-prereq' (nothing missing)", () => {
            const r = planForTransferPrep(
                PROFILE_4,
                cs,
                "stern",
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
            );
            if ("kind" in r) throw new Error("planForTransferPrep unexpectedly returned unsupported");
            // transferPrepPlanner.ts:108-117 — the prefix is only added to
            // suggestions whose courseId is in missingPrereqs. With 0 missing,
            // the promotedIds set is empty.
            for (const s of r.plan.suggestions) {
                expect(s.reason.startsWith("[transfer-prereq")).toBe(false);
            }
        });

        it("plan.enrollmentWarnings include the deadline string ('March 1')", () => {
            const r = planForTransferPrep(
                PROFILE_4,
                cs,
                "stern",
                COURSES,
                PREREQS,
                DEFAULT_PLANNER_CONFIG,
                casCfg,
            );
            if ("kind" in r) throw new Error("planForTransferPrep unexpectedly returned unsupported");
            // transferPrepPlanner.ts:127 appends deadlineWarnings to the plan's
            // enrollmentWarnings.
            const blob = r.plan.enrollmentWarnings.join(" | ");
            expect(blob).toContain("March 1");
        });
    });

    // ---------- Profile 5: Cross-program priority — shared course +30 ----------
    describe("Profile 5 — Cross-program priority: shared course +30 boost", () => {
        it("planMultiProgram has 2 perProgram entries (one per declaration)", () => {
            const r = planMultiProgram(
                PROFILE_5,
                PROGRAMS_MAP,
                COURSES,
                PREREQS,
                { ...DEFAULT_PLANNER_CONFIG, targetSemester: "2025-spring" },
                casCfg,
            );
            // crossProgramPlanner.ts:65-76.
            expect(r.perProgram).toHaveLength(2);
        });

        it("planMultiProgram.merged is non-empty", () => {
            const r = planMultiProgram(
                PROFILE_5,
                PROGRAMS_MAP,
                COURSES,
                PREREQS,
                { ...DEFAULT_PLANNER_CONFIG, targetSemester: "2025-spring" },
                casCfg,
            );
            expect(r.merged.length).toBeGreaterThan(0);
        });

        it("merged[0].courseId === 'MATH-UA 121' (the only currently-shared unmet course)", () => {
            const r = planMultiProgram(
                PROFILE_5,
                PROGRAMS_MAP,
                COURSES,
                PREREQS,
                { ...DEFAULT_PLANNER_CONFIG, targetSemester: "2025-spring" },
                casCfg,
            );
            // MATH-UA 121 satisfies cs_ba_math_calculus AND core_fsi_quant
            // (programs.json:67 + programs.json:254). It's the ONLY shared candidate
            // for this profile. The +30 SHARED_COURSE_BOOST should rank it first.
            expect(r.merged[0]?.courseId).toBe("MATH-UA 121");
        });

        it("merged[0].reason starts with '[shared across 2 programs:'", () => {
            const r = planMultiProgram(
                PROFILE_5,
                PROGRAMS_MAP,
                COURSES,
                PREREQS,
                { ...DEFAULT_PLANNER_CONFIG, targetSemester: "2025-spring" },
                casCfg,
            );
            // crossProgramPlanner.ts:114-117.
            expect(r.merged[0]?.reason.startsWith("[shared across 2 programs:")).toBe(true);
        });

        it("merged[0].satisfiesRules includes both cs_ba_math_calculus AND core_fsi_quant", () => {
            const r = planMultiProgram(
                PROFILE_5,
                PROGRAMS_MAP,
                COURSES,
                PREREQS,
                { ...DEFAULT_PLANNER_CONFIG, targetSemester: "2025-spring" },
                casCfg,
            );
            // crossProgramPlanner.ts:91-96 — ruleIds merged across program plans.
            const rules = r.merged[0]?.satisfiesRules ?? [];
            expect(rules).toContain("cs_ba_math_calculus");
            expect(rules).toContain("core_fsi_quant");
        });

        it("audit.warnings has no 'exceeds_pair_limit' (≤ 2 shared per CAS bulletin)", () => {
            const r = planMultiProgram(
                PROFILE_5,
                PROGRAMS_MAP,
                COURSES,
                PREREQS,
                { ...DEFAULT_PLANNER_CONFIG, targetSemester: "2025-spring" },
                casCfg,
            );
            // CAS bulletin §A3.4 max-2 sharing rule; profile has only 1 currently
            // shared candidate.
            const exceeds = r.audit.warnings.filter((w) => w.kind === "exceeds_pair_limit");
            expect(exceeds).toHaveLength(0);
        });

        it("notes mention shared / declared programs", () => {
            const r = planMultiProgram(
                PROFILE_5,
                PROGRAMS_MAP,
                COURSES,
                PREREQS,
                { ...DEFAULT_PLANNER_CONFIG, targetSemester: "2025-spring" },
                casCfg,
            );
            // crossProgramPlanner.ts:140 — always pushes a "shared across declared programs" note.
            const blob = r.notes.join(" | ").toLowerCase();
            expect(blob).toContain("shared");
        });
    });

    // ---------- Profile 6: Real transcript → confirmation summary ----------
    describe("Profile 6 — Transcript confirmation flow on the real transcript", () => {
        it("parseTranscript returns 4 terms", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            // Fall 2023, Spring 2024, Fall 2024, Spring 2025.
            expect(doc.terms).toHaveLength(4);
        });

        it("parseTranscript.overall.printedGpa === 3.500", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            // PDF cumulative GPA = 3.500.
            expect(doc.overall.printedGpa).toBeCloseTo(3.5, 2);
        });

        it("transcriptToProfileDraft.draft.homeSchool === 'cas'", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            // Spring 2025 dominant suffix is -UA (4 of 4 graded-or-IP rows).
            // profileMapper.ts:38 SUFFIX_TO_SCHOOL[-UA] = "cas".
            expect(draft.draft.homeSchool).toBe("cas");
        });

        it("buildConfirmationSummary.homeSchool === 'cas'", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // confirmationFlow.ts:92 — propagated from draft.
            expect(summary.homeSchool).toBe("cas");
        });

        it("buildConfirmationSummary.cumulativeGPA === 3.5 (within 0.01)", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // Hand calc: total qpts = 168.000, total qhrs = 48 (P/0-cr row excluded).
            // GPA = 168/48 = 3.500 exactly.
            expect(summary.cumulativeGPA).toBeCloseTo(3.5, 2);
        });

        it("buildConfirmationSummary.attemptedCredits === 48", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // confirmationFlow.ts:73 — sums credits over coursesTaken (excludes TR).
            // 12 letter-graded rows × 4 = 48; IMNY-UT 99 P at 0 cr → 0.
            expect(summary.attemptedCredits).toBe(48);
        });

        it("buildConfirmationSummary.examCreditsApplied === 32", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // confirmationFlow.ts:103 — sum of transferCourses[*].credits.
            // 8 AP exams × 4 cr = 32.
            expect(summary.examCreditsApplied).toBe(32);
        });

        it("buildConfirmationSummary.inProgressCount === 4", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // confirmationFlow.ts:99-100 — currentSemester.courses.length.
            // Spring 2025 has 4 *** rows.
            expect(summary.inProgressCount).toBe(4);
        });

        it("buildConfirmationSummary.declaredProgramsCount === 0 (transcript doesn't say)", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // profileMapper.ts:108-114 — declaredPrograms left empty when no override.
            expect(summary.declaredProgramsCount).toBe(0);
        });

        it("fieldsRequiringExplicitConfirmation includes 'declaredPrograms'", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // profileMapper.ts:113.
            expect(summary.fieldsRequiringExplicitConfirmation).toContain("declaredPrograms");
        });

        it("homeSchoolBasis starts with 'homeSchool:'", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // confirmationFlow.ts:82-83.
            expect(summary.homeSchoolBasis.startsWith("homeSchool:")).toBe(true);
        });

        it("inProgressCourses lists the 4 expected course IDs", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            const ids = summary.inProgressCourses.map((c) => c.courseId).sort();
            expect(ids).toEqual([
                "CORE-UA 500",
                "CSCI-UA 310",
                "MATH-UA 233",
                "MATH-UA 325",
            ]);
        });

        it("inferenceNotes contain a transition note", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const draft = transcriptToProfileDraft(doc);
            const summary = buildConfirmationSummary(draft);
            // profileMapper.ts:127-132 — transition note emitted when schoolTransition set.
            const blob = summary.inferenceNotes.join(" | ").toLowerCase();
            expect(blob).toContain("transition");
        });
    });
});
