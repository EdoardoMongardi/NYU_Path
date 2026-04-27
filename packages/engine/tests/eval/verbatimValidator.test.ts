// ============================================================
// Phase 7-B Step 15 — verbatim-drift validator test
// ============================================================
// Verifies the 4th validator check that gates `outputMode:
// "semi_hardened"` tools.
// ============================================================

import { describe, expect, it } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator.js";
import type { ToolInvocation } from "../../src/agent/agentLoop.js";

const baseStudent = {
    id: "u1",
    catalogYear: "2025-2026",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "cs_major_ba", programType: "major" as const }],
    coursesTaken: [],
};

describe("verbatim-drift validator (Phase 7-B Step 15)", () => {
    it("passes when the assistant reply contains the verbatim text exactly", () => {
        const inv: ToolInvocation = {
            toolName: "run_full_audit",
            args: {},
            // Summary includes the GPA number so the grounding
            // validator (3rd check) is satisfied; this test focuses
            // on the verbatim-drift validator (4th check).
            summary: "audit ran. Cumulative GPA: 3.421",
            verbatimText: "Cumulative GPA: 3.421 (computed from your transcript).",
        };
        const verdict = validateResponse({
            assistantText:
                "Based on your transcript:\nCumulative GPA: 3.421 (computed from your transcript).\nLet me know if you want to dig in.",
            invocations: [inv],
            student: baseStudent,
        });
        expect(verdict.ok).toBe(true);
    });

    it("passes when the assistant reply contains the verbatim text with reflowed whitespace", () => {
        const inv: ToolInvocation = {
            toolName: "run_full_audit",
            args: {},
            // Summary includes the GPA number so the grounding
            // validator (3rd check) is satisfied; this test focuses
            // on the verbatim-drift validator (4th check).
            summary: "audit ran. Cumulative GPA: 3.421",
            verbatimText: "Cumulative GPA: 3.421 (computed from your transcript).",
        };
        const verdict = validateResponse({
            assistantText: "Cumulative GPA:    3.421\n(computed from your transcript).",
            invocations: [inv],
            student: baseStudent,
        });
        expect(verdict.ok).toBe(true);
    });

    it("fails when the model paraphrases the verbatim text", () => {
        const inv: ToolInvocation = {
            toolName: "run_full_audit",
            args: {},
            // Summary includes the GPA number so the grounding
            // validator (3rd check) is satisfied; this test focuses
            // on the verbatim-drift validator (4th check).
            summary: "audit ran. Cumulative GPA: 3.421",
            verbatimText: "Cumulative GPA: 3.421 (computed from your transcript).",
        };
        const verdict = validateResponse({
            assistantText: "Your cumulative GPA is around 3.4.",
            invocations: [inv],
            student: baseStudent,
        });
        expect(verdict.ok).toBe(false);
        const drift = verdict.violations.find((v) => v.kind === "verbatim_drift");
        expect(drift).toBeDefined();
        expect(drift!.detail).toMatch(/run_full_audit/);
    });

    it("ignores invocations with no verbatimText (synthesis-mode tools unaffected)", () => {
        const inv: ToolInvocation = {
            toolName: "search_courses",
            args: { query: "ml" },
            summary: "stub",
        };
        const verdict = validateResponse({
            assistantText: "Here are some ML courses.",
            invocations: [inv],
            student: baseStudent,
        });
        // No verbatim_drift violation can fire here.
        expect(verdict.violations.find((v) => v.kind === "verbatim_drift")).toBeUndefined();
    });
});
