// ============================================================
// Phase 6.1 WS5 — RecorderLLMClient unit tests
// ============================================================
// Pins: (a) every complete() call appends one JSONL entry,
// (b) the captured fixture replays through RecordingLLMClient and
// reproduces the same completions (round-trip property), (c) the
// recorder doesn't break the live flow if fixture-append fails.
// ============================================================

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    RecorderLLMClient,
    RecordingLLMClient,
    type LLMClient,
    type LLMCompletion,
} from "../../src/agent/index.js";

function makeStubClient(replies: LLMCompletion[]): LLMClient {
    let i = 0;
    return {
        id: "stub",
        async complete() {
            const r = replies[i++ % replies.length];
            return r;
        },
    };
}

function tmpFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "nyupath-recorder-"));
    return join(dir, "fixture.jsonl");
}

describe("RecorderLLMClient (Phase 6.1 WS5)", () => {
    it("appends one JSONL entry per complete() call", async () => {
        const stub = makeStubClient([
            { text: "hi 1", toolCalls: [], latencyMs: 10 },
            { text: "hi 2", toolCalls: [], latencyMs: 11 },
        ]);
        const path = tmpFixture();
        const recorder = new RecorderLLMClient({ inner: stub, fixturePath: path });

        await recorder.complete({ system: "s", messages: [{ role: "user", content: "first" }] });
        await recorder.complete({ system: "s", messages: [{ role: "user", content: "second" }] });

        const lines = readFileSync(path, "utf-8").trim().split("\n");
        expect(lines).toHaveLength(2);
        const entry1 = JSON.parse(lines[0]!);
        expect(entry1.match.userMessageEquals).toBe("first");
        expect(entry1.completion.text).toBe("hi 1");
        const entry2 = JSON.parse(lines[1]!);
        expect(entry2.match.userMessageEquals).toBe("second");
    });

    it("captures tool calls verbatim including ids", async () => {
        const stub = makeStubClient([
            {
                text: "calling",
                toolCalls: [{ id: "call_123", name: "run_full_audit", args: { dryRun: true } }],
                latencyMs: 5,
            },
        ]);
        const path = tmpFixture();
        const recorder = new RecorderLLMClient({ inner: stub, fixturePath: path });
        await recorder.complete({ system: "s", messages: [{ role: "user", content: "audit me" }] });

        const entry = JSON.parse(readFileSync(path, "utf-8").trim());
        expect(entry.completion.toolCalls).toEqual([
            { id: "call_123", name: "run_full_audit", args: { dryRun: true } },
        ]);
    });

    it("round-trip: a captured fixture replays through RecordingLLMClient and produces the same completion", async () => {
        const stub = makeStubClient([
            { text: "captured reply", toolCalls: [], latencyMs: 7 },
        ]);
        const path = tmpFixture();
        const recorder = new RecorderLLMClient({ inner: stub, fixturePath: path });

        const live = await recorder.complete({
            system: "s",
            messages: [{ role: "user", content: "round-trip me" }],
        });

        // Replay using RecordingLLMClient with the recorded JSONL.
        const replay = RecordingLLMClient.fromJsonl(path);
        const replayed = await replay.complete({
            system: "s",
            messages: [{ role: "user", content: "round-trip me" }],
        });

        expect(replayed.text).toBe(live.text);
        expect(replayed.toolCalls).toEqual(live.toolCalls);
    });

    it("truncates the fixture when truncateOnStart is true", async () => {
        const path = tmpFixture();
        // Pre-seed the fixture with a sentinel line.
        writeFileSync(path, JSON.stringify({ match: {}, completion: { text: "stale", toolCalls: [] } }) + "\n");
        const stub = makeStubClient([{ text: "fresh", toolCalls: [], latencyMs: 1 }]);
        const _ = new RecorderLLMClient({ inner: stub, fixturePath: path, truncateOnStart: true });
        const after = readFileSync(path, "utf-8");
        expect(after).toBe("");
    });

    it("supports the userMessageContains match strategy for fuzzy replay", async () => {
        const stub = makeStubClient([{ text: "ok", toolCalls: [], latencyMs: 1 }]);
        const path = tmpFixture();
        const recorder = new RecorderLLMClient({
            inner: stub,
            fixturePath: path,
            matchStrategy: "userMessageContains",
        });
        await recorder.complete({
            system: "s",
            messages: [{ role: "user", content: "what is my GPA right now please" }],
        });
        const entry = JSON.parse(readFileSync(path, "utf-8").trim());
        // Substring matcher must be present; should be a non-empty
        // prefix of the user message (≥8 chars per the recorder rule).
        expect(typeof entry.match.userMessageContains).toBe("string");
        expect(entry.match.userMessageContains.length).toBeGreaterThanOrEqual(8);
        expect("what is my GPA right now please").toContain(entry.match.userMessageContains);
    });

    it("fixture-append failure does NOT break the live flow", async () => {
        const stub = makeStubClient([{ text: "still works", toolCalls: [], latencyMs: 1 }]);
        // Path inside a non-existent directory that mkdirSync can create —
        // recorder should succeed. To force failure we point at a path
        // whose parent component is a regular file.
        const blockerDir = mkdtempSync(join(tmpdir(), "nyupath-recorder-fail-"));
        const blockerFile = join(blockerDir, "not-a-dir");
        writeFileSync(blockerFile, "blocking file");
        const path = join(blockerFile, "fixture.jsonl"); // Parent is a file ⇒ append fails.

        const recorder = new RecorderLLMClient({ inner: stub, fixturePath: path });
        const result = await recorder.complete({
            system: "s",
            messages: [{ role: "user", content: "go" }],
        });
        expect(result.text).toBe("still works"); // Live path uninterrupted.
    });
});
