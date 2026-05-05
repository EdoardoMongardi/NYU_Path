// ============================================================
// planActionClient — Phase 17 Task C
// ============================================================
// Browser-side typed wrappers for the deterministic plan-action
// routes shipped in Phase 17 Task B (`/api/plan/<verb>`). Each
// helper:
//
//   1. Builds a JSON body of the route's exact shape.
//   2. POSTs with `Content-Type: application/json` + `credentials:
//      "same-origin"` so the session cookie reaches the route's
//      `readSessionFromRequest` gate.
//   3. Parses the JSON response.
//   4. Surfaces transport errors (network drop, non-2xx status) as
//      a typed `{ ok: false, error }` discriminated value so the
//      caller can pattern-match without try/catch.
//
// No SSE here — the propose routes return a single JSON payload.
// Stage-2 enrichment (FOSE section data) streams via the existing
// `forward_materialization_update` SSE channel and is wired
// elsewhere; the client wrapper only owns the Stage 1 round-trip.
// ============================================================
//
// Mirrors the `chatV2Client.ts` pattern: typed events / typed
// returns / no implicit any. Each non-confirm route returns the
// `PlanActionResponse` shape from `planActionOrchestrator` (re-
// exported here as `PlanActionRouteResponse` so the browser bundle
// doesn't need the orchestrator import).
// ============================================================

import type {
    PlanChangeOutcome,
    PlanDiff,
    ForwardSchedule,
} from "@nyupath/shared";

/**
 * Stage-1 success payload. Mirrors `PlanActionResponse` in
 * `apps/web/lib/planActionOrchestrator.ts`. Re-declared here so the
 * browser bundle does not transitively import the engine + Node-only
 * orchestrator code (which would explode at build time).
 */
export interface PlanActionRouteResponse extends PlanChangeOutcome {
    planDiff?: PlanDiff;
    explanation: string;
    pendingMutationId: string;
    futureTerms: string[];
    forwardSchedule?: ForwardSchedule;
}

/** Confirm-stage success payload. */
export interface PlanConfirmRouteResponse extends PlanChangeOutcome {
    planDiff?: PlanDiff;
    storedIn: "forwardSchedule" | "studentDraftPlan";
    forwardSchedule?: ForwardSchedule;
    consumedMutationId: string;
}

/** Discriminated success/failure result for every wrapper. */
export type PlanActionResult<T> =
    | { ok: true; data: T }
    | { ok: false; status: number; error: string; kind?: string };

/** Inputs accepted by the public verbs. */
export interface PlanAddInput {
    courseId: string;
    term: string;
}

export interface PlanSwapSingleInput {
    drop: string;
    add: string;
    term: string;
}

export interface PlanSwapExchange {
    aCourseId: string;
    aTerm: string;
    bCourseId: string;
    bTerm: string;
}

export interface PlanSwapBatchInput {
    exchanges: PlanSwapExchange[];
}

export type PlanSwapInput = PlanSwapSingleInput | PlanSwapBatchInput;

export interface PlanDropInput {
    courseId: string;
    /** Omit to exclude globally; provide a term to scope the exclusion. */
    term?: string;
}

export interface PlanLockInput {
    courseId: string;
    term: string;
    /** `true` → freeze the slot (writes to SchedulePreferences.pins[]).
     *  `false` → unfreeze (removes the matching pin). */
    locked: boolean;
}

export interface PlanMoveInput {
    courseId: string;
    fromTerm: string;
    toTerm: string;
}

export interface PlanConfirmInput {
    pendingMutationId: string;
}

// ---------------------------------------------------------------------
// Internal: shared POST helper.
// ---------------------------------------------------------------------

async function postJson<TResp>(
    url: string,
    body: unknown,
    init: { signal?: AbortSignal } = {},
): Promise<PlanActionResult<TResp>> {
    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "same-origin",
            signal: init.signal,
        });
    } catch (err) {
        return {
            ok: false,
            status: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
    let parsed: unknown;
    try {
        parsed = await response.json();
    } catch {
        // Empty / malformed body — fall back to a status-only error.
        if (!response.ok) {
            return {
                ok: false,
                status: response.status,
                error: `HTTP ${response.status}`,
            };
        }
        // Some routes may legally return 204 / empty body in the future.
        return { ok: true, data: {} as TResp };
    }
    if (!response.ok) {
        const obj = (parsed ?? {}) as { error?: unknown; kind?: unknown };
        const error = typeof obj.error === "string" ? obj.error : `HTTP ${response.status}`;
        const kind = typeof obj.kind === "string" ? obj.kind : undefined;
        return {
            ok: false,
            status: response.status,
            error,
            ...(kind ? { kind } : {}),
        };
    }
    return { ok: true, data: parsed as TResp };
}

// ---------------------------------------------------------------------
// Public verbs.
// ---------------------------------------------------------------------

export async function planAdd(
    input: PlanAddInput,
    init: { signal?: AbortSignal } = {},
): Promise<PlanActionResult<PlanActionRouteResponse>> {
    return postJson<PlanActionRouteResponse>("/api/plan/add", input, init);
}

export async function planSwap(
    input: PlanSwapInput,
    init: { signal?: AbortSignal } = {},
): Promise<PlanActionResult<PlanActionRouteResponse>> {
    return postJson<PlanActionRouteResponse>("/api/plan/swap", input, init);
}

export async function planDrop(
    input: PlanDropInput,
    init: { signal?: AbortSignal } = {},
): Promise<PlanActionResult<PlanActionRouteResponse>> {
    // Drop the optional `term` field when undefined so the route's
    // strict-mode Zod schema does not reject `term: undefined`.
    const body: PlanDropInput = input.term
        ? { courseId: input.courseId, term: input.term }
        : { courseId: input.courseId };
    return postJson<PlanActionRouteResponse>("/api/plan/drop", body, init);
}

export async function planLock(
    input: PlanLockInput,
    init: { signal?: AbortSignal } = {},
): Promise<PlanActionResult<PlanActionRouteResponse>> {
    return postJson<PlanActionRouteResponse>("/api/plan/lock", input, init);
}

export async function planMove(
    input: PlanMoveInput,
    init: { signal?: AbortSignal } = {},
): Promise<PlanActionResult<PlanActionRouteResponse>> {
    return postJson<PlanActionRouteResponse>("/api/plan/move", input, init);
}

export async function planConfirm(
    input: PlanConfirmInput,
    init: { signal?: AbortSignal } = {},
): Promise<PlanActionResult<PlanConfirmRouteResponse>> {
    return postJson<PlanConfirmRouteResponse>("/api/plan/confirm", input, init);
}
