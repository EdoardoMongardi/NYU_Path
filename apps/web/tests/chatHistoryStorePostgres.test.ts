// ============================================================
// Phase 16 Task A — PostgresChatHistoryStore SQL pattern coverage
// ============================================================
// Mirror the scheduleStorePostgres.test.ts stub-database pattern:
// we don't need a live DB to verify the store invokes the right
// table + chain. Semantics are covered by the InMemory store tests.
// ============================================================

import { describe, expect, it, beforeEach } from "vitest";
import { PostgresChatHistoryStore } from "../lib/db/chatHistoryStorePostgres";
import type { Database } from "../lib/db/client";
import { chatMessages, students } from "../lib/db/schema";
import type { ChatMessageRecord } from "@nyupath/engine";

interface RecordedCall {
    op: string;
    args: unknown[];
}

class StubDatabase {
    public readonly calls: RecordedCall[] = [];
    private nextSelectResult: unknown[] = [];

    setNextSelectResult(rows: unknown[]): void {
        this.nextSelectResult = rows;
    }

    insert(table: unknown): this {
        this.calls.push({ op: "insert", args: [table] });
        return this;
    }
    /**
     * `.values(...)` is sometimes awaited directly (chat_messages
     * append) and sometimes followed by `.onConflictDoNothing` /
     * `.onConflictDoUpdate` (the students FK ensure path). We make
     * the return value act as both: a thenable AND a chainable
     * builder. The recorder still captures the operation.
     */
    values(values: unknown): this {
        this.calls.push({ op: "values", args: [values] });
        return this;
    }
    onConflictDoNothing(opts: unknown): Promise<unknown> {
        this.calls.push({ op: "onConflictDoNothing", args: [opts] });
        return Promise.resolve();
    }
    select(columns?: unknown): this {
        this.calls.push({ op: "select", args: columns !== undefined ? [columns] : [] });
        return this;
    }
    from(table: unknown): this {
        this.calls.push({ op: "from", args: [table] });
        return this;
    }
    where(clause: unknown): this {
        this.calls.push({ op: "where", args: [clause] });
        return this;
    }
    orderBy(clause: unknown): this {
        this.calls.push({ op: "orderBy", args: [clause] });
        return this;
    }
    limit(n: number): Promise<unknown[]> {
        this.calls.push({ op: "limit", args: [n] });
        const result = this.nextSelectResult;
        this.nextSelectResult = [];
        return Promise.resolve(result);
    }
    delete(table: unknown): this {
        this.calls.push({ op: "delete", args: [table] });
        return this;
    }
    then(onFulfilled?: (v: unknown) => unknown): Promise<unknown> {
        this.calls.push({ op: "then-resolve", args: [] });
        return Promise.resolve(undefined).then(onFulfilled);
    }
}

function mkChatMsg(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
    return {
        role: "user",
        content: "hello",
        createdAt: new Date("2026-05-04T12:00:00Z").toISOString(),
        ...overrides,
    };
}

describe("PostgresChatHistoryStore — appendMessage", () => {
    let stub: StubDatabase;
    let store: PostgresChatHistoryStore;
    beforeEach(() => {
        stub = new StubDatabase();
        store = new PostgresChatHistoryStore(stub as unknown as Database);
    });

    it("ensures the student row exists, then inserts into chat_messages", async () => {
        await store.appendMessage("stud_1", mkChatMsg({ role: "user", content: "hi" }));
        const ops = stub.calls.map((c) => c.op);
        // Two inserts: first to students (idempotent), second to chat_messages.
        expect(ops.filter((o) => o === "insert")).toHaveLength(2);
        // The chat_messages insert is the last one.
        const insertCalls = stub.calls.filter((c) => c.op === "insert");
        expect(insertCalls[0]!.args[0]).toBe(students);
        expect(insertCalls[1]!.args[0]).toBe(chatMessages);

        // Confirm the inserted values carry every record field.
        const valuesCalls = stub.calls.filter((c) => c.op === "values");
        const inserted = valuesCalls[valuesCalls.length - 1]!.args[0] as Record<string, unknown>;
        expect(inserted.studentId).toBe("stud_1");
        expect(inserted.role).toBe("user");
        expect(inserted.content).toBe("hi");
    });

    it("persists nullable side-channel columns when present", async () => {
        await store.appendMessage("stud_1", mkChatMsg({
            role: "assistant",
            content: "preview",
            thinkingText: "thinking",
            toolInvocations: [{ toolName: "update_profile", args: {}, summary: "ok" }],
            validatorViolations: [{ kind: "drift", detail: "x" }],
            pendingMutationId: "pm_42",
        }));
        const valuesCalls = stub.calls.filter((c) => c.op === "values");
        const inserted = valuesCalls[valuesCalls.length - 1]!.args[0] as Record<string, unknown>;
        expect(inserted.thinkingText).toBe("thinking");
        expect(Array.isArray(inserted.toolInvocations)).toBe(true);
        expect(Array.isArray(inserted.validatorViolations)).toBe(true);
        expect(inserted.pendingMutationId).toBe("pm_42");
    });

    it("writes nulls for omitted side-channel columns", async () => {
        await store.appendMessage("stud_1", mkChatMsg({ role: "user", content: "hi" }));
        const valuesCalls = stub.calls.filter((c) => c.op === "values");
        const inserted = valuesCalls[valuesCalls.length - 1]!.args[0] as Record<string, unknown>;
        expect(inserted.thinkingText).toBeNull();
        expect(inserted.toolInvocations).toBeNull();
        expect(inserted.validatorViolations).toBeNull();
        expect(inserted.pendingMutationId).toBeNull();
    });
});

describe("PostgresChatHistoryStore — loadRecentMessages", () => {
    let stub: StubDatabase;
    let store: PostgresChatHistoryStore;
    beforeEach(() => {
        stub = new StubDatabase();
        store = new PostgresChatHistoryStore(stub as unknown as Database);
    });

    it("selects the last N messages, ordered by id desc, then reverses to chronological", async () => {
        // The route sees them in chronological order (oldest → newest);
        // the SQL fetches DESC and the store reverses in JS.
        stub.setNextSelectResult([
            // DESC order from the DB:
            { role: "assistant", content: "third", thinkingText: null, toolInvocations: null, validatorViolations: null, pendingMutationId: null, createdAt: new Date("2026-05-04T12:02:00Z") },
            { role: "user", content: "second", thinkingText: null, toolInvocations: null, validatorViolations: null, pendingMutationId: null, createdAt: new Date("2026-05-04T12:01:00Z") },
            { role: "user", content: "first", thinkingText: null, toolInvocations: null, validatorViolations: null, pendingMutationId: null, createdAt: new Date("2026-05-04T12:00:00Z") },
        ]);
        const out = await store.loadRecentMessages("stud_1", 3);
        expect(out.map((m) => m.content)).toEqual(["first", "second", "third"]);

        const ops = stub.calls.map((c) => c.op);
        expect(ops).toEqual(["select", "from", "where", "orderBy", "limit"]);
        expect(stub.calls[1]!.args[0]).toBe(chatMessages);
        expect(stub.calls[4]!.args[0]).toBe(3);
    });

    it("defaults the limit to 50 when omitted", async () => {
        stub.setNextSelectResult([]);
        await store.loadRecentMessages("stud_1");
        const limitCall = stub.calls.find((c) => c.op === "limit")!;
        expect(limitCall.args[0]).toBe(50);
    });

    it("converts Date objects to ISO strings on read", async () => {
        const ts = new Date("2026-05-04T12:00:00Z");
        stub.setNextSelectResult([
            { role: "user", content: "hi", thinkingText: null, toolInvocations: null, validatorViolations: null, pendingMutationId: null, createdAt: ts },
        ]);
        const out = await store.loadRecentMessages("stud_1", 1);
        expect(out[0]!.createdAt).toBe(ts.toISOString());
    });
});

describe("PostgresChatHistoryStore — clearForStudent", () => {
    it("deletes from chat_messages where studentId matches", async () => {
        const stub = new StubDatabase();
        const store = new PostgresChatHistoryStore(stub as unknown as Database);
        await store.clearForStudent("stud_1");
        const ops = stub.calls.map((c) => c.op);
        expect(ops[0]).toBe("delete");
        expect(stub.calls[0]!.args[0]).toBe(chatMessages);
        expect(ops).toContain("where");
    });
});
