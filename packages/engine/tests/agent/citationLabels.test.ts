import { describe, it, expect } from "vitest";
import { formatCitation } from "../../src/agent/citationLabels";

describe("formatCitation", () => {
    it("maps the F-1 floor pointer to a user-facing label", () => {
        expect(formatCitation("data/schools/cas.json#f1FullTimeMinCredits"))
            .toBe("NYU CAS F-1 Full-Time Minimum Credit Policy");
        expect(formatCitation("data/schools/stern.json#f1FullTimeMinCredits"))
            .toBe("NYU Stern F-1 Full-Time Minimum Credit Policy");
    });

    it("maps the per-semester ceiling pointer to a user-facing label", () => {
        expect(formatCitation("data/schools/cas.json#maxCreditsPerSemester"))
            .toBe("NYU CAS Per-Semester Credit Ceiling");
        expect(formatCitation("data/schools/stern.json#maxCreditsPerSemester"))
            .toBe("NYU Stern Per-Semester Credit Ceiling");
    });

    it("falls back to a generic label for unknown pointers", () => {
        expect(formatCitation("data/schools/unknown.json#mysteryField"))
            .toBe("NYU policy reference");
        expect(formatCitation("totally/unrelated/path.json"))
            .toBe("NYU policy reference");
    });

    it("falls back to school-only label when field is unknown", () => {
        // Known school + unknown field → "<School> policy"
        expect(formatCitation("data/schools/cas.json#mysteryField"))
            .toBe("NYU CAS policy");
        expect(formatCitation("data/schools/stern.json#someUnknownKey"))
            .toBe("NYU Stern policy");
    });

    it("falls back to field-only label when school is unknown", () => {
        // Unknown school + known field → "NYU <Field Label>"
        // (Use schools NOT in SCHOOL_DISPLAY_NAMES: "wagner" and "lawschool".)
        expect(formatCitation("data/schools/wagner.json#f1FullTimeMinCredits"))
            .toBe("NYU F-1 Full-Time Minimum Credit Policy");
        expect(formatCitation("data/schools/lawschool.json#maxCreditsPerSemester"))
            .toBe("NYU Per-Semester Credit Ceiling");
    });

    it("never returns a string containing a filesystem path", () => {
        const labels = [
            formatCitation("data/schools/cas.json#f1FullTimeMinCredits"),
            formatCitation("data/schools/cas.json#maxCreditsPerSemester"),
            formatCitation("data/schools/stern.json#f1FullTimeMinCredits"),
            formatCitation("data/schools/unknown.json#mysteryField"),
        ];
        for (const label of labels) {
            expect(label, `leaked path in: ${label}`).not.toMatch(/\.json/);
            expect(label, `leaked path in: ${label}`).not.toMatch(/\//);
            expect(label, `leaked path in: ${label}`).not.toMatch(/#/);
        }
    });
});
