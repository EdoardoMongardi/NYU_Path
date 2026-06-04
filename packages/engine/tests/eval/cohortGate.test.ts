// ============================================================
// Phase 6.5 P-4 — cohort gate + recovery mode tests
// ============================================================

import { describe, expect, it, beforeEach } from "vitest";
import {
    COHORT_CONFIGS,
    setCohortAssignment,
    userInCohort,
    getCohortConfig,
} from "../../src/cohort/gate.js";
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
