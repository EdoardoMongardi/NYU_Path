// ============================================================
// Unit Tests — Availability Predictor
// ============================================================
import { describe, it, expect } from "vitest";
import { predictAvailability } from "../../src/search/availabilityPredictor.js";

function makeCourse(courseId: string, termsOffered: string[]) {
    return { courseId, termsOffered };
}

describe("Availability Predictor", () => {
    it("confirmed: course listed in target term", () => {
        const course = makeCourse("CSCI-UA 101", ["1248", "1254", "1258"]);
        const result = predictAvailability(course, "1258");
        expect(result.available).toBe(true);
        expect(result.confidence).toBe("confirmed");
    });

    it("confirmed unavailable: term is published but course not in it", () => {
        const course = makeCourse("CSCI-UA 480", ["1248"]); // only Fall 2024
        const published = new Set(["1258"]); // Fall 2025 is published
        const result = predictAvailability(course, "1258", published);
        expect(result.available).toBe(false);
        expect(result.confidence).toBe("confirmed");
    });

    it("likely: offered in same season 2+ times", () => {
        // Offered Fall 2024 + Fall 2025, predict Fall 2026
        const course = makeCourse("CSCI-UA 101", ["1248", "1258"]);
        const result = predictAvailability(course, "1268");
        expect(result.available).toBe(true);
        expect(result.confidence).toBe("likely");
        expect(result.reason).toContain("fall");
    });

    it("uncertain: offered in same season only once", () => {
        // Offered Fall 2025 only, predict Fall 2026
        const course = makeCourse("CSCI-UA 480", ["1258"]);
        const result = predictAvailability(course, "1268");
        expect(result.available).toBe(true);
        expect(result.confidence).toBe("uncertain");
    });

    it("uncertain unavailable: never offered in target season", () => {
        // Only offered in spring, predict fall
        const course = makeCourse("ENGL-UA 910", ["1244", "1254", "1264"]);
        const result = predictAvailability(course, "1268"); // fall
        expect(result.available).toBe(false);
        expect(result.confidence).toBe("uncertain");
        expect(result.reason).toContain("Never offered in fall");
    });

    it("spring prediction from spring history", () => {
        const course = makeCourse("MATH-UA 120", ["1244", "1254"]); // Spring 24 + 25
        const result = predictAvailability(course, "1264"); // Spring 2026
        // Spring 2026 IS in our data, but let's test without it in termsOffered
        // Actually 1264 is in our scraped data. Let's test 1274 (Spring 2027)
        const result2 = predictAvailability(course, "1274"); // Spring 2027
        expect(result2.available).toBe(true);
        expect(result2.confidence).toBe("likely");
    });

    it("summer courses predicted correctly", () => {
        const course = makeCourse("CSCI-UA 102", ["1246", "1256"]); // Summer 24 + 25
        const result = predictAvailability(course, "1266"); // Summer 2026
        // Check if 1266 is in termsOffered or not
        if (course.termsOffered.includes("1266")) {
            expect(result.confidence).toBe("confirmed");
        } else {
            expect(result.available).toBe(true);
            expect(result.confidence).toBe("likely");
        }
    });

    it("cross-season: fall-only course predicted unavailable in spring", () => {
        const course = makeCourse("CS-UY 4613", ["1248", "1258"]); // only fall
        const result = predictAvailability(course, "1274"); // Spring 2027
        expect(result.available).toBe(false);
        expect(result.reason).toContain("Never offered in spring");
    });
});
