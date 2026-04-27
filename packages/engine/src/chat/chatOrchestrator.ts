// ============================================================
// Chat Orchestrator — Main entry point for student messages
// ============================================================
// Routes messages to the right engine function and generates
// natural language responses.
// ============================================================
//
// @deprecated Phase 6 WS3 (scheduled for removal after WS2 lands).
// This module is the pre-Phase-5 chat-layer; the replacement is the
// agent loop in `packages/engine/src/agent/agentLoop.ts:runAgentTurn`
// plus the §7.2 tool registry. Two callers remain:
//   1. `apps/web/app/api/chat/route.ts` — production. Stays on the
//      legacy path until Phase 6.1 stands up `/api/chat/v2` against
//      `runAgentTurn` and migrates the `grade_adjustment` /
//      `course_info` intents (Option B per the Phase 6 plan).
//   2. `packages/engine/tests/eval/advisoryQuality.ts` — eval-only
//      helper, not on the user-facing path.
// Do NOT add new callers. Migrate to the agent loop instead.
// ============================================================

import type { LLMClient } from "./llmClient.js";
import { classifyIntentHybrid, type ClassifiedIntent } from "./intentRouter.js";
import {
    explainAudit,
    explainPlan,
    formatSearchResults,
    generateGreeting,
    answerGeneral,
} from "./explanationGenerator.js";
import type { SemanticSearchResult } from "../search/semanticSearch.js";
import type { AvailabilityResult } from "../search/availabilityPredictor.js";

export interface ChatContext {
    /** Student's name for personalized responses */
    studentName?: string;
    /** Summary of student's academic situation for general Q&A */
    studentContext?: string;
    /** Function to run degree audit — injected by the caller */
    runAudit?: () => Promise<AuditData>;
    /** Function to run semester plan — injected by the caller */
    runPlan?: () => Promise<PlanData>;
    /** Function to search courses by query — injected by the caller */
    searchCourses?: (query: string) => Promise<SearchData>;
    /** Function to check course availability — injected by the caller */
    checkAvailability?: (courseId: string) => Promise<AvailabilityResult>;
}

/** A single message in the conversation history */
export interface HistoryMessage {
    role: string;
    content: string;
}

// Minimal data types for the orchestrator (no hard dependency on types.ts)
export interface AuditData {
    programName: string;
    totalCreditsCompleted: number;
    totalCreditsRequired: number;
    rulesCompleted: number;
    rulesTotal: number;
    unmetRules: string[];
    /** Credits of free electives still needed to reach 128 total */
    remainingFreeElectiveCredits?: number;
    /** Courses currently in progress (pending grades) — assumed passing */
    pendingCourses?: Array<{ courseId: string; title: string; credits: number }>;
}

export interface PlanData {
    semester: string;
    courses: Array<{ id: string; title: string; credits: number; category: string }>;
    totalCredits: number;
    freeSlots: number;
    pacingNote?: string;
    enrollmentWarnings: string[];
    /** Unmet CAS Core requirements with available course options */
    unmetCoreRules?: Array<{ label: string; options: string[] }>;
    /** Available major elective options not yet selected */
    electiveOptions?: Array<{ id: string; title: string }>;
    /** Courses the student has already completed */
    completedCourses?: string[];
    /** Whether the student is a freshman (0-1 completed semesters) */
    isFreshman?: boolean;
}

export interface SearchData {
    results: SemanticSearchResult[];
    query: string;
    availability?: Map<string, AvailabilityResult>;
}

export interface ChatResponse {
    /** Natural language message to send to the student */
    message: string;
    /** The classified intent */
    intent: ClassifiedIntent;
    /** Search results (if elective_search) */
    searchResults?: SemanticSearchResult[];
    /** Availability info (if schedule_check) */
    availability?: AvailabilityResult;
}

/**
 * Handle a student message: classify → route → respond.
 */
export async function handleMessage(
    userMessage: string,
    context: ChatContext,
    llm: LLMClient,
    history?: HistoryMessage[]
): Promise<ChatResponse> {
    // 1. Classify intent (hybrid: rules first, LLM fallback)
    const intent = await classifyIntentHybrid(userMessage, llm);

    // 2. Route to the right handler
    switch (intent.intent) {
        case "elective_search":
            return handleElectiveSearch(intent, context, llm);

        case "audit_status":
            return handleAuditStatus(userMessage, intent, context, llm, history);

        case "plan_explain":
            return handlePlanExplain(intent, context, llm, history);

        case "schedule_check":
            return handleScheduleCheck(intent, context);

        case "general":
        default:
            return handleGeneral(userMessage, intent, context, llm, history);
    }
}

async function handleElectiveSearch(
    intent: ClassifiedIntent,
    context: ChatContext,
    llm: LLMClient
): Promise<ChatResponse> {
    if (!context.searchCourses) {
        return {
            message: "I'd love to help you find courses, but I don't have access to the course search right now. Please try again later.",
            intent,
        };
    }

    const query = intent.searchQuery ?? "interesting courses";
    const data = await context.searchCourses(query);

    // Map results with availability info
    const resultsWithAvail = data.results.map(r => ({
        courseId: r.courseId,
        title: r.title,
        score: r.score,
        availability: data.availability?.get(r.courseId)
            ? formatAvailability(data.availability.get(r.courseId)!)
            : undefined,
    }));

    const message = formatSearchResults(resultsWithAvail, query);

    return {
        message,
        intent,
        searchResults: data.results,
    };
}

async function handleAuditStatus(
    userMessage: string,
    intent: ClassifiedIntent,
    context: ChatContext,
    llm: LLMClient,
    history?: HistoryMessage[]
): Promise<ChatResponse> {
    if (!context.runAudit) {
        return {
            message: "I don't have your degree information loaded yet. Please set up your profile first!",
            intent,
        };
    }

    const audit = await context.runAudit();
    const message = await explainAudit(audit, llm, history, userMessage);

    return { message, intent };
}

async function handlePlanExplain(
    intent: ClassifiedIntent,
    context: ChatContext,
    llm: LLMClient,
    history?: HistoryMessage[]
): Promise<ChatResponse> {
    if (!context.runPlan) {
        return {
            message: "I don't have your course plan set up yet. Let's start by checking your degree progress!",
            intent,
        };
    }

    const plan = await context.runPlan();
    const message = await explainPlan(plan, llm, history);

    return { message, intent };
}

async function handleScheduleCheck(
    intent: ClassifiedIntent,
    context: ChatContext
): Promise<ChatResponse> {
    if (!context.checkAvailability || !intent.courseId) {
        return {
            message: intent.courseId
                ? "I can't check course availability right now. Please try again later."
                : "Which course would you like me to check? Please include the course code (e.g., CSCI-UA 472).",
            intent,
        };
    }

    const avail = await context.checkAvailability(intent.courseId);
    const message = formatAvailabilityMessage(intent.courseId, avail);

    return { message, intent, availability: avail };
}

async function handleGeneral(
    userMessage: string,
    intent: ClassifiedIntent,
    context: ChatContext,
    llm: LLMClient,
    history?: HistoryMessage[]
): Promise<ChatResponse> {
    // Check for greetings
    const lower = userMessage.toLowerCase().trim();
    if (/^(hi|hello|hey|sup|yo|what's up|howdy)\b/.test(lower)) {
        return {
            message: generateGreeting(context.studentName),
            intent,
        };
    }

    const message = await answerGeneral(userMessage, llm, context.studentContext, history);
    return { message, intent };
}

// ---- Helpers ----

function formatAvailability(avail: AvailabilityResult): string {
    switch (avail.confidence) {
        case "confirmed":
            return avail.available ? "🟢 Confirmed" : "🔴 Not offered";
        case "likely":
            return "🟡 Likely offered";
        case "uncertain":
            return avail.available ? "⚪ Uncertain" : "⚪ Unlikely";
    }
}

function formatAvailabilityMessage(courseId: string, avail: AvailabilityResult): string {
    const icon = formatAvailability(avail);
    return `**${courseId}**: ${icon}\n${avail.reason}`;
}
