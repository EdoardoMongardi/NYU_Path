// Locks the "no DPR → no personalized answers" policy: the planning/record
// tools must hard-refuse in validateInput when no DPR is loaded.
import { describe, it, expect } from "vitest";
import { getAcademicStandingTool } from "../../src/agent/tools/getAcademicStanding.js";
import { planForwardDegreeTool } from "../../src/agent/tools/planForwardDegree.js";
import type { ToolUseContext } from "../../src/agent/tool.js";

function ctxNoDpr(): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session: {
            student: { id: "t", homeSchool: "sps", catalogYear: "2025-2026", declaredPrograms: [], coursesTaken: [] },
            schoolConfig: null,
            degreeProgressReport: undefined,
        },
    } as unknown as ToolUseContext;
}

describe("no-DPR policy: personalized tools refuse without a DPR", () => {
    it("get_academic_standing refuses", async () => {
        const r = await getAcademicStandingTool.validateInput!({}, ctxNoDpr());
        expect(r.ok).toBe(false);
    });

    it("plan_forward_degree refuses", async () => {
        const r = await planForwardDegreeTool.validateInput!({}, ctxNoDpr());
        expect(r.ok).toBe(false);
    });
});
