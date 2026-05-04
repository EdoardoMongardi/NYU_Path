// ============================================================
// PostgresChatHistoryStore (Phase 16 Task A)
// ============================================================
// Drizzle-backed implementation of the engine's `ChatHistoryStore`
// interface. Append-only insert; load reads the last N rows ordered
// by `id` so the timeline is monotonic regardless of clock skew.
// ============================================================

import type {
    ChatHistoryStore,
    ChatMessageRecord,
} from "@nyupath/engine";
import { asc, desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { chatMessages, students } from "./schema.js";

const DEFAULT_LOAD_LIMIT = 50;

export class PostgresChatHistoryStore implements ChatHistoryStore {
    constructor(private readonly db: Database) {}

    async appendMessage(studentId: string, message: ChatMessageRecord): Promise<void> {
        // Ensure FK target — same idempotent pattern the other stores use.
        await this.db
            .insert(students)
            .values({ studentId })
            .onConflictDoNothing({ target: students.studentId });
        await this.db.insert(chatMessages).values({
            studentId,
            role: message.role,
            content: message.content,
            thinkingText: message.thinkingText ?? null,
            toolInvocations:
                message.toolInvocations !== undefined
                    ? (message.toolInvocations as unknown as object)
                    : null,
            validatorViolations:
                message.validatorViolations !== undefined
                    ? (message.validatorViolations as unknown as object)
                    : null,
            pendingMutationId: message.pendingMutationId ?? null,
            createdAt: new Date(message.createdAt),
        });
    }

    async loadRecentMessages(
        studentId: string,
        limit: number = DEFAULT_LOAD_LIMIT,
    ): Promise<ChatMessageRecord[]> {
        // Pull the last N by id descending, then reverse so the caller
        // sees chronological order (oldest → newest).
        const rows = await this.db
            .select({
                role: chatMessages.role,
                content: chatMessages.content,
                thinkingText: chatMessages.thinkingText,
                toolInvocations: chatMessages.toolInvocations,
                validatorViolations: chatMessages.validatorViolations,
                pendingMutationId: chatMessages.pendingMutationId,
                createdAt: chatMessages.createdAt,
            })
            .from(chatMessages)
            .where(eq(chatMessages.studentId, studentId))
            .orderBy(desc(chatMessages.id))
            .limit(limit);
        const ordered = [...rows].reverse();
        return ordered.map((r) => {
            const out: ChatMessageRecord = {
                role: r.role as ChatMessageRecord["role"],
                content: r.content,
                createdAt: r.createdAt instanceof Date
                    ? r.createdAt.toISOString()
                    : String(r.createdAt),
            };
            if (r.thinkingText !== null && r.thinkingText !== undefined) {
                out.thinkingText = r.thinkingText;
            }
            if (r.toolInvocations !== null && r.toolInvocations !== undefined) {
                out.toolInvocations = r.toolInvocations as ChatMessageRecord["toolInvocations"];
            }
            if (r.validatorViolations !== null && r.validatorViolations !== undefined) {
                out.validatorViolations = r.validatorViolations as ChatMessageRecord["validatorViolations"];
            }
            if (r.pendingMutationId !== null && r.pendingMutationId !== undefined) {
                out.pendingMutationId = r.pendingMutationId;
            }
            return out;
        });
    }

    async clearForStudent(studentId: string): Promise<void> {
        await this.db
            .delete(chatMessages)
            .where(eq(chatMessages.studentId, studentId));
    }

    /**
     * Test-only helper: load all messages in chronological order
     * (no limit). Mirrors what the InMemory store exposes via internal
     * arrays.
     */
    async loadAllForTest(studentId: string): Promise<ChatMessageRecord[]> {
        const rows = await this.db
            .select({
                role: chatMessages.role,
                content: chatMessages.content,
                thinkingText: chatMessages.thinkingText,
                toolInvocations: chatMessages.toolInvocations,
                validatorViolations: chatMessages.validatorViolations,
                pendingMutationId: chatMessages.pendingMutationId,
                createdAt: chatMessages.createdAt,
            })
            .from(chatMessages)
            .where(eq(chatMessages.studentId, studentId))
            .orderBy(asc(chatMessages.id));
        return rows.map((r) => {
            const out: ChatMessageRecord = {
                role: r.role as ChatMessageRecord["role"],
                content: r.content,
                createdAt: r.createdAt instanceof Date
                    ? r.createdAt.toISOString()
                    : String(r.createdAt),
            };
            if (r.thinkingText !== null && r.thinkingText !== undefined) {
                out.thinkingText = r.thinkingText;
            }
            if (r.toolInvocations !== null && r.toolInvocations !== undefined) {
                out.toolInvocations = r.toolInvocations as ChatMessageRecord["toolInvocations"];
            }
            if (r.validatorViolations !== null && r.validatorViolations !== undefined) {
                out.validatorViolations = r.validatorViolations as ChatMessageRecord["validatorViolations"];
            }
            if (r.pendingMutationId !== null && r.pendingMutationId !== undefined) {
                out.pendingMutationId = r.pendingMutationId;
            }
            return out;
        });
    }
}
