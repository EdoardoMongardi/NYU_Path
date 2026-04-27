// ============================================================
// Phase 6.5 P-6 — fallback_log review CLI tests
// ============================================================

import { describe, expect, it } from "vitest";
import { parseFallbackLog, aggregate, formatReport, type FallbackEvent } from "../../tools/fallback-log-review/review.js";

describe("parseFallbackLog (Phase 6.5 P-6)", () => {
    it("parses one event per JSONL line", () => {
        const text = [
            JSON.stringify({ kind: "max_turns", ts: "2026-04-26T10:00:00Z", detail: "..." }),
            JSON.stringify({ kind: "tool_unsupported", ts: "2026-04-26T10:01:00Z", detail: "...", toolName: "x" }),
        ].join("\n");
        const events = parseFallbackLog(text);
        expect(events).toHaveLength(2);
        expect(events[0]!.kind).toBe("max_turns");
    });

    it("skips blank lines, comment lines, and malformed JSON", () => {
        const text = [
            "",
            "# this is a comment",
            "// also a comment",
            "{ not json",
            JSON.stringify({ kind: "max_turns", ts: "2026-04-26T10:00:00Z", detail: "..." }),
        ].join("\n");
        const events = parseFallbackLog(text);
        expect(events).toHaveLength(1);
    });
});

describe("aggregate (Phase 6.5 P-6)", () => {
    function makeEvent(kind: string, partial: Partial<FallbackEvent> = {}): FallbackEvent {
        return {
            kind,
            ts: partial.ts ?? "2026-04-26T10:00:00Z",
            detail: partial.detail ?? "",
            ...partial,
        };
    }

    it("counts events per kind", () => {
        const r = aggregate([
            makeEvent("max_turns"),
            makeEvent("max_turns"),
            makeEvent("tool_unsupported", { toolName: "X" }),
        ]);
        expect(r.totalEvents).toBe(3);
        expect(r.perKindCounts.max_turns).toBe(2);
        expect(r.perKindCounts.tool_unsupported).toBe(1);
    });

    it("ranks the top unsupported tools by count", () => {
        const r = aggregate([
            makeEvent("tool_unsupported", { toolName: "A" }),
            makeEvent("tool_unsupported", { toolName: "B" }),
            makeEvent("tool_unsupported", { toolName: "B" }),
            makeEvent("tool_unsupported", { toolName: "C" }),
            makeEvent("tool_unsupported", { toolName: "C" }),
            makeEvent("tool_unsupported", { toolName: "C" }),
        ]);
        expect(r.topUnsupportedTools[0]).toEqual({ toolName: "C", count: 3 });
        expect(r.topUnsupportedTools[1]).toEqual({ toolName: "B", count: 2 });
        expect(r.topUnsupportedTools[2]).toEqual({ toolName: "A", count: 1 });
    });

    it("ranks the top fallback-triggering models", () => {
        const r = aggregate([
            makeEvent("model_fallback_triggered", { modelId: "openai:gpt-4.1-mini" }),
            makeEvent("model_fallback_triggered", { modelId: "openai:gpt-4.1-mini" }),
            makeEvent("model_fallback_triggered", { modelId: "anthropic:claude-x" }),
        ]);
        expect(r.topFallbackModels[0]!.modelId).toBe("openai:gpt-4.1-mini");
        expect(r.topFallbackModels[0]!.count).toBe(2);
    });

    it("rolls up events per correlationId", () => {
        const r = aggregate([
            makeEvent("max_turns", { correlationId: "req-1" }),
            makeEvent("tool_unsupported", { correlationId: "req-1", toolName: "X" }),
            makeEvent("max_turns", { correlationId: "req-2" }),
        ]);
        expect(r.uniqueCorrelationIds).toBe(2);
        const top = r.worstCorrelationIds.find((c) => c.correlationId === "req-1");
        expect(top?.eventCount).toBe(2);
        expect(top?.kinds.sort()).toEqual(["max_turns", "tool_unsupported"]);
    });

    it("filters by --since timestamp", () => {
        const r = aggregate(
            [
                makeEvent("max_turns", { ts: "2026-04-25T10:00:00Z" }),
                makeEvent("max_turns", { ts: "2026-04-26T10:00:00Z" }),
                makeEvent("max_turns", { ts: "2026-04-27T10:00:00Z" }),
            ],
            { since: "2026-04-26T00:00:00Z" },
        );
        expect(r.totalEvents).toBe(2);
    });

    it("tracks earliest/latest timestamps", () => {
        const r = aggregate([
            makeEvent("max_turns", { ts: "2026-04-26T12:00:00Z" }),
            makeEvent("max_turns", { ts: "2026-04-26T08:00:00Z" }),
            makeEvent("max_turns", { ts: "2026-04-26T16:00:00Z" }),
        ]);
        expect(r.earliestTs).toBe("2026-04-26T08:00:00Z");
        expect(r.latestTs).toBe("2026-04-26T16:00:00Z");
    });
});

describe("formatReport (Phase 6.5 P-6)", () => {
    it("includes all section headings", () => {
        const r = aggregate([
            { kind: "max_turns", ts: "2026-04-26T10:00:00Z", detail: "", correlationId: "c1" },
            { kind: "tool_unsupported", ts: "2026-04-26T10:01:00Z", detail: "", correlationId: "c1", toolName: "X" },
            { kind: "model_fallback_triggered", ts: "2026-04-26T10:02:00Z", detail: "", modelId: "openai:m" },
        ]);
        const out = formatReport(r);
        expect(out).toMatch(/Total events: 3/);
        expect(out).toMatch(/Events per kind/);
        expect(out).toMatch(/Top unsupported tools/);
        expect(out).toMatch(/Top fallback-triggering models/);
        expect(out).toMatch(/Top conversations by event count/);
    });

    it("omits empty sections gracefully", () => {
        const r = aggregate([{ kind: "max_turns", ts: "2026-04-26T10:00:00Z", detail: "" }]);
        const out = formatReport(r);
        expect(out).not.toMatch(/Top unsupported tools/);
        expect(out).not.toMatch(/Top fallback-triggering models/);
    });
});
