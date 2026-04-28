// ============================================================
// Observability dashboard (Phase 7-E W10.6)
// ============================================================
// Operator-only read-only view of the in-process fallback_log
// events. Renders as a server component so we can read the
// JSONL file directly from the local fs without exposing it
// through an API route.
//
// What it shows: per-event-kind counts (e.g., 47 transition
// events, 2 validator_replay events, 0 model_error_no_fallback
// events) + the last 200 events in reverse-chronological order.
//
// Why: ARCHITECTURE.md §12.6.5 cohort-B precondition is "ops
// reviews fallback_log.jsonl daily." We start that habit in
// cohort A so it's a known-good ritual before scale.
//
// Auth: cohort A runs anonymous-mode (no auth). This page is
// guarded by IP allow-list at the deployment layer (TODO once
// W12 ships, gate via JWT + ADMIN_EMAILS check).
// ============================================================

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

interface FallbackEvent {
    kind: string;
    ts: string;
    detail?: string;
    correlationId?: string;
    toolName?: string;
    modelId?: string;
    extra?: Record<string, unknown>;
}

const LOG_PATH_CANDIDATES = [
    process.env.NYUPATH_FALLBACK_LOG_PATH,
    join(process.cwd(), "data", "fallback_log.jsonl"),
    join(process.cwd(), "..", "..", "data", "fallback_log.jsonl"),
].filter((p): p is string => Boolean(p));

function loadEvents(): { events: FallbackEvent[]; path: string | null; sizeKb: number } {
    for (const path of LOG_PATH_CANDIDATES) {
        if (existsSync(path)) {
            const raw = readFileSync(path, "utf-8");
            const events: FallbackEvent[] = [];
            for (const line of raw.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    events.push(JSON.parse(trimmed) as FallbackEvent);
                } catch { /* skip malformed line */ }
            }
            const stat = statSync(path);
            return { events, path, sizeKb: stat.size / 1024 };
        }
    }
    return { events: [], path: null, sizeKb: 0 };
}

function countByKind(events: FallbackEvent[]): Array<[string, number]> {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
}

function formatTs(ts: string): string {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

export const dynamic = "force-dynamic";

export default function ObservabilityPage() {
    const { events, path, sizeKb } = loadEvents();
    const counts = countByKind(events);
    const recent = events.slice(-200).reverse();
    const operationalKinds = new Set([
        "model_error_no_fallback",
        "validator_block",
        "max_turns",
        "tool_unsupported",
        "data_conflict_unresolved",
    ]);
    const operationalCount = counts
        .filter(([k]) => operationalKinds.has(k))
        .reduce((s, [, n]) => s + n, 0);

    return (
        <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 1100, margin: "2rem auto", padding: "0 1rem" }}>
            <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>NYU Path — Observability</h1>
            <p style={{ color: "#555", fontSize: "0.9rem", marginTop: 0 }}>
                Cohort-A operator dashboard. Read-only.{" "}
                {path
                    ? `Source: ${path} (${sizeKb.toFixed(1)} KB, ${events.length} events)`
                    : `No log file found. Set NYUPATH_FALLBACK_LOG_PATH or place at data/fallback_log.jsonl.`}
            </p>

            <div style={{
                background: operationalCount > 0 ? "#fff3e0" : "#e8f5e9",
                border: `1px solid ${operationalCount > 0 ? "#f0a040" : "#a0d0a0"}`,
                padding: "0.75rem 1rem",
                borderRadius: 6,
                marginBottom: "1.5rem",
            }}>
                <strong>{operationalCount > 0 ? "⚠ Operational events present" : "✓ All clear"}</strong>
                <span style={{ marginLeft: "1rem", color: "#555" }}>
                    {operationalCount} operational event{operationalCount === 1 ? "" : "s"} in window
                    (model_error_no_fallback, validator_block, max_turns, tool_unsupported, data_conflict_unresolved)
                </span>
            </div>

            <h2 style={{ fontSize: "1.1rem", borderBottom: "1px solid #ddd", paddingBottom: "0.25rem" }}>
                Counts by kind
            </h2>
            {counts.length === 0 ? (
                <p style={{ color: "#888" }}>No events in the log yet.</p>
            ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                    <thead>
                        <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                            <th style={{ padding: "0.4rem" }}>Kind</th>
                            <th style={{ padding: "0.4rem", textAlign: "right" }}>Count</th>
                            <th style={{ padding: "0.4rem" }}>Severity</th>
                        </tr>
                    </thead>
                    <tbody>
                        {counts.map(([kind, n]) => (
                            <tr key={kind} style={{ borderBottom: "1px solid #f0f0f0" }}>
                                <td style={{ padding: "0.4rem", fontFamily: "monospace" }}>{kind}</td>
                                <td style={{ padding: "0.4rem", textAlign: "right" }}>{n}</td>
                                <td style={{ padding: "0.4rem" }}>
                                    {operationalKinds.has(kind)
                                        ? <span style={{ color: "#c00" }}>operational</span>
                                        : <span style={{ color: "#888" }}>observability</span>}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            <h2 style={{ fontSize: "1.1rem", borderBottom: "1px solid #ddd", paddingBottom: "0.25rem", marginTop: "2rem" }}>
                Recent events (last 200, newest first)
            </h2>
            {recent.length === 0 ? (
                <p style={{ color: "#888" }}>No events.</p>
            ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                    <thead>
                        <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
                            <th style={{ padding: "0.3rem" }}>Time</th>
                            <th style={{ padding: "0.3rem" }}>Kind</th>
                            <th style={{ padding: "0.3rem" }}>Tool</th>
                            <th style={{ padding: "0.3rem" }}>Detail</th>
                        </tr>
                    </thead>
                    <tbody>
                        {recent.map((e, i) => (
                            <tr key={i} style={{ borderBottom: "1px solid #f5f5f5" }}>
                                <td style={{ padding: "0.3rem", whiteSpace: "nowrap" }}>{formatTs(e.ts)}</td>
                                <td style={{ padding: "0.3rem", fontFamily: "monospace",
                                    color: operationalKinds.has(e.kind) ? "#c00" : "inherit" }}>
                                    {e.kind}
                                </td>
                                <td style={{ padding: "0.3rem", fontFamily: "monospace" }}>{e.toolName ?? ""}</td>
                                <td style={{ padding: "0.3rem", color: "#555" }}>
                                    {(e.detail ?? "").slice(0, 220)}
                                    {(e.detail ?? "").length > 220 ? "…" : ""}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}

            <p style={{ marginTop: "2rem", fontSize: "0.8rem", color: "#888" }}>
                Page is server-rendered on each request. Configure log path via{" "}
                <code>NYUPATH_FALLBACK_LOG_PATH</code> env var.
            </p>
        </div>
    );
}
