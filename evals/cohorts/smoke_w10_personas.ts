// ============================================================
// Phase 7-E W10.8 — 5-persona smoke-test fixtures
// ============================================================
// Five distinct "students" we walk through the full v2 pipeline
// (DPR upload → agent loop → multi-turn dialog) once each, to
// surface bugs that single-turn cohort-A grading missed:
//   - SSE delivery glitches across long turns
//   - Tool routing under multi-intent prompts
//   - Refusal cascade for off-domain asks
//   - Disclaimer presence on Tier-3 (what-if) flows
//   - Session-summary roll-up at end of session
//
// W10.8's purpose is *bug-finding*, not grading. We capture
// every operational event (validator_block, max_turns,
// model_error_no_fallback, etc.) and classify into P0/P1/P2.
//
// The 5 personas span the spread of cohort A's expected mix:
//   1. Real DPR (anchor — verified parse, real numbers)
//   2. CAS sophomore early-stage CS major
//   3. CAS senior almost-done Econ (graduation-check)
//   4. Stern junior (different home school)
//   5. International CAS junior with F-1 (policy-heavy questions)
// ============================================================

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StudentProfile } from "@nyupath/shared";
import { parseDpr } from "../../packages/engine/src/index.js";
import type { ConversationCase } from "../cohort/runner.js";
import {
    mkDpr,
    mkGroup,
    mkRequirement,
    mkCourse,
} from "../../packages/engine/tests/helpers/mkDpr.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_DPR_PATH = join(
    __dirname,
    "..",
    "..",
    "packages/engine/tests/fixtures/dpr_sample.redacted.txt",
);

// ---- Persona 1: real DPR (anchor) ------------------------------

const realDprText = readFileSync(REAL_DPR_PATH, "utf-8");
const realDprParse = parseDpr(realDprText, { pageCount: 9, nowIso: "2026-04-27T00:00:00Z" });
if (!realDprParse.ok) throw new Error(`smoke_w10_personas: real-DPR parse failed: ${realDprParse.error}`);
const REAL_DPR = realDprParse.report;

const persona1: ConversationCase = {
    id: "smoke-p1-real-dpr",
    description: "Anchor: real CAS CS/Math joint major, 138 credits, GPA 3.402, 1 missing CS course",
    student: {
        id: "smoke-p1",
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "computer_science_math", programType: "major" }],
        coursesTaken: [],
        visaStatus: "domestic",
    } satisfies StudentProfile,
    degreeProgressReport: REAL_DPR,
    turns: [
        { userMessage: "What's my cumulative GPA?" },
        { userMessage: "What requirements do I still need to graduate?" },
        { userMessage: "Plan my fall semester so I can finish my CS major." },
        { userMessage: "What if I added a Math minor — would it delay graduation?" },
    ],
};

// ---- Persona 2: CAS sophomore CS, early stage ------------------

const persona2Dpr = mkDpr({
    header: { studentName: "Persona Two", preparedDate: "04/27/2026" },
    programs: [
        { programType: "Undergraduate Career", label: "Undergraduate Career", requirementTerm: "Fall 2024", requirementStatus: "satisfied" },
        { programType: "Major Approved", label: "Computer Science", requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" },
    ],
    cumulative: {
        creditsUsed: 48,
        cumulativeGpa: 3.21,
        residencyUsed: 48,
        passFailUsedUnits: 4,
        outsideHomeUsedUnits: 0,
    },
    requirementGroups: [
        mkGroup({
            rgId: "RG_CORE",
            title: "CAS Core",
            status: "not_satisfied",
            children: [
                mkRequirement({
                    rId: "R_CORE_TEXTS",
                    title: "Texts and Ideas",
                    status: "not_satisfied",
                    statusText: "Not Satisfied: Complete one CORE-UA 400-499.",
                    counter: { kind: "courses", required: 1, used: 0, needed: 1 },
                }),
                mkRequirement({
                    rId: "R_CORE_CULT",
                    title: "Cultures and Contexts",
                    status: "not_satisfied",
                    statusText: "Not Satisfied: Complete one CORE-UA 500-599.",
                    counter: { kind: "courses", required: 1, used: 0, needed: 1 },
                }),
            ],
        }),
        mkGroup({
            rgId: "RG_CS_MAJOR",
            title: "Computer Science Major",
            status: "not_satisfied",
            children: [
                mkRequirement({
                    rId: "R_CS_REQ",
                    title: "CS Required Courses",
                    status: "not_satisfied",
                    counter: { kind: "courses", required: 6, used: 2, needed: 4 },
                    coursesUsed: [
                        mkCourse({ term: "2024 Fall", courseId: "CSCI-UA 101", grade: "A-" }),
                        mkCourse({ term: "2025 Spr", courseId: "CSCI-UA 102", grade: "B+" }),
                    ],
                }),
            ],
        }),
    ],
    courseHistory: [
        mkCourse({ term: "2024 Fall", courseId: "CSCI-UA 101", grade: "A-" }),
        mkCourse({ term: "2024 Fall", courseId: "MATH-UA 121", grade: "B" }),
        mkCourse({ term: "2024 Fall", courseId: "EXPOS-UA 1", grade: "A" }),
        mkCourse({ term: "2025 Spr", courseId: "CSCI-UA 102", grade: "B+" }),
        mkCourse({ term: "2025 Spr", courseId: "MATH-UA 122", grade: "B" }),
    ],
});

const persona2: ConversationCase = {
    id: "smoke-p2-cas-soph-cs",
    description: "CAS sophomore CS major, 48 credits, missing 4 CS courses + CORE Texts/Cultures",
    student: {
        id: "smoke-p2",
        catalogYear: "2024-2025",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "cs_ba", programType: "major" }],
        coursesTaken: [],
        visaStatus: "domestic",
    } satisfies StudentProfile,
    degreeProgressReport: persona2Dpr,
    turns: [
        { userMessage: "How many credits do I have so far?" },
        { userMessage: "What CORE classes am I still missing?" },
        { userMessage: "I want to take 4 classes this fall to make progress on my major. What should I take?" },
        { userMessage: "How many P/F credits have I used?" },
    ],
};

// ---- Persona 3: CAS senior Econ, graduation-check --------------

const persona3Dpr = mkDpr({
    header: { studentName: "Persona Three", preparedDate: "04/27/2026" },
    programs: [
        { programType: "Undergraduate Career", label: "Undergraduate Career", requirementTerm: "Fall 2022", requirementStatus: "satisfied" },
        { programType: "Major Approved", label: "Economics", requirementTerm: "Fall 2023", requirementStatus: "not_satisfied" },
    ],
    cumulative: {
        creditsUsed: 122,
        cumulativeGpa: 3.65,
        residencyUsed: 96,
        passFailUsedUnits: 8,
        outsideHomeUsedUnits: 4,
    },
    requirementGroups: [
        mkGroup({
            rgId: "RG_ECON_MAJOR",
            title: "Economics Major",
            status: "not_satisfied",
            children: [
                mkRequirement({
                    rId: "R_ECON_ELECT",
                    title: "Economics Electives",
                    status: "not_satisfied",
                    statusText: "Not Satisfied: Complete 1 more ECON-UA 200-level elective.",
                    counter: { kind: "units", required: 12, used: 8, needed: 4 },
                    coursesUsed: [
                        mkCourse({ term: "2024 Fall", courseId: "ECON-UA 220", grade: "A" }),
                        mkCourse({ term: "2025 Spr", courseId: "ECON-UA 230", grade: "B+" }),
                    ],
                }),
            ],
        }),
    ],
    courseHistory: [
        mkCourse({ term: "2022 Fall", courseId: "ECON-UA 1", grade: "A" }),
        mkCourse({ term: "2023 Spr", courseId: "ECON-UA 2", grade: "A-" }),
        mkCourse({ term: "2023 Fall", courseId: "ECON-UA 18", grade: "B+" }),
        mkCourse({ term: "2024 Spr", courseId: "ECON-UA 20", grade: "B" }),
        mkCourse({ term: "2024 Fall", courseId: "ECON-UA 220", grade: "A" }),
        mkCourse({ term: "2025 Spr", courseId: "ECON-UA 230", grade: "B+" }),
    ],
});

const persona3: ConversationCase = {
    id: "smoke-p3-cas-senior-econ",
    description: "CAS senior Econ, 122 credits, GPA 3.65, 1 elective short",
    student: {
        id: "smoke-p3",
        catalogYear: "2022-2023",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "economics_ba", programType: "major" }],
        coursesTaken: [],
        visaStatus: "domestic",
    } satisfies StudentProfile,
    degreeProgressReport: persona3Dpr,
    turns: [
        { userMessage: "Am I on track to graduate this spring?" },
        { userMessage: "What's the one requirement I'm still missing?" },
        { userMessage: "Suggest a single course I could take this fall to finish my major." },
        { userMessage: "What's the deadline to drop a class with a W?" },
    ],
};

// ---- Persona 4: Stern junior (different home school) -----------

const persona4Dpr = mkDpr({
    header: { studentName: "Persona Four", preparedDate: "04/27/2026" },
    programs: [
        { programType: "Undergraduate Career", label: "Undergraduate Career", requirementTerm: "Fall 2023", requirementStatus: "satisfied" },
        { programType: "Major Approved", label: "Finance", requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" },
    ],
    cumulative: {
        creditsUsed: 88,
        cumulativeGpa: 3.45,
        residencyUsed: 88,
        passFailUsedUnits: 0,
        outsideHomeUsedUnits: 0,
    },
    requirementGroups: [
        mkGroup({
            rgId: "RG_STERN_FIN",
            title: "Stern Finance Major",
            status: "not_satisfied",
            children: [
                mkRequirement({
                    rId: "R_FIN_CORE",
                    title: "Finance Core",
                    status: "not_satisfied",
                    counter: { kind: "courses", required: 4, used: 2, needed: 2 },
                    coursesUsed: [
                        mkCourse({ term: "2024 Fall", courseId: "FINC-UB 1", grade: "A" }),
                        mkCourse({ term: "2025 Spr", courseId: "FINC-UB 2", grade: "B+" }),
                    ],
                }),
            ],
        }),
    ],
    courseHistory: [
        mkCourse({ term: "2023 Fall", courseId: "ACCT-UB 1", grade: "A" }),
        mkCourse({ term: "2023 Fall", courseId: "STAT-UB 1", grade: "B+" }),
        mkCourse({ term: "2024 Spr", courseId: "MGMT-UB 1", grade: "A-" }),
        mkCourse({ term: "2024 Fall", courseId: "FINC-UB 1", grade: "A" }),
        mkCourse({ term: "2025 Spr", courseId: "FINC-UB 2", grade: "B+" }),
    ],
});

const persona4: ConversationCase = {
    id: "smoke-p4-stern-jr-finance",
    description: "Stern junior Finance, 88 credits, missing 2 finance core courses",
    student: {
        id: "smoke-p4",
        catalogYear: "2023-2024",
        homeSchool: "stern",
        declaredPrograms: [{ programId: "stern_finance", programType: "major" }],
        coursesTaken: [],
        visaStatus: "domestic",
    } satisfies StudentProfile,
    degreeProgressReport: persona4Dpr,
    turns: [
        { userMessage: "What's my GPA and how many credits do I have left?" },
        { userMessage: "What finance courses am I still missing?" },
        { userMessage: "Can I take an FAS class as a Stern student?" },
        { userMessage: "What if I added a CS minor?" },
    ],
};

// ---- Persona 5: International CAS junior with F-1 --------------

const persona5Dpr = mkDpr({
    header: { studentName: "Persona Five", preparedDate: "04/27/2026" },
    programs: [
        { programType: "Undergraduate Career", label: "Undergraduate Career", requirementTerm: "Fall 2023", requirementStatus: "satisfied" },
        { programType: "Major Approved", label: "Mathematics", requirementTerm: "Fall 2023", requirementStatus: "not_satisfied" },
    ],
    cumulative: {
        creditsUsed: 76,
        cumulativeGpa: 3.78,
        residencyUsed: 76,
        passFailUsedUnits: 0,
        outsideHomeUsedUnits: 0,
    },
    requirementGroups: [
        mkGroup({
            rgId: "RG_MATH_MAJOR",
            title: "Mathematics Major",
            status: "not_satisfied",
            children: [
                mkRequirement({
                    rId: "R_MATH_REQ",
                    title: "Math Required Courses",
                    status: "not_satisfied",
                    counter: { kind: "courses", required: 8, used: 5, needed: 3 },
                    coursesUsed: [
                        mkCourse({ term: "2023 Fall", courseId: "MATH-UA 121", grade: "A" }),
                        mkCourse({ term: "2024 Spr", courseId: "MATH-UA 122", grade: "A" }),
                        mkCourse({ term: "2024 Fall", courseId: "MATH-UA 123", grade: "A-" }),
                        mkCourse({ term: "2025 Spr", courseId: "MATH-UA 140", grade: "B+" }),
                        mkCourse({ term: "2025 Spr", courseId: "MATH-UA 248", grade: "A" }),
                    ],
                }),
            ],
        }),
    ],
    courseHistory: [
        mkCourse({ term: "2023 Fall", courseId: "MATH-UA 121", grade: "A" }),
        mkCourse({ term: "2024 Spr", courseId: "MATH-UA 122", grade: "A" }),
        mkCourse({ term: "2024 Fall", courseId: "MATH-UA 123", grade: "A-" }),
        mkCourse({ term: "2025 Spr", courseId: "MATH-UA 140", grade: "B+" }),
        mkCourse({ term: "2025 Spr", courseId: "MATH-UA 248", grade: "A" }),
    ],
});

const persona5: ConversationCase = {
    id: "smoke-p5-cas-jr-math-f1",
    description: "International CAS junior Math, F-1 visa, asks policy-heavy questions",
    student: {
        id: "smoke-p5",
        catalogYear: "2023-2024",
        homeSchool: "cas",
        declaredPrograms: [{ programId: "math_ba", programType: "major" }],
        coursesTaken: [],
        visaStatus: "f1",
    } satisfies StudentProfile,
    degreeProgressReport: persona5Dpr,
    turns: [
        { userMessage: "What's the minimum credit load I need as an F-1 student?" },
        { userMessage: "Can I drop a class without losing full-time status?" },
        { userMessage: "How many math courses do I still need?" },
        { userMessage: "If I take an internship for credit, does it count toward my major?" },
    ],
};

export const SMOKE_W10_PERSONAS: ConversationCase[] = [
    persona1,
    persona2,
    persona3,
    persona4,
    persona5,
];
