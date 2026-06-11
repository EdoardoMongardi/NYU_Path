// ============================================================
// viewForwardPlan.test.ts — Task D1.1 (Phase 3 advisor)
// ============================================================
// RED-before-GREEN coverage for the `detail: "rich"` mode added to
// `view_forward_plan`. The rich mode surfaces the recorded WHY + lock
// status + flexibility + downstream + critical-path that ALREADY live on
// the slot/semester objects, so the agent can answer "why is X in term Y
// / which courses are locked vs movable / how flexible is this" without
// inventing any field.
//
// We drive through the tool exactly as the loop does: `tool.call(input,
// ctx)` builds `output.summary`, and `tool.summarizeResult(output)`
// returns the model-facing string (capped at maxResultChars).
//
// Backward-compat: `detail: "terse"` (and the no-arg default) must keep
// the EXACT current terse output — the rich fields must NOT appear.
// ============================================================

import { describe, it, expect } from "vitest";
import type {
    ForwardSchedule,
    ForwardSemester,
    ScheduleSlot,
    ScheduleSlotCompleted,
    ScheduleSlotSpecificPlanned,
} from "@nyupath/shared";
import type { ToolSession, ToolUseContext } from "../../../src/agent/tool.js";
import { viewForwardPlanTool } from "../../../src/agent/tools/viewForwardPlan.js";

// ---- Fixture helpers (minimal valid objects against @nyupath/shared) ----

const KNOWN_REASON = "placed to satisfy CS-required before its dependents";

function makeSpecificPlannedSlot(
    overrides: Partial<ScheduleSlotSpecificPlanned> = {},
): ScheduleSlotSpecificPlanned {
    return {
        kind: "specific_planned",
        courseId: "CSCI-UA 101",
        title: "Intro to CS",
        credits: 4,
        satisfiesRules: ["CS-CORE-1"],
        reason: KNOWN_REASON,
        rationale: {
            satisfiesRequirements: ["CS-CORE-1"],
            termConstraints: [],
            consideredAlternatives: [],
            decisionsApplied: [],
        },
        flexibility: {
            earliestPossibleTerm: "2026-fall",
            latestPossibleTerm: "2027-spring",
            alternativeCourses: ["CSCI-UA 102"],
        },
        downstreamImpact: {
            courseIds: ["CSCI-UA 201", "CSCI-UA 202"],
            graduationDelay: 1,
        },
        workloadTier: "major-required",
        workloadWeight: 1.0,
        bindingState: "bound",
        confidence: "historically_likely",
        isCriticalPath: true,
        ...overrides,
    };
}

function makeCompletedSlot(
    overrides: Partial<ScheduleSlotCompleted> = {},
): ScheduleSlotCompleted {
    return {
        kind: "completed",
        courseId: "MATH-UA 121",
        title: "Calculus I",
        credits: 4,
        grade: "A",
        ...overrides,
    };
}

function makeSemester(
    term: string,
    slots: ScheduleSlot[],
    locked = false,
): ForwardSemester {
    return {
        term,
        locked,
        slots,
        plannedCredits: slots.reduce(
            (sum, s) =>
                sum +
                (s.kind === "specific_planned" ||
                s.kind === "placeholder" ||
                s.kind === "in_progress" ||
                s.kind === "completed"
                    ? (s as { credits: number }).credits
                    : 0),
            0,
        ),
        notes: [],
        loadRationale: {
            strategy: "balanced",
            creditsTarget: 16,
            slack: 4,
            weightedCredits: 8,
            hardCount: 2,
            easyCount: 0,
            alternativeDistributionsConsidered: [],
        },
    };
}

function makeSchedule(semesters: ForwardSemester[]): ForwardSchedule {
    return {
        studentId: "test-student",
        homeSchoolId: "cas",
        graduationTerm: "2027-spring",
        creditTargetPerSemester: 16,
        f1Floor: 12,
        domesticPartTimeFloor: 8,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters,
        dprCourseHistoryHash: "test-hash",
        computedAt: 1_700_000_000_000,
        feasibility: {
            feasible: true,
            constraintViolations: [],
            placementRationale: {},
        },
        state: "valid-clean",
        balanceScore: 0,
        assumptions: [],
    };
}

function makeCtx(session: ToolSession): ToolUseContext {
    return {
        signal: new AbortController().signal,
        session,
    };
}

/** Build a schedule with: a critical-path specific_planned slot in an
 *  UNLOCKED semester + a completed slot in a LOCKED semester. */
function fixtureSchedule(): ForwardSchedule {
    return makeSchedule([
        makeSemester("2025-fall", [makeCompletedSlot()], /* locked */ true),
        makeSemester("2026-fall", [makeSpecificPlannedSlot()], /* locked */ false),
    ]);
}

// ============================================================
// RICH mode
// ============================================================

describe("view_forward_plan — detail: rich", () => {
    it("surfaces the recorded reason, flexibility, critical-path, lock-vs-movable markers, and the locked semester", async () => {
        const session: ToolSession = { forwardSchedule: fixtureSchedule() };
        const out = await viewForwardPlanTool.call({ detail: "rich" }, makeCtx(session));
        const summary = viewForwardPlanTool.summarizeResult(out);

        // The load-bearing recorded WHY appears verbatim.
        expect(summary).toContain(KNOWN_REASON);
        // Flexibility (earliest possible term) appears.
        expect(summary).toContain("2026-fall");
        expect(summary).toContain("2027-spring");
        // A critical-path marker is present.
        expect(summary.toLowerCase()).toContain("critical");
        // Per-slot locked-vs-movable marker: the planned slot is movable.
        expect(summary.toLowerCase()).toContain("movable");
        // The completed slot carries the lock marker.
        expect(summary).toContain("🔒");
        // The locked semester is indicated as locked.
        expect(summary.toLowerCase()).toContain("locked");
        // Downstream impact + flexibility alternatives surface.
        expect(summary).toContain("CSCI-UA 102"); // alternativeCourses
    });
});

// ============================================================
// TERSE mode — backward-compat (byte-identical to the old output)
// ============================================================

describe("view_forward_plan — detail: terse (backward-compat)", () => {
    const EXPECTED_TERSE = [
        "FORWARD DEGREE PLAN — VALID (no caveats)",
        "Graduation target: 2027-spring",
        "Balance score: 0.00",
        "Degree credits met: no",
        "Semesters: 2",
        "Computed at: 2023-11-14T22:13:20.000Z",
        "",
        "  2025-fall: 4cr — MATH-UA 121 ✓",
        "  2026-fall: 4cr — CSCI-UA 101 (4cr)",
    ].join("\n");

    it("explicit detail:terse reproduces the exact current terse output", async () => {
        const session: ToolSession = { forwardSchedule: fixtureSchedule() };
        const out = await viewForwardPlanTool.call({ detail: "terse" }, makeCtx(session));
        const summary = viewForwardPlanTool.summarizeResult(out);
        expect(summary).toBe(EXPECTED_TERSE);
    });

    it("no-arg default reproduces the exact terse output (rich fields absent)", async () => {
        const session: ToolSession = { forwardSchedule: fixtureSchedule() };
        const out = await viewForwardPlanTool.call({}, makeCtx(session));
        const summary = viewForwardPlanTool.summarizeResult(out);
        expect(summary).toBe(EXPECTED_TERSE);
        // None of the rich fields leak into terse mode.
        expect(summary).not.toContain(KNOWN_REASON);
        expect(summary).not.toContain("critical");
        expect(summary).not.toContain("🔒");
        expect(summary).not.toContain("movable");
    });
});

// ============================================================
// Empty / no-plan case (unchanged)
// ============================================================

describe("view_forward_plan — no plan stored", () => {
    it("returns the 'No forward degree plan' message regardless of detail", async () => {
        const session: ToolSession = {};
        const out = await viewForwardPlanTool.call({ detail: "rich" }, makeCtx(session));
        const summary = viewForwardPlanTool.summarizeResult(out);
        expect(out.source).toBe("none");
        expect(out.schedule).toBeNull();
        expect(summary).toContain("No forward degree plan is stored in this session.");
    });
});
