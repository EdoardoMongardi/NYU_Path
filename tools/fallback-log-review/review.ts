// ============================================================
// fallback_log.jsonl daily-review CLI (Phase 6.5 P-6)
// ============================================================
// Reads a fallback-log JSONL file and prints a human-readable
// summary the daily / weekly review meeting (§12.6.5 cohort B+
// review cadence) walks through. Pure JSONL parser + aggregation —
// no engine deps so it runs in CI or any node environment.
//
// Usage:
//   pnpm tsx tools/fallback-log-review/review.ts \
//     --path /var/log/nyupath/fallback_log.jsonl \
//     [--since 2026-04-26T00:00:00Z]
//
// Output sections (per §12.6.5):
//   1. Headline — total events, unique correlationIds, time range
//   2. Per-kind counts (model_fallback_triggered, max_turns, etc.)
//   3. Top 10 unsupported tools (kind=tool_unsupported)
//   4. Top 10 model-fallback triggers (modelId)
//   5. Per-correlationId narrative for the worst-case turns
// ============================================================

import { readFileSync } from "node:fs";

// Mirror packages/engine/src/observability/fallbackLog.ts:FallbackEvent
// (this file is intentionally engine-free so the CLI runs in CI
// without needing the engine workspace built).
export interface FallbackEvent {
    kind: string;
    ts: string;
    detail: string;
    correlationId?: string;
    toolName?: string;
    modelId?: string;
    extra?: Record<string, unknown>;
}

export interface FallbackLogReport {
    totalEvents: number;
    uniqueCorrelationIds: number;
    earliestTs: string | null;
    latestTs: string | null;
    perKindCounts: Record<string, number>;
    topUnsupportedTools: Array<{ toolName: string; count: number }>;
    topFallbackModels: Array<{ modelId: string; count: number }>;
    /** Per-correlationId roll-up: how many fallback events fired for
     *  each conversation. The review meeting walks the top entries. */
    worstCorrelationIds: Array<{ correlationId: string; eventCount: number; kinds: string[] }>;
}

/** Parse a JSONL string into events. Skips blank/comment lines. */
export function parseFallbackLog(text: string): FallbackEvent[] {
    const out: FallbackEvent[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("//") || line.startsWith("#")) continue;
        try {
            out.push(JSON.parse(line) as FallbackEvent);
        } catch {
            // Skip malformed lines silently — corrupt lines should
            // not block the review of the rest of the day.
        }
    }
    return out;
}

export function aggregate(events: FallbackEvent[], opts: { since?: string } = {}): FallbackLogReport {
    const filtered = opts.since
        ? events.filter((e) => e.ts >= opts.since!)
        : events;

    const perKindCounts: Record<string, number> = {};
    const toolCounts = new Map<string, number>();
    const modelCounts = new Map<string, number>();
    const corrIds = new Set<string>();
    const corrEvents = new Map<string, { count: number; kinds: Set<string> }>();
    let earliest: string | null = null;
    let latest: string | null = null;

    for (const e of filtered) {
        perKindCounts[e.kind] = (perKindCounts[e.kind] ?? 0) + 1;
        if (e.kind === "tool_unsupported" && e.toolName) {
            toolCounts.set(e.toolName, (toolCounts.get(e.toolName) ?? 0) + 1);
        }
        if (e.kind === "model_fallback_triggered" && e.modelId) {
            modelCounts.set(e.modelId, (modelCounts.get(e.modelId) ?? 0) + 1);
        }
        if (e.correlationId) {
            corrIds.add(e.correlationId);
            const bucket = corrEvents.get(e.correlationId) ?? { count: 0, kinds: new Set<string>() };
            bucket.count += 1;
            bucket.kinds.add(e.kind);
            corrEvents.set(e.correlationId, bucket);
        }
        if (!earliest || e.ts < earliest) earliest = e.ts;
        if (!latest || e.ts > latest) latest = e.ts;
    }

    const topUnsupportedTools = [...toolCounts.entries()]
        .map(([toolName, count]) => ({ toolName, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    const topFallbackModels = [...modelCounts.entries()]
        .map(([modelId, count]) => ({ modelId, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    const worstCorrelationIds = [...corrEvents.entries()]
        .map(([correlationId, b]) => ({ correlationId, eventCount: b.count, kinds: [...b.kinds] }))
        .sort((a, b) => b.eventCount - a.eventCount)
        .slice(0, 10);

    return {
        totalEvents: filtered.length,
        uniqueCorrelationIds: corrIds.size,
        earliestTs: earliest,
        latestTs: latest,
        perKindCounts,
        topUnsupportedTools,
        topFallbackModels,
        worstCorrelationIds,
    };
}

export function formatReport(r: FallbackLogReport): string {
    const lines: string[] = [];
    lines.push("=== fallback_log.jsonl review ===");
    lines.push(`Time range: ${r.earliestTs ?? "(none)"} → ${r.latestTs ?? "(none)"}`);
    lines.push(`Total events: ${r.totalEvents}`);
    lines.push(`Unique correlation ids: ${r.uniqueCorrelationIds}`);
    lines.push("");
    lines.push("Events per kind:");
    for (const [k, n] of Object.entries(r.perKindCounts).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${k}: ${n}`);
    }
    if (r.topUnsupportedTools.length > 0) {
        lines.push("");
        lines.push("Top unsupported tools:");
        for (const t of r.topUnsupportedTools) lines.push(`  ${t.toolName}: ${t.count}`);
    }
    if (r.topFallbackModels.length > 0) {
        lines.push("");
        lines.push("Top fallback-triggering models:");
        for (const m of r.topFallbackModels) lines.push(`  ${m.modelId}: ${m.count}`);
    }
    if (r.worstCorrelationIds.length > 0) {
        lines.push("");
        lines.push("Top conversations by event count:");
        for (const c of r.worstCorrelationIds) {
            lines.push(`  ${c.correlationId}: ${c.eventCount} events (${c.kinds.join(", ")})`);
        }
    }
    return lines.join("\n");
}

// ============================================================
// CLI entry point
// ============================================================

function parseFlag(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
    const path = parseFlag("path");
    const since = parseFlag("since");
    if (!path) {
        process.stderr.write("Required flag: --path <fallback_log.jsonl>  [--since <iso8601>]\n");
        process.exit(1);
    }
    const text = readFileSync(path, "utf-8");
    const events = parseFallbackLog(text);
    const report = aggregate(events, since ? { since } : {});
    process.stdout.write(formatReport(report) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
