// ============================================================
// Session-summary persistence (Phase 7-A P-9 / §7.3)
// ============================================================
// Architecture §7.3 specifies a rolling-window of the last 5 session
// summaries (~600 tokens each) appended to a student's profile. This
// module is the persistence layer behind that rolling window.
//
// Phase 7-A scope: file-backed (one JSON file per student id under
// `NYUPATH_SESSION_STORE_PATH ?? ./.nyupath-sessions`). A
// Postgres-backed implementation can swap in by satisfying the
// `SessionStore` interface — production will swap when cohort C
// scale demands it.
// ============================================================

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
    type FallbackSink,
    NULL_SINK,
    emitFallback,
    defaultProductionSink,
} from "../observability/fallbackLog.js";

export interface SessionSummary {
    /** ISO date the session occurred. */
    date: string;
    /** ~600-token natural-language summary the agent wrote at end of turn. */
    summary: string;
}

export interface StudentSessionRecord {
    studentId: string;
    /** Rolling window of the last 5 session summaries (most recent last). */
    sessionSummaries: SessionSummary[];
    /** ISO date of the most recent session — used for "welcome back" context. */
    lastSessionDate?: string;
}

/** Maximum number of summaries kept (architecture §7.3 line 1736). */
export const MAX_SESSION_SUMMARIES = 5;

export interface SessionStore {
    /** Read the current record for a student. Returns an empty record
     *  if none exists yet. */
    get(studentId: string): Promise<StudentSessionRecord>;
    /** Append a new summary, trim to MAX_SESSION_SUMMARIES, persist. */
    appendSummary(studentId: string, summary: SessionSummary): Promise<StudentSessionRecord>;
    /** Replace a record entirely (used by tests + cohort imports). */
    replace(record: StudentSessionRecord): Promise<void>;
}

// ============================================================
// In-memory implementation (tests + dev)
// ============================================================

export class InMemorySessionStore implements SessionStore {
    private readonly records = new Map<string, StudentSessionRecord>();

    async get(studentId: string): Promise<StudentSessionRecord> {
        return this.records.get(studentId) ?? { studentId, sessionSummaries: [] };
    }

    async appendSummary(studentId: string, summary: SessionSummary): Promise<StudentSessionRecord> {
        const current = await this.get(studentId);
        const next: StudentSessionRecord = {
            studentId,
            sessionSummaries: [...current.sessionSummaries, summary].slice(-MAX_SESSION_SUMMARIES),
            lastSessionDate: summary.date,
        };
        this.records.set(studentId, next);
        return next;
    }

    async replace(record: StudentSessionRecord): Promise<void> {
        this.records.set(record.studentId, record);
    }

    /** Test-only helper. */
    clear(): void {
        this.records.clear();
    }
}

// ============================================================
// File-backed implementation (production until Postgres lands)
// ============================================================

export class FileBackedSessionStore implements SessionStore {
    private readonly fallbackSink: FallbackSink;

    constructor(
        private readonly rootDir: string,
        opts: { fallbackSink?: FallbackSink } = {},
    ) {
        this.fallbackSink = opts.fallbackSink ?? NULL_SINK;
        try {
            mkdirSync(this.rootDir, { recursive: true });
        } catch {
            // dir may already exist or path may be invalid — failures
            // are surfaced on read/write below.
        }
    }

    private pathFor(studentId: string): string {
        // Sanitize the student id to avoid directory traversal.
        const safe = studentId.replace(/[^a-zA-Z0-9_.-]/g, "_");
        return join(this.rootDir, `${safe}.json`);
    }

    async get(studentId: string): Promise<StudentSessionRecord> {
        const path = this.pathFor(studentId);
        if (!existsSync(path)) return { studentId, sessionSummaries: [] };
        try {
            const raw = readFileSync(path, "utf-8");
            const parsed = JSON.parse(raw) as StudentSessionRecord;
            // Defensive: trim if a previous version wrote more than MAX.
            return {
                ...parsed,
                sessionSummaries: parsed.sessionSummaries.slice(-MAX_SESSION_SUMMARIES),
            };
        } catch {
            // Corrupt file — surface as empty rather than crashing the
            // turn. The next appendSummary will overwrite it cleanly.
            return { studentId, sessionSummaries: [] };
        }
    }

    async appendSummary(studentId: string, summary: SessionSummary): Promise<StudentSessionRecord> {
        const current = await this.get(studentId);
        const next: StudentSessionRecord = {
            studentId,
            sessionSummaries: [...current.sessionSummaries, summary].slice(-MAX_SESSION_SUMMARIES),
            lastSessionDate: summary.date,
        };
        await this.replace(next);
        return next;
    }

    async replace(record: StudentSessionRecord): Promise<void> {
        const path = this.pathFor(record.studentId);
        try {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, JSON.stringify(record, null, 2) + "\n", "utf-8");
        } catch (err) {
            // Persistence failures should NOT break the live turn.
            // The agent loop's session is the source of truth for the
            // current request; the file is the cross-session memory.
            // Phase 7-A reviewer P3: route failures through the
            // observability FallbackSink for consistency with the
            // agent loop's fallback logging pattern (data_conflict_unresolved
            // is the closest existing event kind for "the persistent
            // store rejected a write").
            emitFallback(
                this.fallbackSink,
                "data_conflict_unresolved",
                `FileBackedSessionStore.replace failed for studentId=${record.studentId}: ${err instanceof Error ? err.message : String(err)}`,
                { extra: { rootDir: this.rootDir, path } },
            );
        }
    }
}

// ============================================================
// Production-default factory
// ============================================================

/** Resolve the production-default session store. Returns an in-
 *  memory store when `NYUPATH_SESSION_STORE_PATH` is unset (tests
 *  + dev) and a file-backed store otherwise. The file-backed store
 *  routes write failures through `defaultProductionSink(env)` so
 *  ops sees them in fallback_log.jsonl alongside agent-loop events. */
export function defaultSessionStore(env: Record<string, string | undefined> = process.env): SessionStore {
    const root = env.NYUPATH_SESSION_STORE_PATH;
    if (!root) return new InMemorySessionStore();
    return new FileBackedSessionStore(root, { fallbackSink: defaultProductionSink(env) });
}

// ============================================================
// priorMessages helper — reads sessionSummaries and emits the
// system-prompt-friendly preface the agent loop consumes.
// ============================================================

/**
 * Format a student's sessionSummaries as a leading "system" message
 * the agent loop can prepend to `priorMessages`. The architecture
 * (§7.3 line 1716) wants the last ~3 summaries injected; we cap at
 * MAX_SESSION_SUMMARIES (5) so the runtime can choose how many.
 */
export function summariesAsPriorMessage(record: StudentSessionRecord, count = 3): string | null {
    if (record.sessionSummaries.length === 0) return null;
    const recent = record.sessionSummaries.slice(-count);
    const lines = ["Prior advising sessions (most recent last):"];
    for (const s of recent) {
        lines.push(`- ${s.date}: ${s.summary}`);
    }
    return lines.join("\n");
}
