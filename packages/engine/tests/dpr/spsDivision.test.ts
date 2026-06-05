import { describe, it, expect } from "vitest";
import { resolveSpsDivision, SPS_DIVISION_OPTIONS } from "../../src/dpr/spsDivision.js";
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

describe("resolveSpsDivision — low confidence (ask the student)", () => {
    it("career row only (no Major) → low, returns the three options", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Undergraduate Career", label: "UC-Sch of Prof Studies" }], 128));
        expect(r.confidence).toBe("low");
        if (r.confidence !== "low") return;
        expect(r.options).toEqual(SPS_DIVISION_OPTIONS);
    });

    it("Major label with no degree token and no creditsRequired → low", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Real Estate" }], null));
        expect(r.confidence).toBe("low");
    });

    it("two Majors in different divisions → low", () => {
        const r = resolveSpsDivision(dpr([
            { programType: "Major", label: "Real Estate (BS)" },
            { programType: "Major", label: "Applied General Studies (BA)" },
        ], 128));
        expect(r.confidence).toBe("low");
    });

    it("label says BS but creditsRequired says associate → conflict dropped → low", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major", label: "Real Estate (BS)" }], 60));
        expect(r.confidence).toBe("low");
    });
});

describe("resolveSpsDivision — realistic DPR shape ('Major Approved' + bare label + credits band)", () => {
    it("bare 'Real Estate' + 128 credits → schack / 64", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major Approved", label: "Real Estate" }], 128));
        expect(r.confidence).toBe("high");
        if (r.confidence !== "high") return;
        expect(r.division).toBe("schack");
        expect(r.advancedStandingCap).toBe(64);
    });

    it("bare 'Hospitality Management' + 60 credits → daus associate's / 30 (degree-level-first)", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major Approved", label: "Hospitality Management" }], 60));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(30);
    });

    it("bare 'Applied General Studies' + 120 credits → daus bachelor's / 80", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major Approved", label: "Applied General Studies" }], 120));
        expect(r.confidence === "high" && r.advancedStandingCap).toBe(80);
    });

    it("bare 'Sport Management' + 128 credits → tisch_institute / 64", () => {
        const r = resolveSpsDivision(dpr([{ programType: "Major Approved", label: "Sport Management" }], 128));
        expect(r.confidence === "high" && r.division).toBe("tisch_institute");
    });
});
