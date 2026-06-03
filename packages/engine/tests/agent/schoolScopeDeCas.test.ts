// ============================================================
// Phase E — de-CAS scope: shared defaults + dynamic prompt school name
// ============================================================

import { describe, expect, it } from "vitest";
import {
    DEFAULT_F1_FULLTIME_MIN_CREDITS,
    DEFAULT_PER_SEMESTER_CEILING,
    perSemesterCeilingFor,
    schoolDisplayName,
} from "../../src/data/schoolDefaults.js";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

describe("schoolDefaults (Phase E)", () => {
    it("exposes the near-universal NYU-undergrad registration constants", () => {
        expect(DEFAULT_PER_SEMESTER_CEILING).toBe(18);
        expect(DEFAULT_F1_FULLTIME_MIN_CREDITS).toBe(12);
    });

    it("perSemesterCeilingFor returns the shared default for any school today", () => {
        expect(perSemesterCeilingFor("cas")).toBe(18);
        expect(perSemesterCeilingFor("stern")).toBe(18);
        expect(perSemesterCeilingFor(undefined)).toBe(18);
    });

    it("schoolDisplayName maps ids to full names, falls back to generic NYU", () => {
        expect(schoolDisplayName("cas")).toBe("NYU College of Arts & Science");
        expect(schoolDisplayName("stern")).toBe("NYU Stern School of Business");
        expect(schoolDisplayName("tandon")).toBe("NYU Tandon School of Engineering");
        // Unknown / missing → generic, never an asserted wrong school.
        expect(schoolDisplayName("madeup")).toBe("NYU");
        expect(schoolDisplayName(undefined)).toBe("NYU");
    });
});

describe("system prompt — de-CAS role line (Phase E)", () => {
    const baseStudent = {
        id: "u1",
        catalogYear: "2025-2026",
        declaredPrograms: [],
        coursesTaken: [],
    };

    it("introduces with the STUDENT's school, not a hardcoded CAS", () => {
        const stern = buildSystemPrompt({ student: { ...baseStudent, homeSchool: "stern" } });
        expect(stern).toContain("NYU Stern School of Business");
        expect(stern).not.toContain("an AI academic adviser for NYU College of Arts & Science");
    });

    it("still says CAS for a CAS student", () => {
        const cas = buildSystemPrompt({ student: { ...baseStudent, homeSchool: "cas" } });
        expect(cas).toContain("an AI academic adviser for NYU College of Arts & Science");
    });

    it("falls back to a generic NYU when no student is loaded", () => {
        const none = buildSystemPrompt({});
        expect(none).toContain("an AI academic adviser for NYU.");
        expect(none).not.toContain("College of Arts & Science");
    });
});
