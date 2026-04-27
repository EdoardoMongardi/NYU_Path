// ============================================================
// Phase 6.5 P-4 — cohort gate + recovery mode tests
// ============================================================

import { describe, expect, it, beforeEach } from "vitest";
import {
    COHORT_CONFIGS,
    setCohortAssignment,
    userInCohort,
    getCohortConfig,
    runTemplateMatcherOnly,
} from "../../src/cohort/gate.js";
import { loadPolicyTemplates } from "../../src/rag/index.js";
import type { ToolSession } from "../../src/agent/index.js";

const STUDENT = {
    id: "u1",
    catalogYear: "2025-2026",
    homeSchool: "cas",
    declaredPrograms: [{ programId: "cs_major_ba", programType: "major" as const }],
    coursesTaken: [],
};

describe("cohort gate (Phase 6.5 P-4)", () => {
    beforeEach(() => { setCohortAssignment({ default: "alpha" }); });

    it("defaults unknown users to alpha", () => {
        expect(userInCohort("unknown_user")).toBe("alpha");
    });

    it("respects explicit overrides", () => {
        setCohortAssignment({
            overrides: { "user_a": "invite", "user_b": "limited" },
            default: "alpha",
        });
        expect(userInCohort("user_a")).toBe("invite");
        expect(userInCohort("user_b")).toBe("limited");
        expect(userInCohort("user_c")).toBe("alpha");
    });

    it("exposes a CohortConfig for every cohort with the architectural floor", () => {
        const cohorts = ["alpha", "beta", "invite", "public", "limited"] as const;
        for (const c of cohorts) {
            const cfg = getCohortConfig(c);
            expect(cfg.cohort).toBe(c);
            // The four production cohorts hold the ≥0.90 floor.
            // `limited` is a recovery mode and intentionally has 0.0
            // (the gate is the cohort's eval, not a sub-gate).
            if (c === "limited") {
                expect(cfg.evalGateFailing).toBe(true);
                expect(cfg.composedEvalFloor).toBe(0.0);
            } else {
                expect(cfg.evalGateFailing).toBe(false);
                expect(cfg.composedEvalFloor).toBe(0.90);
            }
        }
    });

    it("limited cohort has maxTurns=0 (agent loop disabled)", () => {
        expect(COHORT_CONFIGS.limited.maxTurns).toBe(0);
    });
});

describe("runTemplateMatcherOnly (Phase 6.5 P-4 recovery mode)", () => {
    const { templates } = loadPolicyTemplates();
    const session: ToolSession = { student: STUDENT };
    const NOW = new Date("2026-04-26T00:00:00Z");

    it("returns a curated template body when one matches", () => {
        const result = runTemplateMatcherOnly(
            "Can I take a major course P/F?",
            session,
            templates,
            { now: NOW },
        );
        expect(result.kind).toBe("template");
        expect(result.match?.template.id).toBe("cas_pf_major");
        expect(result.reply).toContain("32 credits");
    });

    it("returns a 'limited availability' fallback when nothing matches", () => {
        const result = runTemplateMatcherOnly(
            "what's the meaning of life",
            session,
            templates,
            { now: NOW },
        );
        expect(result.kind).toBe("no_match");
        expect(result.reply).toMatch(/limited availability/i);
        expect(result.reply).toMatch(/college advising center/i);
    });

    it("returns the limited fallback when no student is loaded", () => {
        const result = runTemplateMatcherOnly("anything", {}, templates, { now: NOW });
        expect(result.kind).toBe("no_match");
        expect(result.reply).toMatch(/limited availability/i);
    });
});
