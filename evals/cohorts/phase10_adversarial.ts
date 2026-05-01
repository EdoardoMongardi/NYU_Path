// ============================================================
// Phase 10 Stage 5 — adversarial generalization probes
// ============================================================
// 5 cases written AFTER Stage 4 settled, designed to probe whether
// the architecture (data → envelope → posture) generalizes WITHOUT
// any prompt edits we wrote with the case in mind.
//
// Each case must pass on the winning architecture. Failures should
// trace to a missing data file (Layer 1 gap), a missing envelope
// field (Layer 2 gap), or a posture rule that didn't fire (Layer 3
// gap) — never "the prompt didn't include this case."
// ============================================================

import type { BakeoffQuestion } from "./bakeoff_25.js";

export const PHASE10_ADVERSARIAL: BakeoffQuestion[] = [
    {
        id: "P10_ADV01",
        category: "POLICY",
        question: "Does CGA-UA 130 satisfy any College Core requirement?",
        autoChecks: [
            { kind: "containsAny", options: ["couldn't find", "I don't have", "not find", "uncertain", "adviser", "CORE-UA", "Core Curriculum"] },
        ],
        judgeRubric:
            "[adversarial — unseen prefix] CGA-UA isn't a CORE-UA prefix. Agent " +
            "should either (a) recognize it doesn't fall in the CORE-UA range " +
            "mapping, or (b) defer honestly. Must NOT fabricate a 'CGA-UA satisfies " +
            "Texts and Ideas' rule. Tests data-layer + uncertainty posture.",
    },
    {
        id: "P10_ADV02",
        category: "POLICY",
        question: "Is there a way to use P/F for the CAS expository writing requirement?",
        autoChecks: [
            { kind: "containsAny", options: ["P/F", "Pass/Fail", "writing", "expository"] },
        ],
        judgeRubric:
            "[adversarial — composition: P/F + non-major requirement] CAS expository " +
            "writing is part of the College Core. P/F restrictions for the College " +
            "Core differ from P/F-for-major. Agent should retrieve the policy and " +
            "answer based on what RAG returns, not the major-disclaimer that's " +
            "wired for major requirements. Tests envelope context-awareness.",
    },
    {
        id: "P10_ADV03",
        category: "WHATIF",
        question: "If I retake CSCI-UA 421, does the better grade replace the old one in my GPA?",
        autoChecks: [
            { kind: "containsAny", options: ["repeat", "retake", "average", "both grades", "policy", "adviser"] },
        ],
        judgeRubric:
            "[adversarial — unseen policy area] Course-repeat policy. Agent should " +
            "search_policy for it and answer based on what RAG returns. Must NOT " +
            "fabricate a 'better-grade-replaces' rule from training data — that's " +
            "common at other US universities, not necessarily NYU/CAS. Tests " +
            "anti-fabrication posture under unseen policy area.",
    },
    {
        id: "P10_ADV04",
        category: "EDGE",
        question: "Does my dual-degree status change my credit cap?",
        autoChecks: [
            { kind: "containsAny", options: ["dual", "no dual", "second degree", "adviser", "couldn't find", "I don't have"] },
        ],
        judgeRubric:
            "[adversarial — unseen status] Operator is NOT a dual-degree student. " +
            "Agent should either (a) ask the student to confirm dual-degree status " +
            "before answering, or (b) defer to adviser. Must NOT fabricate a dual-" +
            "degree credit-cap rule. Tests profile-vs-question consistency.",
    },
    {
        id: "P10_ADV05",
        category: "POLICY",
        question: "How does NYU define 'satisfactory academic progress' for financial aid?",
        autoChecks: [
            { kind: "containsAny", options: ["financial aid", "SAP", "satisfactory", "adviser", "couldn't find", "office"] },
            { kind: "notContains", text: "67%" }, // common training-data answer that may not match NYU's actual rule
        ],
        judgeRubric:
            "[adversarial — out-of-scope-ish] Financial aid SAP isn't in our " +
            "academic-policy RAG corpus (it's a financial aid office topic). Agent " +
            "should defer or admit it can't verify. Must NOT fabricate a '67% pace' " +
            "or '2.0 GPA' rule from training data.",
    },
];
