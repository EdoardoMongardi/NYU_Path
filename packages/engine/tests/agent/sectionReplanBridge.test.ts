// ============================================================
// sectionReplanBridge.test.ts — Phase 38 Phase A (escalation)
// ============================================================
// A1 — classifySectionFailure: turn the section-layer signals (from
// materialize_feasible + an explicit student rejection) into a typed
// failure kind. A2 — generateResolutionLadder: emit the ordered
// rung-1→3 mutation batches (§2④). Both PURE — they never touch the
// solver (A3 re-solves through the frozen seam).
// ============================================================

import { describe, it, expect } from "vitest";
import {
    classifySectionFailure,
    generateResolutionLadder,
    validateResolutionCandidates,
    makeFrozenSeamEvaluator,
    type ResolutionBatch,
    type BatchEvaluation,
} from "../../src/agent/sectionMaterialization/sectionReplanBridge.js";
import type { ForwardSchedule } from "@nyupath/shared";
import type { ToolSession } from "../../src/agent/tool.js";
import type { DegreeProgressReport } from "../../src/dpr/schema.js";

describe("classifySectionFailure — A1", () => {
    it("zero feasible candidates (all combos clash) → hard-conflict", () => {
        const f = classifySectionFailure({ candidateCount: 0, unavailableCourses: [] });
        expect(f?.kind).toBe("hard-conflict");
    });

    it("a course with no open/waitlist section → course-wipe naming that course", () => {
        const f = classifySectionFailure({ candidateCount: 1, unavailableCourses: ["CSCI-UA 421"] });
        expect(f?.kind).toBe("course-wipe");
        expect(f?.courseIds).toEqual(["CSCI-UA 421"]);
    });

    it("an explicit student rejection → soft-rejection naming the rejected courses", () => {
        const f = classifySectionFailure({
            candidateCount: 3,
            unavailableCourses: [],
            rejectedCourseIds: ["CSCI-UA 421"],
        });
        expect(f?.kind).toBe("soft-rejection");
        expect(f?.courseIds).toEqual(["CSCI-UA 421"]);
    });

    it("feasible candidates + no wipe + no rejection → no failure (null)", () => {
        expect(classifySectionFailure({ candidateCount: 5, unavailableCourses: [] })).toBeNull();
    });

    it("an explicit rejection takes precedence over an incidental wipe", () => {
        const f = classifySectionFailure({
            candidateCount: 0,
            unavailableCourses: ["MATH-UA 121"],
            rejectedCourseIds: ["CSCI-UA 421"],
        });
        expect(f?.kind).toBe("soft-rejection");
        expect(f?.courseIds).toEqual(["CSCI-UA 421"]);
    });
});

describe("generateResolutionLadder — A2", () => {
    const baseCtx = {
        nearTerm: "2026-fall",
        laterTerms: ["2027-spring", "2027-fall"],
    };

    it("rung 1 emits a within-term swap when an alternative course is available", () => {
        const batches = generateResolutionLadder({
            ...baseCtx,
            failure: { kind: "course-wipe", courseIds: ["CSCI-UA 421"] },
            withinTermAlternatives: { "CSCI-UA 421": "CSCI-UA 470" },
        });
        const rung1 = batches.find(b => b.rung === 1);
        expect(rung1).toBeDefined();
        expect(rung1!.mutations).toEqual([
            { kind: "swap", drop: "CSCI-UA 421", add: "CSCI-UA 470", term: "2026-fall" },
        ]);
    });

    it("rung 2 moves the course to the nearest later term", () => {
        const batches = generateResolutionLadder({
            ...baseCtx,
            failure: { kind: "course-wipe", courseIds: ["CSCI-UA 421"] },
        });
        const rung2 = batches.find(b => b.rung === 2);
        expect(rung2).toBeDefined();
        expect(rung2!.mutations).toEqual([
            { kind: "move", courseId: "CSCI-UA 421", fromTerm: "2026-fall", toTerm: "2027-spring" },
        ]);
        expect(rung2!.movedCourseIds).toEqual(["CSCI-UA 421"]);
    });

    it("rung 3 emits a multi-course move batch (≤ K) when more than one course fails", () => {
        const batches = generateResolutionLadder({
            ...baseCtx,
            failure: { kind: "hard-conflict", courseIds: ["CSCI-UA 421", "MATH-UA 121"] },
            multiCourseK: 2,
        });
        const rung3 = batches.find(b => b.rung === 3);
        expect(rung3).toBeDefined();
        expect(rung3!.mutations).toEqual([
            { kind: "move", courseId: "CSCI-UA 421", fromTerm: "2026-fall", toTerm: "2027-spring" },
            { kind: "move", courseId: "MATH-UA 121", fromTerm: "2026-fall", toTerm: "2027-spring" },
        ]);
        expect(rung3!.movedCourseIds.length).toBeLessThanOrEqual(2);
    });

    it("batches are ordered cheapest-first (rung 1 → 2 → 3) and skip rung 1 with no alternatives", () => {
        const batches = generateResolutionLadder({
            ...baseCtx,
            failure: { kind: "hard-conflict", courseIds: ["CSCI-UA 421"] },
        });
        const rungs = batches.map(b => b.rung);
        // No within-term alternative supplied → no rung 1; rungs ascend.
        expect(rungs).not.toContain(1);
        expect([...rungs]).toEqual([...rungs].sort((a, b) => a - b));
    });

    it("returns no move batches when there is no later term to move into", () => {
        const batches = generateResolutionLadder({
            nearTerm: "2027-fall",
            laterTerms: [],
            failure: { kind: "course-wipe", courseIds: ["CSCI-UA 421"] },
        });
        expect(batches.find(b => b.rung === 2)).toBeUndefined();
        expect(batches.find(b => b.rung === 3)).toBeUndefined();
    });
});

describe("validateResolutionCandidates — A3/A4", () => {
    const batch = (rung: 1 | 2 | 3, movedCourseIds: string[]): ResolutionBatch => ({
        rung,
        strategy: "s",
        mutations: [],
        movedCourseIds,
    });
    const sched = (gradTerm: string) => ({ graduationTerm: gradTerm } as unknown as ForwardSchedule);

    it("keeps only feasible batches and ranks fewest-moves-first", () => {
        const b1 = batch(2, ["X"]);             // 1 move, feasible, grad unchanged
        const b2 = batch(3, ["X", "Y"]);        // 2 moves, feasible, grad changed
        const b3 = batch(2, ["Z"]);             // infeasible → dropped
        const evaluate = (b: ResolutionBatch): BatchEvaluation => {
            if (b === b3) {
                return { batch: b, feasible: false, infeasibility: { conflictSource: "credit", conflictDetail: "below floor" } };
            }
            const gradTerm = b === b2 ? "2028-spring" : "2027-spring";
            return { batch: b, feasible: true, schedule: sched(gradTerm), gradTerm };
        };
        const res = validateResolutionCandidates([b1, b2, b3], "2027-spring", evaluate);
        expect(res.resolutions.map(r => r.batch)).toEqual([b1, b2]);
        expect(res.resolutions[0]!.gradTermChanged).toBe(false);
        expect(res.resolutions[1]!.gradTermChanged).toBe(true);
        expect(res.reason).toBeNull();
    });

    it("ranks an unchanged-grad-term resolution above a changed one at the SAME move count", () => {
        const a = batch(2, ["X"]); // grad changed
        const b = batch(2, ["Y"]); // grad unchanged
        const evaluate = (bb: ResolutionBatch): BatchEvaluation => {
            const gradTerm = bb === a ? "2028-spring" : "2027-spring";
            return { batch: bb, feasible: true, schedule: sched(gradTerm), gradTerm };
        };
        const res = validateResolutionCandidates([a, b], "2027-spring", evaluate);
        expect(res.resolutions[0]!.batch).toBe(b);
    });

    it("A4 — no feasible batch → empty resolutions + a reason from the infeasibility report", () => {
        const b = batch(2, ["X"]);
        const evaluate = (): BatchEvaluation => ({
            batch: b,
            feasible: false,
            infeasibility: { conflictSource: "graduation-term", conflictDetail: "would push graduation past your target" },
        });
        const res = validateResolutionCandidates([b], "2027-spring", evaluate);
        expect(res.resolutions).toEqual([]);
        expect(res.reason).toContain("graduation");
    });

    it("makeFrozenSeamEvaluator wires the real propose-path chain end-to-end without throwing", () => {
        // A minimal solvable session (empty-program DPR ⇒ a trivial solve);
        // the point is that the real chain composes + returns a verdict.
        const dpr = {
            _meta: { parserVersion: "1", parsedAt: "2026-01-01T00:00:00Z", sourceFingerprint: "sha256:t", sourcePdfPageCount: 1, parseDurationMs: 0, warnings: [] },
            header: { studentName: "T", preparedDate: "01/01/2026" },
            programs: [],
            advisorNotations: [],
            cumulative: {
                creditsRequired: 128, creditsUsed: 96, cumulativeGpa: 3.4, cumulativeGpaRequired: 2.0,
                residencyRequired: 64, residencyUsed: 64, passFailUsedUnits: 0, passFailCapUnits: 32,
                outsideHomeUsedUnits: 0, outsideHomeCapUnits: 16, timeLimitYears: 8,
            },
            requirementGroups: [],
            courseHistory: [],
        } as unknown as DegreeProgressReport;
        const plan = { graduationTerm: "2027-spring", semesters: [] } as unknown as ForwardSchedule;
        const session = {
            student: {
                id: "t", catalogYear: "2024", homeSchool: "cas",
                declaredPrograms: [{ programId: "computer_science", programType: "major" }],
                coursesTaken: [], visaStatus: "f1",
            },
            schoolConfig: {
                schoolId: "cas", name: "CAS", degreeType: "BA", courseSuffix: ["-UA"],
                totalCreditsRequired: 128, overallGpaMin: 2.0, acceptsTransferCredit: true,
                maxCreditsPerSemester: 18, f1FullTimeMinCredits: 12, residency: { minCredits: 64, note: null },
            },
            degreeProgressReport: dpr,
            forwardSchedule: plan,
        } as unknown as ToolSession;

        const evaluate = makeFrozenSeamEvaluator(session, dpr, plan);
        const result = evaluate({ rung: 2, strategy: "noop", mutations: [], movedCourseIds: [] });
        expect(typeof result.feasible).toBe("boolean");
    });
});
