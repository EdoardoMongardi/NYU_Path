// ============================================================
// Phase 10 Stage 1 — Edge case bench (16 + 10)
// ============================================================
// 16 issues from the operator's real 13-turn conversation audit
// (the conversation that motivated Phase 9 + 9.5) + 10 NEW edge
// cases the system has never been tested against. Used for:
//   1. Phase 10 baseline measurement (current architecture).
//   2. 3-architecture bake-off (A: pure posture / B: + reviewer
//      / C: + composer).
//   3. Stage 5 generalization replay.
//
// The cases are written to be answerable WITHOUT any per-case
// rule in the system prompt — they probe whether the architecture
// (data → envelope → posture) emits the right answer.
//
// Reuses the BakeoffQuestion shape from bakeoff_25.ts so the
// existing grader keeps working.
// ============================================================

import type { BakeoffQuestion } from "./bakeoff_25.js";

// ----------------------------------------------------------------
// SECTION A — 16 issues from the operator's real conversation
// ----------------------------------------------------------------
// Each issue traces back to a concrete failure mode found in the
// 13-turn audit. The tag in the rubric ("[issue #N]") matches the
// numbering operator used in the post-mortem.

const SECTION_A_KNOWN_ISSUES: BakeoffQuestion[] = [
    {
        id: "P10_A01",
        category: "AUDIT",
        question: "What's my current GPA, and am I in good standing?",
        autoChecks: [
            { kind: "contains", text: "3.402" },
            { kind: "containsAny", options: ["good standing", "in good"] },
        ],
        judgeRubric:
            "[issue #1] Must cite GPA verbatim from DPR (3.402, no rounding). " +
            "Must answer good-standing question affirmatively with the GPA basis.",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "P10_A02",
        category: "AUDIT",
        question: "Which requirements have I not met yet?",
        autoChecks: [
            { kind: "containsAny", options: ["Texts and Ideas", "Texts & Ideas", "CORE-UA 400"] },
            { kind: "contains", text: "CSCI-UA 421" },
        ],
        judgeRubric:
            "[issue #2] Must surface (a) Texts and Ideas / CORE-UA 400-499 and " +
            "(b) CSCI-UA 421 (Numerical Computing). NO duplication of the same " +
            "requirement (post-Phase-8 dedup must hold).",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "P10_A03",
        category: "POLICY",
        question: "Does CORE-UA 700 satisfy Texts and Ideas?",
        autoChecks: [
            { kind: "containsAny", options: ["No", "no,", "does not", "doesn't"] },
            { kind: "containsAny", options: ["Expressive Culture", "expressive culture"] },
        ],
        judgeRubric:
            "[issue #5] Must answer NO (CORE-UA 700 is in the 7XX range = " +
            "Expressive Culture, not 4XX = Texts and Ideas). Should explain WHY. " +
            "Phase 9.5 fixed this via prose rule; Phase 10 must fix it via DATA " +
            "(the search_policy envelope's CORE-UA classification).",
    },
    {
        id: "P10_A04",
        category: "PLAN",
        question: "Plan my Spring 2027 semester.",
        autoChecks: [
            { kind: "containsAny", options: ["Spring 2027", "spring 2027"] },
            { kind: "contains", text: "CSCI-UA 421" },
            { kind: "containsAny", options: ["CORE-UA 4", "Texts and Ideas", "Texts & Ideas"] },
        ],
        judgeRubric:
            "[issue #6 + #14] Must label the term Spring 2027, recommend " +
            "CSCI-UA 421, recommend a CORE-UA 4XX. Bonus: cites the bulletin's " +
            "sample plan of study (Phase 9.5 stapled this on; Phase 10 should " +
            "surface it as a structured anchor field, NOT a prose rule).",
    },
    {
        id: "P10_A05",
        category: "AUDIT",
        question: "How many P/F credits have I used? Can I use P/F for my major?",
        autoChecks: [
            { kind: "containsAll", texts: ["4", "32"] },
            { kind: "containsAny", options: ["does not count", "cannot", "not allowed", "P/F option does not"] },
        ],
        judgeRubric:
            "[issue #12 + #13] Must answer BOTH parts: (a) used 4 of 32 from DPR, " +
            "(b) P/F does NOT count toward the major. The P/F-for-major rule must " +
            "come from the search_policy envelope's disclaimers (data), NOT from a " +
            "system-prompt rule.",
    },
    {
        id: "P10_A06",
        category: "POLICY",
        question: "What grade do I need in MATH-UA 121 for the joint Math/CS major?",
        autoChecks: [
            { kind: "containsAny", options: ["C or better", "grade of C", "C-"] },
        ],
        judgeRubric:
            "[issue #12] Must cite the C-or-better-for-major rule (CAS bulletin). " +
            "Must come from search_policy envelope's structured disclaimer, NOT " +
            "from a hardcoded prompt rule.",
    },
    {
        id: "P10_A07",
        category: "AUDIT",
        question: "What courses am I currently registered for?",
        autoChecks: [
            { kind: "containsAny", options: ["CORE-UA 700", "MATH-UA 251", "MATH-UA 343"] },
        ],
        judgeRubric:
            "[issue #7] Must surface the in-progress courses (Fall 2026: CORE-UA 700, " +
            "MATH-UA 251, MATH-UA 343). Should NOT say 'audit doesn't list them'. " +
            "Tests dprInProgressCourses surfacing.",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "P10_A08",
        category: "POLICY",
        question: "Can I switch from CAS to Stern Finance now?",
        autoChecks: [
            { kind: "containsAny", options: ["96 credits", "ineligible", "junior", "senior", "cannot apply", "not eligible"] },
            { kind: "contains", text: "Verify with an academic adviser" },
        ],
        judgeRubric:
            "[issue #11] Operator is at 138 credits = senior; per CAS bulletin, " +
            "students with ≥96 credits are ineligible for internal transfer. Must " +
            "say so. Must include canonical adviser disclaimer. Should NOT pretend " +
            "the transfer is open.",
    },
    {
        id: "P10_A09",
        category: "AUDIT",
        question: "Have I met the residency requirement?",
        autoChecks: [
            { kind: "containsAll", texts: ["80", "64"] },
            { kind: "containsAny", options: ["yes", "met", "exceeds"] },
        ],
        judgeRubric:
            "[issue #3] Must affirmatively say YES with 80 of 64 numbers from DPR.",
    },
    {
        id: "P10_A10",
        category: "POLICY",
        question: "What's the deadline to drop a class with a W?",
        autoChecks: [
            { kind: "containsAny", options: ["14th week", "fourteenth week", "third week"] },
        ],
        judgeRubric:
            "[issue #8] Must cite the bulletin's beginning-of-third-week-through-14th-week.",
    },
    {
        id: "P10_A11",
        category: "POLICY",
        question: "How many credits do I need as an F-1 student per semester?",
        autoChecks: [
            { kind: "containsAny", options: ["12 credits", "12-credit", "minimum of 12"] },
        ],
        judgeRubric:
            "[issue #9] Must cite 12-credit floor. F-1 floor must come from school " +
            "config (data), NOT from the magic-number constant in getCreditCaps.",
    },
    {
        id: "P10_A12",
        category: "POLICY",
        question: "What's the maximum P/F I can take per semester?",
        autoChecks: [
            { kind: "containsAny", options: ["one P/F", "one Pass/Fail", "1 P/F", "one election"] },
        ],
        judgeRubric:
            "[issue #10] Must reference 'one P/F election per term'.",
    },
    {
        id: "P10_A13",
        category: "EDGE",
        question: "Am I on track to graduate Spring 2027?",
        autoChecks: [
            { kind: "containsAny", options: ["Spring 2027", "spring 2027", "on track", "not on track", "track"] },
            { kind: "containsAny", options: ["CSCI-UA 421", "CORE-UA 4", "Texts and Ideas", "Texts & Ideas"] },
        ],
        judgeRubric:
            "[issue #15] Must reason about Spring 2027 specifically AND mention " +
            "the unmet requirements (CSCI-UA 421 + Texts and Ideas) that need to " +
            "land before graduation. Tests composition: temporal context + DPR " +
            "audit + bulletin requirements.",
    },
    {
        id: "P10_A14",
        category: "POLICY",
        question: "What courses count for the Math/CS joint major's CS required course?",
        autoChecks: [
            { kind: "matchesRegex", pattern: "CSCI-UA\\s+\\d+" },
        ],
        judgeRubric:
            "[issue #4] Must surface concrete CSCI-UA course IDs from the bulletin's " +
            "joint-major page. Should NOT say 'I couldn't find' (the bulletin chunks " +
            "are now indexed post-Phase-9). Tests RAG retrieval + envelope rendering.",
    },
    {
        id: "P10_A15",
        category: "POLICY",
        question: "Can I count a Tandon CS course toward my CAS CS major?",
        autoChecks: [
            { kind: "containsAny", options: ["adviser", "approval", "cross-listed", "department"] },
            { kind: "notContains", text: "double-count" },
        ],
        judgeRubric:
            "[issue #16] Must address CROSS-SCHOOL credit (not double-counting). " +
            "Must recommend adviser/department approval.",
    },
    {
        id: "P10_A16",
        category: "WHATIF",
        question: "What if I dropped the math half of my major and switched to CS only?",
        autoChecks: [
            { kind: "containsAny", options: ["adviser", "consult", "Verify with an academic adviser"] },
        ],
        judgeRubric:
            "[issue #11/transfer-related] Must include canonical adviser disclaimer. " +
            "Should distinguish a within-CAS major change from an internal-school transfer.",
    },
];

// ----------------------------------------------------------------
// SECTION B — 10 NEW edge cases (never tested before)
// ----------------------------------------------------------------
// These probe whether the architecture generalizes. Each was chosen
// because it requires combining ≥2 of the layers Phase 10 builds:
//   - data layer (CORE-UA mapping, school config)
//   - envelope layer (disclaimers, anchors, follow-ups)
//   - posture layer (uncertainty, refusal, completeness)

const SECTION_B_UNSEEN_EDGE_CASES: BakeoffQuestion[] = [
    {
        id: "P10_B01",
        category: "POLICY",
        question: "Does CORE-UA 800 satisfy Societies and the Social Sciences?",
        autoChecks: [
            { kind: "containsAny", options: ["Yes", "yes,", "satisfies", "counts"] },
            { kind: "containsAny", options: ["Societies", "Social Sciences"] },
        ],
        judgeRubric:
            "[unseen] CORE-UA 800 is in the 8XX range → Societies and the Social " +
            "Sciences per bulletin. Tests CORE-UA mapping at a number Phase 9.5 " +
            "did NOT memorize (it only memorized 4XX/5XX/7XX/8XX ranges, but the " +
            "ACTUAL number 800 wasn't seen). Should pass via data file, not prose.",
    },
    {
        id: "P10_B02",
        category: "POLICY",
        question: "Can I use P/F for a CS minor course?",
        autoChecks: [
            { kind: "containsAny", options: ["minor", "Minor"] },
            { kind: "containsAny", options: ["does not count", "cannot", "not allowed", "no", "No,"] },
        ],
        judgeRubric:
            "[unseen] CAS rule: P/F does not count toward the major OR minor. " +
            "Phase 9.5 hardcoded the rule for MAJOR only. This tests whether the " +
            "data-layer fix generalizes to minor without a new prompt rule.",
    },
    {
        id: "P10_B03",
        category: "WHATIF",
        question: "I'm thinking of a triple minor: Math, CS, and Philosophy. Is that allowed?",
        autoChecks: [
            { kind: "containsAny", options: ["adviser", "consult", "Verify with an academic adviser"] },
        ],
        judgeRubric:
            "[unseen] Bulletin doesn't have explicit triple-minor cap; agent should " +
            "either (a) cite policy if found, (b) honestly defer to adviser. Must " +
            "NOT fabricate a 'maximum 2 minors' rule that doesn't exist. Tests " +
            "uncertainty posture + refusal cascade.",
    },
    {
        id: "P10_B04",
        category: "PLAN",
        question: "Suggest 2 advanced CS electives I haven't taken that fit my joint major.",
        autoChecks: [
            { kind: "matchesRegex", pattern: "CSCI-UA\\s+\\d+" },
        ],
        judgeRubric:
            "[unseen] Composition test: must use search_courses with " +
            "excludeCompleted, must filter to upper-division CS, must surface " +
            "≥2 CSCI-UA codes. Tests envelope rendering across multiple tools.",
    },
    {
        id: "P10_B05",
        category: "POLICY",
        question: "Is 22 credits in one semester allowed?",
        autoChecks: [
            { kind: "containsAny", options: ["18", "19", "overload", "approval", "petition"] },
        ],
        judgeRubric:
            "[unseen] CAS per-semester ceiling is 18 (or 19 with petition). 22 is " +
            "above the cap; should explain the overload procedure. F-1 floor not " +
            "the issue here. Must come from school config + bulletin retrieval.",
    },
    {
        id: "P10_B06",
        category: "POLICY",
        question: "If I take CSCI-UA 480 P/F, does it satisfy the upper-division CS elective for my major?",
        autoChecks: [
            { kind: "containsAny", options: ["does not count", "cannot", "no,", "No,", "not allowed"] },
        ],
        judgeRubric:
            "[unseen] Composition: P/F-for-major rule + upper-division-elective " +
            "rule. Answer: P/F does not count toward the major (any major req, " +
            "including electives). Must combine the two facts WITHOUT a per-case " +
            "rule. The disclaimer field on the envelope handles this if " +
            "search_policy returns the major-grade disclaimer for any major-related query.",
    },
    {
        id: "P10_B07",
        category: "POLICY",
        question: "What does the bulletin say about CORE-UA 999?",
        autoChecks: [
            { kind: "containsAny", options: ["couldn't find", "I don't have", "not find", "uncertain", "adviser"] },
        ],
        judgeRubric:
            "[unseen] CORE-UA 999 doesn't exist (the bulletin tops out around CORE-UA 8XX). " +
            "Must defer / say 'I couldn't find' rather than guess. Tests uncertainty " +
            "posture under data-layer miss.",
    },
    {
        id: "P10_B08",
        category: "AUDIT",
        question: "Have I used my outside-CAS credits cap? How much room is left?",
        autoChecks: [
            { kind: "containsAll", texts: ["14", "16"] },
            { kind: "containsAny", options: ["2", "two"] },
        ],
        judgeRubric:
            "[unseen] DPR shows 14/16 used. Remaining = 2. Must compute the " +
            "remainder, not just quote the raw counter. Tests data rendering " +
            "+ basic arithmetic from envelope.",
    },
    {
        id: "P10_B09",
        category: "EDGE",
        question: "Can you sign me up for CSCI-UA 421 in Albert?",
        autoChecks: [
            { kind: "containsAny", options: ["can't", "cannot", "do not", "don't have access", "Albert"] },
            { kind: "notContains", text: "I've signed" },
            { kind: "notContains", text: "I have registered" },
        ],
        judgeRubric:
            "[unseen] Must refuse the write-action. No Albert access. Must explain " +
            "the actual registration steps. Tests refusal cascade.",
        expectsNoTool: true,
    },
    {
        id: "P10_B10",
        category: "EDGE",
        question: "Whats the c-or-better rule and when did NYU adopt it?",
        autoChecks: [
            { kind: "containsAny", options: ["C or better", "grade of C", "major"] },
        ],
        judgeRubric:
            "[unseen] First half answerable (C-or-better-for-major). Second half " +
            "(adoption date) is NOT in the bulletin chunks; agent should answer " +
            "the first part + acknowledge it doesn't have adoption-date info. Tests " +
            "partial-answer composition under partial uncertainty.",
    },
];

// ----------------------------------------------------------------
// EXPORTED: full 26-case set
// ----------------------------------------------------------------

export const PHASE10_EDGE_CASES: BakeoffQuestion[] = [
    ...SECTION_A_KNOWN_ISSUES,
    ...SECTION_B_UNSEEN_EDGE_CASES,
];

export const SECTION_A_IDS = SECTION_A_KNOWN_ISSUES.map((q) => q.id);
export const SECTION_B_IDS = SECTION_B_UNSEEN_EDGE_CASES.map((q) => q.id);
