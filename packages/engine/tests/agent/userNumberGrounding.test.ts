import { describe, it, expect } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator";
import type { StudentProfile } from "@nyupath/shared";

const MINIMAL_STUDENT: StudentProfile = {
    studentId: "test",
    homeSchoolId: "cas",
    declaredPrograms: [],
    visaStatus: undefined,
    transcript: { semesters: [] },
    plans: [],
    expectedGraduationTerm: undefined,
};

describe("user-supplied numbers count as grounded", () => {
    it("does NOT flag a number that originated in the user's question", () => {
        const verdict = validateResponse({
            assistantText: "Just to confirm — you'd like a 16-credit plan?",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for courses of 16 credits in total",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number")).toBe(false);
    });

    it("does NOT flag user numbers even when no tool was called", () => {
        const verdict = validateResponse({
            assistantText: "I see you want 5 electives. Which semester are we planning?",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "give me 5 electives",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number")).toBe(false);
    });

    it("STILL flags a number that's neither in the user's question nor a tool result", () => {
        const verdict = validateResponse({
            assistantText: "Your GPA is 3.7.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "what's my GPA?",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number")).toBe(true);
    });

    it("flags a hallucinated number even when the user mentioned a different one", () => {
        // User said "16", agent fabricated "20" — still ungrounded.
        const verdict = validateResponse({
            assistantText: "Your plan totals 20 credits.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for 16 credits",
        });
        expect(verdict.violations.some(v => v.kind === "ungrounded_number")).toBe(true);
    });
});
