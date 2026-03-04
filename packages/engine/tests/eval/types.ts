// ============================================================
// Evaluation Framework — Type Definitions
// ============================================================

import type { Intent } from "../../src/chat/intentRouter.js";

// ---- Eval Intent Taxonomy (mapped from production intents) ----

export type EvalIntent =
    | "audit_status"    // includes grade_adjustment (what-if)
    | "plan_explain"
    | "elective_search"
    | "schedule_check"
    | "course_info"
    | "meta"            // greetings, clarification
    | "follow_up";      // context-dependent follow-ups

export type SupportStatus = "supported" | "unsupported" | "ambiguous" | "under_evidenced";
export type ExpectedBehavior = "answer" | "refuse" | "ask_clarifying";
export type EvalCategory = "intent_classification" | "constraint" | "advisory" | "stress";
export type Difficulty = "easy" | "medium" | "hard";

// ---- Eval Dataset Schema ----

export interface EvalExample {
    id: string;
    category: EvalCategory;
    subcategory: string;
    difficulty: Difficulty;
    tags: string[];

    // Input
    query: string;
    student_profile_id: string | null;
    conversation_history: { role: "user" | "assistant"; content: string }[];

    // Expected: Intent
    expected_intent: EvalIntent;
    expected_confidence_min: number;
    expected_course_id: string | null;
    expected_search_query: string | null;

    // Expected: Deterministic
    expected_audit: {
        overall_status: "satisfied" | "in_progress" | "not_started";
        total_credits_completed: number;
        rules_satisfied: string[];
        rules_remaining: string[];
        warnings_contain: string[];
    } | null;
    expected_plan: {
        min_courses: number;
        max_courses: number;
        must_include: string[];
        must_not_include: string[];
        f1_compliant: boolean;
    } | null;

    // Expected: Advisory (LLM)
    advisory_assertions: {
        must_contain: string[];
        numeric_facts: Record<string, number>;
        allowed_course_ids: string[];
        must_cite_sources: string[];
        no_fabricated_ids: boolean;
        grounding_source: string;
        tone: string;
    } | null;

    // Evidence sufficiency (human-assigned)
    support_status: SupportStatus;
    expected_behavior: ExpectedBehavior;

    // Failure annotations
    expected_failure: string | null;
    notes: string;
}

// ---- Eval Results ----

export interface IntentResult {
    id: string;
    query: string;
    expected_intent: EvalIntent;
    predicted_intent: EvalIntent;
    raw_intent: Intent;         // original router label before mapping
    confidence: number;
    quick_classify_hit: boolean; // true if rule-based, false if LLM fallback
    correct: boolean;
    failure_code: string | null;
    latency_ms: number;
}

export interface ConstraintResult {
    id: string;
    profile_id: string;
    program_id: string;
    expected_status: string;
    actual_status: string;
    expected_credits: number;
    actual_credits: number;
    rules_correct: number;
    rules_total: number;
    warnings_precision: number;
    warnings_recall: number;
    correct: boolean;
    failure_code: string | null;
    data_gap_code: string | null; // D2xx codes
}

export interface AdvisoryResult {
    id: string;
    query: string;
    grounding_source: string;
    claims_total: number;
    claims_grounded: number;
    claims_fabricated: number;
    claims_contradicted: number;
    claims_insufficient: number;
    numeric_facts_correct: number;
    numeric_facts_total: number;
    fabricated_ids: string[];
    failure_code: string | null;
}

export interface AbstractionResult {
    id: string;
    support_status: SupportStatus;
    expected_behavior: ExpectedBehavior;
    actual_behavior: ExpectedBehavior;
    correct: boolean;
}

export interface EvalRun {
    run_id: string;
    timestamp: string;
    system: string;
    intent_results: IntentResult[];
    constraint_results: ConstraintResult[];
    advisory_results: AdvisoryResult[];
    abstention_results: AbstractionResult[];
}

// ---- Intent Mapping ----

export function mapIntentToEval(intent: Intent): EvalIntent {
    switch (intent) {
        case "grade_adjustment":
            return "audit_status";
        case "general":
            // Caller must decide meta vs follow_up based on context
            // Default to follow_up since meta is deterministic
            return "follow_up";
        default:
            return intent as EvalIntent;
    }
}
