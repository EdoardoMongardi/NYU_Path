// ============================================================
// foseAvailabilityGate.test.ts — Phase 15 Task 3 tests
// ============================================================
// Tests for classifyAvailability() using fixture-driven cases.
//
// FoseSection carries `meets` + `meetingTimes` (schema correction
// from Task 0/1: real FOSE uses `meets` + `meetingTimes`, not `hours`).
//
// Fixture verification done at test-write time (2026-05-03):
//   csci-ua-101_2026-fall:  22 results, all have parseable meetingTimes → "full"
//   csci-ua-101_2028-fall:   0 results                                  → "unavailable"
//   empty array                                                          → "unavailable"
//   synthetic partial (1/4 parseable = 25% < 50%)                       → "partial"
// ============================================================

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAvailability } from "../../src/agent/sectionMaterialization/foseAvailabilityGate.js";
import type { FoseSection } from "../../src/agent/sectionMaterialization/foseAvailabilityGate.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/fose");

/** Load fixture results as FoseSection[] */
function loadFixture(name: string): FoseSection[] {
    const filePath = path.join(FIXTURE_DIR, `${name}.json`);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
        results: Array<{ meets?: string; meetingTimes?: string }>;
    };
    return raw.results.map(r => ({
        meets: r.meets,
        meetingTimes: r.meetingTimes,
    }));
}

describe("classifyAvailability", () => {
    // ---- Case 1: current term with full data → "full" ----
    it('classifies 2026-fall (csci-ua-101, 22 sections, all with meetingTimes) as "full"', () => {
        const sections = loadFixture("csci-ua-101_2026-fall");
        expect(sections.length).toBe(22);
        const result = classifyAvailability(sections);
        expect(result).toBe("full");
    });

    // ---- Case 2: far-future term with zero results → "unavailable" ----
    it('classifies 2028-fall (csci-ua-101, 0 results) as "unavailable"', () => {
        const sections = loadFixture("csci-ua-101_2028-fall");
        expect(sections.length).toBe(0);
        const result = classifyAvailability(sections);
        expect(result).toBe("unavailable");
    });

    // ---- Case 3: empty array → "unavailable" ----
    it("classifies empty array as \"unavailable\"", () => {
        const result = classifyAvailability([]);
        expect(result).toBe("unavailable");
    });

    // ---- Case 4: synthetic partial — 1 parseable / 4 total (25%) → "partial" ----
    // Sections with no meetingTimes and non-async meets → unparseable
    it("classifies partial fixture (1/4 parseable = 25%) as \"partial\"", () => {
        const sections: FoseSection[] = [
            // Parseable: has meetingTimes
            {
                meets: "MW 9:30-10:45a",
                meetingTimes: '[{"meet_day":"0","start_time":"930","end_time":"1045"},{"meet_day":"2","start_time":"930","end_time":"1045"}]',
            },
            // Unparseable: no meetingTimes, non-async meets
            { meets: "MW 9:30-10:45a", meetingTimes: undefined },
            { meets: "TR 11a-12:15p", meetingTimes: undefined },
            { meets: "F 2-4:30p", meetingTimes: undefined },
        ];
        const result = classifyAvailability(sections);
        expect(result).toBe("partial");
    });

    // ---- Case 5: async sections count as parseable ----
    // "asynchronous" kind is a definitive answer → counts toward parseable
    it("counts asynchronous sections as parseable (Does Not Meet with [] meetingTimes)", () => {
        const sections: FoseSection[] = [
            // Two async sections (empty meetingTimes + "Does Not Meet" meets)
            { meets: "Does Not Meet", meetingTimes: "[]" },
            { meets: "Does Not Meet", meetingTimes: "[]" },
            // One section with real times
            {
                meets: "TR 9:30-10:45a",
                meetingTimes: '[{"meet_day":"1","start_time":"930","end_time":"1045"},{"meet_day":"3","start_time":"930","end_time":"1045"}]',
            },
        ];
        // 3/3 parseable (2 async + 1 ok) → "full"
        const result = classifyAvailability(sections);
        expect(result).toBe("full");
    });

    // ---- Case 6: 50% boundary is inclusive → "full" ----
    it("classifies 2/4 parseable (50%) as \"full\" (boundary is ≥ 0.5)", () => {
        const sections: FoseSection[] = [
            // Parseable: has meetingTimes
            {
                meets: "MW 9:30-10:45a",
                meetingTimes: '[{"meet_day":"0","start_time":"930","end_time":"1045"}]',
            },
            { meets: "Does Not Meet", meetingTimes: "[]" },
            // Unparseable
            { meets: "MW 9:30-10:45a", meetingTimes: undefined },
            { meets: "TR 11a-12:15p", meetingTimes: undefined },
        ];
        const result = classifyAvailability(sections);
        expect(result).toBe("full");
    });

    // ---- Case 7: load a large 2026-fall fixture with async sections ----
    // econ-ua-1_2026-fall has 14 ok + 2 async (Does Not Meet) = 16/16 parseable
    it('classifies econ-ua-1_2026-fall (14 ok + 2 async, all parseable) as "full"', () => {
        const sections = loadFixture("econ-ua-1_2026-fall");
        expect(sections.length).toBe(16);
        const result = classifyAvailability(sections);
        expect(result).toBe("full");
    });
});
