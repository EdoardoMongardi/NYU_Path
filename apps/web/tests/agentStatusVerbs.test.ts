import { describe, it, expect } from "vitest";
import { getActiveVerb, getPastVerb, getThoughtSentence, IDLE_VERB, TOOL_THOUGHT_SENTENCES, TOOL_VERBS } from "../lib/agentStatusVerbs";

describe("agentStatusVerbs", () => {
    it("maps every tool name registered in the engine to an active verb", () => {
        // Keep in lock-step with packages/engine/src/agent/registry.ts
        // (ALL_NYUPATH_TOOLS). When that array grows, add the new name here
        // AND add an entry in TOOL_VERBS + TOOL_THOUGHT_SENTENCES.
        const registered = [
            // Phase 0–11 (legacy minus plan_semester deprecated May 2026,
            // minus check_transfer_eligibility removed in the pure-RAG decommission)
            "run_full_audit",
            "what_if_audit", "search_policy", "update_profile",
            "confirm_profile_update", "get_credit_caps", "search_availability",
            "get_academic_standing", "check_overlap", "search_courses",
            // Improvement-plan Phase B
            "get_program_requirements",
            // Phase 13
            "plan_forward_degree", "view_forward_plan",
            // Phase 14
            "propose_plan_change", "confirm_plan_change", "simulate_alternatives",
            "bind_free_elective", "bind_pool_slot", "compare_plan_alternatives",
            // Phase 15
            "materialize_sections", "confirm_section_combination",
        ];
        for (const t of registered) {
            expect(TOOL_VERBS[t], `missing verb for ${t}`).toBeDefined();
            expect(TOOL_VERBS[t].active.endsWith("…")).toBe(false);
            expect(TOOL_VERBS[t].past).toMatch(/.+/);
        }
    });

    it("getActiveVerb returns the mapped active form", () => {
        expect(getActiveVerb("search_policy")).toBe("Looking up policy");
        expect(getActiveVerb("plan_forward_degree")).toBe("Planning your full degree");
        expect(getActiveVerb("run_full_audit")).toBe("Running your degree audit");
    });

    it("getPastVerb returns the mapped past form", () => {
        expect(getPastVerb("search_policy")).toBe("Looked up policy");
        expect(getPastVerb("plan_forward_degree")).toBe("Planned your full degree");
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

    it("maps every registered tool to a natural-language thought sentence", () => {
        const registered = Object.keys(TOOL_VERBS);
        for (const t of registered) {
            expect(TOOL_THOUGHT_SENTENCES[t], `missing thought for ${t}`).toBeDefined();
            // Sentences should read like a sentence — at least 30 chars and ending in punctuation.
            expect(TOOL_THOUGHT_SENTENCES[t].length).toBeGreaterThan(30);
            expect(/[.!?]$/.test(TOOL_THOUGHT_SENTENCES[t])).toBe(true);
        }
    });

    it("getThoughtSentence routes template_match prefixes to the canned-answer thought", () => {
        expect(getThoughtSentence("template:f1_credit_floor")).toMatch(/canned answer/i);
    });

    it("getThoughtSentence falls back to a generic thought for unknown tool names", () => {
        const fallback = getThoughtSentence("future_tool_xyz");
        expect(fallback.length).toBeGreaterThan(10);
        expect(/[.!?]$/.test(fallback)).toBe(true);
    });

    it("getThoughtSentence returns the mapped sentence for known tools", () => {
        expect(getThoughtSentence("search_policy")).toMatch(/policy|bulletin/i);
        expect(getThoughtSentence("plan_forward_degree")).toMatch(/plan|degree/i);
    });
});
