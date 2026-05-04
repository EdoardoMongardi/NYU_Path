// ============================================================
// Phase 16 Task A — InMemoryChatHistoryStore
// ============================================================
// Append-only timeline; load returns the tail in chronological order.
// ============================================================

import { describe, expect, it, beforeEach } from "vitest";
import {
    InMemoryChatHistoryStore,
    type ChatMessageRecord,
} from "../../src/persistence/chatHistoryStore.js";

function mkMsg(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
    return {
        role: "user",
        content: "hello",
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe("InMemoryChatHistoryStore — append + load", () => {
    let store: InMemoryChatHistoryStore;
    beforeEach(() => {
        store = new InMemoryChatHistoryStore();
    });

    it("round-trips a single message via append + loadRecent", async () => {
        await store.appendMessage("stud_1", mkMsg({ role: "user", content: "hi" }));
        const out = await store.loadRecentMessages("stud_1");
        expect(out).toHaveLength(1);
        expect(out[0]!.role).toBe("user");
        expect(out[0]!.content).toBe("hi");
    });

    it("loadRecent returns messages in chronological order (oldest → newest)", async () => {
        await store.appendMessage("stud_1", mkMsg({ role: "user", content: "1" }));
        await store.appendMessage("stud_1", mkMsg({ role: "assistant", content: "2" }));
        await store.appendMessage("stud_1", mkMsg({ role: "user", content: "3" }));
        const out = await store.loadRecentMessages("stud_1");
        expect(out.map((m) => m.content)).toEqual(["1", "2", "3"]);
    });

    it("returns an empty array when no messages exist", async () => {
        const out = await store.loadRecentMessages("never-persisted");
        expect(out).toEqual([]);
    });

    it("isolates messages by studentId", async () => {
        await store.appendMessage("stud_a", mkMsg({ content: "a-msg" }));
        await store.appendMessage("stud_b", mkMsg({ content: "b-msg" }));
        const a = await store.loadRecentMessages("stud_a");
        const b = await store.loadRecentMessages("stud_b");
        expect(a).toHaveLength(1);
        expect(a[0]!.content).toBe("a-msg");
        expect(b).toHaveLength(1);
        expect(b[0]!.content).toBe("b-msg");
    });

    it("respects the limit parameter (returns the LATEST N when total > limit)", async () => {
        for (let i = 0; i < 10; i += 1) {
            await store.appendMessage("stud_1", mkMsg({ content: `msg_${i}` }));
        }
        const last3 = await store.loadRecentMessages("stud_1", 3);
        expect(last3).toHaveLength(3);
        expect(last3.map((m) => m.content)).toEqual(["msg_7", "msg_8", "msg_9"]);
    });

    it("defaults to limit=50 when limit is omitted", async () => {
        for (let i = 0; i < 60; i += 1) {
            await store.appendMessage("stud_1", mkMsg({ content: `msg_${i}` }));
        }
        const out = await store.loadRecentMessages("stud_1");
        expect(out).toHaveLength(50);
        // The first message returned is msg_10 (60 - 50 = 10).
        expect(out[0]!.content).toBe("msg_10");
        expect(out[out.length - 1]!.content).toBe("msg_59");
    });

    it("preserves toolInvocations + validatorViolations + pendingMutationId on the record", async () => {
        await store.appendMessage("stud_1", {
            role: "assistant",
            content: "preview",
            createdAt: new Date().toISOString(),
            toolInvocations: [
                { toolName: "update_profile", args: {}, summary: "ok" },
            ],
            validatorViolations: [{ kind: "drift", detail: "x" }],
            pendingMutationId: "pm_42",
            thinkingText: "thought-stream",
        });
        const out = await store.loadRecentMessages("stud_1");
        expect(out[0]!.toolInvocations).toHaveLength(1);
        expect(out[0]!.toolInvocations![0]!.toolName).toBe("update_profile");
        expect(out[0]!.validatorViolations).toEqual([{ kind: "drift", detail: "x" }]);
        expect(out[0]!.pendingMutationId).toBe("pm_42");
        expect(out[0]!.thinkingText).toBe("thought-stream");
    });
});

describe("InMemoryChatHistoryStore — clear", () => {
    let store: InMemoryChatHistoryStore;
    beforeEach(() => {
        store = new InMemoryChatHistoryStore();
    });

    it("clearForStudent wipes that student's messages", async () => {
        await store.appendMessage("stud_1", mkMsg({ content: "hi" }));
        await store.clearForStudent("stud_1");
        const out = await store.loadRecentMessages("stud_1");
        expect(out).toEqual([]);
    });

    it("clearForStudent does NOT touch other students", async () => {
        await store.appendMessage("stud_a", mkMsg({ content: "a-msg" }));
        await store.appendMessage("stud_b", mkMsg({ content: "b-msg" }));
        await store.clearForStudent("stud_a");
        const a = await store.loadRecentMessages("stud_a");
        const b = await store.loadRecentMessages("stud_b");
        expect(a).toEqual([]);
        expect(b).toHaveLength(1);
    });
});
