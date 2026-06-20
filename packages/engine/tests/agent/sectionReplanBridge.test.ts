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
} from "../../src/agent/sectionMaterialization/sectionReplanBridge.js";

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
