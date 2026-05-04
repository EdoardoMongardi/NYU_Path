// ============================================================
// parseMeetingTimes.test.ts — Phase 15 Task 1 tests
// ============================================================
// Tests for parseMeetingTimes() and hhmmToMinutes() using:
//   1. Explicit unit cases covering all fixture-observed shapes.
//   2. Fixture-driven coverage: every section in all 27 recorded
//      FOSE fixtures must produce "ok" or "asynchronous" — never
//      "unparseable".
// ============================================================

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMeetingTimes, hhmmToMinutes } from "../../src/agent/sectionMaterialization/parseMeetingTimes.js";
import type { MeetingPattern } from "../../src/agent/sectionMaterialization/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/fose");

// ---- hhmmToMinutes unit tests ----

describe("hhmmToMinutes", () => {
    it("converts 3-char time '800' → 480 (8:00 AM)", () => {
        expect(hhmmToMinutes("800")).toBe(480);
    });

    it("converts 3-char time '930' → 570 (9:30 AM)", () => {
        expect(hhmmToMinutes("930")).toBe(570);
    });

    it("converts 3-char time '915' → 555 (9:15 AM)", () => {
        expect(hhmmToMinutes("915")).toBe(555);
    });

    it("converts 4-char time '1045' → 645 (10:45 AM)", () => {
        expect(hhmmToMinutes("1045")).toBe(645);
    });

    it("converts 4-char time '1400' → 840 (2:00 PM)", () => {
        expect(hhmmToMinutes("1400")).toBe(840);
    });

    it("converts 4-char time '1230' → 750 (12:30 PM)", () => {
        expect(hhmmToMinutes("1230")).toBe(750);
    });

    it("converts 4-char time '2050' → 1250 (8:50 PM)", () => {
        expect(hhmmToMinutes("2050")).toBe(1250);
    });

    it("returns null for empty string", () => {
        expect(hhmmToMinutes("")).toBeNull();
    });

    it("returns null for non-numeric string", () => {
        expect(hhmmToMinutes("abc")).toBeNull();
    });
});

// ---- parseMeetingTimes unit tests ----

describe("parseMeetingTimes — structured meetingTimes primary path", () => {
    it("parses a TR (Tue/Thu) section from meetingTimes JSON", () => {
        // Fixture: csci-ua-101_2026-fall section 002 — "TR 8-9:15a"
        const meetingTimesJson = JSON.stringify([
            { meet_day: "1", start_time: "800", end_time: "915" },
            { meet_day: "3", start_time: "800", end_time: "915" },
        ]);
        const result = parseMeetingTimes("TR 8-9:15a", meetingTimesJson);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
            expect(result.patterns).toHaveLength(2);
            expect(result.patterns[0]).toEqual<MeetingPattern>({ day: "Tu", startMin: 480, endMin: 555 });
            expect(result.patterns[1]).toEqual<MeetingPattern>({ day: "Th", startMin: 480, endMin: 555 });
        }
    });

    it("parses an MW section from meetingTimes JSON", () => {
        // Fixture: csci-ua-101_2026-fall section 003 — "MW 11a-12:15p"
        const meetingTimesJson = JSON.stringify([
            { meet_day: "0", start_time: "1100", end_time: "1215" },
            { meet_day: "2", start_time: "1100", end_time: "1215" },
        ]);
        const result = parseMeetingTimes("MW 11a-12:15p", meetingTimesJson);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
            expect(result.patterns).toHaveLength(2);
            expect(result.patterns[0]).toEqual<MeetingPattern>({ day: "M", startMin: 660, endMin: 735 });
            expect(result.patterns[1]).toEqual<MeetingPattern>({ day: "W", startMin: 660, endMin: 735 });
        }
    });

    it("parses multi-session (3-entry) meetingTimes — MW + F section", () => {
        // Fixture: biol-ua-11_2026-fall — "MW 9:30-10:45a; F 2-4p"
        const meetingTimesJson = JSON.stringify([
            { meet_day: "0", start_time: "930", end_time: "1045" },
            { meet_day: "2", start_time: "930", end_time: "1045" },
            { meet_day: "4", start_time: "1400", end_time: "1600" },
        ]);
        const result = parseMeetingTimes("MW 9:30-10:45a; F 2-4p", meetingTimesJson);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
            expect(result.patterns).toHaveLength(3);
            expect(result.patterns[0]).toEqual<MeetingPattern>({ day: "M", startMin: 570, endMin: 645 });
            expect(result.patterns[1]).toEqual<MeetingPattern>({ day: "W", startMin: 570, endMin: 645 });
            expect(result.patterns[2]).toEqual<MeetingPattern>({ day: "F", startMin: 840, endMin: 960 });
        }
    });

    it("parses MWF (3-day) section — day indices 0, 2, 4", () => {
        // Fixture: fren-ua-1_2026-fall — "MWF 9:30-10:45a"
        const meetingTimesJson = JSON.stringify([
            { meet_day: "0", start_time: "930", end_time: "1045" },
            { meet_day: "2", start_time: "930", end_time: "1045" },
            { meet_day: "4", start_time: "930", end_time: "1045" },
        ]);
        const result = parseMeetingTimes("MWF 9:30-10:45a", meetingTimesJson);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
            expect(result.patterns).toHaveLength(3);
            const days = result.patterns.map(p => p.day);
            expect(days).toEqual(["M", "W", "F"]);
        }
    });

    it("parses MTWR (4-day summer intensive) — day indices 0, 1, 2, 3", () => {
        // Fixture: csci-ua-101_2026-summer — "MTWR 11:10a-1:15p"
        const meetingTimesJson = JSON.stringify([
            { meet_day: "0", start_time: "1110", end_time: "1315" },
            { meet_day: "1", start_time: "1110", end_time: "1315" },
            { meet_day: "2", start_time: "1110", end_time: "1315" },
            { meet_day: "3", start_time: "1110", end_time: "1315" },
        ]);
        const result = parseMeetingTimes("MTWR 11:10a-1:15p", meetingTimesJson);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
            expect(result.patterns).toHaveLength(4);
            const days = result.patterns.map(p => p.day);
            expect(days).toEqual(["M", "Tu", "W", "Th"]);
        }
    });

    it("parses single-day (F only) section", () => {
        // Fixture: csci-ua-101_2026-fall — "F 2-4:30p"
        const meetingTimesJson = JSON.stringify([
            { meet_day: "4", start_time: "1400", end_time: "1630" },
        ]);
        const result = parseMeetingTimes("F 2-4:30p", meetingTimesJson);
        expect(result.kind).toBe("ok");
        if (result.kind === "ok") {
            expect(result.patterns).toHaveLength(1);
            expect(result.patterns[0]).toEqual<MeetingPattern>({ day: "F", startMin: 840, endMin: 990 });
        }
    });
});

describe("parseMeetingTimes — async fallback path (no meetingTimes)", () => {
    it("classifies 'Does Not Meet' as asynchronous (meets string only)", () => {
        const result = parseMeetingTimes("Does Not Meet", "[]");
        expect(result).toEqual({ kind: "asynchronous" });
    });

    it("classifies 'Does Not Meet' as asynchronous when meetingTimes is empty string", () => {
        const result = parseMeetingTimes("Does Not Meet", "");
        expect(result).toEqual({ kind: "asynchronous" });
    });

    it("classifies 'Does Not Meet' as asynchronous when meetingTimes is undefined", () => {
        const result = parseMeetingTimes("Does Not Meet", undefined);
        expect(result).toEqual({ kind: "asynchronous" });
    });

    it("classifies empty meets string as asynchronous", () => {
        const result = parseMeetingTimes("", undefined);
        expect(result).toEqual({ kind: "asynchronous" });
    });

    it("classifies 'TBA' as asynchronous", () => {
        const result = parseMeetingTimes("TBA", undefined);
        expect(result).toEqual({ kind: "asynchronous" });
    });

    it("classifies 'asynchronous' keyword in meets as asynchronous", () => {
        const result = parseMeetingTimes("Online (Asynchronous)", undefined);
        expect(result).toEqual({ kind: "asynchronous" });
    });
});

describe("parseMeetingTimes — unparseable fallback", () => {
    it("returns unparseable when meetingTimes is absent and meets is not async", () => {
        // A non-async, non-standard meets string with no meetingTimes
        const result = parseMeetingTimes("Some Unknown Format XYZ", undefined);
        expect(result.kind).toBe("unparseable");
        if (result.kind === "unparseable") {
            expect(result.raw).toBe("Some Unknown Format XYZ");
        }
    });

    it("prefers structured meetingTimes over meets when meetingTimes is valid", () => {
        // Even if meets is weird, if meetingTimes parses we return ok
        const meetingTimesJson = JSON.stringify([
            { meet_day: "0", start_time: "900", end_time: "1000" },
        ]);
        const result = parseMeetingTimes("¯\\_(ツ)_/¯", meetingTimesJson);
        expect(result.kind).toBe("ok");
    });
});

// ---- Real-fixture coverage test ----

describe("parseMeetingTimes — real fixture coverage", () => {
    it("produces zero 'unparseable' results across all 27 FOSE fixtures", () => {
        const files = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".json"));
        expect(files.length).toBeGreaterThanOrEqual(27);

        const unparseable: Array<{ file: string; crn: string; meets: string; meetingTimes: unknown }> = [];

        for (const file of files) {
            const data = JSON.parse(
                fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8"),
            ) as { results?: Array<{ crn?: string; meets?: string; meetingTimes?: string }> };

            for (const section of data.results ?? []) {
                const result = parseMeetingTimes(
                    section.meets ?? "",
                    section.meetingTimes,
                );
                if (result.kind === "unparseable") {
                    unparseable.push({
                        file,
                        crn: section.crn ?? "?",
                        meets: section.meets ?? "",
                        meetingTimes: section.meetingTimes,
                    });
                }
            }
        }

        if (unparseable.length > 0) {
            console.error("Unparseable sections found:");
            for (const u of unparseable) {
                console.error(`  ${u.file} crn=${u.crn}  meets=${JSON.stringify(u.meets)}  meetingTimes=${JSON.stringify(u.meetingTimes)}`);
            }
        }

        expect(unparseable).toHaveLength(0);
    });

    it("correctly classifies 'Does Not Meet' sections as asynchronous in econ fixture", () => {
        const data = JSON.parse(
            fs.readFileSync(path.join(FIXTURE_DIR, "econ-ua-1_2026-fall.json"), "utf8"),
        ) as { results: Array<{ meets?: string; meetingTimes?: string }> };

        const doesNotMeet = data.results.filter(r => r.meets === "Does Not Meet");
        expect(doesNotMeet.length).toBeGreaterThan(0);

        for (const section of doesNotMeet) {
            const result = parseMeetingTimes(section.meets ?? "", section.meetingTimes);
            expect(result.kind).toBe("asynchronous");
        }
    });

    it("correctly classifies all timed sections as 'ok' in csci-ua-101 fall fixture", () => {
        const data = JSON.parse(
            fs.readFileSync(path.join(FIXTURE_DIR, "csci-ua-101_2026-fall.json"), "utf8"),
        ) as { results: Array<{ meets?: string; meetingTimes?: string }> };

        // All csci-ua-101 sections have timed meetingTimes
        for (const section of data.results) {
            const result = parseMeetingTimes(section.meets ?? "", section.meetingTimes);
            expect(result.kind).toBe("ok");
            if (result.kind === "ok") {
                expect(result.patterns.length).toBeGreaterThan(0);
            }
        }
    });
});
