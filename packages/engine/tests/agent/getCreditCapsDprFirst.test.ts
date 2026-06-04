// ============================================================
// Phase E — get_credit_caps is DPR-first + school-agnostic
// ============================================================
// The authoritative caps come from the student's DPR cumulative block,
// not a per-school config. The tool runs with EITHER a DPR or a config;
// the per-semester ceiling + F-1 floor fall back to a shared
// NYU-undergrad default. This is what lets a non-CAS student (with just
// their DPR) get correct caps without a per-school config file.

import { describe, expect, it } from "vitest";
import { getCreditCapsTool } from "../../src/agent/tools/getCreditCaps.js";
import type { ToolUseContext } from "../../src/agent/tool.js";
import type { SchoolConfig } from "@nyupath/shared";
import { mkDpr } from "../helpers/mkDpr.js";

function sternStudent(visa?: "f1" | "domestic") {
    return {
        id: "t",
        homeSchool: "stern",
        catalogYear: "2025-2026",
        declaredPrograms: [],
        coursesTaken: [],
        ...(visa ? { visaStatus: visa } : {}),
    };
}

const STERN_DPR = mkDpr({
    cumulative: {
        creditsRequired: 120,
        cumulativeGpaRequired: 2.5,
        residencyRequired: 64,
        passFailCapUnits: 30,
        outsideHomeCapUnits: 16,
        timeLimitYears: 8,
    },
});

const CAS_CFG: SchoolConfig = {
    schoolId: "cas",
    name: "College of Arts and Science",
    degreeType: "BA",
    courseSuffix: ["-UA"],
    totalCreditsRequired: 128,
    overallGpaMin: 2.0,
    residency: { minCredits: 64, kind: "credits" },
    acceptsTransferCredit: true,
    maxCreditsPerSemester: 18,
    f1FullTimeMinCredits: 12,
};

function ctxWith(session: ToolUseContext["session"]): ToolUseContext {
    return { signal: new AbortController().signal, session };
}

describe("get_credit_caps — DPR-first, school-agnostic (Phase E)", () => {
    it("runs from a DPR alone (no schoolConfig) and reads caps from it", async () => {
        const ctx = ctxWith({ student: sternStudent(), degreeProgressReport: STERN_DPR });
        expect((await getCreditCapsTool.validateInput!({}, ctx)).ok).toBe(true);

        const out = await getCreditCapsTool.call({}, ctx);
        expect(out.totalCreditsRequired).toBe(120); // from DPR
        expect(out.overallGpaMin).toBe(2.5); // from DPR
        expect(out.perSemesterCeiling).toBe(18); // shared default (DPR-absent)
        expect(out.schoolName).toBe("NYU Stern School of Business"); // derived, not "CAS"
        expect(out.capsSource).toBe("dpr");
        // Per-student caps surfaced from the DPR cumulative block.
        expect(out.passFailCapUnits).toBe(30);
        expect(out.outsideHomeCapUnits).toBe(16);
        expect(out.timeLimitYears).toBe(8);

        const summary = getCreditCapsTool.summarizeResult(out);
        expect(summary).toContain("NYU Stern School of Business");
        expect(summary).toContain("Pass/Fail career cap: 30 units");
        expect(summary).toContain("Degree time limit: 8 years");
    });

    it("DPR wins over schoolConfig when both are present", async () => {
        const ctx = ctxWith({
            student: sternStudent(),
            schoolConfig: CAS_CFG,
            degreeProgressReport: STERN_DPR,
        });
        const out = await getCreditCapsTool.call({}, ctx);
        expect(out.totalCreditsRequired).toBe(120); // DPR, not config's 128
        expect(out.overallGpaMin).toBe(2.5); // DPR, not config's 2.0
        expect(out.capsSource).toBe("dpr+config");
    });

    it("without a DPR: both the degree total and the GPA floor are null (DPR-only)", async () => {
        const ctx = ctxWith({ student: { ...sternStudent(), homeSchool: "cas" }, schoolConfig: CAS_CFG });
        const out = await getCreditCapsTool.call({}, ctx);
        // Step 8c/8e — degree total and GPA floor are both per-student DPR
        // facts; without a DPR we don't state a personalized number.
        expect(out.totalCreditsRequired).toBeNull();
        expect(out.overallGpaMin).toBeNull();
        expect(out.capsSource).toBe("config");
    });

    it("rejects only when NEITHER a config NOR a DPR is loaded", async () => {
        const ctx = ctxWith({ student: sternStudent() });
        expect((await getCreditCapsTool.validateInput!({}, ctx)).ok).toBe(false);
    });

    it("F-1 floor falls back to the shared 12-credit default with no config", async () => {
        const ctx = ctxWith({ student: sternStudent("f1"), degreeProgressReport: STERN_DPR });
        const out = await getCreditCapsTool.call({}, ctx);
        expect(out.f1FullTimeFloor).toBe(12);
    });
});
