// Diagnostic dump for wave2 — always passes; prints engine output to stderr
// for inspection against wave2_fixtures.md predictions.
import { describe, it } from "vitest";
import type { Course, Program, StudentProfile, SchoolConfig } from "@nyupath/shared";
import { degreeAudit } from "../../../src/audit/degreeAudit.js";
import { crossProgramAudit } from "../../../src/audit/crossProgramAudit.js";
import { decideSpsEnrollment } from "../../../src/audit/spsEnrollmentGuard.js";
import { calculateStanding } from "../../../src/audit/academicStanding.js";
import { loadCourses, loadProgram, loadSchoolConfig } from "../../../src/dataLoader.js";
import { parseTranscript, transcriptToProfileDraft } from "../../../src/transcript/index.js";

const COURSES: Course[] = loadCourses();
const cs = loadProgram("cs_major_ba", "2023") as Program;
const casCore = loadProgram("cas_core", "2023") as Program;
const casCfg = loadSchoolConfig("cas") as SchoolConfig;
const tandonCfg = loadSchoolConfig("tandon") as SchoolConfig;
const sternCfg = loadSchoolConfig("stern") as SchoolConfig;

function dump(label: string, value: unknown): void {
    console.error(`\n[wave2-dump] ${label}: ${JSON.stringify(value, null, 2)}`);
}

describe("wave2 diagnostic dump", () => {
    it("Profile 1: FL exemption", () => {
        const s: StudentProfile = {
            id: "synthetic-cas-fl-exempt-nonenglish",
            catalogYear: "2023",
            homeSchool: "cas",
            declaredPrograms: [
                { programId: "cas_core", programType: "major", declaredAt: "2023-fall", declaredUnderCatalogYear: "2023" },
            ],
            coursesTaken: [
                { courseId: "EXPOS-UA 1", grade: "B+", semester: "2023-fall", credits: 4 },
                { courseId: "FYSEM-UA 50", grade: "A", semester: "2023-fall", credits: 4 },
                { courseId: "CORE-UA 400", grade: "A-", semester: "2023-fall", credits: 4 },
                { courseId: "CORE-UA 500", grade: "A-", semester: "2024-spring", credits: 4 },
                { courseId: "CORE-UA 760", grade: "B+", semester: "2024-spring", credits: 4 },
                { courseId: "CORE-UA 200", grade: "A", semester: "2024-spring", credits: 4 },
                { courseId: "CORE-UA 100", grade: "A-", semester: "2024-fall", credits: 4 },
                { courseId: "CORE-UA 201", grade: "A", semester: "2024-fall", credits: 4 },
            ],
            flags: ["nonEnglishSecondary"],
            uaSuffixCredits: 32,
            nonCASNYUCredits: 0,
            onlineCredits: 0,
            passfailCredits: 0,
            matriculationYear: 2023,
            visaStatus: "domestic",
        };
        const r = degreeAudit(s, casCore, COURSES, casCfg);
        const fl = r.rules.find((x) => x.ruleId === "core_foreign_lang");
        dump("Profile 1 FL rule", fl);
        dump("Profile 1 overallStatus", r.overallStatus);
        dump("Profile 1 warnings", r.warnings);
    });

    it("Profile 2: Tandon -UY student", () => {
        const s: StudentProfile = {
            id: "synthetic-tandon-uy-student",
            catalogYear: "2023",
            homeSchool: "tandon",
            declaredPrograms: [],
            coursesTaken: [
                { courseId: "MA-UY 1024", grade: "B+", semester: "2023-fall", credits: 4 },
                { courseId: "CS-UY 1114", grade: "A-", semester: "2023-fall", credits: 4 },
                { courseId: "EXPOS-UA 1", grade: "B", semester: "2023-fall", credits: 4 },
                { courseId: "PH-UY 1013", grade: "B", semester: "2023-fall", credits: 4 },
                { courseId: "MA-UY 1124", grade: "B+", semester: "2024-spring", credits: 4 },
                { courseId: "CS-UY 1134", grade: "A", semester: "2024-spring", credits: 4 },
                { courseId: "PH-UY 2023", grade: "B-", semester: "2024-spring", credits: 4 },
                { courseId: "EG-UY 1004", grade: "A-", semester: "2024-spring", credits: 2 },
            ],
            uaSuffixCredits: 4,
            nonCASNYUCredits: 0,
            onlineCredits: 0,
            passfailCredits: 0,
            matriculationYear: 2023,
            visaStatus: "domestic",
        };
        dump("Profile 2 SPS REBS1-UC", decideSpsEnrollment("REBS1-UC 1234", tandonCfg));
        dump("Profile 2 SPS CSCI-UA 102", decideSpsEnrollment("CSCI-UA 102", tandonCfg));
        dump("Profile 2 SPS CP-UY 1000", decideSpsEnrollment("CP-UY 1000", tandonCfg));
        dump("Profile 2 standing", calculateStanding(s.coursesTaken, 2, tandonCfg));
        try {
            const r = degreeAudit(s, cs, COURSES, tandonCfg);
            dump("Profile 2 degreeAudit(cs_major_ba) overallStatus", r.overallStatus);
        } catch (e) {
            dump("Profile 2 degreeAudit threw", String(e));
        }
    });

    it("Profile 3: Stern SPS ban", () => {
        dump("Profile 3 REBS1-UC 1234 stern", decideSpsEnrollment("REBS1-UC 1234", sternCfg));
        dump("Profile 3 TCHT1-UC 5 stern", decideSpsEnrollment("TCHT1-UC 5", sternCfg));
        dump("Profile 3 TCSM1-UC 99 stern", decideSpsEnrollment("TCSM1-UC 99", sternCfg));
        dump("Profile 3 PSYCH-UA 1 stern", decideSpsEnrollment("PSYCH-UA 1", sternCfg));
    });

    it("Profile 4: dismissal", () => {
        const courses: StudentProfile["coursesTaken"] = [
            { courseId: "EXPOS-UA 1", grade: "F", semester: "2024-fall", credits: 4 },
            { courseId: "MATH-UA 121", grade: "C-", semester: "2024-fall", credits: 4 },
            { courseId: "CSCI-UA 101", grade: "F", semester: "2024-fall", credits: 4 },
            { courseId: "CORE-UA 400", grade: "W", semester: "2024-fall", credits: 4 },
            { courseId: "MATH-UA 9", grade: "F", semester: "2025-spring", credits: 4 },
            { courseId: "PSYCH-UA 1", grade: "F", semester: "2025-spring", credits: 4 },
            { courseId: "ANTH-UA 2", grade: "W", semester: "2025-spring", credits: 4 },
            { courseId: "ECON-UA 1", grade: "D", semester: "2025-spring", credits: 4 },
        ];
        dump("Profile 4 standing(2 sem)", calculateStanding(courses, 2, casCfg));
        dump("Profile 4 standing(1 sem)", calculateStanding(courses, 1, casCfg));
    });

    it("Profile 5: doublecount", () => {
        const s: StudentProfile = {
            id: "synthetic-cas-doublecount-2-shared",
            catalogYear: "2023",
            homeSchool: "cas",
            declaredPrograms: [
                { programId: "cs_major_ba", programType: "major", declaredAt: "2023-fall", declaredUnderCatalogYear: "2023" },
                { programId: "cas_core", programType: "minor", declaredAt: "2023-fall", declaredUnderCatalogYear: "2023" },
            ],
            coursesTaken: [
                { courseId: "CSCI-UA 101", grade: "A", semester: "2023-fall", credits: 4 },
                { courseId: "MATH-UA 121", grade: "B+", semester: "2023-fall", credits: 4 },
                { courseId: "EXPOS-UA 1", grade: "B+", semester: "2023-fall", credits: 4 },
                { courseId: "FYSEM-UA 50", grade: "A", semester: "2023-fall", credits: 4 },
                { courseId: "CSCI-UA 102", grade: "A-", semester: "2024-spring", credits: 4 },
                { courseId: "MATH-UA 120", grade: "A-", semester: "2024-spring", credits: 4 },
                { courseId: "MATH-UA 122", grade: "B+", semester: "2024-spring", credits: 4 },
                { courseId: "CORE-UA 400", grade: "A-", semester: "2024-spring", credits: 4 },
                { courseId: "CSCI-UA 201", grade: "B+", semester: "2024-fall", credits: 4 },
                { courseId: "CSCI-UA 202", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "CORE-UA 500", grade: "A", semester: "2024-fall", credits: 4 },
                { courseId: "CORE-UA 760", grade: "B+", semester: "2024-fall", credits: 4 },
                { courseId: "CORE-UA 200", grade: "A", semester: "2025-spring", credits: 4 },
                { courseId: "CSCI-UA 472", grade: "A-", semester: "2025-spring", credits: 4 },
            ],
            flags: ["nonEnglishSecondary"],
            uaSuffixCredits: 56,
            nonCASNYUCredits: 0,
            onlineCredits: 0,
            passfailCredits: 0,
            matriculationYear: 2023,
            visaStatus: "domestic",
        };
        const programs = new Map<string, Program>([
            [cs.programId, cs],
            [casCore.programId, casCore],
        ]);
        const r = crossProgramAudit(s, programs, COURSES, casCfg);
        dump("Profile 5 sharedCourses", r.sharedCourses);
        dump("Profile 5 warnings", r.warnings);
        for (const e of r.programs) {
            dump(
                `Profile 5 audit ${e.declaration.programId} (${e.declaration.programType})`,
                {
                    overall: e.audit.overallStatus,
                    rules: e.audit.rules.map((rl) => ({
                        ruleId: rl.ruleId,
                        status: rl.status,
                        coursesSatisfying: rl.coursesSatisfying,
                        exemptReason: rl.exemptReason,
                    })),
                },
            );
        }
    });

    it("Profile 6: transcript", () => {
        const text = `Test Student
Bachelor of Arts / Major: Computer Science

Fall 2023
IMNY-UT 101  Creative Computing  A  4.0  4.0  16.0
IMNY-UT 102  Communications Lab  A  4.0  4.0  16.0
EXPOS-UA 1   Writing the Essay   B  4.0  4.0  12.0
Term Totals: AHRS 12.0 EHRS 12.0 QHRS 12.0 QPTS 44.0 GPA 3.667

Spring 2024
IMNY-UT 201  Interactive Lab     A-  4.0  4.0  14.668
IMNY-UT 202  Visual Computing    B+  4.0  4.0  13.332
ASPP-UT 2    Art Writing         B   4.0  4.0  12.0
Term Totals: AHRS 12.0 EHRS 12.0 QHRS 12.0 QPTS 40.0 GPA 3.333

Fall 2024
CSCI-UA 101  Intro CS            A   4.0  4.0  16.0
MATH-UA 121  Calculus I          A-  4.0  4.0  14.668
CORE-UA 400  Texts and Ideas     B+  4.0  4.0  13.332
EXPOS-UA 1   Writing the Essay   A   4.0  4.0  16.0
Term Totals: AHRS 16.0 EHRS 16.0 QHRS 16.0 QPTS 60.0 GPA 3.75

Spring 2025
CSCI-UA 102  Data Structures     A   4.0  4.0  16.0
MATH-UA 120  Discrete Math       A-  4.0  4.0  14.668
CORE-UA 500  Cultures Contexts   B   4.0  4.0  12.0
Term Totals: AHRS 12.0 EHRS 12.0 QHRS 12.0 QPTS 42.668 GPA 3.556

AHRS 52.0
EHRS 52.0
QHRS 52.0
QPTS 186.668
GPA 3.59
`;
        const doc = parseTranscript(text);
        dump("Profile 6 schoolTransition", doc.schoolTransition);
        dump("Profile 6 suffixHistory", doc.suffixHistory);
        dump("Profile 6 overall", doc.overall);
        dump("Profile 6 terms count", doc.terms.length);
        const out = transcriptToProfileDraft(doc);
        dump("Profile 6 draft.homeSchool", out.draft.homeSchool);
        dump("Profile 6 notes", out.notes);
        dump("Profile 6 needsConfirmation", out.needsConfirmation);
    });
});
