// ============================================================
// D5.1 — checkPlanClaims plan-claim validator (LAUNCH-BLOCKING)
// ============================================================
// The exit criterion "ungrounded plan claims blocked." checkPlanClaims
// diffs the agent's prose against the stored ForwardSchedule and BLOCKS:
//   - course-placement claims that disagree with where the plan puts a
//     course (or place a course the plan doesn't),
//   - graduation-term claims that disagree with graduationTerm,
//   - lock-status claims that disagree with the stored slot's mutability.
// It is PURE (no LLM) and a no-op when ctx.forwardSchedule is absent.

import { describe, expect, it } from "vitest";
import type { ForwardSchedule, ScheduleSlot } from "@nyupath/shared";
import { validateResponse } from "../../src/agent/responseValidator.js";

// ------------------------------------------------------------
// Minimal slot builders. checkPlanClaims only reads `kind` +
// `courseId` (and, for lock status, the slot kind + the semester's
// `locked`). The rich specific_planned/placeholder fields are
// irrelevant to the check, so we cast minimal shapes to ScheduleSlot.
// ------------------------------------------------------------
function plannedSlot(courseId: string): ScheduleSlot {
    return { kind: "specific_planned", courseId, title: courseId, credits: 4 } as unknown as ScheduleSlot;
}
function completedSlot(courseId: string): ScheduleSlot {
    return { kind: "completed", courseId, title: courseId, credits: 4, grade: "A" } as unknown as ScheduleSlot;
}

// CSCI-UA 102 → specific_planned (movable) in 2027-fall (unlocked).
// CSCI-UA 101 → completed (locked/final) in 2025-fall (locked).
// graduationTerm → 2028-spring.
function makeSchedule(): ForwardSchedule {
    return {
        studentId: "stu-1",
        homeSchoolId: "cas",
        graduationTerm: "2028-spring",
        creditTargetPerSemester: 16,
        f1Floor: null,
        domesticPartTimeFloor: null,
        graduationCreditMinimum: 128,
        degreeCreditsMet: false,
        semesters: [
            {
                term: "2025-fall",
                locked: true,
                slots: [completedSlot("CSCI-UA 101")],
                plannedCredits: 4,
                notes: [],
                loadRationale: {} as never,
            },
            {
                term: "2027-fall",
                locked: false,
                slots: [plannedSlot("CSCI-UA 102")],
                plannedCredits: 4,
                notes: [],
                loadRationale: {} as never,
            },
        ],
    } as unknown as ForwardSchedule;
}

function planViolations(assistantText: string, schedule?: ForwardSchedule) {
    const verdict = validateResponse({
        assistantText,
        invocations: [],
        ...(schedule ? { forwardSchedule: schedule } : {}),
    });
    return verdict.violations.filter((v) => v.kind === "ungrounded_plan_claim");
}

describe("checkPlanClaims (D5.1)", () => {
    // (a) wrong placement → exactly one violation
    it("(a) flags a course claimed in a term the plan does NOT place it", () => {
        const v = planViolations(
            "I've put CSCI-UA 102 in Spring 2026 for you.",
            makeSchedule(),
        );
        expect(v.length).toBe(1);
    });

    // (a2) prose-form term match → NO violation (normalizer works)
    it("(a2) accepts a prose term that matches the stored canonical term", () => {
        const v = planViolations(
            "CSCI-UA 102 is scheduled in Fall 2027.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });

    // (a3) near-miss season → violation; course w/o term → no false positive
    it("(a3) flags a near-miss season and ignores a course with no term claim", () => {
        const wrongSeason = planViolations(
            "CSCI-UA 102 is in Spring 2027.",
            makeSchedule(),
        );
        expect(wrongSeason.length).toBe(1);

        const noTerm = planViolations(
            "CSCI-UA 102 is a great course and pairs well with your other classes.",
            makeSchedule(),
        );
        expect(noTerm.length).toBe(0);
    });

    // (b) grad-term mismatch → violation; match → none
    it("(b) flags a graduation-term claim that disagrees, accepts a matching one", () => {
        const wrong = planViolations(
            "Based on this plan, you graduate Fall 2028.",
            makeSchedule(),
        );
        expect(wrong.length).toBe(1);

        const right = planViolations(
            "Based on this plan, you graduate Spring 2028.",
            makeSchedule(),
        );
        expect(right.length).toBe(0);
    });

    // (c) all placements match → NO violation
    it("(c) accepts a reply whose placements all match the stored plan", () => {
        const v = planViolations(
            "CSCI-UA 102 sits in Fall 2027, and you graduate Spring 2028.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });

    // (d) no forwardSchedule → no-op
    it("(d) is a no-op when ctx.forwardSchedule is absent", () => {
        const v = planViolations(
            "CSCI-UA 102 is in Spring 2026 and you graduate Fall 2099.",
            undefined,
        );
        expect(v.length).toBe(0);
    });

    // (e) lock-status both directions
    it("(e) flags claiming a movable slot is locked, and claiming a locked slot is movable", () => {
        // specific_planned + unlocked semester = movable; reply says it's locked/final.
        const lockedClaim = planViolations(
            "CSCI-UA 102 is locked and final — you can't change it.",
            makeSchedule(),
        );
        expect(lockedClaim.length).toBeGreaterThanOrEqual(1);

        // completed = locked/final; reply says student can still move it.
        const movableClaim = planViolations(
            "You can still move CSCI-UA 101 to a later term if you'd like.",
            makeSchedule(),
        );
        expect(movableClaim.length).toBeGreaterThanOrEqual(1);
    });

    // (f) counterfactual carve-out → NO violation
    it("(f) does NOT flag a counterfactual/hypothetical placement or grad-term claim", () => {
        const v = planViolations(
            "If you failed CSCI-UA 101, you would graduate Spring 2029 and CSCI-UA 102 would move to Spring 2028.",
            makeSchedule(),
        );
        expect(v.length).toBe(0);
    });
});
