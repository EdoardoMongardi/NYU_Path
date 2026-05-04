// ============================================================
// Phase 11 Stage 2 — planFeasibility.ts unit tests
// ============================================================

import { describe, expect, it } from "vitest";
import { verifyPlanFeasibility } from "../../src/agent/verifiers/planFeasibility.js";
import type { CourseSuggestion, SchoolConfig } from "@nyupath/shared";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

const baseSchool: SchoolConfig = {
    schoolId: "cas",
    name: "College of Arts and Science",
    degreeType: "BA",
    courseSuffix: ["-UA"],
    totalCreditsRequired: 128,
    overallGpaMin: 2.0,
    acceptsTransferCredit: true,
    maxCreditsPerSemester: 18,
    f1FullTimeMinCredits: 12,
} as SchoolConfig;

function mkSuggestion(courseId: string, credits = 4): CourseSuggestion {
    return {
        courseId,
        title: courseId,
        credits,
        priority: 1,
        blockedCount: 0,
        satisfiesRules: [],
        category: "required",
        reason: "test",
    };
}

function mkDpr(history: Array<{ subject: string; catalogNbr: string; type: string; term: string; grade?: string | null; courseTitle?: string; units?: number }>): DegreeProgressReport {
    return {
        header: { studentId: "s", studentName: "S", program: "p", college: "c", preparedDate: "2026-04-30" },
        programs: [],
        cumulative: { creditsRequired: 128, creditsUsed: 60, cumulativeGpa: 3.0, residencyRequired: 64, residencyUsed: 32, passFailUsedUnits: 0, passFailCapUnits: 32, outsideHomeUsedUnits: 0, outsideHomeCapUnits: 16, timeLimitYears: 8 },
        requirementGroups: [],
        courseHistory: history.map((h) => ({
            subject: h.subject, catalogNbr: h.catalogNbr, type: h.type,
            term: h.term, grade: h.grade ?? null,
            courseTitle: h.courseTitle ?? `${h.subject} ${h.catalogNbr}`,
            units: h.units ?? 4,
        })),
        _meta: { warnings: [], sourceFingerprint: "test" },
    } as unknown as DegreeProgressReport;
}

describe("verifyPlanFeasibility — happy path", () => {
    it("passes when plan is within ceiling, above F-1 floor, prereqs met, no dups", () => {
        const verdict = verifyPlanFeasibility({
            suggestions: [mkSuggestion("CSCI-UA 421"), mkSuggestion("CORE-UA 400"), mkSuggestion("MATH-UA 251")],
            plannedCredits: 12,
            targetSemester: "2027 Spring",
            creditsAlreadyInTarget: 0,
            alreadyRegisteredForTargetIds: [],
            schoolConfig: baseSchool,
            visaStatus: "f1",
            dpr: mkDpr([{ subject: "CSCI-UA", catalogNbr: "201", type: "EN", term: "2024 Fall", grade: "A" }]),
            prereqs: undefined,
        });
        expect(verdict.ok).toBe(true);
        expect(verdict.violations).toHaveLength(0);
    });
});

describe("verifyPlanFeasibility — ceiling check", () => {
    it("flags when planned + already-registered exceed maxCreditsPerSemester", () => {
        const verdict = verifyPlanFeasibility({
            suggestions: [mkSuggestion("X-UA 1"), mkSuggestion("X-UA 2"), mkSuggestion("X-UA 3")],
            plannedCredits: 12,
            targetSemester: "2026 Fall",
            creditsAlreadyInTarget: 12,
            alreadyRegisteredForTargetIds: ["A-UA 1", "A-UA 2", "A-UA 3"],
            schoolConfig: baseSchool, // ceiling 18
            visaStatus: "f1",
            dpr: null,
            prereqs: undefined,
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations[0]!.kind).toBe("exceeds_semester_ceiling");
        expect(verdict.violations[0]!.detail).toMatch(/24/);   // total
        expect(verdict.violations[0]!.detail).toMatch(/18/);   // ceiling
    });
});

describe("verifyPlanFeasibility — F-1 floor check", () => {
    it("flags when student is F-1 and projected total < f1FullTimeMinCredits", () => {
        const verdict = verifyPlanFeasibility({
            suggestions: [mkSuggestion("CSCI-UA 421")],
            plannedCredits: 4,
            targetSemester: "2026 Fall",
            creditsAlreadyInTarget: 0,
            alreadyRegisteredForTargetIds: [],
            schoolConfig: baseSchool, // floor 12
            visaStatus: "f1",
            dpr: null,
            prereqs: undefined,
        });
        expect(verdict.ok).toBe(false);
        expect(verdict.violations[0]!.kind).toBe("below_f1_floor");
        expect(verdict.violations[0]!.detail).toMatch(/12/);
    });

    it("does NOT flag F-1 floor for domestic students", () => {
        const verdict = verifyPlanFeasibility({
            suggestions: [mkSuggestion("CSCI-UA 421")],
            plannedCredits: 4,
            targetSemester: "2026 Fall",
            creditsAlreadyInTarget: 0,
            alreadyRegisteredForTargetIds: [],
            schoolConfig: baseSchool,
            visaStatus: "domestic",
            dpr: null,
            prereqs: undefined,
        });
        const f1Violations = verdict.violations.filter((v) => v.kind === "below_f1_floor");
        expect(f1Violations).toHaveLength(0);
    });
});

describe("verifyPlanFeasibility — prereq chain check", () => {
    it("flags when a suggestion's prereq is not in completed/IP/already-registered", () => {
        const verdict = verifyPlanFeasibility({
            suggestions: [mkSuggestion("CSCI-UA 472")],
            plannedCredits: 4,
            targetSemester: "2027 Spring",
            creditsAlreadyInTarget: 0,
            alreadyRegisteredForTargetIds: [],
            schoolConfig: baseSchool,
            visaStatus: "f1",
            dpr: mkDpr([{ subject: "MATH-UA", catalogNbr: "121", type: "EN", term: "2024 Fall" }]), // no CSCI-UA 102
            prereqs: [{ course: "CSCI-UA 472", prereqGroups: [{ type: "AND", courses: ["CSCI-UA 102"] }], coreqs: [] }],
        });
        expect(verdict.ok).toBe(false);
        const v = verdict.violations.find((x) => x.kind === "prereq_chain_broken");
        expect(v).toBeDefined();
        expect(v!.courseId).toBe("CSCI-UA 472");
        expect(v!.detail).toMatch(/CSCI-UA 102/);
    });

    it("passes when prereq is in IP rows", () => {
        const verdict = verifyPlanFeasibility({
            suggestions: [mkSuggestion("CSCI-UA 472")],
            plannedCredits: 4,
            targetSemester: "2027 Spring",
            creditsAlreadyInTarget: 0,
            alreadyRegisteredForTargetIds: [],
            schoolConfig: baseSchool,
            visaStatus: "f1",
            dpr: mkDpr([{ subject: "CSCI-UA", catalogNbr: "102", type: "IP", term: "2026 Spring" }]),
            prereqs: [{ course: "CSCI-UA 472", prereqGroups: [{ type: "AND", courses: ["CSCI-UA 102"] }], coreqs: [] }],
        });
        expect(verdict.violations.filter((v) => v.kind === "prereq_chain_broken")).toHaveLength(0);
    });
});

describe("verifyPlanFeasibility — duplicate-in-target-term check", () => {
    it("flags when suggestion is already in alreadyRegisteredForTarget", () => {
        const verdict = verifyPlanFeasibility({
            suggestions: [mkSuggestion("CORE-UA 700")],
            plannedCredits: 4,
            targetSemester: "2026 Fall",
            creditsAlreadyInTarget: 4,
            alreadyRegisteredForTargetIds: ["CORE-UA 700"],
            schoolConfig: baseSchool,
            visaStatus: "f1",
            dpr: null,
            prereqs: undefined,
        });
        expect(verdict.ok).toBe(false);
        const v = verdict.violations.find((x) => x.kind === "duplicate_in_target_term");
        expect(v).toBeDefined();
        expect(v!.courseId).toBe("CORE-UA 700");
    });
});

describe("verifyPlanFeasibility — uses-completed-course check", () => {
    it("flags when suggestion is already completed (EN row)", () => {
        const verdict = verifyPlanFeasibility({
            suggestions: [mkSuggestion("CSCI-UA 102")],
            plannedCredits: 4,
            targetSemester: "2027 Spring",
            creditsAlreadyInTarget: 0,
            alreadyRegisteredForTargetIds: [],
            schoolConfig: baseSchool,
            visaStatus: "f1",
            dpr: mkDpr([{ subject: "CSCI-UA", catalogNbr: "102", type: "EN", term: "2025 Fall", grade: "A" }]),
            prereqs: undefined,
        });
        expect(verdict.ok).toBe(false);
        const v = verdict.violations.find((x) => x.kind === "uses_completed_course");
        expect(v).toBeDefined();
        expect(v!.courseId).toBe("CSCI-UA 102");
    });
});
