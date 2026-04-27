// ============================================================
// Cohort gate (Phase 6.5 P-4) — §12.6.5 lines 4103-4123
// ============================================================
// Operationalizes the Appendix D ≥0.90 eval gate by mapping a userId
// to a cohort and a per-cohort runtime configuration. The architecture
// specifies four cohorts plus a `limited` recovery cohort that disables
// the agent loop and serves only via the curated template matcher
// (`runTemplateMatcherOnly`). Cohort assignments are server-side and
// updated manually via a weekly review meeting (no automatic
// transitions — the gate is a forcing function for human review).
// ============================================================

import { matchTemplate, type PolicyTemplate, type TemplateMatchResult } from "../rag/policyTemplate.js";
import type { ToolSession } from "../agent/tool.js";

export type Cohort = "alpha" | "beta" | "invite" | "public" | "limited";

export interface CohortConfig {
    cohort: Cohort;
    /**
     * When true, the agent loop is disabled for this cohort and
     * `runTemplateMatcherOnly` serves curated answers only. Used for
     * the cohort-D failure response ("Limited availability mode")
     * and any cohort whose eval gate is currently failing.
     */
    evalGateFailing: boolean;
    /**
     * Soft cap on max-turns for this cohort. Lower for early cohorts
     * to keep cost + variance bounded; higher for later cohorts that
     * need multi-tool reasoning chains.
     */
    maxTurns: number;
    /** Minimum composite eval score required to STAY in this cohort
     *  (Appendix D §D.5). When the rolling-week composite drops below
     *  this, ops should flip `evalGateFailing` to true. */
    composedEvalFloor: number;
    /** Human-readable summary surfaced in admin dashboards. */
    description: string;
}

/** Per-cohort defaults the architecture pins at §12.6.5. Operations
 *  edits this table (or a JSON override layered on top) to flip a
 *  cohort into recovery mode without a redeploy. */
export const COHORT_CONFIGS: Record<Cohort, CohortConfig> = {
    alpha: {
        cohort: "alpha",
        evalGateFailing: false,
        maxTurns: 8,
        composedEvalFloor: 0.90,
        description: "Internal alpha (~10 testers: team + faculty contacts).",
    },
    beta: {
        cohort: "beta",
        evalGateFailing: false,
        maxTurns: 8,
        composedEvalFloor: 0.90,
        description: "Closed beta (~50 CAS volunteers).",
    },
    invite: {
        cohort: "invite",
        evalGateFailing: false,
        maxTurns: 10,
        composedEvalFloor: 0.90,
        description: "Invite-only (~500 across CAS + Tandon + Stern).",
    },
    public: {
        cohort: "public",
        evalGateFailing: false,
        maxTurns: 10,
        composedEvalFloor: 0.90,
        description: "Public launch — NYU undergrads at large.",
    },
    limited: {
        cohort: "limited",
        evalGateFailing: true,
        maxTurns: 0,
        composedEvalFloor: 0.0,
        description: "Limited availability — template matcher only; agent loop disabled.",
    },
};

/**
 * Resolve a userId to a cohort. Production wires this against a
 * datastore lookup; the in-memory map below is the dev/test
 * default. Unknown users default to `alpha` so the recovery
 * machinery is exercised before they reach beta — matches the
 * architecture's "no automatic transitions" rule.
 */
export interface CohortAssignment {
    /** Map userId → cohort. Undefined entries fall through to default. */
    overrides?: Record<string, Cohort>;
    /** Cohort assigned to userIds NOT in `overrides`. Default `alpha`. */
    default?: Cohort;
}

let CURRENT_ASSIGNMENT: CohortAssignment = { default: "alpha" };

/** Replace the runtime cohort assignment (used by ops + tests). */
export function setCohortAssignment(a: CohortAssignment): void {
    CURRENT_ASSIGNMENT = a;
}

export function getCohortAssignment(): CohortAssignment {
    return CURRENT_ASSIGNMENT;
}

/** Resolve a userId → Cohort. */
export function userInCohort(userId: string): Cohort {
    return CURRENT_ASSIGNMENT.overrides?.[userId] ?? CURRENT_ASSIGNMENT.default ?? "alpha";
}

export function getCohortConfig(cohort: Cohort): CohortConfig {
    return COHORT_CONFIGS[cohort];
}

// ============================================================
// runTemplateMatcherOnly — recovery mode (§12.6.5)
// ============================================================
//
// When a cohort's eval gate is failing, the agent loop is disabled
// and queries are served by the §5.5 template matcher only. If no
// template matches, the user gets a transparent "limited
// availability" message instead of an LLM-generated reply.

export interface TemplateOnlyResult {
    kind: "template" | "no_match";
    /** Present when kind === "template". */
    match?: TemplateMatchResult;
    /** Always present. The reply text the chat layer should surface. */
    reply: string;
}

/**
 * Recovery-mode entry point. Looks up the user's home school and
 * walks the curated template corpus for a match. No LLM, no tools,
 * no validators — just template lookup.
 */
export function runTemplateMatcherOnly(
    userMessage: string,
    session: ToolSession,
    templates: PolicyTemplate[],
    options: { now?: Date; transferIntent?: boolean } = {},
): TemplateOnlyResult {
    if (!session.student) {
        return {
            kind: "no_match",
            reply: noMatchMessage("limited"),
        };
    }
    const match = matchTemplate(userMessage, templates, session.student.homeSchool, {
        now: options.now,
        transferIntent: options.transferIntent,
    });
    if (match) {
        return {
            kind: "template",
            match,
            reply: match.template.body,
        };
    }
    return {
        kind: "no_match",
        reply: noMatchMessage("limited"),
    };
}

function noMatchMessage(cohort: Cohort): string {
    if (cohort === "limited") {
        return [
            "**NYU Path is currently in limited availability mode.**",
            "",
            "We're not able to answer this question right now. Please contact the College Advising Center (25 West 4th Street, 5th floor; 212-998-8130) for help.",
            "",
            "We'll be back at full capacity once our internal eval suite returns to its quality baseline. Thanks for your patience.",
        ].join("\n");
    }
    return "I don't have a curated answer for that question. Try rephrasing, or contact your academic adviser.";
}
