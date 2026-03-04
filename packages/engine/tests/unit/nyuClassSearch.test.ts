// ============================================================
// NYU Class Search API — Unit Tests
// ============================================================
import { describe, it, expect } from "vitest";
import {
    generateTermCode,
    getRecentTermOptions,
    extractAvailableCourseIds,
    extractAllCourseIds,
} from "../../src/api/nyuClassSearch.js";
import type { FoseSearchResult } from "../../src/api/nyuClassSearch.js";

describe("Term Code Generation", () => {
    it("generates correct code for Spring 2025", () => {
        expect(generateTermCode(2025, "spring")).toBe("1254");
    });

    it("generates correct code for Fall 2025", () => {
        expect(generateTermCode(2025, "fall")).toBe("1258");
    });

    it("generates correct code for Summer 2025", () => {
        expect(generateTermCode(2025, "summer")).toBe("1256");
    });

    it("generates correct code for Spring 2024", () => {
        expect(generateTermCode(2024, "spring")).toBe("1244");
    });

    it("generates correct code for Fall 2023", () => {
        expect(generateTermCode(2023, "fall")).toBe("1238");
    });
});

describe("Recent Term Options", () => {
    it("returns terms for current and adjacent years", () => {
        const terms = getRecentTermOptions();
        // Should have 3 years × 3 terms = 9 options
        expect(terms.length).toBe(9);
    });

    it("each term has code, label, year, and term", () => {
        const terms = getRecentTermOptions();
        for (const t of terms) {
            expect(t.code).toBeTruthy();
            expect(t.label).toBeTruthy();
            expect(t.year).toBeGreaterThan(2020);
            expect(["spring", "summer", "fall"]).toContain(t.term);
        }
    });
});

describe("Course ID Extraction", () => {
    const mockResults: FoseSearchResult[] = [
        { key: "1", code: "CSCI-UA 101", title: "Intro", crn: "100", srcdb: "1254", stat: "O" },
        { key: "2", code: "CSCI-UA 101", title: "Intro", crn: "101", srcdb: "1254", stat: "O" }, // duplicate section
        { key: "3", code: "CSCI-UA 102", title: "Data Structures", crn: "200", srcdb: "1254", stat: "W" },
        { key: "4", code: "CSCI-UA 201", title: "CSO", crn: "300", srcdb: "1254", stat: "C" }, // closed
        { key: "5", code: "CSCI-UA 310", title: "Algorithms", crn: "400", srcdb: "1254", stat: "O" },
    ];

    it("extracts available (open/waitlisted) courses, deduplicated", () => {
        const ids = extractAvailableCourseIds(mockResults);
        expect(ids).toEqual(["CSCI-UA 101", "CSCI-UA 102", "CSCI-UA 310"]);
        // CSCI-UA 201 is closed, should not appear
        expect(ids).not.toContain("CSCI-UA 201");
    });

    it("extracts all course IDs regardless of status", () => {
        const ids = extractAllCourseIds(mockResults);
        expect(ids).toEqual(["CSCI-UA 101", "CSCI-UA 102", "CSCI-UA 201", "CSCI-UA 310"]);
    });

    it("deduplicates multiple sections of same course", () => {
        const ids = extractAllCourseIds(mockResults);
        const count = ids.filter(id => id === "CSCI-UA 101").length;
        expect(count).toBe(1);
    });
});
