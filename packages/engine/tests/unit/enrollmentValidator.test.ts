// ============================================================
// Unit Tests — Enrollment Validator
// ============================================================
import { describe, it, expect } from "vitest";
import { validateEnrollment } from "../../src/planner/enrollmentValidator.js";
import type { CourseSuggestion, StudentProfile, PlannerConfig } from "@nyupath/shared";

function mockSuggestion(courseId: string, credits: number): CourseSuggestion {
    return {
        courseId,
        title: `Mock ${courseId}`,
        credits,
        reason: "test",
        priority: 10,
        blockedCount: 0,
        satisfiesRules: [],
        category: "elective",
    };
}

function makeStudent(visaStatus: "f1" | "domestic" | "other" = "domestic"): StudentProfile {
    return {
        id: "test",
        catalogYear: "2023",
        declaredPrograms: ["cs_major_ba"],
        coursesTaken: [],
        visaStatus,
    };
}

function makeConfig(overrides: Partial<PlannerConfig> = {}): PlannerConfig {
    return {
        targetSemester: "2025-fall",
        maxCourses: 5,
        maxCredits: 20,
        ...overrides,
    };
}

// ============================================================
// F-1 Student Tests
// ============================================================
describe("Enrollment Validator: F-1 Student", () => {
    it("F-1 with 12 credits (3 online + 9 in-person) → valid", () => {
        const suggestions = [
            mockSuggestion("ONLINE-1", 3),
            mockSuggestion("INPERSON-1", 3),
            mockSuggestion("INPERSON-2", 3),
            mockSuggestion("INPERSON-3", 3),
        ];
        const config = makeConfig({ onlineCourseIds: ["ONLINE-1"] });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(0);
    });

    it("F-1 with 9 credits → VIOLATION (below 12 minimum)", () => {
        const suggestions = [
            mockSuggestion("COURSE-1", 3),
            mockSuggestion("COURSE-2", 3),
            mockSuggestion("COURSE-3", 3),
        ];
        const result = validateEnrollment(suggestions, makeStudent("f1"), makeConfig());
        expect(result.valid).toBe(false);
        expect(result.warnings.some(w => w.includes("F-1 VIOLATION"))).toBe(true);
        expect(result.warnings.some(w => w.includes("9 credits"))).toBe(true);
    });

    it("F-1 with 2 online courses → VIOLATION", () => {
        const suggestions = [
            mockSuggestion("ONLINE-1", 3),
            mockSuggestion("ONLINE-2", 3),
            mockSuggestion("INPERSON-1", 3),
            mockSuggestion("INPERSON-2", 3),
        ];
        const config = makeConfig({ onlineCourseIds: ["ONLINE-1", "ONLINE-2"] });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        expect(result.valid).toBe(false);
        expect(result.warnings.some(w => w.includes("2 online courses"))).toBe(true);
    });

    it("F-1 with 12 credits but only 3 in-person → VIOLATION (online majority)", () => {
        const suggestions = [
            mockSuggestion("ONLINE-1", 3),
            mockSuggestion("ONLINE-2", 3),
            mockSuggestion("ONLINE-3", 3),
            mockSuggestion("INPERSON-1", 3),
        ];
        const config = makeConfig({ onlineCourseIds: ["ONLINE-1", "ONLINE-2", "ONLINE-3"] });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        expect(result.valid).toBe(false);
    });

    it("F-1 final semester with 6 credits → valid (RCL exception)", () => {
        const suggestions = [
            mockSuggestion("COURSE-1", 3),
            mockSuggestion("COURSE-2", 3),
        ];
        const config = makeConfig({ isFinalSemester: true });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        expect(result.valid).toBe(true);
        // Should still have advisory about OGS approval
        expect(result.warnings.some(w => w.includes("OGS") || w.includes("RCL"))).toBe(true);
    });

    it("F-1 summer semester → no enrollment check", () => {
        const suggestions = [
            mockSuggestion("COURSE-1", 3),
        ];
        const config = makeConfig({ targetSemester: "2025-summer" });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(0);
    });

    it("F-1 january term → no enrollment check", () => {
        const suggestions = [
            mockSuggestion("COURSE-1", 3),
        ];
        const config = makeConfig({ targetSemester: "2026-january" });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(0);
    });
});

// ============================================================
// Domestic Student Tests
// ============================================================
describe("Enrollment Validator: Domestic Student", () => {
    it("domestic with 6 credits → half-time warning", () => {
        const suggestions = [
            mockSuggestion("COURSE-1", 3),
            mockSuggestion("COURSE-2", 3),
        ];
        const result = validateEnrollment(suggestions, makeStudent("domestic"), makeConfig());
        expect(result.valid).toBe(true);  // Not a hard error
        expect(result.warnings.some(w => w.includes("half-time") || w.includes("Half-time"))).toBe(true);
    });

    it("domestic with 12 credits → no warning", () => {
        const suggestions = [
            mockSuggestion("COURSE-1", 4),
            mockSuggestion("COURSE-2", 4),
            mockSuggestion("COURSE-3", 4),
        ];
        const result = validateEnrollment(suggestions, makeStudent("domestic"), makeConfig());
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(0);
    });

    it("domestic final semester with 3 credits → no warning", () => {
        const suggestions = [
            mockSuggestion("COURSE-1", 3),
        ];
        const config = makeConfig({ isFinalSemester: true });
        const result = validateEnrollment(suggestions, makeStudent("domestic"), config);
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(0);
    });

    it("domestic with no visaStatus set → treated as domestic", () => {
        const student: StudentProfile = {
            id: "test",
            catalogYear: "2023",
            declaredPrograms: [],
            coursesTaken: [],
            // no visaStatus
        };
        const suggestions = [
            mockSuggestion("COURSE-1", 3),
        ];
        const result = validateEnrollment(suggestions, student, makeConfig());
        expect(result.valid).toBe(true);
        // Should get half-time warning (3 < 12)
        expect(result.warnings.some(w => w.includes("half-time") || w.includes("Half-time"))).toBe(true);
    });
});

// ============================================================
// Boundary Edge Cases
// ============================================================
describe("Enrollment Validator: Boundary cases", () => {
    it("F-1 exactly 12 credits, exactly 1 online (3cr), 9 in-person → valid", () => {
        const suggestions = [
            mockSuggestion("ONLINE-1", 3),
            mockSuggestion("INPERSON-1", 4),
            mockSuggestion("INPERSON-2", 4),
            mockSuggestion("INPERSON-3", 1),  // 12 total, 9 in-person
        ];
        const config = makeConfig({ onlineCourseIds: ["ONLINE-1"] });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(0);
    });

    it("F-1 single 4-credit online course → VIOLATION (>3 online credits)", () => {
        const suggestions = [
            mockSuggestion("ONLINE-1", 4),  // 1 online course but 4 credits
            mockSuggestion("INPERSON-1", 4),
            mockSuggestion("INPERSON-2", 4),
        ];
        const config = makeConfig({ onlineCourseIds: ["ONLINE-1"] });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        expect(result.valid).toBe(false);
        expect(result.warnings.some(w => w.includes("online") && w.includes("4 credits"))).toBe(true);
    });

    it("F-1 exactly 12 credits but only 8 in-person → VIOLATION (needs 9)", () => {
        const suggestions = [
            mockSuggestion("ONLINE-1", 3),   // 1 online
            mockSuggestion("ONLINE-2", 1),   // counted as 2nd online but also reduces in-person
            mockSuggestion("INPERSON-1", 4),
            mockSuggestion("INPERSON-2", 4),
        ];
        const config = makeConfig({ onlineCourseIds: ["ONLINE-1", "ONLINE-2"] });
        const result = validateEnrollment(suggestions, makeStudent("f1"), config);
        // 2 online courses → violation
        expect(result.valid).toBe(false);
    });
});
