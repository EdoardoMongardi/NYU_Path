import { describe, it, expect } from "vitest";
import { planSemesterTool } from "../../src/agent/tools/planSemester.js";

// We focus on (a) programId required-or-defaulted, (b) DPR-path
// scope restriction. Task 5 will extend this file with the credit-
// fill test cases.
//
// NOTE: validateInput signature is (input, ctx: ToolUseContext) where
// ToolUseContext = { signal: AbortSignal; session: ToolSession }.
// We pass a minimal { session, signal } shape cast to `any`.

// Minimal DPR stub — gives validateInput the `degreeProgressReport`
// signal it needs to take the DPR shortcircuit path and return { ok: true }
// after the programId guard runs. Without this the authored-rules fallback
// guard fires ("Required engine data not loaded.") before we get to test
// the programId logic.
const MINIMAL_DPR = {
    _meta: { parserVersion: "1.0.0", parsedAt: "", sourceFingerprint: "test", sourcePdfPageCount: 1, parseDurationMs: 0, warnings: [] },
    header: { studentName: "Test", preparedDate: "2026-05-01" },
    programs: [],
    advisorNotations: [],
    cumulative: { creditsRequired: 128, creditsUsed: 0, cumulativeGpa: null, cumulativeGpaRequired: null, residencyRequired: null, residencyUsed: null, passFailUsedUnits: null, passFailCapUnits: null, outsideHomeUsedUnits: null, outsideHomeCapUnits: null, timeLimitYears: null },
    requirementGroups: [],
    courseHistory: [],
};

function fakeCtx(opts: { declaredPrograms: string[] }) {
    return {
        signal: new AbortController().signal,
        session: {
            student: {
                id: "test",
                studentId: "test",
                homeSchoolId: "cas",
                declaredPrograms: opts.declaredPrograms.map(programId => ({
                    programId,
                    programType: "major" as const,
                })),
                visaStatus: undefined,
                transcript: { semesters: [] },
                plans: [],
                expectedGraduationTerm: "2027-spring",
            },
            schoolConfig: { schoolId: "cas", maxCreditsPerSemester: 18, f1FullTimeMinCredits: 12 },
            programs: new Map(),
            // Provide a DPR so the DPR-path shortcircuit fires and
            // validateInput returns { ok: true } after the programId
            // guard (rather than hitting the authored-rules "no data" wall).
            degreeProgressReport: MINIMAL_DPR,
        },
    };
}

describe("plan_semester programId handling", () => {
    it("validateInput auto-defaults programId when student has exactly one declared program", async () => {
        const ctx = fakeCtx({ declaredPrograms: ["computer_science_math"] });
        const input = { targetSemester: "2027-spring" } as any;
        const result = await planSemesterTool.validateInput!(input, ctx as any);
        // validateInput should NOT reject — it should fill programId
        // from the single declared program.
        expect(result.ok).toBe(true);
        // After successful validation, the input is mutated to carry programId.
        expect(input.programId).toBe("computer_science_math");
    });

    it("validateInput rejects when student has multiple declared programs and no programId is passed", async () => {
        const ctx = fakeCtx({ declaredPrograms: ["computer_science_math", "music_minor"] });
        const result = await planSemesterTool.validateInput!(
            { targetSemester: "2027-spring" } as any,
            ctx as any,
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            // ValidationResult uses `userMessage` (not `message`)
            expect(result.userMessage).toMatch(/programId/i);
        }
    });

    it("validateInput accepts when an explicit programId is passed even with multiple declared programs", async () => {
        const ctx = fakeCtx({ declaredPrograms: ["computer_science_math", "music_minor"] });
        const result = await planSemesterTool.validateInput!(
            { targetSemester: "2027-spring", programId: "computer_science_math" } as any,
            ctx as any,
        );
        expect(result.ok).toBe(true);
    });
});
