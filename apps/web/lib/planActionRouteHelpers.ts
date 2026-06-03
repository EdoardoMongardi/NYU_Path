// ============================================================
// planActionRouteHelpers (Phase 17 Task B)
// ============================================================
// Tiny shared HTTP plumbing for the deterministic plan-action
// routes (/api/plan/<verb>). Each route does:
//
//   1. auth gate via readSessionFromRequest → 401 if absent
//   2. rate-limit via consumeRequest("plan-action:<studentId>") →
//      429 if over the daily quota (separate bucket from chat).
//   3. parse JSON body (400 on malformed)
//   4. validate the body shape against the route's Zod schema (400)
//   5. invoke the orchestrator (runProposeStage / runConfirmStage)
//   6. shape the orchestrator's typed error → HTTP code
//
// Centralizing 1–6 here keeps each per-verb route file < 60 LOC and
// makes regression-testing the auth/rate-limit/validation contract
// easy (one assertion path per concern).
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodTypeAny } from "zod";
import { readSessionFromRequest } from "./auth/session.js";
import { consumeRequest } from "./rateLimit.js";
import {
    runProposeStage,
    runConfirmStage,
    type RunConfirmError,
    type RunProposeError,
} from "./planActionOrchestrator.js";
import type { PlanMutation } from "@nyupath/shared";

/** Per-student daily cap on plan-action mutations. Distinct bucket
 *  from chat-rate so a flurry of clicks doesn't burn the chat quota
 *  (and vice-versa). */
const PLAN_ACTION_LIMIT_PER_DAY = 60;
const RATE_BUCKET_PREFIX = "plan-action";

interface ProposeOk {
    ok: true;
    studentId: string;
    body: unknown;
}

/** Run auth + rate-limit + JSON parse. Returns either an early
 *  NextResponse (401/429/400) or the studentId + parsed body. */
async function preflight(req: NextRequest): Promise<
    | { ok: true; studentId: string; body: unknown }
    | { ok: false; response: NextResponse }
> {
    const auth = await readSessionFromRequest(req);
    if (!auth) {
        return {
            ok: false,
            response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
        };
    }
    const studentId = auth.sub;

    const rate = consumeRequest(`${RATE_BUCKET_PREFIX}:${studentId}`, PLAN_ACTION_LIMIT_PER_DAY);
    if (!rate.ok) {
        return {
            ok: false,
            response: NextResponse.json(
                {
                    error:
                        `You've used the plan-action quota for today (${rate.limit} requests). ` +
                        `Try again after ${rate.resetAt}.`,
                },
                {
                    status: 429,
                    headers: {
                        "Retry-After": String(rate.retryAfterSeconds),
                        "X-RateLimit-Limit": String(rate.limit),
                        "X-RateLimit-Remaining": "0",
                        "X-RateLimit-Reset": rate.resetAt,
                    },
                },
            ),
        };
    }

    let body: unknown;
    try {
        body = await req.json();
    } catch (err) {
        return {
            ok: false,
            response: NextResponse.json(
                { error: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}` },
                { status: 400 },
            ),
        };
    }

    return { ok: true, studentId, body };
}

/** Map a typed orchestrator error to an HTTP NextResponse. The
 *  no-X family is 409 Conflict (state-precondition); engine_error
 *  is 500. */
function mapProposeError(err: RunProposeError): NextResponse {
    switch (err.kind) {
        case "no_profile":
        case "no_dpr":
        case "no_schedule":
            return NextResponse.json({ error: err.message, kind: err.kind }, { status: 409 });
        case "engine_error":
            return NextResponse.json({ error: err.message, kind: err.kind }, { status: 500 });
    }
}

function mapConfirmError(err: RunConfirmError): NextResponse {
    switch (err.kind) {
        case "unknown_mutation_id":
            return NextResponse.json({ error: err.message, kind: err.kind }, { status: 404 });
        case "studentId_mismatch":
            return NextResponse.json({ error: err.message, kind: err.kind }, { status: 403 });
        case "no_profile":
        case "no_dpr":
        case "no_schedule":
            return NextResponse.json({ error: err.message, kind: err.kind }, { status: 409 });
        case "engine_error":
            return NextResponse.json({ error: err.message, kind: err.kind }, { status: 500 });
    }
}

function formatZodIssues(err: unknown): string {
    if (err instanceof ZodError) {
        return err.issues
            .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
            .join("; ");
    }
    return String(err);
}

/**
 * The shared propose-stage handler each per-verb route delegates to.
 * `schema` validates the body shape; `buildMutations` lifts it to the
 * canonical PlanMutation[] the orchestrator consumes.
 */
export async function handleProposeRoute<T>(
    req: NextRequest,
    schema: ZodTypeAny,
    buildMutations: (input: T) => PlanMutation[],
): Promise<NextResponse> {
    const pre = await preflight(req);
    if (!pre.ok) return pre.response;

    let parsed: T;
    try {
        parsed = schema.parse(pre.body) as T;
    } catch (err) {
        return NextResponse.json(
            { error: `Invalid request body: ${formatZodIssues(err)}` },
            { status: 400 },
        );
    }

    const mutations = buildMutations(parsed);
    if (mutations.length === 0) {
        return NextResponse.json({ error: "Empty mutation list — nothing to propose." }, { status: 400 });
    }

    const result = await runProposeStage(pre.studentId, mutations);
    if (!result.ok) return mapProposeError(result.error);

    return NextResponse.json(result.response);
}

/** Same shape as handleProposeRoute but for the /confirm route. The
 *  body is `{ pendingMutationId: string, force?: boolean }` and we
 *  delegate straight to runConfirmStage. The optional `force` flag
 *  routes an infeasible apply into Decision #32's
 *  `student-preferred-invalid-draft` slot rather than the default
 *  `infeasible-draft`. */
export async function handleConfirmRoute(
    req: NextRequest,
    schema: ZodTypeAny,
): Promise<NextResponse> {
    const pre = await preflight(req);
    if (!pre.ok) return pre.response;

    let parsed: { pendingMutationId: string; force?: boolean };
    try {
        parsed = schema.parse(pre.body) as { pendingMutationId: string; force?: boolean };
    } catch (err) {
        return NextResponse.json(
            { error: `Invalid request body: ${formatZodIssues(err)}` },
            { status: 400 },
        );
    }

    const result = await runConfirmStage(
        pre.studentId,
        parsed.pendingMutationId,
        { force: parsed.force === true },
    );
    if (!result.ok) return mapConfirmError(result.error);

    return NextResponse.json(result.response);
}

// Re-export the rate-limit constant for tests.
export const _PLAN_ACTION_LIMIT_PER_DAY_FOR_TESTS = PLAN_ACTION_LIMIT_PER_DAY;
export const _RATE_BUCKET_PREFIX_FOR_TESTS = RATE_BUCKET_PREFIX;

// Legacy unused export-stub — keep for type-narrowing across the
// migration if any caller picks it up later.
export type { ProposeOk };
