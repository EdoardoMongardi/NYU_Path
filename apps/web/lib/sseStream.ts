// ============================================================
// SSE stream encoder (Phase 6.1 WS2)
// ============================================================
// Minimal Server-Sent-Events encoder for the v2 chat route.
// Produces a `ReadableStream` that emits `event: <kind>` + `data: <json>`
// blocks separated by blank lines. Compatible with the browser's
// EventSource API and `fetch().then(r => r.body)` reading.
// ============================================================

export type SseEvent =
    | { kind: "template_match"; templateId: string; body: string; source: string }
    | { kind: "tool_invocation_start"; toolName: string; args: Record<string, unknown> }
    | { kind: "tool_invocation_done"; toolName: string; summary?: string; error?: string }
    | { kind: "token"; text: string }
    | { kind: "validator_block"; violations: Array<{ kind: string; detail: string; caveatId?: string; number?: string }> }
    | { kind: "done"; finalText: string; modelUsedId: string }
    | { kind: "error"; message: string };

export interface SseWriter {
    write(ev: SseEvent): void;
    close(): void;
}

/** Build a ReadableStream + a typed writer. The route handler emits
 *  events through `writer.write(...)` and calls `writer.close()`
 *  when done. */
export function createSseStream(): { stream: ReadableStream<Uint8Array>; writer: SseWriter } {
    const encoder = new TextEncoder();
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    let closed = false;
    const queued: Uint8Array[] = [];

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controllerRef = controller;
            // Flush anything emitted before the controller was ready.
            for (const chunk of queued) controller.enqueue(chunk);
            queued.length = 0;
            if (closed) {
                try { controller.close(); } catch { /* already closed */ }
            }
        },
        cancel() {
            closed = true;
        },
    });

    function encode(ev: SseEvent): Uint8Array {
        const eventLine = `event: ${ev.kind}\n`;
        const dataLine = `data: ${JSON.stringify(ev)}\n\n`;
        return encoder.encode(eventLine + dataLine);
    }

    const writer: SseWriter = {
        write(ev) {
            if (closed) return;
            const chunk = encode(ev);
            if (controllerRef) controllerRef.enqueue(chunk);
            else queued.push(chunk);
        },
        close() {
            if (closed) return;
            closed = true;
            if (controllerRef) {
                try { controllerRef.close(); } catch { /* already closed */ }
            }
        },
    };

    return { stream, writer };
}
