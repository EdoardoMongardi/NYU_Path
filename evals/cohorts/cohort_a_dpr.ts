// ============================================================
// Cohort A — DPR-driven cases (Phase 7-E W6)
// ============================================================
// 40 new cohort-A cases that exercise the W3-refactored
// DPR-primary tool paths. Each case carries a parsed
// DegreeProgressReport built via the mkDpr helper; the runner
// injects it into session.degreeProgressReport, the agent's
// run_full_audit / plan_semester / what_if_audit then read
// from NYU's pre-computed audit.
//
// Domain coverage (matches PHASE_7E_PLAN.md §3 W6.1):
//   - 8 audit reads (graduation tracking, GPA, credits)
//   - 8 remaining-requirement queries
//   - 6 plan-next-semester suggestions
//   - 4 P/F + outside-CAS budget questions
//   - 8 hypothetical major switches (4 authored, 4 JIT-extracted)
//   - 4 hypothetical minor adds
//   - 6 policy questions (RAG-only path, no DPR involvement)
//   - 3 onboarding edge cases (kept in legacy starter file —
//     they happen pre-DPR; not duplicated here)
//   - 3 cross-school transfer scenarios
// ============================================================

import type { ConversationCase } from "../cohort/runner.js";
import type { StudentProfile } from "@nyupath/shared";
import {
    mkDpr,
    mkGroup,
    mkRequirement,
    mkCourse,
    mkAlmostDoneDpr,
    mkSatisfiedDpr,
} from "../../packages/engine/tests/helpers/mkDpr.js";

// ----------------------------------------------------------------
// Reusable student profile + DPR fixtures
// ----------------------------------------------------------------

const STUDENT_CAS_CS: StudentProfile = {
    id: "cohortA-dpr-cas-cs",
    catalogYear: "2024-2025",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "computer_science", programType: "major" }],
    coursesTaken: [],
    visaStatus: "domestic",
};

const STUDENT_CAS_CS_F1: StudentProfile = {
    ...STUDENT_CAS_CS,
    id: "cohortA-dpr-cas-cs-f1",
    visaStatus: "f1",
};

const STUDENT_CAS_ECON: StudentProfile = {
    id: "cohortA-dpr-cas-econ",
    catalogYear: "2024-2025",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "cas_econ_ba", programType: "major" }],
    coursesTaken: [],
    visaStatus: "domestic",
};

const STUDENT_CAS_MATH: StudentProfile = {
    id: "cohortA-dpr-cas-math",
    catalogYear: "2024-2025",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "math_major", programType: "major" }],
    coursesTaken: [],
    visaStatus: "domestic",
};

// DPR fixtures used across multiple cases.

const DPR_GRAD_READY = mkDpr({
    cumulative: { creditsUsed: 132, cumulativeGpa: 3.65, residencyUsed: 78 },
    requirementGroups: [
        mkGroup({
            rgId: "RG_CS_MAJOR",
            title: "Computer Science Major",
            status: "satisfied",
            children: [mkRequirement({ rId: "R_CS/10", status: "satisfied" })],
        }),
    ],
});

const DPR_ALMOST_DONE_PF_HEAVY = mkDpr({
    cumulative: { creditsUsed: 124, cumulativeGpa: 3.4, passFailUsedUnits: 28 },
    requirementGroups: [
        mkGroup({
            rgId: "RG_CS_MAJOR",
            title: "Computer Science Major",
            status: "not_satisfied",
            children: [
                mkRequirement({
                    rId: "R_CS/10",
                    title: "Computer Science: Required Courses",
                    status: "not_satisfied",
                    statusText: "Not Satisfied: Complete CSCI-UA 421 Numerical Computing.",
                    counter: { kind: "courses", required: 6, used: 5, needed: 1 },
                }),
            ],
        }),
    ],
});

const DPR_F1_AT_FLOOR = mkDpr({
    cumulative: { creditsUsed: 80, cumulativeGpa: 3.1 },
    requirementGroups: [
        mkGroup({
            rgId: "RG_CS_MAJOR", title: "Computer Science Major", status: "not_satisfied",
            children: [mkRequirement({ rId: "R_CS/10", status: "not_satisfied",
                counter: { kind: "courses", required: 8, used: 4, needed: 4 } })],
        }),
    ],
    courseHistory: [
        mkCourse({ term: "2026 Spr", courseId: "CSCI-UA 102", grade: null, units: 4, type: "IP" }),
        mkCourse({ term: "2026 Spr", courseId: "CSCI-UA 201", grade: null, units: 4, type: "IP" }),
        mkCourse({ term: "2026 Spr", courseId: "MATH-UA 121", grade: null, units: 4, type: "IP" }),
    ],
});

const DPR_ECON_MIDWAY = mkDpr({
    programs: [
        { programType: "Undergraduate Career", label: "Undergraduate Career",
          requirementTerm: "Fall 2023", requirementStatus: "satisfied" },
        { programType: "Major Approved", label: "Economics",
          requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" },
    ],
    cumulative: { creditsUsed: 96, cumulativeGpa: 3.55, outsideHomeUsedUnits: 8 },
    requirementGroups: [
        mkGroup({
            rgId: "RG_ECON", title: "Economics Major", status: "not_satisfied",
            children: [
                mkRequirement({ rId: "R_ECON/10", title: "Intermediate Microeconomics",
                    status: "not_satisfied", statusText: "Not Satisfied: Complete ECON-UA 10 or ECON-UA 11.",
                    counter: { kind: "courses", required: 1, used: 0, needed: 1 } }),
                mkRequirement({ rId: "R_ECON/20", title: "Econometrics",
                    status: "not_satisfied", statusText: "Not Satisfied: Complete ECON-UA 266.",
                    counter: { kind: "courses", required: 1, used: 0, needed: 1 } }),
            ],
        }),
    ],
});

const DPR_MATH_PURE = mkDpr({
    programs: [
        { programType: "Undergraduate Career", label: "Undergraduate Career",
          requirementTerm: "Fall 2023", requirementStatus: "satisfied" },
        { programType: "Major Approved", label: "Mathematics",
          requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" },
    ],
    cumulative: { creditsUsed: 110, cumulativeGpa: 3.7 },
    requirementGroups: [
        mkGroup({
            rgId: "RG_MATH", title: "Mathematics Major (Pure track)", status: "not_satisfied",
            children: [
                mkRequirement({ rId: "R_MATH/10", title: "Real Analysis",
                    status: "not_satisfied", statusText: "Not Satisfied: Complete MATH-UA 325.",
                    counter: { kind: "courses", required: 1, used: 0, needed: 1 } }),
                mkRequirement({ rId: "R_MATH/20", title: "Algebra",
                    status: "not_satisfied", statusText: "Not Satisfied: Complete MATH-UA 343.",
                    counter: { kind: "courses", required: 1, used: 0, needed: 1 } }),
            ],
        }),
    ],
});

// ----------------------------------------------------------------
// Cohort A — DPR-driven cases (40)
// ----------------------------------------------------------------

export const COHORT_A_DPR_CASES: ConversationCase[] = [
    // ============================================================
    // Audit reads (8) — exercise run_full_audit DPR primary path
    // ============================================================
    {
        id: "cohortA-dpr-101-grad-status",
        description: "Graduation-ready student asks 'am I done?' — DPR shows all satisfied.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_GRAD_READY,
        turns: [{
            userMessage: "Am I on track to graduate? What's my status?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["3.650"], // GPA from DPR cumulative — must trace verbatim
            forbiddenPatterns: [/^you might/i],
        }],
    },
    {
        id: "cohortA-dpr-102-gpa-query",
        description: "GPA-only question — agent must call run_full_audit (Cardinal Rule §2.1).",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "What's my cumulative GPA right now?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["3.400"],
            forbiddenPatterns: [/your gpa is around/i, /approximately/i],
        }],
    },
    {
        id: "cohortA-dpr-103-credits-query",
        description: "Credit count from DPR cumulative block.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "How many credits do I have so far?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["124"],
        }],
    },
    {
        id: "cohortA-dpr-104-residency-check",
        description: "CAS residency check (R1001/35).",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_GRAD_READY,
        turns: [{
            userMessage: "Have I met the CAS residency requirement of 64 credits in CAS?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["78"],
        }],
    },
    {
        id: "cohortA-dpr-105-good-standing",
        description: "Below-2.0 GPA flagged as academic_concern.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: mkDpr({ cumulative: { cumulativeGpa: 1.85, creditsUsed: 64 } }),
        turns: [{
            userMessage: "Am I in good academic standing?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["1.850"],
            requiresAdviserCaveat: true,
        }],
    },
    {
        id: "cohortA-dpr-106-multi-program-audit",
        description: "Student with major + minor; audit walks both.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: mkDpr({
            programs: [
                { programType: "Undergraduate Career", label: "Undergraduate Career",
                  requirementTerm: "Fall 2023", requirementStatus: "satisfied" },
                { programType: "Major Approved", label: "Computer Science",
                  requirementTerm: "Fall 2024", requirementStatus: "satisfied" },
                { programType: "Minor", label: "Mathematics Minor",
                  requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" },
            ],
            cumulative: { creditsUsed: 120, cumulativeGpa: 3.5 },
        }),
        turns: [{
            userMessage: "Where do I stand on both my major and my Math minor?",
            expectedToolCalls: ["run_full_audit"],
        }],
    },
    {
        id: "cohortA-dpr-107-near-grad-econ",
        description: "Econ junior asks for an audit — DPR shows 2 unmet major reqs.",
        student: STUDENT_CAS_ECON,
        degreeProgressReport: DPR_ECON_MIDWAY,
        turns: [{
            userMessage: "Audit me — am I on track for Econ?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["3.550", "96"],
        }],
    },
    {
        id: "cohortA-dpr-108-pf-tally",
        description: "Pass/Fail budget query — DPR's R1680/10 has the running tally.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "How many pass/fail credits have I used? Am I close to the cap?",
            // The agent might call run_full_audit OR get_credit_caps; both are
            // acceptable. We check the reply mentions both numbers.
            requiredCaveats: ["28", "32"],
        }],
    },

    // ============================================================
    // Remaining-requirement queries (8)
    // ============================================================
    {
        id: "cohortA-dpr-201-what-do-i-need",
        description: "Almost-done student asks what's left → CSCI-UA 421 surfaces.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "What requirements do I still need to satisfy?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["CSCI-UA 421"],
        }],
    },
    {
        id: "cohortA-dpr-202-econ-missing-courses",
        description: "Econ midway student asks what's left.",
        student: STUDENT_CAS_ECON,
        degreeProgressReport: DPR_ECON_MIDWAY,
        turns: [{
            userMessage: "What classes am I missing for the Econ major?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["ECON-UA"],
        }],
    },
    {
        id: "cohortA-dpr-203-math-missing",
        description: "Math major: Algebra + Real Analysis still needed.",
        student: STUDENT_CAS_MATH,
        degreeProgressReport: DPR_MATH_PURE,
        turns: [{
            userMessage: "What do I still need to graduate?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["MATH-UA 325", "MATH-UA 343"],
        }],
    },
    {
        id: "cohortA-dpr-204-am-i-done",
        description: "Fully satisfied DPR — agent confirms graduation eligibility.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: mkSatisfiedDpr(),
        turns: [{
            userMessage: "Am I done? Can I graduate?",
            expectedToolCalls: ["run_full_audit"],
            forbiddenPatterns: [/might still need/i, /probably/i],
        }],
    },
    {
        id: "cohortA-dpr-205-elective-count",
        description: "Student asks how many electives they still need.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: mkDpr({
            cumulative: { creditsUsed: 100, cumulativeGpa: 3.2 },
            requirementGroups: [
                mkGroup({
                    rgId: "RG_ELECT", title: "Free Electives", status: "not_satisfied",
                    children: [mkRequirement({ rId: "R_ELECT/10",
                        status: "not_satisfied",
                        counter: { kind: "units", required: 28, used: 16, needed: 12 } })],
                }),
            ],
        }),
        turns: [{
            userMessage: "How many free elective credits do I still need?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["12"],
        }],
    },
    {
        id: "cohortA-dpr-206-core-curriculum",
        description: "Core CORE-UA Texts & Ideas requirement still unmet.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: mkDpr({
            cumulative: { creditsUsed: 96 },
            requirementGroups: [
                mkGroup({
                    rgId: "RG_CORE", title: "CORE Foundations", status: "overall_not_satisfied",
                    children: [mkRequirement({ rId: "R_CORE/10", title: "Texts & Ideas",
                        status: "not_satisfied",
                        statusText: "Not Satisfied: Complete 1 course from CORE-UA 400-499.",
                        counter: { kind: "courses", required: 1, used: 0, needed: 1 } })],
                }),
            ],
        }),
        turns: [{
            userMessage: "What core requirements am I missing?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["CORE-UA 400"],
        }],
    },
    {
        id: "cohortA-dpr-207-language-requirement",
        description: "Student forgot whether the foreign-language requirement is satisfied.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: mkDpr({
            requirementGroups: [
                mkGroup({
                    rgId: "RG_LANG", title: "Foreign Language", status: "satisfied",
                    children: [mkRequirement({ rId: "R_LANG/10", status: "satisfied",
                        statusText: "Satisfied: 4 credits intermediate proficiency completed." })],
                }),
            ],
        }),
        turns: [{
            userMessage: "Have I met my foreign language requirement?",
            expectedToolCalls: ["run_full_audit"],
        }],
    },
    {
        id: "cohortA-dpr-208-summary-counter",
        description: "RG-level summary counter (X courses required, Y used, Z needed) surfaces.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Roughly how much is left?",
            expectedToolCalls: ["run_full_audit"],
            requiredCaveats: ["1"], // 1 needed
        }],
    },

    // ============================================================
    // Plan-next-semester (6)
    // ============================================================
    {
        id: "cohortA-dpr-301-plan-fall",
        description: "Almost-done CS student plans next semester — CSCI-UA 421 should surface.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "What should I take next semester to finish my major?",
            expectedToolCalls: ["plan_semester"],
            requiredCaveats: ["CSCI-UA 421"],
        }],
    },
    {
        id: "cohortA-dpr-302-plan-econ",
        description: "Econ student plans Spring 2027.",
        student: STUDENT_CAS_ECON,
        degreeProgressReport: DPR_ECON_MIDWAY,
        turns: [{
            userMessage: "Plan my next semester. I want to make progress on the major.",
            expectedToolCalls: ["plan_semester"],
            requiredCaveats: ["ECON-UA"],
        }],
    },
    {
        id: "cohortA-dpr-303-plan-fewer-credits",
        description: "Student requests a lighter load (12 credits) — F-1 floor still met.",
        student: STUDENT_CAS_CS_F1,
        degreeProgressReport: DPR_F1_AT_FLOOR,
        turns: [{
            userMessage: "I want a lighter semester — plan 12 credits worth.",
            expectedToolCalls: ["plan_semester"],
            requiredCaveats: ["F-1", "12"],
        }],
    },
    {
        id: "cohortA-dpr-304-plan-priority",
        description: "Student wants the most-impactful courses ranked first.",
        student: STUDENT_CAS_MATH,
        degreeProgressReport: DPR_MATH_PURE,
        turns: [{
            userMessage: "Rank what I should take to graduate fastest.",
            expectedToolCalls: ["plan_semester"],
            requiredCaveats: ["MATH-UA"],
        }],
    },
    {
        id: "cohortA-dpr-305-plan-summer",
        description: "Summer-session planning — agent should still respect prereqs.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Can I knock out CSCI-UA 421 over the summer?",
            // Either plan_semester or search_availability is acceptable.
        }],
    },
    {
        id: "cohortA-dpr-306-plan-with-target-term",
        description: "Explicit target-term plan request.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Plan me a 4-course schedule for 2027-spring.",
            expectedToolCalls: ["plan_semester"],
        }],
    },

    // ============================================================
    // P/F + outside-CAS budget (4)
    // ============================================================
    {
        id: "cohortA-dpr-401-pf-near-cap",
        description: "Heavy P/F user asks if they can take another P/F course.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "I've used 28 P/F credits already. Can I take one more class P/F?",
            requiredCaveats: ["32"],
            forbiddenPatterns: [/^yes,? you can take/i],
        }],
    },
    {
        id: "cohortA-dpr-402-pf-major-rule",
        description: "P/F-major restriction reminder.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Can I take CSCI-UA 421 P/F?",
            requiredCaveats: ["No"], // P/F not allowed for major courses
            forbiddenPatterns: [/^yes/i],
        }],
    },
    {
        id: "cohortA-dpr-403-outside-cas-cap",
        description: "Outside-CAS credit cap question.",
        student: STUDENT_CAS_ECON,
        degreeProgressReport: DPR_ECON_MIDWAY,
        turns: [{
            userMessage: "I want to take a Stern course. How many non-CAS credits am I allowed?",
            requiredCaveats: ["16"],
        }],
    },
    {
        id: "cohortA-dpr-404-time-limit",
        description: "8-year time-limit reminder.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: mkDpr({
            cumulative: { timeLimitYears: 8, creditsUsed: 100 },
        }),
        turns: [{
            userMessage: "Is there a time limit on how long I have to finish my degree?",
            requiredCaveats: ["8"],
        }],
    },

    // ============================================================
    // Hypothetical major switches (8) — 4 authored, 4 JIT
    // ============================================================
    {
        id: "cohortA-dpr-501-whatif-cs-to-econ",
        description: "Switch CS → Econ; cas_econ_ba is in authored catalog.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "What if I switched my major to Economics?",
            expectedToolCalls: ["what_if_audit"],
        }],
    },
    {
        id: "cohortA-dpr-502-whatif-add-econ",
        description: "Add Econ as second major while keeping CS.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Could I add Economics as a second major?",
            expectedToolCalls: ["what_if_audit"],
        }],
    },
    {
        id: "cohortA-dpr-503-whatif-cs-to-math",
        description: "Switch CS → Math (Math major isn't authored — disclaimer required).",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "What if I switched to Mathematics instead?",
            expectedToolCalls: ["what_if_audit"],
            requiredCaveats: ["adviser"],
        }],
    },
    {
        id: "cohortA-dpr-504-whatif-stern",
        description: "Switch to Stern Finance — JIT path with disclaimer + transfer caveat.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "What if I transferred to Stern Finance? Is it possible?",
            expectedToolCalls: ["what_if_audit", "check_transfer_eligibility"],
            requiredCaveats: ["GPA", "not published", "adviser"],
        }],
    },
    {
        id: "cohortA-dpr-505-whatif-tisch",
        description: "Switch to Tisch program — JIT path; should include adviser caveat.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "What if I switched to Film & TV at Tisch?",
            expectedToolCalls: ["what_if_audit"],
            requiredCaveats: ["adviser"],
        }],
    },
    {
        id: "cohortA-dpr-506-whatif-tandon",
        description: "Switch to Tandon CS BS.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Could I move to the Tandon BS in Computer Science?",
            expectedToolCalls: ["what_if_audit"],
            requiredCaveats: ["adviser"],
        }],
    },
    {
        id: "cohortA-dpr-507-whatif-double-major-econ-math",
        description: "Add Math as second major to Econ student.",
        student: STUDENT_CAS_ECON,
        degreeProgressReport: DPR_ECON_MIDWAY,
        turns: [{
            userMessage: "Could I double major in Math along with Econ?",
            expectedToolCalls: ["what_if_audit"],
        }],
    },
    {
        id: "cohortA-dpr-508-whatif-econ-track",
        description: "Switch Econ concentration (Theory vs Policy) — JIT path.",
        student: STUDENT_CAS_ECON,
        degreeProgressReport: DPR_ECON_MIDWAY,
        turns: [{
            userMessage: "What if I switched to the Econ Theory concentration?",
            expectedToolCalls: ["what_if_audit"],
            requiredCaveats: ["adviser"],
        }],
    },

    // ============================================================
    // Hypothetical minor adds (4)
    // ============================================================
    {
        id: "cohortA-dpr-601-add-math-minor",
        description: "Add Math minor to CS major; not authored — disclaimer.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "I want to add a Math minor. Will I still graduate on time?",
            expectedToolCalls: ["what_if_audit"],
            requiredCaveats: ["adviser"],
        }],
    },
    {
        id: "cohortA-dpr-602-add-data-science",
        description: "Add Data Science minor.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Could I add a Data Science minor?",
            expectedToolCalls: ["what_if_audit"],
            requiredCaveats: ["adviser"],
        }],
    },
    {
        id: "cohortA-dpr-603-business-minor",
        description: "Add Stern business minor — cross-school caps + JIT.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Can I add a Business of Entertainment, Media & Technology minor?",
            expectedToolCalls: ["what_if_audit"],
            requiredCaveats: ["16"], // outside-home cap
        }],
    },
    {
        id: "cohortA-dpr-604-minor-time-cost",
        description: "Cost-of-minor question.",
        student: STUDENT_CAS_ECON,
        degreeProgressReport: DPR_ECON_MIDWAY,
        turns: [{
            userMessage: "What's the time cost of adding a Stats minor?",
            expectedToolCalls: ["what_if_audit"],
        }],
    },

    // ============================================================
    // Policy questions (6) — RAG-only path, no DPR involvement
    // ============================================================
    {
        id: "cohortA-dpr-701-pf-deadline",
        description: "P/F deadline — template fast-path expected.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "What's the deadline to switch a class to P/F?",
        }],
    },
    {
        id: "cohortA-dpr-702-withdrawal-window",
        description: "Withdrawal window question.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Until when can I drop a class with a W?",
            expectedToolCalls: ["search_policy"],
        }],
    },
    {
        id: "cohortA-dpr-703-incomplete-policy",
        description: "Incomplete-grade policy — RAG.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Can I take an incomplete in a class? What happens then?",
            expectedToolCalls: ["search_policy"],
        }],
    },
    {
        id: "cohortA-dpr-704-residency-policy",
        description: "Residency policy explainer.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "How does the CAS residency requirement work?",
            expectedToolCalls: ["search_policy"],
            requiredCaveats: ["64"],
        }],
    },
    {
        id: "cohortA-dpr-705-graduation-application",
        description: "Graduation application timing.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_GRAD_READY,
        turns: [{
            userMessage: "When do I need to apply to graduate?",
            expectedToolCalls: ["search_policy"],
        }],
    },
    {
        id: "cohortA-dpr-706-leave-of-absence",
        description: "Leave-of-absence policy lookup.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "How does taking a leave of absence work?",
            expectedToolCalls: ["search_policy"],
        }],
    },

    // ============================================================
    // Cross-school transfer scenarios (3)
    // ============================================================
    {
        id: "cohortA-dpr-801-stern-internal-transfer-prereqs",
        description: "Stern internal transfer prereq enumeration.",
        student: STUDENT_CAS_ECON,
        degreeProgressReport: DPR_ECON_MIDWAY,
        turns: [{
            userMessage: "What prereqs do I need to internal-transfer to Stern?",
            expectedToolCalls: ["check_transfer_eligibility"],
            requiredCaveats: ["GPA", "not published"],
        }],
    },
    {
        id: "cohortA-dpr-802-tandon-transfer-window",
        description: "Tandon transfer window question.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "Can I transfer to Tandon as a senior, or is it too late?",
            expectedToolCalls: ["check_transfer_eligibility"],
            requiresAdviserCaveat: true,
        }],
    },
    {
        id: "cohortA-dpr-803-credit-transfer-cap",
        description: "Credit-transfer cap policy.",
        student: STUDENT_CAS_CS,
        degreeProgressReport: DPR_ALMOST_DONE_PF_HEAVY,
        turns: [{
            userMessage: "If I transferred to Stern, how many of my CAS credits would carry over?",
            expectedToolCalls: ["check_transfer_eligibility"],
        }],
    },
];
