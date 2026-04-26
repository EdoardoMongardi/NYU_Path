// Diagnostic dump for wave 3 — prints engine output for each profile so we can
// compare with the bulletin-predicted table in wave3_fixtures.md. This file is
// noisy on stdout; it always passes.

import { describe, it } from "vitest";
import type { Course, Program, StudentProfile, PlannerConfig, Prerequisite } from "@nyupath/shared";
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

const cs = loadProgram("cs_major_ba", "2023")!;
const casCore = loadProgram("cas_core", "2023")!;
const COURSES: Course[] = loadCourses();
const PREREQS: Prerequisite[] = loadPrereqs();
const ALL_PROGRAMS = loadPrograms();
const PROGRAMS_MAP = new Map<string, Program>(ALL_PROGRAMS.map((p) => [p.programId, p]));
const casCfg = loadSchoolConfig("cas")!;

const DEFAULT_CFG: PlannerConfig = {
    targetSemester: "2025-fall",
    maxCourses: 5,
    maxCredits: 18,
};

function dump(label: string, data: unknown): void {
    // eslint-disable-next-line no-console
    console.log(`\n===== ${label} =====`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(data, null, 2));
}

describe("wave 3 dumps", () => {
    it("Profile 2 — projection on 'all major rules met' student", () => {
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
        const r = projectMultiSemester({
            student: PROFILE_2,
            program: cs,
            courses: COURSES,
            prereqs: PREREQS,
            startSemester: "2026-fall",
            semesterCount: 5,
            schoolConfig: casCfg,
        });
        dump("Profile 2 result.semesters[*]", r.semesters.map((s) => ({
            semester: s.semester,
            cumulativeCreditsAtEnd: s.cumulativeCreditsAtEnd,
            onTrackForGraduation: s.onTrackForGraduation,
            suggestionsCount: s.plan.suggestions.length,
            suggestionTopFew: s.plan.suggestions.slice(0, 3).map((x) => ({ id: x.courseId, reason: x.reason })),
        })));
        dump("Profile 2 notes", r.notes);
        dump("Profile 2 projectedGraduationSemester", r.projectedGraduationSemester);
    });

    it("Profile 6 — confirmation summary + draft.coursesTaken from real transcript", () => {
        const text = `Edoardo Mongardi
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
        const doc = parseTranscript(text);
        const draft = transcriptToProfileDraft(doc);
        dump("Profile 6 draft.coursesTaken", draft.draft.coursesTaken);
        dump("Profile 6 draft.notes", draft.notes);
        const summary = buildConfirmationSummary(draft);
        dump("Profile 6 summary", summary);
    });
});
