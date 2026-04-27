// ============================================================
// /api/chat/v2 — Phase 6.1 WS2
// ============================================================
// New endpoint that drives the Phase 5 agent loop (`runAgentTurn`)
// against the production `OpenAIEngineClient`. Returns Server-Sent
// Events: `template_match` (when preLoopDispatch fires), per-tool
// `tool_invocation_start` / `tool_invocation_done`, `validator_block`
// when the response validator blocks the reply, and finally
// `token` + `done`.
//
// NOTE: Phase 6.1 ships a "block-streaming" v2 — events are emitted
// at coherent boundaries (tool start/done, final reply) rather than
// token-by-token. True intra-token streaming (first-token P50 ≤ 2.5s
// per §6.5.1) is a follow-up that requires `streamComplete` on the
// LLM client; the SSE pipeline + UI shape are wired here so the
// streaming refinement can land without route or UI changes.
//
// The legacy `/api/chat` route stays untouched. Migration of the
// `grade_adjustment` and `course_info` intents is Phase 7.
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import {
    runAgentTurnStreaming,
    buildDefaultRegistry,
    buildSystemPrompt,
    preLoopDispatch,
    validateResponse,
    createPrimaryClient,
    createFallbackClient,
    userInCohort,
    getCohortConfig,
    runTemplateMatcherOnly,
    type ToolSession,
    type LLMMessage,
    type ToolInvocation,
    type Cohort,
} from "@nyupath/engine";
import { loadPolicyTemplates } from "@nyupath/engine";
import { buildStudentProfileV2, type TranscriptData } from "../../../../lib/buildSession";
import { createSseStream, type SseWriter } from "../../../../lib/sseStream";
import { getCourseSearchFn } from "../../../../lib/courseCatalogSearch";

// Required for SSE — Node.js streaming, NOT edge runtime (the OpenAI
// SDK uses Node streams that the edge runtime doesn't support).
export const runtime = "nodejs";

// Cache the templates corpus at module level (one disk read per warm
// container). The Phase 6.5 cohort runner can rebuild via process
// recycling — there's no hot-reload requirement here.
let TEMPLATES: ReturnType<typeof loadPolicyTemplates>["templates"] | null = null;
function getTemplates() {
    if (TEMPLATES === null) TEMPLATES = loadPolicyTemplates().templates;
    return TEMPLATES;
}

interface V2RequestBody {
    message: string;
    parsedData?: TranscriptData;
    visaStatus?: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    correlationId?: string;
    /** Phase 7-A: stable user id used for cohort lookup. When omitted,
     *  the cohort gate falls through to the configured default
     *  (`alpha` until ops sets otherwise). */
    userId?: string;
}

export async function POST(req: NextRequest): Promise<Response> {
    let body: V2RequestBody;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }
    if (!body.message || typeof body.message !== "string") {
        return NextResponse.json({ error: "`message` is required and must be a string." }, { status: 400 });
    }
    if (!body.parsedData) {
        return NextResponse.json(
            { error: "`parsedData` is required. Onboarding must complete before /chat/v2 is reachable." },
            { status: 400 },
        );
    }

    const primary = createPrimaryClient();
    if (!primary) {
        return NextResponse.json(
            { error: "OPENAI_API_KEY not configured." },
            { status: 503 },
        );
    }
    const fallback = createFallbackClient(); // null is OK — the loop tolerates a missing fallback.

    const student = buildStudentProfileV2(body.parsedData, body.visaStatus);
    const searchCoursesFn = getCourseSearchFn();
    const session: ToolSession = searchCoursesFn
        ? ({ student, searchCoursesFn } as ToolSession & { searchCoursesFn: typeof searchCoursesFn })
        : { student };
    const systemPrompt = buildSystemPrompt({ student });
    const templates = getTemplates();

    // Phase 7-A P-1: cohort gate. When the user's cohort is in
    // `evalGateFailing` (e.g., cohort=`limited`), the agent loop is
    // disabled and we serve via runTemplateMatcherOnly per §12.6.5.
    const cohort: Cohort = userInCohort(body.userId ?? "anonymous");
    const cohortConfig = getCohortConfig(cohort);

    const { stream, writer } = createSseStream();

    // Run the agent loop in the background; the SSE stream returns
    // immediately so the browser sees event flow from t=0.
    void runV2Turn({
        primary,
        fallback,
        session,
        systemPrompt,
        templates,
        userMessage: body.message,
        history: body.history,
        correlationId: body.correlationId,
        cohort,
        cohortGateFailing: cohortConfig.evalGateFailing,
        writer,
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        },
    });
}

interface V2TurnArgs {
    primary: ReturnType<typeof createPrimaryClient>;
    fallback: ReturnType<typeof createFallbackClient>;
    session: ToolSession;
    systemPrompt: string;
    templates: ReturnType<typeof loadPolicyTemplates>["templates"];
    userMessage: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    correlationId?: string;
    cohort: Cohort;
    cohortGateFailing: boolean;
    writer: SseWriter;
}

async function runV2Turn(args: V2TurnArgs): Promise<void> {
    const { primary, fallback, session, systemPrompt, templates, userMessage, history, correlationId, cohort, cohortGateFailing, writer } = args;
    if (!primary) {
        writer.write({ kind: "error", message: "primary LLM client not configured" });
        writer.close();
        return;
    }
    try {
        // Phase 7-A P-1 / §12.6.5 — recovery mode. When the user's
        // cohort has `evalGateFailing: true` (e.g., the production
        // composite has dropped below 0.90), the agent loop is
        // disabled and we serve template-only answers. Falls back
        // to a "limited availability" reply when no template matches.
        if (cohortGateFailing) {
            const recovery = runTemplateMatcherOnly(userMessage, session, templates);
            if (recovery.kind === "template") {
                const t = recovery.match!.template;
                writer.write({ kind: "template_match", templateId: t.id, body: t.body, source: t.source });
                writer.write({ kind: "token", text: t.body });
                writer.write({ kind: "done", finalText: t.body, modelUsedId: `cohort:${cohort}:template-only` });
            } else {
                writer.write({ kind: "token", text: recovery.reply });
                writer.write({ kind: "done", finalText: recovery.reply, modelUsedId: `cohort:${cohort}:limited` });
            }
            writer.close();
            return;
        }

        // §5.5 pre-loop dispatch — template fast-path first.
        const dispatch = preLoopDispatch(userMessage, session, { templates });
        if (dispatch.kind === "template") {
            const t = dispatch.match.template;
            writer.write({
                kind: "template_match",
                templateId: t.id,
                body: t.body,
                source: t.source,
            });
            writer.write({ kind: "token", text: t.body });
            writer.write({ kind: "done", finalText: t.body, modelUsedId: "template" });
            writer.close();
            return;
        }

        // Convert prior history (from the client) into LLMMessages.
        const priorMessages: LLMMessage[] = (history ?? []).map((h) => ({
            role: h.role,
            content: h.content,
        }));

        // Phase 6.5 P-3: stream events through the agent generator.
        // tool_invocation_start/done fire AS each tool starts/finishes,
        // text_delta tokens stream the final reply character-by-
        // character (when the underlying client supports streamComplete),
        // and the terminal `done` event yields the full ChatTurnResult.
        const invocationsSoFar: ToolInvocation[] = [];
        let finalResult: import("@nyupath/engine").ChatTurnResult | null = null;

        for await (const ev of runAgentTurnStreaming(
            primary,
            buildDefaultRegistry(),
            session,
            userMessage,
            {
                systemPrompt,
                priorMessages,
                ...(fallback ? { fallbackClient: fallback } : {}),
                ...(correlationId ? { correlationId } : {}),
                maxTurns: 8,
            },
        )) {
            switch (ev.type) {
                case "tool_invocation_start":
                    writer.write({
                        kind: "tool_invocation_start",
                        toolName: ev.toolName,
                        args: ev.args,
                    });
                    break;
                case "tool_invocation_done":
                    invocationsSoFar.push(ev.invocation);
                    writer.write({
                        kind: "tool_invocation_done",
                        toolName: ev.invocation.toolName,
                        ...(ev.invocation.summary !== undefined ? { summary: ev.invocation.summary } : {}),
                        ...(ev.invocation.error?.message !== undefined ? { error: ev.invocation.error.message } : {}),
                    });
                    break;
                case "text_delta":
                    writer.write({ kind: "token", text: ev.text });
                    break;
                case "done":
                    finalResult = ev.result;
                    break;
            }
        }

        if (!finalResult || finalResult.kind !== "ok") {
            writer.write({
                kind: "error",
                message: finalResult ? `Agent loop ended in non-ok state: ${finalResult.kind}` : "Agent loop did not yield a final result.",
            });
            writer.close();
            return;
        }

        // Run the launch-blocking validators per §9.1 Part 9.
        const verdict = validateResponse({
            assistantText: finalResult.finalText,
            invocations: finalResult.invocations,
            student: session.student,
        });
        if (!verdict.ok) {
            writer.write({
                kind: "validator_block",
                violations: verdict.violations.map((v) => ({
                    kind: v.kind,
                    detail: v.detail,
                    ...(v.caveatId ? { caveatId: v.caveatId } : {}),
                    ...(v.number ? { number: v.number } : {}),
                })),
            });
            // Phase 6.1 posture: surface the reply anyway with a
            // clear validator_block event so the UI can render a
            // warning. Phase 7 should add an automatic re-run with
            // an additional system-prompt rule per §9.1 Part 9.
        }

        writer.write({
            kind: "done",
            finalText: finalResult.finalText,
            modelUsedId: finalResult.modelUsedId,
        });
    } catch (err) {
        writer.write({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
        });
    } finally {
        writer.close();
    }
}
