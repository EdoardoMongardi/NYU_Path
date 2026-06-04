// ============================================================
// Course-ID canonicalization (the "CS 101 == CS 0101" fix)
// ============================================================
// Proves that the zero-padded and unpadded forms of the same course are
// treated as equal — both by the pure helper and end-to-end through the
// prereq graph (a padded prereq is satisfied by the student's unpadded
// completion, which previously failed silently).

import { describe, expect, it } from "vitest";
import { canonicalizeCourseId } from "../../src/courseId.js";
import { PrereqGraph } from "../../src/graph/prereqGraph.js";
import type { Prerequisite } from "@nyupath/shared";

describe("canonicalizeCourseId", () => {
    it("strips leading zeros from the course number", () => {
        expect(canonicalizeCourseId("CSCI-UA 0101")).toBe("CSCI-UA 101");
        expect(canonicalizeCourseId("EXPOS-UA 0001")).toBe("EXPOS-UA 1");
        expect(canonicalizeCourseId("MATH-UA 0009")).toBe("MATH-UA 9");
        expect(canonicalizeCourseId("ACCT-UB 0001")).toBe("ACCT-UB 1");
    });
    it("is a no-op on already-canonical ids", () => {
        expect(canonicalizeCourseId("CSCI-UA 101")).toBe("CSCI-UA 101");
        expect(canonicalizeCourseId("MATH-UA 123")).toBe("MATH-UA 123");
    });
    it("preserves AP/IB/placement pseudo-ids (no space-then-zero)", () => {
        expect(canonicalizeCourseId("AP-CS-A-3")).toBe("AP-CS-A-3");
        expect(canonicalizeCourseId("PLACE-LANG-MANDARIN-1")).toBe("PLACE-LANG-MANDARIN-1");
        expect(canonicalizeCourseId("IB-PSYCH-HL-5")).toBe("IB-PSYCH-HL-5");
    });
    it("preserves a letter suffix while stripping the leading zero", () => {
        expect(canonicalizeCourseId("CHIN-SHU 0101S")).toBe("CHIN-SHU 101S");
    });
});

describe("PrereqGraph — padded/unpadded forms match (the live fix)", () => {
    const prereqs: Prerequisite[] = [
        // X's prereq is stored zero-padded; the student completed the unpadded form.
        { course: "ADV-UA 200", prereqGroups: [{ type: "AND", courses: ["MATH-UA 0009"] }], coreqs: [] },
    ] as unknown as Prerequisite[];
    const graph = new PrereqGraph(prereqs);

    it("a padded prereq is satisfied by the student's unpadded completion", () => {
        expect(graph.hasPrerequisitesMet("ADV-UA 200", new Set(["MATH-UA 9"]))).toBe(true);
    });
    it("and vice-versa (unpadded query id, padded completion)", () => {
        expect(graph.hasPrerequisitesMet("ADV-UA 200", new Set(["MATH-UA 0009"]))).toBe(true);
    });
    it("still correctly reports an unmet prereq", () => {
        expect(graph.hasPrerequisitesMet("ADV-UA 200", new Set(["MATH-UA 8"]))).toBe(false);
    });
});
