// ============================================================
// Phase 12.5 Task 5 — getCreditCaps refactor tests
// ============================================================
// Verifies that:
//   1. validateInput no longer rejects when DPR is loaded.
//   2. call() always returns numeric caps.
//   3. call() emits a suggestedFollowUp pointing at search_policy
//      when DPR is loaded.
//   4. call() does NOT emit the follow-up when DPR is absent.
// ============================================================

import { describe, it, expect } from "vitest";
import { getCreditCapsTool } from "../../src/agent/tools/getCreditCaps.js";
import type { ToolUseContext } from "../../src/agent/tool.js";
import type { SchoolConfig } from "@nyupath/shared";

// Minimal SchoolConfig with the two numeric values the tests assert on.
const FAKE_CFG: SchoolConfig = {
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

function fakeCtx(opts: { dprLoaded: boolean; visa?: string }): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session: {
            student: {
                id: "t",
                homeSchool: "cas",
                catalogYear: "2025-2026",
                declaredPrograms: [],
                coursesTaken: [],
                visaStatus: opts.visa as "f1" | "domestic" | "other" | undefined,
            },
            schoolConfig: FAKE_CFG,
            degreeProgressReport: opts.dprLoaded ? ({} as any) : undefined,
        },
    };
}

describe("getCreditCaps refactor (Phase 12.5 Task 5)", () => {
    it("validateInput accepts the call even when DPR is loaded (no rejection)", async () => {
        const ctx = fakeCtx({ dprLoaded: true });
        const result = await getCreditCapsTool.validateInput!({}, ctx);
        expect(result.ok).toBe(true);
    });

    it("validateInput still accepts when DPR is not loaded", async () => {
        const ctx = fakeCtx({ dprLoaded: false });
        const result = await getCreditCapsTool.validateInput!({}, ctx);
        expect(result.ok).toBe(true);
    });

    it("returns the actual school + visa caps in the data payload", async () => {
        const ctx = fakeCtx({ dprLoaded: true, visa: "f1" });
        const result = await getCreditCapsTool.call({}, ctx);
        // Confirm the numeric caps are surfaced.
        const allText = JSON.stringify(result);
        expect(allText).toMatch(/18/); // maxCreditsPerSemester
        expect(allText).toMatch(/12/); // f1FullTimeMinCredits
    });

    it("emits a suggestedFollowUp pointing at search_policy when DPR is loaded", async () => {
        const ctx = fakeCtx({ dprLoaded: true, visa: "f1" });
        const result = await getCreditCapsTool.call({}, ctx);
        const allText = JSON.stringify(result).toLowerCase();
        expect(allText).toContain("search_policy");
    });

    it("does not emit the search_policy followUp when DPR is not loaded", async () => {
        // When there's no DPR, the credit caps come from school config
        // alone — there's no need to chain to search_policy.
        const ctx = fakeCtx({ dprLoaded: false });
        const result = await getCreditCapsTool.call({}, ctx);
        const allText = JSON.stringify(result).toLowerCase();
        expect(allText).not.toContain("search_policy");
    });
});
