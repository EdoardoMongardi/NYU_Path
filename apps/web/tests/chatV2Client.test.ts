// ============================================================
// Phase 6.5 P-1 — chatV2Client SSE consumer tests
// ============================================================
// Pins (a) the line-buffered SSE parser handles partial chunks,
// (b) every event kind round-trips, (c) HTTP errors and transport
// failures surface as synthetic `{kind:"error"}` events,
// (d) the pendingMutationId extractor reads the update_profile
// summary literal.
// ============================================================

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { streamChatV2, extractPendingMutationId, type ChatV2Event } from "../lib/chatV2Client";

/** Build a Response whose body emits the given chunks in order. */
function fakeResponse(chunks: string[], opts: { status?: number; ok?: boolean } = {}): Response {
    const status = opts.status ?? 200;
    const ok = opts.ok ?? (status >= 200 && status < 300);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
        },
    });
    // Construct a minimal Response shape that satisfies the helper.
    return new Response(stream, { status }) as Response & { ok: boolean };
}

function installFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).fetch = impl as any;
}

describe("streamChatV2 (Phase 6.5 P-1)", () => {
    const ORIGINAL_FETCH = globalThis.fetch;
    afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

    it("parses a single token + done event sequence", async () => {
        installFetch(async () => fakeResponse([
            "event: token\ndata: " + JSON.stringify({ kind: "token", text: "hello" }) + "\n\n",
            "event: done\ndata: " + JSON.stringify({ kind: "done", finalText: "hello", modelUsedId: "m" }) + "\n\n",
        ]));
        const events: ChatV2Event[] = [];
        for await (const ev of streamChatV2({ message: "hi", parsedData: {} })) {
            events.push(ev);
        }
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ kind: "token", text: "hello" });
        expect(events[1]).toMatchObject({ kind: "done", finalText: "hello" });
    });

    it("handles partial chunks (event split across reads)", async () => {
        installFetch(async () => fakeResponse([
            "event: token\nda",
            "ta: " + JSON.stringify({ kind: "token", text: "split" }) + "\n",
            "\n", // separator arrives in its own chunk
            "event: done\ndata: " + JSON.stringify({ kind: "done", finalText: "split", modelUsedId: "m" }) + "\n\n",
        ]));
        const events: ChatV2Event[] = [];
        for await (const ev of streamChatV2({ message: "hi", parsedData: {} })) {
            events.push(ev);
        }
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ kind: "token", text: "split" });
    });

    it("yields all 7 event kinds end-to-end", async () => {
        const all: ChatV2Event[] = [
            { kind: "template_match", templateId: "t", body: "b", source: "s" },
            { kind: "tool_invocation_start", toolName: "x", args: {} },
            { kind: "tool_invocation_done", toolName: "x", summary: "ok" },
            { kind: "validator_block", violations: [{ kind: "ungrounded_number", detail: "..." }] },
            { kind: "token", text: "hi" },
            { kind: "done", finalText: "hi", modelUsedId: "m" },
            { kind: "error", message: "boom" },
        ];
        installFetch(async () => fakeResponse(
            all.map((e) => `event: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`),
        ));
        const got: ChatV2Event[] = [];
        for await (const ev of streamChatV2({ message: "hi", parsedData: {} })) {
            got.push(ev);
        }
        expect(got.map((e) => e.kind)).toEqual(all.map((e) => e.kind));
    });

    it("yields a synthetic error event on HTTP 503", async () => {
        installFetch(async () => new Response(JSON.stringify({ error: "OPENAI_API_KEY missing" }), { status: 503 }));
        const events: ChatV2Event[] = [];
        for await (const ev of streamChatV2({ message: "hi", parsedData: {} })) {
            events.push(ev);
        }
        expect(events).toHaveLength(1);
        expect(events[0]!.kind).toBe("error");
        expect((events[0] as { kind: "error"; message: string }).message).toMatch(/OPENAI_API_KEY/);
    });

    it("yields a synthetic error event on transport failure", async () => {
        installFetch(async () => { throw new Error("network down"); });
        const events: ChatV2Event[] = [];
        for await (const ev of streamChatV2({ message: "hi", parsedData: {} })) {
            events.push(ev);
        }
        expect(events).toHaveLength(1);
        expect(events[0]!.kind).toBe("error");
        expect((events[0] as { kind: "error"; message: string }).message).toMatch(/network down/);
    });

    it("ignores blocks that lack a data: line", async () => {
        installFetch(async () => fakeResponse([
            ": this is a heartbeat comment\n\n",
            "event: token\ndata: " + JSON.stringify({ kind: "token", text: "x" }) + "\n\n",
        ]));
        const events: ChatV2Event[] = [];
        for await (const ev of streamChatV2({ message: "hi", parsedData: {} })) {
            events.push(ev);
        }
        expect(events).toHaveLength(1);
        expect(events[0]!.kind).toBe("token");
    });
});

describe("extractPendingMutationId", () => {
    it("extracts the id from an update_profile summary", () => {
        const summary = `STATUS: pending_confirmation
pendingMutationId: pm_1729900000000_42
field: visaStatus
before: "domestic"
after: "f1"`;
        expect(extractPendingMutationId(summary)).toBe("pm_1729900000000_42");
    });

    it("returns null when no pending id is present", () => {
        expect(extractPendingMutationId("APPLIED visaStatus: domestic → f1")).toBeNull();
        expect(extractPendingMutationId(undefined)).toBeNull();
        expect(extractPendingMutationId("")).toBeNull();
    });
});
