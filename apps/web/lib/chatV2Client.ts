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

export type ChatV2Event =
    | { kind: "template_match"; templateId: string; body: string; source: string }
    | { kind: "tool_invocation_start"; toolName: string; args: Record<string, unknown> }
    | { kind: "tool_invocation_done"; toolName: string; summary?: string; error?: string }
    | { kind: "token"; text: string }
    | { kind: "validator_block"; violations: Array<{ kind: string; detail: string; caveatId?: string; number?: string }> }
    | { kind: "done"; finalText: string; modelUsedId: string }
    | { kind: "error"; message: string };

export interface ChatV2Request {
    message: string;
    parsedData: unknown;
    visaStatus?: string | null;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    correlationId?: string;
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
