// ============================================================
// ChatHistoryStore — durable chat transcript (Phase 16 Task A)
// ============================================================
// Append-only log of every chat turn the student sees: user message,
// assistant reply, tool invocations, validator violations, and any
// pendingMutationId surfaced this turn (the click-to-confirm UI for
// `update_profile` previews).
//
// Phase 5–15 stored chat history only in the client's React state —
// every reload wiped the conversation. Phase 16 makes the in-memory
// transcript a *cache* of `chat_messages`. Login restore reads the
// most-recent N rows (default 50, configurable via
// `NYUPATH_CHAT_HISTORY_RESTORE_LIMIT`); older rows stay in the DB
// for audit but aren't restored to the UI.
//
// Per Decision #16.5: every turn writes both the user + assistant
// message, so the rendered transcript matches what the student saw
// last session, including the pending-confirmation buttons for any
// still-open profile mutations.
// ============================================================

import type { ToolInvocation } from "../agent/agentLoop.js";

export interface ChatMessageRecord {
    role: "user" | "assistant" | "system";
    content: string;
    /** Assistant's chain-of-thought (if any). */
    thinkingText?: string;
    /** Tool invocations the agent made during this turn. */
    toolInvocations?: ToolInvocation[];
    /** Validator violations the post-loop validator surfaced. */
    validatorViolations?: Array<{ kind: string; detail: string; caveatId?: string }>;
    /** pendingMutationId surfaced this turn (if `update_profile` ran). */
    pendingMutationId?: string;
    /** ISO timestamp the message was written. */
    createdAt: string;
}

export interface ChatHistoryStore {
    /** Append one message to the student's chat history. */
    appendMessage(studentId: string, message: ChatMessageRecord): Promise<void>;
    /**
     * Load the most-recent N messages for a student in chronological
     * order (oldest → newest). When `limit` is omitted, defaults to
     * 50 (matches the page-bootstrap N referenced in the Phase 16
     * locked design choices).
     */
    loadRecentMessages(studentId: string, limit?: number): Promise<ChatMessageRecord[]>;
    /** Wipe every message for a student (test-affordance Clear button). */
    clearForStudent(studentId: string): Promise<void>;
}

const DEFAULT_LOAD_LIMIT = 50;

// ============================================================
// InMemoryChatHistoryStore — dev + test default
// ============================================================
// One array per student. Append is O(1); load slices the tail.
// Clears on process exit.
// ============================================================

export class InMemoryChatHistoryStore implements ChatHistoryStore {
    private readonly messages = new Map<string, ChatMessageRecord[]>();

    async appendMessage(studentId: string, message: ChatMessageRecord): Promise<void> {
        const list = this.messages.get(studentId) ?? [];
        list.push(message);
        this.messages.set(studentId, list);
    }

    async loadRecentMessages(
        studentId: string,
        limit: number = DEFAULT_LOAD_LIMIT,
    ): Promise<ChatMessageRecord[]> {
        const list = this.messages.get(studentId);
        if (!list || list.length === 0) return [];
        // Tail of `limit`, chronological.
        return list.slice(-limit);
    }

    async clearForStudent(studentId: string): Promise<void> {
        this.messages.delete(studentId);
    }

    /** Test-only: wipe everything across every student. */
    clear(): void {
        this.messages.clear();
    }
}
