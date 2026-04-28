// ============================================================
// Phase 7-E W10.4 — session-summary persistence smoke test
// ============================================================
// Verifies that the file-backed session store actually prepends
// prior-session summaries on the next turn, end-to-end. The
// store + summariesAsPriorMessage helper were wired in Phase
// 7-A P-9 but never smoke-tested across multiple turns of one
// student's day. W10.4 closes that gate.
// ============================================================

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    FileBackedSessionStore,
    summariesAsPriorMessage,
    MAX_SESSION_SUMMARIES,
} from "../../src/persistence/sessionStore.js";

describe("W10.4 — session-summary persistence smoke test", () => {
    it("FileBackedSessionStore writes + reads back across instances (server restart simulation)", async () => {
        const root = mkdtempSync(join(tmpdir(), "nyupath-session-"));
        try {
            const store1 = new FileBackedSessionStore(root);
            await store1.appendSummary("alice", { date: "2026-04-28", summary: "Discussed CSCI-UA 421 prereqs." });
            await store1.appendSummary("alice", { date: "2026-04-29", summary: "Confirmed P/F deadline is Mar 1." });

            // Simulate server restart by spinning up a fresh instance
            // backed by the same on-disk root.
            const store2 = new FileBackedSessionStore(root);
            const record = await store2.get("alice");
            expect(record).not.toBeNull();
            expect(record!.sessionSummaries).toHaveLength(2);
            expect(record!.sessionSummaries[0]!.summary).toMatch(/CSCI-UA 421/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("summariesAsPriorMessage formats the rolling-window summary as a single system-prepend string", async () => {
        const root = mkdtempSync(join(tmpdir(), "nyupath-session-"));
        try {
            const store = new FileBackedSessionStore(root);
            await store.appendSummary("bob", { date: "2026-04-25", summary: "Asked about audit." });
            await store.appendSummary("bob", { date: "2026-04-26", summary: "Asked about transfer to Stern." });
            await store.appendSummary("bob", { date: "2026-04-27", summary: "Asked about Math minor." });
            const record = await store.get("bob");
            const prepend = summariesAsPriorMessage(record!, 3);
            expect(prepend).not.toBeNull();
            expect(prepend!).toContain("Asked about audit");
            expect(prepend!).toContain("Asked about transfer to Stern");
            expect(prepend!).toContain("Asked about Math minor");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rolling window evicts oldest beyond MAX_SESSION_SUMMARIES (default 5)", async () => {
        const root = mkdtempSync(join(tmpdir(), "nyupath-session-"));
        try {
            const store = new FileBackedSessionStore(root);
            for (let i = 0; i < MAX_SESSION_SUMMARIES + 3; i++) {
                await store.appendSummary("carol", {
                    date: `2026-04-${String(20 + i).padStart(2, "0")}`,
                    summary: `Day ${i} chat`,
                });
            }
            const record = await store.get("carol");
            expect(record!.sessionSummaries.length).toBeLessThanOrEqual(MAX_SESSION_SUMMARIES);
            // Oldest evicted: "Day 0" must be gone.
            const text = record!.sessionSummaries.map((s) => s.summary).join(" ");
            expect(text).not.toContain("Day 0 ");
            expect(text).not.toContain("Day 1 ");
            // Latest preserved.
            expect(text).toContain(`Day ${MAX_SESSION_SUMMARIES + 2} chat`);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("returns null prepend when the record has no summaries", async () => {
        const root = mkdtempSync(join(tmpdir(), "nyupath-session-"));
        try {
            const store = new FileBackedSessionStore(root);
            const empty = await store.get("nobody");
            // Store returns an empty record (not null) for unknown
            // students; summariesAsPriorMessage should return null when
            // the summaries array is empty.
            expect(empty.sessionSummaries).toHaveLength(0);
            expect(summariesAsPriorMessage(empty, 3)).toBeNull();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("file-on-disk is the canonical record (operator can inspect manually)", async () => {
        const root = mkdtempSync(join(tmpdir(), "nyupath-session-"));
        try {
            const store = new FileBackedSessionStore(root);
            await store.appendSummary("dave", { date: "2026-04-28", summary: "Smoke test entry." });
            // The file path should exist and be a JSONL we can inspect.
            // We don't assert the exact filename; just that something
            // got written under the root.
            const fs = await import("node:fs");
            const entries = fs.readdirSync(root);
            expect(entries.length).toBeGreaterThan(0);
            const fullPath = join(root, entries[0]!);
            expect(existsSync(fullPath)).toBe(true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
