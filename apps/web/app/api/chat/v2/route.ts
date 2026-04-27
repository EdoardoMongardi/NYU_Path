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
    runAgentTurn,
    buildDefaultRegistry,
    buildSystemPrompt,
    preLoopDispatch,
    validateResponse,
    createPrimaryClient,
    createFallbackClient,
    type ToolSession,
    type LLMMessage,
} from "@nyupath/engine";
import { loadPolicyTemplates } from "@nyupath/engine";
import { buildStudentProfileV2, type TranscriptData } from "../../../../lib/buildSession";
import { createSseStream, type SseWriter } from "../../../../lib/sseStream";

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
    const session: ToolSession = { student };
    const systemPrompt = buildSystemPrompt({ student });
    const templates = getTemplates();

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
    writer: SseWriter;
}

async function runV2Turn(args: V2TurnArgs): Promise<void> {
    const { primary, fallback, session, systemPrompt, templates, userMessage, history, correlationId, writer } = args;
    if (!primary) {
        writer.write({ kind: "error", message: "primary LLM client not configured" });
        writer.close();
        return;
    }
    try {
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

        const result = await runAgentTurn(
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
        );

        // Surface tool invocations in arrival order. Block-emit:
        // start + done back-to-back per tool. Real intra-tool
        // progress is a Phase 7 follow-up.
        for (const inv of result.invocations) {
            writer.write({
                kind: "tool_invocation_start",
                toolName: inv.toolName,
                args: inv.args,
            });
            writer.write({
                kind: "tool_invocation_done",
                toolName: inv.toolName,
                ...(inv.summary !== undefined ? { summary: inv.summary } : {}),
                ...(inv.error?.message !== undefined ? { error: inv.error.message } : {}),
            });
        }

        if (result.kind !== "ok") {
            writer.write({
                kind: "error",
                message: `Agent loop ended in non-ok state: ${result.kind}`,
            });
            writer.close();
            return;
        }

        // Run the launch-blocking validators per §9.1 Part 9.
        const verdict = validateResponse({
            assistantText: result.finalText,
            invocations: result.invocations,
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

        writer.write({ kind: "token", text: result.finalText });
        writer.write({
            kind: "done",
            finalText: result.finalText,
            modelUsedId: result.modelUsedId,
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
