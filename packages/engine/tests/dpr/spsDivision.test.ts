import { describe, it, expect } from "vitest";
import { resolveSpsDivision } from "../../src/dpr/spsDivision.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

function dpr(
    programs: Array<{ programType: string; label: string }>,
    creditsRequired: number | null = null,
): DegreeProgressReport {
    return {
        programs: programs.map((p) => ({
            ...p,
            requirementTerm: "Fall 2024",
            requirementStatus: "not_satisfied",
        })),
        cumulative: { creditsRequired },
    } as unknown as DegreeProgressReport;
}

describe("resolveSpsDivision — high confidence", () => {
    const CAREER = { programType: "Undergraduate Career", label: "UC-Sch of Prof Studies" };

    it("Real Estate (BS) → Schack, cap 64", () => {
        const r = resolveSpsDivision(dpr([CAREER, { programType: "Major", label: "Real Estate (BS)" }], 128));
        expect(r.confidence).toBe("high");
        if (r.confidence !== "high") return;
        expect(r.division).toBe("schack");
        expect(r.advancedStandingCap).toBe(64);
    });

    it("Hospitality, Travel and Tourism Management (BS) → Tisch Center, cap 64", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Hospitality, Travel and Tourism Management (BS)" }], 128));
        expect(r.confidence === "high" && r.division).toBe("tisch_center");
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(64);
    });

    it("Sport Management (BS) → Tisch Institute, cap 64", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Sport Management (BS)" }], 128));
        expect(r.confidence === "high" && r.division).toBe("tisch_institute");
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(64);
    });

    it("Leadership and Management Studies (BS) → DAUS bachelor's, cap 80", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Leadership and Management Studies (BS)" }], 128));
        expect(r.confidence === "high" && r.division).toBe("daus");
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(80);
    });

    it("Applied General Studies (BA) → DAUS bachelor's, cap 80", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Applied General Studies (BA)" }], 120));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(80);
    });

    it("Business (AAS) → DAUS associate's, cap 30", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Business (AAS)" }], 60));
        expect(r.confidence === "high" && r.division).toBe("daus");
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(30);
    });

    it("Hospitality Management (AAS) → DAUS associate's, cap 30 (degree-level-first beats the subject token)", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Hospitality Management (AAS)" }], 60));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(30);
    });

    it("Liberal Arts (AA) → DAUS associate's, cap 30", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Liberal Arts (AA)" }], 60));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(30);
    });

    it("supplies the degree level from creditsRequired when the label has no degree token", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Real Estate" }], 128));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(64);
    });
});
