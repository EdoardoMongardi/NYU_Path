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
import { join } from "node:path";
import {
    runAgentTurnStreaming,
    buildDefaultRegistry,
    buildSystemPrompt,
    // Phase 8 A1: preLoopDispatch removed from active path; import
    // dropped to surface compile-time mistakes if anything tries to
    // reintroduce the keyword router. runTemplateMatcherOnly stays
    // for recovery mode (cohortConfig.evalGateFailing).
    validateResponse,
    createPrimaryClient,
    createFallbackClient,
    getCohortConfig,
    runTemplateMatcherOnly,
    summariesAsPriorMessage,
    JsonlFileSink,
    type FallbackSink,
    type ToolSession,
    type LLMMessage,
    type ToolInvocation,
    type Cohort,
} from "@nyupath/engine";
import {
    loadPolicyTemplates,
    loadSchoolConfig,
    degreeProgressReportSchema,
    deriveTemporalContext,
    normalizeGraduationTarget,
    detectMultiIntent,
    renderMultiIntentBriefing,
    detectAmbiguity,
    askClarification,
    type DegreeProgressReport,
} from "@nyupath/engine";
import {
    buildStudentProfileV2,
    buildStudentProfileFromDpr,
    type TranscriptData,
} from "../../../../lib/buildSession";
import { createSseStream, type SseWriter } from "../../../../lib/sseStream";
import { getCourseSearchFn } from "../../../../lib/courseCatalogSearch";
import { getStores } from "../../../../lib/db/store";
import { getPolicyRagBundle } from "../../../../lib/policyRagSetup";
import { consumeRequest } from "../../../../lib/rateLimit";
import { readSessionFromRequest } from "../../../../lib/auth/session";

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

// Phase 7-E W11 reviewer P1-2 — wire a real fallback sink so the
// /admin/observability dashboard has data to display. Without this
// every model_error_no_fallback / validator_replay / context_limit_terminate
// silently disappears and the operator has nothing to debug from.
// Resolution order matches the dashboard's LOG_PATH_CANDIDATES:
//   1. NYUPATH_FALLBACK_LOG_PATH env var (operator override)
//   2. <cwd>/data/fallback_log.jsonl  (the dashboard's first guess)
let FALLBACK_SINK: FallbackSink | null = null;
function getFallbackSink(): FallbackSink {
    if (FALLBACK_SINK === null) {
        const path =
            process.env.NYUPATH_FALLBACK_LOG_PATH
            ?? join(process.cwd(), "data", "fallback_log.jsonl");
        FALLBACK_SINK = new JsonlFileSink(path);
    }
    return FALLBACK_SINK;
}

/** Phase 7-E onboarding shape: discriminated union. The DPR variant
 *  is the post-pivot canonical artifact; the transcript variant stays
 *  as the cohort-A fallback for students whose DPR isn't accessible.
 *
 *  IMPORTANT: the `dpr` discriminator is recognized but not yet
 *  consumed at this route until Workstream 3 lands the
 *  `session.degreeProgressReport` injection + tool refactor. Until
 *  then we reject DPR-shaped requests early so the failure mode is
 *  loud, never silent profile-corruption. */
type ParsedDataPayload =
    | (TranscriptData & { kind?: undefined })
    | { kind: "transcript"; transcript: TranscriptData }
    | { kind: "dpr"; report: unknown };

interface V2RequestBody {
    message: string;
    parsedData?: ParsedDataPayload;
    visaStatus?: string;
    /** Phase 7-E temporal-context fix — collected during onboarding,
     *  free-form (e.g., "Spring 2027" or "spring2027"). Normalized
     *  into the prompt as `graduationTerm`. */
    graduationTarget?: string | null;
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
    // Phase 7-E W3.4 — discriminated parsedData. The DPR path is the
    // post-pivot canonical onboarding artifact; the transcript path
    // remains as the cohort-A fallback.
    const pd = body.parsedData;
    const isDprPayload = (
        pd: ParsedDataPayload,
    ): pd is { kind: "dpr"; report: DegreeProgressReport } =>
        pd && typeof pd === "object" && "kind" in pd && pd.kind === "dpr";
    const isTranscriptPayload = (
        pd: ParsedDataPayload,
    ): pd is { kind: "transcript"; transcript: TranscriptData } =>
        pd && typeof pd === "object" && "kind" in pd && pd.kind === "transcript";

    // Validate DPR payload shape lazily (the engine schema lives in the
    // engine package; we re-validate here to fail loudly on a bad
    // client rather than at the first tool call).
    let parsedDpr: DegreeProgressReport | undefined;
    if (isDprPayload(pd)) {
        const v = degreeProgressReportSchema.safeParse(pd.report);
        if (!v.success) {
            return NextResponse.json(
                {
                    error:
                        "DPR payload failed schema validation. Re-upload your DPR through onboarding " +
                        `(${v.error.issues.map((i) => i.path.join(".")).slice(0, 3).join(", ")}).`,
                },
                { status: 400 },
            );
        }
        parsedDpr = v.data;
    }

    // Unwrap the transcript-shaped discriminator so the legacy builder
    // sees the same flat shape it expected pre-W2. Pre-W2 callers
    // (no `kind`) continue to work unchanged.
    const transcriptPayload: TranscriptData = isTranscriptPayload(pd)
        ? pd.transcript
        : isDprPayload(pd)
            ? ({} as TranscriptData) // DPR path doesn't use this; legacy builder gets a stub
            : (pd as TranscriptData);

    const primary = createPrimaryClient();
    if (!primary) {
        // Phase 8 B5 — primary is no longer always OpenAI; the message
        // names whichever provider's key is needed by the configured
        // primary (default: Anthropic).
        const provider = (process.env.NYUPATH_PRIMARY_PROVIDER ?? "anthropic").toUpperCase();
        return NextResponse.json(
            { error: `${provider}_API_KEY not configured.` },
            { status: 503 },
        );
    }
    const fallback = createFallbackClient(); // null is OK — the loop tolerates a missing fallback.

    // Phase 7-E W12.5 — derive the canonical userId from the session
    // cookie if present (authenticated student). Fall back to the
    // body's per-browser UUID for the anonymous-mode path that cohort
    // A may still hit during operator self-testing. The cookie always
    // wins — a malicious client cannot escape rate-limit by sending a
    // forged body.userId once the user is signed in.
    const authClaims = await readSessionFromRequest(req);
    const userId = authClaims?.sub ?? body.userId ?? "anonymous";

    // Phase 7-E W10.5 — per-student daily rate limit (cohort-A cost
    // guard + abuse signal). 30 messages / UTC day default. With W12,
    // authenticated students get a per-NetID bucket; pre-auth callers
    // get a per-browser-UUID bucket; the literal "anonymous" id shares
    // one global bucket as a last resort.
    const rateCheck = consumeRequest(userId);
    if (!rateCheck.ok) {
        return NextResponse.json(
            {
                error:
                    `Daily message limit reached (${rateCheck.limit} per day). ` +
                    `Resets at ${rateCheck.resetAt}. ` +
                    `Reach out to your adviser for anything urgent in the meantime.`,
            },
            {
                status: 429,
                headers: {
                    "Retry-After": String(rateCheck.retryAfterSeconds),
                    "X-RateLimit-Limit": String(rateCheck.limit),
                    "X-RateLimit-Remaining": "0",
                    "X-RateLimit-Reset": rateCheck.resetAt,
                },
            },
        );
    }

    const stores = getStores();

    // Build the student profile. DPR path takes precedence; transcript
    // path is the fallback. When neither has a usable shape, we still
    // build a stub via the transcript builder for the legacy tests.
    const student = parsedDpr
        ? buildStudentProfileFromDpr(parsedDpr, {
            ...(body.visaStatus === "f1" || body.visaStatus === "domestic"
                ? { visaStatus: body.visaStatus }
                : {}),
        })
        : buildStudentProfileV2(transcriptPayload, body.visaStatus);
    const searchCoursesFn = getCourseSearchFn();
    const ragBundle = getPolicyRagBundle();
    // Phase 7-E reviewer-followup — load the home-school's config so
    // get_credit_caps + plan_semester can answer cap/floor questions.
    // Without this every tool that needs school-level data fell over
    // with "School config not loaded".
    const schoolConfig = (() => {
        try {
            return loadSchoolConfig(student.homeSchool);
        } catch {
            return null;
        }
    })();
    const session: ToolSession = {
        student,
        profileStore: stores.profileStore,
        ...(schoolConfig ? { schoolConfig } : {}),
        ...(ragBundle ? { rag: ragBundle } : {}),
        ...(searchCoursesFn ? { searchCoursesFn } : {}),
        ...(parsedDpr ? { degreeProgressReport: parsedDpr } : {}),
    } as ToolSession & {
        searchCoursesFn?: ReturnType<typeof getCourseSearchFn>;
    };
    // Phase 7-E + Phase 8 calendar fix — temporal context.
    // currentTerm + nextTerm come from the wall clock + NYU calendar
    // (independent of the DPR), so "next semester" resolves correctly
    // even when the student has pre-registered for a future term and
    // their DPR carries multiple IP-row terms. enrolledNowTerm +
    // preRegisteredTerms come from the DPR, disambiguated against
    // the wall clock.
    const now = new Date();
    const temporal = parsedDpr
        ? deriveTemporalContext(parsedDpr, { now })
        : { currentTerm: undefined, nextTerm: undefined };
    const graduationTerm = normalizeGraduationTarget(body.graduationTarget);
    const todayIso = now.toISOString().slice(0, 10);
    const systemPrompt = buildSystemPrompt({
        student,
        dprLoaded: parsedDpr !== undefined,
        today: todayIso,
        ...(temporal.currentTerm ? { currentTerm: temporal.currentTerm } : {}),
        ...(temporal.nextTerm ? { nextTerm: temporal.nextTerm } : {}),
        ...(temporal.enrolledNowTerm ? { enrolledNowTerm: temporal.enrolledNowTerm } : {}),
        ...(temporal.preRegisteredTerms && temporal.preRegisteredTerms.length > 0
            ? { preRegisteredTerms: temporal.preRegisteredTerms } : {}),
        ...(graduationTerm ? { graduationTerm } : {}),
    });

    // Phase 11 S3 — multi-intent detector. When the user's message
    // contains multiple distinct requests, prepend a briefing line
    // to the system prompt so the agent enumerates and addresses
    // each sub-question. Pure deterministic; no extra LLM call.
    const multiIntent = detectMultiIntent(body.message);
    const briefing = renderMultiIntentBriefing(multiIntent);
    const finalSystemPrompt = briefing
        ? `${systemPrompt}\n\n${briefing}`
        : systemPrompt;
    const templates = getTemplates();

    // Phase 7-A P-1 + Phase 7-B Step 8b: cohort gate. The store factory
    // checks Postgres first (when DATABASE_URL is set) and falls back
    // to the engine's in-memory `userInCohort()` otherwise.
    const cohort: Cohort = await stores.cohortLookup(userId);
    const cohortConfig = getCohortConfig(cohort);

    // Phase 7-B Step 9: read sessionSummaries and prepend as a system
    // priorMessage so the agent has cross-session continuity.
    let sessionSummaryContext: string | null = null;
    try {
        const record = await stores.sessionStore.get(userId);
        sessionSummaryContext = summariesAsPriorMessage(record, 3);
    } catch {
        // Session-store read failures must NOT break the live turn.
        sessionSummaryContext = null;
    }

    const { stream, writer } = createSseStream();

    // Phase 11 S4 — gated clarifier. Detect deterministic
    // ambiguity signals; if any fire, run the clarifier sub-agent
    // (single haiku call, no tools). When the clarifier returns a
    // question, stream it as the agent's reply for THIS turn and
    // skip the main agent loop. The student responds with detail,
    // and the next turn flows through the agent normally.
    const ambiguity = detectAmbiguity(body.message, body.history ?? []);
    if (ambiguity.ambiguous) {
        // Cheap haiku call — no tools, ~80 tokens out.
        const clarification = await askClarification(
            primary,
            body.message,
            body.history ?? [],
            {
                ...(student.homeSchool ? { homeSchool: student.homeSchool } : {}),
                declaredPrograms: student.declaredPrograms.map((p) => p.programId),
                ...(student.visaStatus ? { visaStatus: student.visaStatus } : {}),
            },
        ).catch((err) => {
            console.error("[clarifier] failed; falling back to agent loop", err);
            return null;
        });
        if (clarification && !clarification.isClear && clarification.output.length > 0) {
            // Stream the clarifying question + close the SSE.
            for (const tok of clarification.output.match(/.{1,40}/g) ?? []) {
                writer.write({ kind: "token", text: tok });
            }
            writer.write({ kind: "done", finalText: clarification.output, modelUsedId: primary.id });
            writer.close();
            return new NextResponse(stream, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache, no-transform",
                    Connection: "keep-alive",
                },
            });
        }
    }

    // Run the agent loop in the background; the SSE stream returns
    // immediately so the browser sees event flow from t=0.
    void runV2Turn({
        primary,
        fallback,
        session,
        systemPrompt: finalSystemPrompt,
        templates,
        userMessage: body.message,
        history: body.history,
        correlationId: body.correlationId,
        cohort,
        cohortGateFailing: cohortConfig.evalGateFailing,
        sessionSummaryContext,
        userId,
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
    /** Phase 7-B Step 9 — formatted sessionSummaries prefix or null. */
    sessionSummaryContext: string | null;
    /** Phase 7-E W12.5 — canonical student id (cookie-derived when
     *  authenticated, per-browser UUID otherwise). Used for the
     *  end-of-turn appendSummary call. */
    userId: string;
    writer: SseWriter;
}

async function runV2Turn(args: V2TurnArgs): Promise<void> {
    const { primary, fallback, session, systemPrompt, templates, userMessage, history, correlationId, cohort, cohortGateFailing, sessionSummaryContext, userId, writer } = args;
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

        // Phase 8 Stage A1 — preLoopDispatch DEMOTED.
        // Pre-Phase-8 we ran a keyword/similarity matcher BEFORE the
        // agent loop and short-circuited with template.body when it
        // hit. That hijacked DPR-grounded questions ("how many P/F
        // have I used?" matched cas_pf_career_cap → returned bulletin
        // verbatim → DPR never consulted, student's actual usage
        // ("4 of 32") never surfaced).
        //
        // Architectural inspiration: Claude Code (recovered-src/src/
        // query.ts:307) goes straight to the model. Tool descriptions
        // + reasoning route, not keyword matchers. We follow the same
        // pattern: every question now enters the agent loop, which
        // calls run_full_audit / search_policy / etc. as needed.
        // search_policy already consults the same template registry
        // internally (rag/policySearch.ts:111) — so curated bulletin
        // quotes are still surfaced when relevant, but the AGENT
        // decides whether to quote them, blend with DPR data, or skip.
        //
        // Recovery mode (cohortConfig.evalGateFailing, above) keeps
        // template-only routing because in that mode we deliberately
        // disable LLM behavior.

        // Convert prior history (from the client) into LLMMessages.
        // Phase 7-B Step 9: prepend the formatted sessionSummaries
        // (when a record exists) as a leading system message so the
        // agent has cross-session continuity per §7.3.
        const priorMessages: LLMMessage[] = [
            ...(sessionSummaryContext
                ? [{ role: "system" as const, content: sessionSummaryContext }]
                : []),
            ...(history ?? []).map((h) => ({
                role: h.role,
                content: h.content,
            })),
        ];

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
                // Phase 9 Stage 3 — bumped from 8 to 10 to give the agent
                // headroom for the new "audit → search_policy → synthesize"
                // multi-tool flows. Stage-2 nudge tells it to call
                // search_policy at most twice per requirement gap, but
                // multiple gaps in one question (CS Required + Texts &
                // Ideas + joint major roll-up) can chain through 4-6 calls.
                maxTurns: 10,
                // Phase 7-E W11 reviewer P1-2 — emit observability events
                // to the JSONL sink so the operator dashboard at
                // /admin/observability has signal during cohort A.
                fallbackSink: getFallbackSink(),
                // Phase 7-B Step 19 — stop-hook re-prompt. The loop
                // calls this when it has a final reply; if the verdict
                // is not-ok AND there's replay budget, the loop appends
                // a system message describing the violations and runs
                // one more pass before returning. Defaults to limit=1.
                validatorReplayLimit: 1,
                validateResponse: ({ assistantText, invocations, session: s }) => {
                    const verdict = validateResponse({
                        assistantText,
                        invocations,
                        student: s.student,
                        // Phase 10 F4c — pass the user's last message so
                        // the verbatim-drift check can skip when the
                        // verbatim is topically irrelevant.
                        userQuestion: body.message,
                    });
                    return {
                        ok: verdict.ok,
                        violations: verdict.violations.map((v) => ({
                            kind: v.kind,
                            detail: v.detail,
                        })),
                    };
                },
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

        // Phase 7-B Step 18 — Tier-3 graceful termination. Surface a
        // `done` event so the UI can render the polite "start a new
        // session" reply instead of an error.
        if (finalResult && finalResult.kind === "context_limit") {
            writer.write({
                kind: "done",
                finalText: finalResult.finalText,
                modelUsedId: `${finalResult.modelUsedId}:context_limit`,
            });
            writer.close();
            return;
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
            // Phase 10 F4c — thread the user's last message for
            // topical-relevance gating in checkVerbatim.
            userQuestion: body.message,
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

        // Phase 7-E W12.5 — persist a short rolling session summary so
        // the next chat sees minimal cross-session context. We DON'T
        // make a separate LLM call here (the cohort-A cost guard would
        // double on every turn); instead we write a heuristic marker
        // that captures intent + tools called. Authenticated user only
        // — anonymous "userId === 'anonymous'" should not write to
        // shared storage.
        if (userId !== "anonymous") {
            try {
                const toolNames = Array.from(new Set(finalResult.invocations.map((i) => i.toolName)));
                const userSnippet = userMessage.slice(0, 140).replace(/\s+/g, " ").trim();
                const summary =
                    `Asked: "${userSnippet}${userMessage.length > 140 ? "…" : ""}". ` +
                    `Tools called: ${toolNames.length > 0 ? toolNames.join(", ") : "none"}.`;
                await stores.sessionStore.appendSummary(userId, {
                    date: new Date().toISOString().slice(0, 10),
                    summary,
                });
            } catch (e) {
                // A failed summary write must NOT break the live turn.
                // The dashboard will surface the underlying error via
                // fallback_log if anything systemic is wrong.
                console.error("[v2 route] appendSummary failed:", e);
            }
        }
    } catch (err) {
        writer.write({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
        });
    } finally {
        writer.close();
    }
}
