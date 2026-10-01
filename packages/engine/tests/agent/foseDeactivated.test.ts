// ============================================================
// foseDeactivated.test.ts — FOSE (plan 38) deactivation guard
// ============================================================
// 2026-07-14: FOSE was DROPPED from the live agent (owner decision — no
// acceptable live-seat-data source). `materialize_feasible` and
// `propose_section_replan` are UNREGISTERED (registry.ts) and their
// SECTION-FEASIBILITY routing was removed from the system prompt.
//
// This file REPLACES the old `fosePhaseE0Routing.test.ts` (which asserted the
// OPPOSITE — that the routing was present). It is now a regression guard: if
// someone re-registers a FOSE tool or re-adds its routing without deliberately
// reviving the feature, these fail. The tool CODE + exports still exist in the
// repo (importable, unit-tested) — this guards the live-agent surface only.
// ============================================================

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/agent/systemPrompt.js";
import { buildDefaultRegistry } from "../../src/agent/registry.js";

describe("FOSE deactivation — the two plan-38 tools are off the live agent", () => {
    const reg = buildDefaultRegistry();

    it("does NOT register materialize_feasible or propose_section_replan", () => {
        expect(reg.has("materialize_feasible")).toBe(false);
        expect(reg.has("propose_section_replan")).toBe(false);
        const names = reg.list().map(t => t.name);
        expect(names).not.toContain("materialize_feasible");
        expect(names).not.toContain("propose_section_replan");
    });

    it("does NOT route to the FOSE tools in the DPR-loaded system prompt", () => {
        const prompt = buildSystemPrompt({ dprLoaded: true });
        expect(prompt).not.toContain("materialize_feasible");
        expect(prompt).not.toContain("propose_section_replan");
    });

    it("keeps core near-term section-materialization (materialize_sections) intact", () => {
        // materialize_sections is Phase-15/17 core planning (auto-chained from
        // plan_forward_degree), NOT part of plan-38 FOSE — it must survive.
        expect(reg.has("materialize_sections")).toBe(true);
        expect(reg.has("confirm_section_combination")).toBe(true);
        const prompt = buildSystemPrompt({ dprLoaded: true });
        expect(prompt).toContain("materialize_sections");
    });
});
