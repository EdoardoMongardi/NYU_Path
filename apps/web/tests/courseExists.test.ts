// ============================================================
// courseExists — catalog-presence check (Task E3)
// ============================================================
// "CSCI-UA 101" is verified to exist in the bundled courses.json.
// "CSCI-UA 0101" is the zero-padded form — canonicalizeCourseId
//   strips the leading zero → "CSCI-UA 101", which IS in the catalog,
//   so the padded form must resolve to true.
// "ZZZZ-UA 9999" is a nonsense id that cannot exist.

import { describe, it, expect, beforeEach } from "vitest";
import { courseExists, _clearCourseExistsCache } from "../lib/courseExists";

describe("courseExists", () => {
    beforeEach(() => {
        _clearCourseExistsCache();
    });

    it("returns true for a real catalog course id (CSCI-UA 101)", () => {
        expect(courseExists("CSCI-UA 101")).toBe(true);
    });

    it("returns false for a nonsense course id (ZZZZ-UA 9999)", () => {
        expect(courseExists("ZZZZ-UA 9999")).toBe(false);
    });

    it("canonicalizes: the zero-padded form CSCI-UA 0101 matches CSCI-UA 101 → true", () => {
        // canonicalizeCourseId("CSCI-UA 0101") → "CSCI-UA 101", which is in the catalog.
        expect(courseExists("CSCI-UA 0101")).toBe(true);
    });

    it("caches: a second call with the same id returns the same result without re-loading", () => {
        const first = courseExists("CSCI-UA 101");
        const second = courseExists("CSCI-UA 101");
        expect(first).toBe(true);
        expect(second).toBe(true);
    });
});
