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

describe("quantitative_shortfall validator rule", () => {
    it("flags 'asked for 16 credits, delivered 8 credits, no shortfall acknowledgement' as quantitative_shortfall", () => {
        const verdict = validateResponse({
            assistantText: "Here's your plan: CORE-UA 400 (4cr) and CSCI-UA 421 (4cr), totaling 8 credits. What would you like to do next?",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for courses of 16 credits in total",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(true);
    });

    it("does NOT flag when answer delivers exactly the requested quantity", () => {
        const verdict = validateResponse({
            assistantText: "Here's your plan: CORE-UA 400, CSCI-UA 421, and 2 free electives, totaling 16 credits.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for courses of 16 credits in total",
        });
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(false);
    });

    it("does NOT flag when shortfall is explicitly acknowledged", () => {
        const verdict = validateResponse({
            assistantText: "Could not fill the requested 16-credit plan; delivered 8 credits across 2 courses. The student should call search_courses to find additional electives.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "plan for courses of 16 credits in total",
        });
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(false);
    });

    it("does NOT fire when the user's number isn't paired with a unit keyword", () => {
        // "show me option 16" — 16 isn't a quantity of credits/courses.
        const verdict = validateResponse({
            assistantText: "Here is option 16's content: ...",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "show me option 16",
        });
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(false);
    });

    it("works for the 'electives' unit, not just credits", () => {
        const verdict = validateResponse({
            assistantText: "Here are 3 elective options.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "give me 5 electives",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "quantitative_shortfall")).toBe(true);
    });
});
