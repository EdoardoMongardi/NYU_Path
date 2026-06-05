// ============================================================
// get_credit_caps — SPS division-specific advanced-standing caps
// ============================================================
// SPS is administratively one school but operationally a federation of
// divisions whose advanced-standing caps differ: Schack Institute / Tisch
// Center / Tisch Institute bachelor's = 64, Division of Applied Undergraduate
// Studies (DAUS) bachelor's = 80, DAUS associate's = 30 (SPS academic-policies
// bulletin L376/L378). There is no division signal in the student profile, so
// the tool must surface ALL three scoped variants rather than silently
// presenting the Schack/Tisch 64 as "SPS".
// ============================================================

import { describe, it, expect } from "vitest";
import { getCreditCapsTool } from "../../src/agent/tools/getCreditCaps.js";
import { loadSchoolConfig } from "../../src/dataLoader.js";
import type { ToolUseContext } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

const sps = loadSchoolConfig("sps")!;

function spsCtx(): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session: {
            student: {
                id: "t",
                homeSchool: "sps",
                catalogYear: "2025-2026",
                declaredPrograms: [],
                coursesTaken: [],
            },
            schoolConfig: sps,
            degreeProgressReport: undefined,
        },
    } as unknown as ToolUseContext;
}

describe("get_credit_caps surfaces SPS division-specific advanced-standing caps", () => {
    it("config carries all three division-scoped advanced-standing caps", () => {
        const adv = (sps.creditCaps ?? []).filter((c) => c.type === "advanced_standing");
        const byCredits = Object.fromEntries(adv.map((c) => [c.maxCredits, c.appliesTo]));
        expect(byCredits[64]).toBeTruthy(); // Schack/Tisch bachelor's
        expect(byCredits[80]).toBeTruthy(); // DAUS bachelor's
        expect(byCredits[30]).toBeTruthy(); // DAUS associate's
        // Every scoped cap names which division/degree it applies to.
        expect(adv.every((c) => typeof c.appliesTo === "string" && c.appliesTo.length > 0)).toBe(true);
    });

    it("the rendered summary shows each division's cap with its scope", async () => {
        const out = await getCreditCapsTool.call({}, spsCtx());
        const summary = getCreditCapsTool.summarizeResult!(out as never);
        const lower = summary.toLowerCase();
        expect(summary).toContain("80");
        expect(summary).toContain("30");
        expect(lower).toContain("daus"); // Division of Applied Undergraduate Studies
        expect(lower).toContain("associate");
    });
});

function spsCtxWithDpr(programLabel: string, creditsRequired: number): ToolUseContext {
    const dpr = {
        programs: [{ programType: "Major", label: programLabel, requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" }],
        cumulative: { creditsRequired },
    } as unknown as DegreeProgressReport;
    return {
        signal: new AbortController().signal,
        session: {
            student: { id: "t", homeSchool: "sps", catalogYear: "2025-2026", declaredPrograms: [], coursesTaken: [] },
            schoolConfig: sps,
            degreeProgressReport: dpr,
        },
    } as unknown as ToolUseContext;
}

describe("get_credit_caps resolves the SPS division from the DPR", () => {
    it("DAUS bachelor's DPR → summary shows the single 80 cap, not all three", async () => {
        const out = await getCreditCapsTool.call({}, spsCtxWithDpr("Applied General Studies (BA)", 120));
        const summary = getCreditCapsTool.summarizeResult!(out as never);
        expect(summary).toContain("80");
        expect(summary.toLowerCase()).toContain("daus");
        expect(summary).not.toContain("64 credits");
        expect(summary).not.toContain("30 credits");
    });
});

describe("get_credit_caps SPS division — clarification + unchanged paths", () => {
    it("career-only DPR → summary asks the student to confirm their division (lists all three)", async () => {
        const dpr = {
            programs: [{ programType: "Undergraduate Career", label: "UC-Sch of Prof Studies", requirementTerm: "Fall 2024", requirementStatus: "not_satisfied" }],
            cumulative: { creditsRequired: 128 },
        } as unknown as DegreeProgressReport;
        const ctx = {
            signal: new AbortController().signal,
            session: {
                student: { id: "t", homeSchool: "sps", catalogYear: "2025-2026", declaredPrograms: [], coursesTaken: [] },
                schoolConfig: sps,
                degreeProgressReport: dpr,
            },
        } as unknown as ToolUseContext;
        const out = await getCreditCapsTool.call({}, ctx);
        const summary = getCreditCapsTool.summarizeResult!(out as never);
        const lower = summary.toLowerCase();
        expect(lower).toContain("confirm");
        expect(summary).toContain("64");
        expect(summary).toContain("80");
        expect(summary).toContain("30");
    });

    it("no DPR → still shows all three scoped caps (general policy, status quo)", async () => {
        const out = await getCreditCapsTool.call({}, spsCtx()); // spsCtx() defined earlier in this file (no DPR)
        const summary = getCreditCapsTool.summarizeResult!(out as never);
        expect(summary).toContain("80");
        expect(summary.toLowerCase()).toContain("associate");
        expect(summary.toLowerCase()).not.toContain("confirm");
    });
});
