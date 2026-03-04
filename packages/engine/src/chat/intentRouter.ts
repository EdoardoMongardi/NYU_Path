// ============================================================
// Intent Router — Classify student messages into action intents
// ============================================================

import type { LLMClient, Message } from "./llmClient.js";

export type Intent =
    | "elective_search"
    | "audit_status"
    | "plan_explain"
    | "schedule_check"
    | "grade_adjustment"
    | "course_info"
    | "general";

export interface ClassifiedIntent {
    intent: Intent;
    /** Extracted search query for elective_search intent */
    searchQuery?: string;
    /** Extracted course ID for schedule_check or grade_adjustment intent */
    courseId?: string;
    /** Expected grade for grade_adjustment intent (e.g. "F", "D", "C-") */
    expectedGrade?: string;
    /** Confidence 0-1 */
    confidence: number;
}

const SYSTEM_PROMPT = `You are an intent classifier for an NYU course planning assistant. Classify the student's message into exactly one intent.

Intents:
- "elective_search": Student wants to find/discover courses by topic or interest. Examples: "I want ML courses", "something creative", "courses about philosophy", "find a writing course"
- "audit_status": Student asks about their degree progress, credits remaining, requirements. Examples: "How many credits do I need?", "Am I on track to graduate?", "What requirements are left?"
- "plan_explain": Student directly asks for a NEW course plan or what to take. Examples: "What should I take next semester?", "Plan my semester", "Suggest courses for next fall"
- "schedule_check": Student asks if a specific course is offered in a specific semester. Examples: "Is CS 472 offered in spring?", "When is Machine Learning available?"
- "general": Follow-up questions about previous responses, questions about specific courses, opinions, greetings, prereq questions, or anything else. Examples: "Why not add an elective?", "Should I take Linear Algebra?", "But I already took that", "What does that mean?", "Hello"

IMPORTANT: If the student is asking a FOLLOW-UP question about a previous plan/response (e.g. "why not ...", "but I already ...", "should I take X", "can you replace ..."), classify as "general" NOT "plan_explain". Only classify as "plan_explain" if they are explicitly requesting a NEW fresh plan.

If the intent is "elective_search", extract the search query (the topic/interest they want).
If the intent is "schedule_check", extract the course ID if mentioned.

Respond in JSON: {"intent": "...", "searchQuery": "...", "courseId": "...", "confidence": 0.0-1.0}`;

/**
 * Classify a student message into an action intent.
 * Uses GPT-4o-mini with JSON mode for structured output.
 */
export async function classifyIntent(
    message: string,
    llm: LLMClient
): Promise<ClassifiedIntent> {
    const messages: Message[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: message },
    ];

    const result = await llm.chatJSON<ClassifiedIntent>(messages, {
        temperature: 0,
        maxTokens: 150,
    });

    return {
        intent: result.intent ?? "general",
        searchQuery: result.searchQuery,
        courseId: result.courseId,
        confidence: result.confidence ?? 0.5,
    };
}

/**
 * Fast rule-based pre-classification for obvious intents.
 * Falls back to LLM for ambiguous messages.
 * This saves ~80% of LLM calls for simple messages.
 */
export function quickClassify(message: string): ClassifiedIntent | null {
    const lower = message.toLowerCase().trim();

    // Greetings
    if (/^(hi|hello|hey|sup|yo|what's up|howdy)\b/.test(lower)) {
        return { intent: "general", confidence: 0.95 };
    }

    // Grade adjustment — "I think I'll fail X", "I'll get a D in Y", "I might not pass Z"
    const gradeAdjMatch = lower.match(/\b(?:fail|failing|won'?t pass|might not pass|expect.*(f|d\+?|d-?|c-)|get.*(f|d\+?|d-?|c-)\s+in|getting.*(f|d\+?|d-?|c-))\b/i);
    if (gradeAdjMatch) {
        // Try to extract course ID from the message
        const courseIdMatch = message.match(/\b([A-Z]{2,}-[A-Z]{2}\s+\d+)\b/i);
        // Determine expected grade
        let expectedGrade = "F";
        const gradeMatch = lower.match(/\b(c-|d\+|d-|d)\b/);
        if (gradeMatch) {
            expectedGrade = gradeMatch[1].toUpperCase();
        } else if (/fail|failing|won'?t pass|might not pass/.test(lower)) {
            expectedGrade = "F";
        }
        return {
            intent: "grade_adjustment",
            courseId: courseIdMatch ? courseIdMatch[1].toUpperCase() : undefined,
            expectedGrade,
            confidence: 0.85,
        };
    }

    // Course info — "tell me about CSCI-UA 201", "describe Data Structures", "what is CSCI-UA 310",
    // "give me full description of CSCI-UA 467", "description of CSCI-UA 473", "CSCI-UA 310?"
    const courseIdInMsg = message.match(/\b([A-Z]{2,}-[A-Z]{2}\s+\d+)\b/i);
    if (courseIdInMsg) {
        const courseInfoTrigger = /\b(tell me about|describe|what is|what's|info on|details?\s*(?:about|on|for)|prerequisite?s?\s*(?:for|of)|description\s*(?:of|for)|give me.*(?:description|info|details)|about)\b/i;
        if (courseInfoTrigger.test(lower) || /\?\s*$/.test(message.trim())) {
            return {
                intent: "course_info",
                courseId: courseIdInMsg[1].toUpperCase(),
                confidence: 0.9,
            };
        }
    }

    // Audit keywords
    if (/\b(credits?\b.*\b(left|remaining|needed|need|do i)|on track|graduat|requirements?\b|degree (progress|audit|check))\b/i.test(lower)) {
        return { intent: "audit_status", confidence: 0.9 };
    }

    // Schedule check with specific course
    const courseMatch = lower.match(/\b(is|when|does)\b.*\b([A-Z]{2,}-[A-Z]{2}\s+\d+)\b/i);
    if (courseMatch && /\b(offer|available|open|taught|run)\b/.test(lower)) {
        return {
            intent: "schedule_check",
            courseId: courseMatch[2].toUpperCase(),
            confidence: 0.85,
        };
    }

    // Elective search with topic keywords
    if (/\b(courses? about|interested in|want.*courses?|looking for.*class|something (about|like|creative|fun|easy|interesting)|find (a |an |me )?(course|class|elective))\b/.test(lower)) {
        // Extract the topic after common patterns
        const topicMatch = lower.match(/(?:courses? about|interested in|something (?:about|like)|looking for.*(?:class|course).*(?:about|on|in)|find (?:a |an |me )?(?:course|class|elective)\s*(?:for|about|on|in)?\s*)\s*(.+)/i);
        return {
            intent: "elective_search",
            searchQuery: topicMatch?.[1]?.replace(/[?.!]+$/, "").trim() ?? message,
            confidence: 0.85,
        };
    }

    // Plan explanation — only direct plan requests, NOT follow-up questions
    if (/^(what should i take|what courses|suggest.*next semester|course plan|plan my semester)\b/.test(lower)) {
        return { intent: "plan_explain", confidence: 0.85 };
    }

    // Ambiguous — needs LLM
    return null;
}

/**
 * Hybrid classifier: tries quick rules first, falls back to LLM.
 */
export async function classifyIntentHybrid(
    message: string,
    llm: LLMClient
): Promise<ClassifiedIntent> {
    const quick = quickClassify(message);
    if (quick) return quick;
    return classifyIntent(message, llm);
}
