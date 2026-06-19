// ============================================================
// chatV2Client — SSE consumer for /api/chat/v2 (Phase 6.5 P-1)
// ============================================================
// Browser-side helper that POSTs a chat message to the v2 SSE
// endpoint and yields parsed events. The chat page consumes this
// generator and updates UI state per event kind.
//
// Why a helper file: the SSE parsing is non-trivial (line buffering,
// `event:` + `data:` pairing, partial-chunk handling) and writing
// it inline in `page.tsx` would balloon the component. The helper
// is also the natural test seam.
// ============================================================

import type { ForwardSchedule } from "@nyupath/shared";
import type { MaterializationResult, MaterializedSemester } from "@nyupath/engine";

/**
 * Phase 15 Task 8 — section shape carried by the materialization
 * payload. Derived from `MaterializedSemester["courses"][number]["sections"][number]`
 * so the UI doesn't need a deep import into engine internals (the
 * engine barrel does not re-export `SectionView` directly because it
 * collides with the search-availability `SectionView` shape).
 */
export type MaterializationSectionView =
    MaterializedSemester["courses"][number]["sections"][number];

/**
 * Phase 15 Task 8 — payload of the `forward_materialization_update`
 * SSE event. Mirrors `session.lastMaterializationResult` (the engine
 * side-channel populated by `materialize_sections.call()`): the
 * orchestrator's `MaterializationResult` plus the `targetTerm` and
 * `proposals` array (one entry per conflict-free combination, ordered
 * to match `result.semester.combinations`).
 */
export type ForwardMaterializationPayload =
    & MaterializationResult
    & {
        targetTerm: string;
        proposals?: Array<{
            proposalId: string;
            sections: MaterializationSectionView[];
            weeklyHours: number;
        }>;
        computedAt: number;
    };

export type ChatV2Event =
    | { kind: "tool_invocation_start"; toolName: string; args: Record<string, unknown> }
    | { kind: "tool_invocation_done"; toolName: string; summary?: string; error?: string }
    | { kind: "token"; text: string }
    | { kind: "thinking"; text: string }
    | { kind: "validator_block"; violations: Array<{ kind: string; detail: string; caveatId?: string; number?: string }> }
    | { kind: "forward_schedule_update"; schedule: ForwardSchedule }
    | { kind: "forward_materialization_update"; result: ForwardMaterializationPayload }
    /**
     * Plan 36 H4.2b — Branch-A "upload your Albert What-If audit" offer.
     * Emitted once per assistant turn when the agent calls the
     * `what_if_audit` tool (whose summary carries an `AUDIT_UPLOAD_OFFER:
     * <label>` marker line). The client renders an upload card prompting
     * the student to attach the Albert What-If audit for the hypothetical
     * PROGRAM identified by `hypotheticalProgram`.
     */
    | { kind: "whatif_audit_request"; hypotheticalProgram: string }
    /**
     * Task I1 — chat-proposed change surfaces the Confirm rail. Emitted
     * at most ONCE per turn when the agent called `propose_plan_change`.
     * Carries the staged `pendingMutationId` so the workspace Confirm
     * button can POST to `/api/plan/confirm` and commit via the existing
     * chokepoint. Staging ≠ committing — nothing persists until Confirm.
     */
    | {
        kind: "plan_proposal";
        pendingMutationId: string;
        feasible: boolean;
        consequences: string[];
        proposedSchedule?: import("@nyupath/shared").ForwardSchedule;
        planDiff?: import("@nyupath/shared").PlanDiff;
    }
    | { kind: "done"; finalText: string; modelUsedId: string }
    | { kind: "error"; message: string };

/**
 * Phase 17 Task D — events emitted by `/api/plan/explain-polish` (LLM
 * polish) and the Stage 2 enrichment fork (`/api/plan/stage2`). These
 * stream into the same `plan_action_bubble` chat-thread message kind
 * the Task D sidebar surface populates after a successful Stage 1
 * route response. They live on a dedicated event union so the polish
 * + enrichment fetches never accidentally consume `done` events meant
 * for the chat stream (and vice versa).
 */
export type PlanActionBubbleSseEvent =
    | { kind: "plan_action_explanation_polish_chunk"; slotKey: string; deltaText: string }
    | { kind: "plan_action_explanation_polish_done"; slotKey: string; polishedText: string }
    | { kind: "plan_action_explanation_polish_error"; slotKey: string; message: string }
    /** Stage 2 enrichment carried by /api/plan/stage2. One event per
     *  term in the request's `futureTerms[]`. The `message` field
     *  starts with `[<term>] ` so a downstream UI reducer can route
     *  per-term without re-parsing the term out of it. */
    | { kind: "plan_action_stage2_enrichment"; slotKey: string; term?: string; status: "pending" | "ok" | "warn" | "unavailable"; message: string }
    /** Terminator for the Stage 2 stream. Emitted after every term
     *  in the input list has produced an enrichment event. */
    | { kind: "plan_action_stage2_done"; slotKey: string };

export interface ChatV2Request {
    message: string;
    parsedData: unknown;
    visaStatus?: string | null;
    /** Free-form graduation target collected during onboarding
     *  (e.g., "Spring 2027" or "spring2027"). The v2 route normalizes
     *  it and injects it into the system prompt as `graduationTerm`
     *  so the agent answers "next semester" with the correct label. */
    graduationTarget?: string | null;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    correlationId?: string;
    /** Stable per-browser UUID generated by the chat page on first
     *  load and persisted to localStorage. Drives the v2 route's
     *  per-student rate-limit bucket so each browser has its own
     *  30 msg/UTC-day quota (cohort-A approximation of per-user
     *  limits — real auth lands in W12). */
    userId?: string;
    /** CAS-1 / Phase 4 E5.2 — the onboarding-confirmed home-school CODE
     *  (e.g. "cas", "stern", "shanghai", "nyuad"). When present, the v2
     *  route threads it as `homeSchoolOverride` so deriveHomeSchool is
     *  bypassed. Omitted entirely when unconfirmed — NEVER silently CAS. */
    homeSchool?: string;
}

/**
 * POST to /api/chat/v2 and yield parsed SSE events. Gracefully
 * surfaces transport errors as a synthetic `{kind:"error"}` event so
 * the caller doesn't need a separate try/catch around iteration.
 */
export async function* streamChatV2(
    body: ChatV2Request,
    init: { endpoint?: string; signal?: AbortSignal } = {},
): AsyncGenerator<ChatV2Event, void, void> {
    const endpoint = init.endpoint ?? "/api/chat/v2";
    let response: Response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: init.signal,
        });
    } catch (err) {
        yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
        return;
    }
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const j = await response.json();
            if (j?.error) detail = j.error;
        } catch { /* fall through */ }
        yield { kind: "error", message: detail };
        return;
    }
    if (!response.body) {
        yield { kind: "error", message: "Server returned empty body." };
        return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // SSE blocks are separated by "\n\n". Process every
            // complete block; keep the trailing partial in `buffer`.
            let sep = buffer.indexOf("\n\n");
            while (sep !== -1) {
                const block = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                const ev = parseBlock(block);
                if (ev) yield ev;
                sep = buffer.indexOf("\n\n");
            }
        }
        // Flush any final partial block (no trailing \n\n).
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
            const ev = parseBlock(buffer);
            if (ev) yield ev;
        }
    } catch (err) {
        if (init.signal?.aborted) return;
        yield { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
}

function parseBlock(block: string): ChatV2Event | null {
    let dataLine: string | null = null;
    for (const raw of block.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
        // The `event: <kind>` line is informational — the kind also
        // lives inside the JSON payload, so we don't double-track it.
    }
    if (!dataLine) return null;
    try {
        return JSON.parse(dataLine) as ChatV2Event;
    } catch {
        return null;
    }
}

/**
 * Detect the two-step profile-mutation preview in a tool_invocation_done
 * summary. The v2 route surfaces `update_profile` summaries verbatim;
 * they contain "pendingMutationId: pm_..." per
 * packages/engine/src/agent/tools/updateProfile.ts:summarizeResult.
 */
export function extractPendingMutationId(summary: string | undefined): string | null {
    if (!summary) return null;
    const m = summary.match(/pendingMutationId:\s*(pm_[a-zA-Z0-9_]+)/);
    return m ? m[1]! : null;
}

/**
 * Plan 36 H4.2b — detect the Branch-A audit-upload offer in a
 * `what_if_audit` tool_invocation_done summary. The engine tool's
 * `summarizeResult` emits a machine-extractable marker line
 * `AUDIT_UPLOAD_OFFER: <label>` (see
 * packages/engine/src/agent/tools/whatIfAudit.ts:summarizeResult). The
 * v2 route regexes this line — mirroring `extractPendingMutationId` —
 * and forwards the trimmed label as a `whatif_audit_request` SSE event
 * so the client can render the upload card. Returns the trimmed label,
 * or null when the marker is absent.
 */
export function extractAuditUploadOffer(summary: string | undefined): string | null {
    if (!summary) return null;
    const m = summary.match(/^AUDIT_UPLOAD_OFFER:\s*(.+?)\s*$/m);
    // Trim + re-null-check: the lazy `(.+?)` can capture a lone whitespace
    // char from an all-whitespace label (the trailing `\s*$` absorbs the
    // rest), which would otherwise return " " and emit a blank-program
    // upload card. Collapse any empty/whitespace-only label to null so the
    // route never emits an empty-program event (matches this docstring).
    const label = m ? m[1]!.trim() : null;
    return label ? label : null;
}

/**
 * Phase 17 Task D — POST to /api/plan/explain-polish and yield
 * parsed polish events. Mirrors `streamChatV2`'s SSE parser. Returns
 * empty (no events) when the route returns 204 (env-flag gated off).
 */
export async function* streamPlanActionPolish(
    body: { slotKey: string; templateText: string; structuredDiff?: unknown },
    init: { endpoint?: string; signal?: AbortSignal } = {},
): AsyncGenerator<PlanActionBubbleSseEvent, void, void> {
    const endpoint = init.endpoint ?? "/api/plan/explain-polish";
    let response: Response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "same-origin",
            signal: init.signal,
        });
    } catch (err) {
        yield {
            kind: "plan_action_explanation_polish_error",
            slotKey: body.slotKey,
            message: err instanceof Error ? err.message : String(err),
        };
        return;
    }
    if (response.status === 204) return; // ENV-gated off — no events.
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const j = await response.json();
            if (j?.error) detail = j.error;
        } catch { /* fall through */ }
        yield {
            kind: "plan_action_explanation_polish_error",
            slotKey: body.slotKey,
            message: detail,
        };
        return;
    }
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep = buffer.indexOf("\n\n");
            while (sep !== -1) {
                const block = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                const ev = parseBubbleBlock(block);
                if (ev) yield ev;
                sep = buffer.indexOf("\n\n");
            }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
            const ev = parseBubbleBlock(buffer);
            if (ev) yield ev;
        }
    } catch (err) {
        if (init.signal?.aborted) return;
        yield {
            kind: "plan_action_explanation_polish_error",
            slotKey: body.slotKey,
            message: err instanceof Error ? err.message : String(err),
        };
    }
}

function parseBubbleBlock(block: string): PlanActionBubbleSseEvent | null {
    let dataLine: string | null = null;
    for (const raw of block.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("data: ")) dataLine = line.slice("data: ".length);
    }
    if (!dataLine) return null;
    try {
        return JSON.parse(dataLine) as PlanActionBubbleSseEvent;
    } catch {
        return null;
    }
}

/**
 * Phase 17 Task D follow-up — POST to /api/plan/stage2 with the
 * `futureTerms[]` from a propose-stage response. The route runs
 * `materializeSections` per term in the background and streams one
 * `plan_action_stage2_enrichment` event per term, terminated by a
 * `plan_action_stage2_done` event. The slotKey echoed on every
 * event matches `bubbleSlotKey(pendingMutationId)` so the
 * page-side reducer can route the signal to the right bubble.
 */
export async function* streamPlanActionStage2(
    body: { slotKey: string; futureTerms: string[] },
    init: { endpoint?: string; signal?: AbortSignal } = {},
): AsyncGenerator<PlanActionBubbleSseEvent, void, void> {
    const endpoint = init.endpoint ?? "/api/plan/stage2";
    let response: Response;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "same-origin",
            signal: init.signal,
        });
    } catch (err) {
        // Stage 2 failures are best-effort — surface as a single
        // "unavailable" enrichment so the bubble can show the
        // section-data-unavailable signal rather than nothing.
        yield {
            kind: "plan_action_stage2_enrichment",
            slotKey: body.slotKey,
            status: "unavailable",
            message: `[stage2] section data unavailable: ${err instanceof Error ? err.message : String(err)}`,
        };
        return;
    }
    if (response.status === 204) return;
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const j = await response.json();
            if (j?.error) detail = j.error;
        } catch { /* fall through */ }
        yield {
            kind: "plan_action_stage2_enrichment",
            slotKey: body.slotKey,
            status: "unavailable",
            message: `[stage2] ${detail}`,
        };
        return;
    }
    if (!response.body) return;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep = buffer.indexOf("\n\n");
            while (sep !== -1) {
                const block = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                const ev = parseBubbleBlock(block);
                if (ev) yield ev;
                sep = buffer.indexOf("\n\n");
            }
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) {
            const ev = parseBubbleBlock(buffer);
            if (ev) yield ev;
        }
    } catch (err) {
        if (init.signal?.aborted) return;
        yield {
            kind: "plan_action_stage2_enrichment",
            slotKey: body.slotKey,
            status: "unavailable",
            message: `[stage2] ${err instanceof Error ? err.message : String(err)}`,
        };
    }
}
