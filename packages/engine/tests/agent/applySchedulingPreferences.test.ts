// ============================================================
// applySchedulingPreferences.test.ts — Phase 15 Task 5
// ============================================================
// Tests for applySchedulingPreferences() — Phase-15 first reader
// of the Phase-14-defined SchedulingPreferences type (Decision #43).
//
// Strict-vs-soft within SchedulingPreferences is INDEPENDENT from
// Decision #42's hard-vs-soft constraint framing.
// ============================================================

import { describe, it, expect } from "vitest";
import { applySchedulingPreferences } from "../../src/agent/sectionMaterialization/applySchedulingPreferences.js";
import type { MeetingPattern, SectionView } from "../../src/agent/sectionMaterialization/types.js";
import type { SchedulingPreferences } from "@nyupath/shared";

// ---- Section-fixture helper ----

function makeSection(
    courseId: string,
    crn: string,
    patterns: MeetingPattern[],
    overrides: Partial<SectionView> = {},
): SectionView {
    return {
        courseId,
        title: courseId,
        crn,
        credits: "4",
        instructor: "Staff",
        status: "A",
        meetingPatterns: patterns,
        isAsynchronous: patterns.length === 0,
        rawMeets: "",
        ...overrides,
    };
}

// ---- Reusable meeting patterns ----
// 9:00 AM = 540, 10:30 AM = 630, 12:00 PM = 720, 1:00 PM = 780, 5:00 PM = 1020
const M_9_1015: MeetingPattern = { day: "M", startMin: 540, endMin: 615 };  // M 9:00–10:15
const W_9_1015: MeetingPattern = { day: "W", startMin: 540, endMin: 615 };  // W 9:00–10:15
const F_10_1115: MeetingPattern = { day: "F", startMin: 600, endMin: 675 }; // F 10:00–11:15
const F_2_315: MeetingPattern = { day: "F", startMin: 840, endMin: 915 };   // F 2:00–3:15 PM
const TU_11_1215: MeetingPattern = { day: "Tu", startMin: 660, endMin: 735 };
const TH_11_1215: MeetingPattern = { day: "Th", startMin: 660, endMin: 735 };
const M_2_315: MeetingPattern = { day: "M", startMin: 840, endMin: 915 };   // M 2:00–3:15
const W_2_315: MeetingPattern = { day: "W", startMin: 840, endMin: 915 };   // W 2:00–3:15

// ---- (a) Strict avoidDays Friday filter ----

describe("applySchedulingPreferences — strict avoidDays", () => {
    it("strict-true Friday filter drops Friday-meeting sections and keeps the rest", () => {
        const fridaySection = makeSection("X", "X-fri", [F_10_1115]);
        const tuesdaySection = makeSection("X", "X-tue", [TU_11_1215]);
        const monWedSection = makeSection("X", "X-mw", [M_9_1015, W_9_1015]);

        const prefs: SchedulingPreferences = {
            avoidDays: [{ day: "F", strict: true }],
        };

        const result = applySchedulingPreferences(
            [fridaySection, tuesdaySection, monWedSection],
            prefs,
        );

        expect(result.surviving.map(s => s.crn).sort()).toEqual(["X-mw", "X-tue"].sort());
        expect(result.eliminatedByStrict).toHaveLength(1);
        expect(result.eliminatedByStrict[0]!.sectionId).toBe("X-fri");
        // Reason must be concrete: name the strict entry + the matching pattern
        expect(result.eliminatedByStrict[0]!.reason).toMatch(/strict/i);
        expect(result.eliminatedByStrict[0]!.reason).toMatch(/F/);
    });
});

// ---- (b) Soft preferTimeWindows reranks but doesn't drop ----

describe("applySchedulingPreferences — soft preferTimeWindows", () => {
    it("Mon/Wed-morning window boosts MW sections without dropping others", () => {
        const mwMorning = makeSection("X", "X-mw-am", [M_9_1015, W_9_1015]);
        const mwAfternoon = makeSection("X", "X-mw-pm", [M_2_315, W_2_315]);

        const prefs: SchedulingPreferences = {
            preferTimeWindows: [
                { days: ["M", "W"], startMin: 540, endMin: 720, weight: 1.0 },
            ],
        };

        const result = applySchedulingPreferences([mwMorning, mwAfternoon], prefs);

        // Both sections survive the soft pass
        expect(result.surviving.map(s => s.crn).sort()).toEqual(["X-mw-am", "X-mw-pm"].sort());
        expect(result.eliminatedByStrict).toHaveLength(0);

        // Boosted section has weight > 1; non-boosted defaults to 1 (omitted from Map)
        const amWeight = result.rerankWeights.get("X-mw-am") ?? 1;
        const pmWeight = result.rerankWeights.get("X-mw-pm") ?? 1;
        expect(amWeight).toBeGreaterThan(pmWeight);
        expect(amWeight).toBeGreaterThan(1);
    });
});

// ---- (c) All sections of a course dropped ----

describe("applySchedulingPreferences — all sections dropped (Decision #19 swap-cascade trigger)", () => {
    it("when all sections of a course meet on Friday and Friday is strictly avoided, helper reports zero surviving", () => {
        const fri1 = makeSection("Y", "Y-1", [F_10_1115]);
        const fri2 = makeSection("Y", "Y-2", [F_2_315]);

        const prefs: SchedulingPreferences = {
            avoidDays: [{ day: "F", strict: true }],
        };

        const result = applySchedulingPreferences([fri1, fri2], prefs);

        expect(result.surviving).toHaveLength(0);
        expect(result.eliminatedByStrict.map(e => e.sectionId).sort()).toEqual(["Y-1", "Y-2"].sort());
    });
});

// ---- (d) Soft avoidDays applies a downward weight ----

describe("applySchedulingPreferences — soft avoidDays", () => {
    it("applies a downward weight rather than dropping", () => {
        const fri = makeSection("X", "X-fri", [F_10_1115]);
        const tue = makeSection("X", "X-tue", [TU_11_1215]);

        const prefs: SchedulingPreferences = {
            avoidDays: [{ day: "F", strict: false }],
        };

        const result = applySchedulingPreferences([fri, tue], prefs);

        expect(result.surviving.map(s => s.crn).sort()).toEqual(["X-fri", "X-tue"].sort());
        expect(result.eliminatedByStrict).toHaveLength(0);

        const friWeight = result.rerankWeights.get("X-fri") ?? 1;
        const tueWeight = result.rerankWeights.get("X-tue") ?? 1;
        expect(friWeight).toBeLessThan(1);
        expect(friWeight).toBeGreaterThan(0);
        expect(tueWeight).toBe(1);
    });
});

// ---- (e) Soft avoidTimeWindows applies a downward weight ----

describe("applySchedulingPreferences — soft avoidTimeWindows", () => {
    it("applies a downward weight rather than dropping when window overlaps", () => {
        // Window: M 8:00–10:00 (480–600), soft.
        // M_9_1015 (540–615) overlaps the window via half-open semantics: 540 < 600 && 480 < 615.
        const mwMorning = makeSection("X", "X-mw-am", [M_9_1015, W_9_1015]);
        const mwAfternoon = makeSection("X", "X-mw-pm", [M_2_315, W_2_315]);

        const prefs: SchedulingPreferences = {
            avoidTimeWindows: [
                { days: ["M"], startMin: 480, endMin: 600, strict: false },
            ],
        };

        const result = applySchedulingPreferences([mwMorning, mwAfternoon], prefs);

        expect(result.surviving).toHaveLength(2);
        expect(result.eliminatedByStrict).toHaveLength(0);

        const amWeight = result.rerankWeights.get("X-mw-am") ?? 1;
        const pmWeight = result.rerankWeights.get("X-mw-pm") ?? 1;
        expect(amWeight).toBeLessThan(1);
        expect(pmWeight).toBe(1);
    });
});

// ---- (f) Strict avoidTimeWindows drops ----

describe("applySchedulingPreferences — strict avoidTimeWindows", () => {
    it("drops sections that overlap any pattern's day∩time", () => {
        const mwMorning = makeSection("X", "X-mw-am", [M_9_1015, W_9_1015]);
        const mwAfternoon = makeSection("X", "X-mw-pm", [M_2_315, W_2_315]);

        const prefs: SchedulingPreferences = {
            avoidTimeWindows: [
                { days: ["M", "W"], startMin: 480, endMin: 600, strict: true },
            ],
        };

        const result = applySchedulingPreferences([mwMorning, mwAfternoon], prefs);

        expect(result.surviving.map(s => s.crn)).toEqual(["X-mw-pm"]);
        expect(result.eliminatedByStrict).toHaveLength(1);
        expect(result.eliminatedByStrict[0]!.sectionId).toBe("X-mw-am");
        expect(result.eliminatedByStrict[0]!.reason).toMatch(/strict/i);
        expect(result.eliminatedByStrict[0]!.reason).toMatch(/avoidTimeWindow/i);
    });

    it("respects half-open boundary touch (no drop when window ends exactly at section start)", () => {
        // Window M 8:00–9:00 (480–540), strict.
        // M_9_1015 starts at 540 — half-open: 540 < 540 is false, so NOT a conflict.
        const mwMorning = makeSection("X", "X-mw-am", [M_9_1015]);

        const prefs: SchedulingPreferences = {
            avoidTimeWindows: [
                { days: ["M"], startMin: 480, endMin: 540, strict: true },
            ],
        };

        const result = applySchedulingPreferences([mwMorning], prefs);
        expect(result.surviving).toHaveLength(1);
        expect(result.eliminatedByStrict).toHaveLength(0);
    });
});

// ---- (g) desiredFreeDay strict ----

describe("applySchedulingPreferences — desiredFreeDay strict", () => {
    it("drops sections meeting on the chosen concrete day", () => {
        const friSec = makeSection("X", "X-fri", [F_10_1115]);
        const tueSec = makeSection("X", "X-tue", [TU_11_1215]);

        const prefs: SchedulingPreferences = {
            desiredFreeDay: { day: "F", strict: true },
        };

        const result = applySchedulingPreferences([friSec, tueSec], prefs);

        expect(result.surviving.map(s => s.crn)).toEqual(["X-tue"]);
        expect(result.eliminatedByStrict).toHaveLength(1);
        expect(result.eliminatedByStrict[0]!.sectionId).toBe("X-fri");
        expect(result.eliminatedByStrict[0]!.reason).toMatch(/desiredFreeDay/i);
    });

    it("'any' picks the day from M..F that yields the most surviving sections", () => {
        // Every weekday is touched by at least one section here, so the helper
        // is forced to drop something — but Friday is the cheapest day to free
        // (only 1 section meets on F, while M, Tu, W, Th each have ≥ 2 hits).
        const fri = makeSection("X", "X-fri", [F_10_1115]);                // F
        const mw1 = makeSection("X", "X-mw-am", [M_9_1015, W_9_1015]);     // M, W
        const mw2 = makeSection("X", "X-mw-pm", [M_2_315, W_2_315]);       // M, W
        const tuth = makeSection("X", "X-tuth", [TU_11_1215, TH_11_1215]); // Tu, Th
        const tuth2 = makeSection("X", "X-tuth2", [TU_11_1215, TH_11_1215]); // Tu, Th

        const prefs: SchedulingPreferences = {
            desiredFreeDay: { day: "any", strict: true },
        };

        const result = applySchedulingPreferences([fri, mw1, mw2, tuth, tuth2], prefs);

        // Day-by-day section count: M=2, Tu=2, W=2, Th=2, F=1 → F wins (fewest drops).
        expect(result.surviving.map(s => s.crn).sort())
            .toEqual(["X-mw-am", "X-mw-pm", "X-tuth", "X-tuth2"].sort());
        expect(result.eliminatedByStrict).toHaveLength(1);
        expect(result.eliminatedByStrict[0]!.sectionId).toBe("X-fri");
    });

    it("'any' chooses a day no section meets on when one exists (zero drops)", () => {
        // Sections only meet M-Th; Friday is empty → F is the optimal free day.
        const m = makeSection("X", "X-m", [M_9_1015]);
        const tu = makeSection("X", "X-tu", [TU_11_1215]);
        const w = makeSection("X", "X-w", [W_9_1015]);
        const th = makeSection("X", "X-th", [TH_11_1215]);

        const prefs: SchedulingPreferences = {
            desiredFreeDay: { day: "any", strict: true },
        };

        const result = applySchedulingPreferences([m, tu, w, th], prefs);
        expect(result.surviving).toHaveLength(4);
        expect(result.eliminatedByStrict).toHaveLength(0);
    });
});

// ---- (h) avoidConsecutiveLongBlocks ----

describe("applySchedulingPreferences — avoidConsecutiveLongBlocks", () => {
    it("soft-deboosts sections that produce ≥3-hour back-to-back blocks", () => {
        // Section A: M 9:00–10:30 (90 min) + M 10:30–12:30 (120 min) — back-to-back, total 210 min ≥ 180 → flag.
        const longBlock = makeSection("L", "L-long", [
            { day: "M", startMin: 540, endMin: 630 },
            { day: "M", startMin: 630, endMin: 750 },
        ]);
        // Section B: M 9:00–10:15 + Tu 9:00–10:15 — single short block per day, no flag.
        const shortBlocks = makeSection("S", "S-short", [
            { day: "M", startMin: 540, endMin: 615 },
            { day: "Tu", startMin: 540, endMin: 615 },
        ]);

        const prefs: SchedulingPreferences = {
            avoidConsecutiveLongBlocks: true,
        };

        const result = applySchedulingPreferences([longBlock, shortBlocks], prefs);

        expect(result.surviving).toHaveLength(2);
        expect(result.eliminatedByStrict).toHaveLength(0);

        const longWeight = result.rerankWeights.get("L-long") ?? 1;
        const shortWeight = result.rerankWeights.get("S-short") ?? 1;
        expect(longWeight).toBeLessThan(1);
        expect(shortWeight).toBe(1);
    });

    it("does NOT deboost a single 180-min meeting (one-shot 3-hour studio); DOES deboost two back-to-back 90-min meetings", () => {
        // Single 180-min meeting (e.g. a 3-hour studio class): chain length = 1, no flag.
        const oneShot = makeSection("ONE", "ONE-1", [
            { day: "M", startMin: 540, endMin: 720 }, // M 9:00–12:00 (180 min, single pattern)
        ]);
        // Two back-to-back 90-min meetings on the same day → chain length = 2, total 180 min ≥ 180 → flag.
        const paired = makeSection("PAIR", "PAIR-1", [
            { day: "M", startMin: 540, endMin: 630 },  // M 9:00–10:30
            { day: "M", startMin: 630, endMin: 720 },  // M 10:30–12:00 (boundary touch = back-to-back)
        ]);

        const prefs: SchedulingPreferences = { avoidConsecutiveLongBlocks: true };
        const result = applySchedulingPreferences([oneShot, paired], prefs);

        // Single long meeting: NOT flagged → no entry in rerankWeights (default 1.0 implicit).
        expect(result.rerankWeights.has("ONE-1")).toBe(false);
        // Two back-to-back patterns spanning ≥180 min: flagged → multiplier < 1.
        const pairedWeight = result.rerankWeights.get("PAIR-1") ?? 1;
        expect(pairedWeight).toBeLessThan(1);
    });
});

// ---- (i) Undefined / empty prefs identity ----

describe("applySchedulingPreferences — undefined / empty prefs", () => {
    it("undefined → identity (sections unchanged, no rerank weights, no eliminations)", () => {
        const sections = [makeSection("X", "X-1", [M_9_1015])];
        const result = applySchedulingPreferences(sections, undefined);
        expect(result.surviving).toBe(sections);
        expect(result.rerankWeights.size).toBe(0);
        expect(result.eliminatedByStrict).toHaveLength(0);
    });

    it("empty {} → identity", () => {
        const sections = [makeSection("X", "X-1", [M_9_1015])];
        const result = applySchedulingPreferences(sections, {});
        expect(result.surviving).toEqual(sections);
        expect(result.rerankWeights.size).toBe(0);
        expect(result.eliminatedByStrict).toHaveLength(0);
    });

    it("asynchronous sections (no meetingPatterns) pass through every day/time filter", () => {
        const asyncSec = makeSection("ASYNC", "A-1", [], { isAsynchronous: true });
        const prefs: SchedulingPreferences = {
            avoidDays: [{ day: "F", strict: true }],
            avoidTimeWindows: [{ days: ["M", "Tu", "W", "Th", "F"], startMin: 0, endMin: 1440, strict: true }],
            desiredFreeDay: { day: "F", strict: true },
        };
        const result = applySchedulingPreferences([asyncSec], prefs);
        expect(result.surviving.map(s => s.crn)).toEqual(["A-1"]);
        expect(result.eliminatedByStrict).toHaveLength(0);
    });
});

// ---- (j) rerankWeights aggregation ----

describe("applySchedulingPreferences — rerankWeights aggregate by product", () => {
    it("avoidTimeWindows soft + preferTimeWindows soft both apply → multipliers compose", () => {
        // Section meets M 9:00–10:15.
        const sec = makeSection("X", "X-1", [M_9_1015]);

        // avoidTimeWindows soft on M 8–10 (overlaps section) → downward.
        // preferTimeWindows on M 8–11 (overlaps section)     → upward.
        const prefsBoth: SchedulingPreferences = {
            avoidTimeWindows: [{ days: ["M"], startMin: 480, endMin: 600, strict: false }],
            preferTimeWindows: [{ days: ["M"], startMin: 480, endMin: 660, weight: 1.0 }],
        };
        const both = applySchedulingPreferences([sec], prefsBoth);
        const wBoth = both.rerankWeights.get("X-1") ?? 1;

        // Each individual contribution
        const prefsAvoidOnly: SchedulingPreferences = {
            avoidTimeWindows: [{ days: ["M"], startMin: 480, endMin: 600, strict: false }],
        };
        const wAvoid = applySchedulingPreferences([sec], prefsAvoidOnly).rerankWeights.get("X-1") ?? 1;

        const prefsPreferOnly: SchedulingPreferences = {
            preferTimeWindows: [{ days: ["M"], startMin: 480, endMin: 660, weight: 1.0 }],
        };
        const wPrefer = applySchedulingPreferences([sec], prefsPreferOnly).rerankWeights.get("X-1") ?? 1;

        // Product aggregation, deterministic and commutative
        expect(wBoth).toBeCloseTo(wAvoid * wPrefer, 6);
    });
});
