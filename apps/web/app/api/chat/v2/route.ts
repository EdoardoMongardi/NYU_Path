// ============================================================
// /api/chat/v2 — Phase 6.1 WS2
// ============================================================
// New endpoint that drives the Phase 5 agent loop (`runAgentTurn`)
// against the production `OpenAIEngineClient`. Returns Server-Sent
// Events: per-tool `tool_invocation_start` / `tool_invocation_done`,
// `validator_block` when the response validator blocks the reply, and
// finally `token` + `done`.
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
    // Phase 8 A1: preLoopDispatch (the keyword/template router) was
    // removed from the active path — every question enters the agent
    // loop. runRecoveryMode handles the cohort-gate-failing path.
    validateResponse,
    reviewCompleteness,
    createPrimaryClient,
    createFallbackClient,
    getCohortConfig,
    runRecoveryMode,
    summariesAsPriorMessage,
    JsonlFileSink,
    type FallbackSink,
    type ToolSession,
    type LLMMessage,
    type ToolInvocation,
    type Cohort,
} from "@nyupath/engine";
import {
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
    buildStudentProfileFromDpr,
} from "../../../../lib/buildSession";
import { createSseStream, type SseWriter } from "../../../../lib/sseStream";
import { getCourseSearchFn } from "../../../../lib/courseCatalogSearch";
import { getCatalog } from "../../../../lib/loadCatalog";
import { getStores } from "../../../../lib/db/store";
import { getPolicyRagBundle } from "../../../../lib/policyRagSetup";
import { consumeRequest } from "../../../../lib/rateLimit";
import { readSessionFromRequest } from "../../../../lib/auth/session";
import { extractPendingMutationId } from "../../../../lib/chatV2Client";

// Required for SSE — Node.js streaming, NOT edge runtime (the OpenAI
// SDK uses Node streams that the edge runtime doesn't support).
export const runtime = "nodejs";

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

/** Onboarding artifact. DPR-only: the Albert Degree Progress Report is
 *  the sole accepted onboarding artifact. The legacy transcript variant
 *  has been removed — the DPR carries everything the transcript did plus
 *  declared programs and NYU's pre-computed audit. */
type ParsedDataPayload = { kind: "dpr"; report: unknown };

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
    // DPR-only: a valid Degree Progress Report is required to reach the
    // agent. There is no transcript fallback — if the client hasn't
    // completed DPR onboarding, ask them to do so and stop here.
    const pd = body.parsedData;
    const isDprPayload = (
        pd: ParsedDataPayload | undefined,
    ): pd is { kind: "dpr"; report: DegreeProgressReport } =>
        !!pd && typeof pd === "object" && "kind" in pd && pd.kind === "dpr";

    if (!isDprPayload(pd)) {
        return NextResponse.json(
            {
                error:
                    "I need your Albert Degree Progress Report (DPR) before we can chat about your record. " +
                    "Please upload it through onboarding (Albert → Academics → Planning Tools → Degree Progress Report).",
                onboardingStep: "awaiting_dpr",
            },
            { status: 400 },
        );
    }

    // Validate DPR payload shape lazily (the engine schema lives in the
    // engine package; we re-validate here to fail loudly on a bad
    // client rather than at the first tool call).
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
    const parsedDpr: DegreeProgressReport = v.data;

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

    // Build the student profile from the DPR (the only onboarding artifact).
    const student = buildStudentProfileFromDpr(parsedDpr, {
        // RC: studentIdOverride MUST track the auth subject so every
        // persistence write keys on the SAME id the restore route
        // reads from. Without this, tools persist under the slugified
        // DPR-name id while restore reads from auth.sub → split rows
        // in `students` / `forward_schedules` / `chat_messages`.
        // See May 2026 post-mortem (DB-split bug).
        studentIdOverride: userId,
        ...(body.visaStatus === "f1" || body.visaStatus === "domestic"
            ? { visaStatus: body.visaStatus }
            : {}),
    });
    const searchCoursesFn = getCourseSearchFn();
    const ragBundle = getPolicyRagBundle();
    // Phase 7-E reviewer-followup — load the home-school's config so
    // get_credit_caps + plan_forward_degree can answer cap/floor
    // questions. Without this every tool that needs school-level data
    // fell over with "School config not loaded".
    const schoolConfig = (() => {
        try {
            return loadSchoolConfig(student.homeSchool);
        } catch {
            return null;
        }
    })();
    // Load the engine catalog (courses + prereqs) into the session.
    // The forward planner reads course titles/credits + prereqs from
    // these maps. Module-cached; file-read failures degrade to an empty
    // catalog so a missing data file can't break the turn.
    const catalog = (() => {
        try {
            return getCatalog();
        } catch {
            return null;
        }
    })();
    const session: ToolSession = {
        student,
        profileStore: stores.profileStore,
        // Phase 16 Task A — durable schedule + chat-history. The
        // schedule store is read by plan_forward_degree +
        // confirm_plan_change after a successful tool call (no-throw
        // persistence). The chat-history store is written by this
        // route AFTER the agent loop finishes (post-`done` event)
        // — tools never write to it directly.
        scheduleStore: stores.scheduleStore,
        chatHistoryStore: stores.chatHistoryStore,
        // Phase 11 follow-up — thread the latest user message so
        // tool validateInput hooks can apply scope guards based on the
        // user's intent. Generic across all tools.
        lastUserMessage: body.message,
        ...(schoolConfig ? { schoolConfig } : {}),
        ...(catalog ? { courses: catalog.courses, prereqs: catalog.prereqs } : {}),
        ...(ragBundle ? { rag: ragBundle } : {}),
        ...(searchCoursesFn ? { searchCoursesFn } : {}),
        ...(parsedDpr ? { degreeProgressReport: parsedDpr } : {}),
    } as ToolSession & {
        searchCoursesFn?: ReturnType<typeof getCourseSearchFn>;
    };

    // RC: persist the parsed DPR + profile at session bootstrap so it
    // survives a refresh / new login. Previously, persistence only
    // landed when the user confirmed a profile mutation (the
    // `confirm_profile_update` two-step flow). Initial onboarding
    // never triggers that flow, so `students.profile` and
    // `students.parsed_dpr` stayed null and `/api/session/restore`
    // returned an empty payload on every refresh.
    //
    // No-throw: persistence failures don't break the live turn.
    if (parsedDpr && userId !== "anonymous") {
        try {
            await stores.profileStore.persistMutation(
                student,
                {
                    pendingMutationId: `bootstrap-${Date.now()}`,
                    field: "homeSchool" as const, // discriminator unused at restore — we just need a row
                    before: null,
                    after: student.homeSchool,
                    confirmedAt: new Date().toISOString(),
                },
                parsedDpr,
            );
        } catch (err) {
            console.warn(
                `[v2 route] bootstrap persistMutation failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

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
    // Stash the normalized term on the session so plan_forward_degree
    // can default `graduationTermOverride` to the student's onboarding-
    // stated value when the LLM forgets to pass it. Without this fall-
    // back the planner derives graduationTerm from creditsEarned alone,
    // which collapses to currentTerm+1 for any student already past
    // their credit minimum and produces a too-narrow window that flips
    // the schedule to `infeasible-draft` for spurious credit-ceiling
    // reasons. (See May 2026 graduation-term-default post-mortem.)
    if (graduationTerm) {
        session.graduationTarget = graduationTerm;
    }
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
        userMessage: body.message,
        history: body.history,
        correlationId: body.correlationId,
        cohort,
        cohortGateFailing: cohortConfig.evalGateFailing,
        sessionSummaryContext,
        userId,
        sessionStore: stores.sessionStore,
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
    /** Session-summary store, threaded from the POST handler's
     *  `getStores()` bundle. runV2Turn runs outside the POST handler's
     *  scope, so it can't reach the handler-local `stores`; pass the
     *  store it needs explicitly so the end-of-turn appendSummary writes
     *  to the same instance the rest of the route uses. */
    sessionStore: ReturnType<typeof getStores>["sessionStore"];
    writer: SseWriter;
}

async function runV2Turn(args: V2TurnArgs): Promise<void> {
    const { primary, fallback, session, systemPrompt, userMessage, history, correlationId, cohort, cohortGateFailing, sessionSummaryContext, userId, sessionStore, writer } = args;
    if (!primary) {
        writer.write({ kind: "error", message: "primary LLM client not configured" });
        writer.close();
        return;
    }
    try {
        // §12.6.5 — recovery mode. When the user's cohort has
        // `evalGateFailing: true` (e.g., the production composite dropped
        // below 0.90), the agent loop is disabled. The curated template
        // corpus was removed, so there's no degraded answer path — we
        // surface a transparent "limited availability" reply.
        if (cohortGateFailing) {
            const recovery = runRecoveryMode(userMessage, session);
            writer.write({ kind: "token", text: recovery.reply });
            writer.write({ kind: "done", finalText: recovery.reply, modelUsedId: `cohort:${cohort}:limited` });
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
        // search_policy is pure RAG over the bulletin corpus (the
        // curated template registry was removed) — the AGENT decides
        // when to call it and whether to quote, blend with DPR data,
        // or skip.
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
        // Phase 16 Task A — accumulate thinking-delta text so it can be
        // persisted alongside the assistant turn. The stream emits
        // thinking_delta events inline; we only need the joined string
        // for the chat_messages.thinking_text column.
        const thinkingChunks: string[] = [];

        // Phase 13 Task 9 — capture forwardSchedule.computedAt before
        // the agent runs so we can detect when plan_forward_degree (or
        // any tool) writes a new schedule to session.forwardSchedule.
        const beforeComputedAt = session.forwardSchedule?.computedAt;
        // RC-5 (May 2026 post-mortem) — same snapshot for the
        // infeasible-draft slot per Decision #32. When the solver
        // produces an infeasible plan it lands in `session.studentDraftPlan`,
        // not `session.forwardSchedule`. Without this snapshot the UI never
        // surfaces the draft and the student has no way to inspect why
        // their plan failed feasibility (e.g. credit-cap overflow). Sidebar
        // already renders the infeasible-draft banner from `state`.
        const beforeDraftComputedAt = session.studentDraftPlan?.computedAt;
        // Phase 15 Task 8 — same pattern for the materialization
        // side-channel. `materialize_sections.call()` writes to
        // `session.lastMaterializationResult` as a side-effect of
        // staging proposals. Capture the timestamp now so we can detect
        // when the agent ran the tool this turn.
        const beforeMaterializationComputedAt = session.lastMaterializationResult?.computedAt;

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
                // Phase 9 — the streaming loop has no output-truncation
                // recovery (unlike the block path), so a final answer that
                // exceeds maxTokens is simply cut off for the user. The old
                // 1024 default truncated long advising replies (acute now
                // that Sonnet — our new primary — writes richer, longer
                // answers: the live eval's Q1/Q3 ran ~2-2.5k tokens). Lift
                // the cap to 4096 so complete answers reach the user; it
                // still bounds runaway output.
                maxTokens: 4096,
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
                        userQuestion: userMessage,
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
                case "thinking_delta":
                    writer.write({ kind: "thinking", text: ev.text });
                    thinkingChunks.push(ev.text);
                    break;
                case "text_delta":
                    writer.write({ kind: "token", text: ev.text });
                    break;
                case "done":
                    finalResult = ev.result;
                    break;
            }
        }

        // Phase 13 Task 9 — emit forward_schedule_update when the
        // schedule was computed (or updated) this turn. The schedule is
        // written to session.forwardSchedule by plan_forward_degree /
        // reconcile tools. Emit before the done/error path so the UI
        // sidebar can display the plan before the final text is written.
        //
        // RC-5: when only the infeasible-draft slot changed (Decision #32),
        // emit the draft so the student can still inspect what went wrong.
        // The sidebar's existing 4-state banner (valid-clean /
        // valid-with-trade-offs / infeasible-draft / student-preferred-
        // invalid-draft) keys off `schedule.state`, so the same event
        // shape works for both slots. Prefer the valid plan when both
        // changed in the same turn (rare but possible with reconcile).
        const afterComputedAt = session.forwardSchedule?.computedAt;
        const scheduleChanged =
            session.forwardSchedule !== undefined
            && (beforeComputedAt === undefined || beforeComputedAt !== afterComputedAt);
        const afterDraftComputedAt = session.studentDraftPlan?.computedAt;
        const draftChanged =
            session.studentDraftPlan !== undefined
            && (beforeDraftComputedAt === undefined || beforeDraftComputedAt !== afterDraftComputedAt);
        if (scheduleChanged) {
            writer.write({
                kind: "forward_schedule_update",
                schedule: session.forwardSchedule!,
            });
        } else if (draftChanged) {
            writer.write({
                kind: "forward_schedule_update",
                schedule: session.studentDraftPlan!,
            });
        }

        // Phase 15 Task 8 — emit forward_materialization_update when
        // materialize_sections ran this turn. The tool writes its
        // result (full / partial / unavailable) to
        // session.lastMaterializationResult so the route doesn't have
        // to inspect each invocation's args/result manually. The page's
        // sidebar reads the event into `forwardMaterialization` state
        // and switches the immediate term's render path accordingly.
        const afterMaterializationComputedAt = session.lastMaterializationResult?.computedAt;
        const materializationChanged =
            session.lastMaterializationResult !== undefined
            && (beforeMaterializationComputedAt === undefined
                || beforeMaterializationComputedAt !== afterMaterializationComputedAt);
        if (materializationChanged) {
            writer.write({
                kind: "forward_materialization_update",
                result: session.lastMaterializationResult!,
            });
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
            userQuestion: userMessage,
        });

        // Phase 12.5 Task 4 — completeness reviewer. Runs after
        // validateResponse so envelope-metadata drops (missing
        // disclaimers / bulletin anchors) are surfaced as
        // `incompleteness` violations alongside the existing validator
        // violations. Same `validator_block` event, no new event kind.
        const completenessVerdict = reviewCompleteness(
            finalResult.finalText,
            finalResult.invocations,
        );
        const completenessViolations = completenessVerdict.pass
            ? []
            : [
                {
                    kind: "incompleteness" as const,
                    detail: completenessVerdict.retryGuidance,
                },
            ];

        const allViolations = [
            ...verdict.violations.map((v) => ({
                kind: v.kind,
                detail: v.detail,
                ...(v.caveatId ? { caveatId: v.caveatId } : {}),
                ...(v.number ? { number: v.number } : {}),
            })),
            ...completenessViolations,
        ];
        const allOk = verdict.ok && completenessVerdict.pass;

        // Phase 11 follow-up — when the validator catches fabricated
        // bulletin attribution AFTER the replay budget is spent, strip
        // the offending blockquote from the final text rather than
        // streaming a known-wrong citation to the student. The UI
        // still gets a `validator_block` event so the warning is
        // logged. Generic across every fabrication (any tool, any
        // school, any policy).
        let finalTextOut = finalResult.finalText;
        if (!allOk) {
            const fabrications = verdict.violations.filter((v) => v.kind === "fabricated_attribution");
            for (const _f of fabrications) {
                finalTextOut = stripFabricatedBlockquotes(finalTextOut);
            }
            writer.write({
                kind: "validator_block",
                violations: allViolations,
            });
        }

        writer.write({
            kind: "done",
            finalText: finalTextOut,
            modelUsedId: finalResult.modelUsedId,
        });

        // Phase 16 Task A — append the user message + assistant
        // response (plus tool invocations + validator violations +
        // thinking text) to the durable chat-history store so a
        // returning student sees the same transcript next session.
        // Authenticated user only — anonymous "userId === 'anonymous'"
        // should not write to shared storage. Failures must NOT break
        // the live turn.
        if (userId !== "anonymous" && session.chatHistoryStore) {
            try {
                const nowIso = new Date().toISOString();
                // Persist the user's message first so the timeline
                // ordering (user → assistant) is preserved on restore.
                await session.chatHistoryStore.appendMessage(userId, {
                    role: "user",
                    content: userMessage,
                    createdAt: nowIso,
                });
                // pendingMutationId — surfaced by `update_profile`. Mirror
                // the client-side extractor in chatV2Client so the page's
                // restore path sees the same id and can re-render the
                // confirm button without recomputing.
                const updateProfileInvocation = finalResult.invocations.find(
                    (i) => i.toolName === "update_profile",
                );
                const pendingMutationId = updateProfileInvocation
                    ? extractPendingMutationId(updateProfileInvocation.summary)
                    : null;
                const assistantRecord: import("@nyupath/engine").ChatMessageRecord = {
                    role: "assistant",
                    content: finalTextOut,
                    createdAt: new Date().toISOString(),
                };
                const thinkingText = thinkingChunks.join("");
                if (thinkingText.length > 0) {
                    assistantRecord.thinkingText = thinkingText;
                }
                if (finalResult.invocations.length > 0) {
                    assistantRecord.toolInvocations = finalResult.invocations;
                }
                if (allViolations.length > 0) {
                    assistantRecord.validatorViolations = allViolations.map((v) => {
                        const out: { kind: string; detail: string; caveatId?: string } = {
                            kind: v.kind,
                            detail: v.detail,
                        };
                        if ("caveatId" in v && typeof v.caveatId === "string") {
                            out.caveatId = v.caveatId;
                        }
                        return out;
                    });
                }
                if (pendingMutationId) {
                    assistantRecord.pendingMutationId = pendingMutationId;
                }
                await session.chatHistoryStore.appendMessage(userId, assistantRecord);
            } catch (e) {
                // A failed transcript write must NOT break the live turn.
                console.error("[v2 route] chatHistoryStore.appendMessage failed:", e);
            }
        }

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
                await sessionStore.appendSummary(userId, {
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

// ============================================================
// Phase 11 follow-up — fabricated-attribution substitution
// ============================================================
// When the post-loop validator catches a `fabricated_attribution`
// violation and the replay budget is exhausted, we strip every
// blockquote attributed to a bulletin/policy source from the final
// text so the student doesn't see a known-wrong citation. A short
// substitution paragraph informs them. Generic across every
// fabrication shape (any school, any policy, any tool).
const ATTRIBUTION_LINE_RE = /^\s*(?:.*\b(?:per|according to|from|as stated in|the (?:cas )?bulletin|the policy|the catalog).*?:?\s*)?$/i;
const BLOCKQUOTE_LINE_RE = /^>\s*(.*)$/;

function stripFabricatedBlockquotes(text: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    let droppedAny = false;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i]!;
        if (BLOCKQUOTE_LINE_RE.test(line)) {
            // Drop this blockquote group and the immediately preceding
            // attribution-introduction line (e.g., "Per the bulletin:").
            droppedAny = true;
            if (out.length > 0 && ATTRIBUTION_LINE_RE.test(out[out.length - 1]!)) {
                out.pop();
            }
            while (i < lines.length && BLOCKQUOTE_LINE_RE.test(lines[i]!)) i++;
            continue;
        }
        out.push(line);
        i++;
    }
    if (!droppedAny) return text;
    out.push("");
    out.push(
        "_(Note: a bulletin quotation was removed because the agent could not " +
        "verify it against the indexed corpus. Please confirm the underlying " +
        "policy with your academic adviser before relying on it.)_",
    );
    return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
