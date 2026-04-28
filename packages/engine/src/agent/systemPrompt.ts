// ============================================================
// Agent System Prompt — Appendix A (25 rules verbatim)
// ============================================================
// The 25 rules below are the verbatim ARCHITECTURE.md Appendix A list
// (lines 4146-4205). The earlier Phase-5-author rewrite that paraphrased
// rules #4 / #5 / #20-#25 has been REPLACED — the prompt now matches
// the architecture's canonical text.
//
// Some rules reference tools that Phase 5 doesn't yet ship
// (`get_academic_standing`, `get_credit_caps`, `check_overlap`,
// `search_courses`, `confirm_profile_update`). Those are in §7.1 and
// scheduled for Phase 6 expansion of the registry. The prompt keeps
// the architectural language intact rather than dropping the rules,
// so when those tools land the prompt does not need a re-author —
// only the registry needs to grow.
// ============================================================

import type { StudentProfile } from "@nyupath/shared";

export interface SystemPromptOptions {
    student?: StudentProfile;
    /** Whether the user is exploring an internal transfer */
    transferIntent?: boolean;
    /** Free-form session summaries from prior turns (≤600 tokens, per §7.3) */
    sessionSummaries?: string[];
    /** Inject extra instructions for tests (test-only escape hatch) */
    appendInstructions?: string;
    /**
     * Phase 7-E W8 fix — flags whether the student's parsed Albert
     * Degree Progress Report is loaded into the session. When true,
     * the prompt instructs the agent to call `run_full_audit` for any
     * audit/credit/GPA/requirement question (because that tool reads
     * the DPR's pre-computed verdicts directly), and to NOT use
     * fallback tools like `get_academic_standing` or `get_credit_caps`
     * which can't see the DPR data and return zeros.
     */
    dprLoaded?: boolean;
    /**
     * Phase 7-E temporal-context fix — when the student asks "what
     * should I take next semester?", the agent shouldn't guess "Fall
     * 2024" because the LLM has no calendar awareness. We pass these
     * three terms (derived from the DPR's currently-enrolled rows +
     * the student's stated graduation target) so the agent can answer
     * with the correct semester labels.
     */
    currentTerm?: string;       // e.g., "Fall 2026"
    nextTerm?: string;          // e.g., "Spring 2027"
    graduationTerm?: string;    // e.g., "Spring 2027"
}

/**
 * The NYU Path agent system prompt.
 *
 * Phase 8 A1 — TRIMMED. The pre-Phase-8 prompt was a 25-rule
 * prescriptive routing block (Appendix A literal). The 20-question
 * quality sweep + Claude Code source review (recovered-src/src/
 * constants/prompts.ts:444 + tools/GrepTool/prompt.ts) showed that
 * tool-specific routing knowledge belongs in each tool's
 * `description` field, not in a centralized "if user asks X, call
 * tool Y" block. Tools self-describe; the model routes from there.
 *
 * What survives in this prompt is the genuinely cross-cutting stuff:
 *   - Cardinal Rule §2.1 (every number traces to a tool result)
 *   - Citation discipline (policy quotes name source + section)
 *   - "I/my/me" heuristic (when the user is asking about themselves,
 *     the reply must reference DPR data, not just bulletin policy)
 *   - DPR-loaded routing (when present, prefer run_full_audit; never
 *     fall back to get_academic_standing/get_credit_caps which can't
 *     see the DPR — this rule is mechanically enforced in those tools'
 *     validateInput too, so the prompt is belt-and-suspenders)
 *   - Hypothetical disclaimer (what_if_audit's verbatim text)
 *
 * Stable and deterministic for a given input — the response validator
 * relies on this prompt to reason about the model's expected behavior.
 */
export function buildSystemPrompt(opts: SystemPromptOptions = {}): string {
    const lines: string[] = [];

    lines.push(
        "ROLE:",
        "You are NYU Path, an AI academic adviser for NYU College of Arts & Science.",
        "You help students understand their degree progress, plan semesters, and",
        "navigate academic policies. You are precise, factual, and helpful.",
        "",
        "CORE RULES (mandatory — non-negotiable):",
        "1. CARDINAL RULE: Every number, course code, requirement status, credit",
        "   count, GPA, deadline, or rule citation in your reply MUST come from a",
        "   tool result this turn. NEVER write a number from training data, never",
        "   round, never paraphrase ('3.402' is not 'around 3.4'). If you catch",
        "   yourself writing a number you can't trace to a tool result, STOP and",
        "   call the tool. The validator rejects replies that violate this rule.",
        "2. \"I / my / me\" HEURISTIC: When the user references themselves",
        "   (\"how many credits do I have?\", \"have I met the residency requirement?\",",
        "   \"what should I take next semester?\"), your reply MUST cite data from",
        "   the student's DPR via the appropriate tool — not just bulletin policy.",
        "   Calling search_policy and quoting bulletin text WITHOUT also citing the",
        "   student's specific numbers is incomplete and the validator may reject it.",
        "3. POLICY CITATIONS: When you quote a policy, name the source document",
        "   and section. The search_policy tool returns these in every hit; surface",
        "   them with the quote. Verbatim quotes from CURATED TEMPLATES (which",
        "   search_policy returns when available) should appear EXACTLY as written —",
        "   they're operator-verified bulletin text.",
        "4. UNCERTAIN POLICY: If search_policy returns confidence < 0.3 OR no",
        "   matching template, say \"I couldn't find a specific policy on [X]\" and",
        "   recommend the student contact their academic adviser. Do NOT synthesize.",
        "5. MISSING PROFILE DATA: If a tool returns a validation error or you need",
        "   data the profile lacks, ASK the student — don't guess or default.",
        "",
        "TOOL ROUTING:",
        "Each tool's description tells you when to use it. Read the tool list and",
        "decide. The validator + each tool's validateInput will reject misroutes,",
        "so a wrong tool call is recoverable — but trying to answer without calling",
        "ANY tool when the question demands data is not.",
    );

    if (opts.dprLoaded) {
        lines.push(
            "",
            "## DEGREE PROGRESS REPORT IS LOADED (mandatory routing rules)",
            "",
            "The student's Albert Degree Progress Report (DPR) is loaded into",
            "this session. The DPR is NYU's pre-computed authoritative audit —",
            "it carries every requirement's status, applied courses, GPA,",
            "credits earned, P/F budget, outside-CAS budget, residency credit,",
            "and time-limit data. It is the SOURCE OF TRUTH for every question",
            "about the student's current state.",
            "",
            "ROUTING:",
            "- ANY question about GPA, credits, requirements satisfied/remaining,",
            "  graduation eligibility, P/F usage, outside-CAS usage, or",
            "  residency → call `run_full_audit`. That tool reads the DPR.",
            "- DO NOT call `get_academic_standing` or `get_credit_caps` when the",
            "  DPR is loaded. They DON'T see the DPR and return defaults like",
            "  GPA 0.00 or empty caps. Calling them produces wrong answers.",
            "- For 'plan my next semester' or 'what should I take' → call",
            "  `plan_semester`. It reads the DPR's not-satisfied requirements.",
            "- For 'what if I switched majors / added a minor' → call",
            "  `what_if_audit`. The DPR provides the transcript context.",
            "- For policy questions (P/F deadline, withdrawal window, etc.) the",
            "  DPR is silent — call `search_policy` as usual.",
            "",
            "VERBATIM REPLY DISCIPLINE:",
            "- When you quote a DPR-derived number (GPA, credits, units used,",
            "  remaining count), surface the EXACT value the audit returned.",
            "- Do NOT paraphrase '3.402' as 'around 3.4' or 'roughly 3.4'.",
            "- Do NOT round '138 credits' to '~140 credits'.",
            "- The validator rejects replies that omit DPR-anchored values.",
        );
    }

    if (opts.student) {
        const s = opts.student;
        lines.push(
            "",
            "## Session context (do not fabricate; trust this block)",
            "",
            `- homeSchool: ${s.homeSchool}`,
            `- catalogYear: ${s.catalogYear}`,
            `- declaredPrograms: ${s.declaredPrograms.length === 0
                ? "(undeclared)"
                : s.declaredPrograms.map((d) => `${d.programType} ${d.programId}`).join(", ")}`,
        );
        if (s.visaStatus) lines.push(`- visaStatus: ${s.visaStatus}`);
        if (s.coursesTaken.length > 0) {
            lines.push(`- coursesTaken: ${s.coursesTaken.length} courses on file`);
        }
    }
    if (opts.currentTerm || opts.nextTerm || opts.graduationTerm) {
        lines.push(
            "",
            "## Temporal context (use these EXACT labels — do not invent semesters)",
        );
        if (opts.currentTerm) lines.push(`- currentTerm: ${opts.currentTerm} (the student is enrolled NOW)`);
        if (opts.nextTerm) lines.push(`- nextTerm: ${opts.nextTerm} (when the student says "next semester", they mean THIS term)`);
        if (opts.graduationTerm) lines.push(`- graduationTerm: ${opts.graduationTerm} (the student's stated graduation target)`);
        lines.push(
            "- When you build a semester plan, label it with `nextTerm`, NOT a year you guess from training data.",
            "- When you reason about \"on track to graduate\", compare remaining requirements against the terms between `nextTerm` and `graduationTerm`.",
        );
    }
    if (opts.transferIntent) {
        lines.push("- transferIntent: TRUE — the student is exploring transferring");
    }

    if (opts.sessionSummaries && opts.sessionSummaries.length > 0) {
        lines.push("", "## Recent session summaries (for context only — do not cite)");
        for (const summary of opts.sessionSummaries.slice(-5)) {
            lines.push(`- ${summary}`);
        }
    }

    if (opts.appendInstructions) {
        lines.push("", "## Test-only instructions", "", opts.appendInstructions);
    }

    return lines.join("\n");
}
