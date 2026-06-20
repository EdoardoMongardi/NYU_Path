// ============================================================
// fosePhaseE0Routing.test.ts — Phase 38 Task E0 (agent reachability)
// ============================================================
// `materialize_feasible` is registered but unreachable until the system
// prompt routes to it. These assert the routing rule + the §2.5
// agent⇄deterministic boundary instruction are present in the emitted
// system prompt (so the green engine actually fires).
// ============================================================

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";

describe("E0 — materialize_feasible routing (reachability)", () => {
    // The FOSE/section tool-routing block is emitted once a DPR is loaded
    // (section feasibility presupposes a parsed DPR + a forward plan).
    const prompt = buildSystemPrompt({ dprLoaded: true });

    it("routes near-term section-feasibility / 'can I take these next term' to materialize_feasible", () => {
        expect(prompt).toContain("materialize_feasible");
        // The routing trigger phrase must appear so the agent knows WHEN to call it.
        expect(prompt.toLowerCase()).toMatch(/can i take these|next term|near-term section|section feasibility|feasible schedule/);
    });

    it("states the §2.5 boundary: the agent ranks tool-verified candidates, never enumerates or judges validity", () => {
        // The boundary instruction must forbid the agent inventing/judging.
        expect(prompt.toLowerCase()).toMatch(/never (enumerate|invent)|only rank|tool-verified|candidateid/);
        expect(prompt.toLowerCase()).toContain("materialize_feasible");
    });

    it("tells the agent that on no feasible candidate / reject-all, escalation produces a confirmable re-plan (not the agent itself)", () => {
        expect(prompt.toLowerCase()).toMatch(/propose_section_replan|escalat|re-plan|move .* later term/);
    });
});
