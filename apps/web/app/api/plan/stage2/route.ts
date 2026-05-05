// ============================================================
// /api/plan/stage2 — Phase 17 Task D follow-up
// ============================================================
// Stage 2 of the two-stage validation pipeline.
//
// Stage 1 (the propose routes — /api/plan/add|swap|drop|lock|move)
// runs the structural validator synchronously and returns a
// `futureTerms[]` hint identifying which terms in the proposed
// schedule fall within the FOSE data window. Stage 2 takes that
// hint, runs `materialize_sections` per term in the background, and
// streams one enrichment signal per term back to the bubble.
//
// The signals are best-effort: a 5xx from FOSE for one term doesn't
// block the bubble's Confirm button — the user already has all the
// structural information they need to decide. Stage 2 just adds
// "✓ open sections exist" / "⚠ no open sections" / "ℹ section
// data unavailable" annotations as they land.
//
// Streaming format mirrors /api/plan/explain-polish: SSE blocks
// with `event: <kind>` + `data: <JSON>` separated by `\n\n`. Two
// event kinds:
//   - `plan_action_stage2_enrichment` — one per term
//   - `plan_action_stage2_done` — terminator after every term has
//     produced an enrichment event
//
// Auth + rate-limit: same pattern as the propose routes (401 on
// missing session; 429 on per-day quota exhaustion). The Stage 2
// bucket is separate from chat / plan-action so Stage 2 fan-out
// from a single click can't drain the propose-side quota.
// ============================================================

import { NextRequest } from "next/server";
import { z } from "zod";
import {
    materializeSections,
    type MaterializationResult,
} from "@nyupath/engine";
import type { ScheduleSlot } from "@nyupath/shared";
import { readSessionFromRequest } from "../../../../lib/auth/session";
import { consumeRequest } from "../../../../lib/rateLimit";
import { getStores } from "../../../../lib/db/store";

export const runtime = "nodejs";

const InputSchema = z.object({
    /** Stable bubble identifier echoed back into every SSE event so
     *  the page-side reducer can route enrichment signals to the
     *  right bubble. Mirrors `/api/plan/explain-polish`. */
    slotKey: z.string().min(1).max(200),
    /** Solver-format term identifiers (e.g. "2026-fall"). One Stage 2
     *  signal is emitted per term in this list. */
    futureTerms: z.array(z.string().min(1).max(50)).min(1).max(8),
});

const STAGE2_LIMIT_PER_DAY = 200;
const STAGE2_BUCKET_PREFIX = "plan-stage2";

/** Per-event payload streamed to the bubble. */
type Stage2SseEvent =
    | {
        kind: "plan_action_stage2_enrichment";
        slotKey: string;
        term: string;
        status: "pending" | "ok" | "warn" | "unavailable";
        message: string;
    }
    | { kind: "plan_action_stage2_done"; slotKey: string };

function encodeEvent(ev: Stage2SseEvent): Uint8Array {
    const eventLine = `event: ${ev.kind}\n`;
    const dataLine = `data: ${JSON.stringify(ev)}\n\n`;
    return new TextEncoder().encode(eventLine + dataLine);
}

/**
 * Translate a `MaterializationResult` into the bubble's terse
 * signal vocabulary. Pure function — testable and easy to extend
 * (e.g. a future "⚠ Time conflict with [other course]" status).
 */
function classifyMaterialization(
    term: string,
    result: MaterializationResult,
): { status: "ok" | "warn" | "unavailable"; message: string } {
    if (result.state === "unavailable") {
        return {
            status: "unavailable",
            message: `[${term}] section data unavailable for this term yet.`,
        };
    }
    if (result.state === "partial") {
        return {
            status: "warn",
            message: `[${term}] courses listed but meeting times not fully published.`,
        };
    }
    // state === "full"
    const semester = result.semester;
    if (!semester || semester.combinations.length === 0) {
        return {
            status: "warn",
            message: `[${term}] no conflict-free combinations — only waitlists or time conflicts.`,
        };
    }
    return {
        status: "ok",
        message: `[${term}] open sections exist (${semester.combinations.length} conflict-free combinations).`,
    };
}

/**
 * Pluck specific_planned courseIds from the proposed schedule for
 * the given term. Returns an empty array when the term doesn't
 * exist or has no concrete courses (placeholder-only term).
 */
function pickCourseIdsForTerm(
    schedule: { semesters: Array<{ term: string; slots: ScheduleSlot[] }> },
    term: string,
): string[] {
    const semester = schedule.semesters.find((s) => s.term === term);
    if (!semester) return [];
    const ids: string[] = [];
    for (const slot of semester.slots) {
        if (slot.kind === "specific_planned") {
            ids.push(slot.courseId);
        }
    }
    return ids;
}

export async function POST(req: NextRequest): Promise<Response> {
    // Auth gate.
    const auth = await readSessionFromRequest(req);
    if (!auth) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
        });
    }
    const studentId = auth.sub;

    // Rate-limit (separate bucket from chat / plan-action / polish).
    const rate = consumeRequest(`${STAGE2_BUCKET_PREFIX}:${studentId}`, STAGE2_LIMIT_PER_DAY);
    if (!rate.ok) {
        return new Response(
            JSON.stringify({
                error: `Stage 2 quota exhausted for today (${rate.limit}). Try again after ${rate.resetAt}.`,
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

    // Parse + validate body.
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

    // Load forwardSchedule (the source of courseIds-per-term) +
    // schedulePreferences (passed verbatim to the orchestrator).
    const stores = getStores();
    let schedule: { semesters: Array<{ term: string; slots: ScheduleSlot[] }> } | null = null;
    try {
        const loaded = await stores.scheduleStore.loadLatestSchedule(studentId);
        if (loaded) schedule = loaded.schedule;
    } catch {
        // Best-effort — fall through with null; we'll emit unavailable
        // for every term.
    }
    let schedulingPreferences: import("@nyupath/shared").SchedulingPreferences | undefined;
    try {
        const prefs = await stores.scheduleStore.loadPreferences(studentId);
        if (prefs?.schedulingPreferences) {
            schedulingPreferences = prefs.schedulingPreferences;
        }
    } catch {
        // best-effort
    }

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for (const term of parsed.futureTerms) {
                    const courseIds = schedule ? pickCourseIdsForTerm(schedule, term) : [];

                    if (!schedule) {
                        controller.enqueue(encodeEvent({
                            kind: "plan_action_stage2_enrichment",
                            slotKey: parsed.slotKey,
                            term,
                            status: "unavailable",
                            message: `[${term}] no schedule loaded — cannot fetch sections.`,
                        }));
                        continue;
                    }
                    if (courseIds.length === 0) {
                        // No specific_planned slots in this term —
                        // either it's placeholder-only or doesn't
                        // exist in the proposed schedule yet.
                        controller.enqueue(encodeEvent({
                            kind: "plan_action_stage2_enrichment",
                            slotKey: parsed.slotKey,
                            term,
                            status: "warn",
                            message: `[${term}] no concrete courses scheduled for this term.`,
                        }));
                        continue;
                    }

                    try {
                        const result = await materializeSections({
                            termCode: term,
                            courseIds,
                            // Phase 17 Task D — the route layer is
                            // strictly read-only, so the swap cascade
                            // hook is a no-op (mirrors the
                            // materialize_sections tool's stub).
                            swapHook: async () => null,
                            ...(schedulingPreferences ? { schedulingPreferences } : {}),
                        });
                        const signal = classifyMaterialization(term, result);
                        controller.enqueue(encodeEvent({
                            kind: "plan_action_stage2_enrichment",
                            slotKey: parsed.slotKey,
                            term,
                            status: signal.status,
                            message: signal.message,
                        }));
                    } catch (err) {
                        // Stage 2 is best-effort — surface the failure
                        // as an unavailable enrichment, never as a
                        // route-level 500. The bubble's Confirm path
                        // is unaffected.
                        controller.enqueue(encodeEvent({
                            kind: "plan_action_stage2_enrichment",
                            slotKey: parsed.slotKey,
                            term,
                            status: "unavailable",
                            message: `[${term}] FOSE error: ${err instanceof Error ? err.message : String(err)}`,
                        }));
                    }
                }
                controller.enqueue(encodeEvent({
                    kind: "plan_action_stage2_done",
                    slotKey: parsed.slotKey,
                }));
                controller.close();
            } catch (err) {
                // Fatal stream error — emit a single unavailable
                // signal then close.
                try {
                    controller.enqueue(encodeEvent({
                        kind: "plan_action_stage2_enrichment",
                        slotKey: parsed.slotKey,
                        term: parsed.futureTerms[0] ?? "unknown",
                        status: "unavailable",
                        message: `[stage2] ${err instanceof Error ? err.message : String(err)}`,
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
