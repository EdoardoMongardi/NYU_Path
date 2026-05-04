import { describe, it, expect } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator";

const MINIMAL_STUDENT = {
    studentId: "t",
    homeSchoolId: "cas",
    declaredPrograms: [],
    visaStatus: undefined,
    transcript: { semesters: [] },
    plans: [],
    expectedGraduationTerm: undefined,
};

describe("grounding allows arithmetic on grounded numbers", () => {
    it("allows '16' when both '12' and '4' appear in tool results (12 + 4 = 16)", () => {
        const verdict = validateResponse({
            assistantText: "Your total is 16 credits (12 already registered + 4 planned).",
            invocations: [
                { toolName: "plan_semester", summary: "12 credits already registered, 4 credits planned" } as any,
            ],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what's my total?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "16")).toBe(false);
    });

    it("allows '8' when '12' and '4' appear (12 - 4 = 8)", () => {
        const verdict = validateResponse({
            assistantText: "After dropping the 4-credit course you'll have 8 credits.",
            invocations: [{ toolName: "plan_semester", summary: "12 credits planned, 4-credit course" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what if I drop one?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "8")).toBe(false);
    });

    it("STILL flags a number that is neither verbatim nor a sum/diff of grounded numbers", () => {
        const verdict = validateResponse({
            assistantText: "Your GPA is 3.7.",
            invocations: [{ toolName: "x", summary: "12 credits planned" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "what's my GPA?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "3.7")).toBe(true);
    });

    it("allows arithmetic on userQuestion + tool-result numbers (16 from user, 4 from tool, 16 - 4 = 12)", () => {
        const verdict = validateResponse({
            assistantText: "Of the 16 you asked for, the planner placed 4 — so you're 12 short.",
            invocations: [{ toolName: "plan_semester", summary: "4 credits planned" } as any],
            student: MINIMAL_STUDENT as any,
            userQuestion: "plan for 16 credits",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number" && v.number === "12")).toBe(false);
    });
});
