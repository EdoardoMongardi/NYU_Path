// ============================================================
// Cohort eval runner (Phase 6.5 P-5)
// ============================================================
// Drives full conversation cases through `runAgentTurn` and scores
// each turn against the §D Appendix composite. The runner is
// LLM-client agnostic: pass a `RecordingLLMClient` for deterministic
// CI runs, or an `OpenAIEngineClient` for live cohort evaluation.
// ============================================================

import type { LLMClient } from "../../packages/engine/src/agent/index.js";
import {
    runAgentTurn,
    buildDefaultRegistry,
    buildSystemPrompt,
    type ToolSession,
} from "../../packages/engine/src/agent/index.js";
import type { StudentProfile } from "@nyupath/shared";
import {
    scoreTurn,
    aggregateCohort,
    type CompositeReport,
    type ExpectedTurn,
} from "./composite.js";

export interface ConversationCase {
    id: string;
    description: string;
    student: StudentProfile;
    /** Sequence of turns. Each `userMessage` is sent through the
     *  agent loop with the prior assistant replies in `priorMessages`. */
    turns: ExpectedTurn[];
}

export interface CaseReport {
    caseId: string;
    description: string;
    /** Per-turn composite scores in order. */
    turnScores: CompositeReport[];
    /** Mean composite across this case's turns. */
    caseComposite: number;
    /** Optional engine-level errors that surfaced. */
    errors: string[];
}

export interface CohortReport {
    /** Each case's roll-up. */
    cases: CaseReport[];
    /** Cohort-level composite (mean per-case composite). */
    cohortComposite: number;
    /** Per-dimension cohort means (helpful for diagnosis). */
    dimensions: { grounding: number; completeness: number; uncertainty: number; nonFabrication: number };
    /** Number of turns scored. Useful for sanity-checking sample size. */
    turnCount: number;
    /** Per-case composites in submission order. */
    perCaseScores: number[];
}

export interface RunnerOptions {
    /** Override the system prompt (defaults to buildSystemPrompt({student})). */
    systemPromptForCase?: (c: ConversationCase) => string;
    /** Max turns per `runAgentTurn` invocation. Defaults to 8. */
    maxTurns?: number;
    /** Optional fallback client. */
    fallbackClient?: LLMClient;
}

export async function runCohort(
    client: LLMClient,
    cases: ConversationCase[],
    options: RunnerOptions = {},
): Promise<CohortReport> {
    const caseReports: CaseReport[] = [];
    let allTurns: CompositeReport[] = [];

    for (const c of cases) {
        const session: ToolSession = { student: c.student };
        const systemPrompt = options.systemPromptForCase
            ? options.systemPromptForCase(c)
            : buildSystemPrompt({ student: c.student });

        // Maintain a rolling priorMessages list — each user turn
        // appends the assistant's last reply for context.
        const priorMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
        const turnReports: CompositeReport[] = [];
        const errors: string[] = [];

        for (const turn of c.turns) {
            const result = await runAgentTurn(client, buildDefaultRegistry(), session, turn.userMessage, {
                systemPrompt,
                priorMessages: priorMessages.map((m) => ({ role: m.role, content: m.content })),
                maxTurns: options.maxTurns ?? 8,
                ...(options.fallbackClient ? { fallbackClient: options.fallbackClient } : {}),
            });
            if (result.kind !== "ok") {
                errors.push(`turn "${turn.userMessage.slice(0, 40)}…" → kind=${result.kind}`);
                turnReports.push({
                    dimensions: { grounding: 0, completeness: 0, uncertainty: 0, nonFabrication: 0 },
                    composite: 0,
                    notes: [`agent loop did not produce 'ok' (kind=${result.kind})`],
                });
                continue;
            }
            const report = scoreTurn(
                { assistantText: result.finalText, invocations: result.invocations },
                turn,
            );
            turnReports.push(report);
            // Append both user + assistant for the next turn's context.
            priorMessages.push({ role: "user", content: turn.userMessage });
            priorMessages.push({ role: "assistant", content: result.finalText });
        }

        const caseComposite = turnReports.length > 0
            ? turnReports.reduce((s, r) => s + r.composite, 0) / turnReports.length
            : 0;
        caseReports.push({
            caseId: c.id,
            description: c.description,
            turnScores: turnReports,
            caseComposite,
            errors,
        });
        allTurns = allTurns.concat(turnReports);
    }

    const agg = aggregateCohort(allTurns);
    return {
        cases: caseReports,
        cohortComposite: agg.composite,
        dimensions: agg.dimensions,
        turnCount: allTurns.length,
        perCaseScores: caseReports.map((r) => r.caseComposite),
    };
}
