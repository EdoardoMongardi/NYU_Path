// ============================================================
// Phase 6.1 WS2 — SSE stream encoder tests
// ============================================================

import { describe, expect, it } from "vitest";
import { createSseStream } from "../lib/sseStream";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
}

describe("createSseStream (Phase 6.1 WS2)", () => {
    it("encodes events as 'event: <kind>\\ndata: <json>\\n\\n'", async () => {
        const { stream, writer } = createSseStream();
        writer.write({ kind: "token", text: "hello" });
        writer.write({ kind: "done", finalText: "hello", modelUsedId: "test" });
        writer.close();
        const out = await readAll(stream);
        expect(out).toContain("event: token\n");
        expect(out).toContain("event: done\n");
        // data lines are valid JSON.
        const dataLines = out.split("\n").filter((l) => l.startsWith("data: "));
        expect(dataLines).toHaveLength(2);
        for (const line of dataLines) {
            expect(() => JSON.parse(line.slice("data: ".length))).not.toThrow();
        }
    });

    it("queues events emitted before the controller is ready", async () => {
        // Emit before the consumer reads (the writer may be called
        // synchronously after createSseStream returns, before
        // start(controller) fires).
        const { stream, writer } = createSseStream();
        writer.write({ kind: "token", text: "first" });
        writer.write({ kind: "token", text: "second" });
        writer.close();
        const out = await readAll(stream);
        expect(out.split("event: token").length - 1).toBe(2);
    });

    it("write() after close() is a no-op (does not throw)", async () => {
        const { stream, writer } = createSseStream();
        writer.write({ kind: "token", text: "before" });
        writer.close();
        // Drain so the stream actually closes.
        await readAll(stream);
        expect(() => writer.write({ kind: "token", text: "after" })).not.toThrow();
    });

    it("emits all 7 event kinds without throwing", async () => {
        const { stream, writer } = createSseStream();
        writer.write({ kind: "template_match", templateId: "t", body: "b", source: "s" });
        writer.write({ kind: "tool_invocation_start", toolName: "x", args: { a: 1 } });
        writer.write({ kind: "tool_invocation_done", toolName: "x", summary: "ok" });
        writer.write({ kind: "validator_block", violations: [{ kind: "ungrounded_number", detail: "..." }] });
        writer.write({ kind: "token", text: "hi" });
        writer.write({ kind: "done", finalText: "hi", modelUsedId: "m" });
        writer.write({ kind: "error", message: "boom" });
        writer.close();
        const out = await readAll(stream);
        expect(out).toMatch(/event: template_match/);
        expect(out).toMatch(/event: tool_invocation_start/);
        expect(out).toMatch(/event: tool_invocation_done/);
        expect(out).toMatch(/event: validator_block/);
        expect(out).toMatch(/event: token/);
        expect(out).toMatch(/event: done/);
        expect(out).toMatch(/event: error/);
    });
});
