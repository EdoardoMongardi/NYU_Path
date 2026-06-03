// ============================================================
// Phase 16 Task A — computeDprFingerprint
// ============================================================
// The Update-DPR route compares a fresh fingerprint against the
// stored one to decide whether the schedule needs to be re-planned.
// The hash MUST be stable across:
//   - identical inputs in the same process
//   - re-parses where course-history rows arrive in a different order
// And MUST change when either:
//   - a course-history row's content changes (grade flip, units edit)
//   - the cumulative block changes
// Fields outside the canonical input (e.g., _meta.parsedAt,
// header.preparedDate, requirementGroups) DO NOT participate.
// ============================================================

import { describe, expect, it } from "vitest";
import { computeDprFingerprint } from "../../src/dpr/fingerprint.js";
import { mkDpr, mkCourse } from "../helpers/mkDpr.js";

describe("computeDprFingerprint — determinism", () => {
    it("returns the same hash for the same input across two calls", () => {
        const dpr = mkDpr({
            courseHistory: [
                mkCourse({ term: "2023 Fall", courseId: "CSCI-UA 101", grade: "A" }),
                mkCourse({ term: "2024 Spr", courseId: "CSCI-UA 102", grade: "B+" }),
            ],
        });
        expect(computeDprFingerprint(dpr)).toBe(computeDprFingerprint(dpr));
    });

    it("ignores _meta.parsedAt (so a re-parse of the same source PDF matches)", () => {
        const a = mkDpr({
            parsedAt: "2026-04-27T00:00:00Z",
            courseHistory: [mkCourse({ term: "2023 Fall", courseId: "CSCI-UA 101", grade: "A" })],
        });
        const b = mkDpr({
            parsedAt: "2026-05-04T12:00:00Z",
            courseHistory: [mkCourse({ term: "2023 Fall", courseId: "CSCI-UA 101", grade: "A" })],
        });
        expect(computeDprFingerprint(a)).toBe(computeDprFingerprint(b));
    });

    it("returns the same hash regardless of course-history row order (sorts before hashing)", () => {
        const reordered = mkDpr({
            courseHistory: [
                mkCourse({ term: "2024 Spr", courseId: "CSCI-UA 102", grade: "B+" }),
                mkCourse({ term: "2023 Fall", courseId: "CSCI-UA 101", grade: "A" }),
            ],
        });
        const original = mkDpr({
            courseHistory: [
                mkCourse({ term: "2023 Fall", courseId: "CSCI-UA 101", grade: "A" }),
                mkCourse({ term: "2024 Spr", courseId: "CSCI-UA 102", grade: "B+" }),
            ],
        });
        expect(computeDprFingerprint(reordered)).toBe(computeDprFingerprint(original));
    });
});

describe("computeDprFingerprint — change detection", () => {
    it("changes when a course-history row's grade flips (IP → A)", () => {
        const before = mkDpr({
            courseHistory: [
                mkCourse({ term: "2026 Spr", courseId: "CSCI-UA 421", grade: null, type: "IP" }),
            ],
        });
        const after = mkDpr({
            courseHistory: [
                mkCourse({ term: "2026 Spr", courseId: "CSCI-UA 421", grade: "A", type: "EN" }),
            ],
        });
        expect(computeDprFingerprint(before)).not.toBe(computeDprFingerprint(after));
    });

    it("changes when a course-history row's units change", () => {
        const before = mkDpr({
            courseHistory: [
                mkCourse({ term: "2024 Spr", courseId: "CSCI-UA 102", grade: "A", units: 4 }),
            ],
        });
        const after = mkDpr({
            courseHistory: [
                mkCourse({ term: "2024 Spr", courseId: "CSCI-UA 102", grade: "A", units: 2 }),
            ],
        });
        expect(computeDprFingerprint(before)).not.toBe(computeDprFingerprint(after));
    });

    it("changes when the cumulative block changes (creditsUsed bumps)", () => {
        const before = mkDpr({ cumulative: { creditsUsed: 100 } });
        const after = mkDpr({ cumulative: { creditsUsed: 104 } });
        expect(computeDprFingerprint(before)).not.toBe(computeDprFingerprint(after));
    });

    it("changes when the programs list changes (declared major flips)", () => {
        const before = mkDpr({
            programs: [
                {
                    programType: "Major Approved",
                    label: "Computer Science",
                    requirementTerm: "Fall 2024",
                    requirementStatus: "satisfied",
                },
            ],
        });
        const after = mkDpr({
            programs: [
                {
                    programType: "Major Approved",
                    label: "Mathematics",
                    requirementTerm: "Fall 2024",
                    requirementStatus: "satisfied",
                },
            ],
        });
        expect(computeDprFingerprint(before)).not.toBe(computeDprFingerprint(after));
    });
});

describe("computeDprFingerprint — output shape", () => {
    it("is a 64-char lowercase hex string (sha256)", () => {
        const dpr = mkDpr();
        const fp = computeDprFingerprint(dpr);
        expect(fp).toMatch(/^[a-f0-9]{64}$/);
    });
});
