// ============================================================
// prereqSatisfaction.test.ts — Decision #4 truth table (Phase 13 Task 3.0)
// ============================================================
// 13 truth-table cases covering all satisfaction paths and hard-reject
// branches of isPrereqSatisfied (optimistic-forward-projection rule).
//
// Fixture convention:
//   - courseId format: "CSCI-UA 101" (subject + space + catalogNbr)
//   - DPR courseHistory term: PeopleSoft format "2025 Fall", "2026 Spr"
//   - solver term: "2026-fall", "2027-spring"
// ============================================================

import { describe, it, expect } from "vitest";
import { isPrereqSatisfied } from "../../src/dpr/prereqSatisfaction.js";
import type { DegreeProgressReport, DPRCourseRow, DPRRequirementGroup } from "../../src/dpr/schema.js";

// ---- Fixture helpers ----

/** Minimal DPR with empty courseHistory and requirementGroups by default. */
function makeDpr(overrides: {
    courseHistory?: DPRCourseRow[];
    requirementGroups?: DPRRequirementGroup[];
} = {}): DegreeProgressReport {
    return {
        _meta: {
            parserVersion: "1.0.0",
            parsedAt: "2026-01-01T00:00:00Z",
            sourceFingerprint: "sha256:abc123",
            sourcePdfPageCount: 5,
            parseDurationMs: 100,
            warnings: [],
        },
        header: {
            studentName: "Test Student",
            preparedDate: "01/01/2026",
        },
        programs: [],
        advisorNotations: [],
        cumulative: {
            creditsRequired: 128,
            creditsUsed: 64,
            cumulativeGpa: 3.5,
            cumulativeGpaRequired: 2.0,
            residencyRequired: 64,
            residencyUsed: 32,
            passFailUsedUnits: 0,
            passFailCapUnits: 32,
            outsideHomeUsedUnits: 0,
            outsideHomeCapUnits: 16,
            timeLimitYears: 8,
        },
        requirementGroups: overrides.requirementGroups ?? [],
        courseHistory: overrides.courseHistory ?? [],
    };
}

/** Build a DPRCourseRow with the given courseId ("CSCI-UA 101" → subject="CSCI-UA", catalogNbr="101"). */
function makeCourseRow(
    courseId: string,
    type: string,
    grade: string | null = null,
    term = "2025 Fall",
): DPRCourseRow {
    const spaceIdx = courseId.lastIndexOf(" ");
    const subject = courseId.substring(0, spaceIdx);
    const catalogNbr = courseId.substring(spaceIdx + 1);
    return {
        term,
        subject,
        catalogNbr,
        courseTitle: `${courseId} Title`,
        grade,
        units: 4,
        type,
    };
}

/**
 * Build a minimal requirementGroups tree that places the given courseId
 * in a leaf requirement's coursesUsed[]. This simulates the DPR recording
 * the course as satisfying a requirement (the "dpr-satisfiedBy" path).
 */
function makeRGWithCourseUsed(courseId: string): DPRRequirementGroup[] {
    const spaceIdx = courseId.lastIndexOf(" ");
    const subject = courseId.substring(0, spaceIdx);
    const catalogNbr = courseId.substring(spaceIdx + 1);
    return [
        {
            rgId: "RG5000",
            title: "Test Requirement Group",
            status: "satisfied",
            statusText: "Satisfied: Completed",
            children: [
                {
                    rId: "R5000/10",
                    title: "Test Requirement",
                    status: "satisfied",
                    statusText: "Satisfied: Completed",
                    coursesUsed: [
                        {
                            term: "2024 Fall",
                            subject,
                            catalogNbr,
                            courseTitle: `${courseId} Title`,
                            grade: "A",
                            units: 4,
                            type: "EN",
                        },
                    ],
                },
            ],
        },
    ];
}

// ---- Tests ----

describe("isPrereqSatisfied — Decision #4 truth table", () => {

    // Row 1: DPR satisfiedBy (coursesUsed in any requirement leaf)
    it("Row 1: DPR satisfiedBy entry → satisfied (path 'dpr-satisfiedBy')", () => {
        const dpr = makeDpr({
            requirementGroups: makeRGWithCourseUsed("CSCI-UA 101"),
            courseHistory: [makeCourseRow("CSCI-UA 101", "EN", "B", "2024 Fall")],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 101",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: true, reason: "dpr-satisfiedBy" });
    });

    // Row 2: IP attempt in courseHistory → satisfied (assumed-passing)
    it("Row 2: IP attempt → satisfied (path 'ip-attempt')", () => {
        const dpr = makeDpr({
            courseHistory: [makeCourseRow("CSCI-UA 201", "IP", null, "2026 Spr")],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 201",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: true, reason: "ip-attempt" });
    });

    // Row 3a: future placement strictly before T (prereq mode) → satisfied
    it("Row 3a: future placement strictly before T (prereq mode) → satisfied ('future-placement')", () => {
        const dpr = makeDpr();
        const placements = new Map([["MATH-UA 121", "2026-spring"]]);

        const result = isPrereqSatisfied({
            prereqCourseId: "MATH-UA 121",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: placements,
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: true, reason: "future-placement" });
    });

    // Row 3b: future placement AT T (prereq mode) → does NOT satisfy (strictly-before required)
    it("Row 3b: future placement AT T (prereq mode) → does NOT satisfy (continues to Step 4)", () => {
        const dpr = makeDpr();
        const placements = new Map([["MATH-UA 121", "2026-fall"]]);

        const result = isPrereqSatisfied({
            prereqCourseId: "MATH-UA 121",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: placements,
            mode: "prereq",
        });

        // No satisfiedBy, no IP, placement NOT before T → hard-reject → no attempt → fail-no-attempt
        expect(result).toEqual({ satisfied: false, reason: "fail-no-attempt" });
    });

    // Row 3c: future placement AT T (coreq mode) → satisfied (≤T)
    it("Row 3c: future placement AT T (coreq mode) → satisfied ('future-placement')", () => {
        const dpr = makeDpr();
        const placements = new Map([["MATH-UA 121", "2026-fall"]]);

        const result = isPrereqSatisfied({
            prereqCourseId: "MATH-UA 121",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: placements,
            mode: "coreq",
        });

        expect(result).toEqual({ satisfied: true, reason: "future-placement" });
    });

    // Row 3d: future placement AFTER T (any mode) → does NOT satisfy
    it("Row 3d: future placement AFTER T (prereq mode) → does NOT satisfy", () => {
        const dpr = makeDpr();
        const placements = new Map([["MATH-UA 121", "2027-spring"]]);

        const result = isPrereqSatisfied({
            prereqCourseId: "MATH-UA 121",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: placements,
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: false, reason: "fail-no-attempt" });
    });

    it("Row 3d (coreq): future placement AFTER T → does NOT satisfy", () => {
        const dpr = makeDpr();
        const placements = new Map([["MATH-UA 121", "2027-spring"]]);

        const result = isPrereqSatisfied({
            prereqCourseId: "MATH-UA 121",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: placements,
            mode: "coreq",
        });

        expect(result).toEqual({ satisfied: false, reason: "fail-no-attempt" });
    });

    // Row 4: no IP, no future-plan, no satisfiedBy, never taken → fail-no-attempt
    it("Row 4: course never taken, no IP, no future placement, no satisfiedBy → fail-no-attempt", () => {
        const dpr = makeDpr();

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 480",
            dependentTerm: "2027-spring",
            dpr,
            plannedPlacements: new Map(),
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: false, reason: "fail-no-attempt" });
    });

    // Row 5a: EN attempt, minGrades present, grade BELOW threshold, no retake → fail-grade-threshold
    it("Row 5a: EN attempt below threshold, minGrades set, no retake → fail-grade-threshold", () => {
        const dpr = makeDpr({
            courseHistory: [makeCourseRow("CSCI-UA 101", "EN", "C-", "2025 Fall")],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 101",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            minGrades: { "CSCI-UA 101": "C" },
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: false, reason: "fail-grade-threshold" });
    });

    // Row 5b: EN attempt, minGrades present, grade AT threshold → satisfied (dpr-satisfiedBy-implicit)
    it("Row 5b: EN attempt AT threshold, minGrades set → satisfied ('dpr-satisfiedBy-implicit')", () => {
        const dpr = makeDpr({
            courseHistory: [makeCourseRow("CSCI-UA 101", "EN", "C", "2025 Fall")],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 101",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            minGrades: { "CSCI-UA 101": "C" },
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: true, reason: "dpr-satisfiedBy-implicit" });
    });

    // Row 5c: EN attempt below threshold BUT IP retake → Step 2 short-circuits → satisfied via ip-attempt
    it("Row 5c: EN below threshold + IP retake → satisfied via 'ip-attempt' (Step 2 fires first)", () => {
        const dpr = makeDpr({
            courseHistory: [
                makeCourseRow("CSCI-UA 101", "EN", "C-", "2025 Fall"),
                makeCourseRow("CSCI-UA 101", "IP", null, "2026 Spr"),
            ],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 101",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            minGrades: { "CSCI-UA 101": "C" },
            mode: "prereq",
        });

        // IP short-circuits at Step 2 before reaching threshold check at Step 4
        expect(result).toEqual({ satisfied: true, reason: "ip-attempt" });
    });

    // Row 5d: EN attempt below threshold BUT future-plan retake before T → satisfied via future-placement
    it("Row 5d: EN below threshold + future-plan retake before T → satisfied via 'future-placement'", () => {
        const dpr = makeDpr({
            courseHistory: [makeCourseRow("CSCI-UA 101", "EN", "C-", "2025 Fall")],
        });
        const placements = new Map([["CSCI-UA 101", "2026-spring"]]);

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 101",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: placements,
            minGrades: { "CSCI-UA 101": "C" },
            mode: "prereq",
        });

        // Step 3 fires (placement 2026-spring < 2026-fall)
        expect(result).toEqual({ satisfied: true, reason: "future-placement" });
    });

    // Row 6: EN attempt, NO minGrades, NOT in any requirementGroups.satisfiedBy → fail-no-implicit-acceptance
    it("Row 6: EN attempt, no minGrades, not in any coursesUsed → fail-no-implicit-acceptance", () => {
        const dpr = makeDpr({
            courseHistory: [makeCourseRow("CSCI-UA 101", "EN", "D", "2025 Fall")],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 101",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            // minGrades NOT set for CSCI-UA 101
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: false, reason: "fail-no-implicit-acceptance" });
    });

    // Row 7: multiple EN/TE attempts (retakes); most-recent governs threshold check
    it("Row 7: multiple attempts — most-recent (by term) governs the threshold check", () => {
        // Earlier attempt: D (fails C threshold)
        // Later attempt: B (meets C threshold)
        // → most-recent is B → should satisfy
        const dpr = makeDpr({
            courseHistory: [
                makeCourseRow("CSCI-UA 101", "EN", "D", "2024 Fall"),
                makeCourseRow("CSCI-UA 101", "EN", "B", "2025 Fall"),
            ],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 101",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            minGrades: { "CSCI-UA 101": "C" },
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: true, reason: "dpr-satisfiedBy-implicit" });
    });

    it("Row 7b: most-recent attempt fails threshold even though earlier attempt passed", () => {
        // Earlier attempt: A (passes C threshold)
        // Later retake with lower grade: D (fails C threshold)
        // → most-recent governs → fail
        const dpr = makeDpr({
            courseHistory: [
                makeCourseRow("CSCI-UA 101", "EN", "A", "2024 Fall"),
                makeCourseRow("CSCI-UA 101", "EN", "D", "2025 Fall"),
            ],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "CSCI-UA 101",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            minGrades: { "CSCI-UA 101": "C" },
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: false, reason: "fail-grade-threshold" });
    });

    // TE (transfer credit) treated as final past attempt — same as EN
    it("TE (transfer credit) row treated as a final past attempt — no minGrades + not in coursesUsed → fail-no-implicit-acceptance", () => {
        const dpr = makeDpr({
            courseHistory: [makeCourseRow("MATH-UA 9", "TE", "P", "2024 Fall")],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "MATH-UA 9",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: false, reason: "fail-no-implicit-acceptance" });
    });

    it("TE row appears in coursesUsed → satisfied via dpr-satisfiedBy (Step 1)", () => {
        const dpr = makeDpr({
            requirementGroups: makeRGWithCourseUsed("MATH-UA 9"),
            courseHistory: [makeCourseRow("MATH-UA 9", "TE", "P", "2024 Fall")],
        });

        const result = isPrereqSatisfied({
            prereqCourseId: "MATH-UA 9",
            dependentTerm: "2026-fall",
            dpr,
            plannedPlacements: new Map(),
            mode: "prereq",
        });

        expect(result).toEqual({ satisfied: true, reason: "dpr-satisfiedBy" });
    });
});
