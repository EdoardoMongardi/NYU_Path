// ============================================================
// diffClassFor — pure helper unit test (node env, no jsdom)
// ============================================================
// Tests the `diffClassFor(diff, term, courseId)` helper extracted from
// ScheduleView so the diff-class lookup logic is node-unit-tested
// independently of the React component.
// ============================================================

import { describe, it, expect } from "vitest";
import { diffClassFor } from "../app/chat/workspace/ScheduleView";
import type { AnnotatedColumn } from "../lib/scenarios/scheduleDiff";

// Minimal AnnotatedColumn fixture: one term, three rows.
const makeColumn = (): AnnotatedColumn => ({
    terms: [
        {
            term: "2026-fall",
            rows: [
                { courseId: "CSCI-UA 101", label: "Intro CS", term: "2026-fall", diff: "same" },
                { courseId: "MATH-UA 121", label: "Calculus I", term: "2026-fall", diff: "added" },
                { courseId: "PHYS-UA 11",  label: "Physics I", term: "2026-fall", diff: "removed" },
                { courseId: "CSCI-UA 201", label: "Data Structures", term: "2026-fall", diff: "moved" },
                { courseId: "CSCI-UA 310", label: "OS", term: "2026-fall", diff: "retake" },
            ],
        },
        {
            term: "2027-spring",
            rows: [
                { courseId: "CSCI-UA 202", label: "Algorithms", term: "2027-spring", diff: "same" },
            ],
        },
    ],
});

describe("diffClassFor — no diff column", () => {
    it("returns null when diff is undefined", () => {
        expect(diffClassFor(undefined, "2026-fall", "CSCI-UA 101")).toBeNull();
    });
});

describe("diffClassFor — correct class for each CourseDiff value", () => {
    const col = makeColumn();

    it("returns null for 'same'", () => {
        expect(diffClassFor(col, "2026-fall", "CSCI-UA 101")).toBeNull();
    });

    it("returns 'diff-added' for 'added'", () => {
        expect(diffClassFor(col, "2026-fall", "MATH-UA 121")).toBe("diff-added");
    });

    it("returns 'diff-removed' for 'removed'", () => {
        expect(diffClassFor(col, "2026-fall", "PHYS-UA 11")).toBe("diff-removed");
    });

    it("returns 'diff-moved' for 'moved'", () => {
        expect(diffClassFor(col, "2026-fall", "CSCI-UA 201")).toBe("diff-moved");
    });

    it("returns 'diff-retake' for 'retake'", () => {
        expect(diffClassFor(col, "2026-fall", "CSCI-UA 310")).toBe("diff-retake");
    });
});

describe("diffClassFor — cross-term isolation", () => {
    const col = makeColumn();

    it("returns null when courseId is not in the given term (exists in another term)", () => {
        // CSCI-UA 202 is in 2027-spring, not 2026-fall
        expect(diffClassFor(col, "2026-fall", "CSCI-UA 202")).toBeNull();
    });

    it("finds the course in the correct term", () => {
        expect(diffClassFor(col, "2027-spring", "CSCI-UA 202")).toBeNull(); // same → null
    });
});

describe("diffClassFor — course absent from diff column", () => {
    const col = makeColumn();

    it("returns null when courseId is not in the diff at all", () => {
        expect(diffClassFor(col, "2026-fall", "UNKNOWN-999")).toBeNull();
    });
});
