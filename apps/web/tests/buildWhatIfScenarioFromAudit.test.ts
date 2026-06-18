// ============================================================
// buildWhatIfScenarioFromAudit.test.ts — H4.2b-3 TDD
// ============================================================
// Unit-tests for the pure `buildWhatIfScenarioFromAudit` helper +
// `mapStateToVerdict`. Written RED-first (before the implementation
// was finalized).
//
// Covers:
//   (1) mapStateToVerdict for ALL FOUR PlanState values.
//   (2) kind === "whatif".
//   (3) rederive.via === "audit_upload".
//   (4) label fallback (hypotheticalProgram preferred, else resp.label).
//   (5) hedges === [resp.cta].
//   (6) pendingMutationId === undefined — the read-only / not-confirmable
//       guarantee (R1: the scenario can NEVER be committed).
// ============================================================

import { describe, it, expect } from "vitest";
import {
    buildWhatIfScenarioFromAudit,
    mapStateToVerdict,
    type WhatIfAuditResponse,
} from "../app/chat/buildWhatIfScenarioFromAudit";
import type { ForwardSchedule, PlanState } from "@nyupath/shared";

// ---------------------------------------------------------------------------
// Minimal fixtures
// ---------------------------------------------------------------------------

/** A minimal ForwardSchedule stub carrying a chosen PlanState `state`. */
function makeSchedule(state: PlanState): ForwardSchedule {
    return {
        state,
        semesters: [],
    } as unknown as ForwardSchedule;
}

function makeResponse(overrides: Partial<WhatIfAuditResponse> = {}): WhatIfAuditResponse {
    return {
        exploration: {
            schedule: makeSchedule("valid-clean"),
            summary: "Plan completes in 4 semesters.",
            hypotheticalProgram: "Economics (BA)",
        },
        label: "What-if: hypothetical Economics (BA) — not your committed plan.",
        cta: "To make this real, declare it in Albert and upload your new (real) DPR.",
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// mapStateToVerdict — ALL FOUR PlanState values
// ---------------------------------------------------------------------------

describe("mapStateToVerdict", () => {
    it("maps valid-clean → valid", () => {
        expect(mapStateToVerdict("valid-clean")).toBe("valid");
    });
    it("maps valid-with-trade-offs → trade-offs", () => {
        expect(mapStateToVerdict("valid-with-trade-offs")).toBe("trade-offs");
    });
    it("maps infeasible-draft → invalid", () => {
        expect(mapStateToVerdict("infeasible-draft")).toBe("invalid");
    });
    it("maps student-preferred-invalid-draft → invalid", () => {
        expect(mapStateToVerdict("student-preferred-invalid-draft")).toBe("invalid");
    });
});

// ---------------------------------------------------------------------------
// buildWhatIfScenarioFromAudit
// ---------------------------------------------------------------------------

describe("buildWhatIfScenarioFromAudit", () => {
    it("produces a read-only what-if scenario", () => {
        const resp = makeResponse();
        const s = buildWhatIfScenarioFromAudit(resp, "wf-1", 5000);
        expect(s.id).toBe("wf-1");
        expect(s.kind).toBe("whatif");
        expect(s.createdAt).toBe(5000);
        // The exploration's schedule is passed through by identity.
        expect(s.schedule).toBe(resp.exploration.schedule);
    });

    it("sets rederive.via === 'audit_upload'", () => {
        const s = buildWhatIfScenarioFromAudit(makeResponse(), "wf-1", 5000);
        expect(s.rederive).toEqual({ via: "audit_upload" });
    });

    it("derives verdict from the schedule state", () => {
        const s = buildWhatIfScenarioFromAudit(
            makeResponse({
                exploration: {
                    schedule: makeSchedule("valid-with-trade-offs"),
                    summary: "x",
                    hypotheticalProgram: "Econ",
                },
            }),
            "wf-1",
            5000,
        );
        expect(s.verdict).toBe("trade-offs");
    });

    it("prefers hypotheticalProgram for the label", () => {
        const s = buildWhatIfScenarioFromAudit(makeResponse(), "wf-1", 5000);
        expect(s.label).toBe("Economics (BA)");
    });

    it("falls back to resp.label when hypotheticalProgram is empty", () => {
        const s = buildWhatIfScenarioFromAudit(
            makeResponse({
                exploration: {
                    schedule: makeSchedule("valid-clean"),
                    summary: "x",
                    hypotheticalProgram: "",
                },
                label: "Banner label",
            }),
            "wf-1",
            5000,
        );
        expect(s.label).toBe("Banner label");
    });

    it("sets hedges to exactly [resp.cta]", () => {
        const resp = makeResponse();
        const s = buildWhatIfScenarioFromAudit(resp, "wf-1", 5000);
        expect(s.hedges).toEqual([resp.cta]);
    });

    it("has NO pendingMutationId (read-only / not-confirmable guarantee)", () => {
        const s = buildWhatIfScenarioFromAudit(makeResponse(), "wf-1", 5000);
        expect(s.pendingMutationId).toBeUndefined();
    });
});
