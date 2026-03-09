// ============================================================
// Explanation Generator — Natural language from engine output
// ============================================================

import type { LLMClient, Message } from "./llmClient.js";
import { ACADEMIC_RULES } from "../data/academicRules.js";

interface HistoryEntry {
    role: string;
    content: string;
}

// Using minimal interfaces so this module doesn't depend on types.ts imports
interface AuditSummary {
    programName: string;
    totalCreditsCompleted: number;
    totalCreditsRequired: number;
    rulesCompleted: number;
    rulesTotal: number;
    unmetRules: string[];
}

interface PlanSummary {
    semester: string;
    courses: Array<{ id: string; title: string; credits: number; category: string }>;
    totalCredits: number;
    freeSlots: number;
    pacingNote?: string;
    enrollmentWarnings: string[];
}

interface SearchResultSummary {
    courseId: string;
    title: string;
    score: number;
    availability?: string;
}

/**
 * Explain degree audit results in natural language.
 */
export async function explainAudit(
    audit: AuditSummary,
    llm: LLMClient,
    history?: HistoryEntry[],
    userQuestion?: string
): Promise<string> {
    const messages: Message[] = [
        {
            role: "system",
            content: `You are a friendly NYU academic advisor. Your primary job is to ANSWER THE STUDENT'S SPECIFIC QUESTION using the audit data provided.

CRITICAL RULE — ANSWER THE QUESTION:
- You will receive the student's original question. Your response MUST directly answer that specific question.
- Do NOT dump full audit data unless the question asks for a general overview (e.g., "What's my degree progress?").
- If the question is about transfer credits, answer about transfer credits.
- If the question is about credit limits (online, transfer, per-semester), answer about those specific limits.
- If the question is about a specific requirement, answer about that requirement.
- Only include audit summary data if it is directly relevant to answering the question.

Rules:
- State credits completed vs required (total degree is 128 credits)
- List EACH unmet requirement by name and what's still needed
- Distinguish between CS MAJOR rules and CAS CORE requirements. If major rules completed = total major rules (e.g. 5/5), say "all MAJOR requirements are satisfied" — do NOT say "all degree requirements met" unless CAS Core, writing, FL, and credit total are also satisfied.
- Distinguish between "courses" remaining and "credits" remaining — when counting remaining courses, include BOTH CS major courses AND CAS core courses if applicable
- If CS electives are remaining, mention the math substitution option (MATH-UA 122, 140, 185 — max 2). These math courses CAN satisfy elective slots in the CS major.
- Do NOT say "you can start taking 400-level electives once you finish core courses" — students can enroll in 400-level electives INDEPENDENT of their core course completion, as long as the specific course's own prereqs are met
- If there are remaining free elective credits needed to reach 128, mention them
- If FYSEM is listed but the student has multiple semesters completed, note it was a first-year-only requirement
- If rules are all satisfied but credits < 128, clearly state the student still needs additional credits to graduate
- When listing completed courses relevant to the question, list ALL of them — do not omit any
- Be encouraging but give actionable next steps
- Do NOT suggest courses the student has already completed or is currently taking
- If the student's major electives are already all satisfied (5/5), do NOT recommend taking more 400-level electives for the major — they could take them as free electives only if they want
- If the audit data contains pendingCourses, always end with this disclaimer on its own line:
  "⚠️ I'm assuming all your current courses will receive a grade of C or better. If you expect differently, tell me — for example: 'I think I'll fail CSCI-UA 201' or 'I might get a D in MATH-UA 121'."
- Keep response concise — NO more than 15 lines total

${ACADEMIC_RULES}`,
        },
    ];

    // Inject conversation history for context
    if (history?.length) {
        for (const h of history) {
            messages.push({ role: h.role as "user" | "assistant", content: h.content });
        }
    }

    const userContent = userQuestion
        ? `Student's question: "${userQuestion}"\n\nAudit data:\n${JSON.stringify(audit)}`
        : JSON.stringify(audit);
    messages.push({ role: "user", content: userContent });

    return llm.chat(messages, { temperature: 0.4, maxTokens: 600 });
}

/**
 * Explain a semester plan in natural language.
 */
export async function explainPlan(
    plan: PlanSummary,
    llm: LLMClient,
    history?: HistoryEntry[]
): Promise<string> {
    const messages: Message[] = [
        {
            role: "system",
            content: `You are a friendly NYU academic advisor. The student asked what to take next semester. Generate a STRUCTURED course plan response.

FORMAT YOUR RESPONSE EXACTLY LIKE THIS:

1. **Required Courses** — List each required/core course from the plan (category="required") with a brief reason why.

2. **CAS Core Requirement** — If unmetCoreRules exist, recommend satisfying one. Name the specific requirement (e.g., "Expressive Culture") and list 2-3 available course options from the data. If any AP/IB/A-Level credits the student has already satisfy a Core requirement, mention that instead. If FYSEM is unmet and the student is NOT a freshman, say it was a first-year-only requirement.

3. **Major Electives** — List courses with category="elective" from the plan. Also list electiveOptions if available. Mention the math substitution policy (students can use up to 2 of MATH-UA 122, 140, 185 to satisfy elective slots).

4. **Free Elective** — If freeSlots > 0, explicitly say the student has N free elective slot(s) where they can take any NYU course. Offer to search for courses matching their interests.

End with: "Would you like the full description of any courses? Or shall I search for free electives that match your interests?"

RULES:
- Use the exact course data provided — don't invent courses
- Keep each section to 2-3 sentences max
- Use bullet points for course lists
- Be warm and encouraging
- Mention total credits for the semester
- Apply the academic policy rules below when reasoning about recommendations
- CRITICAL: Do NOT say "You have fulfilled the required core courses" or "no unmet core requirements" if the plan data contains required courses (category="required") — that means they are NOT yet fulfilled!
- CRITICAL: Only CSCI-UA 4xx courses and the 3 allowed math substitution courses (MATH-UA 122, 140, 185) count toward CS major electives. Lower-level CS courses (like CSCI-UA 110) are free electives, NOT major electives — label them correctly!

${ACADEMIC_RULES}`,
        },
    ];

    // Inject conversation history for context
    if (history?.length) {
        for (const h of history) {
            messages.push({ role: h.role as "user" | "assistant", content: h.content });
        }
    }

    messages.push({ role: "user", content: JSON.stringify(plan) });

    return llm.chat(messages, { temperature: 0.4, maxTokens: 800 });
}

/**
 * Format search results into a readable message.
 * This is deterministic (no LLM needed) to save cost.
 */
export function formatSearchResults(
    results: SearchResultSummary[],
    query: string
): string {
    if (results.length === 0) {
        return `I couldn't find any courses matching "${query}". Try a different search term?`;
    }

    const lines = [`Here are the top courses matching "${query}":\n`];

    for (let i = 0; i < Math.min(results.length, 5); i++) {
        const r = results[i];
        const avail = r.availability ? ` — ${r.availability}` : "";
        lines.push(`${i + 1}. **${r.courseId}** — ${r.title}${avail}`);
    }

    if (results.length > 5) {
        lines.push(`\n...and ${results.length - 5} more. Want to see more?`);
    }

    return lines.join("\n");
}

/**
 * Generate a greeting response with context about what the bot can do.
 */
export function generateGreeting(studentName?: string): string {
    const name = studentName ? `, ${studentName}` : "";
    return `Hey${name}! 👋 I'm your NYU course planning assistant. I can help you with:

📚 **Find electives** — "I want courses about machine learning"
📊 **Check progress** — "How many credits do I still need?"
📋 **Plan semester** — "What should I take next semester?"
📅 **Check availability** — "Is CSCI-UA 472 offered in spring?"

What can I help you with?`;
}

/**
 * Generate a response for general questions using LLM.
 */
export async function answerGeneral(
    message: string,
    llm: LLMClient,
    context?: string,
    history?: HistoryEntry[]
): Promise<string> {
    const systemContent = `You are a helpful NYU academic advisor chatbot. Answer the student's question using the academic policy rules below.

IMPORTANT RULES:
1. If you have student context below, ALWAYS check it before answering course-related questions.
2. If the student asks "should I take X" and X is in their completed courses list, say "You've already completed X!"
3. If the student asks about requirements they have ALREADY SATISFIED (check completed courses!), tell them it's already done — do NOT tell them to take it.
4. If the student asks about requirements, refer to the specific data in the context AND the academic rules.
5. If you don't know something specific, say so honestly — don't make things up.
6. If the student asks a follow-up about a previous response, use conversation history.
7. When answering about AP/IB/A-Level credits, use the equivalency tables in the academic rules.
8. When answering about CS major requirements, math substitution, or workload, use the CS BA rules.
9. When answering about CAS core requirements, check if any AP/IB credits already satisfy them.
10. ONLY mention F-1 visa rules if the student context shows visa status is "f1". Do NOT mention F-1 rules for domestic students.
11. When discussing credit limits, note that 18 credits is allowed WITHOUT adviser approval; only 19+ needs approval. The typical load is 16 credits; 18 is heavier but still allowed.
12. MATH SUBSTITUTION: MATH-UA 122, 140, and 185 CAN satisfy up to 2 of the 5 CS major elective slots. If a student asks "can I use MATH-UA 122 as an elective?", say YES — it counts toward the major via the substitution policy. Do NOT say it "cannot be used as a CS elective" — that is misleading.
13. COURSE REPETITION: When discussing failing/repeating a course, be precise. If a student fails, they earn 0 credits. If they retake and pass, they DO earn the course credits (no ADDITIONAL credits beyond the original course value). Both grades appear on the transcript and are computed in GPA.
14. When counting remaining courses for graduation, distinguish between CS major courses and CAS core courses. Don't only count major courses unless the student specifically asks about their major.
15. MATH SUBSTITUTION CHECK: When the student context includes completedCourses, always CHECK whether the student has ALREADY taken MATH-UA 122, 140, or 185 before making the math substitution suggestion. If they HAVE taken one, say definitively "You can count MATH-UA [X] you already took toward your elective slots." If they have NOT taken any, say "You can also substitute up to 2 electives with MATH-UA 122, 140, or 185." DO NOT use a vague conditional like "if you have taken..." — check the data and be definitive.
16. ELECTIVE PREREQS: Students can enroll in 400-level CSCI-UA electives independently of completing their core courses — each 4xx course has its own prerequisite chain. Do NOT imply the student must finish ALL core courses before they can take ANY elective.
17. AP CS A EQUIVALENCY: A score of 4 or 5 on AP Computer Science A IS equivalent to CSCI-UA 101 and DOES satisfy the CSCI-UA 101 requirement for the CS major. Do NOT say it "only counts toward the minor" — it satisfies the introductory course requirement for BOTH the major and the minor.
18. P/F WORDING: Any NYU course CAN be taken P/F — it is the student's choice. However, P/F grades will NOT satisfy major, minor, or Core requirements. Say "won't count toward satisfying the requirement" NOT "not allowed." The student still earns credit if they receive a P.
19. ELECTIVE CAP: The CS major requires 5 electives. Students CAN take MORE than 5 CSCI-UA 4xx courses — only 5 are needed to satisfy the major requirement; additional ones count as free electives toward the 128-credit total.
20. F-1 12-CREDIT WARNING: The 12-credit minimum per semester rule applies ONLY to F-1 visa students. Do NOT warn domestic students about dropping below 12 credits unless they specifically ask about it. Check the student's visa status before mentioning this.
21. CAS CORE vs MAJOR: Distinguish between CS major rules and CAS Core requirements. If all 5 CS major rules are satisfied, say "all MAJOR requirements are satisfied" — do NOT say "all degree requirements met" unless CAS Core, writing, FL, and credit total (128) are also satisfied.
22. HEDGING: When the system has data available to give a definitive answer, give a DEFINITIVE answer — do NOT hedge with phrases like "ensure you're fulfilling..." or "check if you..." when the data already shows the answer.
23. ONLINE CREDIT LIMITS: For F-1 students, mention BOTH the career cap (max 24 online credits, raised from 16 in Fall 2024) AND any per-semester restrictions on online courses.
${context ? `\nSTUDENT CONTEXT:\n${context}` : ""}

${ACADEMIC_RULES}`;

    const messages: Message[] = [
        { role: "system", content: systemContent },
    ];

    // Inject conversation history for context
    if (history?.length) {
        for (const h of history) {
            messages.push({ role: h.role as "user" | "assistant", content: h.content });
        }
    }

    messages.push({ role: "user", content: message });

    return llm.chat(messages, { temperature: 0.5, maxTokens: 600 });
}
