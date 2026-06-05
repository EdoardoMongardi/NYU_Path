// ============================================================
// Course-ID canonicalization (the "CS 101 == CS 0101" fix)
// ============================================================
// Proves that the zero-padded and unpadded forms of the same course are
// treated as equal by the pure helper.

import { describe, expect, it } from "vitest";
import { canonicalizeCourseId } from "../../src/courseId.js";

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
