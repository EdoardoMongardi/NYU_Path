import { describe, it, expect } from "vitest";
import { getActiveVerb, getPastVerb, IDLE_VERB, TOOL_VERBS } from "../lib/agentStatusVerbs";

describe("agentStatusVerbs", () => {
    it("maps every tool name registered in the engine to an active verb", () => {
        const registered = [
            "run_full_audit", "plan_semester", "check_transfer_eligibility",
            "what_if_audit", "search_policy", "update_profile",
            "confirm_profile_update", "get_credit_caps", "search_availability",
            "get_academic_standing", "check_overlap", "search_courses",
        ];
        for (const t of registered) {
            expect(TOOL_VERBS[t], `missing verb for ${t}`).toBeDefined();
            expect(TOOL_VERBS[t].active.endsWith("…")).toBe(false);
            expect(TOOL_VERBS[t].past).toMatch(/.+/);
        }
    });

    it("getActiveVerb returns the mapped active form", () => {
        expect(getActiveVerb("search_policy")).toBe("Looking up policy");
        expect(getActiveVerb("plan_semester")).toBe("Planning your semester");
        expect(getActiveVerb("run_full_audit")).toBe("Running your degree audit");
    });

    it("getPastVerb returns the mapped past form", () => {
        expect(getPastVerb("search_policy")).toBe("Looked up policy");
        expect(getPastVerb("plan_semester")).toBe("Planned a semester");
    });

    it("falls back gracefully for unknown tool names", () => {
        expect(getActiveVerb("future_tool_xyz")).toBe("Working");
        expect(getPastVerb("future_tool_xyz")).toBe("Used a tool");
    });

    it("template_match pseudo-tools are passed through with a sensible verb", () => {
        expect(getActiveVerb("template:f1_credit_floor")).toBe("Checking a known answer");
        expect(getPastVerb("template:f1_credit_floor")).toBe("Matched a known answer");
    });

    it("exposes IDLE_VERB constant for the no-tool 'Thinking' state", () => {
        expect(IDLE_VERB).toBe("Thinking");
    });
});
