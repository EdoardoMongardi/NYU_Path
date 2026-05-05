// ============================================================
// /api/plan/explain-polish — Phase 17 Task D
// ============================================================
// LLM polish stream for the inline confirm bubble. The 5 propose
// routes return a deterministic template explanation in 180-600ms;
// the page renders it INSTANTLY in a `plan_action_bubble` message.
// After the bubble appears, the page fires a fire-and-forget POST
// here. This route streams a more natural rewrite back via the
// browser fetch+ReadableStream API; the page replaces the template
// text with the polished version once it lands.
//
// Constrained system prompt (`apps/web/lib/llmPolishPrompt.ts`)
// locks the model to "rephrase, do NOT add new facts; preserve every
// course code and credit number verbatim." Cardinal Rule §2.1
// anchor.
//
// GATING: the polish call is gated by the
// `NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH=1` env flag. When OFF, the
// route returns 204 No Content so the client can fire-and-forget
// without burning Anthropic tokens. The page-side ENV-gate is
// authoritative — this route's gate is defense-in-depth.
//
// Streaming format: SSE blocks compatible with the v2 chat stream
// (`apps/web/lib/sseStream.ts`). Two event kinds:
//   - `plan_action_explanation_polish_chunk` — incremental text
//   - `plan_action_explanation_polish_done` — final text + close
// Errors stream as a `plan_action_explanation_polish_error` event.
// ============================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { readSessionFromRequest } from "../../../../lib/auth/session";
import { consumeRequest } from "../../../../lib/rateLimit";
import {
    LLM_POLISH_SYSTEM_PROMPT,
    LLM_POLISH_MAX_TOKENS,
    LLM_POLISH_MODEL_ID,
    buildPolishUserMessage,
} from "../../../../lib/llmPolishPrompt";

export const runtime = "nodejs";

const InputSchema = z.object({
    /** Stable identifier for the slot the bubble is anchored to. The
     *  client echoes this back into the SSE event payload so a
     *  multi-bubble UI can route the polish to the right bubble. */
    slotKey: z.string().min(1).max(200),
    /** The deterministic template explanation rendered by the
     *  engine's `explainPlanDiff` helper. Copied verbatim into the
     *  Anthropic user message. */
    templateText: z.string().min(1).max(4000),
    /** Optional structured PlanDiff serialized as JSON. Passed to the
     *  model only as disambiguation context; the system prompt
     *  forbids the model from adding facts beyond what the template
     *  already states. */
    structuredDiff: z.unknown().optional(),
});

const PLAN_POLISH_LIMIT_PER_DAY = 200;
const PLAN_POLISH_BUCKET_PREFIX = "plan-polish";

/**
 * The polish route streams its own SSE channel (it is NOT shared
 * with the v2 chat stream — see `sseStream.ts` for that one). Two
 * event kinds + an error kind. JSON-encoded payloads.
 */
type PolishSseEvent =
    | { kind: "plan_action_explanation_polish_chunk"; slotKey: string; deltaText: string }
    | { kind: "plan_action_explanation_polish_done"; slotKey: string; polishedText: string }
    | { kind: "plan_action_explanation_polish_error"; slotKey: string; message: string };

function encodeEvent(ev: PolishSseEvent): Uint8Array {
    const eventLine = `event: ${ev.kind}\n`;
    const dataLine = `data: ${JSON.stringify(ev)}\n\n`;
    return new TextEncoder().encode(eventLine + dataLine);
}

export async function POST(req: NextRequest): Promise<Response> {
    // Auth gate — same as every plan-action route.
    const auth = await readSessionFromRequest(req);
    if (!auth) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    }
    const studentId = auth.sub;

    // Rate-limit (separate bucket from chat / plan-action). Polish
    // calls are cheap but the page may fire one per click; cap to
    // PLAN_POLISH_LIMIT_PER_DAY per student per UTC day.
    const rate = consumeRequest(`${PLAN_POLISH_BUCKET_PREFIX}:${studentId}`, PLAN_POLISH_LIMIT_PER_DAY);
    if (!rate.ok) {
        return new Response(
            JSON.stringify({
                error: `Polish quota exhausted for today (${rate.limit}). Try again after ${rate.resetAt}.`,
            }),
            {
                status: 429,
                headers: {
                    "Content-Type": "application/json",
                    "Retry-After": String(rate.retryAfterSeconds),
                },
            },
        );
    }

    // Defense-in-depth ENV gate. The page is authoritative; if it
    // fired anyway, return 204 so the fetch resolves cleanly without
    // any tokens being burned.
    const polishEnabled = process.env.NEXT_PUBLIC_PLAN_CHANGE_LLM_POLISH === "1"
        || process.env.PLAN_CHANGE_LLM_POLISH === "1";
    if (!polishEnabled) {
        return new Response(null, { status: 204 });
    }

    // Parse body.
    let raw: unknown;
    try {
        raw = await req.json();
    } catch (err) {
        return new Response(
            JSON.stringify({ error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` }),
            { status: 400, headers: { "Content-Type": "application/json" } },
        );
    }
    let parsed: z.infer<typeof InputSchema>;
    try {
        parsed = InputSchema.parse(raw);
    } catch (err) {
        return new Response(
            JSON.stringify({ error: `Invalid request body: ${err instanceof Error ? err.message : String(err)}` }),
            { status: 400, headers: { "Content-Type": "application/json" } },
        );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        return new Response(
            JSON.stringify({ error: "ANTHROPIC_API_KEY missing — polish unavailable." }),
            { status: 503, headers: { "Content-Type": "application/json" } },
        );
    }

    const userMessage = buildPolishUserMessage({
        templateText: parsed.templateText,
        structuredDiffJson: parsed.structuredDiff !== undefined
            ? JSON.stringify(parsed.structuredDiff).slice(0, 2000)
            : undefined,
    });

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                const client = new Anthropic({ apiKey });
                const anthroStream = client.messages.stream({
                    model: LLM_POLISH_MODEL_ID,
                    max_tokens: LLM_POLISH_MAX_TOKENS,
                    temperature: 0.2,
                    system: LLM_POLISH_SYSTEM_PROMPT,
                    messages: [{ role: "user", content: userMessage }],
                });
                let acc = "";
                for await (const ev of anthroStream) {
                    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
                        const delta = ev.delta.text;
                        acc += delta;
                        controller.enqueue(encodeEvent({
                            kind: "plan_action_explanation_polish_chunk",
                            slotKey: parsed.slotKey,
                            deltaText: delta,
                        }));
                    }
                }
                controller.enqueue(encodeEvent({
                    kind: "plan_action_explanation_polish_done",
                    slotKey: parsed.slotKey,
                    polishedText: acc.trim(),
                }));
                controller.close();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                try {
                    controller.enqueue(encodeEvent({
                        kind: "plan_action_explanation_polish_error",
                        slotKey: parsed.slotKey,
                        message: msg,
                    }));
                } catch { /* already closed */ }
                try { controller.close(); } catch { /* already closed */ }
            }
        },
    });

    return new Response(stream, {
        status: 200,
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    });
}
