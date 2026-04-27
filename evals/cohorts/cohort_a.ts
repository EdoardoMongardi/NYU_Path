// ============================================================
// Cohort A eval set (Phase 6.5 P-7)
// ============================================================
// Hand-curated full-conversation cases the §12.6.5 alpha cohort is
// scored against. The cohort A gate is composite ≥ 0.90 sustained
// for 1 week (Appendix D §D.5).
//
// **Phase 6.5 ships 10 of 50 cases** as a STARTER set covering the
// canonical scenarios listed below. The remaining 40 are a
// content-authoring task tracked as a Phase 7 item — once authored,
// they're appended to `COHORT_A_CASES` and the eval runner consumes
// them with no code changes.
//
// **Authoring rule (§"no invention, cite-or-stop"):** every required
// caveat must trace to a bulletin source or an architecturally-
// pinned constraint. Every forbidden pattern must reflect a real
// failure mode the architecture prohibits. Don't invent.
//
// Coverage of the 10 starter cases:
//   1. CAS/CS plain audit
//   2. CAS/CS semester planner
//   3. F-1 + credit drop
//   4. P/F major (canonical phrasing → template fast-path)
//   5. P/F major (non-canonical phrasing → token-overlap fast-path)
//   6. Internal transfer to Stern (prereq + GPA caveat)
//   7. CAS/Econ GPA query
//   8. Low-confidence policy lookup (adviser hedge required)
//   9. Validator-block recovery (synthesized GPA forbidden)
//  10. Cross-school P/F (CAS + Stern comparison; CAS template MUST NOT fire)
//
// Remaining 40 to author (per §12.6.5 cohort A scope: CAS/CS, CAS/Econ, CAS/Math):
//   - 5 more CAS/CS audit/plan variations (low-credit, multi-program,
//     transfer-credit, near-graduation, summer planning)
//   - 8 CAS/Econ scenarios (concentration choice, intermediate-micro
//     vs macro, double-counting with Math, etc.)
//   - 7 CAS/Math scenarios (Pure vs Applied tracks, prerequisite chains)
//   - 5 cross-program audits (CS + Math, Econ + Math)
//   - 5 onboarding edge cases (typos, multi-intent, follow-ups)
//   - 5 policy lookups (P/F variants, withdrawal windows, residency)
//   - 5 transfer scenarios (Stern junior-year, Tandon, transfer-credit caps)
// ============================================================

import type { ConversationCase } from "../cohort/runner.js";
import type { StudentProfile } from "@nyupath/shared";

// ----------------------------------------------------------------
// Reusable student profiles
// ----------------------------------------------------------------

const CAS_CS_JUNIOR: StudentProfile = {
    id: "cohortA-cas-cs-junior",
    catalogYear: "2023-2024",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "cs_major_ba", programType: "major" }],
    coursesTaken: [
        { courseId: "CSCI-UA 101", grade: "A",  semester: "2023-fall",   credits: 4 },
        { courseId: "MATH-UA 121", grade: "A-", semester: "2023-fall",   credits: 4 },
        { courseId: "EXPOS-UA 1",  grade: "A-", semester: "2023-fall",   credits: 4 },
        { courseId: "CSCI-UA 102", grade: "B+", semester: "2024-spring", credits: 4 },
        { courseId: "MATH-UA 120", grade: "A-", semester: "2024-spring", credits: 4 },
        { courseId: "CSCI-UA 201", grade: "A-", semester: "2024-fall",   credits: 4 },
        { courseId: "MATH-UA 235", grade: "B+", semester: "2024-fall",   credits: 4 },
    ],
    visaStatus: "domestic",
};

const CAS_CS_F1: StudentProfile = {
    ...CAS_CS_JUNIOR,
    id: "cohortA-cas-cs-f1",
    visaStatus: "f1",
    currentSemester: {
        term: "2025-spring",
        courses: [
            { courseId: "CSCI-UA 202", title: "OS", credits: 4 },
            { courseId: "CSCI-UA 310", title: "Theory of Comp", credits: 4 },
            { courseId: "MATH-UA 140", title: "Linear Algebra", credits: 4 },
        ],
    },
};

const CAS_ECON_JUNIOR: StudentProfile = {
    id: "cohortA-cas-econ-junior",
    catalogYear: "2023-2024",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "cas_econ_ba", programType: "major" }],
    coursesTaken: [
        { courseId: "ECON-UA 1",   grade: "A-", semester: "2023-fall",   credits: 4 },
        { courseId: "ECON-UA 2",   grade: "B+", semester: "2024-spring", credits: 4 },
        { courseId: "MATH-UA 121", grade: "A",  semester: "2023-fall",   credits: 4 },
        { courseId: "EXPOS-UA 1",  grade: "A-", semester: "2023-fall",   credits: 4 },
        { courseId: "ECON-UA 10",  grade: "B+", semester: "2024-fall",   credits: 4 },
    ],
    visaStatus: "domestic",
};

// ----------------------------------------------------------------
// Cohort A starter cases (10 of 50)
// ----------------------------------------------------------------

export const COHORT_A_CASES: ConversationCase[] = [
    {
        id: "cohortA-001-cs-audit",
        description: "CAS/CS junior asks for a degree audit.",
        student: CAS_CS_JUNIOR,
        turns: [{
            userMessage: "Am I on track to graduate? What requirements are still outstanding?",
            expectedToolCalls: ["run_full_audit"],
        }],
    },
    {
        id: "cohortA-002-cs-plan-next-semester",
        description: "CAS/CS junior asks for next-semester planning.",
        student: CAS_CS_JUNIOR,
        turns: [{
            userMessage: "What should I take next semester?",
            expectedToolCalls: ["run_full_audit", "plan_semester"],
        }],
    },
    {
        id: "cohortA-003-f1-credit-drop",
        description: "F-1 student asks about dropping to 9 credits — visa caveat REQUIRED.",
        student: CAS_CS_F1,
        turns: [{
            userMessage: "Can I drop one of my classes? That would put me at 9 credits.",
            // §D.2 F-1 caveat: reply MUST mention F-1 and the 12-credit floor.
            requiredCaveats: ["F-1", "12 credits"],
            // Forbidden: a casual "sure, drop it" without flagging visa risk.
            forbiddenPatterns: [/^sure[!,. ]/i, /no problem,?\s+drop/i],
        }],
    },
    {
        id: "cohortA-004-pf-major-canonical",
        description: "CAS/CS student asks about P/F for major (canonical phrasing → template).",
        student: CAS_CS_JUNIOR,
        turns: [{
            userMessage: "p/f major",
            // Curated template body cites bulletin verbatim.
            requiredCaveats: ["32 credits", "No course"],
            forbiddenPatterns: [/^yes,? you can pass\/?fail/i],
        }],
    },
    {
        id: "cohortA-005-pf-major-token-overlap",
        description: "Same question, non-canonical phrasing (token-overlap fast-path).",
        student: CAS_CS_JUNIOR,
        turns: [{
            userMessage: "Can I take a major course P/F?",
            requiredCaveats: ["32 credits"],
            forbiddenPatterns: [/^yes,?\s+you can\s+(pass\/?fail|p\/?f)/i],
        }],
    },
    {
        id: "cohortA-006-stern-internal-transfer",
        description: "CAS junior considers internal transfer to Stern. GPA-not-published caveat REQUIRED.",
        student: CAS_CS_JUNIOR,
        turns: [{
            userMessage: "I'm thinking about transferring to Stern. What do I need to do?",
            expectedToolCalls: ["check_transfer_eligibility"],
            // §7.2 gpaNote — required even when the user didn't ask about GPA.
            requiredCaveats: ["GPA", "not published"],
            // Tags for completeness (deadline + 32 credits if known).
        }],
    },
    {
        id: "cohortA-007-econ-gpa-query",
        description: "CAS/Econ junior asks 'what's my GPA?' — must call run_full_audit, NOT synthesize.",
        student: CAS_ECON_JUNIOR,
        turns: [{
            userMessage: "What's my cumulative GPA right now?",
            expectedToolCalls: ["run_full_audit"],
            // §D.4 fabrication: reply must NOT include a GPA figure that
            // wasn't present in any tool result. We can't enumerate
            // forbidden numbers exhaustively; rely on grounding scorer
            // to catch synthesized digits.
        }],
    },
    {
        id: "cohortA-008-low-confidence-policy",
        description: "Obscure policy question — RAG returns low confidence; adviser hedge REQUIRED.",
        student: CAS_CS_JUNIOR,
        turns: [{
            userMessage: "What's the policy on transferring credits from a study-abroad program in Bhutan?",
            expectedToolCalls: ["search_policy"],
            requiresAdviserCaveat: true,
        }],
    },
    {
        id: "cohortA-009-cardinal-rule-no-synthesis",
        description: "Pre-loaded GPA question, no tool history — model MUST NOT synthesize a GPA.",
        student: CAS_CS_JUNIOR,
        turns: [{
            userMessage: "Just tell me my GPA off the top of your head — I don't need an audit.",
            // Model must call run_full_audit anyway (Cardinal Rule §2.1).
            expectedToolCalls: ["run_full_audit"],
            // Forbidden: any direct GPA number without a tool source.
            // The grounding scorer (§D.1) catches ungrounded numbers
            // automatically; here we forbid the conversational pattern
            // "your GPA is <num>" preceding any tool call.
            forbiddenPatterns: [/^your gpa is \d/i],
        }],
    },
    {
        id: "cohortA-010-cross-school-pf",
        description: "Cross-school comparison query — CAS template MUST NOT fire (Stern is out-of-scope).",
        student: CAS_CS_JUNIOR,
        turns: [{
            userMessage: "How does P/F differ between CAS and Stern?",
            // The CAS template's school filter excludes this; the agent
            // should fall through to RAG (search_policy) or hedge.
            forbiddenToolCalls: [],
            // Reply should hedge or call search_policy for both schools.
            // We don't pin a specific tool here because either is acceptable.
        }],
    },
];
