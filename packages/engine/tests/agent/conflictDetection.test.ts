// ============================================================
// conflictDetection.test.ts — Phase 15 Task 2 tests
// ============================================================
// Tests for conflicts() and enumerateConflictFreeCombinations().
// ============================================================

import { describe, it, expect } from "vitest";
import {
    conflicts,
    enumerateConflictFreeCombinations,
    MAX_COMBINATIONS,
} from "../../src/agent/sectionMaterialization/conflictDetection.js";
import type { MeetingPattern, SectionView } from "../../src/agent/sectionMaterialization/types.js";

// ---- Shared fixtures ----

// M 9:00–10:00
const MON_9_10: MeetingPattern = { day: "M", startMin: 540, endMin: 600 };
// M 9:30–10:15  (overlaps MON_9_10)
const MON_930_1015: MeetingPattern = { day: "M", startMin: 570, endMin: 615 };
// M 10:00–11:00  (touches MON_9_10 at boundary, NOT an overlap)
const MON_10_11: MeetingPattern = { day: "M", startMin: 600, endMin: 660 };
// Tu 9:00–10:00  (different day from MON_9_10)
const TUE_9_10: MeetingPattern = { day: "Tu", startMin: 540, endMin: 600 };
// Tu 9:15–10:15  (overlaps TUE_9_10)
const TUE_915_1015: MeetingPattern = { day: "Tu", startMin: 555, endMin: 615 };
// Sa  (used for non-conflicting Saturday sections)
const SAT_BASE: MeetingPattern = { day: "Sa", startMin: 600, endMin: 660 };

// ---- conflicts() unit tests ----

describe("conflicts", () => {
    it("returns true when patterns overlap on the same day", () => {
        expect(conflicts([MON_9_10], [MON_930_1015])).toBe(true);
    });

    it("returns true when B starts before A ends (partial overlap)", () => {
        // MON_930_1015: M 9:30–10:15 (570–615)
        // MON_10_11:    M 10:00–11:00 (600–660)
        // aStart(570) < bEnd(660) → true; bStart(600) < aEnd(615) → true → OVERLAP
        expect(conflicts([MON_930_1015], [MON_10_11])).toBe(true);
    });

    it("returns false when patterns abut without overlap (boundary touch)", () => {
        // MON_9_10 ends at 600; MON_10_11 starts at 600 — half-open, NOT a conflict
        expect(conflicts([MON_9_10], [MON_10_11])).toBe(false);
    });

    it("returns false when patterns are on different days", () => {
        // MON_9_10 vs TUE_9_10 — same time, different day
        expect(conflicts([MON_9_10], [TUE_9_10])).toBe(false);
    });

    it("returns false for empty pattern arrays (asynchronous sections)", () => {
        expect(conflicts([], [MON_9_10])).toBe(false);
        expect(conflicts([MON_9_10], [])).toBe(false);
        expect(conflicts([], [])).toBe(false);
    });

    it("checks every pair in multi-pattern arrays (e.g. MW+T course)", () => {
        // A has MON_9_10 and TUE_9_10; B has TUE_915_1015 (overlaps TUE_9_10)
        expect(conflicts([MON_9_10, TUE_9_10], [TUE_915_1015])).toBe(true);
    });

    it("returns false when no pairs overlap in multi-pattern arrays", () => {
        // A has MON_9_10 (M); B has TUE_9_10 (Tu) — different days entirely
        expect(conflicts([MON_9_10], [TUE_9_10])).toBe(false);
    });
});

// ---- enumerateConflictFreeCombinations unit tests ----

function makeSection(courseId: string, patterns: MeetingPattern[], suffix = "a"): SectionView {
    return {
        courseId,
        title: courseId,
        crn: `${courseId}-${suffix}`,
        credits: "4",
        instructor: "Staff",
        status: "A",
        meetingPatterns: patterns,
        isAsynchronous: patterns.length === 0,
        rawMeets: "",
    };
}

describe("enumerateConflictFreeCombinations", () => {
    it("returns the full cross-product when no sections conflict", () => {
        // X has 2 sections (M and Tu); Y has 1 section (W) — none conflict
        const result = enumerateConflictFreeCombinations([
            {
                courseId: "X",
                title: "X",
                sections: [
                    makeSection("X", [MON_9_10], "m"),
                    makeSection("X", [MON_10_11], "m2"),
                ],
            },
            {
                courseId: "Y",
                title: "Y",
                sections: [makeSection("Y", [TUE_9_10], "t")],
            },
        ]);
        // 2 × 1 = 2 combinations
        expect(result.combinations).toHaveLength(2);
        expect(result.truncated).toBe(false);
    });

    it("filters out combinations where any two sections conflict", () => {
        const result = enumerateConflictFreeCombinations([
            {
                courseId: "X",
                title: "X",
                sections: [makeSection("X", [MON_9_10])],
            },
            {
                courseId: "Y",
                title: "Y",
                sections: [makeSection("Y", [MON_930_1015])], // overlaps MON_9_10
            },
        ]);
        expect(result.combinations).toHaveLength(0);
        expect(result.truncated).toBe(false);
    });

    it("adjacent times (boundary touch) are NOT filtered as conflicts", () => {
        // X: M 9-10, Y: M 10-11 — should be kept (half-open: not a conflict)
        const result = enumerateConflictFreeCombinations([
            {
                courseId: "X",
                title: "X",
                sections: [makeSection("X", [MON_9_10])],
            },
            {
                courseId: "Y",
                title: "Y",
                sections: [makeSection("Y", [MON_10_11])],
            },
        ]);
        expect(result.combinations).toHaveLength(1);
        expect(result.truncated).toBe(false);
    });

    it("asynchronous sections (empty patterns) never conflict with anything", () => {
        const asyncSection = makeSection("ASYNC", [], "async");
        // Async + any timed section = no conflict
        const result = enumerateConflictFreeCombinations([
            {
                courseId: "ASYNC",
                title: "ASYNC",
                sections: [asyncSection],
            },
            {
                courseId: "X",
                title: "X",
                sections: [makeSection("X", [MON_9_10])],
            },
        ]);
        expect(result.combinations).toHaveLength(1);
        expect(result.truncated).toBe(false);
        expect(result.combinations[0]!.sections[0]!.isAsynchronous).toBe(true);
    });

    it("caps output at MAX_COMBINATIONS and sets truncated flag", () => {
        // 5 courses × 5 sections each = 3125 combinations pre-filter
        // All on different Sat slots so no conflicts
        const courses = Array.from({ length: 5 }, (_, i) => ({
            courseId: `C${i}`,
            title: `C${i}`,
            sections: Array.from({ length: 5 }, (_, j) =>
                makeSection(`C${i}`, [
                    { day: "Sa" as const, startMin: i * 100 + j * 10, endMin: i * 100 + j * 10 + 5 },
                ], `s${j}`),
            ),
        }));
        const result = enumerateConflictFreeCombinations(courses);
        expect(result.combinations.length).toBeLessThanOrEqual(MAX_COMBINATIONS);
        expect(result.truncated).toBe(true);
    });

    it("correctly handles multi-day patterns across courses (M/W/F example)", () => {
        // A: MWF 9-10  vs  B: W 9:30-10:30 — conflict on Wednesday
        const mwfPatterns: MeetingPattern[] = [
            { day: "M", startMin: 540, endMin: 600 },
            { day: "W", startMin: 540, endMin: 600 },
            { day: "F", startMin: 540, endMin: 600 },
        ];
        const wedConflict: MeetingPattern[] = [
            { day: "W", startMin: 570, endMin: 630 }, // overlaps W 9-10 in mwfPatterns
        ];
        const result = enumerateConflictFreeCombinations([
            {
                courseId: "A",
                title: "A",
                sections: [makeSection("A", mwfPatterns)],
            },
            {
                courseId: "B",
                title: "B",
                sections: [makeSection("B", wedConflict)],
            },
        ]);
        expect(result.combinations).toHaveLength(0);
    });

    it("returns weeklyHours as correct decimal total", () => {
        // X: M 9-10 (60 min = 1 hr) + Y: Tu 9-10:30 (90 min = 1.5 hr) = 2.5 hr
        const result = enumerateConflictFreeCombinations([
            {
                courseId: "X",
                title: "X",
                sections: [makeSection("X", [MON_9_10])], // 60 min
            },
            {
                courseId: "Y",
                title: "Y",
                sections: [makeSection("Y", [{ day: "Tu", startMin: 540, endMin: 630 }])], // 90 min
            },
        ]);
        expect(result.combinations).toHaveLength(1);
        expect(result.combinations[0]!.weeklyHours).toBeCloseTo(2.5, 2);
    });

    it("returns empty array for empty course list", () => {
        const result = enumerateConflictFreeCombinations([]);
        expect(result.combinations).toHaveLength(0);
        expect(result.truncated).toBe(false);
    });

    it("respects custom cap parameter", () => {
        // 4 non-conflicting courses × 3 sections = 81 combos; cap at 5
        const courses = Array.from({ length: 4 }, (_, i) => ({
            courseId: `C${i}`,
            title: `C${i}`,
            sections: Array.from({ length: 3 }, (_, j) =>
                makeSection(`C${i}`, [
                    { day: "Sa" as const, startMin: i * 50 + j * 10, endMin: i * 50 + j * 10 + 5 },
                ], `s${j}`),
            ),
        }));
        const result = enumerateConflictFreeCombinations(courses, 5);
        expect(result.combinations.length).toBeLessThanOrEqual(5);
        expect(result.truncated).toBe(true);
    });
});
