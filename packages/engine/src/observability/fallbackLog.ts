// ============================================================
// Fallback log (Phase 6 WS4 — §6.4 / §9.1 / §10 / §12.6.5 cohort B)
// ============================================================
// Append-only structured event log for the operational signals the
// architecture references but never wires:
//
//   §6.4   "model fallback triggered"
//   §9.1   "validator blocked a reply"; "max-turns exhausted"
//   §10    "tool returned 'unsupported'"
//   §11.0  "data conflict unresolved"
//   §12.6.5 cohort B daily review of fallback_log.jsonl
//
// One event per line, JSONL. Default sink writes to the path in
// NYUPATH_FALLBACK_LOG_PATH (or /var/log/nyupath/fallback_log.jsonl).
// Tests inject an in-memory sink — the writer takes a `sink` parameter
// so we never touch the filesystem in the unit-test path.
// ============================================================

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type FallbackEventKind =
    | "model_fallback_triggered"
    | "model_error_no_fallback"
    | "max_turns"
    | "validator_block"
    | "tool_unsupported"
    | "low_confidence_rag"
    | "data_conflict_unresolved";

export interface FallbackEvent {
    kind: FallbackEventKind;
    /** ISO timestamp the event was recorded */
    ts: string;
    /** Free-form human-readable detail */
    detail: string;
    /** Stable correlation id for the conversation/request */
    correlationId?: string;
    /** Tool name, when applicable */
    toolName?: string;
    /** Model id (e.g., the failing primary's id), when applicable */
    modelId?: string;
    /** Additional structured payload — kept open so callers can tack on
     *  per-event-kind context without breaking the schema. */
    extra?: Record<string, unknown>;
}

export interface FallbackSink {
    record(ev: FallbackEvent): void;
}

/** In-memory sink for tests + tools that need to introspect events. */
export class InMemoryFallbackSink implements FallbackSink {
    public readonly events: FallbackEvent[] = [];
    record(ev: FallbackEvent): void {
        this.events.push(ev);
    }
    clear(): void {
        this.events.length = 0;
    }
}

/** No-op sink used as the default when callers don't supply one. */
export const NULL_SINK: FallbackSink = { record: () => { /* drop */ } };

/** JSONL append sink — production default. Lazy-creates the parent dir. */
export class JsonlFileSink implements FallbackSink {
    constructor(private readonly path: string) {}
    record(ev: FallbackEvent): void {
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            appendFileSync(this.path, JSON.stringify(ev) + "\n", "utf-8");
        } catch {
            // Logging failures must never break the agent. Silently
            // drop; ops can backfill from STDOUT if needed.
        }
    }
}

/** Resolve the production-default sink. Returns NULL_SINK when neither
 *  the env var nor a path is configured — keeps unit tests pure. */
export function defaultProductionSink(env: Record<string, string | undefined> = process.env): FallbackSink {
    const path = env.NYUPATH_FALLBACK_LOG_PATH;
    if (!path) return NULL_SINK;
    return new JsonlFileSink(path);
}

/** Convenience helper: emit an event with `ts` auto-stamped. */
export function emitFallback(
    sink: FallbackSink,
    kind: FallbackEventKind,
    detail: string,
    extra?: Omit<FallbackEvent, "kind" | "ts" | "detail">,
): void {
    sink.record({
        kind,
        ts: new Date().toISOString(),
        detail,
        ...(extra ?? {}),
    });
}
