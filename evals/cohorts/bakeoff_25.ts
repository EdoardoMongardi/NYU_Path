// ============================================================
// Phase 8 Workstream B — 25-question bake-off set
// ============================================================
// 20 questions from the Phase-7E 20-question quality sweep + 5 new
// edge cases (off-domain refusal, multi-intent, typo, follow-up,
// write-action refusal). Each carries deterministic auto-checks
// against the operator's real DPR ground truth so the bake-off
// grader can score correctness without a human in the loop.
//
// Ground truth (Edoardo Mongardi, real SAA_STD_DS.pdf):
//   GPA 3.402, Credits 138/128, Residency 80/64,
//   P/F 4/32, Outside-CAS 14/16, Time limit 8 yrs
//   Currently enrolled (Fall 2026): CORE-UA 700, MATH-UA 251, MATH-UA 343
//   Currently enrolled (Spring 2026 IP): CSCI-UA 4, CSCI-UA 473, MATH-UA 334, MPAJZ-UE 71
//   Unmet: Texts & Ideas (CORE-UA 400-499), CS Required (CSCI-UA 421), CS/Math summary
//   F-1 visa, Spring 2027 grad target
// ============================================================

export interface BakeoffQuestion {
    id: string;
    category: "AUDIT" | "PLAN" | "WHATIF" | "POLICY" | "EDGE";
    question: string;
    /** Deterministic checks. Each returns pass / fail / partial.
     *  The grader applies them to the assistant's final text. */
    autoChecks: AutoCheck[];
    /** Free-form rubric notes the LLM-judge consults to grade
     *  qualitatively. */
    judgeRubric: string;
    /** When set, the question is a follow-up to questionId — the
     *  bake-off runner threads the previous turn's reply as history. */
    followUpTo?: string;
    /** When true, calling ANY tool is a failure mode (off-domain). */
    expectsNoTool?: boolean;
    /** When set, all listed tool names must appear in the invocation
     *  list for the response to be deemed complete. */
    requiresTools?: string[];
}

export type AutoCheck =
    | { kind: "contains"; text: string; mode?: "any" | "all" }
    | { kind: "containsAny"; options: string[] }
    | { kind: "containsAll"; texts: string[] }
    | { kind: "notContains"; text: string }
    | { kind: "matchesRegex"; pattern: string; flags?: string };

// ----------------------------------------------------------------
// Q1-Q20 — original sweep (verbatim wording from prior session)
// ----------------------------------------------------------------

export const BAKEOFF_25: BakeoffQuestion[] = [
    {
        id: "Q01", category: "AUDIT", question: "What's my GPA?",
        autoChecks: [{ kind: "contains", text: "3.402" }],
        judgeRubric: "Must cite '3.402' verbatim AND attribute to the DPR/audit. No rounding ('3.4', 'around 3.4').",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "Q02", category: "AUDIT", question: "How many credits do I have?",
        autoChecks: [{ kind: "containsAll", texts: ["138", "128"] }],
        judgeRubric: "Must cite '138 credits' AND '128 required'. Should attribute to DPR.",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "Q03", category: "AUDIT", question: "What requirements am I still missing?",
        autoChecks: [
            { kind: "containsAny", options: ["Texts & Ideas", "Texts and Ideas", "CORE-UA 400"] },
            { kind: "containsAny", options: ["CSCI-UA 421", "Computer Science: Required", "Numerical Computing"] },
        ],
        judgeRubric: "Must list AT LEAST: (a) Texts & Ideas (CORE-UA 400-499) and (b) CS Required Course (CSCI-UA 421). May also mention CS/Math joint major summary. Texts & Ideas should appear ONCE not twice (B5 dedup).",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "Q04", category: "AUDIT", question: "How many P/F credits have I used? What's the cap?",
        autoChecks: [{ kind: "containsAll", texts: ["4", "32"] }],
        judgeRubric: "Must answer BOTH parts of the question: 'used 4' AND 'cap 32'. Should cite DPR for the '4'. Bonus if it adds the bulletin context (one election per term, etc.).",
    },
    {
        id: "Q05", category: "AUDIT", question: "Am I in good academic standing?",
        autoChecks: [
            { kind: "containsAny", options: ["good standing", "good_standing", "in good"] },
            { kind: "contains", text: "3.402" },
        ],
        judgeRubric: "Must explicitly say 'good standing' AND cite the GPA basis (3.402 ≥ 2.0).",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "Q06", category: "AUDIT", question: "Have I met the residency requirement?",
        autoChecks: [
            { kind: "containsAll", texts: ["80", "64"] },
            { kind: "containsAny", options: ["yes", "met", "exceeds"] },
        ],
        judgeRubric: "Must answer YES with the specific numbers (80 of 64 met). NOT just bulletin verbatim.",
    },
    {
        id: "Q07", category: "AUDIT", question: "How many outside-CAS credits have I used?",
        autoChecks: [{ kind: "containsAll", texts: ["14", "16"] }],
        judgeRubric: "Must cite '14 of 16'. Source = DPR.",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "Q08", category: "AUDIT", question: "Am I currently enrolled in any classes?",
        autoChecks: [
            { kind: "containsAny", options: ["yes", "Yes", "currently enrolled", "in progress"] },
            { kind: "containsAny", options: ["CORE-UA 700", "MATH-UA 251", "MATH-UA 343"] },
        ],
        judgeRubric: "Must say YES and name at least 2 of the Fall 2026 in-progress courses. Pre-Phase-8 said 'audit doesn't list them' — that's a fail.",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "Q09", category: "PLAN", question: "What should I take next semester?",
        autoChecks: [
            { kind: "containsAny", options: ["Spring 2027", "spring 2027"] },
            { kind: "contains", text: "CSCI-UA 421" },
            { kind: "containsAny", options: ["CORE-UA 4", "Texts & Ideas", "Texts and Ideas"] },
        ],
        judgeRubric: "Must label the term as Spring 2027 (NOT Fall 2024 or guessed year), recommend CSCI-UA 421, recommend a CORE-UA 400-level for Texts & Ideas. Bonus: F-1 12-credit floor mentioned.",
    },
    {
        id: "Q10", category: "PLAN", question: "What math classes am I currently registered for?",
        autoChecks: [
            { kind: "contains", text: "MATH-UA 251" },
            { kind: "contains", text: "MATH-UA 343" },
        ],
        judgeRubric: "Must name BOTH MATH-UA 251 AND MATH-UA 343 (currently enrolled Fall 2026). May also mention MATH-UA 334 (Spring 2026 IP).",
        requiresTools: ["run_full_audit"],
    },
    {
        id: "Q11", category: "PLAN", question: "Suggest a CS elective I haven't taken yet.",
        autoChecks: [
            { kind: "matchesRegex", pattern: "CSCI-UA\\s+\\d+" },
            { kind: "notContains", text: "CORE-UA 400" },
        ],
        judgeRubric: "Must suggest at least one CSCI-UA course code. Pre-Phase-8 suggested CORE-UA 400 (totally wrong). Bonus if the suggested course is reasonable (e.g., CSCI-UA 467 OS, CSCI-UA 472 ML).",
    },
    {
        id: "Q12", category: "WHATIF", question: "What if I add an Economics minor?",
        autoChecks: [
            { kind: "contains", text: "Verify with an academic adviser" },
        ],
        judgeRubric: "Must include the canonical §6.4 disclaimer 'Verify with an academic adviser before applying for an internal transfer or program change' (verbatim or close paraphrase). Should be honest about lacking structured rules.",
    },
    {
        id: "Q13", category: "WHATIF", question: "What if I switched my major to just Computer Science instead of CS/Math?",
        autoChecks: [
            { kind: "containsAny", options: ["Verify with an academic adviser", "consult an academic adviser"] },
        ],
        judgeRubric: "Must cite disclaimer; bonus for noting that within-CAS major change is not an internal-school transfer.",
    },
    {
        id: "Q14", category: "WHATIF", question: "Could I graduate one semester early, in Fall 2026?",
        autoChecks: [
            { kind: "containsAll", texts: ["Fall 2026"] },
            { kind: "contains", text: "CSCI-UA 421" },
        ],
        judgeRubric: "Must reason about Fall 2026 specifically. Bonus for recognizing Fall 2026 IS the current term and reasoning about whether currently-enrolled courses (CORE-UA 700 etc.) satisfy the unmet reqs (they don't — CORE-UA 700 doesn't satisfy 400-499 Texts & Ideas).",
    },
    {
        id: "Q15", category: "WHATIF", question: "What if I took CSCI-UA 421 in the summer instead of spring?",
        autoChecks: [
            { kind: "notContains", text: "did not find an exact match" },
            { kind: "notContains", text: "I couldn't find" },
        ],
        judgeRubric: "Must NOT claim CSCI-UA 421 doesn't exist (it does — it's in the catalog after Phase-8 A5 fix). Should reason about summer enrollment + canonical disclaimer.",
    },
    {
        id: "Q16", category: "POLICY", question: "What's the deadline to drop a class with a W?",
        autoChecks: [
            { kind: "containsAny", options: ["14th week", "fourteenth week", "third week"] },
        ],
        judgeRubric: "Must mention the bulletin's 'beginning of the third week through the 14th week' (or close paraphrase). Bonus: F-1 dropping-below-12 caveat.",
    },
    {
        id: "Q17", category: "POLICY", question: "How many credits do I need as an F-1 student per semester?",
        autoChecks: [{ kind: "containsAny", options: ["12 credits", "12-credit", "minimum of 12"] }],
        judgeRubric: "Must cite '12 credits' as the F-1 full-time floor. Bonus: OGS / RCL guidance.",
    },
    {
        id: "Q18", category: "POLICY", question: "What's the maximum P/F I can take per semester?",
        autoChecks: [
            { kind: "containsAny", options: ["one P/F", "one Pass/Fail", "1 P/F", "one election"] },
        ],
        judgeRubric: "Must reference 'one P/F election per term' (per CAS bulletin). Pre-Phase-8 said 'no per-semester max exists' — wrong. Honest 'I couldn't find' is acceptable but worse than the bulletin truth.",
    },
    {
        id: "Q19", category: "POLICY", question: "Can I count a Tandon CS course toward my CAS CS major?",
        autoChecks: [
            { kind: "containsAny", options: ["adviser", "approval", "cross-listed", "department"] },
            { kind: "notContains", text: "double-count" },
        ],
        judgeRubric: "Must address CROSS-SCHOOL credit policy (not double-counting between two majors). Should recommend adviser/department approval. Pre-Phase-8 hit cas_double_counting template — wrong question.",
    },
    {
        id: "Q20", category: "POLICY", question: "Can I take a course at NYU Florence as part of my degree?",
        autoChecks: [
            { kind: "containsAny", options: ["adviser", "couldn't find", "I don't have", "study-abroad", "study abroad"] },
        ],
        judgeRubric: "Acceptable answers: (a) honest refusal + adviser referral, (b) any policy retrieved about study-abroad / global-network sites. Must NOT fabricate specific NYU Florence rules.",
    },

    // ----------------------------------------------------------------
    // Q21-Q25 — new edge cases (Phase 8 expansion)
    // ----------------------------------------------------------------

    {
        id: "Q21", category: "EDGE", question: "What's the weather like in NYC today?",
        autoChecks: [
            { kind: "containsAny", options: ["academic", "advising", "I'm an", "course planning", "NYU"] },
            { kind: "notContains", text: "70" }, // no fabricated temperature
        ],
        judgeRubric: "Must politely refuse — this is NOT in NYU Path's domain. Should redirect to academic topics. Should NOT call any academic tool. Should NOT fabricate weather.",
        expectsNoTool: true,
    },
    {
        id: "Q22", category: "EDGE", question: "What's my GPA and can I add a Math minor?",
        autoChecks: [
            { kind: "contains", text: "3.402" },
            { kind: "containsAny", options: ["Verify with an academic adviser", "consult", "adviser"] },
        ],
        judgeRubric: "Must answer BOTH parts: (a) GPA from DPR (3.402), (b) Math minor what-if with disclaimer. Multi-intent: should call run_full_audit AND what_if_audit.",
    },
    {
        id: "Q23", category: "EDGE", question: "whts the dropp dedline",
        autoChecks: [
            { kind: "containsAny", options: ["drop", "withdraw", "14th week", "third week"] },
        ],
        judgeRubric: "Must understand the typo and answer the drop-deadline question (same as Q16). Should NOT bounce 'I don't understand'.",
    },
    {
        id: "Q24", category: "EDGE", question: "and what about for an F-1 student?",
        followUpTo: "Q23",
        autoChecks: [
            { kind: "containsAny", options: ["12 credits", "F-1", "OGS", "full-time", "visa"] },
        ],
        judgeRubric: "Must use the prior turn's context (drop-deadline) AND apply F-1-specific caveats (drop below 12 credits affects visa). Tests context retention across turns.",
    },
    {
        id: "Q25", category: "EDGE", question: "Can you change my major to Stern Finance for me?",
        autoChecks: [
            { kind: "containsAny", options: ["can't", "cannot", "do not", "don't have access", "Albert", "adviser"] },
            { kind: "notContains", text: "I've changed" },
            { kind: "notContains", text: "I have updated" },
        ],
        judgeRubric: "Must refuse the write-action politely (no Albert access; can't modify NYU records). Should explain HOW to actually change major (advising appointment, application, etc.). Should NOT pretend to have done it.",
    },
];
