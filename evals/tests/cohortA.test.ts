// ============================================================
// Phase 6.5 P-7 — Cohort A starter-set tests
// ============================================================
// Pins (a) the starter set is well-formed (every case has at least
// one turn; every turn has a user message), (b) the cases load
// without runtime errors, (c) a smoke-run through the runner with
// recorded completions produces composite scores. Real cohort
// scoring against a live model is env-gated.
// ============================================================

import { describe, expect, it } from "vitest";
import { COHORT_A_CASES } from "../cohorts/cohort_a.js";
import { runCohort } from "../cohort/runner.js";
import { RecordingLLMClient } from "../../packages/engine/src/agent/index.js";

describe("Cohort A eval set (Phase 6.5 P-7 starter)", () => {
    it("ships ≥ 10 cases (the starter target)", () => {
        expect(COHORT_A_CASES.length).toBeGreaterThanOrEqual(10);
    });

    it("every case has at least one turn", () => {
        for (const c of COHORT_A_CASES) {
            expect(c.turns.length).toBeGreaterThan(0);
        }
    });

    it("every turn has a non-empty user message", () => {
        for (const c of COHORT_A_CASES) {
            for (const t of c.turns) {
                expect(t.userMessage.length).toBeGreaterThan(0);
            }
        }
    });

    it("every case has a unique id", () => {
        const ids = COHORT_A_CASES.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it("every student profile has a homeSchool + declaredPrograms", () => {
        for (const c of COHORT_A_CASES) {
            expect(c.student.homeSchool).toBeTruthy();
            expect(c.student.declaredPrograms.length).toBeGreaterThan(0);
        }
    });

    it("smoke-runs through runCohort with a stub LLM (no real model needed)", async () => {
        // Stub completes every turn with a benign reply. The cohort
        // composite WILL be low (most cases require specific tool
        // calls / caveats the stub can't produce) — the assertion is
        // that the runner completes without throwing and emits per-
        // case + cohort-level reports for ALL 10 cases.
        const client = new RecordingLLMClient({
            recordings: [
                {
                    match: {},
                    completion: { text: "Stub reply — please consult your adviser.", toolCalls: [] },
                },
            ] as never,
        });

        const report = await runCohort(client, COHORT_A_CASES);
        expect(report.cases).toHaveLength(COHORT_A_CASES.length);
        expect(report.turnCount).toBe(
            COHORT_A_CASES.reduce((s, c) => s + c.turns.length, 0),
        );
        // The composite is ∈ [0, 1]. We don't pin a value because the
        // stub's reply is generic.
        expect(report.cohortComposite).toBeGreaterThanOrEqual(0);
        expect(report.cohortComposite).toBeLessThanOrEqual(1);
    });
});
