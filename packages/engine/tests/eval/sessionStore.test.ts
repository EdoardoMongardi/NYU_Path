// ============================================================
// Phase 7-A P-9 — sessionStore tests (§7.3 rolling window of 5)
// ============================================================

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    InMemorySessionStore,
    FileBackedSessionStore,
    defaultSessionStore,
    summariesAsPriorMessage,
    MAX_SESSION_SUMMARIES,
    type SessionSummary,
} from "../../src/persistence/sessionStore.js";
import { InMemoryFallbackSink } from "../../src/observability/fallbackLog.js";

function makeSummary(date: string, body: string): SessionSummary {
    return { date, summary: body };
}

describe("InMemorySessionStore (Phase 7-A P-9)", () => {
    it("returns an empty record for unknown students", async () => {
        const store = new InMemorySessionStore();
        const r = await store.get("unknown");
        expect(r.studentId).toBe("unknown");
        expect(r.sessionSummaries).toEqual([]);
    });

    it("appends summaries in chronological order", async () => {
        const store = new InMemorySessionStore();
        await store.appendSummary("u1", makeSummary("2026-04-25", "first"));
        const r = await store.appendSummary("u1", makeSummary("2026-04-26", "second"));
        expect(r.sessionSummaries.map((s) => s.date)).toEqual(["2026-04-25", "2026-04-26"]);
        expect(r.lastSessionDate).toBe("2026-04-26");
    });

    it("trims the rolling window to MAX_SESSION_SUMMARIES (5)", async () => {
        const store = new InMemorySessionStore();
        for (let i = 0; i < 10; i++) {
            await store.appendSummary("u1", makeSummary(`2026-04-${10 + i}`, `s${i}`));
        }
        const r = await store.get("u1");
        expect(r.sessionSummaries).toHaveLength(MAX_SESSION_SUMMARIES);
        // The 5 most recent are kept (s5..s9).
        expect(r.sessionSummaries.map((s) => s.summary)).toEqual(["s5", "s6", "s7", "s8", "s9"]);
    });

    it("isolates students by id", async () => {
        const store = new InMemorySessionStore();
        await store.appendSummary("u1", makeSummary("2026-04-26", "for u1"));
        await store.appendSummary("u2", makeSummary("2026-04-26", "for u2"));
        const u1 = await store.get("u1");
        const u2 = await store.get("u2");
        expect(u1.sessionSummaries[0]!.summary).toBe("for u1");
        expect(u2.sessionSummaries[0]!.summary).toBe("for u2");
    });
});

describe("FileBackedSessionStore (Phase 7-A P-9)", () => {
    function tmpStore(): FileBackedSessionStore {
        const dir = mkdtempSync(join(tmpdir(), "nyupath-sessions-"));
        return new FileBackedSessionStore(dir);
    }

    it("persists summaries across get/append cycles", async () => {
        const store = tmpStore();
        await store.appendSummary("u1", makeSummary("2026-04-25", "yesterday"));
        await store.appendSummary("u1", makeSummary("2026-04-26", "today"));
        const r = await store.get("u1");
        expect(r.sessionSummaries).toHaveLength(2);
        expect(r.sessionSummaries[1]!.summary).toBe("today");
    });

    it("returns an empty record when reading a non-existent student", async () => {
        const store = tmpStore();
        const r = await store.get("never-seen");
        expect(r.sessionSummaries).toEqual([]);
    });

    it("trims to 5 even when the on-disk file is larger (defensive)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "nyupath-sessions-"));
        // Write a file with 10 summaries on disk to simulate an older
        // version that wrote more than the rolling window.
        const path = join(dir, "u1.json");
        const big = {
            studentId: "u1",
            sessionSummaries: Array.from({ length: 10 }, (_, i) => makeSummary(`2026-04-${10 + i}`, `s${i}`)),
        };
        writeFileSync(path, JSON.stringify(big));
        const store = new FileBackedSessionStore(dir);
        const r = await store.get("u1");
        expect(r.sessionSummaries).toHaveLength(MAX_SESSION_SUMMARIES);
    });

    it("survives a corrupt JSON file (returns empty record)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "nyupath-sessions-"));
        writeFileSync(join(dir, "u1.json"), "{ this is not valid JSON");
        const store = new FileBackedSessionStore(dir);
        const r = await store.get("u1");
        expect(r.sessionSummaries).toEqual([]);
    });

    it("routes write failures through the FallbackSink (Phase 7-A reviewer P3 fix)", async () => {
        // Force a write failure by passing a path whose parent
        // component is an existing regular file, not a directory.
        const blockerDir = mkdtempSync(join(tmpdir(), "nyupath-sessions-blocker-"));
        const blockerFile = join(blockerDir, "not-a-dir");
        writeFileSync(blockerFile, "blocking file");
        const rootDir = join(blockerFile, "store"); // parent is a file

        const sink = new InMemoryFallbackSink();
        const store = new FileBackedSessionStore(rootDir, { fallbackSink: sink });
        await store.appendSummary("u1", makeSummary("2026-04-26", "test"));

        // The write failed — but the live flow returned successfully
        // (no throw), AND the failure was routed to the sink with the
        // canonical event kind.
        expect(sink.events.length).toBeGreaterThan(0);
        const ev = sink.events[0]!;
        expect(ev.kind).toBe("data_conflict_unresolved");
        expect(ev.detail).toMatch(/FileBackedSessionStore\.replace failed/);
        expect(ev.detail).toMatch(/u1/);
    });

    it("sanitizes student ids to prevent directory traversal", async () => {
        const dir = mkdtempSync(join(tmpdir(), "nyupath-sessions-"));
        const store = new FileBackedSessionStore(dir);
        await store.appendSummary("../../etc/passwd", makeSummary("2026-04-26", "exploit attempt"));
        // The file should land inside `dir`, not escape it. The
        // sanitization regex replaces `/`, `.` (when not safe), and
        // `\` with `_`; the resulting filename is `..__..__etc_passwd`.
        const r = await store.get("../../etc/passwd");
        expect(r.sessionSummaries).toHaveLength(1);
        // Verify a file landed inside dir (not at /etc/passwd). The
        // sanitizer replaces each `/` with `_` (single underscore per
        // separator) so "../../etc/passwd" → ".._.._etc_passwd".
        expect(() => readFileSync(join(dir, ".._.._etc_passwd.json"), "utf-8")).not.toThrow();
    });
});

describe("defaultSessionStore", () => {
    it("returns an in-memory store when no env path is set", () => {
        const s = defaultSessionStore({});
        expect(s).toBeInstanceOf(InMemorySessionStore);
    });

    it("returns a file-backed store when NYUPATH_SESSION_STORE_PATH is set", () => {
        const dir = mkdtempSync(join(tmpdir(), "nyupath-sessions-"));
        const s = defaultSessionStore({ NYUPATH_SESSION_STORE_PATH: dir });
        expect(s).toBeInstanceOf(FileBackedSessionStore);
    });
});

describe("summariesAsPriorMessage", () => {
    it("returns null for an empty record", () => {
        expect(summariesAsPriorMessage({ studentId: "u", sessionSummaries: [] })).toBeNull();
    });

    it("formats the last 3 summaries with date prefixes", () => {
        const out = summariesAsPriorMessage({
            studentId: "u",
            sessionSummaries: [
                makeSummary("2026-04-20", "audited progress"),
                makeSummary("2026-04-22", "discussed transfer to Stern"),
                makeSummary("2026-04-25", "planned spring 2027 schedule"),
                makeSummary("2026-04-26", "confirmed F-1 visa caveats"),
            ],
        }, 3);
        expect(out).toMatch(/Prior advising sessions/);
        expect(out).toMatch(/2026-04-22/);
        expect(out).toMatch(/2026-04-26/);
        // Oldest is dropped because count=3.
        expect(out).not.toMatch(/2026-04-20/);
    });
});
