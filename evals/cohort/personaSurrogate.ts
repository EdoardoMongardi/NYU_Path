// ============================================================
// LLM-persona surrogate runner (Phase 7-A P-10)
// ============================================================
// Pre-flight cohort A composite measurement WITHOUT real users.
//
// Uses a "student persona" LLM as the user side of each cohort A
// conversation. The persona LLM gets a system prompt describing a
// realistic NYU undergrad (CAS junior, F-1 student, transfer
// hopeful, etc.) and is fed the case's first turn as a seed. It
// generates plausible follow-up questions; the agent loop responds;
// the conversation continues for up to N turns or until the persona
// signals it's done.
//
// Caveats spelled out in the architecture's §12.6.5 line 4134:
// hand-curated cases under-represent the long tail. The persona
// surrogate ALSO under-represents the long tail — it generates
// well-formed queries an LLM imagines a student might ask. It does
// NOT capture the messy, anxious, multi-intent reality of actual
// students mid-semester. Treat the surrogate composite as an
// **upper bound** on what cohort A will produce; if the surrogate
// can't clear 0.90, real users definitely won't.
// ============================================================

import {
    runAgentTurn,
    buildDefaultRegistry,
    buildSystemPrompt,
    type LLMClient,
    type LLMMessage,
    type ToolSession,
} from "../../packages/engine/src/agent/index.js";
import { scoreTurn, aggregateCohort, type CompositeReport } from "./composite.js";
import type { ConversationCase } from "./runner.js";
import type { ExpectedTurn } from "./composite.js";
import type { StudentProfile } from "@nyupath/shared";

export interface PersonaSurrogateOptions {
    /** LLM client driving the agent (the system under test). */
    agentClient: LLMClient;
    /** LLM client driving the persona (the simulated user). MUST be
     *  a DIFFERENT model from the agent per the LLM-as-judge best
     *  practice (avoids self-graded inflation). */
    personaClient: LLMClient;
    /** Maximum follow-up turns the persona may take per case. */
    maxFollowUps?: number;
    /** Optional fallback for the agent client. */
    fallbackClient?: LLMClient;
}

/** Build the system prompt for the persona LLM. The persona is
 *  asked to play a specific student type and to terminate the
 *  conversation when satisfied or when the agent has answered
 *  enough. */
function personaSystem(student: StudentProfile, caseDescription: string): string {
    return [
        "You are simulating an NYU undergraduate using an academic-advising chatbot.",
        "",
        "Your profile:",
        `- School: ${student.homeSchool.toUpperCase()}`,
        `- Catalog year: ${student.catalogYear}`,
        `- Declared programs: ${student.declaredPrograms.map((p) => `${p.programType} ${p.programId}`).join(", ")}`,
        `- Visa status: ${student.visaStatus ?? "domestic"}`,
        `- Courses completed: ${student.coursesTaken.length}`,
        "",
        `Scenario: ${caseDescription}`,
        "",
        "Behave like a real NYU student, not an evaluator. Ask short,",
        "natural follow-ups when the answer is unclear. If the answer is",
        "satisfying, reply with the literal token \"<<DONE>>\" and nothing",
        "else.",
        "",
        "Do NOT critique the assistant's answer. Do NOT explain the",
        "scenario. Do NOT try to trick the assistant. Just play the",
        "student.",
    ].join("\n");
}

/** Run a single case end-to-end. The persona produces follow-up
 *  user messages until it emits "<<DONE>>" or maxFollowUps is hit. */
async function runOneCase(
    c: ConversationCase,
    opts: PersonaSurrogateOptions,
): Promise<{ caseId: string; turnReports: CompositeReport[]; transcript: Array<{ role: "user" | "assistant"; content: string }>; errors: string[] }> {
    const session: ToolSession = { student: c.student };
    const agentSystemPrompt = buildSystemPrompt({ student: c.student });
    const personaSystemPrompt = personaSystem(c.student, c.description);

    const transcript: Array<{ role: "user" | "assistant"; content: string }> = [];
    const turnReports: CompositeReport[] = [];
    const errors: string[] = [];
    const maxFollowUps = opts.maxFollowUps ?? 3;

    // The first turn is seeded from the case's first ExpectedTurn.
    const seedExpected: ExpectedTurn = c.turns[0]!;
    let userMessage = seedExpected.userMessage;
    let expectedForThisTurn: ExpectedTurn | undefined = seedExpected;
    let followUpCount = 0;

    while (true) {
        const result = await runAgentTurn(
            opts.agentClient,
            buildDefaultRegistry(),
            session,
            userMessage,
            {
                systemPrompt: agentSystemPrompt,
                priorMessages: transcript,
                maxTurns: 8,
                ...(opts.fallbackClient ? { fallbackClient: opts.fallbackClient } : {}),
            },
        );
        if (result.kind !== "ok") {
            errors.push(`turn ended kind=${result.kind}`);
            turnReports.push({
                dimensions: { grounding: 0, completeness: 0, uncertainty: 0, nonFabrication: 0 },
                composite: 0,
                notes: [`agent loop did not produce 'ok' (kind=${result.kind})`],
            });
            break;
        }
        // Score the turn against the case's expected components when
        // available; subsequent persona-driven follow-ups have no
        // expected shape, so we score against an empty expectation
        // (loose grounding + non-fabrication only).
        const exp: ExpectedTurn = expectedForThisTurn ?? { userMessage };
        const report = scoreTurn(
            { assistantText: result.finalText, invocations: result.invocations },
            exp,
        );
        turnReports.push(report);
        transcript.push({ role: "user", content: userMessage });
        transcript.push({ role: "assistant", content: result.finalText });

        if (followUpCount >= maxFollowUps) break;
        followUpCount += 1;

        // Ask the persona for the next user message.
        const personaMessages: LLMMessage[] = [
            ...transcript.map((m) => ({ role: m.role, content: m.content })),
        ];
        let personaText: string;
        try {
            const personaCompletion = await opts.personaClient.complete({
                system: personaSystemPrompt,
                messages: personaMessages,
                maxTokens: 80,
                temperature: 0.7,
            });
            personaText = personaCompletion.text.trim();
        } catch (e) {
            errors.push(`persona client errored: ${e instanceof Error ? e.message : String(e)}`);
            break;
        }
        if (personaText.includes("<<DONE>>") || personaText.length === 0) break;
        userMessage = personaText;
        expectedForThisTurn = undefined; // no expected shape for follow-ups
    }

    return { caseId: c.id, turnReports, transcript, errors };
}

export interface PersonaSurrogateReport {
    cases: Array<{
        caseId: string;
        description: string;
        composite: number;
        transcript: Array<{ role: "user" | "assistant"; content: string }>;
        errors: string[];
    }>;
    cohortComposite: number;
    /** Mean per-dimension scores across the cohort. */
    dimensions: { grounding: number; completeness: number; uncertainty: number; nonFabrication: number };
}

/** Run the entire cohort through the persona-surrogate harness. */
export async function runPersonaSurrogate(
    cases: ConversationCase[],
    opts: PersonaSurrogateOptions,
): Promise<PersonaSurrogateReport> {
    const caseRows: PersonaSurrogateReport["cases"] = [];
    let allTurnReports: CompositeReport[] = [];
    for (const c of cases) {
        const out = await runOneCase(c, opts);
        const composite = out.turnReports.length > 0
            ? out.turnReports.reduce((s, r) => s + r.composite, 0) / out.turnReports.length
            : 0;
        caseRows.push({
            caseId: out.caseId,
            description: c.description,
            composite,
            transcript: out.transcript,
            errors: out.errors,
        });
        allTurnReports = allTurnReports.concat(out.turnReports);
    }
    const agg = aggregateCohort(allTurnReports);
    return {
        cases: caseRows,
        cohortComposite: agg.composite,
        dimensions: agg.dimensions,
    };
}
