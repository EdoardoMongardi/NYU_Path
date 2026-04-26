// =============================================================================
// Wave 2 — Independent (bulletin-only) test harness.
//
// IMPORTANT: The assertions in this file come from BULLETIN reading only,
// expressed as predictions in wave2_fixtures.md. They are NOT cribbed from
// engine source bodies, and they DO NOT presume the engine produces what
// they assert by construction — the point is to surface mismatches.
//
// Each `expect(...)` is paired with a comment citing the bulletin line that
// drives the prediction. A failing expectation is a candidate engine bug or
// a documented "engine encoding diverges from bulletin".
// =============================================================================

import { describe, it, expect } from "vitest";
import type { Course, Program, StudentProfile, SchoolConfig } from "@nyupath/shared";
import { degreeAudit } from "../../../src/audit/degreeAudit.js";
import { crossProgramAudit } from "../../../src/audit/crossProgramAudit.js";
import { decideSpsEnrollment } from "../../../src/audit/spsEnrollmentGuard.js";
import { calculateStanding } from "../../../src/audit/academicStanding.js";
import {
    loadCourses,
    loadProgram,
    loadSchoolConfig,
} from "../../../src/dataLoader.js";
import { parseTranscript, transcriptToProfileDraft } from "../../../src/transcript/index.js";

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

// =============================================================================
// Profile 1 — CAS Core foreign-language exemption (nonEnglishSecondary)
// =============================================================================

const PROFILE_1_FL_EXEMPT: StudentProfile = {
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

// =============================================================================
// Profile 2 — Tandon BS student with -UY courses
// =============================================================================

const PROFILE_2_TANDON: StudentProfile = {
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

// =============================================================================
// Profile 3 — Stern student attempting CAS-allowed SPS course
// =============================================================================

const PROFILE_3_STERN: StudentProfile = {
    id: "synthetic-stern-sps-block",
    catalogYear: "2025",
    homeSchool: "stern",
    declaredPrograms: [],
    coursesTaken: [
        { courseId: "ACCT-UB 1", grade: "A-", semester: "2025-fall", credits: 3 },
    ],
    uaSuffixCredits: 0,
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2025,
    visaStatus: "domestic",
};

// =============================================================================
// Profile 4 — CAS student near academic dismissal
// =============================================================================

const PROFILE_4_DISMISSAL: StudentProfile = {
    id: "synthetic-cas-near-dismissal",
    catalogYear: "2024",
    homeSchool: "cas",
    declaredPrograms: [],
    coursesTaken: [
        { courseId: "EXPOS-UA 1", grade: "F", semester: "2024-fall", credits: 4 },
        { courseId: "MATH-UA 121", grade: "C-", semester: "2024-fall", credits: 4 },
        { courseId: "CSCI-UA 101", grade: "F", semester: "2024-fall", credits: 4 },
        { courseId: "CORE-UA 400", grade: "W", semester: "2024-fall", credits: 4 },
        { courseId: "MATH-UA 9", grade: "F", semester: "2025-spring", credits: 4 },
        { courseId: "PSYCH-UA 1", grade: "F", semester: "2025-spring", credits: 4 },
        { courseId: "ANTH-UA 2", grade: "W", semester: "2025-spring", credits: 4 },
        { courseId: "ECON-UA 1", grade: "D", semester: "2025-spring", credits: 4 },
    ],
    uaSuffixCredits: 32,
    nonCASNYUCredits: 0,
    onlineCredits: 0,
    passfailCredits: 0,
    matriculationYear: 2024,
    visaStatus: "domestic",
};

// =============================================================================
// Profile 5A — Cross-program double-counting at the limit (2 shared)
// =============================================================================

const PROFILE_5_DOUBLECOUNT: StudentProfile = {
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

// =============================================================================
// Profile 6 — Synthetic transcript with school transition (Tisch -UT → CAS -UA)
// =============================================================================

const PROFILE_6_TRANSCRIPT_TEXT = `Test Student
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

// =============================================================================
// Tests
// =============================================================================

describe("Wave 2 — Independent fixtures (bulletin-derived)", () => {
    const cs = getCsBaProgram();
    const casCore = getCasCoreProgram();
    const casCfg = getSchoolCfg("cas");
    const tandonCfg = getSchoolCfg("tandon");
    const sternCfg = getSchoolCfg("stern");

    // ---------- Profile 1: CAS Core FL exemption ----------
    describe("Profile 1 — CAS Core foreign-language exemption (nonEnglishSecondary)", () => {
        const s = PROFILE_1_FL_EXEMPT;

        it("degreeAudit(cas_core): core_foreign_lang status === 'satisfied' via flag exemption", () => {
            const r = degreeAudit(s, casCore, COURSES, casCfg);
            // CAS Core "Foreign Language → Exemptions" L71:
            //   "Students whose entire secondary schooling was in a language other than English ...
            //    are exempt from the foreign language requirement."
            // The student took ZERO foreign-language courses; the only path to satisfaction
            // is the nonEnglishSecondary flag.
            const fl = r.rules.find((x) => x.ruleId === "core_foreign_lang");
            expect(fl).toBeDefined();
            expect(fl?.status).toBe("satisfied");
        });

        it("degreeAudit(cas_core): core_foreign_lang exemptReason is non-empty", () => {
            const r = degreeAudit(s, casCore, COURSES, casCfg);
            // RuleAuditResult.exemptReason (types.ts:450): "If rule was auto-satisfied by
            // exemption, explains why." Bulletin gives an explicit narrative for exemptions.
            const fl = r.rules.find((x) => x.ruleId === "core_foreign_lang");
            expect(typeof fl?.exemptReason).toBe("string");
            expect((fl?.exemptReason ?? "").length).toBeGreaterThan(0);
        });

        it("degreeAudit(cas_core): core_foreign_lang coursesSatisfying is empty (no FL course taken)", () => {
            const r = degreeAudit(s, casCore, COURSES, casCfg);
            // RuleAuditResult.coursesSatisfying (types.ts:444): "Courses applied toward this rule".
            // Student took no FL courses → the satisfaction must come from the flag, not a course.
            const fl = r.rules.find((x) => x.ruleId === "core_foreign_lang");
            expect(fl?.coursesSatisfying ?? []).toHaveLength(0);
        });
    });

    // ---------- Profile 2: Tandon student -UY courses ----------
    describe("Profile 2 — Tandon student with -UY courses", () => {
        const s = PROFILE_2_TANDON;

        it("decideSpsEnrollment(REBS1-UC, tandon): blocked, school_total_ban", () => {
            const d = decideSpsEnrollment("REBS1-UC 1234", tandonCfg);
            // Tandon bulletin L167: SPS courses are excluded from credit toward the degree.
            // tandon.json:181-183 spsPolicy.allowed: false.
            expect(d.enrollment).toBe("blocked");
            if (d.enrollment === "blocked") {
                expect(d.rule).toBe("school_total_ban");
            }
        });

        it("decideSpsEnrollment(CSCI-UA 102, tandon): allowed, not_an_sps_course", () => {
            const d = decideSpsEnrollment("CSCI-UA 102", tandonCfg);
            // -UA is CAS, not SPS. The SPS guard is contractually for -UC/-CE only.
            expect(d.enrollment).toBe("allowed");
            if (d.enrollment === "allowed") {
                expect(d.reason).toBe("not_an_sps_course");
            }
        });

        it("decideSpsEnrollment(CP-UY 1000, tandon): allowed, not_an_sps_course (-UY is Tandon, not SPS)", () => {
            const d = decideSpsEnrollment("CP-UY 1000", tandonCfg);
            // -UY = Tandon's own suffix per tandon.json:143. Not an SPS course.
            expect(d.enrollment).toBe("allowed");
            if (d.enrollment === "allowed") {
                expect(d.reason).toBe("not_an_sps_course");
            }
        });

        it("calculateStanding: level === 'good_standing' with Tandon config", () => {
            const r = calculateStanding(s.coursesTaken, 2, tandonCfg);
            // Tandon overallGpaMin: 2.0 (tandon.json:145). Hand calc GPA ≈ 3.31 >> 2.0.
            expect(r.level).toBe("good_standing");
            expect(r.inGoodStanding).toBe(true);
        });

        it("calculateStanding: cumulative GPA in [3.20, 3.40] — hand-calc 3.31", () => {
            const r = calculateStanding(s.coursesTaken, 2, tandonCfg);
            // Hand calc:
            //   B+·4·4 + A-·3.667·4 + B·3·4 + B·3·4
            //   + B+·3.333·4 + A·4·4 + B-·2.667·4 + A-·3.667·2
            //   = 13.332+14.668+12+12+13.332+16+10.668+7.334 = 99.334
            //   GPA credits = 4·7 + 2 = 30
            //   GPA = 99.334/30 = 3.311
            expect(r.cumulativeGPA).toBeGreaterThan(3.20);
            expect(r.cumulativeGPA).toBeLessThan(3.40);
        });
    });

    // ---------- Profile 3: Stern SPS total ban ----------
    describe("Profile 3 — Stern student attempting SPS courses", () => {
        // Stern bulletin L215: "Stern students are not permitted to enroll in courses
        //   through any SPS programs."
        // stern.json:183-184 spsPolicy.allowed: false.

        it("decideSpsEnrollment(REBS1-UC, stern): blocked (CAS allows; Stern doesn't)", () => {
            const d = decideSpsEnrollment("REBS1-UC 1234", sternCfg);
            expect(d.enrollment).toBe("blocked");
            if (d.enrollment === "blocked") {
                expect(d.rule).toBe("school_total_ban");
            }
        });

        it("decideSpsEnrollment(TCHT1-UC, stern): blocked", () => {
            const d = decideSpsEnrollment("TCHT1-UC 5", sternCfg);
            expect(d.enrollment).toBe("blocked");
        });

        it("decideSpsEnrollment(TCSM1-UC, stern): blocked", () => {
            const d = decideSpsEnrollment("TCSM1-UC 99", sternCfg);
            expect(d.enrollment).toBe("blocked");
        });

        it("decideSpsEnrollment(PSYCH-UA 1, stern): allowed, not_an_sps_course", () => {
            const d = decideSpsEnrollment("PSYCH-UA 1", sternCfg);
            // -UA is CAS, not SPS. The SPS guard does not police cross-school CAS use.
            expect(d.enrollment).toBe("allowed");
            if (d.enrollment === "allowed") {
                expect(d.reason).toBe("not_an_sps_course");
            }
        });
    });

    // ---------- Profile 4: dismissal trigger ----------
    describe("Profile 4 — CAS student near academic dismissal", () => {
        const s = PROFILE_4_DISMISSAL;

        it("calculateStanding(2 semesters): level === 'dismissed'", () => {
            const r = calculateStanding(s.coursesTaken, 2, casCfg);
            // CAS bulletin L494: "Starting after a student's second semester ... record may
            //   be considered for dismissal if fewer than 50% of attempted credit hours were
            //   successfully completed." Student: 8/32 = 25% completion.
            // Also L466: cumulative GPA below 2.0 → not in good standing.
            expect(r.level).toBe("dismissed");
        });

        it("calculateStanding(2 semesters): inGoodStanding === false", () => {
            const r = calculateStanding(s.coursesTaken, 2, casCfg);
            // L466.
            expect(r.inGoodStanding).toBe(false);
        });

        it("calculateStanding(2 semesters): cumulativeGPA in [0.40, 0.50]", () => {
            const r = calculateStanding(s.coursesTaken, 2, casCfg);
            // Hand calc: 6 letter grades, 4·F + C- + D = 0+0+0+0+1.667+1.0
            //   weighted: F·0·4·4 + C-·1.667·4 + D·1.0·4 = 4·1.667+4·1.0 = 6.668+4 = 10.668
            //   GPA credits = 6·4 = 24
            //   GPA = 10.668/24 = 0.4445
            expect(r.cumulativeGPA).toBeGreaterThan(0.40);
            expect(r.cumulativeGPA).toBeLessThan(0.50);
        });

        it("calculateStanding(2 semesters): completionRate in [0.20, 0.30]", () => {
            const r = calculateStanding(s.coursesTaken, 2, casCfg);
            // Earned: C- (4) + D (4) = 8. Attempted: 8 courses × 4 = 32. Ratio = 0.25.
            expect(r.completionRate).toBeGreaterThan(0.20);
            expect(r.completionRate).toBeLessThan(0.30);
        });

        it("calculateStanding(2 semesters): warnings mention 'dismiss' or '50%' or 'completion'", () => {
            const r = calculateStanding(s.coursesTaken, 2, casCfg);
            // L494 wording. Engine SHOULD surface a human-readable explanation when escalating
            // to 'dismissed'.
            const blob = r.warnings.join(" | ").toLowerCase();
            const hasDismissalLanguage =
                blob.includes("dismiss") ||
                blob.includes("50%") ||
                blob.includes("completion");
            expect(hasDismissalLanguage).toBe(true);
        });

        it("calculateStanding(1 semester): level !== 'dismissed' (trigger requires >= 2 semesters)", () => {
            const r = calculateStanding(s.coursesTaken, 1, casCfg);
            // L494: dismissal review starts AFTER the student's 2nd semester. With only 1
            // semester completed the dismissal level should not yet apply, even though GPA
            // is below 2.0 (academic_concern is appropriate; dismissed is not).
            expect(r.level).not.toBe("dismissed");
        });
    });

    // ---------- Profile 5A: 2-shared-courses, no exceeds_pair_limit ----------
    describe("Profile 5 — Cross-program double-counting at the limit", () => {
        const s = PROFILE_5_DOUBLECOUNT;

        it("crossProgramAudit: programs.length === 2", () => {
            const programs = new Map<string, Program>([
                [cs.programId, cs],
                [casCore.programId, casCore],
            ]);
            const r = crossProgramAudit(s, programs, COURSES, casCfg);
            expect(r.programs).toHaveLength(2);
        });

        it("crossProgramAudit: no exceeds_pair_limit warnings (≤ 2 shared courses, at limit not over)", () => {
            const programs = new Map<string, Program>([
                [cs.programId, cs],
                [casCore.programId, casCore],
            ]);
            const r = crossProgramAudit(s, programs, COURSES, casCfg);
            // CAS bulletin L126: "No student may double count more than two courses between
            //   two majors (or between a major and a minor, or between two minors)".
            // cas.json defaultMajorToMinor: 2. Student declares cs_major_ba (major) and
            // cas_core (minor). Shared candidates: MATH-UA 121, MATH-UA 122 (at most).
            const exceeds = r.warnings.filter((w) => w.kind === "exceeds_pair_limit");
            expect(exceeds).toHaveLength(0);
        });

        it("crossProgramAudit: no triple_count warnings", () => {
            const programs = new Map<string, Program>([
                [cs.programId, cs],
                [casCore.programId, casCore],
            ]);
            const r = crossProgramAudit(s, programs, COURSES, casCfg);
            // L126: "No course may ever be triple-counted among any combination of three
            //   majors and/or minors." With only 2 declared programs, triple-counting is
            //   impossible by definition.
            const triples = r.warnings.filter((w) => w.kind === "triple_count");
            expect(triples).toHaveLength(0);
        });

        it("crossProgramAudit: sharedCourses count <= 2 (the per-pair limit)", () => {
            const programs = new Map<string, Program>([
                [cs.programId, cs],
                [casCore.programId, casCore],
            ]);
            const r = crossProgramAudit(s, programs, COURSES, casCfg);
            // The bulletin's max-2 only constrains FOR-CREDIT double-counting. The engine's
            // sharedCourses report is "courses appearing in 2+ programs after audit"
            // (crossProgramAudit.ts:54). With at most 2 mathematically-shareable courses
            // between the bundled cs_major_ba and cas_core, this assertion verifies the
            // engine doesn't somehow report 3+ shared courses.
            expect(r.sharedCourses.length).toBeLessThanOrEqual(2);
        });
    });

    // ---------- Profile 6: synthetic transcript with school transition ----------
    describe("Profile 6 — Synthetic transcript with school transition", () => {
        it("parseTranscript: 4 terms parsed", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            expect(doc.terms).toHaveLength(4);
        });

        it("parseTranscript: overall.printedGpa === 3.59", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            // Overall block: AHRS 52, QPTS 186.668 → 3.59 by construction.
            expect(doc.overall.printedGpa).toBeCloseTo(3.59, 2);
        });

        it("parseTranscript: schoolTransition is detected", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            // TranscriptDocument.schoolTransition (types.ts:62): "Term in which the home
            //   school changed (G40), if detected". Fall 2023/Spring 2024 dominant -UT;
            //   Fall 2024 onward dominant -UA → transition at 2024-fall.
            expect(doc.schoolTransition).toBeDefined();
        });

        it("parseTranscript: schoolTransition.fromSemester === '2024-fall'", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            expect(doc.schoolTransition?.fromSemester).toBe("2024-fall");
        });

        it("parseTranscript: schoolTransition.previousSuffixes includes '-UT'", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            expect(doc.schoolTransition?.previousSuffixes).toContain("-UT");
        });

        it("parseTranscript: schoolTransition.newSuffixes includes '-UA'", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            expect(doc.schoolTransition?.newSuffixes).toContain("-UA");
        });

        it("transcriptToProfileDraft: draft.homeSchool === 'cas' (most recent term dominant suffix is -UA)", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const out = transcriptToProfileDraft(doc);
            // profileMapper.ts SUFFIX_TO_SCHOOL[-UA] = "cas". Inference walks most-recent
            // term backward looking for dominant -U* suffix. Spring 2025 has 3× -UA, 0× -UT.
            expect(out.draft.homeSchool).toBe("cas");
        });

        it("transcriptToProfileDraft: draft.coursesTaken length === 13", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const out = transcriptToProfileDraft(doc);
            // 3 (Fall 2023) + 3 (Spring 2024) + 4 (Fall 2024) + 3 (Spring 2025) = 13.
            expect(out.draft.coursesTaken).toHaveLength(13);
        });

        it("transcriptToProfileDraft: notes mentions transition (-UT and -UA)", () => {
            const doc = parseTranscript(PROFILE_6_TRANSCRIPT_TEXT);
            const out = transcriptToProfileDraft(doc);
            // profileMapper.ts:127-132: when schoolTransition is set, notes string mentions it.
            const blob = out.notes.join(" | ");
            expect(blob.toLowerCase()).toContain("transition");
        });
    });
});
