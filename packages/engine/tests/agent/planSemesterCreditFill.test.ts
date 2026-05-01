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

    // ----- Credit-fill (Task 5) -----

    it("fills free electives on the final semester (no semestersUntilGrad > 1 gate)", async () => {
        // Set up: student on the final semester (targetSemester ===
        // graduationTerm), DPR with 2 not-satisfied 4-credit hard
        // requirements, asks for 16 credits. With the gate dropped,
        // the planner should also append free-elective slots toward
        // the 16-credit target after the hard quota is met.
        const dprWithRequirements = {
            ...MINIMAL_DPR,
            cumulative: { ...MINIMAL_DPR.cumulative, creditsRequired: 128, creditsUsed: 96 },
            requirementGroups: [
                {
                    rgId: "RG1001",
                    title: "Major Required Courses",
                    status: "not_satisfied" as const,
                    statusText: "Not Satisfied",
                    children: [
                        {
                            rId: "MJREQ-001",
                            title: "Major Required: Operating Systems",
                            status: "not_satisfied" as const,
                            statusText: "Need CSCI-UA 202",
                            description: "Take CSCI-UA 202",
                            counter: { kind: "courses" as const, required: 1, used: 0, needed: 1 },
                            coursesUsed: [],
                        },
                        {
                            rId: "MJREQ-002",
                            title: "Major Required: Algorithms",
                            status: "not_satisfied" as const,
                            statusText: "Need CSCI-UA 310",
                            description: "Take CSCI-UA 310",
                            counter: { kind: "courses" as const, required: 1, used: 0, needed: 1 },
                            coursesUsed: [],
                        },
                    ],
                },
            ],
        };
        const ctx = fakeCtx({ declaredPrograms: ["computer_science_math"] });
        (ctx.session as any).degreeProgressReport = dprWithRequirements;

        const input = {
            targetSemester: "2027-spring",
            graduationTerm: "2027-spring",
            programId: "computer_science_math",
            maxCredits: 16,
        } as any;

        const result = await planSemesterTool.call(input, ctx as any);

        // Either the plan placed requirements + free electives for a
        // total >= 12 credits (above the F-1 floor), or the planner
        // emitted a couldNotFill warning. The pre-fix regression was
        // "delivers only 8 credits with no warning" — both outcomes
        // above are acceptable; the silent 8-credit case is not.
        const totalCredits = (result.suggestions ?? []).reduce(
            (sum: number, s: { credits?: number }) => sum + (s.credits ?? 0),
            0,
        );
        const hasShortfallWarning = JSON.stringify(result).toLowerCase().includes("could not fill");
        expect(
            totalCredits >= 12 || hasShortfallWarning,
            `plan delivered ${totalCredits} credits with no shortfall warning`,
        ).toBe(true);
    });

    it("emits a couldNotFillCredits warning when maxCredits is unreachable", async () => {
        // Set up: DPR with only ONE 4-credit requirement and maxCourses=1,
        // so the planner places exactly 1 course (4 credits), then the
        // course-count cap prevents free-elective fill. With maxCredits=16,
        // the shortfall is 12 credits and the planner must emit a
        // "Could not fill" disclaimer so the agent (and UI) know the target
        // was not met.
        const dprOneReq = {
            ...MINIMAL_DPR,
            cumulative: { ...MINIMAL_DPR.cumulative, creditsRequired: 128, creditsUsed: 124 },
            requirementGroups: [
                {
                    rgId: "RG1001",
                    title: "Major Required Courses",
                    status: "not_satisfied" as const,
                    statusText: "Not Satisfied",
                    children: [
                        {
                            rId: "MJREQ-001",
                            title: "Major Required: Capstone",
                            status: "not_satisfied" as const,
                            statusText: "Need CSCI-UA 480",
                            description: "Take CSCI-UA 480",
                            counter: { kind: "courses" as const, required: 1, used: 0, needed: 1 },
                            coursesUsed: [],
                        },
                    ],
                },
            ],
        };
        const ctx = fakeCtx({ declaredPrograms: ["computer_science_math"] });
        (ctx.session as any).degreeProgressReport = dprOneReq;

        const input = {
            targetSemester: "2027-spring",
            graduationTerm: "2027-spring",
            programId: "computer_science_math",
            // maxCourses=1 caps the plan at 1 course (4 cr); free-elective
            // fill cannot run because the slot count is exhausted.
            maxCourses: 1,
            maxCredits: 16,
        } as any;

        const result = await planSemesterTool.call(input, ctx as any);
        const allText = JSON.stringify(result).toLowerCase();

        // With only 4 credits delivered against a 16-credit ask, the
        // planner must emit a shortfall disclaimer. Any of these substrings
        // constitutes a valid "could not fill" signal.
        const hasShortfallSignal =
            allText.includes("could not fill") ||
            allText.includes("target unreachable") ||
            allText.includes("short of") ||
            allText.includes("could not reach");
        expect(
            hasShortfallSignal,
            `expected couldNotFillCredits-style warning, result: ${allText.slice(0, 500)}`,
        ).toBe(true);
    });
});
