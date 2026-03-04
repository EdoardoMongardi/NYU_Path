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
    history?: HistoryEntry[]
): Promise<string> {
    const messages: Message[] = [
        {
            role: "system",
            content: `You are a friendly NYU academic advisor. Explain the student's degree progress clearly and specifically.

Rules:
- State credits completed vs required (total degree is 128 credits)
- List EACH unmet requirement by name and what's still needed
- Distinguish between "courses" remaining and "credits" remaining
- If CS electives are remaining, mention the math substitution option (MATH-UA 122, 140, 185 — max 2)
- If there are remaining free elective credits needed to reach 128, mention them
- If FYSEM is listed but the student has multiple semesters completed, note it was a first-year-only requirement
- If they ask about specific requirements (like CAS core, CS electives), answer with specifics from the data
- Be encouraging but give actionable next steps
- Do NOT suggest courses the student has already completed or is currently taking
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

    messages.push({ role: "user", content: JSON.stringify(audit) });

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

3. **Major Electives** — List courses with category="elective" from the plan. Also list electiveOptions if available. Mention the math substitution policy (students can use up to 2 of MATH-UA 122, 140, 185 as electives).

4. **Free Elective** — If freeSlots > 0, explicitly say the student has N free elective slot(s) where they can take any NYU course. Offer to search for courses matching their interests.

End with: "Would you like the full description of any courses? Or shall I search for free electives that match your interests?"

RULES:
- Use the exact course data provided — don't invent courses
- Keep each section to 2-3 sentences max
- Use bullet points for course lists
- Be warm and encouraging
- Mention total credits for the semester
- Apply the academic policy rules below when reasoning about recommendations

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
3. If the student asks about requirements, refer to the specific data in the context AND the academic rules.
4. If you don't know something specific, say so honestly — don't make things up.
5. If the student asks a follow-up about a previous response, use conversation history.
6. When answering about AP/IB/A-Level credits, use the equivalency tables in the academic rules.
7. When answering about CS major requirements, math substitution, or workload, use the CS BA rules.
8. When answering about CAS core requirements, check if any AP/IB credits already satisfy them.
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
