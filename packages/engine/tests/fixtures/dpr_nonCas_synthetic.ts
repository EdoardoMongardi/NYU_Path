/**
 * ============================================================================
 * SYNTHETIC non-CAS DPR fixture — NYU SHANGHAI / Computer Science
 * ============================================================================
 *
 * ⚠️  THIS IS SYNTHETIC, FABRICATED TEST DATA — NOT a redaction of any real
 *     student's Degree Progress Report. No real non-CAS DPR exists in the repo
 *     to redact, and `Docs/core_philosophy.md` #2 forbids fabricating
 *     unverifiable "real" data and passing it off as real. So instead we
 *     CONSTRUCT a structurally-valid `DegreeProgressReport` OBJECT that we
 *     fully control, label it loudly as synthetic, and run it through the
 *     engine pipeline.
 *
 * WHY THIS EXISTS — it PINS the requirement-kind classifier's CAS coupling.
 *     `classifyRequirementKind` (packages/engine/src/agent/forwardSchedule/
 *     requirementKind.ts) keys its school-core / general-elective detection on
 *     CAS-specific structural rgId families (RG5004, RG5007, RG5393, RG33308,
 *     RG5002, RG5005, RG31394, RG31395) and the R1142/* major rId family —
 *     all "confirmed present in the CAS fixture"; non-CAS hierarchies are
 *     documented as "unvalidated". This fixture deliberately uses rgId/rId
 *     values that are NOT in any of those CAS families, so the classifier is
 *     forced down its FALLBACK paths. The accompanying e2e test
 *     (tests/e2e/nonCasPlan.test.ts) asserts the whole classify→solve→validate
 *     pipeline does NOT silently crash on the non-CAS hierarchy.
 *
 *     This test DOCUMENTS the seam; it does NOT fix it. The classifier is
 *     still CAS-coupled. Real non-CAS DPR validation remains PENDING a real
 *     non-CAS fixture (which we will not fabricate).
 *
 * PII: none. Every value here is invented. `studentName` is a placeholder.
 *
 * Structural guarantee: `makeNonCasShanghaiDpr()` is validated against
 *     `degreeProgressReportSchema.parse(...)` at the bottom of this file (and
 *     again in the test) so it cannot silently drift from the Zod schema.
 *
 * The classifier's major-group detection keys on the DECLARED-PROGRAM label
 * (from session.student.declaredPrograms) overlapping the group title — that
 * path is NOT CAS-specific, so the major group below ("Computer Science
 * Major") is intentionally resolvable to exercise major-required/elective
 * placement. The school-core ("Shanghai Core Curriculum") and general
 * ("Unrestricted Electives") groups use non-CAS rgIds/titles that DO fall to
 * the classifier's fallback — that is the coupling being pinned.
 * ============================================================================
 */

import type { ToolSession } from "../../src/agent/tool.js";
import {
    degreeProgressReportSchema,
    type DegreeProgressReport,
} from "../../src/dpr/schema.js";
import type { Course, Prerequisite, SchoolConfig } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Synthetic non-CAS rgId / rId namespace.
//
// Deliberately OUTSIDE every CAS family the classifier keys on. We prefix
// requirement-group ids with "SH" (Shanghai) and leaf ids with "SR" so a
// future reader — and the classifier's structural matchers — never confuse
// these with the real CAS RGxxxx / R1142/* identifiers.
// ---------------------------------------------------------------------------

/**
 * Build a SYNTHETIC NYU Shanghai Computer Science DPR object.
 *
 * Shape (small but structurally complete):
 *   - cumulative block (credits / GPA / residency / caps)
 *   - 3 requirement groups, each with leaf requirements:
 *       1. "Computer Science Major"        (matches declared-program label)
 *       2. "Shanghai Core Curriculum"      (non-CAS rgId — fallback)
 *       3. "Unrestricted Electives"        (non-CAS rgId — fallback)
 *   - a little course history (completed + transfer)
 *   - programs[] declaring the Shanghai CS major
 *
 * The unmet leaves point at synthetic Shanghai-coded candidate courses
 * (e.g. "CSCI-SHU 210") that MUST also exist in the synthetic catalog
 * (see `makeNonCasCatalog`) so the solver can place them.
 */
export function makeNonCasShanghaiDpr(
    overrides: Partial<DegreeProgressReport> = {},
): DegreeProgressReport {
    const dpr: DegreeProgressReport = {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            // Marked synthetic so no consumer mistakes this for a real parse.
            sourceFingerprint: "sha256:SYNTHETIC-non-cas-shanghai-fixture",
            sourcePdfPageCount: 0,
            parseDurationMs: 0,
            warnings: ["SYNTHETIC FIXTURE — not parsed from a real DPR PDF"],
        },
        header: {
            studentName: "Synthetic Shanghai Student (fabricated)",
            preparedDate: "01/01/2026",
        },
        programs: [
            {
                programType: "Undergraduate Career",
                label: "SH-NYU Shanghai",
                requirementTerm: "Fall 2024",
                requirementStatus: "not_satisfied",
            },
            {
                programType: "Major",
                label: "Computer Science Major Approved",
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
            // -----------------------------------------------------------------
            // 1. MAJOR group — title overlaps the declared-program label
            //    ("Computer Science"), so the classifier's NON-CAS-safe
            //    declared-program path resolves these leaves. rgId "SH7001" is
            //    deliberately NOT in any CAS family.
            // -----------------------------------------------------------------
            {
                rgId: "SH7001",
                title: "Computer Science Major",
                status: "not_satisfied",
                statusText: "Not Satisfied: Complete the Computer Science major.",
                children: [
                    {
                        rId: "SR7001/10",
                        title: "Computer Science: Required Courses",
                        status: "not_satisfied",
                        statusText:
                            "Not Satisfied: Complete the required CS courses. Take CSCI-SHU 210.",
                        description: "Required: CSCI-SHU 210 Data Structures.",
                        counter: { kind: "courses", required: 1, used: 0, needed: 1 },
                        coursesUsed: [],
                    },
                    {
                        rId: "SR7001/20",
                        title: "Computer Science: Elective Courses",
                        status: "not_satisfied",
                        statusText:
                            "Not Satisfied: Complete one CS elective. Choose from CSCI-SHU 350 or CSCI-SHU 360.",
                        description: "Choose one: CSCI-SHU 350 or CSCI-SHU 360.",
                        counter: { kind: "courses", required: 1, used: 0, needed: 1 },
                        coursesUsed: [],
                    },
                ],
            },
            // -----------------------------------------------------------------
            // 2. SCHOOL-CORE group — non-CAS rgId "SH8001" + a title the CAS
            //    core matchers do NOT recognize ("Shanghai Core Curriculum"
            //    does not start with "CORE " and is not a CAS college-req
            //    label). This subtree therefore falls to the classifier's
            //    FALLBACK — exactly the coupling we pin.
            // -----------------------------------------------------------------
            {
                rgId: "SH8001",
                title: "Shanghai Core Curriculum",
                status: "not_satisfied",
                statusText: "Not Satisfied: Complete the Shanghai core.",
                children: [
                    {
                        rId: "SR8001/10",
                        title: "Global Perspectives on Society",
                        status: "not_satisfied",
                        statusText:
                            "Not Satisfied: Complete one Global Perspectives course. Take CORE-SHU 100.",
                        description: "Required: CORE-SHU 100.",
                        counter: { kind: "courses", required: 1, used: 0, needed: 1 },
                        coursesUsed: [],
                    },
                ],
            },
            // -----------------------------------------------------------------
            // 3. GENERAL/FREE ELECTIVES group — non-CAS rgId "SH9001". Title
            //    "Unrestricted Electives" is NOT the CAS "General Electives"
            //    label, so this also takes the classifier FALLBACK.
            // -----------------------------------------------------------------
            {
                rgId: "SH9001",
                title: "Unrestricted Electives",
                status: "not_satisfied",
                statusText: "Not Satisfied: Complete remaining elective credits.",
                children: [
                    {
                        rId: "SR9001/10",
                        title: "Free Elective",
                        status: "not_satisfied",
                        statusText:
                            "Not Satisfied: Complete one free elective. Take HUMN-SHU 101.",
                        description: "Any course. e.g. HUMN-SHU 101.",
                        counter: { kind: "courses", required: 1, used: 0, needed: 1 },
                        coursesUsed: [],
                    },
                ],
            },
        ],
        courseHistory: [
            {
                term: "2024 Fall",
                subject: "CSCI-SHU",
                catalogNbr: "101",
                courseTitle: "Intro to Computer Science",
                grade: "A",
                units: 4,
                type: "EN",
            },
            {
                term: "2025 Spring",
                subject: "MATH-SHU",
                catalogNbr: "120",
                courseTitle: "Calculus",
                grade: "B+",
                units: 4,
                type: "EN",
            },
            {
                term: "2024 Fall",
                subject: "WRIT-SHU",
                catalogNbr: "101",
                courseTitle: "Writing as Inquiry",
                grade: null,
                units: 4,
                type: "TE",
            },
        ],
        ...overrides,
    };

    // Structural guarantee: fail loudly if this object ever drifts from the
    // Zod schema. parse() returns a fresh validated object.
    return degreeProgressReportSchema.parse(dpr);
}

// ---------------------------------------------------------------------------
// Synthetic Shanghai catalog — the courses the unmet leaves point at MUST
// exist here so the solver can place them. All Shanghai-coded (-SHU), all
// non-CAS. Offered fall+spring so the small horizon can seat them.
// ---------------------------------------------------------------------------

const SYNTHETIC_COURSES: Course[] = [
    {
        id: "CSCI-SHU 210",
        title: "Data Structures",
        credits: 4,
        departments: ["CSCI-SHU"],
        crossListed: [],
        exclusions: [],
        termsOffered: ["fall", "spring"],
        catalogYearsActive: ["2020", "2030"],
    },
    {
        id: "CSCI-SHU 350",
        title: "Computer Networking",
        credits: 4,
        departments: ["CSCI-SHU"],
        crossListed: [],
        exclusions: [],
        termsOffered: ["fall", "spring"],
        catalogYearsActive: ["2020", "2030"],
    },
    {
        id: "CSCI-SHU 360",
        title: "Machine Learning",
        credits: 4,
        departments: ["CSCI-SHU"],
        crossListed: [],
        exclusions: [],
        termsOffered: ["fall", "spring"],
        catalogYearsActive: ["2020", "2030"],
    },
    {
        id: "CORE-SHU 100",
        title: "Global Perspectives on Society",
        credits: 4,
        departments: ["CORE-SHU"],
        crossListed: [],
        exclusions: [],
        termsOffered: ["fall", "spring"],
        catalogYearsActive: ["2020", "2030"],
    },
    {
        id: "HUMN-SHU 101",
        title: "Foundations of Humanities",
        credits: 4,
        departments: ["HUMN-SHU"],
        crossListed: [],
        exclusions: [],
        termsOffered: ["fall", "spring"],
        catalogYearsActive: ["2020", "2030"],
    },
];

const SYNTHETIC_PREREQS: Prerequisite[] = [
    // CSCI-SHU 210 (Data Structures) requires CSCI-SHU 101 (Intro) — already
    // in the synthetic course history, so this prereq is satisfied. Included
    // so the prereq path is exercised, not bypassed.
    {
        course: "CSCI-SHU 210",
        prereqGroups: [{ type: "AND", courses: ["CSCI-SHU 101"] }],
        coreqs: [],
    },
];

const SYNTHETIC_SCHOOL_CONFIG: SchoolConfig = {
    schoolId: "shanghai",
    name: "NYU Shanghai",
    courseSuffix: ["-SHU"],
    // Step 8e — residency minimum-credits moved to the DPR
    // (dpr.cumulative.residencyRequired); ResidencyConfig no longer carries it.
    residency: { suffix: "-SHU" },
    maxCreditsPerSemester: 18,
    f1FullTimeMinCredits: 12,
    creditTargetPerSemester: 16,
    domesticPartTimeFloor: 8,
};

/**
 * Build a synthetic ToolSession wired to the non-CAS Shanghai catalog above.
 *
 * IMPORTANT — `declaredPrograms[].programType` MUST be lowercase `"major"`:
 * the classifier's `buildMajorLabelSet` filters on `programType !== "major"`,
 * and `programId` ("Computer Science") is what overlaps the major-group title
 * so the major leaves resolve via the NON-CAS-safe declared-program path.
 */
export function makeNonCasShanghaiSession(
    overrides: Partial<ToolSession> = {},
): ToolSession {
    return {
        student: {
            id: "synthetic-shanghai-student",
            catalogYear: "2024",
            homeSchool: "shanghai",
            declaredPrograms: [
                { programId: "Computer Science", programType: "major" },
            ],
            coursesTaken: [],
            visaStatus: "f1",
        },
        courses: SYNTHETIC_COURSES,
        prereqs: SYNTHETIC_PREREQS,
        schoolConfig: SYNTHETIC_SCHOOL_CONFIG,
        ...overrides,
    };
}

/** The synthetic catalog, exported for tests that want it standalone. */
export const nonCasShanghaiCatalog = {
    courses: SYNTHETIC_COURSES,
    prereqs: SYNTHETIC_PREREQS,
    schoolConfig: SYNTHETIC_SCHOOL_CONFIG,
};
