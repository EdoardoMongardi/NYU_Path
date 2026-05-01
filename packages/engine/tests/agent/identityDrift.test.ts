import { describe, it, expect } from "vitest";
import { validateResponse } from "../../src/agent/responseValidator.js";

// Minimal student stub — only required fields; `student` is optional
// in ValidatorContext so violations here come purely from the text checks.
const MINIMAL_STUDENT = {
    id: "test",
    catalogYear: "2025-2026",
    homeSchool: "cas",
    declaredPrograms: [] as [],
    coursesTaken: [] as [],
};

describe("identity_drift validator rule", () => {
    it("flags 'Call me and I'll suggest' as identity drift", () => {
        const verdict = validateResponse({
            assistantText: "Sure! Call me and I'll suggest electives that fit.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "what electives should I take?",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(true);
    });

    it("flags 'Email me with your decision' as identity drift", () => {
        const verdict = validateResponse({
            assistantText: "Email me with your decision and we'll move forward.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "what should I do?",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(true);
    });

    it("flags 'Reply back to me' as identity drift", () => {
        const verdict = validateResponse({
            assistantText: "Reply back to me when you've thought it over.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "anything else?",
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(true);
    });

    it("does NOT flag legitimate first-person assistant phrasing", () => {
        const verdict = validateResponse({
            assistantText:
                "I'll suggest some electives. Let me know which sound interesting and I can pull more details.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "what electives should I take?",
        });
        // No identity_drift violation. (Other violations may fire from other
        // rules — we only assert this specific kind is absent.)
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(false);
    });

    it("does NOT flag a student-directed 'call' that has nothing to do with the agent", () => {
        // E.g. NYU's own help-desk number. The phrase doesn't put the agent
        // in the third-party-contactable role.
        const verdict = validateResponse({
            assistantText: "If you need a Reduced Course Load, call OGS at 212-998-4720.",
            invocations: [],
            student: MINIMAL_STUDENT,
            userQuestion: "can I take fewer credits?",
        });
        expect(verdict.violations.some(v => v.kind === "identity_drift")).toBe(false);
    });
});
