// ============================================================
// planBadges (Phase 4 Task E2.1) — plan-level badge-row logic
// ============================================================
// apps/web ships NO DOM render harness (no @testing-library/react,
// no jsdom — vitest runs in node), so the badge logic is extracted
// into the pure, framework-agnostic helper `apps/web/lib/planBadges.ts`
// and unit-tested here directly. The React `PlanBadges` component in
// scheduleSidebar.tsx is a thin consumer of `computePlanBadges`.
//
// Coverage:
//   - validity ✓ for the two valid states; clearly-marked invalid for
//     the two draft states.
//   - graduationTerm formatted to a human label ("2027-spring" →
//     "Spring 2027").
//   - tradeOffCount = consequences?.length ?? 0 (0 at rest).
//   - the binding philosophy-#3 / §11 case: a plan that is NOT
//     ~99%-grounded (optimality "best-effort"/"feasibility-unconfirmed",
//     a populated assumptions[], or an invalid-draft state) MUST render
//     the VERIFY-WITH-ADVISER hedge — never a bare ✓. The hedge derives
//     ONLY from real engine-produced fields; it fabricates no CAS-coupling
//     claim and computes no new number.
// ============================================================

import { describe, it, expect } from "vitest";
import type { ForwardSchedule, PlanState, Assumption } from "@nyupath/shared";
import { computePlanBadges } from "../lib/planBadges";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseSchedule(overrides: Partial<ForwardSchedule> = {}): ForwardSchedule {
    return {
        studentId: "stu-1",
        homeSchoolId: "CAS",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [],
        dprCourseHistoryHash: "hash",
        computedAt: 0,
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
        ...overrides,
    };
}

const heuristicAssumption: Assumption = {
    type: "HEURISTIC_MAPPING",
    studentStatedFactor: "lighter Mondays",
    studentConstraintFraming: "soft",
    mappedToMutation: null,
    confidence: "low",
    reasoning: "Interpreted 'lighter Mondays' as a soft Monday-load deboost.",
    consequenceIfWrong: "Mondays may stay heavy if the interpretation was wrong.",
};

// ---------------------------------------------------------------------------
// Validity badge
// ---------------------------------------------------------------------------

describe("computePlanBadges — validity badge (E2.1)", () => {
    it("valid-clean → valid (✓)", () => {
        const b = computePlanBadges(baseSchedule({ state: "valid-clean" }));
        expect(b.validity.valid).toBe(true);
        expect(b.validity.state).toBe<PlanState>("valid-clean");
    });

    it("valid-with-trade-offs → valid (✓)", () => {
        const b = computePlanBadges(baseSchedule({ state: "valid-with-trade-offs" }));
        expect(b.validity.valid).toBe(true);
    });

    it("infeasible-draft → clearly-marked invalid", () => {
        const b = computePlanBadges(baseSchedule({ state: "infeasible-draft" }));
        expect(b.validity.valid).toBe(false);
        expect(b.validity.label.toLowerCase()).toContain("invalid");
    });

    it("student-preferred-invalid-draft → clearly-marked invalid", () => {
        const b = computePlanBadges(
            baseSchedule({ state: "student-preferred-invalid-draft" }),
        );
        expect(b.validity.valid).toBe(false);
        expect(b.validity.label.toLowerCase()).toContain("invalid");
    });
});

// ---------------------------------------------------------------------------
// Graduation-term badge
// ---------------------------------------------------------------------------

describe("computePlanBadges — graduation-term badge (E2.1)", () => {
    it("formats a planner term to a human label", () => {
        const b = computePlanBadges(baseSchedule({ graduationTerm: "2027-spring" }));
        expect(b.graduationTerm).toBe("Spring 2027");
    });

    it("passes through an unrecognized term shape verbatim (no invention)", () => {
        const b = computePlanBadges(baseSchedule({ graduationTerm: "TBD" }));
        expect(b.graduationTerm).toBe("TBD");
    });
});

// ---------------------------------------------------------------------------
// Trade-off count badge
// ---------------------------------------------------------------------------

describe("computePlanBadges — trade-off count badge (E2.1)", () => {
    it("counts the passed consequences array", () => {
        const consequences = [
            "Bumped Spring 2027 from 16 → 20cr (within cap).",
            "Dropped the elective slack in Fall 2026.",
        ];
        const b = computePlanBadges(baseSchedule(), consequences);
        expect(b.tradeOffCount).toBe(2);
    });

    it("no consequences arg → count 0 (at rest)", () => {
        const b = computePlanBadges(baseSchedule());
        expect(b.tradeOffCount).toBe(0);
    });

    it("empty consequences array → count 0", () => {
        const b = computePlanBadges(baseSchedule(), []);
        expect(b.tradeOffCount).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Confidence badge — the binding philosophy-#3 / §11 badge.
// ---------------------------------------------------------------------------

describe("computePlanBadges — confidence badge (E2.1, binding §11)", () => {
    it("clean grounded plan (optimal/undefined, no assumptions) → NOT hedged", () => {
        const b = computePlanBadges(
            baseSchedule({ state: "valid-clean", optimality: "optimal", assumptions: [] }),
        );
        expect(b.confidence.hedged).toBe(false);
        expect(b.confidence.label.toLowerCase()).not.toContain("verify with your adviser");
    });

    it("undefined optimality (back-compat = optimal) + no assumptions → NOT hedged", () => {
        const sched = baseSchedule({ state: "valid-clean", assumptions: [] });
        delete sched.optimality;
        const b = computePlanBadges(sched);
        expect(b.confidence.hedged).toBe(false);
    });

    it("optimality 'best-effort' → hedged + 'verify with your adviser'", () => {
        const b = computePlanBadges(
            baseSchedule({ state: "valid-clean", optimality: "best-effort" }),
        );
        expect(b.confidence.hedged).toBe(true);
        expect(b.confidence.label.toLowerCase()).toContain("verify with your adviser");
    });

    it("optimality 'feasibility-unconfirmed' → hedged + 'verify with your adviser'", () => {
        const b = computePlanBadges(
            baseSchedule({ state: "valid-clean", optimality: "feasibility-unconfirmed" }),
        );
        expect(b.confidence.hedged).toBe(true);
        expect(b.confidence.label.toLowerCase()).toContain("verify with your adviser");
    });

    it("populated assumptions[] → hedged + 'verify with your adviser'", () => {
        const b = computePlanBadges(
            baseSchedule({ state: "valid-with-trade-offs", assumptions: [heuristicAssumption] }),
        );
        expect(b.confidence.hedged).toBe(true);
        expect(b.confidence.label.toLowerCase()).toContain("verify with your adviser");
    });

    it("infeasible-draft state → hedged + 'verify with your adviser'", () => {
        const b = computePlanBadges(baseSchedule({ state: "infeasible-draft" }));
        expect(b.confidence.hedged).toBe(true);
        expect(b.confidence.label.toLowerCase()).toContain("verify with your adviser");
    });

    it("student-preferred-invalid-draft state → hedged + 'verify with your adviser'", () => {
        const b = computePlanBadges(
            baseSchedule({ state: "student-preferred-invalid-draft" }),
        );
        expect(b.confidence.hedged).toBe(true);
        expect(b.confidence.label.toLowerCase()).toContain("verify with your adviser");
    });
});

// ---------------------------------------------------------------------------
// Full-row smoke — the four badges from one live ForwardSchedule.
// ---------------------------------------------------------------------------

describe("computePlanBadges — full row (E2.1)", () => {
    it("derives all four badges from a single live ForwardSchedule + consequences", () => {
        const consequences = ["Bumped Spring 2027 from 16 → 20cr (within cap)."];
        const b = computePlanBadges(
            baseSchedule({
                state: "valid-with-trade-offs",
                graduationTerm: "2027-spring",
                optimality: "best-effort",
                assumptions: [heuristicAssumption],
            }),
            consequences,
        );
        expect(b.validity.valid).toBe(true);
        expect(b.graduationTerm).toBe("Spring 2027");
        expect(b.tradeOffCount).toBe(1);
        expect(b.confidence.hedged).toBe(true);
        expect(b.confidence.label.toLowerCase()).toContain("verify with your adviser");
    });
});
